import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeReviewHost } from './execution-review-native-fixture.mjs';
import { checked } from './execution-service-run-fixture.mjs';
import { host } from './execution-review-service-fixture.mjs';
import { seedScaledReviewMetadata } from './native-work-session-review-scale-fixture.mjs';
import { ExecutionWorkflowIntents } from '../dist/execution-workflow-intent.js';
import { readExecutionRunState } from '../dist/execution-run-state.js';

// Real original Service/domain/queue. Member/model/SDK issuers remain explicit
// contracts; no actual model or C automatic runner is exercised here.
test('workflow claim: synchronous original owner check rejects copies/foreign requests before a caller reserves work', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true }),
    copy = { ...h.workflowClaim };
  assert.equal(copy.check(), undefined, 'a borrowed closure alone is not original identity');
  const before = h.read();
  h.resetCounts();
  assert.equal(h.service.assertWorkflowExecutionClaim(h.request, h.workflowClaim), undefined);
  for (const forged of [copy, {}, undefined, structuredClone(h.workflowClaim.view)])
    assert.throws(() => h.service.assertWorkflowExecutionClaim(h.request, forged), {
      code: 'workflow-authority-denied',
    });
  const other = Object.freeze({ headers: {} });
  h.members.set(other, 'chen');
  assert.throws(() => h.service.assertWorkflowExecutionClaim(other, h.workflowClaim), {
    code: 'workflow-authority-denied',
  });
  assert.equal(h.service.assertWorkflowExecutionClaim(h.request, h.workflowClaim), undefined);
  assert.deepEqual(h.read(), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('workflow claim: another original Service and stopped/fenced arms cannot pass the synchronous view', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true }),
    other = await nativeReviewHost(t, { workflow: {}, prepareOnly: true });
  assert.throws(() => other.service.assertWorkflowExecutionClaim(h.request, h.workflowClaim), {
    code: 'workflow-authority-denied',
  });
  checked(
    await h.service.stopWorkflowExecution(h.request, {
      ...h.workflowLocation,
      requestId: 'claim-contract-stop',
      intentId: h.workflowView.intent.intentId,
      generation: h.workflowView.intent.generation,
    }),
  );
  h.resetCounts();
  assert.throws(() => h.service.assertWorkflowExecutionClaim(h.request, h.workflowClaim));
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  other.service.fenceRuns();
  assert.throws(() =>
    other.service.assertWorkflowExecutionClaim(other.request, other.workflowClaim),
  );
});

test('workflow claim: current-only checks keep all three historical scope drains and reject changed bindings, copies, Stop and revocation', async (t) => {
  const h = await host(t, { reviewerIds: ['qa'] });
  await seedScaledReviewMetadata(h);
  let node = h.read();
  node.nativeExecution = readExecutionRunState(node);
  const location = {
    spaceId: 'north',
    taskId: node.taskId,
    planId: node.planId,
    revision: node.revision,
  };
  const member = new AbortController(),
    lifetime = new AbortController(),
    calls = [];
  const intentId = 'claim-current-contract';
  const starts = node.nativeExecution.runs.map((run, index) => ({
    intentId,
    generation: index + 1,
    nodeId: node.nodeId,
    expectedNodeVersion: 0,
    expectedRunVersion: 0,
    requestId: node.nativeExecution.receipts.find((receipt) => receipt.runId === run.attempt.id)
      .requestId,
    newRunId: run.attempt.id,
    newSegmentId: run.segmentId,
    expertId: 'qa',
    expertVersionId: run.attempt.expertVersionId,
    inputsFingerprint: run.attempt.payloadHash,
  }));
  let receipt = {
    idempotencyKey: 'contract-plan',
    fingerprint: 'contract-plan',
    nodeIds: [node.nodeId],
    workflowExecution: {
      schemaVersion: 1,
      intentId,
      actorId: 'chen',
      spaceId: 'north',
      generation: 4,
      version: 1,
      status: 'running',
      starts,
      defaults: {
        model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
        workspace: { kind: 'text-only' },
        tools: 'text-only',
      },
      budget: { concurrent: 1, automaticAttemptsPerNode: 1, automaticRevisions: 0 },
      commandReceipts: [
        { requestId: 'contract-start', kind: 'start', generation: 1, fingerprint: '0'.repeat(64) },
      ],
    },
  };
  const original = Object.freeze({});
  // Member/facts/drain callbacks are explicit contracts, never SDK drain proof.
  const coordinator = new ExecutionWorkflowIntents({
    signal: lifetime.signal,
    enqueue: (work) => work(),
    watch: () => () => {},
    async open(request) {
      assert.equal(request, original);
      return {
        memberId: 'chen',
        signal: member.signal,
        facts: () => ({ receipt, nodes: [node], availableExpertIds: [] }),
        async initialize() {
          assert.fail('already initialized');
        },
        assertDrained(actual, run) {
          assert.equal(actual, node);
          calls.push(run.attempt.id);
        },
        release() {},
      };
    },
    async write(_location, next) {
      receipt = structuredClone(next);
    },
  });
  t.after(() => coordinator.close());
  const resumed = checked(
    await coordinator.resume(original, {
      ...location,
      requestId: 'resume-current-contract',
      intentId,
      generation: 4,
      expectedVersion: 1,
    }),
  );
  const claim = checked(
    await coordinator.claim(original, {
      ...location,
      intentId,
      generation: resumed.intent.generation,
    }),
  );
  calls.length = 0;
  assert.equal(coordinator.assertClaimCurrent(original, claim).intent.generation, 5);
  assert.deepEqual(
    calls,
    node.nativeExecution.runs.map((run) => run.attempt.id),
  );
  for (const [request, candidate] of [
    [original, { ...claim }],
    [{}, claim],
  ])
    assert.throws(() => coordinator.assertClaimCurrent(request, candidate), {
      code: 'workflow-authority-denied',
    });
  const saved = receipt.workflowExecution.starts[1].requestId;
  receipt.workflowExecution.starts[1].requestId = 'mismatched-receipt';
  assert.throws(() => coordinator.assertClaimCurrent(original, claim));
  receipt.workflowExecution.starts[1].requestId = saved;
  await Promise.resolve();
  const oldSegment = node.nativeExecution.runs[0].segmentId;
  node.nativeExecution.runs[0].segmentId = 'different-historical-segment';
  assert.throws(() => coordinator.assertClaimCurrent(original, claim));
  node.nativeExecution.runs[0].segmentId = oldSegment;
  assert.equal(coordinator.assertClaimCurrent(original, claim).intent.generation, 5);
  checked(
    await coordinator.stop(original, {
      ...location,
      requestId: 'stop-current-contract',
      intentId,
      generation: 5,
    }),
  );
  assert.throws(() => coordinator.assertClaimCurrent(original, claim));
  member.abort();
  assert.throws(() => coordinator.assertClaimCurrent(original, claim));
});
