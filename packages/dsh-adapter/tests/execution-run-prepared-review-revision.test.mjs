import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeRecordKey, createExecutionHandoff } from '@zhuma/agent-core';
import { host } from './execution-review-service-fixture.mjs';
import { checked, refused, caller } from './execution-service-run-fixture.mjs';
import { command, available } from './execution-run-fixture.mjs';
import { beginExecutionRun, recordExecutionRunEvent } from '../dist/execution-run-state.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { enableExecutionRunWriter } from '../dist/execution-run-protocol.js';
import { freezeExecutionReviewComposition } from '../dist/execution-review-composition.js';
import { reviewDescriptors } from './execution-review-composition-fixture.mjs';
import {
  readExecutionReviewState,
  prepareExecutionReview,
} from '../dist/execution-review-state.js';
import {
  admitExecutionReview,
  recordExecutionReviewEvent,
} from '../dist/execution-review-lifecycle.js';
import { stoppedPreparedWorkflowReviewRunIdsForRevision } from '../dist/execution-workflow-reviews.js';

// Original Service/queue/JSON and pure transitions. Historical author events,
// member identity and physical drain below are explicit contracts, not SDK proof.
async function returned(t, { stop = true } = {}) {
  let drained = true;
  let onDrain = () => {};
  const drain = new AbortController();
  const h = await host(t, {
    reviewerIds: ['qa', 'outside'],
    migrationDrain(scope) {
      assert.equal(scope.runId, 'previous-author');
      return drained
        ? {
            signal: drain.signal,
            assertCurrent() {
              drain.signal.throwIfAborted();
              onDrain();
            },
          }
        : undefined;
    },
  });
  const original = h.read();
  const ready = {
    ...original,
    command: { ...original.command, status: 'ready', entryStatus: 'ready' },
  };
  const model = { provider: 'contract', model: 'contract-model', maxTokens: 1000 };
  const compositionFor = (node, runId, generation) =>
    freezeExecutionRunComposition({
      workbench: h.readWorkbench(),
      node,
      scope: {
        ...h.locate(),
        actorId: 'chen',
        spaceId: 'north',
        runId,
        generation,
        segmentId: `${runId}-segment`,
      },
      model,
      executor: { kind: 'builtin' },
      tools: { kind: 'text-only' },
      inputs: { ...h.locate(), actorId: 'chen', spaceId: 'north', items: [] },
    });
  const composition = compositionFor(ready, 'previous-author', 1);
  const { firstMessage: _first, ...projection } = executionRunCompositionRequest(composition);
  let author = beginExecutionRun(
    ready,
    command(ready, {
      newRunId: 'previous-author',
      newSegmentId: 'previous-author-segment',
      ...projection,
      composition,
    }),
    [ready],
    available,
  ).record;
  author = recordExecutionRunEvent(author, {
    runId: 'previous-author',
    generation: 1,
    segmentId: 'previous-author-segment',
    sequence: 1,
    kind: 'accepted',
    nativeSessionId: 'previous-author-native',
    executorRunId: 'previous-author-native',
  }).record;
  author = recordExecutionRunEvent(author, {
    runId: 'previous-author',
    generation: 1,
    segmentId: 'previous-author-segment',
    sequence: 2,
    kind: 'completed',
    idle: true,
    flushed: true,
    resourcesSettled: true,
  }).record;
  await enableExecutionRunWriter(
    () => h.domain.global.get(),
    (next) => h.domain.global.set(next),
    [original],
  );
  await h.domain
    .table('nodes')
    .put(nodeRecordKey(original), { ...original, nativeExecution: author.nativeExecution });
  const location = { ...h.locate(), spaceId: 'north' };
  delete location.nodeId;
  const workflow = checked(
    await h.service.startWorkflowExecution(h.request, {
      ...location,
      requestId: 'start-with-previous-author',
      defaults: { model, workspace: { kind: 'text-only' }, tools: 'text-only' },
      budget: { concurrent: 1, automaticAttemptsPerNode: 1, automaticRevisions: 0 },
    }),
  );
  const claim = checked(
    await h.service.claimWorkflowExecution(h.request, {
      ...location,
      intentId: workflow.intent.intentId,
      generation: workflow.intent.generation,
    }),
  );
  const query = claim.reviewCandidates[0];
  assert.ok(query);
  const facts = checked(await h.service.readExpertReviewPreparation(h.request, query));
  const reviewComposition = freezeExecutionReviewComposition({
    ...facts,
    model: { ...model, maxTokens: 16384 },
    tools: {
      readTarget: reviewDescriptors.readTarget,
      completeReview: reviewDescriptors.completeReview,
    },
  });
  const prepared = checked(
    await h.service.prepareExpertReview(
      h.request,
      { ...query, configurationId: reviewComposition.configurationId },
      claim,
    ),
  );
  const reservedNode = h.read();
  if (stop)
    checked(
      await h.service.stopWorkflowExecution(h.request, {
        ...location,
        requestId: 'stop-never-admitted-review',
        intentId: workflow.intent.intentId,
        generation: workflow.intent.generation,
      }),
    );
  const round = h.read().rounds.at(-1);
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'formal-return'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'request-changes',
      comment: 'Revise the fixed result.',
    }),
  );
  const node = h.read();
  assert.equal(node.command.status, 'needs-revision');
  const nextComposition = compositionFor(node, 'revised-author', 2);
  const { firstMessage: _nextMessage, ...nextProjection } =
    executionRunCompositionRequest(nextComposition);
  const { actorId: _actor, ...raw } = command(node, {
    requestId: 'begin-revised-author',
    newRunId: 'revised-author',
    newSegmentId: 'revised-author-segment',
    ...nextProjection,
    composition: nextComposition,
  });
  return {
    ...h,
    input: { ...h.locate(), ...raw },
    prepared,
    reviewComposition,
    reservedNode,
    query,
    setOnDrain: (callback) => {
      onDrain = callback;
    },
    setDrained: (value) => {
      drained = value;
    },
  };
}

