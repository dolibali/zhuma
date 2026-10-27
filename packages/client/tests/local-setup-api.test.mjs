import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createLocalSetupApi, LocalSetupApiError } from '../dist/identity/local-setup-api.js';
import {
  LocalSetupForm,
  loginAfterLocalSetup,
  enterTeamAfterLocalSetup,
} from '../dist/identity/LocalSetupBoundary.js';
import { IdentityApiError } from '../dist/identity/api.js';
import { createMemberSessionController } from '../dist/identity/session.js';
import { createMemberShell } from '../dist/identity/shell.js';
import { createMemberSpaceController } from '../dist/identity/spaces.js';

const packs = [
  { id: 'zhuma-work-planning', version: '1.0.0', name: '工作规划专家', role: '规划与分工' },
];
const reply = (value) => Response.json({ version: 1, ok: true, value });
const team = { id: 'trusted-created-team-receipt', kind: 'team', name: '实际创建的团队' };
const signal = () => new AbortController().signal;
const input = {
  requestId: '93229ea7-fd11-4575-b7af-40b7337f3e01',
  accountId: 'ann',
  password: 'synthetic-password-only',
  teamName: '研发团队',
  packIds: packs.map((p) => p.id),
};

test('first setup Client API contract: exact same-origin owner paths and fields, detached bounded replies', async () => {
  const calls = [];
  const api = createLocalSetupApi(async (url, options) => {
    calls.push({ url, options });
    return reply({
      kind: options.method === 'GET' ? 'pending' : 'configured',
      requestId: input.requestId,
      packs,
      ...(options.method === 'POST' ? { createdTeam: team } : {}),
    });
  });
  const state = await api.status(signal());
  assert.equal(state.kind, 'pending');
  assert.equal(state.requestId, input.requestId);
  assert(Object.isFrozen(state.packs[0]));
  assert.equal(JSON.stringify(state).includes(input.password), false);
  const initialized = await api.initialize(
    { ...input, actorId: 'not-accepted', ready: true },
    signal(),
  );
  assert.equal(initialized.kind, 'configured');
  assert.deepEqual(initialized.createdTeam, team);
  assert(Object.isFrozen(initialized.createdTeam));
  assert.deepEqual(
    calls.map((call) => [call.url, call.options.method]),
    [
      ['/api/zhuma-local-setup/status', 'GET'],
      ['/api/zhuma-local-setup/initialize', 'POST'],
    ],
  );
  for (const call of calls) {
    assert.equal(call.options.credentials, 'same-origin');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.cache, 'no-store');
  }
  assert.deepEqual(JSON.parse(calls[1].options.body), input);
  assert.equal(calls[0].options.body, undefined);
});

test('first setup Client API contract: foreign owner, unknown error and malformed state never become readiness', async () => {
  for (const [response, code] of [
    [new Response('', { status: 403 }), 'untrusted-request'],
    [
      Response.json({ error: { code: 'conflict', message: input.password } }, { status: 409 }),
      'conflict',
    ],
    [
      Response.json({ error: { code: 'toString', message: input.password } }, { status: 503 }),
      'unavailable',
    ],
    [reply({ kind: 'pending', packs }), 'invalid-response'],
    [
      reply({ kind: 'configured', packs, createdTeam: { ...team, kind: 'personal' } }),
      'invalid-response',
    ],
    [reply({ kind: 'configured', packs: [...packs, ...packs] }), 'invalid-response'],
    [
      reply({ kind: 'configured', packs: [{ ...packs[0], version: 'private-next' }] }),
      'invalid-response',
    ],
  ]) {
    await assert.rejects(createLocalSetupApi(async () => response).status(signal()), (error) => {
      assert(error instanceof LocalSetupApiError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(input.password), false);
      return true;
    });
  }
});

test('first setup Client API contract: an already-cancelled view sends nothing and a late reply cannot become success', async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const api = createLocalSetupApi(async () => {
    calls++;
    return reply({ kind: 'configured', packs });
  });
  await assert.rejects(api.status(abort.signal));
  assert.equal(calls, 0);
  const late = new AbortController();
  const slow = createLocalSetupApi(async () => {
    late.abort();
    return reply({ kind: 'configured', packs });
  });
  // A fetch test port can return after abort. The API must still reject it.
  await assert.rejects(slow.initialize(input, late.signal));
});

test('first setup form SSR contract: real labels and explicit expert choices, no seeded user or credential value', () => {
  const html = renderToStaticMarkup(
    createElement(LocalSetupForm, {
      snapshot: { kind: 'unconfigured', packs },
      initialize: async () => {},
    }),
  );
  assert(html.includes('创建并进入工作台'));
  assert(html.includes('账号与团队'));
  assert(html.includes('团队基础专家'));
  assert(html.includes('type="checkbox"'));
  assert(html.includes('autoComplete="new-password"'));
  assert.equal(html.includes(input.password), false);
  assert.equal(html.includes('value="ann"'), false);
  const pending = renderToStaticMarkup(
    createElement(LocalSetupForm, {
      snapshot: { kind: 'pending', requestId: input.requestId, packs },
      initialize: async () => {},
    }),
  );
  assert(pending.includes('继续完成首次设置'));
});

