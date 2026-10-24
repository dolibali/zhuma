import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityApiError } from '../dist/identity/api.js';
import { createMemberSessionController } from '../dist/identity/session.js';

const member = (accountId) => ({
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: `peer-${accountId}`,
  spaces: [],
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function apiWith(overrides = {}) {
  return {
    login: async ({ accountId }) => ({ accountId }),
    session: async () => {
      throw new IdentityApiError('unauthenticated');
    },
    logout: async () => ({ accountId: 'member-a' }),
    ...overrides,
  };
}

test('session contract: explicit restore only, no password in state, login rechecks the server session', async () => {
  const calls = [];
  let authenticated = false;
  const api = apiWith({
    login: async (credentials) => {
      calls.push('login');
      authenticated = true;
      return { accountId: credentials.accountId };
    },
    session: async () => {
      calls.push('session');
      if (!authenticated) throw new IdentityApiError('unauthenticated');
      return member('member-a');
    },
  });
  const controller = createMemberSessionController(api);
  const states = [];
  const unsubscribe = controller.subscribe(() => states.push(controller.getSnapshot()));
  assert.deepEqual(calls, []);
  await controller.restore();
  assert.equal(controller.getSnapshot().status, 'signed-out');
  await controller.login({ accountId: 'member-a', password: 'fixture-only' });
  assert.deepEqual(calls, ['session', 'login', 'session']);
  assert.equal(controller.getSnapshot().session.accountId, 'member-a');
  assert.equal(JSON.stringify(states).includes('fixture-only'), false);
  assert.deepEqual(
    states.map(({ status }) => status),
    ['restoring', 'signed-out', 'signing-in', 'authenticated'],
  );
  unsubscribe();
});

test('session contract: duplicate login is ignored and a changed account cannot mount protected content', async () => {
  const login = deferred();
  let count = 0;
  const controller = createMemberSessionController(
    apiWith({
      login: () => {
        ++count;
        return login.promise;
      },
      session: async () => member('member-b'),
    }),
  );
  controller.invalidate();
  const first = controller.login({ accountId: 'member-a', password: 'fixture-only' });
  await controller.login({ accountId: 'member-b', password: 'ignored' });
  assert.equal(count, 1);
  login.resolve({ accountId: 'member-a' });
  await first;
  assert.equal(controller.getSnapshot().status, 'signed-out');
  assert.equal(controller.getSnapshot().error.code, 'session-changed');
});

test('session contract: dispose/restart (including StrictMode replay) isolates a late restore', async () => {
  const old = deferred();
  const signals = [];
  let count = 0;
  const controller = createMemberSessionController(
    apiWith({
      session: (signal) => {
        signals.push(signal);
        return ++count === 1 ? old.promise : Promise.resolve(member('member-b'));
      },
    }),
  );
  const first = controller.restore();
  controller.dispose();
  assert.equal(signals[0].aborted, true);
  await controller.restore();
  const current = controller.getSnapshot();
  old.resolve(member('member-a'));
  await first;
  assert.equal(controller.getSnapshot(), current);
  assert.equal(current.session.accountId, 'member-b');
});

test('session contract: logout hides the account immediately; failure remains closed until retry/401', async () => {
  const logout = deferred();
  let count = 0;
  const controller = createMemberSessionController(
    apiWith({
      session: async () => member('member-a'),
      logout: () =>
        ++count === 1 ? logout.promise : Promise.reject(new IdentityApiError('unauthenticated')),
    }),
  );
  await controller.restore();
  const request = controller.logout();
  assert.deepEqual(controller.getSnapshot(), { status: 'signing-out' });
  logout.reject(new IdentityApiError('unavailable'));
  await request;
  assert.equal(controller.getSnapshot().status, 'unavailable');
  assert.equal(controller.getSnapshot().action, 'logout');
  assert.equal('session' in controller.getSnapshot(), false);
  const closed = controller.getSnapshot();
  await controller.restore();
  assert.equal(controller.getSnapshot(), closed);
  await controller.logout();
  assert.deepEqual(controller.getSnapshot(), { status: 'signed-out' });
});

test('session contract: a protected 401 from an old account epoch cannot invalidate a newer login', async () => {
  let accountId = 'member-a';
  const controller = createMemberSessionController(
    apiWith({ session: async () => member(accountId) }),
  );
  await controller.restore();
  const oldEpoch = controller.getSnapshot().epoch;
  await controller.logout();
  accountId = 'member-b';
  await controller.login({ accountId, password: 'fixture-only' });
  const current = controller.getSnapshot();
  controller.invalidate(oldEpoch);
  assert.equal(controller.getSnapshot(), current);
  controller.invalidate(current.epoch);
  assert.equal(controller.getSnapshot().error.code, 'unauthenticated');
});

test('session contract: old login completion after unmount cannot issue a follow-up session read', async () => {
  const login = deferred();
  let reads = 0;
  const controller = createMemberSessionController(
    apiWith({
      login: () => login.promise,
      session: async () => {
        ++reads;
        return member('member-a');
      },
    }),
  );
  controller.invalidate();
  const pending = controller.login({ accountId: 'member-a', password: 'fixture-only' });
  controller.dispose();
  login.resolve({ accountId: 'member-a' });
  await pending;
  assert.equal(reads, 0);
  assert.deepEqual(controller.getSnapshot(), { status: 'restoring' });
});

test('session contract: unavailable restore can recover; an owner session never becomes a member', async () => {
  let failure = new IdentityApiError('unavailable');
  const controller = createMemberSessionController(
    apiWith({
      session: async () => {
        throw failure;
      },
    }),
  );
  await controller.restore();
  assert.equal(controller.getSnapshot().status, 'unavailable');
  failure = new IdentityApiError('member-session-required');
  await controller.restore();
  assert.deepEqual(controller.getSnapshot(), { status: 'signed-out' });
});