test('returned author: an exact stopped never-admitted review reservation no longer blocks the next Run, and remains immutable on replay', async (t) => {
  const h = await returned(t);
  const before = h.read();
  h.setDrained(false);
  refused(await h.service.startRun(h.request, h.input), 'run-migration-pending');
  assert.deepEqual(
    h.read(),
    before,
    'logical qualification never substitutes for the native author drain',
  );
  h.setDrained(true);
  const next = checked(await h.service.startRun(h.request, h.input));
  assert.equal(next.run.attempt.id, 'revised-author');
  assert.equal(next.effect.kind, 'dispatch');
  assert.deepEqual(readExecutionReviewState(h.read()), readExecutionReviewState(before));
  assert.deepEqual(h.read().nativeExecution.runs[0], before.nativeExecution.runs[0]);
  assert.deepEqual(h.read().rounds, before.rounds);
  assert.equal(h.read('consume').command.status, 'blocked');
  assert.equal(checked(await h.service.startRun(h.request, h.input)).disposition, 'replayed');
  assert.equal(h.read().nativeExecution.runs.length, 2);
  assert.throws(() => h.service.assertExpertReviewDrained(h.prepared.attempt.scope));
});

test('returned author: a different automatic request, Run, segment or noninitial prepared version never gains the exemption', async (t) => {
  const h = await returned(t);
  const returnedNode = h.read();
  const { review: _review, ...author } = h.reservedNode.nativeExecution;
  const original = { ...h.reservedNode, nativeExecution: { ...author, schemaVersion: 1 } };
  for (const patch of [
    { requestId: `workflow-review-${'0'.repeat(64)}` },
    { newRunId: 'different-prepared-run' },
    { newSegmentId: 'different-prepared-segment' },
    { configurationId: 'not-a-frozen-review-composition' },
    { version: 2 },
  ]) {
    const { version, ...fields } = patch;
    const candidate = prepareExecutionReview(
      original,
      createExecutionHandoff(original, h.readWorkbench()),
      {
        requestId: h.query.requestId,
        expectedReviewVersion: 0,
        target: h.query.target,
        reviewerId: 'qa',
        controllerMemberId: 'chen',
        configurationId: h.reviewComposition.configurationId,
        newRunId: h.prepared.attempt.scope.runId,
        newSegmentId: h.prepared.attempt.scope.segmentId,
        ...fields,
      },
    ).record;
    if (version) candidate.nativeExecution.review.attempts[0].version = version;
    const changed = { ...returnedNode, nativeExecution: candidate.nativeExecution };
    readExecutionReviewState(changed);
    await h.domain.table('nodes').put(nodeRecordKey(changed), changed);
    refused(await h.service.startRun(h.request, h.input), 'run-active');
    assert.deepEqual(h.read(), changed);
  }
});

