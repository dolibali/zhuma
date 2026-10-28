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
  await h.bridge.whenIdle();
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'held');
  assert.equal((await h.bridge.closeBeforeNative()).status, 'pending');
});

test('original SDK resource barrier: normal scope disposal can abort registration while authority stays live; held explicit drain blocks ballot and downstream until the same close finishes', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.onTestFinished(() => release.resolve());
  const local = new AbortController();
  let disposals = 0,
    drains = 0;
  const h = await setup(t, {
    adoption(ctx) {
      ctx.effect(() => () => local.abort());
      return {
        assertCurrent() {
          local.signal.throwIfAborted();
          return undefined;
        },
        async dispose() {
          disposals++;
          local.abort();
        },
        async drain() {
          drains++;
          entered.resolve();
          await release.promise;
        },
      };
    },
  });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await entered.promise;
  const attempt = readExecutionReviewState(h.d.read()).attempts[0];
  assert.equal(local.signal.aborted, true, 'actual SDK scope teardown ran its finalizer');
  h.native.runtime.migrationDrain(attempt.nativeSessionId).assertCurrent();
  assert.throws(() => h.d.service.assertExpertReviewDrained(attempt.scope));
  assert.equal(attempt.resources, 'held');
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  const calls = h.adapter.requests.length;
  release.resolve();
  await h.waitFor(() => h.d.read().command.status === 'completed');
  await h.bridge.whenIdle();
  h.d.service.assertExpertReviewDrained(attempt.scope);
  assert.equal(h.d.read().rounds[0].ballots.length, 1);
  assert.equal(h.d.read('consume').command.status, 'ready');
  assert.equal(h.adapter.requests.length, calls, 'late close never resends a model');
  assert.deepEqual({ disposals, drains }, { disposals: 1, drains: 1 });
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK resource barrier: rejected disposal stays held across repeated close and actual Stop cannot resume over it', async (t) => {
  let disposals = 0,
    drains = 0;
  const h = await setup(t, {
    file: false,
    adoption: {
      async dispose() {
        disposals++;
        throw Error('SYNTHETIC_ORIGINAL_DISPOSAL_FAILURE');
      },
      async drain() {
        drains++;
      },
    },
  });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => h.adapter.requests.length === 2);
  await h.bridge.whenIdle();
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  const attempt = readExecutionReviewState(h.d.read()).attempts[0];
  assert.equal(attempt.resources, 'held');
  assert.throws(() => h.d.service.assertExpertReviewDrained(attempt.scope));
  assert.equal((await h.bridge.closeBeforeNative()).status, 'pending');
  assert.equal((await h.bridge.closeBeforeNative()).status, 'pending');
  const stopped = await h.d.service.stopWorkflowExecution(h.d.request, {
    ...h.location,
    requestId: 'stop-rejected-disposal',
    intentId: h.view.intent.intentId,
    generation: h.view.intent.generation,
  });
  assert.equal(stopped.ok, true);
  if (!stopped.ok) throw Error('The actual Stop request failed.');
  assert.equal(stopped.value.state, 'stopping');
  const resumed = await h.d.service.resumeWorkflowExecution(h.d.request, {
    ...h.location,
    requestId: 'resume-rejected-disposal',
    intentId: stopped.value.intent.intentId,
    generation: stopped.value.intent.generation,
    expectedVersion: stopped.value.intent.version,
  });
  assert.equal(resumed.ok, false);
  assert.deepEqual({ disposals, drains }, { disposals: 1, drains: 1 });
});

test('original SDK resource barrier: malformed returned adoption retains its available disposer and never becomes empty settled resources', async (t) => {
  let disposals = 0;
  const h = await setup(t, {
    file: false,
    adoption: {
      drain: undefined,
      async dispose() {
        disposals++;
      },
    },
  });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.bridge.whenIdle();
  assert.equal(disposals, 1);
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'held');
  assert.equal((await h.bridge.closeBeforeNative()).status, 'pending');
  assert.equal(disposals, 1);
});

test('original SDK resource barrier: a resource losing live qualification before collection cannot retire into a fixed result', async (t) => {
  let active = true;
  const h = await setup(t, {
    file: false,
    beforeCompletion() {
      active = false;
    },
    adoption: {
      assertCurrent() {
        assert.equal(active, true, 'the real resource has become unavailable before collection');
        return undefined;
      },
    },
  });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => readExecutionReviewState(h.d.read())?.attempts[0]?.resources === 'settled');
  await h.bridge.whenIdle();
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.reads.length, 1);
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

