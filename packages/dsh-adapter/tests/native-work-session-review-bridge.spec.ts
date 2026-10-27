/** Original SDK and genuine Service proof, with explicit member/model/empty
 * adoption fixtures. No manual native event, ready fact or completion cut. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { bootReviewBridge, readExecutionReviewState } from './zhuma-native-review-bridge-bundle.ts';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-review-bridge-sdk-')),
    closes = [];
  t.onTestFinished(async () => {
    for (const close of closes.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  return bootReviewBridge(root, (close) => closes.push(close), options);
}

test('original SDK bridge: genuine claim automatically correlates actual receipt/adoption and fixed text/file reads to one ballot and downstream without manual events', async (t) => {
  const h = await setup(t);
  assert.equal(h.claim.reviewCandidates.length, 1);
  h.bridge.consumeClaim(h.d.request, h.claim);
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => h.d.read().command.status === 'completed');
  await h.bridge.whenIdle();
  const node = h.d.read(),
    attempt = readExecutionReviewState(node).attempts[0];
  assert.equal(attempt.status, 'completed');
  assert.equal(attempt.resources, 'settled');
  assert.equal(attempt.dispatch, 'received');
  assert.equal(attempt.nativeAgentId, attempt.nativeSessionId);
  assert.equal(node.rounds[0].ballots.length, 1);
  assert.equal(node.rounds[0].ballots[0].reviewerId, 'qa');
  assert.equal(h.d.read('consume').command.status, 'ready');
  assert.equal(h.reads.length, 2);
  assert.equal(h.reads[1].bytes.toString(), '固定附件：旧 status 参数必须兼容。');
  assert.equal(h.native.ctx.agents.get(attempt.nativeAgentId), undefined);
  assert.equal(
    h.native.runtime.migrationDrain(attempt.nativeSessionId).basis,
    'flushed-and-closed',
  );
  assert.equal(h.adapter.requests.length, 3);
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK bridge: omitted actual uploaded file records attention and cleans up without a ballot or downstream release', async (t) => {
  const h = await setup(t, { omitFile: true });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => readExecutionReviewState(h.d.read())?.attempts[0]?.resources === 'settled');
  await h.bridge.whenIdle();
  const node = h.d.read(),
    attempt = readExecutionReviewState(node).attempts[0];
  assert.equal(attempt.failure.code, 'review-read-required');
  assert.equal(node.rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.equal(h.native.ctx.agents.get(attempt.nativeAgentId), undefined);
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK bridge: mismatched A adoption never reaches a model or votes and genuine cleanup keeps the original scope', async (t) => {
  const h = await setup(t, { adoption: { configurationId: 'foreign-configuration' } });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => readExecutionReviewState(h.d.read())?.attempts[0]?.resources === 'settled');
  await h.bridge.whenIdle();
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].status, 'cancelled');
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK bridge: pending draining is awakened by the original owner late ready notification without another model or idle injection', async (t) => {
  const pending = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.onTestFinished(() => release.resolve());
  const h = await setup(t, {
    file: false,
    async afterNative({ native, d }) {
      const retire = native.runtime.retire.bind(native.runtime);
      native.runtime.retire = async (...args) => {
        const actual = await retire(...args);
        await release.promise;
        actual.assertCurrent();
        return actual;
      };
      const submit = d.service.submitNativeFixedReview.bind(d.service);
      d.service.submitNativeFixedReview = async (...args) => {
        const result = await submit(...args);
        if (result.ok && result.value.status === 'pending' && result.value.reason === 'draining')
          pending.resolve();
        return result;
      };
    },
  });
  let authorReady = 0;
  const stopAuthor = h.owner.onReady(() => authorReady++);
  t.onTestFinished(stopAuthor);
  h.bridge.consumeClaim(h.d.request, h.claim);
  await pending.promise;
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'held');
  const calls = h.adapter.requests.length;
  release.resolve();
  await h.waitFor(() => h.d.read().command.status === 'completed');
  await h.bridge.whenIdle();
  assert.equal(h.d.read().rounds[0].ballots.length, 1);
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'settled');
  assert.equal(h.adapter.requests.length, calls);
  assert.equal(authorReady, 0, 'review readiness never invokes author listeners');
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK bridge: Stop during actual resource adoption fences admission, keeps wait cancellation separate and cleans the original scope', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.onTestFinished(() => release.resolve());
  const h = await setup(t, {
    file: false,
    adoptionStarted: () => entered.resolve(),
    adoption: { ready: release.promise },
  });
  // The fixture's actual A-adoption promise is deliberately held before native
  // publication. There is no model receipt/adoption to fabricate here.
  h.bridge.consumeClaim(h.d.request, h.claim);
  await entered.promise;
  h.d.members.clear();
  h.d.member.abort();
  h.d.source.abort();
  h.d.service.fenceRuns();
  const waiter = new AbortController();
  waiter.abort();
  assert.equal((await h.bridge.closeBeforeNative(waiter.signal)).status, 'pending');
  assert.equal(h.adapter.requests.length, 0);
  release.resolve();
  await h.bridge.whenIdle();
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  const attempt = readExecutionReviewState(h.d.read()).attempts[0];
  assert.equal(attempt.status, 'cancelled');
  assert.equal(attempt.resources, 'settled');
});

test('original SDK bridge: copied genuine claim cannot reserve, drive a model or poison the later original claim', async (t) => {
  const h = await setup(t, { file: false });
  assert.throws(() => h.bridge.consumeClaim(h.d.request, { ...h.claim }), {
    code: 'workflow-authority-denied',
  });
  await h.bridge.whenIdle();
  assert.equal(readExecutionReviewState(h.d.read())?.attempts.length ?? 0, 0);
  assert.equal(h.adapter.requests.length, 0);
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => h.d.read().command.status === 'completed');
  await h.bridge.whenIdle();
  assert.equal(h.d.read().rounds[0].ballots.length, 1);
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK bridge: a copied claim immediately followed by its original cannot occupy the original reservation', async (t) => {
  let preparations = 0;
  const h = await setup(t, {
    file: false,
    afterPreparation() {
      preparations++;
    },
  });
  const copied = { ...h.claim };
  assert.equal(copied.check(), undefined, 'a borrowed callback still passes its own check');
  let rejected;
  try {
    h.bridge.consumeClaim(h.d.request, copied);
  } catch (error) {
    rejected = error;
  }
  // No await or idle drain between the copied claim and the genuine original.
  h.bridge.consumeClaim(h.d.request, h.claim);
  h.bridge.consumeClaim(h.d.request, h.claim);
  assert.equal(rejected?.code, 'workflow-authority-denied');
  await h.waitFor(() => h.d.read().command.status === 'completed');
  await h.bridge.whenIdle();
  const state = readExecutionReviewState(h.d.read());
  assert.equal(preparations, 1, 'the copy must not reach Host preparation');
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].resources, 'settled');
  assert.equal(h.d.read().rounds[0].ballots.length, 1);
  assert.equal(h.d.read('consume').command.status, 'ready');
  assert.equal(h.adapter.requests.length, 2);
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK bridge: a lost reply after the original ballot uses its historical receipt to repair downstream without resending the model', async (t) => {
  const h = await setup(t, { file: false });
  const changed = h.d.faults.afterNodeWrite;
  let injected = false;
  h.d.faults.afterNodeWrite = (row) => {
    changed(row);
    if (!injected && row.nodeId === 'produce' && row.command.status === 'completed') {
      injected = true;
      throw Error('CONTRACT_REPLY_LOST_AFTER_ORIGINAL_DURABLE_BALLOT');
    }
  };
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => h.d.read('consume').command.status === 'ready');
  await h.bridge.whenIdle();
  assert.ok(injected);
  assert.equal(h.d.read().rounds[0].ballots.length, 1);
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'settled');
  assert.equal(h.adapter.requests.length, 2);
  assert.ok(h.submitTrace.some((result) => !result.ok));
  assert.ok(h.submitTrace.some((result) => result.ok && result.value.status === 'confirmed'));
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK bridge: A adoption revoking its own signal during the final synchronous assertion cannot publish a model', async (t) => {
  const source = new AbortController();
  const h = await setup(t, {
    file: false,
    adoption: {
      signal: source.signal,
      assertCurrent() {
        source.abort();
        return undefined;
      },
    },
  });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => readExecutionReviewState(h.d.read())?.attempts[0]?.resources === 'settled');
  await h.bridge.whenIdle();
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
  const scope = readExecutionReviewState(h.d.read()).attempts[0].scope;
  assert.equal(
    (await h.bridge.recoverStopped(scope)).ok,
    false,
    'a completed close seals further cleanup admission',
  );
});
