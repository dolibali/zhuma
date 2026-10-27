/** Real D issuer/JSON/file bytes and original C SDK/fixed cut/retirement.
 * Scripted model + member/A qualifier fixtures; no login/automatic Host/UI claim. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  bootReviewService,
  readExecutionReviewState,
} from './zhuma-native-review-service-bundle.ts';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-review-service-sdk-'));
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

test('real Service and original SDK: fixed text and uploaded file reach an independent expert before atomic ballot, downstream and physical cleanup', async (t) => {
  const h = await setup(t);
  assert.equal(h.drive.grant.scope.review.principal.reviewerRef.id, 'qa');
  assert.equal(h.d.read().handoff.assignee.id, 'chen');
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.equal(h.resources.length, 2);
  const binding = await h.run();
  assert.equal(h.reads.length, 2);
  assert.equal(h.reads[0].bytes.toString(), h.d.read().artifactVersions[0].text);
  assert.equal(h.reads[1].bytes.toString(), '附件约定：保留旧调用方的 status 字段。');
  assert.equal(h.leases.size, 0);
  assert.deepEqual(h.adapter.requests[0].tools.map((tool) => tool.name).sort(), [
    'complete_review',
    'read_review_target',
  ]);
  const prepared = await h.review.prepareFixedReview(h.grant, new AbortController().signal);
  assert.equal(prepared.status, 'ready');
  await assert.rejects(
    h.review.readFixedReview(h.grant, { ...prepared.ref }, new AbortController().signal),
  );
  const actual = await h.review.readFixedReview(
    h.grant,
    prepared.ref,
    new AbortController().signal,
  );
  assert.equal(actual.readManifest.reads.length, 2);
  assert.deepEqual(
    actual.readManifest.reads.map((read) => read.source.resourceRef),
    h.resources.map((resource) => resource.resourceRef),
  );
  assert.ok(actual.readManifest.reads.every((read) => read.resultSeq < actual.source.cut.callSeq));
  assert.equal(actual.source.nativeSessionId, binding.nativeSessionId);
  actual.check();
  actual.release();
  const writes = [];
  h.d.faults.afterNodeWrite = (row) => writes.push(structuredClone(row));
  const result = checked(
    await h.d.service.submitNativeFixedReview(h.d.request, h.command, h.drive.grant),
  );
  assert.equal(result.status, 'committed');
  assert.equal(result.cleanup, 'settled');
  const atomic = writes.find((row) => row.nodeId === 'produce');
  assert.equal(atomic.command.status, 'completed');
  assert.equal(atomic.rounds[0].ballots.length, 1);
  assert.equal(atomic.rounds[0].ballots[0].reviewerId, 'qa');
  assert.equal(readExecutionReviewState(atomic).attempts[0].status, 'completed');
  assert.equal(readExecutionReviewState(atomic).attempts[0].resources, 'held');
  assert.equal(h.d.read('consume').command.status, 'ready');
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'settled');
  assert.equal(h.native.ctx.agents.get(binding.nativeAgentId), undefined);
  assert.equal(
    h.native.runtime.migrationDrain(binding.nativeSessionId).basis,
    'flushed-and-closed',
  );
  const models = h.adapter.requests.length;
  assert.equal(
    checked(await h.d.service.confirmNativeFixedReview(h.d.request, h.command)).status,
    'confirmed',
  );
  assert.equal(h.adapter.requests.length, models);
  assert.throws(() => h.d.service.assertExpertReviewDriveGrant(h.drive.grant, 'send'));
});

test('real Service and original SDK: reading only the text cannot approve an actual unread uploaded file', async (t) => {
  const h = await setup(t),
    binding = await h.run({ omitFile: true });
  const result = checked(
    await h.d.service.submitNativeFixedReview(h.d.request, h.command, h.drive.grant),
  );
  assert.equal(result.status, 'needs-attention');
  assert.equal(result.failure.code, 'review-read-required');
  assert.deepEqual(
    result.failure.resourceRefs,
    h.resources
      .filter((resource) => resource.kind === 'file')
      .map((resource) => resource.resourceRef),
  );
  assert.equal(result.cleanup, 'settled');
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.equal(h.native.ctx.agents.get(binding.nativeAgentId), undefined);
  assert.equal(
    h.native.runtime.migrationDrain(binding.nativeSessionId).basis,
    'flushed-and-closed',
  );
});

test('real Service and original SDK: copied Drive and wrong target fail before model; revoked member cannot ballot but genuine independent cleanup physically retires', async (t) => {
  const h = await setup(t);
  assert.throws(() => h.native.service.reviewGrant({ ...h.drive.grant }));
  assert.throws(() =>
    h.native.service.reviewGrant({
      ...h.drive.grant,
      scope: {
        ...h.drive.grant.scope,
        review: {
          ...h.drive.grant.scope.review,
          target: { ...h.drive.grant.scope.review.target, artifactVersionId: 'foreign-artifact' },
        },
      },
    }),
  );
  await assert.rejects(
    h.d.service.readExpertReviewResource(
      h.drive.grant,
      { resourceRef: 'foreign-file', offset: 0, length: 8 },
      new AbortController().signal,
    ),
  );
  assert.equal(h.adapter.requests.length, 0);
  const binding = await h.run();
  h.d.member.abort();
  const result = await h.d.service.submitNativeFixedReview(h.d.request, h.command, h.drive.grant);
  assert.equal(result.ok, false);
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  const cleaned = await h.native.service.retireReviewForCleanup(
    h.drive.cleanup,
    new AbortController().signal,
  );
  assert.equal(cleaned.status, 'retired');
  cleaned.drain.assertCurrent();
  assert.equal(h.native.ctx.agents.get(binding.nativeAgentId), undefined);
  assert.equal(
    h.native.runtime.migrationDrain(binding.nativeSessionId).basis,
    'flushed-and-closed',
  );
  // No fabricated D stop/settled event: only physical C retirement is proven here.
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'held');
});
