import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand, nodeRecordKey } from '@zhuma/agent-core';
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

function memory() {
  const nodes = new Map();
  const plans = new Map();
  let writes = 0;
  let failOn = 0;
  const gate = async () => {
    writes += 1;
    if (writes === failOn) throw new Error('disk full');
  };
  const storage = {
    readNode: (key) => nodes.get(key),
    writeNode: async (key, value) => {
      await gate();
      nodes.set(key, structuredClone(value));
    },
    listNodes: () => [...nodes.values()],
    readPlan: (key) => plans.get(key),
    writePlan: async (key, value) => {
      await gate();
      plans.set(key, structuredClone(value));
    },
    listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
  };
  return {
    storage,
    node: (id) => [...nodes.values()].find((record) => record.nodeId === id),
    planCount: () => plans.size,
    arm(writeNumber) {
      writes = 0;
      failOn = writeNumber;
    },
  };
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

function create(state) {
  const store = memory();
  const service = new ExecutionService(store.storage, { readWorkbench: () => state });
  return { service, store };
}

function session(memberId, spaceIds = ['project']) {
  return { member: { ok: true, memberId, spaceIds } };
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

async function startChen(service, applied, idempotencyKey = 'start-1') {
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey,
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  return started.value;
}

test('a caller without a resolved member is refused, and a request cannot choose its actor', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计', assigneeId: 'outside' }),
  ]);
  const { service } = create(state);
  const missing = await service.startPlan(
    {},
    {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: 'start-missing-member',
    },
  );
  assert.equal(missing.error.code, 'unauthenticated');
  assert.equal(
    (
      await service.startPlan(session('chen'), {
        taskId: applied.taskId,
        planId: applied.id,
        revision: applied.revision,
        idempotencyKey: 'start-actor',
        actorId: 'outside',
      })
    ).error.code,
    'actor-from-body',
  );
  assert.equal(
    (
      await service.startPlan(session('ghost'), {
        taskId: applied.taskId,
        planId: applied.id,
        revision: applied.revision,
        idempotencyKey: 'start-ghost',
      })
    ).error.code,
    'not-in-directory',
  );
});

test('start accepts only the requested revision and replays a partial write', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计' }),
    workflowNode({ id: 'publish', title: '发布', assigneeId: 'outside', dependsOn: ['design'] }),
  ]);
  const { service, store } = create(state);
  const missing = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision + 1,
    idempotencyKey: 'start-missing',
  });
  assert.equal(missing.error.code, 'plan-not-found');
  assert.equal(store.planCount(), 0);
  assert.equal(
    (
      await service.startPlan(session('chen'), {
        taskId: applied.taskId,
        planId: applied.id,
        revision: 0,
        idempotencyKey: 'start-zero',
      })
    ).error.code,
    'plan-reference-required',
  );

  store.arm(2);
  const failed = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(failed.error.code, 'unavailable');
  assert.equal(store.planCount(), 0);
  assert.equal(store.node('design').command.version, 1);
  assert.equal(store.node('publish'), undefined);

  store.arm(0);
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.value.disposition, 'applied');
  assert.equal(store.node('design').command.version, 1);
  assert.equal(store.node('publish').command.status, 'blocked');
  assert.equal(store.node('publish').command.entryStatus, 'ready');
  assert.equal(store.node('design').ownerId, 'chen');
  const replay = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-again',
  });
  assert.equal(replay.value.disposition, 'replayed');
  await store.storage.writePlan('task:other:2', {
    idempotencyKey: 'start-other',
    fingerprint: 'other',
    nodeIds: [],
  });
  assert.equal(
    (
      await service.startPlan(session('chen'), {
        taskId: 'task',
        planId: 'other',
        revision: 9,
        idempotencyKey: 'start-other',
      })
    ).error.code,
    'idempotency-mismatch',
  );
});