for (const revocation of ['producer', 'member', 'configuration'])
  test(`original SDK resource barrier: continuing ${revocation} authority revoked during an actual close never casts a ballot`, async (t) => {
    const authority = new AbortController(),
      entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.onTestFinished(() => release.resolve());
    const h = await setup(t, {
      file: false,
      adoption: {
        signal: authority.signal,
        async drain() {
          entered.resolve();
          await release.promise;
        },
      },
    });
    h.bridge.consumeClaim(h.d.request, h.claim);
    await entered.promise;
    if (revocation === 'producer') authority.abort();
    else if (revocation === 'member') {
      h.d.members.clear();
      h.d.member.abort();
    } else h.compositions.clear();
    release.resolve();
    await h.waitFor(
      () => readExecutionReviewState(h.d.read())?.attempts[0]?.resources === 'settled',
    );
    await h.bridge.whenIdle();
    assert.equal(h.d.read().rounds[0].ballots.length, 0);
    assert.equal(h.d.read('consume').command.status, 'blocked');
    assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
  });

test('original SDK resource barrier: an unknown cleanup scope without its original A obligation requires recovery before D is called', async (t) => {
  const h = await setup(t, { file: false });
  let calls = 0;
  const original = h.d.service.recoverStoppedWorkflowReviewCleanup;
  h.d.service.recoverStoppedWorkflowReviewCleanup = async (...args) => {
    calls++;
    return original.apply(h.d.service, args);
  };
  const result = await h.bridge.recoverStopped({});
  assert.equal(result.ok, false);
  if (result.ok) throw Error('Unknown resource ownership must require recovery.');
  assert.equal(result.error.code, 'review-bridge-recovery-required');
  assert.equal(calls, 0);
  assert.equal(h.adapter.requests.length, 0);
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

test('original SDK review truncation: max-tokens after real fixed reads records attention and physically closes without a ballot or retry', async (t) => {
  const h = await setup(t, { finishReason: 'max-tokens' });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => readExecutionReviewState(h.d.read())?.attempts[0]?.resources === 'settled');
  await h.bridge.whenIdle();
  const node = h.d.read(),
    attempt = readExecutionReviewState(node).attempts[0];
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.failure.code, 'review-result-rejected');
  assert.equal(attempt.resources, 'settled');
  assert.equal(attempt.stopPhase, 'none');
  assert.equal(node.rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.equal(h.reads.length, 2, 'both fixed text and uploaded file were actually read');
  assert.equal(h.adapter.requests.length, 3, 'there is no automatic continuation or retry');
  assert.ok(h.submitTrace.some((result) => result.ok && result.value.status === 'needs-attention'));
  assert.equal(h.native.ctx.agents.get(attempt.nativeAgentId), undefined);
  assert.equal(
    h.native.runtime.migrationDrain(attempt.nativeSessionId).basis,
    'flushed-and-closed',
  );
  h.d.service.assertExpertReviewDrained(attempt.scope);
  const events = await h.native.ctx.sessionPersistence.open(attempt.nativeSessionId, 'read');
  try {
    const page = await events.read(0, 100);
    assert.ok(
      page.events.some(
        (event) => event.type === 'turn/end' && event.data.reason.kind === 'max-tokens',
      ),
    );
    assert.equal(
      page.events.some(
        (event) => event.type === 'tool/call' && event.data.name === 'complete_review',
      ),
      false,
    );
  } finally {
    await events.close();
  }
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK review truncation: ordinary completed idle without a declaration remains pending and never becomes a synthetic failure', async (t) => {
  const h = await setup(t, { finishReason: 'stop' });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(
    () => (readExecutionReviewState(h.d.read())?.attempts[0]?.lastEventSequence ?? 0) >= 3,
  );
  await h.bridge.whenIdle();
  const attempt = readExecutionReviewState(h.d.read()).attempts[0];
  assert.equal(attempt.status, 'running');
  assert.equal(attempt.failure, undefined);
  assert.equal(attempt.resources, 'held');
  assert.equal(h.native.runtime.status(attempt.nativeSessionId), 'idle');
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.adapter.requests.length, 3);
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK review truncation: actual Stop before a held model response keeps cancellation ahead of output-limit failure', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.onTestFinished(() => release.resolve());
  const h = await setup(t, {
    finishReason: 'max-tokens',
    async beforeCompletion() {
      entered.resolve();
      await release.promise;
    },
  });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await entered.promise;
  const stopped = await h.d.service.stopWorkflowExecution(h.d.request, {
    ...h.location,
    requestId: 'stop-before-truncated-review-response',
    intentId: h.view.intent.intentId,
    generation: h.view.intent.generation,
  });
  assert.equal(stopped.ok, true);
  release.resolve();
  await h.waitFor(() => readExecutionReviewState(h.d.read())?.attempts[0]?.resources === 'settled');
  await h.bridge.whenIdle();
  const attempt = readExecutionReviewState(h.d.read()).attempts[0];
  assert.equal(attempt.status, 'cancelled');
  assert.equal(attempt.failure, undefined);
  assert.equal(attempt.stopPhase, 'confirmed');
  assert.equal(attempt.resources, 'settled');
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.d.read('consume').command.status, 'blocked');
  assert.equal(h.adapter.requests.length, 3);
  assert.equal(h.native.ctx.agents.get(attempt.nativeAgentId), undefined);
  assert.equal(
    h.native.runtime.migrationDrain(attempt.nativeSessionId).basis,
    'flushed-and-closed',
  );
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});
