import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberSessionController } from '../dist/identity/session.js';
import { changePasswordAndInvalidate } from '../dist/identity/password-change.js';

function memberController() {
  let account = 'ann';
  const calls = [];
  const controller = createMemberSessionController({
    async session() {
      return {
        accountId: account,
        principal: { kind: 'zhuma-member', memberId: account },
        peerId: 'peer-' + account,
        spaces: [],
      };
    },
    async login(input) {
      account = input.accountId;
      return { accountId: account };
    },
    async logout() {
      calls.push(account);
      return { accountId: account };
    },
  });
  return { controller, calls };
}

test('password response retained across account/epoch replacement cannot clear or sign out the new session', async () => {
  for (const replacement of ['bob', 'ann']) {
    const { controller, calls } = memberController();
    await controller.restore();
    const original = controller.getSnapshot();
    let release;
    let clearCount = 0;
    const response = new Promise((done) => {
      release = done;
    });
    const pending = changePasswordAndInvalidate(
      { changePassword: () => response },
      { oldPassword: 'synthetic-old', newPassword: 'synthetic-new' },
      new AbortController().signal,
      controller,
      { accountId: 'ann', epoch: original.epoch },
      () => {
        clearCount++;
      },
    );
    await controller.logout();
    await controller.login({ accountId: replacement, password: 'synthetic' });
    const current = controller.getSnapshot();
    const logoutCount = calls.length;
    release({ reauthenticate: true });
    assert.equal(await pending, false);
    assert.equal(controller.getSnapshot(), current);
    assert.equal(current.status, 'authenticated');
    assert.equal(current.session.accountId, replacement);
    assert.equal(calls.length, logoutCount);
    assert.equal(clearCount, 0);
    controller.dispose();
  }
});

test('same-session successful password change clears its form and invalidates the known revoked session', async () => {
  const { controller, calls } = memberController();
  await controller.restore();
  const original = controller.getSnapshot();
  let clearCount = 0;
  assert.equal(
    await changePasswordAndInvalidate(
      { changePassword: async () => ({ reauthenticate: true }) },
      { oldPassword: 'synthetic-old', newPassword: 'synthetic-new' },
      new AbortController().signal,
      controller,
      { accountId: 'ann', epoch: original.epoch },
      () => {
        clearCount++;
      },
    ),
    true,
  );
  assert.equal(controller.getSnapshot().status, 'signed-out');
  assert.equal(clearCount, 1);
  assert.deepEqual(
    calls,
    [],
    'No cookie-expiring logout request is needed for an already revoked session',
  );
  controller.dispose();
});
