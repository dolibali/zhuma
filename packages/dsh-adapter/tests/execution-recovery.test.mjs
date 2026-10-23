import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const lin = {
  id: 'lin',
  name: '林夏',
  kind: 'human',
  role: '复核',
  capabilities: [],
  instructions: '',
  available: true,
};

function session(memberId, spaceIds = ['project']) {
  return { member: { ok: true, memberId, spaceIds } };
}

function workflowNode(partial) {
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

function memory() {
  const nodes = new Map();
  const plans = new Map();
  return {
    readNode: (key) => nodes.get(key),
    writeNode: async (key, value) => {
      nodes.set(key, structuredClone(value));
    },
    listNodes: () => [...nodes.values()],
    readPlan: (key) => plans.get(key),
    writePlan: async (key, value) => {
      plans.set(key, structuredClone(value));
    },
    listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
    node: (id) => [...nodes.values()].find((record) => record.nodeId === id),
  };
}

function locate(applied, nodeId, expectedVersion, idempotencyKey) {
  return {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId,
    expectedVersion,
    idempotencyKey,
  };
}

function file(over = {}) {
  return {
    id: 'notes',
    mediaType: 'text/plain',
    byteSize: 4,
    checksum: 'abc',
    accessPolicyId: 'task-read',
    uploadComplete: true,
    ...over,
  };
}

const reviewed = () =>
  confirm(
    [
      workflowNode({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['lin', 'outside'],
      }),
      workflowNode({
        id: 'publish',
        title: '发布',
        assigneeId: 'outside',
        dependsOn: ['design'],
      }),
    ],
    [lin],
  );

async function startChen(service, applied) {
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true);
}

test('one complete file and one incomplete file block the submit', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const store = memory();
  const service = new ExecutionService(store, { readWorkbench: () => state });
  await startChen(service, applied);
  const mixed = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'mixed'),
    text: '有说明',
    files: [file(), file({ id: 'second', uploadComplete: false })],
  });
  assert.equal(mixed.error.code, 'upload-incomplete');
  assert.equal(store.node('design').command.version, 1);
  assert.equal(store.node('design').receipts.length, 0);
  assert.equal(store.node('design').artifactVersions.length, 0);
  const fixed = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'mixed'),
    text: '有说明',
    files: [file(), file({ id: 'second' })],
  });
  assert.equal(fixed.value.disposition, 'applied');
});

test('the same key and an approve against a send-back stay consistent', async () => {
  const { state, applied } = reviewed();
  const store = memory();
  const service = new ExecutionService(store, { readWorkbench: () => state });
  await startChen(service, applied);
  const body = { ...locate(applied, 'design', 1, 'dup'), text: '同一份' };
  const same = await Promise.all([
    service.submit(session('chen'), body),
    service.submit(session('chen'), body),
    service.submit(session('chen'), body),
  ]);
  assert.equal(same.filter((item) => item.ok && item.value.disposition === 'applied').length, 1);
  assert.equal(same.filter((item) => item.ok && item.value.disposition === 'replayed').length, 2);
  assert.equal(store.node('design').artifactVersions.length, 1);

  const design = store.node('design');
  const vote = (actorId, key, action, comment) =>
    service.ballot(session(actorId), {
      ...locate(applied, 'design', design.command.version, key),
      roundId: design.currentRoundId,
      artifactVersionId: design.artifactVersions.at(-1).id,
      action,
      ...(comment === undefined ? {} : { comment }),
    });
  const race = await Promise.all([
    vote('lin', 'approve-lin', 'approve'),
    vote('outside', 'back-outside', 'request-changes', '改一下'),
  ]);
  assert.equal(
    race.every((item) => item.ok),
    true,
  );
  assert.equal(store.node('design').command.status, 'needs-revision');
  assert.equal(store.node('publish').command.status, 'blocked');
});

test('two reviewers send back, then resubmit, then all approve', async () => {
  const { state, applied } = reviewed();
  const store = memory();
  const service = new ExecutionService(store, { readWorkbench: () => state });
  await startChen(service, applied);
  const first = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'v1'),
    text: '第一版',
  });
  assert.equal(first.value.node.status, 'in-review');
  const roundId = first.value.node.currentRoundId;
  const artifactId = first.value.node.artifacts.at(-1).id;
  const ballot = (actorId, key, action, comment, version = store.node('design').command.version) =>
    service.ballot(session(actorId), {
      ...locate(applied, 'design', version, key),
      roundId: store.node('design').currentRoundId,
      artifactVersionId: store.node('design').artifactVersions.at(-1).id,
      action,
      ...(comment === undefined ? {} : { comment }),
    });
  const approved = await ballot('lin', 'lin-1', 'approve');
  assert.equal(store.node('design').command.status, 'in-review');
  assert.equal(approved.ok, true);
  const sentBack = await ballot('outside', 'out-1', 'request-changes', '缺错误码');
  assert.equal(sentBack.value.node.status, 'needs-revision');
  assert.equal(store.node('publish').command.status, 'blocked');
  const revised = await service.submit(session('chen'), {
    ...locate(applied, 'design', store.node('design').command.version, 'v2'),
    text: '第二版',
  });
  assert.equal(revised.value.node.status, 'in-review');
  assert.notEqual(revised.value.node.currentRoundId, roundId);
  assert.equal(store.node('design').rounds.at(-1).ballots.length, 0);
  const onlyOne = await ballot('outside', 'out-2', 'approve');
  assert.equal(onlyOne.ok, true);
  assert.equal(store.node('design').command.status, 'in-review');
  const reused = await ballot('lin', 'lin-1', 'approve');
  assert.equal(store.node('design').command.status, 'in-review');
  assert.equal(reused.ok && reused.value.disposition === 'replayed', false);
  const finished = await ballot('lin', 'lin-2', 'approve');
  assert.equal(finished.ok, true);
  const design = store.node('design');
  const publish = store.node('publish');
  assert.equal(design.command.status, 'completed');
  assert.equal(design.artifactVersions.length, 2);
  assert.equal(design.acceptedArtifactVersionId, design.artifactVersions.at(-1).id);
  assert.notEqual(design.acceptedArtifactVersionId, artifactId);
  assert.equal(publish.command.status, 'ready');
  assert.equal(publish.handoff.inputRefs[0].artifactVersionId, design.acceptedArtifactVersionId);
});
