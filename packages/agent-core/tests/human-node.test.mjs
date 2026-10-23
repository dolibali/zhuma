import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  castBallot,
  completionSource,
  startAppliedPlan,
  submitDelivery,
  unlockDownstream,
  unlockKey,
} from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function node(partial) {
  return {
    description: '',
    assigneeId: 'chen',
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
    input: '',
    output: '交付说明',
    rationale: '',
    position: { x: 0, y: 0 },
    ...partial,
  };
}

function confirm(nodes, extra = []) {
  const { state, task } = fixture();
  for (const person of extra) state.participants.push(person);
  const participantIds = new Set(task.participantIds);
  for (const person of extra) participantIds.add(person.id);
  for (const item of nodes) {
    if (item.assigneeId) participantIds.add(item.assigneeId);
    for (const reviewerId of item.reviewerIds) participantIds.add(reviewerId);
  }
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: [...participantIds],
      workflows: [{ ...task.workflows[0], nodes }],
      status: 'ready',
    },
  });
  const applied = ready.appliedPlans.at(-1);
  assert.ok(applied);
  return { state: ready, applied };
}

function start(applied, existing = [], actorId = 'chen') {
  return startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId,
    existing,
  });
}

function at(records, nodeId) {
  const found = records.find((record) => record.nodeId === nodeId);
  assert.ok(found, nodeId);
  return found;
}

const lin = {
  id: 'lin',
  name: '林夏',
  kind: 'human',
  role: '复核',
  capabilities: [],
  instructions: '',
  available: true,
};

function textDraft(text) {
  return { text, files: [], links: [] };
}

function file(uploadComplete) {
  return {
    id: 'notes',
    mediaType: 'text/plain',
    byteSize: 12,
    checksum: 'abc123',
    accessPolicyId: 'task-read',
    uploadComplete,
  };
}

function submit(record, actorId, key, draft, expectedVersion = record.command.version) {
  return submitDelivery({
    record,
    actorId,
    idempotencyKey: key,
    expectedVersion,
    draft,
    artifactId: `artifact:${key}`,
    roundId: `round:${key}`,
  });
}

function vote(record, actorId, action, extra = {}) {
  const roundId = record.currentRoundId;
  const round = record.rounds.find((item) => item.id === roundId);
  assert.ok(round);
  return castBallot({
    record,
    actorId,
    idempotencyKey: extra.idempotencyKey ?? `vote:${actorId}:${roundId}:${action}`,
    expectedVersion: extra.expectedVersion ?? record.command.version,
    ballot: {
      reviewerId: extra.reviewerId ?? actorId,
      roundId: extra.roundId ?? roundId,
      artifactVersionId: extra.artifactVersionId ?? round.artifactVersionId,
      action,
      ...(extra.comment === undefined ? {} : { comment: extra.comment }),
    },
    ...(extra.comments === undefined ? {} : { comments: extra.comments }),
  });
}

test('starts the exact revision and records entry status without using the actor as owner', () => {
  const { applied } = confirm([
    node({ id: 'design', title: '设计' }),
    node({ id: 'publish', title: '发布', assigneeId: 'outside', dependsOn: ['design'] }),
  ]);
  const wrong = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision + 1 },
    applied,
    actorId: 'outside',
    existing: [],
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'plan-not-found');
  assert.equal(wrong.records.length, 0);
  assert.equal(
    startAppliedPlan({
      requested: { taskId: applied.taskId, planId: applied.id, revision: 0 },
      applied,
      actorId: 'chen',
      existing: [],
    }).code,
    'plan-reference-required',
  );

  const started = start(applied, [], 'outside');
  assert.equal(started.ok, true);
  assert.equal(started.disposition, 'applied');
  const design = at(started.records, 'design');
  const publish = at(started.records, 'publish');
  assert.equal(design.command.status, 'ready');
  assert.equal(publish.command.status, 'blocked');
  assert.equal(design.command.entryStatus, 'ready');
  assert.equal(publish.command.entryStatus, 'ready');
  assert.equal(design.ownerId, 'chen');
  assert.equal(publish.ownerId, 'chen');
  assert.notEqual(design.ownerId, 'outside');
  assert.equal(design.handoff.inputRefs.length, 0);
  assert.equal(publish.handoff.inputRefs.length, 0);

  const frozen = structuredClone(started.records);
  const again = start(applied, started.records, 'outside');
  assert.equal(again.disposition, 'replayed');
  assert.deepEqual(started.records, frozen);
  assert.equal(at(again.records, 'design').command.version, 1);
});

