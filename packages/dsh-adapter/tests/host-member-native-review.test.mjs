/** A assembly contracts with scripted typed ports; not SDK/model or genuine protocol proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHostMemberNativeReviews } from '../dist/host-member-native-review.js';

const target = {
  spaceId: 'north',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  roundId: 'round',
  artifactVersionId: 'artifact',
};
const fixed = { ...target, artifactFingerprint: 'a'.repeat(64) };
const reviewerRef = { id: 'reviewer', version: 'plan', digest: 'b'.repeat(64) };
const model = { provider: 'contract', model: 'configured', maxTokens: 4096 };
function fixture({ late = false, denied = false } = {}) {
  let prepares = 0,
    sends = 0,
    starts = 0,
    stops = 0;
  let opens = 0,
    recovers = 0,
    coldStops = 0;
  const coldStopKeys = new Set();
  const ack = Promise.withResolvers();
  const run = {
    value: {
      scope: { runId: 'review-run', review: { target: fixed, principal: { reviewerRef } } },
      resources: 'held',
      attemptVersion: 1,
      runStatus: 'running',
      stopRequested: false,
    },
  };
  const llm = {
    listProviders: () => [{ id: 'contract' }],
    listModels: async () => [{ id: 'configured', provider: 'contract', name: 'Configured' }],
  };
  const ctx = { llm, get: (name) => (name === 'llm' ? llm : undefined) };
  const accepting = new Set();
  const assembly = createHostMemberNativeReviews(ctx, {
    backend: {
      request: async (input) => ({
        body: {
          type: 'server-response',
          rpcId: input.rpcId,
          result: {
            ok: true,
            value: {
              controllerMemberId: 'ann',
              target: fixed,
              expectedReviewVersion: 0,
              attempts: [],
              reviewers: [
                {
                  name: 'Reviewer',
                  reviewerRef,
                  canStart: !denied,
                  ...(denied ? { unavailableReason: 'review-self-review' } : {}),
                },
              ],
            },
          },
        },
      }),
    },
    connectionId: randomUUID(),
    actorId: 'ann',
    lifetime: new AbortController().signal,
    accepting,
    current: async (signal) => signal.throwIfAborted(),
    admit: (signal) => signal.throwIfAborted(),
    publicHistory: (event) => event,
    protocol: {
      prepareAccept: async (_id, input) => {
        prepares++;
        assert.deepEqual(input.target, fixed);
        assert.deepEqual(input.reviewerRef, { id: 'reviewer', version: 'plan' });
        return {
          send: async () => {
            sends++;
            if (late) await ack.promise;
            return run;
          },
        };
      },
      status: async () => run.value,
      stop: async (handle, input) => {
        assert.equal(handle, run);
        coldStops++;
        coldStopKeys.add(input.requestId);
        return run.value;
      },
      canSwitchBackend: () => true,
    },
    native: {
      openReviewSession: async () => {
        opens++;
        return { run, view: { remote: run.value, phase: 'recovery-required' } };
      },
      historyReview: async () => ({ events: [] }),
      recoverReview: async () => {
        recovers++;
        return { run, view: { remote: run.value, phase: 'recovery-required' } };
      },
      startReview: async (value) => {
        assert.equal(value, run);
        starts++;
      },
      readReview: () => ({ remote: run.value, phase: 'working' }),
      stopReview: async (value) => {
        assert.equal(value, run);
        stops++;
        run.value.resources = 'settled';
      },
    },
  });
  return {
    assembly,
    run,
    ack,
    accepting,
    counters: () => ({ prepares, sends, starts, stops }),
    coldCounters: () => ({ opens, recovers, coldStops }),
    coldStopKeys,
    input: {
      ...target,
      requestId: randomUUID(),
      expectedReviewVersion: 0,
      reviewerId: 'reviewer',
      model,
    },
  };
}
test('shared review assembly only starts the original supplied owner and retries the same prepared intent', async () => {
  const h = fixture(),
    signal = new AbortController().signal;
  assert.deepEqual(await h.assembly.handle('review-start', h.input, signal), {
    runId: 'review-run',
  });
  assert.deepEqual(await h.assembly.handle('review-start', h.input, signal), {
    runId: 'review-run',
  });
  assert.deepEqual(h.counters(), { prepares: 1, sends: 2, starts: 1, stops: 0 });
  const read = await h.assembly.handle('review-read', { ...target, runId: 'review-run' }, signal);
  assert.equal(read.status, 'running');
  assert.equal('permit' in read, false);
  await assert.rejects(
    h.assembly.handle('review-start', { ...h.input, model: { ...model, maxTokens: 1000 } }, signal),
  );
  assert.equal(h.counters().prepares, 1);
});
test('cold review opening only reads original status/history; reconciliation requires its explicit operation', async () => {
  const h = fixture(),
    signal = new AbortController().signal;
  const input = { ...target, sessionId: 'original-session' };
  const value = await h.assembly.handle('review-session', input, signal);
  assert.equal(value.sessionId, 'original-session');
  assert.deepEqual(h.coldCounters(), { opens: 1, recovers: 0, coldStops: 0 });
  assert.deepEqual(h.counters(), { prepares: 0, sends: 0, starts: 0, stops: 0 });
  await h.assembly.handle('review-recover', input, signal);
  assert.deepEqual(h.coldCounters(), { opens: 2, recovers: 1, coldStops: 0 });
  assert.equal(h.counters().starts, 0);
  await assert.rejects(
    h.assembly.handle('review-recover', { ...input, roundId: 'foreign' }, signal),
  );
  assert.equal(h.coldCounters().recovers, 1);
});
test('cold held review can be explicitly stopped with its original read handle and same-key retry, without drive admission', async () => {
  const h = fixture(),
    signal = new AbortController().signal;
  const input = {
    ...target,
    sessionId: 'original-session',
    requestId: randomUUID(),
    expectedAttemptVersion: 1,
  };
  const first = await h.assembly.handle('review-session-stop', input, signal);
  assert.equal(first.run.resources, 'held', 'unknown recovery is never reported settled');
  await h.assembly.handle('review-session-stop', input, signal);
  assert.equal(h.coldStopKeys.size, 1);
  assert.deepEqual(h.coldCounters(), { opens: 2, recovers: 2, coldStops: 2 });
  assert.deepEqual(h.counters(), { prepares: 0, sends: 0, starts: 0, stops: 0 });
  await assert.rejects(
    h.assembly.handle('review-session-stop', { ...input, artifactVersionId: 'foreign' }, signal),
  );
  assert.equal(h.coldCounters().coldStops, 2);
});
test('shared review assembly rejects original self-review/changed target before accept', async () => {
  const h = fixture({ denied: true });
  await assert.rejects(h.assembly.handle('review-start', h.input, new AbortController().signal));
  assert.equal(h.counters().prepares, 0);
  const other = fixture();
  await assert.rejects(
    other.assembly.handle(
      'review-options',
      { ...target, artifactVersionId: 'foreign' },
      new AbortController().signal,
    ),
  );
  assert.equal(other.counters().prepares, 0);
});
test('shared review assembly late accepted ACK after close goes only to original cleanup, with zero native starts', async () => {
  const h = fixture({ late: true });
  const pending = h.assembly.handle('review-start', h.input, new AbortController().signal);
  while (h.counters().sends === 0) await new Promise(setImmediate);
  h.assembly.fence();
  h.ack.resolve();
  await assert.rejects(pending);
  await Promise.allSettled(h.accepting);
  assert.deepEqual(h.counters(), { prepares: 1, sends: 1, starts: 0, stops: 1 });
});

test('automatic review preparation retains the original fixed target/ref and records cleanup before C starts the sole native owner', async () => {
  const h = fixture({ denied: true }),
    signal = new AbortController().signal;
  const workflow = { intentId: randomUUID(), generation: 2 };
  const input = await h.assembly.prepare(
    {
      target: fixed,
      expectedReviewVersion: 3,
      reviewerRef: { id: reviewerRef.id, version: reviewerRef.version },
      model,
      workflow,
    },
    signal,
  );
  assert.deepEqual(input, {
    target: fixed,
    expectedReviewVersion: 3,
    reviewerRef: { id: reviewerRef.id, version: reviewerRef.version },
    model,
    workflow,
    workspace: { kind: 'text-only' },
    capabilities: {
      reader: 'zhuma-native-review-read@1',
      resultIntent: 'zhuma-native-review-intent@1',
    },
  });
  assert.deepEqual(
    h.counters(),
    { prepares: 0, sends: 0, starts: 0, stops: 0 },
    'Preparation neither accepts, authorizes nor starts an Agent; C must call original prepareAccept',
  );
  h.assembly.accepted(h.run, signal);
  assert.equal(h.assembly.canSwitchBackend(), false);
  await h.assembly.stopAccepted();
  assert.equal(h.assembly.canSwitchBackend(), true);
  assert.deepEqual(h.counters(), { prepares: 0, sends: 0, starts: 0, stops: 1 });
});

test('automatic review late admission remains a cleanup obligation even when its original gate has closed', async () => {
  const h = fixture(),
    signal = new AbortController().signal;
  h.assembly.fence();
  assert.throws(() => h.assembly.accepted(h.run, signal));
  assert.equal(h.assembly.canSwitchBackend(), false);
  await h.assembly.stopAccepted();
  assert.equal(h.assembly.canSwitchBackend(), true);
  assert.equal(h.counters().starts, 0);
});
