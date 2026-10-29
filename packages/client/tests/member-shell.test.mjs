import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdentityApiError } from '../dist/identity/api.js';
import { createMemberShell } from '../dist/identity/shell.js';
import { createSpacePreferenceStore } from '../dist/identity/space-preferences.js';
import { SidebarAccountFooter } from '../dist/identity/SidebarAccountFooter.js';
import { SidebarAccountSettingsLauncher } from '../dist/identity/SidebarAccountSettingsLauncher.js';
import { MemberExecutionPage } from '../dist/execution/MemberExecutionPage.js';

const spaces = [
  { id: 'personal-a', kind: 'personal', name: '个人空间' },
  { id: 'team-a', kind: 'team', name: '产品研发' },
];
const member = (accountId = 'member-a') => ({
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: 'request-local',
  spaces,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture(overrides = {}) {
  let reads = 0,
    accountId = 'member-a';
  const api = {
    session: async () => {
      reads++;
      return member(accountId);
    },
    login: async (input) => {
      accountId = input.accountId;
      return { accountId };
    },
    logout: async () => ({ accountId }),
    ...overrides,
  };
  const shell = createMemberShell(api);
  return { shell, api, reads: () => reads };
}

test('space preference stores only a space ID per account and tolerates disabled browser storage', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const preferences = createSpacePreferenceStore(() => storage);
  preferences.save('member-a', 'team-a');
  assert.equal(preferences.read('member-a'), 'team-a');
  assert.equal(preferences.read('member-b'), undefined);
  assert.deepEqual([...values.values()], ['team-a']);
  preferences.clearIfMatches('member-a', 'team-b');
  assert.equal(preferences.read('member-a'), 'team-a');
  preferences.clearIfMatches('member-a', 'team-a');
  assert.equal(preferences.read('member-a'), undefined);
  const blocked = createSpacePreferenceStore(() => {
    throw Error('storage disabled');
  });
  assert.equal(blocked.read('member-a'), undefined);
  assert.doesNotThrow(() => blocked.save('member-a', 'team-a'));
  assert.doesNotThrow(() => blocked.clearIfMatches('member-a', 'team-a'));
});

test('same account restores a confirmed team after restart; revocation and account change never reuse it', async () => {
  const values = new Map();
  const preferences = createSpacePreferenceStore(() => ({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }));
  let accountId = 'member-a';
  let directory = spaces;
  let reads = 0;
  const api = {
    session: async () => {
      reads++;
      return { ...member(accountId), spaces: directory };
    },
    login: async () => ({ accountId }),
    logout: async () => ({ accountId }),
  };
  const first = createMemberShell(api, preferences);
  first.start();
  await tick();
  assert.equal(first.getSnapshot().space.space.id, 'personal-a');
  await first.space.select('team-a');
  assert.equal(preferences.read(accountId), 'team-a');
  first.stop();

  const reopened = createMemberShell(api, preferences);
  const before = reads;
  reopened.start();
  assert.equal(reopened.getSnapshot().space, undefined);
  await tick();
  assert.equal(reads, before + 2); // Session restore, then fresh directory verification.
  assert.equal(reopened.getSnapshot().space.space.id, 'team-a');
  directory = [spaces[0]];
  await reopened.space.refresh();
  assert.equal(reopened.getSnapshot().space.status, 'error');
  assert.equal(preferences.read(accountId), undefined);
  reopened.stop();

  const afterRevocation = createMemberShell(api, preferences);
  afterRevocation.start();
  await tick();
  assert.equal(afterRevocation.getSnapshot().space.space.id, 'personal-a');
  afterRevocation.stop();

  accountId = 'member-b';
  directory = [{ id: 'personal-b', kind: 'personal', name: 'Another account' }];
  const other = createMemberShell(api, preferences);
  other.start();
  await tick();
  assert.equal(other.getSnapshot().space.space.id, 'personal-b');
  other.stop();
});

test('root shell contract: one owner starts once, footer/main observe the same controller and space projection', async () => {
  const { shell, reads } = fixture();
  let footer = 0,
    main = 0;
  const stopFooter = shell.subscribe(() => footer++),
    stopMain = shell.subscribe(() => main++);
  shell.start();
  shell.start();
  await tick();
  assert.equal(reads(), 2); // One session restore, one directory recheck; no business/model call.
  assert.equal(shell.getSnapshot().session.status, 'authenticated');
  assert.equal(shell.getSnapshot().space.status, 'ready');
  assert.equal(shell.getSnapshot().space, shell.space.getSnapshot());
  const sessionController = shell.session;
  const spaceController = shell.space;
  await spaceController.select('team-a');
  assert.equal(reads(), 3);
  assert.equal(shell.session, sessionController);
  assert.equal(shell.space, spaceController);
  assert.equal(footer, main);
  stopFooter();
  stopMain();
  const count = footer;
  await shell.space.refresh();
  assert.equal(footer, count);
  shell.stop();
});

test('root shell contract: active page owns discard guard; navigation invalidates it before React cleanup', async () => {
  const { shell } = fixture();
  shell.start();
  await tick();
  shell.setPageActive(true);
  const epoch = shell.getSnapshot().pageEpoch;
  const selected = [];
  const clearOld = shell.registerSpaceGuard(epoch, (id) => selected.push(id));
  shell.requestSpace('team-a');
  assert.deepEqual(selected, ['team-a']);
  assert.equal(shell.space.getSnapshot().space.id, 'personal-a');
  shell.setPageActive(false);
  shell.setPageActive(true);
  assert.equal(shell.isPageCurrent(epoch), false);
  const next = shell.getSnapshot().pageEpoch;
  shell.registerSpaceGuard(next, (id) => selected.push(`new:${id}`));
  clearOld();
  shell.requestSpace('team-a');
  assert.equal(selected.at(-1), 'new:team-a');
  shell.setPageActive(false);
  shell.requestSpace('team-a');
  await tick();
  assert.equal(shell.space.getSnapshot().space.id, 'team-a');
  shell.stop();
});

test('retained panels cannot borrow the active panel epoch or replace its navigation guards', async () => {
  const { shell } = fixture();
  shell.start();
  await tick();
  shell.setPageActive(true, 'zhuma-workbench');
  const epoch = shell.getSnapshot().pageEpoch;
  assert.equal(shell.isPageCurrent(epoch, 'zhuma-workbench'), true);
  assert.equal(shell.isPageCurrent(epoch, 'zhuma-my-work'), false);
  const selected = [],
    left = [];
  shell.registerSpaceGuard(epoch, (id) => selected.push(id), 'zhuma-workbench');
  shell.registerSpaceGuard(epoch, () => assert.fail('hidden space guard'), 'zhuma-my-work');
  shell.registerLeaveGuard(
    epoch,
    (proceed) => {
      left.push('catalog');
      proceed();
    },
    'zhuma-workbench',
  );
  shell.registerLeaveGuard(epoch, () => assert.fail('hidden leave guard'), 'zhuma-my-work');
  shell.requestSpace('team-a');
  shell.requestLeave(() => left.push('navigate'));
  assert.deepEqual(selected, ['team-a']);
  assert.deepEqual(left, ['catalog', 'navigate']);
  shell.setPageActive(true, 'zhuma-my-work');
  assert.equal(shell.isPageCurrent(epoch, 'zhuma-workbench'), false);
  assert.equal(shell.isPageCurrent(shell.getSnapshot().pageEpoch, 'zhuma-my-work'), true);
  shell.stop();
});

test('root shell contract: logout immediately removes shared member/space content; failed logout cannot reopen old cookie', async () => {
  const logout = deferred();
  const { shell, reads } = fixture({ logout: () => logout.promise });
  shell.start();
  await tick();
  const old = shell.space;
  const pending = shell.session.logout();
  assert.equal(shell.getSnapshot().session.status, 'signing-out');
  assert.equal(shell.space, undefined);
  assert.equal(shell.getSnapshot().space, undefined);
  assert.equal(old.getSnapshot().status, 'checking');
  logout.reject(Error('private diagnostic'));
  await pending;
  assert.equal(shell.getSnapshot().session.status, 'unavailable');
  const before = reads();
  await shell.session.restore();
  assert.equal(reads(), before);
  assert.equal(shell.space, undefined);
  shell.stop();
});

test('account transition: a delayed former-account picker cannot select its team after a new login', async () => {
  let accountId = 'member-a';
  const personalB = { id: 'personal-b', kind: 'personal', name: 'New account' };
  const api = {
    session: async () => ({
      ...member(accountId),
      spaces: accountId === 'member-a' ? spaces : [personalB],
    }),
    login: async (input) => {
      accountId = input.accountId;
      return { accountId };
    },
    logout: async () => ({ accountId }),
  };
  const shell = createMemberShell(
    api,
    createSpacePreferenceStore(() => undefined),
  );
  shell.start();
  await tick();
  await shell.space.select('team-a');
  const former = shell.getSnapshot().session.epoch;
  const delayedPicker = () => shell.requestSpace('team-a', undefined, former);
  await shell.session.logout();
  assert.equal(shell.space, undefined);
  await shell.session.login({ accountId: 'member-b', password: 'synthetic' });
  await tick();
  assert.equal(shell.getSnapshot().space.space.id, personalB.id);
  delayedPicker();
  await tick();
  assert.equal(shell.getSnapshot().space.status, 'ready');
  assert.equal(shell.getSnapshot().space.space.id, personalB.id);
  // A genuine current-account choice still goes through the original directory
  // check and remains closed when it is unavailable: no revocation fallback.
  shell.requestSpace('team-a', undefined, shell.getSnapshot().session.epoch);
  await tick();
  assert.equal(shell.getSnapshot().space.status, 'error');
  assert.equal(shell.getSnapshot().space.requestedSpaceId, 'team-a');
  shell.stop();
});

test('root shell contract: a changed member or revoked session in shared space recheck clears both consumers', async () => {
  let next = member();
  const { shell } = fixture({ session: async () => next });
  shell.start();
  await tick();
  next = member('member-b');
  await shell.space.select('team-a');
  assert.equal(shell.getSnapshot().session.status, 'signed-out');
  assert.equal(shell.space, undefined);
  shell.stop();
});

test('root shell contract: stopped ownership rejects late directory results and can restart for a new lifecycle', async () => {
  const held = deferred();
  let count = 0;
  const { shell } = fixture({ session: async () => (++count === 2 ? held.promise : member()) });
  shell.start();
  await tick();
  const previous = shell.space;
  shell.stop();
  held.resolve(member());
  await tick();
  assert.equal(shell.getSnapshot().session.status, 'restoring');
  assert.equal(shell.getSnapshot().space, undefined);
  shell.start();
  await tick();
  assert.equal(shell.getSnapshot().space.status, 'ready');
  assert.notEqual(shell.space, previous);
  shell.stop();
});

test('root shell static contract: account stays in footer and the shared main exposes its current space switcher', async () => {
  const { shell, reads } = fixture();
  shell.start();
  await tick();
  shell.setPageActive(true);
  const before = reads();
  const footer = renderToStaticMarkup(
    createElement(SidebarAccountFooter, { shell, wide: true, openWork() {} }),
  );
  const rail = renderToStaticMarkup(
    createElement(SidebarAccountFooter, { shell, wide: false, openWork() {} }),
  );
  const main = renderToStaticMarkup(createElement(MemberExecutionPage, { shell }));
  assert.match(footer, /账号与空间：member-a/);
  assert.match(footer, /个人 · 个人空间/);
  assert.match(rail, /data-wide="false"/);
  assert.match(rail, /title="member-a/);
  assert.match(main, /我的工作/);
  assert.match(main, /工作空间/);
  assert.equal(main.includes('zm-current-account'), false);
  assert.match(main, /aria-label="当前空间"/);
  assert.match(main, /title="个人 · 个人空间"/);
  assert.match(main, /zm-space-switcher/);
  assert.equal(main.includes('zm-space-summary'), false);
  assert.match(main, /aria-label="刷新空间"/);
  assert.equal(reads(), before); // Rendering consumers never restores or reads again.
  shell.stop();
});

test('member entries share their controllers while page changes fence an old deferred leave', async () => {
  const { shell } = fixture();
  shell.start();
  await tick();
  const space = shell.space;
  const session = shell.session;
  shell.setPageActive(true, 'team');
  const epoch = shell.getSnapshot().pageEpoch;
  let pending;
  let navigated = 0;
  const remove = shell.registerLeaveGuard(epoch, (proceed) => {
    pending = proceed;
  });
  shell.requestLeave(() => navigated++);
  assert.equal(navigated, 0);
  pending();
  assert.equal(navigated, 1);
  shell.requestLeave(() => navigated++);
  shell.setPageActive(true, 'work');
  assert.equal(shell.isPageCurrent(epoch), false);
  assert.equal(shell.space, space);
  assert.equal(shell.session, session);
  pending();
  assert.equal(navigated, 1);
  const next = shell.getSnapshot().pageEpoch;
  shell.registerLeaveGuard(next, (proceed) => {
    pending = proceed;
  });
  remove();
  shell.requestLeave(() => navigated++);
  assert.equal(navigated, 1);
  pending();
  assert.equal(navigated, 2);
  shell.setPageActive(true, 'work');
  assert.equal(shell.getSnapshot().pageEpoch, next);
  shell.stop();
});

test('root shell static contract: signed-out footer opens the login destination without fabricating an identity', async () => {
  const { shell } = fixture({
    session: async () => {
      throw new IdentityApiError('unauthenticated');
    },
  });
  shell.start();
  await tick();
  const html = renderToStaticMarkup(
    createElement(SidebarAccountFooter, { shell, wide: true, openWork() {} }),
  );
  assert.match(html, /登录账号/);
  assert.equal(html.includes('member-a'), false);
  assert.equal(html.includes('zm-control-icon'), false);
  shell.stop();
});

test('settings launcher keeps account and Settings as separate controls in both sidebar widths', async () => {
  const { shell } = fixture();
  shell.start();
  await tick();
  const props = {
    shell,
    settingsOpen: false,
    openWork() {},
    openSettings() {},
    openOnboarding() {},
  };
  for (const wide of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(SidebarAccountSettingsLauncher, { ...props, wide }),
    );
    assert.match(html, new RegExp(`data-wide="${wide}"`));
    assert.match(html, /aria-label="账号与空间：member-a"/);
    assert.match(html, /aria-label="设置"/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.equal((html.match(/zm-settings-trigger/g) ?? []).length, 1);
  }
  shell.stop();
});
