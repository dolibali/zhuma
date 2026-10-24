import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand, nodeRecordKey } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const projectSpaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);

function memory() {
  const nodes = new Map();
  const plans = new Map();
  const storage = {
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
  };
  return {
    storage,
    node: (id) => [...nodes.values()].find((record) => record.nodeId === id),
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

function confirm(nodes, extra = [], workflows) {
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
      workflows: workflows ?? [{ ...task.workflows[0], nodes }],
      status: 'ready',
    },
  });
  const applied = ready.appliedPlans.at(-1);
  assert.ok(applied);
  return { state: ready, applied };
}

function create(state, spaces = projectSpaces) {
  const store = memory();
  const service = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
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

async function start(service, applied) {
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
}

test('inbox groups carry the task path and owner, and counts follow status', async () => {
  const lin = {
    id: 'lin',
    name: '林夏',
    kind: 'human',
    role: '复核',
    capabilities: [],
    instructions: '',
    available: true,
  };
  const design = workflowNode({
    id: 'design',
    title: '设计登录',
    reviewerIds: ['lin'],
    reviewRequired: true,
  });
  const detail = workflowNode({ id: 'detail', title: '细化接口' });
  const { state, applied } = confirm([design, detail], [lin]);
  const { service, store } = create(state);
  await start(service, applied);
  state.tasks[0].workflows = [
    { id: 'root', name: '登录工作流', parentNodeId: null, nodes: [design] },
    { id: 'child', name: '细化', parentNodeId: 'design', nodes: [detail] },
  ];
  const open = await service.inbox(session('chen'), {});
  assert.equal(open.ok, true);
  const detailItem = open.value.items.find((item) => item.nodeId === 'detail');
  const detailPlace = open.value.places.find((place) => place.itemId === detailItem.id);
  assert.equal(detailPlace.taskPath, '客户门户 / 账号登录 / 设计登录');
  assert.equal(detailPlace.ownerName, '陈宁');
  assert.equal(detailPlace.taskPath.includes('chen'), false);
  assert.equal(detailPlace.ownerName.includes('chen'), false);
  assert.equal(Object.hasOwn(detailPlace, 'ownerId'), false);
  const before = await service.inboxCounts(session('chen'), {});
  assert.deepEqual(before.value, { actorId: 'chen', deliver: 2, review: 0, confirm: 0 });
  assert.equal(Object.hasOwn(before.value, 'spaceId'), false);

  const submitted = await service.submit(session('chen'), {
    ...locate(applied, 'design', store.node('design').command.version, 'deliver-design'),
    text: '接口说明',
  });
  assert.equal(submitted.value.disposition, 'applied');
  const afterSubmit = await service.inboxCounts(session('chen'), {});
  assert.deepEqual(afterSubmit.value, { actorId: 'chen', deliver: 1, review: 0, confirm: 0 });
  const review = await service.inboxCounts(session('lin'), {});
  assert.deepEqual(review.value, { actorId: 'lin', deliver: 0, review: 1, confirm: 0 });
  const voted = await service.ballot(session('lin'), {
    ...locate(applied, 'design', store.node('design').command.version, 'approve-design'),
    roundId: store.node('design').currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
    action: 'approve',
  });
  assert.equal(voted.ok, true, voted.ok ? '' : voted.error.code);
  const afterVote = await service.inboxCounts(session('lin'), {});
  assert.deepEqual(afterVote.value, { actorId: 'lin', deliver: 0, review: 0, confirm: 0 });
});

test('an expert node waiting on its owner is a delivery count, not a review count', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计', assigneeId: 'qa' }),
  ]);
  const { service, store } = create(state);
  await start(service, applied);
  const record = store.node('design');
  assert.equal(record.handoff.assignee.kind, 'expert');
  await store.storage.writeNode(nodeRecordKey(record), {
    ...record,
    command: { ...record.command, status: 'waiting-for-input' },
  });
  const inbox = await service.inbox(session('chen'), {});
  assert.equal(inbox.value.items.length, 1);
  assert.equal(inbox.value.items[0].kind, 'deliver');
  assert.equal(inbox.value.items[0].reason, 'owner-input-required');
  const counts = await service.inboxCounts(session('chen'), {});
  assert.deepEqual(counts.value, { actorId: 'chen', deliver: 1, review: 0, confirm: 0 });
});

