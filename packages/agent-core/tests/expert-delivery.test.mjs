/** Pure domain contracts. Synthetic provenance does not prove a native completion or Host authorization. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  canonicalPayload,
  castBallot,
  settleReview,
  startAppliedPlan,
  submitDelivery,
} from '@zhuma/agent-core';
// A owns the public index; this new domain entry is not exported there yet.
import { submitExpertDelivery } from '../dist/human-node.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function ready({ human = false, review = true } = {}) {
  const { state, task, node } = fixture();
  const saved = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'qa', 'outside'],
      status: 'ready',
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            {
              ...node,
              assigneeId: human ? 'chen' : 'qa',
              skillIds: [],
              reviewerIds: review ? [human ? 'qa' : 'chen', 'outside'] : [],
              reviewRequired: review,
            },
          ],
        },
      ],
    },
  });
  const applied = saved.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: task.id, planId: applied.id, revision: applied.revision },
    applied,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(started.ok, true);
  return started.records[0];
}
function input(record, changes = {}) {
  return {
    record,
    expertId: 'qa',
    producerRunId: 'domain-run-1',
    provenanceFingerprint: 'a'.repeat(64),
    idempotencyKey: 'expert-result-1',
    expectedVersion: record.command.version,
    draft: { text: '已核对的交付结果', files: [], links: ['https://example.invalid/reference'] },
    artifactId: 'artifact:expert-result-1',
    roundId: 'round:expert-result-1',
    ...changes,
  };
}
function ballot(record, reviewerId, action, comment) {
  const round = record.rounds.find((item) => item.id === record.currentRoundId);
  return castBallot({
    record,
    actorId: reviewerId,
    idempotencyKey: `vote:${reviewerId}:${round.id}`,
    expectedVersion: record.command.version,
    ballot: {
      reviewerId,
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action,
      ...(comment === undefined ? {} : { comment }),
    },
  });
}
function settle(record) {
  const round = record.rounds.find((item) => item.id === record.currentRoundId);
  return settleReview({
    record,
    actorId: 'chen',
    idempotencyKey: `settle:${round.id}`,
    expectedVersion: record.command.version,
    roundId: round.id,
    artifactVersionId: round.artifactVersionId,
  });
}

test('expert delivery domain: records the actual expert and producer Run and reuses multi-review settlement', () => {
  const record = ready(),
    submitted = submitExpertDelivery(input(record));
  assert.equal(submitted.ok, true);
  assert.equal(submitted.record.command.status, 'in-review');
  assert.equal(submitted.record.artifactVersions.length, 1);
  assert.equal(submitted.record.artifactVersions[0].submittedBy, 'qa');
  assert.equal(submitted.record.artifactVersions[0].producerRunId, 'domain-run-1');
  assert.equal(submitted.record.acceptedArtifactVersionId, undefined);
  const round = submitted.record.rounds[0];
  assert.deepEqual(round.reviewerIds, ['chen', 'outside']);
  assert.equal(round.artifactVersionId, submitted.record.artifactVersions[0].id);
  const one = ballot(submitted.record, 'chen', 'approve');
  assert.equal(one.ok, true);
  assert.equal(one.record.command.status, 'in-review');
  const two = ballot(one.record, 'outside', 'approve');
  assert.equal(two.ok, true);
  const accepted = settle(two.record);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.record.command.status, 'completed');
  assert.equal(accepted.record.acceptedArtifactVersionId, round.artifactVersionId);
});

test('expert delivery domain: no-review submission accepts one immutable version, not a fake human owner', () => {
  const submitted = submitExpertDelivery(input(ready({ review: false })));
  assert.equal(submitted.ok, true);
  assert.equal(submitted.record.command.status, 'completed');
  assert.equal(submitted.record.artifactVersions.length, 1);
  assert.equal(submitted.record.acceptedArtifactVersionId, 'artifact:expert-result-1');
  assert.equal(submitted.record.rounds.length, 0);
  assert.equal(submitted.record.ownerId, 'chen');
  assert.equal(submitted.record.artifactVersions[0].submittedBy, 'qa');
});

test('expert delivery domain: exact replay creates neither another version nor another round', () => {
  const original = input(ready()),
    first = submitExpertDelivery(original);
  assert.equal(first.ok, true);
  const replay = submitExpertDelivery({ ...original, record: first.record });
  assert.equal(replay.ok, true);
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.record, first.record);
  assert.equal(replay.record.artifactVersions.length, 1);
  assert.equal(replay.record.rounds.length, 1);
});

for (const [name, change] of [
  [
    'producer Run',
    (i) => {
      i.producerRunId = 'another-run';
    },
  ],
  [
    'native provenance',
    (i) => {
      i.provenanceFingerprint = 'b'.repeat(64);
    },
  ],
  [
    'text',
    (i) => {
      i.draft = { ...i.draft, text: 'different' };
    },
  ],
  [
    'links',
    (i) => {
      i.draft = { ...i.draft, links: ['https://example.invalid/other'] };
    },
  ],
])
  test(`expert delivery domain: same key with different ${name} refuses without mutation`, () => {
    const original = input(ready()),
      first = submitExpertDelivery(original),
      changed = { ...original, record: first.record };
    change(changed);
    const result = submitExpertDelivery(changed);
    assert.equal(result.ok, false);
    assert.equal(result.disposition, 'idempotency-mismatch');
    assert.equal(result.record, first.record);
  });

test('expert delivery domain: human path, human nodes and another expert cannot impersonate the assignee', () => {
  const expert = ready();
  for (const actorId of ['chen', 'qa'])
    assert.equal(submitDelivery({ ...input(expert), actorId }).code, 'not-assignee');
  assert.equal(submitExpertDelivery(input(ready({ human: true }))).code, 'not-assignee');
  assert.equal(submitExpertDelivery(input(expert, { expertId: 'chen' })).code, 'not-assignee');
});

for (const status of ['running', 'waiting-for-input', 'cancelled', 'failed', 'in-review'])
  test(`expert delivery domain: ${status} cannot create a new delivery`, () => {
    const record = ready();
    record.command = { ...record.command, status };
    const result = submitExpertDelivery(input(record));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'node-not-ready-for-delivery');
    assert.equal(result.record, record);
    assert.equal(result.record.artifactVersions.length, 0);
  });

test('expert delivery domain: invalid provenance, file claims, unsafe links and empty content never consume a receipt', () => {
  const record = ready();
  for (const change of [
    { producerRunId: undefined },
    { producerRunId: '' },
    { provenanceFingerprint: null },
    { provenanceFingerprint: 'not-a-digest' },
    { draft: { text: 'file claim', files: [{ id: 'pretend-file' }], links: [] } },
    { draft: { text: 'bad link', files: [], links: ['file:///not-a-source'] } },
    { draft: { text: 'bad link', files: [], links: ['https://user:password@example.invalid/'] } },
    { draft: { text: ' ', files: [], links: [] } },
  ]) {
    const result = submitExpertDelivery(input(record, change));
    assert.equal(result.ok, false);
    assert.equal(result.record, record);
    assert.equal(result.record.receipts.length, 0);
  }
});

test('expert delivery domain: returned work creates a fresh version and review round through the same path', () => {
  const first = submitExpertDelivery(input(ready()));
  const returned = ballot(first.record, 'chen', 'request-changes', '补充错误码');
  assert.equal(returned.ok, true);
  const settled = settle(returned.record);
  assert.equal(settled.ok, true);
  assert.equal(settled.record.command.status, 'needs-revision');
  const second = submitExpertDelivery(
    input(settled.record, {
      producerRunId: 'domain-run-2',
      provenanceFingerprint: 'b'.repeat(64),
      idempotencyKey: 'expert-result-2',
      artifactId: 'artifact:expert-result-2',
      roundId: 'round:expert-result-2',
    }),
  );
  assert.equal(second.ok, true);
  assert.equal(second.record.command.status, 'in-review');
  assert.deepEqual(
    second.record.artifactVersions.map((v) => [v.version, v.producerRunId]),
    [
      [1, 'domain-run-1'],
      [2, 'domain-run-2'],
    ],
  );
  assert.equal(second.record.currentRoundId, 'round:expert-result-2');
  assert.equal(second.record.rounds.length, 2);
});

test('expert delivery domain: conflict has no side effects and human fingerprint/metadata remain unchanged', () => {
  const record = ready();
  const conflict = submitExpertDelivery(
    input(record, { expectedVersion: record.command.version + 1 }),
  );
  assert.equal(conflict.disposition, 'conflict');
  assert.equal(conflict.record, record);
  const human = ready({ human: true, review: false });
  const request = { ...input(human), actorId: 'chen' };
  const submitted = submitDelivery(request);
  assert.equal(submitted.ok, true);
  assert.equal(submitted.record.artifactVersions[0].submittedBy, 'chen');
  assert.equal(
    submitted.record.artifactVersions[0].producerRunId,
    undefined,
    'unknown provenance fields on the human input remain ignored',
  );
  assert.equal(
    submitted.record.receipts.at(-1).fingerprint,
    canonicalPayload({
      kind: 'submit',
      actorId: 'chen',
      nodeId: human.nodeId,
      text: request.draft.text,
      files: [],
      links: request.draft.links,
    }),
  );
  assert.equal(submitDelivery({ ...request, record: submitted.record }).disposition, 'replayed');
});