test('a wrong revision does not fall back to a newer applied plan', () => {
  const { state, applied } = confirm([node({ id: 'design', title: '设计' })]);
  const drafted = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...state.tasks[0], status: 'draft' },
  });
  const revised = applyWorkbenchCommand(drafted, {
    type: 'save-task',
    task: { ...drafted.tasks[0], status: 'ready' },
  });
  const v1 = revised.appliedPlans.find((plan) => plan.revision === 1);
  const v2 = revised.appliedPlans.find((plan) => plan.revision === 2);
  assert.ok(v1);
  assert.ok(v2);
  assert.equal(applied.revision, 1);
  const fallback = startAppliedPlan({
    requested: { taskId: v1.taskId, planId: v1.id, revision: 1 },
    applied: v2,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.code, 'plan-not-found');
  const exact = startAppliedPlan({
    requested: { taskId: v1.taskId, planId: v1.id, revision: 1 },
    applied: v1,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(exact.ok, true);
  assert.equal(exact.records[0].revision, 1);
  assert.equal(exact.records[0].planId, v1.id);
});

test('a dependent node started after upstream completed stays blocked until unlock writes inputRefs', () => {
  const { applied } = confirm([
    node({ id: 'design', title: '设计' }),
    node({ id: 'publish', title: '发布', assigneeId: 'outside', dependsOn: ['design'] }),
  ]);
  const started = start(applied);
  const design = at(started.records, 'design');
  const completed = {
    ...design,
    command: { ...design.command, status: 'completed' },
    acceptedArtifactVersionId: 'artifact:early',
  };
  const retried = start(applied, [completed]);
  assert.equal(retried.ok, true);
  const publish = at(retried.records, 'publish');
  assert.equal(publish.command.status, 'blocked');
  assert.deepEqual(publish.handoff.inputRefs, []);
  const source = completionSource(at(retried.records, 'design'));
  assert.equal(source, 'artifact:artifact:early');
  const unlocked = unlockDownstream({
    record: publish,
    dependencies: retried.records,
    actorId: 'chen',
    idempotencyKey: unlockKey(source, 'publish'),
    expectedVersion: publish.command.version,
  });
  assert.equal(unlocked.disposition, 'applied');
  assert.equal(unlocked.record.command.status, 'ready');
  assert.deepEqual(unlocked.record.handoff.inputRefs, [
    { sourceNodeId: 'design', artifactVersionId: 'artifact:early' },
  ]);

  const alreadyReady = {
    ...publish,
    command: { ...publish.command, status: 'ready' },
  };
  const repaired = unlockDownstream({
    record: alreadyReady,
    dependencies: retried.records,
    actorId: 'chen',
    idempotencyKey: unlockKey(source, 'publish-ready'),
    expectedVersion: alreadyReady.command.version,
  });
  assert.equal(repaired.disposition, 'applied');
  assert.equal(repaired.record.command.status, 'ready');
  assert.equal(repaired.record.command.version, alreadyReady.command.version);
  assert.equal(repaired.record.handoff.inputRefs.length, 1);
  const again = unlockDownstream({
    record: repaired.record,
    dependencies: retried.records,
    actorId: 'chen',
    idempotencyKey: unlockKey(source, 'publish-ready'),
    expectedVersion: repaired.record.command.version,
  });
  assert.equal(again.disposition, 'ignored');
  assert.equal(again.record.handoff.inputRefs.length, 1);
});

test('an unbound owner and a non-assignee cannot submit, and a mismatched actor cannot vote', () => {
  const { applied } = confirm(
    [
      node({
        id: 'design',
        title: '设计',
        assigneeId: 'qa',
        reviewRequired: true,
        reviewerIds: ['outside'],
      }),
    ],
    [],
  );
  const started = start(applied);
  assert.equal(started.ok, true);
  const design = at(started.records, 'design');
  const ownerSubmit = submit(design, 'chen', 'owner-submit', textDraft('代交'));
  assert.equal(ownerSubmit.ok, false);
  assert.equal(ownerSubmit.code, 'not-assignee');
  assert.equal(ownerSubmit.record, design);
  assert.equal(design.artifactVersions.length, 0);
  assert.equal(design.receipts.length, 0);
  const reviewed = confirm(
    [
      node({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['outside', 'lin'],
      }),
    ],
    [lin],
  );
  const human = at(start(reviewed.applied).records, 'design');
  const stranger = submit(human, 'lin', 'stranger', textDraft('不是我的'));
  assert.equal(stranger.code, 'not-assignee');
  const submitted = submit(human, 'chen', 'design-v1', textDraft('第一版接口'));
  assert.equal(submitted.ok, true);
  const mismatch = vote(submitted.record, 'outside', 'approve', { reviewerId: 'lin' });
  assert.equal(mismatch.code, 'actor-mismatch');
  assert.equal(mismatch.record.rounds[0].ballots.length, 0);
  const unassigned = vote(submitted.record, 'chen', 'approve');
  assert.equal(unassigned.code, 'not-assigned-reviewer');
  assert.equal(submitted.record.receipts.length, 1);
});

test('an incomplete or empty upload does not take a version or write a receipt', () => {
  const { applied } = confirm([node({ id: 'design', title: '设计' })]);
  const design = at(start(applied).records, 'design');
  const before = structuredClone(design);
  const incomplete = submit(design, 'chen', 'upload', {
    text: '说明已经写了',
    files: [file(false)],
    links: [],
  });
  assert.equal(incomplete.code, 'upload-incomplete');
  assert.equal(incomplete.record, design);
  assert.deepEqual(design, before);
  const empty = submit(design, 'chen', 'upload', textDraft('   '));
  assert.equal(empty.code, 'empty-delivery');
  assert.equal(design.command.version, 1);
  assert.equal(design.command.stored.length, 1);
  assert.equal(design.artifactVersions.length, 0);
  assert.equal(design.receipts.length, 0);

  const stored = submit(design, 'chen', 'upload', textDraft('补齐后的说明'));
  assert.equal(stored.disposition, 'applied');
  assert.equal(stored.record.artifactVersions.length, 1);
  assert.equal(stored.record.artifactVersions[0].version, 1);
  assert.equal(stored.record.receipts.length, 1);
  assert.equal(stored.record.command.status, 'completed');
  assert.equal(completionSource(stored.record), 'artifact:artifact:upload');
});

test('a stale node version, round, or artifact is refused and a voided round stays closed', () => {
  const { applied } = confirm(
    [
      node({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['outside'],
      }),
    ],
    [],
  );
  const design = at(start(applied).records, 'design');
  const behind = submit(design, 'chen', 'late', textDraft('迟到'), 0);
  assert.equal(behind.ok, false);
  assert.equal(behind.disposition, 'conflict');
  assert.equal(behind.code, 'conflict');
  assert.equal(design.artifactVersions.length, 0);
  assert.equal(design.command.version, 1);

  const submitted = submit(design, 'chen', 'design-v1', textDraft('第一版'));
  assert.equal(submitted.record.command.version, 2);
  const current = submitted.record;
  const staleVote = vote(current, 'outside', 'approve', { expectedVersion: 1 });
  assert.equal(staleVote.code, 'conflict');
  assert.equal(current.rounds[0].ballots.length, 0);

  const approved = vote(current, 'outside', 'approve');
  assert.equal(approved.disposition, 'applied');
  const missingRound = vote(approved.record, 'outside', 'approve', {
    idempotencyKey: 'missing-round',
    roundId: 'round-missing',
  });
  assert.equal(missingRound.code, 'stale-round');
  const staleArtifact = vote(approved.record, 'outside', 'comment', {
    idempotencyKey: 'stale-artifact',
    artifactVersionId: 'artifact-old',
    comment: '看错版本了',
  });
  assert.equal(staleArtifact.code, 'stale-version');
  assert.equal(approved.record.rounds[0].ballots.length, 1);

  const voided = {
    ...approved.record,
    rounds: approved.record.rounds.map((round) => ({ ...round, status: 'voided' })),
  };
  const voidedVote = vote(voided, 'outside', 'approve', { idempotencyKey: 'voided-vote' });
  assert.equal(voidedVote.code, 'voided-round');
  assert.equal(voided.rounds[0].ballots.length, 1);
});

test('a non-assignee or non-reviewer resending the same key is refused before replay', () => {
  const { applied } = confirm(
    [
      node({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['outside'],
      }),
    ],
    [],
  );
  const design = at(start(applied).records, 'design');
  const submitted = submit(design, 'chen', 'once', textDraft('机密说明'));
  assert.equal(submitted.disposition, 'applied');
  const stolen = submit(submitted.record, 'outside', 'once', textDraft('机密说明'));
  assert.equal(stolen.ok, false);
  assert.equal(stolen.disposition, 'rejected');
  assert.equal(stolen.code, 'not-assignee');
  assert.equal(stolen.record, submitted.record);
  assert.equal(submitted.record.artifactVersions.length, 1);
  assert.equal(submitted.record.receipts.length, 1);

  const voted = vote(submitted.record, 'outside', 'approve', { idempotencyKey: 'vote-1' });
  assert.equal(voted.disposition, 'applied');
  const stolenVote = vote(voted.record, 'chen', 'approve', { idempotencyKey: 'vote-1' });
  assert.equal(stolenVote.ok, false);
  assert.equal(stolenVote.disposition, 'rejected');
  assert.equal(stolenVote.code, 'not-assigned-reviewer');
  assert.equal(voted.record.rounds[0].ballots.length, 1);
  assert.equal(voted.record.receipts.length, 2);
});

test('the same delivery key replays and a different payload conflicts', () => {
  const { applied } = confirm([node({ id: 'design', title: '设计' })]);
  const design = at(start(applied).records, 'design');
  const first = submit(design, 'chen', 'once', textDraft('同一份说明'));
  const replay = submit(first.record, 'chen', 'once', textDraft('同一份说明'), 0);
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.record, first.record);
  assert.equal(first.record.artifactVersions.length, 1);
  assert.equal(first.record.command.version, 2);
  const changed = submit(first.record, 'chen', 'once', textDraft('另一份说明'), 0);
  assert.equal(changed.code, 'idempotency-mismatch');
  assert.equal(first.record.artifactVersions.length, 1);
  assert.equal(first.record.receipts.length, 1);
});