test('a hidden node does not change counts or groups, and a down directory is the same either way', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const { service, store } = create(state);
  await start(service, applied);
  const visible = JSON.stringify(await service.inbox(session('chen'), {}));
  const counted = JSON.stringify(await service.inboxCounts(session('chen'), {}));
  const hiddenTask = {
    ...state.tasks[0],
    id: 'secret-task',
    title: '秘密任务',
    ownerId: 'lin',
    participantIds: ['lin'],
  };
  state.tasks.push(hiddenTask);
  const hidden = structuredClone(store.node('design'));
  hidden.taskId = 'secret-task';
  hidden.nodeId = 'secret-node';
  hidden.planId = 'secret-plan';
  await store.storage.writeNode(nodeRecordKey(hidden), hidden);
  await store.storage.writePlan('secret-task:secret-plan:1', {
    idempotencyKey: 'secret-start',
    fingerprint: 'secret',
    nodeIds: ['secret-node'],
  });
  assert.equal(JSON.stringify(await service.inbox(session('chen'), {})), visible);
  assert.equal(JSON.stringify(await service.inboxCounts(session('chen'), {})), counted);
  assert.equal(visible.includes('secret-node'), false);
  assert.equal(visible.includes('秘密任务'), false);

  const down = {
    async spaceForProject() {
      throw new Error('space-down-4e1');
    },
  };
  const absent = create(state, down);
  const present = create(state, down);
  const designRecord = store.node('design');
  await present.store.storage.writeNode(nodeRecordKey(designRecord), designRecord);
  await present.store.storage.writePlan(
    `${designRecord.taskId}:${designRecord.planId}:${designRecord.revision}`,
    store.storage.readPlan(
      `${designRecord.taskId}:${designRecord.planId}:${designRecord.revision}`,
    ),
  );
  const absentCounts = await absent.service.inboxCounts(session('chen'), {});
  const presentCounts = await present.service.inboxCounts(session('chen'), {});
  const absentInbox = await absent.service.inbox(session('chen'), {});
  const presentInbox = await present.service.inbox(session('chen'), {});
  assert.equal(
    Buffer.compare(
      Buffer.from(JSON.stringify(absentCounts)),
      Buffer.from(JSON.stringify(presentCounts)),
    ),
    0,
  );
  assert.equal(
    Buffer.compare(
      Buffer.from(JSON.stringify(absentInbox)),
      Buffer.from(JSON.stringify(presentInbox)),
    ),
    0,
  );
  assert.equal(absentCounts.error.code, 'unavailable');
  assert.equal(absentCounts.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(absentCounts).includes('space-down-4e1'), false);
  assert.equal(JSON.stringify(absentCounts).includes('deliver'), false);
  assert.equal(JSON.stringify(presentCounts).includes('design'), false);

  const bare = new ExecutionService(memory().storage, { readWorkbench: () => state }, undefined);
  const missingCounts = await bare.inboxCounts(session('chen'), {});
  const missingInbox = await bare.inbox(session('chen'), {});
  assert.deepEqual(missingCounts, missingInbox);
  assert.equal(missingCounts.error.code, 'not-found');
  assert.equal(missingCounts.error.message, '找不到这个节点。');
  assert.equal(JSON.stringify(missingCounts).includes('deliver'), false);
});

test('counts echo the member and the requested scope, and an empty echo is not a grant', async () => {
  const { state, task } = fixture();
  state.projects.push({ id: 'project2', name: '数据平台', description: '内部数据平台' });
  const northReady = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      title: '北空间任务',
      participantIds: ['chen'],
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const ready = applyWorkbenchCommand(northReady, {
    type: 'save-task',
    task: {
      ...task,
      id: 'task-south',
      projectId: 'project2',
      title: '南空间任务',
      participantIds: ['chen'],
      workflows: [
        {
          ...task.workflows[0],
          id: 'root-south',
          nodes: [workflowNode({ id: 'build', title: '构建' })],
        },
      ],
      status: 'ready',
    },
  });
  const spaces = boundedProjectSpaces([
    { projectId: 'project', spaceId: 'north' },
    { projectId: 'project2', spaceId: 'south' },
  ]);
  const { service, store } = create(ready, spaces);
  const chen = session('chen', ['north', 'south']);
  for (const applied of ready.appliedPlans) {
    const started = await service.startPlan(chen, {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: `start-${applied.taskId}`,
    });
    assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  }
  const north = await service.inboxCounts(chen, { spaceId: 'north' });
  assert.deepEqual(north.value, {
    actorId: 'chen',
    spaceId: 'north',
    deliver: 1,
    review: 0,
    confirm: 0,
  });
  const south = await service.inboxCounts(chen, { spaceId: 'south' });
  assert.deepEqual(south.value, {
    actorId: 'chen',
    spaceId: 'south',
    deliver: 1,
    review: 0,
    confirm: 0,
  });
  const all = await service.inboxCounts(chen, {});
  assert.deepEqual(all.value, { actorId: 'chen', deliver: 2, review: 0, confirm: 0 });
  assert.equal(Object.hasOwn(all.value, 'spaceId'), false);

  const stored = JSON.stringify(store.storage.listNodes());
  const ghost = await service.inboxCounts(chen, { spaceId: 'ghost' });
  assert.deepEqual(ghost.value, {
    actorId: 'chen',
    spaceId: 'ghost',
    deliver: 0,
    review: 0,
    confirm: 0,
  });
  const revoked = await service.inboxCounts(session('chen', ['south']), { spaceId: 'north' });
  assert.deepEqual(revoked.value, {
    actorId: 'chen',
    spaceId: 'north',
    deliver: 0,
    review: 0,
    confirm: 0,
  });
  assert.equal(JSON.stringify(ghost).includes('design'), false);
  assert.equal(JSON.stringify(revoked).includes('build'), false);
  assert.equal(JSON.stringify(store.storage.listNodes()), stored);
});