test('first setup login contract: recheck an initially unavailable original controller before entering with the new account', async () => {
  let ready = false,
    authenticated = false,
    logins = 0;
  const controller = createMemberSessionController({
    session: async () => {
      if (!ready) throw new IdentityApiError('unavailable');
      if (!authenticated) throw new IdentityApiError('unauthenticated');
      return {
        accountId: input.accountId,
        principal: { kind: 'zhuma-member', memberId: input.accountId },
        peerId: 'contract-peer',
        spaces: [],
      };
    },
    login: async (credentials) => {
      assert.equal(credentials.accountId, input.accountId);
      authenticated = true;
      logins++;
      return { accountId: input.accountId };
    },
    logout: async () => ({ accountId: input.accountId }),
  });
  await controller.restore();
  assert.equal(controller.getSnapshot().status, 'unavailable');
  ready = true;
  await loginAfterLocalSetup(controller, input, signal());
  assert.equal(logins, 1);
  assert.equal(controller.getSnapshot().status, 'authenticated');
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(input.password), false);
  controller.dispose();
});

test('first setup login contract: closing the view during session recheck cannot start a late login', async () => {
  const checked = Promise.withResolvers(),
    abort = new AbortController();
  let logins = 0;
  const pending = loginAfterLocalSetup(
    {
      restore: () => checked.promise,
      login: async () => {
        logins++;
      },
    },
    input,
    abort.signal,
  );
  abort.abort();
  checked.resolve();
  await assert.rejects(pending);
  assert.equal(logins, 0);
});

test('first setup team landing contract: trusted receipt goes through fresh original space selection; later personal preference remains intact', async () => {
  let configured = false,
    authenticated = false;
  const preferences = new Map(),
    selected = [];
  const member = {
    accountId: input.accountId,
    principal: { kind: 'zhuma-member', memberId: input.accountId },
    peerId: 'contract-peer',
    spaces: [{ id: 'personal', kind: 'personal', name: '个人空间' }, team],
  };
  const api = {
    session: async () => {
      if (!configured) throw new IdentityApiError('unavailable');
      if (!authenticated) throw new IdentityApiError('unauthenticated');
      return member;
    },
    login: async () => {
      authenticated = true;
      return { accountId: input.accountId };
    },
    logout: async () => ({ accountId: input.accountId }),
  };
  const store = {
    read: (account) => preferences.get(account),
    save: (account, id) => {
      preferences.set(account, id);
      selected.push(id);
    },
    clearIfMatches: () => {},
  };
  const shell = createMemberShell(api, store);
  shell.start();
  try {
    await shell.session.restore();
    configured = true;
    await enterTeamAfterLocalSetup(shell, input, team, signal());
    assert.equal(shell.space.getSnapshot().status, 'ready');
    assert.equal(shell.space.getSnapshot().space.id, team.id);
    assert.deepEqual(selected, [team.id]);
    await shell.space.select('personal');
  } finally {
    shell.stop();
  }
  const reopened = createMemberShell(api, store);
  reopened.start();
  try {
    await reopened.session.restore();
    await reopened.space.refresh();
    assert.equal(reopened.space.getSnapshot().space.id, 'personal');
  } finally {
    reopened.stop();
  }
});

test('first setup team landing contract: cancel during original select restores prior space and cannot persist a late target', async () => {
  const member = {
    accountId: 'ann',
    principal: { kind: 'zhuma-member', memberId: 'ann' },
    peerId: 'contract-peer',
    spaces: [{ id: 'personal', kind: 'personal', name: '个人空间' }, team],
  };
  const checked = Promise.withResolvers(),
    saved = [];
  let hold = false;
  const spaces = createMemberSpaceController(
    { session: async () => (hold ? checked.promise : member) },
    member,
    () => {},
    { onConfirmedSelect: (id) => saved.push(id) },
  );
  await spaces.refresh();
  const previous = spaces.getSnapshot();
  hold = true;
  const abort = new AbortController(),
    pending = spaces.select(team.id, abort.signal);
  assert.equal(spaces.getSnapshot().status, 'checking');
  abort.abort();
  assert.equal(spaces.getSnapshot().status, 'ready');
  assert.equal(spaces.getSnapshot().space.id, 'personal');
  assert.notEqual(spaces.getSnapshot().epoch, previous.epoch);
  checked.resolve(member);
  await pending;
  assert.equal(spaces.getSnapshot().space.id, 'personal');
  assert.deepEqual(saved, []);
  spaces.dispose();
});
