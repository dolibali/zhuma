/** Original SDK and genuine Service proof, with explicit member/model/empty
 * adoption fixtures. No manual native event, ready fact or completion cut. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  bootReviewBridge,
  reopenStoppedReviewBridge,
  readExecutionReviewState,
} from './zhuma-native-review-bridge-bundle.ts';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-review-bridge-sdk-')),
    closes = [];
  t.onTestFinished(async () => {
    for (const close of closes.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  return bootReviewBridge(root, (close) => closes.push(close), options);
}

test('backend switch fence: original review preparation and fixed vote remain occupied until actual release', async (t) => {
  const preparing = Promise.withResolvers(),
    releasePrepare = Promise.withResolvers(),
    completing = Promise.withResolvers(),
    releaseComplete = Promise.withResolvers();
  const h = await setup(t, {
    afterPreparation: async () => {
      preparing.resolve();
      await releasePrepare.promise;
    },
    beforeCompletion: async () => {
      completing.resolve();
      await releaseComplete.promise;
    },
  });
  assert.equal(h.bridge.canSwitchBackend(), true);
  h.bridge.consumeClaim(h.d.request, h.claim);
  try {
    await preparing.promise;
    assert.equal(h.bridge.canSwitchBackend(), false, 'preparation exists before a native state');
    releasePrepare.resolve();
    await completing.promise;
    const before = {
      models: h.adapter.requests.length,
      reads: h.reads.length,
      ballots: h.d.read().rounds[0].ballots.length,
    };
    for (let index = 0; index < 20; index++) assert.equal(h.bridge.canSwitchBackend(), false);
    assert.deepEqual(
      {
        models: h.adapter.requests.length,
        reads: h.reads.length,
        ballots: h.d.read().rounds[0].ballots.length,
      },
      before,
    );
  } finally {
    releasePrepare.resolve();
    releaseComplete.resolve();
  }
  await h.waitFor(() => h.d.read().command.status === 'completed');
  await h.bridge.whenIdle();
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'settled');
  assert.equal(h.bridge.canSwitchBackend(), true);
  assert.equal(h.native.ctx.agents.list().length, 0);
});

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

test('original SDK cold review: an unknown cleanup scope is rejected by the original D validator before native retirement', async (t) => {
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
  assert.equal(calls, 1);
  assert.throws(() => h.native.runtime.migrationDrain('unknown-session'));
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

async function coldStoppedReview(t, { resumeBeforeCold = false } = {}) {
  const warm = await setup(t, { file: false, finishReason: 'stop' });
  warm.bridge.consumeClaim(warm.d.request, warm.claim);
  await warm.bridge.whenIdle();
  const original = readExecutionReviewState(warm.d.read()).attempts[0];
  const actor = warm.native.ctx.agents.get(original.nativeAgentId);
  assert.ok(actor, 'the original review Agent was genuinely published');
  await actor.whenIdle();
  await warm.bridge.whenIdle();
  const scope = readExecutionReviewState(warm.d.read()).attempts[0].scope;
  const stopped = await warm.d.service.stopWorkflowExecution(warm.d.request, {
    ...warm.location,
    requestId: 'persist-original-workflow-stop-before-cold-review',
    intentId: warm.view.intent.intentId,
    generation: warm.view.intent.generation,
  });
  assert.equal(stopped.ok, true);
  await warm.waitFor(
    () => readExecutionReviewState(warm.d.read())?.attempts[0]?.resources === 'settled',
  );
  await warm.bridge.whenIdle();
  if (resumeBeforeCold) {
    const resumed = await warm.d.service.resumeWorkflowExecution(warm.d.request, {
      ...warm.location,
      requestId: 'resume-stopped-review-before-cold-owner',
      intentId: stopped.value.intent.intentId,
      generation: stopped.value.intent.generation,
      expectedVersion: stopped.value.intent.version,
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.value.intent.status, 'running');
  }
  const cold = await reopenStoppedReviewBridge(warm, (close) => t.onTestFinished(close));
  assert.throws(
    () => cold.d.service.assertExpertReviewDrained(scope),
    'persisted settled labels are not a new physical certificate',
  );
  return { warm, cold, scope };
}

test('original SDK cold review: a normally resumed workflow can recover its stopped historical scope without another Stop or model', async (t) => {
  const { cold, scope } = await coldStoppedReview(t, { resumeBeforeCold: true });
  const before = structuredClone(cold.d.read());
  const result = await cold.bridge.recoverStopped(scope);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 'settled');
  cold.d.service.assertExpertReviewDrained(scope);
  assert.deepEqual(cold.d.read(), before);
  assert.equal(cold.adapter.requests.length, 0);
  const attempt = readExecutionReviewState(cold.d.read()).attempts[0];
  assert.equal(
    cold.native.runtime.migrationDrain(attempt.nativeSessionId).basis,
    'flushed-and-closed',
  );
  assert.equal(cold.native.ctx.agents.get(attempt.nativeAgentId), undefined);
  assert.equal(cold.d.read().rounds[0].ballots.length, 0);
  assert.equal(cold.d.read('consume').command.status, 'blocked');
});

test('original SDK cold review: committed Stop and exact persisted scope restore a genuine physical drain with empty bridge state', async (t) => {
  const { cold, scope } = await coldStoppedReview(t);
  const before = cold.d.read();
  let retirements = 0;
  const retire = cold.native.service.retireReviewForCleanup.bind(cold.native.service);
  cold.native.service.retireReviewForCleanup = (...args) => {
    retirements++;
    return retire(...args);
  };
  for (const changed of [
    { ...scope, actorId: 'foreign-controller' },
    { ...scope, runId: 'foreign-run' },
    {
      ...scope,
      review: { ...scope.review, target: { ...scope.review.target, roundId: 'foreign-round' } },
    },
  ]) {
    const rejected = await cold.bridge.recoverStopped(changed);
    assert.equal(rejected.ok, false);
  }
  assert.equal(retirements, 0, 'only the original committed Stop may reach C cleanup');
  assert.throws(() => cold.d.service.assertExpertReviewDrained(scope));
  const result = await cold.bridge.recoverStopped(scope);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 'settled');
  cold.d.service.assertExpertReviewDrained(scope);
  const attempt = readExecutionReviewState(cold.d.read()).attempts[0];
  assert.equal(attempt.status, 'cancelled');
  assert.equal(attempt.stopPhase, 'confirmed');
  assert.equal(attempt.resources, 'settled');
  assert.equal(
    cold.native.runtime.migrationDrain(attempt.nativeSessionId).basis,
    'flushed-and-closed',
  );
  assert.equal(cold.native.ctx.agents.get(attempt.nativeAgentId), undefined);
  assert.deepEqual(cold.d.read().artifactVersions, before.artifactVersions);
  assert.deepEqual(cold.d.read().rounds, before.rounds);
  assert.equal(cold.d.read().rounds[0].ballots.length, 0);
  assert.equal(cold.d.read('consume').command.status, 'blocked');
  assert.equal(cold.adapter.requests.length, 0);
  assert.equal(retirements, 1);
});

test('original SDK cold review: aborted wait stays pending until the original native retirement finishes', async (t) => {
  const { cold, scope } = await coldStoppedReview(t);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.onTestFinished(() => release.resolve());
  const retire = cold.native.runtime.retire.bind(cold.native.runtime);
  cold.native.runtime.retire = async (...args) => {
    const actual = await retire(...args);
    entered.resolve();
    await release.promise;
    actual.assertCurrent();
    return actual;
  };
  const wait = new AbortController();
  const recovering = cold.bridge.recoverStopped(scope, wait.signal);
  await entered.promise;
  wait.abort();
  const pending = await recovering;
  assert.equal(pending.ok, true, JSON.stringify(pending));
  assert.equal(pending.value.status, 'pending');
  assert.throws(() => cold.d.service.assertExpertReviewDrained(scope));
  assert.equal(cold.d.read().rounds[0].ballots.length, 0);
  release.resolve();
  await cold.native.service.whenRetirementsIdle();
  const recovered = await cold.bridge.recoverStopped(scope);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.value.status, 'settled');
  cold.d.service.assertExpertReviewDrained(scope);
  assert.equal(cold.adapter.requests.length, 0);
});

test('original SDK cold review: a retained admitted start without its drive cannot be mistaken for an empty cold scope', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.onTestFinished(() => release.resolve());
  const h = await setup(t, {
    file: false,
    afterNative({ d }) {
      const open = d.service.openExpertReviewDrive.bind(d.service);
      d.service.openExpertReviewDrive = async (...args) => {
        const actual = await open(...args);
        entered.resolve();
        await release.promise;
        return actual;
      };
    },
  });
  let retirements = 0;
  const retire = h.native.service.retireReviewForCleanup.bind(h.native.service);
  h.native.service.retireReviewForCleanup = (...args) => {
    retirements++;
    return retire(...args);
  };
  h.bridge.consumeClaim(h.d.request, h.claim);
  await entered.promise;
  const scope = readExecutionReviewState(h.d.read()).attempts[0].scope;
  const stopped = await h.d.service.stopWorkflowExecution(h.d.request, {
    ...h.location,
    requestId: 'stop-retained-start-before-drive-return',
    intentId: h.view.intent.intentId,
    generation: h.view.intent.generation,
  });
  assert.equal(stopped.ok, true);
  const pending = await h.bridge.recoverStopped(scope);
  assert.equal(pending.ok, true, JSON.stringify(pending));
  assert.equal(pending.value.status, 'pending');
  assert.equal(retirements, 0, 'the retained start must settle before C may qualify cleanup');
  assert.equal(readExecutionReviewState(h.d.read()).attempts[0].resources, 'held');
  assert.throws(() => h.d.service.assertExpertReviewDrained(scope));
  release.resolve();
  await h.waitFor(() => readExecutionReviewState(h.d.read())?.attempts[0]?.resources === 'settled');
  await h.bridge.whenIdle();
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.adapter.requests.length, 0);
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
});

test('original SDK prepared metadata: only a revoked genuine claim and exact never-admitted marker can release logical ownership without certifying drain', async (t) => {
  const h = await setup(t, { file: false, refuseAdmission: true });
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.bridge.whenIdle();
  const before = readExecutionReviewState(h.d.read()),
    attempt = before.attempts[0];
  assert.equal(attempt.status, 'prepared');
  assert.equal(attempt.version, 1);
  assert.equal(attempt.dispatch, 'reserved');
  assert.equal(attempt.resources, 'held');
  assert.equal(Object.hasOwn(attempt, 'composition'), false);
  assert.equal(Object.hasOwn(attempt, 'nativeSessionId'), false);
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.claim.signal.aborted, false);
  assert.equal(
    (await h.bridge.closeBeforeNative()).status,
    'pending',
    'a local fence cannot substitute for revoking the genuine workflow claim',
  );
  const stopped = await h.d.service.stopWorkflowExecution(h.d.request, {
    ...h.location,
    requestId: 'stop-never-admitted-logical-review',
    intentId: h.view.intent.intentId,
    generation: h.view.intent.generation,
  });
  assert.equal(stopped.ok, true);
  assert.equal(h.claim.signal.aborted, true);
  await h.bridge.whenIdle();
  assert.equal((await h.bridge.closeBeforeNative()).status, 'settled');
  assert.deepEqual(
    readExecutionReviewState(h.d.read()),
    before,
    'the original prepared/held marker and receipt remain untouched',
  );
  assert.throws(
    () => h.d.service.assertExpertReviewDrained(attempt.scope),
    'logical metadata release cannot mint a physical review certificate',
  );
  assert.deepEqual(
    [...h.native.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries()],
    [],
  );
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  assert.equal(h.adapter.requests.length, 0);
});

test('original SDK review target: an authenticated fixed-body read does not depend on the navigation status query', async (t) => {
  const activeReads = new Set(),
    returned = Promise.withResolvers();
  let navigationReads = 0,
    readMetrics;
  const h = await setup(t, {
    file: false,
    productionHost: true,
    afterNative({ native, hostMetrics }) {
      let before;
      const status = native.runtime.status.bind(native.runtime);
      native.runtime.status = (sessionId) => {
        if (activeReads.size) {
          navigationReads++;
          throw Error('SYNTHETIC_NAVIGATION_STATUS_UNAVAILABLE_DURING_BODY_READ');
        }
        return status(sessionId);
      };
      native.ctx.on(
        'tools/pre-execute',
        async (exec, next) => {
          if (exec.name === 'read_review_target') {
            activeReads.add(exec.token);
            before = { ...hostMetrics, at: performance.now() };
          }
          return next();
        },
        { global: true },
      );
      native.ctx.on(
        'tools/post-execute',
        async (exec, result, next) => {
          if (exec.name === 'read_review_target') {
            activeReads.delete(exec.token);
            readMetrics = {
              elapsedMs: performance.now() - before.at,
              hostChecks: hostMetrics.checks - before.checks,
              workbenchReads: hostMetrics.workbenchReads - before.workbenchReads,
              hostElapsedMs: hostMetrics.elapsedMs - before.elapsedMs,
            };
            returned.resolve(result.value);
          }
          return next();
        },
        { global: true },
      );
    },
  });
  h.bridge.consumeClaim(h.d.request, h.claim);
  try {
    const page = await returned.promise;
    assert.equal(page.ok, true);
    assert.match(page.readRef, /^review_read_[a-f0-9]{64}$/u);
    assert.equal(navigationReads, 0);
    assert.ok(readMetrics.hostChecks > 0);
    console.info('C_SDK_REVIEW_READ_METRICS ' + JSON.stringify(readMetrics));
    await h.waitFor(() => h.d.read().command.status === 'completed');
    await h.bridge.whenIdle();
    const attempt = readExecutionReviewState(h.d.read()).attempts[0];
    assert.equal(navigationReads, 0);
    assert.equal(h.reads.length, 1);
    assert.equal(h.d.read().rounds[0].ballots.length, 1);
    assert.equal(attempt.resources, 'settled');
    assert.equal(h.d.read('consume').command.status, 'ready');
    assert.equal(h.adapter.requests.length, 2);
  } finally {
    if (h.d.read().command.status !== 'completed')
      await h.d.service.stopWorkflowExecution(h.d.request, {
        ...h.location,
        requestId: 'stop-status-query-read-counterexample',
        intentId: h.view.intent.intentId,
        generation: h.view.intent.generation,
      });
  }
});

test('original SDK scaled review read: calibrated three-author/four-review metadata returns a finalized read reference within the existing budget', async (t) => {
  const returned = Promise.withResolvers(),
    ended = Promise.withResolvers();
  let before, post, final;
  const h = await setup(t, {
    file: false,
    productionHost: true,
    scaledHistory: true,
    finishReason: 'stop',
    afterNative({ native, hostMetrics }) {
      native.ctx.on(
        'tools/pre-execute',
        async (exec, next) => {
          if (exec.name === 'read_review_target')
            before = { ...hostMetrics, at: performance.now() };
          return next();
        },
        { global: true },
      );
      native.ctx.on(
        'tools/post-execute',
        async (exec, result, next) => {
          if (exec.name === 'read_review_target') post = performance.now() - before.at;
          return next();
        },
        { global: true },
      );
      native.ctx.on(
        'tools/result',
        (exec, result) => {
          if (exec.name === 'read_review_target') {
            final = {
              elapsedMs: performance.now() - before.at,
              hostChecks: hostMetrics.checks - before.checks,
              workbenchReads: hostMetrics.workbenchReads - before.workbenchReads,
            };
            returned.resolve(result);
          }
        },
        { global: true },
      );
      native.ctx.on(
        'session/event',
        (session, event) => {
          if (event.type === 'turn/end')
            ended.resolve({ sessionId: session.id, reason: event.data.reason.kind });
        },
        { global: true },
      );
    },
  });
  h.bridge.consumeClaim(h.d.request, h.claim);
  try {
    const result = await returned.promise;
    const page = JSON.parse(result.content.find((block) => block.type === 'text').text);
    const node = h.d.read();
    assert.equal(node.nativeExecution.runs.length, 3);
    assert.equal(readExecutionReviewState(node).attempts.length, 4);
    const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
    console.info(
      'C_SDK_SCALED_READ_METRICS ' +
        JSON.stringify({
          preToPostMs: post,
          ...final,
          pageOk: page.ok,
          code: page.code,
          readRefPresent: typeof page.readRef === 'string',
          nodeBytes: bytes(node),
          authorBytes: node.nativeExecution.runs.map((run) => bytes(run.composition)),
          reviewBytes: readExecutionReviewState(node).attempts.map((run) =>
            run.composition ? bytes(run.composition) : null,
          ),
          boundary:
            'synthetic historical metadata; current SDK tools/result is original, no historical physical drain assertion',
        }),
    );
    assert.equal(page.ok, true);
    assert.match(page.readRef, /^review_read_[a-f0-9]{64}$/u);
    assert.ok(
      final.elapsedMs < 5000,
      'the original finalized read exceeds the existing read budget',
    );
    const turn = await ended.promise;
    assert.equal(turn.reason, 'completed');
    await h.bridge.whenIdle();
    assert.equal(h.reads.length, 1);
    assert.equal(h.d.read().rounds.at(-1).ballots.length, 0);
    assert.equal(h.d.read('consume').command.status, 'blocked');
  } finally {
    await h.d.service.stopWorkflowExecution(h.d.request, {
      ...h.location,
      requestId: 'stop-scaled-read-after-measurement',
      intentId: h.view.intent.intentId,
      generation: h.view.intent.generation,
    });
    await h.bridge.whenIdle();
  }
});

test('original SDK review Resume: a real stopped drain survives caller completion and a different request before actual Host preparation', async (t) => {
  const callerDone = new AbortController(),
    sendErrors = [],
    firstTurnEnd = Promise.withResolvers();
  const options = {
    file: false,
    productionHost: true,
    productionPrepare: true,
    finishReason: 'stop',
    afterNative({ native }) {
      native.ctx.on(
        'session/event',
        (session, event) => {
          if (event.type === 'turn/end')
            firstTurnEnd.resolve({ sessionId: session.id, reason: event.data.reason.kind });
        },
        { global: true },
      );
      const retire = native.service.retireReviewForCleanup.bind(native.service);
      const send = native.service.send.bind(native.service);
      native.service.send = async (...args) => {
        try {
          return await send(...args);
        } catch (error) {
          sendErrors.push(error.code);
          throw error;
        }
      };
      let stoppedRun;
      native.service.retireReviewForCleanup = (authority, wait) => {
        stoppedRun ??= authority.scope.runId;
        return retire(
          authority,
          authority.scope.runId === stoppedRun ? AbortSignal.any([wait, callerDone.signal]) : wait,
        );
      };
    },
  };
  const h = await setup(t, options);
  h.bridge.consumeClaim(h.d.request, h.claim);
  await h.waitFor(() => readExecutionReviewState(h.d.read())?.attempts[0]?.status === 'running');
  const first = readExecutionReviewState(h.d.read()).attempts[0];
  const ended = await firstTurnEnd.promise;
  assert.equal(ended.sessionId, first.nativeSessionId);
  assert.equal(ended.reason, 'completed');
  await h.native.ctx.agents.get(first.nativeAgentId).whenIdle();
  await h.bridge.whenIdle();
  const original = readExecutionReviewState(h.d.read()).attempts[0];
  assert.equal(h.hostMetrics.preparations, 1);
  assert.equal(original.status, 'running');
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(h.d.read().rounds[0].ballots.length, 0);
  const stopped = await h.d.service.stopWorkflowExecution(h.d.request, {
    ...h.location,
    requestId: 'stop-real-review-before-resume',
    intentId: h.view.intent.intentId,
    generation: h.view.intent.generation,
  });
  assert.equal(stopped.ok, true);
  await h.waitFor(() => readExecutionReviewState(h.d.read()).attempts[0].resources === 'settled');
  await h.bridge.whenIdle();
  assert.equal(
    h.native.runtime.migrationDrain(original.nativeSessionId).basis,
    'flushed-and-closed',
  );
  assert.equal(h.native.ctx.agents.get(original.nativeAgentId), undefined);
  callerDone.abort();
  assert.doesNotThrow(() => h.d.service.assertExpertReviewDrained(original.scope));
  const before = structuredClone(readExecutionReviewState(h.d.read()).attempts[0]);
  const bindings = h.native.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings');
  const oldRows = structuredClone([...bindings.entries()]);
  assert.equal(oldRows.length, 1);
  const resumed = await h.d.service.resumeWorkflowExecution(h.d.request, {
    ...h.location,
    requestId: 'resume-real-stopped-review',
    intentId: stopped.value.intent.intentId,
    generation: stopped.value.intent.generation,
    expectedVersion: stopped.value.intent.version,
  });
  assert.equal(resumed.ok, true);
  assert.doesNotThrow(() => h.d.service.assertExpertReviewDrained(original.scope));
  const claim = await h.d.service.claimWorkflowExecution(h.d.request, {
    ...h.location,
    intentId: resumed.value.intent.intentId,
    generation: resumed.value.intent.generation,
  });
  assert.equal(claim.ok, true);
  assert.equal(claim.value.reviewCandidates.length, 1);
  assert.notEqual(claim.value.reviewCandidates[0].requestId, h.claim.reviewCandidates[0].requestId);
  options.finishReason = undefined;
  h.bridge.consumeClaim(h.d.request, claim.value);
  assert.doesNotThrow(
    () => h.d.service.assertExpertReviewDrained(original.scope),
    'a new same-target request cannot contaminate the previous physical drain',
  );
  await h.bridge.whenIdle();
  assert.equal(h.hostMetrics.preparations, 2);
  assert.equal(readExecutionReviewState(h.d.read()).attempts.length, 2);
  assert.deepEqual(sendErrors, [], 'the new scope must open its own authenticated native binding');
  await h.waitFor(() => h.d.read().command.status === 'completed');
  await h.bridge.whenIdle();
  assert.deepEqual(readExecutionReviewState(h.d.read()).attempts[0], before);
  assert.deepEqual(bindings.get(oldRows[0][0]), oldRows[0][1]);
  assert.equal([...bindings.entries()].length, 2);
  const next = readExecutionReviewState(h.d.read()).attempts[1];
  assert.notEqual(next.nativeSessionId, original.nativeSessionId);
  assert.equal(next.resources, 'settled');
  assert.doesNotThrow(() => h.d.service.assertExpertReviewDrained(original.scope));
  assert.equal(h.d.read().rounds[0].ballots.length, 1);
  assert.equal(h.d.read('consume').command.status, 'ready');
});
