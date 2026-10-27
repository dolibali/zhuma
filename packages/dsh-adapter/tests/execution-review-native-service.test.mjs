import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { checked, refused, caller, open } from './execution-service-run-fixture.mjs';
import { nativeReviewHost } from './execution-review-native-fixture.mjs';
import { readExecutionReviewState } from '../dist/execution-review-state.js';
import { NativeReviewError } from '../dist/native-work-session-review-contract.js';
import { reviewFileResourceRef } from '../dist/execution-review-target-reader.js';

// Original Service/queue/JSON and actual local attachment where specified.
// All native issuer/read/cut/drain inputs are EXPLICIT CONTRACTS, not SDK proof.
test('native review Service: one original put contains completion, expert ballot and receipt before downstream and separate cleanup', async (t) => {
  const h = await nativeReviewHost(t);
  const writes = [];
  h.faults.afterNodeWrite = (row) => writes.push(structuredClone(row));
  const result = checked(
    await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
  );
  assert.equal(result.status, 'committed');
  assert.equal(result.cleanup, 'settled');
  const original = writes.find((row) => row.nodeId === 'produce');
  assert.equal(original.command.status, 'completed');
  assert.equal(original.rounds[0].ballots.length, 1);
  assert.equal(original.rounds[0].ballots[0].reviewerId, 'qa');
  const first = readExecutionReviewState(original).attempts[0];
  assert.equal(first.status, 'completed');
  assert.equal(first.resources, 'held');
  assert.deepEqual(first.result, result.receipt);
  assert.equal(writes.find((row) => row.nodeId === 'consume').command.status, 'ready');
  assert.equal(readExecutionReviewState(h.read()).attempts[0].resources, 'settled');
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.calls.release, 1);
  assert.equal(h.calls.retire, 1);
  assert.throws(() => h.service.assertExpertReviewDriveGrant(h.drive.grant, 'send'));
  refused(
    await h.service.recordNativeReviewEvent(h.drive.grant, {
      scope: h.drive.grant.scope,
      kind: 'completed',
      sequence: 2,
    }),
    'review-authority-denied',
  );
});

test('native review Service: lost reply confirmation and exact submit retry never reopen C or duplicate the original ballot', async (t) => {
  const h = await nativeReviewHost(t);
  const first = checked(
    await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
  );
  const node = JSON.stringify(h.read()),
    calls = { ...h.calls };
  h.resetCounts();
  const confirmed = checked(await h.service.confirmNativeFixedReview(h.request, h.command));
  const replay = checked(await h.service.submitNativeFixedReview(h.request, h.command, {}));
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed.receipt, first.receipt);
  assert.deepEqual(replay, confirmed);
  assert.equal(JSON.stringify(h.read()), node);
  assert.deepEqual(h.calls, calls);
  assert.equal(h.counters.nodes, 0);
  refused(
    await h.service.confirmNativeFixedReview(h.request, { ...h.command, requestId: 'different' }),
    'review-result-conflict',
  );
});

test('native review Service: omitted actual fixed UTF8 file produces attention, no ballot and no downstream while cleanup remains separate', async (t) => {
  const h = await nativeReviewHost(t, {
    file: { name: 'acceptance.txt', mediaType: 'text/plain', text: '必须验证未读附件内容。' },
  });
  const file = h.read().artifactVersions[0].files[0];
  const result = checked(
    await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
  );
  assert.equal(result.status, 'needs-attention');
  assert.equal(result.failure.code, 'review-read-required');
  assert.deepEqual(result.failure.resourceRefs, [reviewFileResourceRef(file.id)]);
  assert.equal(result.cleanup, 'settled');
  assert.equal(h.read().command.status, 'in-review');
  assert.equal(h.read().rounds[0].ballots.length, 0);
  assert.equal(h.read('consume').command.status, 'blocked');
  const attempt = readExecutionReviewState(h.read()).attempts[0];
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.resources, 'settled');
  assert.equal(attempt.result, undefined);
  const calls = { ...h.calls };
  h.resetCounts();
  assert.deepEqual(checked(await h.service.confirmNativeFixedReview(h.request, h.command)), result);
  assert.deepEqual(h.calls, calls);
  assert.equal(h.counters.nodes, 0);
});

test('native review Service: partial page and trusted native unsupported failure leave the original review obligation without retrying a model', async (t) => {
  for (const kind of ['partial', 'unsupported']) {
    const h = await nativeReviewHost(t);
    if (kind === 'partial') h.hooks.facts = { ranges: [[0, 4]] };
    else
      h.hooks.prepare = () => {
        throw new NativeReviewError('review-unsupported-material');
      };
    const result = checked(
      await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
    );
    assert.equal(result.status, 'needs-attention');
    assert.equal(
      result.failure.code,
      kind === 'partial' ? 'review-read-required' : 'review-unsupported-material',
    );
    assert.equal(h.read().rounds[0].ballots.length, 0);
    assert.equal(h.read('consume').command.status, 'blocked');
    assert.equal(h.calls.prepare, 1);
    assert.equal(h.calls.retire, 1);
  }
});

test('native review Service: missing native port, copied driver, asynchronous assertion and persistence failure cannot cast any partial ballot', async (t) => {
  for (const kind of ['missing-port', 'copied-drive', 'async-assert', 'write']) {
    const h = await nativeReviewHost(t, { install: kind !== 'missing-port' });
    if (kind === 'async-assert') h.hooks.assert = async () => undefined;
    if (kind === 'write') h.faults.node = true;
    const before = JSON.stringify(h.read());
    const result = await h.service.submitNativeFixedReview(
      h.request,
      h.command,
      kind === 'copied-drive' ? { ...h.drive.grant } : h.drive.grant,
    );
    assert.equal(result.ok, false, kind);
    assert.equal(JSON.stringify(h.read()), before, kind);
    assert.equal(h.read().rounds[0].ballots.length, 0);
    assert.equal(h.counters.nodes, 0);
  }
});

