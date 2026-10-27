/** Actual D cleanup + original C SDK retirement/close. Member/model inputs and
 * the manually driven trusted bridge remain the explicit PR198 fixtures. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  bootReviewService,
  readExecutionReviewState,
} from './zhuma-native-review-service-stop-bundle.ts';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-review-stop-sdk-'));
  const closes = [];
  t.onTestFinished(async () => {
    for (const close of closes.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  return bootReviewService(root, (close) => closes.push(close));
}
function checked(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
function fenceAndRevoke(h) {
  h.d.service.fenceRuns();
  h.d.members.clear();
  h.d.member.abort();
  h.d.source.abort();
  assert.throws(() => h.d.service.assertExpertReviewDriveGrant(h.drive.grant, 'send'));
  h.d.service.assertExpertReviewCleanupAuthority(h.drive.cleanup);
}
function stopped(h) {
  const state = readExecutionReviewState(h.d.read()).attempts[0];
  assert.equal(state.status, 'cancelled');
  assert.equal(state.stopPhase, 'confirmed');
  assert.equal(state.resources, 'settled');
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
}

test('real SDK close order: genuine cleanup after dispatch fence and member/Host revocation settles its exact scope before native close', async (t) => {
  const h = await setup(t),
    binding = await h.run();
  const modelCalls = h.adapter.requests.length,
    reads = h.reads.length;
  fenceAndRevoke(h);
  h.d.resetCounts();
  assert.equal((await h.d.service.retireExpertReviewForCleanup({ ...h.drive.cleanup })).ok, false);
  assert.equal(h.d.counters.nodes, 0);
  // The existing result owner closes before native.close in the original Host.
  await h.owner.close();
  const result = checked(await h.d.service.retireExpertReviewForCleanup(h.drive.cleanup));
  assert.equal(result.status, 'settled');
  stopped(h);
  h.d.service.assertExpertReviewDrained(h.drive.grant.scope);
  assert.equal(h.native.ctx.agents.get(binding.nativeAgentId), undefined);
  assert.equal(
    h.native.runtime.migrationDrain(binding.nativeSessionId).basis,
    'flushed-and-closed',
  );
  assert.equal(h.adapter.requests.length, modelCalls);
  assert.equal(h.reads.length, reads);
  await h.native.close();
  // A persisted settled label cannot revive the now-closed physical view.
  assert.throws(() => h.d.service.assertExpertReviewDrained(h.drive.grant.scope));
  await h.d.service.closeRuns();
  assert.throws(() => h.d.service.assertExpertReviewCleanupAuthority(h.drive.cleanup));
  assert.equal((await h.d.service.retireExpertReviewForCleanup(h.drive.cleanup)).ok, false);
});

test('real SDK close order: closing native first cannot turn missing Agent or sealed cleanup refusal into D settled resources', async (t) => {
  const h = await setup(t),
    binding = await h.run(),
    registry = h.native.ctx.agents;
  fenceAndRevoke(h);
  await h.owner.close();
  await h.native.close();
  assert.equal(registry.get(binding.nativeAgentId), undefined);
  const result = await h.d.service.retireExpertReviewForCleanup(h.drive.cleanup);
  assert.equal(result.ok, false, 'a sealed C owner cannot provide a current C192 certificate');
  const state = readExecutionReviewState(h.d.read()).attempts[0];
  assert.equal(state.stopPhase, 'requested');
  assert.equal(state.resources, 'held');
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.throws(() => h.d.service.assertExpertReviewDrained(h.drive.grant.scope));
});

test('real SDK close order: an aborted cleanup wait keeps real target-source completion owned and cannot settle before physical retirement', async (t) => {
  const h = await setup(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.onTestFinished(() => release.resolve());
  const originalRead = h.d.service.readExpertReviewResource.bind(h.d.service);
  // Fault injection holds the real D reader's acquired source result. The C
  // source Promise remains physically pending, even if its logical wait aborts.
  h.d.service.readExpertReviewResource = async (...args) => {
    const actual = await originalRead(...args);
    entered.resolve();
    await release.promise;
    return actual;
  };
  const running = h.run().then(
    () => ({ ok: true }),
    () => ({ ok: false }),
  );
  await entered.promise;
  const binding = h.native.service.open(h.grant).binding;
  fenceAndRevoke(h);
  const stopWritten = Promise.withResolvers();
  h.d.faults.afterNodeWrite = (row) => {
    if (readExecutionReviewState(row)?.attempts[0]?.stopPhase === 'requested')
      stopWritten.resolve();
  };
  const waiter = new AbortController();
  const retiring = h.d.service.retireExpertReviewForCleanup(h.drive.cleanup, waiter.signal);
  await stopWritten.promise;
  waiter.abort();
  const pending = checked(await retiring);
  assert.equal(pending.status, 'pending');
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'held');
  assert.throws(() => h.d.service.assertExpertReviewDrained(h.drive.grant.scope));
  assert.throws(() => h.native.runtime.migrationDrain(binding.nativeSessionId));
  let physicallyIdle = false;
  const drained = h.native.service.whenRetirementsIdle().then(() => {
    physicallyIdle = true;
  });
  await new Promise(setImmediate);
  assert.equal(physicallyIdle, false);
  release.resolve();
  await running;
  await drained;
  assert.equal(
    checked(await h.d.service.retireExpertReviewForCleanup(h.drive.cleanup)).status,
    'settled',
  );
  stopped(h);
  h.d.service.assertExpertReviewDrained(h.drive.grant.scope);
  assert.equal(
    h.native.runtime.migrationDrain(binding.nativeSessionId).basis,
    'flushed-and-closed',
  );
  assert.equal(h.native.ctx.agents.get(binding.nativeAgentId), undefined);
  assert.equal(h.adapter.requests.length, 1);
  await h.owner.close();
  await h.native.close();
});