test('returned author: requested, uncertain-dispatch and running native reviews remain held even with the old Stop', async (t) => {
  const h = await returned(t);
  const returnedNode = h.read();
  let candidate = admitExecutionReview(h.reservedNode, {
    scope: h.prepared.attempt.scope,
    expectedAttemptVersion: 1,
    composition: h.reviewComposition,
  }).record;
  for (const event of [
    undefined,
    { kind: 'dispatch-unknown', sequence: 1 },
    {
      kind: 'accepted',
      sequence: 2,
      nativeSessionId: 'possibly-active-review',
      nativeAgentId: 'possibly-active-review',
    },
  ]) {
    if (event)
      candidate = recordExecutionReviewEvent(candidate, {
        scope: h.prepared.attempt.scope,
        ...event,
      }).record;
    const changed = { ...returnedNode, nativeExecution: candidate.nativeExecution };
    await h.domain.table('nodes').put(nodeRecordKey(changed), changed);
    refused(await h.service.startRun(h.request, h.input), 'run-active');
    assert.deepEqual(h.read(), changed);
  }
});

test('returned author: the final transition rechecks a Stop revoked by the native drain callback', async (t) => {
  const h = await returned(t);
  const before = h.read();
  const [, receipt] = [...h.domain.table('plans').entries()][0];
  const changed = structuredClone(receipt);
  changed.workflowExecution.commandReceipts = changed.workflowExecution.commandReceipts.filter(
    (r) => r.kind !== 'stop',
  );
  let revoked = false,
    checks = 0;
  // Explicit storage-port contract: after the second physical-drain assertion,
  // the original Service reads a changed durable Stop fact synchronously.
  const storage = h.service.storage,
    readPlan = storage.readPlan;
  storage.readPlan = (...args) => (revoked ? structuredClone(changed) : readPlan(...args));
  t.after(() => {
    storage.readPlan = readPlan;
  });
  h.setOnDrain(() => {
    if (++checks === 2) revoked = true;
  });
  refused(await h.service.beginRun(h.request, h.input), 'run-active');
  assert.equal(checks, 2, 'the first verification passed; the commit callback revoked the Stop');
  assert.deepEqual(h.read(), before);
});

test('returned author: a never-admitted marker without the original committed workflow Stop remains held', async (t) => {
  const h = await returned(t, { stop: false });
  const before = h.read();
  refused(await h.service.startRun(h.request, h.input), 'run-active');
  assert.deepEqual(h.read(), before);
});

test('returned author: exact Stop generation and automatic request/Run/segment bindings are mandatory', async (t) => {
  const h = await returned(t);
  const [key, receipt] = [...h.domain.table('plans').entries()][0];
  const node = h.read();
  assert.equal(
    stoppedPreparedWorkflowReviewRunIdsForRevision(node, receipt.workflowExecution).size,
    1,
  );
  for (const mutate of [
    (intent) => {
      intent.commandReceipts = intent.commandReceipts.filter((r) => r.kind !== 'stop');
    },
    (intent) => {
      intent.commandReceipts.find((r) => r.kind === 'stop').fingerprint = '0'.repeat(64);
    },
    (intent) => {
      intent.commandReceipts.find((r) => r.kind === 'stop').generation++;
    },
    (intent) => {
      intent.intentId = 'different-workflow';
    },
    (intent) => {
      intent.actorId = 'outside';
    },
    (intent) => {
      intent.spaceId = 'different-space';
    },
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed.workflowExecution);
    await h.domain.table('plans').put(key, changed);
    const result = await h.service.startRun(h.request, h.input);
    assert.equal(result.ok, false);
    assert.deepEqual(h.read(), node);
  }
  await h.domain.table('plans').put(key, receipt);
  assert.equal(
    checked(await h.service.startRun(h.request, h.input)).run.attempt.id,
    'revised-author',
  );
});

test('returned author: member revocation by the Host configuration callback cannot reuse logical qualification', async (t) => {
  const h = await returned(t);
  const before = h.read();
  h.assertionResults.configuration = () => h.member.abort();
  const result = await h.service.startRun(h.request, h.input);
  assert.equal(result.ok, false);
  assert.deepEqual(h.read(), before);
});
