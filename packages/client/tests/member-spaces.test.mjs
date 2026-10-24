import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityApiError } from '../dist/identity/api.js';
import { createMemberSpaceController } from '../dist/identity/spaces.js';

const personal = { id: 'personal-a', kind: 'personal', name: 'My space' };
const teamA = { id: 'team-a', kind: 'team', name: 'Product' };
const teamB = { id: 'team-b', kind: 'team', name: 'Operations' };
const member = (spaces = [teamA, personal, teamB], accountId = 'member-a') => ({
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: `peer-${accountId}`,
  spaces,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('space selection contract: no eager work, trusted personal default, empty spaces and team-only accounts', async () => {
  for (const [spaces, expected] of [
    [[teamA, personal, teamB], personal],
    [[teamB], teamB],
    [[], undefined],
  ]) {
    let reads = 0;
    const controller = createMemberSpaceController(
      {
        session: async () => {
          reads++;
          return member(spaces);
        },
      },
      member(spaces),
      () => assert.fail('unexpected invalidation'),
    );
    assert.equal(reads, 0);
    assert.equal(controller.getSnapshot().status, 'checking');
    await controller.refresh();
    assert.equal(reads, 1);
    const state = controller.getSnapshot();
    assert.equal(state.status, expected ? 'ready' : 'empty');
    assert.deepEqual(state.space, expected);
    controller.dispose();
  }
});

test('space selection contract: each actual switch revalidates and immediately removes the old ready projection', async () => {
  const next = deferred();
  let reads = 0;
  const controller = createMemberSpaceController(
    { session: async () => (++reads === 1 ? member() : next.promise) },
    member(),
    () => {},
  );
  await controller.refresh();
  await controller.select(personal.id);
  assert.equal(reads, 1);
  const pending = controller.select(teamB.id);
  assert.equal(controller.getSnapshot().status, 'checking');
  assert.equal(controller.getSnapshot().space, undefined);
  next.resolve(member());
  await pending;
  assert.deepEqual(controller.getSnapshot().space, teamB);
  controller.dispose();
});

test('space selection contract: late A -> B -> A reads cannot reopen the intermediate space, even if abort is ignored', async () => {
  const requests = [];
  const controller = createMemberSpaceController(
    {
      session(signal) {
        const request = deferred();
        requests.push({ ...request, signal });
        return request.promise;
      },
    },
    member(),
    () => {},
  );
  const first = controller.select(teamA.id);
  const second = controller.select(teamB.id);
  const third = controller.select(teamA.id);
  assert.ok(requests[0].signal.aborted);
  assert.ok(requests[1].signal.aborted);
  requests[2].resolve(member());
  await third;
  const active = controller.getSnapshot();
  requests[1].resolve(member());
  await second;
  requests[0].resolve(member());
  await first;
  assert.equal(controller.getSnapshot(), active);
  assert.equal(active.space.id, teamA.id);
  controller.dispose();
});

test('space selection contract: unavailable space never falls back to another authorized space without a new action', async () => {
  const controller = createMemberSpaceController(
    { session: async () => member([personal]) },
    member(),
    () => {},
  );
  await controller.select(teamA.id);
  const state = controller.getSnapshot();
  assert.equal(state.status, 'error');
  assert.equal(state.error.code, 'space-unavailable');
  assert.equal(state.space, undefined);
  assert.deepEqual(state.session.spaces, [personal]);
  await controller.select(personal.id);
  assert.equal(controller.getSnapshot().status, 'ready');
  controller.dispose();
});

test('space selection contract: empty or unknown selection cannot silently choose the default space', async () => {
  const controller = createMemberSpaceController(
    { session: async () => member() },
    member(),
    () => {},
  );
  for (const id of ['', 'unknown-space']) {
    await controller.select(id);
    assert.equal(controller.getSnapshot().status, 'error');
    assert.equal(controller.getSnapshot().error.code, 'space-unavailable');
    assert.equal(controller.getSnapshot().space, undefined);
  }
  controller.dispose();
});

test('space selection contract: disposal clears the presentation and effect restart creates a new generation', async () => {
  const controller = createMemberSpaceController(
    { session: async () => member() },
    member(),
    () => {},
  );
  await controller.refresh();
  const oldEpoch = controller.getSnapshot().epoch;
  controller.dispose();
  assert.equal(controller.getSnapshot().status, 'checking');
  await controller.refresh();
  const current = controller.getSnapshot();
  assert.ok(current.epoch > oldEpoch);
  controller.invalidate(oldEpoch);
  assert.equal(controller.getSnapshot(), current);
  controller.dispose();
});

test('space selection contract: same-space refresh keeps the presentation generation, revoked access closes it', async () => {
  let next = member();
  const controller = createMemberSpaceController({ session: async () => next }, member(), () => {});
  await controller.refresh();
  const epoch = controller.getSnapshot().epoch;
  const refreshing = controller.refresh();
  assert.equal(controller.getSnapshot().status, 'ready');
  assert.equal(controller.getSnapshot().refreshing, true);
  await refreshing;
  assert.equal(controller.getSnapshot().epoch, epoch);
  next = member([teamB]);
  await controller.refresh();
  assert.equal(controller.getSnapshot().status, 'error');
  assert.equal(controller.getSnapshot().space, undefined);
  controller.dispose();
});

test('space selection contract: failures close content, only current authentication errors invalidate the login boundary', async () => {
  for (const failure of [
    new IdentityApiError('unauthenticated'),
    new IdentityApiError('member-session-required'),
    new Error('private backend details'),
  ]) {
    let invalidated = 0;
    const controller = createMemberSpaceController(
      {
        session: async () => {
          throw failure;
        },
      },
      member(),
      () => invalidated++,
    );
    await controller.refresh();
    assert.equal(controller.getSnapshot().status, 'error');
    assert.equal(controller.getSnapshot().space, undefined);
    assert.equal(invalidated, failure instanceof IdentityApiError ? 1 : 0);
    assert.ok(!controller.getSnapshot().error.message.includes('private backend'));
    controller.dispose();
  }
});

test('space selection contract: changed account cannot reuse old member content', async () => {
  for (const session of [member([], 'member-b')]) {
    let invalidated = 0;
    const controller = createMemberSpaceController(
      { session: async () => session },
      member(),
      () => invalidated++,
    );
    await controller.refresh();
    assert.equal(controller.getSnapshot().status, 'error');
    assert.equal(controller.getSnapshot().error.code, 'session-changed');
    assert.equal(invalidated, 1);
    controller.dispose();
  }
});

test('space selection contract: request-local HTTP peers may change without replacing the member session', async () => {
  const controller = createMemberSpaceController(
    { session: async () => ({ ...member(), peerId: 'fresh-request-peer' }) },
    member(),
    () => assert.fail('HTTP peer is not a login identity'),
  );
  await controller.refresh();
  assert.equal(controller.getSnapshot().status, 'ready');
  await controller.select(teamA.id);
  assert.equal(controller.getSnapshot().space.id, teamA.id);
  controller.dispose();
});

test('space selection contract: old scoped failures and disposed requests cannot close or resurrect a new context', async () => {
  const late = deferred();
  let held = false,
    invalidated = 0;
  const controller = createMemberSpaceController(
    { session: async () => (held ? late.promise : member()) },
    member(),
    () => invalidated++,
  );
  await controller.refresh();
  const oldEpoch = controller.getSnapshot().epoch;
  await controller.select(teamB.id);
  const current = controller.getSnapshot();
  controller.invalidate(oldEpoch);
  assert.equal(controller.getSnapshot(), current);
  held = true;
  const reading = controller.select(teamA.id);
  controller.dispose();
  late.reject(new IdentityApiError('unauthenticated'));
  await reading;
  assert.equal(invalidated, 0);
  assert.notEqual(controller.getSnapshot().status, 'ready');
});
