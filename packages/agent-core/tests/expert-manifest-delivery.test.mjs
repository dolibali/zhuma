/** Pure domain contracts; synthetic manifests do not authenticate uploads or native completion. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  canonicalPayload,
  castBallot,
  settleReview,
  startAppliedPlan,
  submitDelivery,
  submitExpertDelivery,
  submitExpertManifestDelivery,
  unlockDownstream,
} from '@zhuma/agent-core';
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
            {
              ...node,
              id: 'downstream',
              assigneeId: 'chen',
              reviewerIds: [],
              reviewRequired: false,
              dependsOn: [node.id],
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
  return { record: started.records[0], downstream: started.records[1] };
}

function file(change = {}) {
  return {
    id: 'publication-1',
    mediaType: 'text/plain',
    byteSize: 12,
    checksum: 'a'.repeat(64),
    accessPolicyId: 'space:domain-contract',
    uploadComplete: true,
    ...change,
  };
}

function input(record, change = {}) {
  return {
    record,
    expertId: 'qa',
    producerRunId: 'domain-run-1',
    provenanceFingerprint: 'b'.repeat(64),
    idempotencyKey: 'manifest-result-1',
    expectedVersion: record.command.version,
    draft: { files: [file()], links: [] },
    artifactId: 'artifact:manifest-result-1',
    roundId: 'round:manifest-result-1',
    ...change,
  };
}

function vote(record, reviewerId, action = 'approve') {
  const round = record.rounds.find((item) => item.id === record.currentRoundId);
  const result = castBallot({
    record,
    actorId: reviewerId,
    idempotencyKey: `vote:${reviewerId}:${round.id}`,
    expectedVersion: record.command.version,
    ballot: {
      reviewerId,
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action,
      ...(action === 'request-changes' ? { comment: '修正文件内容' } : {}),
    },
  });
  assert.equal(result.ok, true);
  return result.record;
}

function settle(record) {
  const round = record.rounds.find((item) => item.id === record.currentRoundId);
  const result = settleReview({
    record,
    actorId: 'chen',
    idempotencyKey: `settle:${round.id}`,
    expectedVersion: record.command.version,
    roundId: round.id,
    artifactVersionId: round.artifactVersionId,
  });
  assert.equal(result.ok, true);
  return result.record;
}

function unlock(downstream, dependency, key) {
  const result = unlockDownstream({
    record: downstream,
    dependencies: [dependency],
    actorId: 'chen',
    idempotencyKey: key,
    expectedVersion: downstream.command.version,
  });
  assert.equal(result.ok, true);
  return result.record;
}

test('expert manifest: files-only delivery uses the expert, original review gate and accepted downstream version', () => {
  const { record, downstream } = ready();
  const request = input(record);
  const snapshot = structuredClone(record);
  const submitted = submitExpertManifestDelivery(request);
  assert.equal(submitted.ok, true);
  assert.deepEqual(record, snapshot);
  const version = submitted.record.artifactVersions[0];
  assert.equal(version.text, undefined);
  assert.equal(version.submittedBy, 'qa');
  assert.equal(version.producerRunId, 'domain-run-1');
  assert.deepEqual(version.files, request.draft.files);
  request.draft.files[0].checksum = 'c'.repeat(64);
  assert.equal(
    version.files[0].checksum,
    'a'.repeat(64),
    'input aliases cannot rewrite the version',
  );
  assert.equal(submitted.record.command.status, 'in-review');
  assert.equal(unlock(downstream, submitted.record, 'before-review').command.status, 'blocked');
  const one = settle(vote(submitted.record, 'chen'));
  assert.equal(one.command.status, 'in-review');
  assert.equal(unlock(downstream, one, 'one-vote').command.status, 'blocked');
  const accepted = settle(vote(one, 'outside'));
  assert.equal(accepted.command.status, 'completed');
  assert.equal(accepted.acceptedArtifactVersionId, version.id);
  const next = unlock(downstream, accepted, 'all-votes');
  assert.equal(next.command.status, 'ready');
  assert.deepEqual(next.handoff.inputRefs, [
    { sourceNodeId: record.nodeId, artifactVersionId: version.id },
  ]);
});

test('expert manifest: no-review files are accepted once and exact retry has no new version, round or receipt', () => {
  const { record } = ready({ review: false });
  const request = input(record);
  const first = submitExpertManifestDelivery(request);
  assert.equal(first.ok, true);
  assert.equal(first.record.command.status, 'completed');
  assert.equal(first.record.acceptedArtifactVersionId, request.artifactId);
  assert.equal(first.record.rounds.length, 0);
  const replay = submitExpertManifestDelivery({ ...request, record: first.record });
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.record, first.record);
  assert.equal(replay.record.artifactVersions.length, 1);
  assert.equal(replay.record.receipts.length, first.record.receipts.length);
});

for (const [name, change] of [
  ['Run', (i) => (i.producerRunId = 'domain-run-2')],
  ['provenance', (i) => (i.provenanceFingerprint = 'd'.repeat(64))],
  ['text', (i) => (i.draft.text = 'changed')],
  ['links', (i) => (i.draft.links = ['https://example.invalid/reference'])],
  ['file ID', (i) => (i.draft.files[0].id = 'publication-2')],
  ['file type', (i) => (i.draft.files[0].mediaType = 'application/json')],
  ['file size', (i) => (i.draft.files[0].byteSize = 13)],
  ['file digest', (i) => (i.draft.files[0].checksum = 'e'.repeat(64))],
  ['file policy', (i) => (i.draft.files[0].accessPolicyId = 'another-policy')],
  ['file completion', (i) => (i.draft.files[0].uploadComplete = false)],
  ['manifest members', (i) => i.draft.files.push(file({ id: 'publication-2' }))],
])
  test(`expert manifest: the same key with changed ${name} refuses without mutation`, () => {
    const request = input(ready().record);
    const first = submitExpertManifestDelivery(request);
    assert.equal(first.ok, true);
    const changed = structuredClone(request);
    change(changed);
    const result = submitExpertManifestDelivery({ ...changed, record: first.record });
    assert.equal(result.ok, false);
    assert.equal(result.disposition, 'idempotency-mismatch');
    assert.equal(result.record, first.record);
  });

test('expert manifest: malformed, duplicate or unfinished files, empty content and unsafe links consume no state', () => {
  const { record } = ready();
  for (const draft of [
    { files: null, links: [] },
    { files: [file({ uploadComplete: false })], links: [] },
    { files: [file({ byteSize: -1 })], links: [] },
    { files: [file({ checksum: '' })], links: [] },
    { files: [file(), file()], links: [] },
    { files: [], links: [] },
    { files: [file({ byteSize: 0 })], links: [] },
    { files: [file()], links: ['file:///private'] },
  ]) {
    const result = submitExpertManifestDelivery(input(record, { draft }));
    assert.equal(result.ok, false);
    assert.equal(result.record, record);
    assert.equal(record.artifactVersions.length, 0);
    assert.equal(record.rounds.length, 0);
    assert.equal(record.receipts.length, 0);
  }
});

test('expert manifest: human nodes, another expert and invalid provenance cannot use the entry', () => {
  const { record } = ready();
  for (const change of [
    { expertId: 'chen' },
    { producerRunId: '' },
    { producerRunId: 'r'.repeat(201) },
    { provenanceFingerprint: null },
    { provenanceFingerprint: 'not-a-digest' },
  ]) {
    const result = submitExpertManifestDelivery(input(record, change));
    assert.equal(result.ok, false);
    assert.equal(result.record, record);
  }
  const human = ready({ human: true }).record;
  assert.equal(
    submitExpertManifestDelivery(input(human, { expertId: 'chen' })).code,
    'not-assignee',
  );
  assert.equal(submitDelivery({ ...input(record), actorId: 'chen' }).code, 'not-assignee');
});

for (const status of [
  'running',
  'waiting-for-input',
  'cancelled',
  'failed',
  'in-review',
  'completed',
])
  test(`expert manifest: ${status} cannot create a delivery or consume a receipt`, () => {
    const { record } = ready();
    record.command = { ...record.command, status };
    const result = submitExpertManifestDelivery(input(record));
    assert.equal(result.code, 'node-not-ready-for-delivery');
    assert.equal(result.record, record);
    assert.equal(record.receipts.length, 0);
  });

test('expert manifest: return and resubmit fix a new version and only that accepted version reaches downstream', () => {
  const { record, downstream } = ready();
  const first = submitExpertManifestDelivery(input(record));
  assert.equal(first.ok, true);
  const returned = settle(vote(first.record, 'chen', 'request-changes'));
  assert.equal(returned.command.status, 'needs-revision');
  assert.equal(unlock(downstream, returned, 'returned').command.status, 'blocked');
  const second = submitExpertManifestDelivery(
    input(returned, {
      producerRunId: 'domain-run-2',
      provenanceFingerprint: 'c'.repeat(64),
      idempotencyKey: 'manifest-result-2',
      draft: { text: '修订说明', files: [file({ id: 'publication-2' })], links: [] },
      artifactId: 'artifact:manifest-result-2',
      roundId: 'round:manifest-result-2',
    }),
  );
  assert.equal(second.ok, true);
  assert.equal(second.record.rounds.length, 2);
  assert.deepEqual(
    second.record.artifactVersions.map((v) => [v.version, v.producerRunId, v.files[0].id]),
    [
      [1, 'domain-run-1', 'publication-1'],
      [2, 'domain-run-2', 'publication-2'],
    ],
  );
  const accepted = settle(vote(vote(second.record, 'chen'), 'outside'));
  assert.equal(accepted.command.status, 'completed');
  assert.deepEqual(unlock(downstream, accepted, 'revised-accepted').handoff.inputRefs, [
    { sourceNodeId: record.nodeId, artifactVersionId: 'artifact:manifest-result-2' },
  ]);
});

test('expert manifest: stale version refuses; legacy text fingerprints and file rejection stay unchanged', () => {
  const { record } = ready();
  const conflict = submitExpertManifestDelivery(
    input(record, { expectedVersion: record.command.version + 1 }),
  );
  assert.equal(conflict.disposition, 'conflict');
  assert.equal(conflict.record, record);
  assert.equal(submitExpertDelivery(input(record)).code, 'files-not-accepted');
  const text = input(record, { draft: { text: 'legacy text', files: [], links: [] } });
  const legacy = submitExpertDelivery(text);
  assert.equal(legacy.ok, true);
  assert.equal(
    legacy.record.receipts.at(-1).fingerprint,
    canonicalPayload({
      kind: 'expert-submit',
      expertId: text.expertId,
      nodeId: record.nodeId,
      producerRunId: text.producerRunId,
      provenanceFingerprint: text.provenanceFingerprint,
      text: text.draft.text,
      files: [],
      links: [],
    }),
  );
  assert.equal(submitExpertDelivery({ ...text, record: legacy.record }).disposition, 'replayed');
  assert.equal(
    submitExpertManifestDelivery({ ...text, record: legacy.record }).disposition,
    'idempotency-mismatch',
    'v2 cannot silently reinterpret the legacy receipt',
  );
});
