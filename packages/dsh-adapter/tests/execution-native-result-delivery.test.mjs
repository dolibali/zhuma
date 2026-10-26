/** Pure result-delivery contracts. These source facts are not a real C result reference. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { submitExpertDelivery, castBallot, settleReview } from '@zhuma/agent-core';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import { command, available, records, begin } from './execution-run-fixture.mjs';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import {
  beginExecutionRun,
  recordExecutionRunEvent,
  readExecutionRunState,
  executionRunScope,
} from '../dist/execution-run-state.js';
import {
  nativeResultProvenance,
  nativeResultDeliveryReceipt,
} from '../dist/execution-native-result-delivery.js';

function projectionOf(composition) {
  const { firstMessage: _message, ...projection } = executionRunCompositionRequest(composition);
  return projection;
}

function prepared(options = {}) {
  const review = options.review ?? false;
  const text = Object.hasOwn(options, 'text') ? options.text : 'A fixed expert result.';
  const links = options.links ?? ['https://example.com/result'];
  const facts = compositionFacts({ upstream: true, expert: true });
  if (review) {
    const step = facts.workbench.appliedPlans[0].task.workflows[0].nodes.find(
      (item) => item.id === facts.node.nodeId,
    );
    step.reviewRequired = true;
    step.reviewerIds = ['chen'];
    facts.node = {
      ...facts.node,
      handoff: { ...facts.node.handoff, reviewRequired: true, reviewerIds: ['chen'] },
    };
  }
  const composition = freezeExecutionRunComposition({
    ...facts,
    resultIntentTool: describeNativeResultTool(),
  });
  const projection = projectionOf(composition);
  let node = beginExecutionRun(
    facts.node,
    { ...command(facts.node), ...projection, composition },
    [facts.node],
    available,
  ).record;
  node = recordExecutionRunEvent(node, {
    kind: 'accepted',
    runId: 'run-1',
    generation: 1,
    segmentId: 'segment-1',
    sequence: 1,
    nativeSessionId: 'contract-native-session',
    executorRunId: 'contract-native-agent',
  }).record;
  const scope = executionRunScope(node, readExecutionRunState(node).runs[0]);
  node = recordExecutionRunEvent(node, {
    kind: 'completed',
    runId: 'run-1',
    generation: 1,
    segmentId: 'segment-1',
    sequence: 2,
    idle: true,
    flushed: true,
    resourcesSettled: true,
  }).record;
  const source = {
    scope,
    nativeSessionId: 'contract-native-session',
    nativeAgentId: 'contract-native-agent',
    configurationId: composition.configurationId,
    toolVersion: 'zhuma-native-result-intent@1',
    intentId: 'contract-intent',
    callId: 'contract-call',
    cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 3 },
  };
  const content = { ...(text === undefined ? {} : { text }), links };
  const digest = nativeResultDigest(content);
  const provenanceFingerprint = nativeResultProvenance(source, digest);
  const delivered = submitExpertDelivery({
    record: node,
    expertId: 'qa',
    producerRunId: 'run-1',
    provenanceFingerprint,
    idempotencyKey: 'submit-result',
    expectedVersion: node.command.version,
    draft: { ...content, files: [] },
    artifactId: 'fixed-artifact',
    roundId: 'fixed-round',
  });
  assert.equal(delivered.ok, true, delivered.code);
  const state = readExecutionRunState(delivered.record);
  const resultDelivery = {
    protocolVersion: 1,
    source,
    digest,
    provenanceFingerprint,
    receiptKey: 'submit-result',
    artifactVersionId: 'fixed-artifact',
    ...(review ? { roundId: 'fixed-round' } : {}),
  };
  const record = {
    ...delivered.record,
    nativeExecution: { ...state, runs: state.runs.map((run) => ({ ...run, resultDelivery })) },
  };
  return { record, facts, content };
}

for (const review of [false, true])
  test(`result delivery contract: typed metadata ties exact artifact/receipt/${review ? 'review' : 'no review'} without a body copy`, () => {
    const { record } = prepared({ review });
    const run = readExecutionRunState(record).runs[0];
    const ack = nativeResultDeliveryReceipt(record, run, 'confirmed');
    assert.equal(ack.artifactVersionId, 'fixed-artifact');
    assert.equal(ack.roundId, review ? 'fixed-round' : undefined);
    assert.equal(ack.producerRunId, 'run-1');
    assert.equal(ack.receipt.idempotencyKey, 'submit-result');
    assert(!JSON.stringify(run.resultDelivery).includes('A fixed expert result.'));
    assert(!JSON.stringify(ack).includes('A fixed expert result.'));
    assert(!Object.hasOwn(ack.receipt, 'fingerprint'));
  });

for (const [name, patch] of [
  [
    'null metadata',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery = null;
    },
  ],
  [
    'explicit undefined',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery = undefined;
    },
  ],
  [
    'unknown protocol',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.protocolVersion = 2;
    },
  ],
  [
    'extra path',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.path = '/forbidden';
    },
  ],
  [
    'foreign scope',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.source.scope.nodeId = 'another-node';
    },
  ],
  [
    'old generation',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.source.scope.generation = 2;
    },
  ],
  [
    'foreign Run',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.source.scope.runId = 'another-run';
    },
  ],
  [
    'configuration',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.source.configurationId = 'another-config';
    },
  ],
  [
    'native agent',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.source.nativeAgentId = 'another-agent';
    },
  ],
  [
    'cut order',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.source.cut.resultSeq = 0;
    },
  ],
  [
    'wrong digest',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.digest = '0'.repeat(64);
    },
  ],
  [
    'wrong provenance',
    (r) => {
      r.nativeExecution.runs[0].resultDelivery.provenanceFingerprint = '0'.repeat(64);
    },
  ],
  [
    'artifact missing',
    (r) => {
      r.artifactVersions = [];
    },
  ],
  [
    'artifact producer',
    (r) => {
      r.artifactVersions[0].producerRunId = 'another-run';
    },
  ],
  [
    'artifact submitter',
    (r) => {
      r.artifactVersions[0].submittedBy = 'chen';
    },
  ],
  [
    'artifact body',
    (r) => {
      r.artifactVersions[0].text = 'REPLACED';
    },
  ],
  [
    'receipt missing',
    (r) => {
      r.receipts = [];
    },
  ],
  [
    'receipt mismatch',
    (r) => {
      r.receipts[0].fingerprint = 'REPLACED';
    },
  ],
  [
    'unsettled resources',
    (r) => {
      r.nativeExecution.runs[0].resources = 'held';
    },
  ],
])
  test(`result delivery contract: ${name} fails closed`, () => {
    const { record } = prepared();
    const changed = structuredClone(record);
    patch(changed);
    assert.throws(() => readExecutionRunState(changed), { code: 'run-state-invalid' });
  });

for (const patch of [
  (r) => {
    r.nativeExecution.runs[0].resultDelivery.roundId = undefined;
  },
  (r) => {
    r.rounds[0].artifactVersionId = 'different-artifact';
  },
  (r) => {
    r.rounds[0].reviewerIds = ['qa'];
  },
])
  test('result delivery contract: a mismatched review round cannot certify delivery', () => {
    const changed = structuredClone(prepared({ review: true }).record);
    patch(changed);
    assert.throws(() => readExecutionRunState(changed), { code: 'run-state-invalid' });
  });

for (const text of [undefined, ''])
  test(`result delivery contract: links-only ${text === undefined ? 'absent' : 'explicit empty'} text retains C digest and original receipt`, () => {
    const { record } = prepared({ text });
    assert.equal(record.artifactVersions[0].text, undefined);
    const run = readExecutionRunState(record).runs[0];
    assert.equal(nativeResultDeliveryReceipt(record, run, 'confirmed').artifactVersion, 1);
  });

test('result delivery contract: old metadata bytes stay unchanged and a terminal Run alone has no delivery', () => {
  const old = JSON.parse(
    readFileSync(
      new URL('./fixtures/native-run-pre-result-delivery.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(JSON.stringify(readExecutionRunState(old.record)), JSON.stringify(old.state));
  assert(!Object.hasOwn(readExecutionRunState(old.record).runs[0], 'resultDelivery'));
  let record = begin(records()[0]).record;
  record = recordExecutionRunEvent(record, {
    kind: 'accepted',
    runId: 'run-1',
    generation: 1,
    segmentId: 'segment-1',
    sequence: 1,
    nativeSessionId: 'native',
    executorRunId: 'agent',
  }).record;
  record = recordExecutionRunEvent(record, {
    kind: 'completed',
    runId: 'run-1',
    generation: 1,
    segmentId: 'segment-1',
    sequence: 2,
    idle: true,
    flushed: true,
    resourcesSettled: true,
  }).record;
  assert.equal(record.artifactVersions.length, 0);
  assert(!readExecutionRunState(record).runs[0].resultDelivery);
});

test('result delivery contract: a new generation does not erase the exact historical delivery receipt', () => {
  const { record: delivered, facts } = prepared({ review: true });
  const ballot = castBallot({
    record: delivered,
    actorId: 'chen',
    idempotencyKey: 'return',
    expectedVersion: delivered.command.version,
    ballot: {
      reviewerId: 'chen',
      roundId: 'fixed-round',
      artifactVersionId: 'fixed-artifact',
      action: 'request-changes',
      comment: 'Refine the result.',
    },
  });
  assert.equal(ballot.ok, true, ballot.code);
  const settled = settleReview({
    record: ballot.record,
    actorId: 'chen',
    idempotencyKey: 'settle',
    expectedVersion: ballot.record.command.version,
    roundId: 'fixed-round',
    artifactVersionId: 'fixed-artifact',
  });
  assert.equal(settled.ok, true, settled.code);
  const scope = { ...facts.scope, runId: 'run-2', generation: 2, segmentId: 'segment-2' };
  const composition = freezeExecutionRunComposition({
    ...facts,
    node: settled.record,
    scope,
    resultIntentTool: describeNativeResultTool(),
  });
  const next = beginExecutionRun(
    settled.record,
    {
      ...command(settled.record, {
        requestId: 'second',
        newRunId: 'run-2',
        newSegmentId: 'segment-2',
      }),
      ...projectionOf(composition),
      composition,
    },
    [settled.record],
    available,
  ).record;
  const state = readExecutionRunState(next);
  assert.equal(state.currentRunId, 'run-2');
  assert.equal(
    nativeResultDeliveryReceipt(next, state.runs[0], 'confirmed').roundId,
    'fixed-round',
  );
});