test('native review Service: member revocation while original C lease is pending leaves zero vote and downstream writes', async (t) => {
  const h = await nativeReviewHost(t);
  let releaseRead;
  h.hooks.read = () =>
    new Promise((resolve) => {
      releaseRead = resolve;
    });
  const pending = h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant);
  while (!releaseRead) await setImmediate();
  h.member.abort();
  releaseRead();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(h.read().rounds[0].ballots.length, 0);
  assert.equal(h.counters.nodes, 0);
  assert.equal(h.calls.retire, 0);
});

test('native review Service: same-round peer progress is read fresh before the original atomic vote', async (t) => {
  const h = await nativeReviewHost(t, { reviewerIds: ['qa', 'outside'] });
  let releaseRead;
  h.hooks.read = () =>
    new Promise((resolve) => {
      releaseRead = resolve;
    });
  const pending = h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant);
  while (!releaseRead) await setImmediate();
  const target = h.drive.grant.scope.review.target;
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'peer-vote'),
      roundId: target.roundId,
      artifactVersionId: target.artifactVersionId,
      action: 'approve',
    }),
  );
  releaseRead();
  const result = checked(await pending);
  assert.equal(result.status, 'committed');
  assert.equal(h.read().rounds[0].ballots.length, 2);
  assert.equal(h.read().command.status, 'completed');
  assert.equal(h.read('consume').command.status, 'ready');
});

test('native review Service: concurrent exact requests converge to one receipt and one native completion', async (t) => {
  const h = await nativeReviewHost(t);
  const replies = await Promise.all([
    h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
    h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
  ]);
  const values = replies.map(checked);
  assert.deepEqual(values[0].receipt, values[1].receipt);
  assert.equal(h.read().rounds[0].ballots.length, 1);
  assert.equal(h.read().comments.length, 1);
  assert.equal(readExecutionReviewState(h.read()).attempts.length, 1);
});

test('native review Service: cleanup failure after durable vote preserves a confirmable receipt and held resources until explicit recovery', async (t) => {
  const h = await nativeReviewHost(t);
  h.hooks.retire = () => {
    throw Error('CONTRACT_PHYSICAL_CLEANUP_UNAVAILABLE');
  };
  const result = checked(
    await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
  );
  assert.equal(result.status, 'committed');
  assert.equal(result.cleanup, 'failed');
  assert.equal(readExecutionReviewState(h.read()).attempts[0].resources, 'held');
  const calls = { ...h.calls };
  const confirmed = checked(await h.service.confirmNativeFixedReview(h.request, h.command));
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed.receipt, result.receipt);
  assert.deepEqual(h.calls, calls);
  delete h.hooks.retire;
  assert.equal(
    checked(await h.service.settleNativeReviewCleanup(h.drive.grant.scope)).status,
    'settled',
  );
  assert.equal(readExecutionReviewState(h.read()).attempts[0].resources, 'settled');
  assert.equal(h.read().rounds[0].ballots.length, 1);
});

test('native review Service: failed original downstream outbox is repaired by exact recovery without reading C or recasting a ballot', async (t) => {
  const h = await nativeReviewHost(t);
  h.faults.afterNodeWrite = (row) => {
    if (row.nodeId === 'produce' && row.rounds[0].ballots.length) h.faults.node = true;
  };
  assert.equal(
    (await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant)).ok,
    false,
  );
  assert.equal(h.read().command.status, 'completed');
  assert.equal(h.read().rounds[0].ballots.length, 1);
  assert.equal(h.read('consume').command.status, 'blocked');
  const calls = { ...h.calls };
  h.faults.node = false;
  delete h.faults.afterNodeWrite;
  h.resetCounts();
  const confirmed = checked(await h.service.confirmNativeFixedReview(h.request, h.command));
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(h.counters.nodes, 0, 'passive confirmation never repairs outbox');
  assert.equal(
    checked(await h.service.submitNativeFixedReview(h.request, h.command, {})).status,
    'confirmed',
  );
  assert.equal(h.read('consume').command.status, 'ready');
  assert.equal(h.read().rounds[0].ballots.length, 1);
  assert.deepEqual(h.calls, calls);
});

test('native review Service: new Service on original JSON confirms history without any original native port or drive', async (t) => {
  const h = await nativeReviewHost(t);
  const result = checked(
    await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
  );
  await h.close();
  const cold = await open(h.root, { seed: false, workbench: h.snapshot });
  t.after(() => cold.close());
  cold.resetCounts();
  const confirmed = checked(await cold.service.confirmNativeFixedReview(cold.request, h.command));
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed.receipt, result.receipt);
  assert.equal(cold.counters.nodes, 0);
  refused(
    await cold.service.openExpertReviewDrive(cold.request, h.locator),
    'review-authority-denied',
  );
});

test('native review Service: a fixed proof for another target cannot produce any original node write', async (t) => {
  const h = await nativeReviewHost(t);
  const wrong = structuredClone(h.drive.grant.scope);
  wrong.review.target.roundId = 'wrong-round';
  h.hooks.facts = { proofScope: wrong };
  refused(
    await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
    'review-result-invalid',
  );
  assert.equal(h.counters.nodes, 0);
  assert.equal(h.read().rounds[0].ballots.length, 0);
});
