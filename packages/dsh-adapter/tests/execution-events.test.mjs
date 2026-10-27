import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const projectSpaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);
const SECRET_PATH = 'https://files.example/secret-path-9f3e';

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

function counting(inner) {
  let touches = 0;
  const hit = (read) => {
    touches += 1;
    return read();
  };
  return {
    touches: () => touches,
    storage: {
      readNode: (key) => hit(() => inner.readNode(key)),
      writeNode: (key, value) => hit(() => inner.writeNode(key, value)),
      listNodes: () => hit(() => inner.listNodes()),
      readPlan: (key) => hit(() => inner.readPlan(key)),
      writePlan: (key, value) => hit(() => inner.writePlan(key, value)),
      listPlans: () => hit(() => inner.listPlans()),
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

function session(memberId, spaceIds = ['project']) {
  return { member: { ok: true, memberId, spaceIds } };
}

test('accepted commands append monotonic events and a cursor can dedupe them', async () => {
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
  const publish = workflowNode({ id: 'publish', title: '发布', dependsOn: ['design'] });
  const { state, applied } = confirm([design, publish], [lin]);
  const { service, store } = create(state);
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const submitBody = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    expectedVersion: store.node('design').command.version,
    idempotencyKey: 'deliver-design',
    text: '接口说明',
    links: [SECRET_PATH],
  };
  const submitted = await service.submit(session('chen'), submitBody);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.value.disposition, 'applied');
  const replayed = await service.submit(session('chen'), submitBody);
  assert.equal(replayed.value.disposition, 'replayed');
  const voted = await service.ballot(session('lin'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    expectedVersion: store.node('design').command.version,
    idempotencyKey: 'approve-design',
    roundId: store.node('design').currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
    action: 'approve',
  });
  assert.equal(voted.ok, true, voted.ok ? '' : voted.error.code);

  const pull = (nodeId, after, seenEventIds) =>
    service.events(session('chen'), {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      nodeId,
      after,
      ...(seenEventIds === undefined ? {} : { seenEventIds }),
    });
  const designEvents = await pull('design', 0);
  assert.equal(designEvents.ok, true);
  assert.equal(designEvents.value.actorId, 'chen');
  assert.equal(Object.hasOwn(designEvents.value, 'spaceId'), false);
  assert.equal(designEvents.value.taskId, applied.taskId);
  assert.equal(designEvents.value.planId, applied.id);
  assert.equal(designEvents.value.revision, applied.revision);
  assert.equal(designEvents.value.nodeId, 'design');
  assert.deepEqual(
    designEvents.value.events.map((event) => event.type),
    ['node-started', 'delivery-submitted', 'ballot-recorded'],
  );
  assert.deepEqual(
    designEvents.value.events.map((event) => event.sequence),
    [1, 2, 3],
  );
  const stored = JSON.stringify(store.node('design').events);
  assert.equal(stored.includes(SECRET_PATH), false);
  assert.equal(JSON.stringify(designEvents.value).includes(SECRET_PATH), false);
  const page = await pull('design', 1);
  assert.deepEqual(
    page.value.events.map((event) => event.sequence),
    [2, 3],
  );
  const seen = await pull('design', 0, [designEvents.value.events[1].eventId]);
  assert.deepEqual(
    seen.value.events.map((event) => event.eventId),
    [designEvents.value.events[0].eventId, designEvents.value.events[2].eventId],
  );
  const downstream = await pull('publish', 0);
  assert.deepEqual(
    downstream.value.events.map((event) => [event.sequence, event.type, event.status]),
    [
      [1, 'node-started', 'blocked'],
      [2, 'downstream-unlocked', 'ready'],
    ],
  );
});

test('a bad cursor never touches storage, and hidden nodes match a missing node', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const inner = memory();
  const counted = counting(inner.storage);
  const service = new ExecutionService(
    counted.storage,
    { readWorkbench: () => state },
    projectSpaces,
  );
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const body = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
  };
  for (const after of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const mark = counted.touches();
    const rejected = await service.events(session('chen'), { ...body, after });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'validation');
    assert.equal(rejected.error.message, '提交的数据格式不正确。');
    assert.equal(counted.touches(), mark);
    assert.equal(JSON.stringify(rejected).includes('sequence'), false);
  }
  const wide = await service.events(session('chen'), {
    ...body,
    after: 0,
    seenEventIds: ['x'.repeat(201)],
  });
  assert.equal(wide.error.code, 'validation');

  const missing = await service.events(session('chen'), {
    ...body,
    after: 0,
    nodeId: 'missing-node',
  });
  const hidden = await service.events(session('outside'), { ...body, after: 0 });
  assert.equal(
    Buffer.compare(Buffer.from(JSON.stringify(missing)), Buffer.from(JSON.stringify(hidden))),
    0,
  );
  assert.equal(missing.error.code, 'not-found');
  assert.equal(missing.error.message, '找不到这个节点。');
  assert.equal(JSON.stringify(missing).includes('sequence'), false);
  assert.equal(JSON.stringify(missing).includes('evt:'), false);

  const down = {
    async spaceForProject() {
      throw new Error('space-down-4e1');
    },
  };
  const absent = new ExecutionService(memory().storage, { readWorkbench: () => state }, down);
  const presentStore = memory();
  const designRecord = inner.node('design');
  await presentStore.storage.writeNode(
    `${designRecord.taskId}:${designRecord.planId}:${designRecord.revision}:${designRecord.nodeId}`,
    designRecord,
  );
  await presentStore.storage.writePlan(
    `${designRecord.taskId}:${designRecord.planId}:${designRecord.revision}`,
    inner.storage.readPlan(
      `${designRecord.taskId}:${designRecord.planId}:${designRecord.revision}`,
    ),
  );
  const present = new ExecutionService(presentStore.storage, { readWorkbench: () => state }, down);
  const absentEvents = await absent.events(session('chen'), { ...body, after: 0 });
  const presentEvents = await present.events(session('chen'), { ...body, after: 0 });
  assert.equal(
    Buffer.compare(
      Buffer.from(JSON.stringify(absentEvents)),
      Buffer.from(JSON.stringify(presentEvents)),
    ),
    0,
  );
  assert.equal(absentEvents.error.code, 'unavailable');
  assert.equal(absentEvents.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(absentEvents).includes('sequence'), false);
  assert.equal(JSON.stringify(absentEvents).includes('space-down-4e1'), false);
  assert.equal(JSON.stringify(presentEvents).includes('evt:'), false);
});

test('one command is stored once, the unlock names the owner, and seen ids stop at 200', async () => {
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
  const publish = workflowNode({ id: 'publish', title: '发布', dependsOn: ['design'] });
  const { state, applied } = confirm([design, publish], [lin]);
  const inner = memory();
  let writes = 0;
  const storage = {
    ...inner.storage,
    writeNode: async (key, value) => {
      writes += 1;
      return inner.storage.writeNode(key, value);
    },
  };
  const service = new ExecutionService(storage, { readWorkbench: () => state }, projectSpaces);
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  writes = 0;
  const submitted = await service.submit(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    expectedVersion: inner.node('design').command.version,
    idempotencyKey: 'deliver-design',
    text: '接口说明',
    links: [SECRET_PATH],
  });
  assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.code);
  assert.equal(writes, 1);
  for (const event of inner.node('design').events) {
    assert.deepEqual(Object.keys(event.payload).sort(), ['status', 'version']);
  }
  const voted = await service.ballot(session('lin'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    expectedVersion: inner.node('design').command.version,
    idempotencyKey: 'approve-design',
    roundId: inner.node('design').currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
    action: 'approve',
  });
  assert.equal(voted.ok, true, voted.ok ? '' : voted.error.code);
  const unlocked = inner
    .node('publish')
    .events.find((event) => event.type === 'downstream-unlocked');
  assert.equal(unlocked.actorId, 'chen');
  const body = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    after: 0,
  };
  const ids = (count) => Array.from({ length: count }, (_, index) => `seen-${index}`);
  const exact = await service.events(session('chen'), { ...body, seenEventIds: ids(200) });
  assert.equal(exact.ok, true, exact.ok ? '' : exact.error.code);
  const over = await service.events(session('chen'), { ...body, seenEventIds: ids(201) });
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'validation');
});

function create(state, spaces = projectSpaces) {
  const store = memory();
  const service = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  return { service, store };
}

test('events check the requested space before reading, and a stale cursor stays with its node', async () => {
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
          nodes: [workflowNode({ id: 'design', title: '设计' })],
        },
      ],
      status: 'ready',
    },
  });
  const spaces = boundedProjectSpaces([
    { projectId: 'project', spaceId: 'north' },
    { projectId: 'project2', spaceId: 'south' },
  ]);
  const inner = memory();
  let writes = 0;
  const storage = {
    ...inner.storage,
    writeNode: async (key, value) => {
      writes += 1;
      return inner.storage.writeNode(key, value);
    },
    writePlan: async (key, value) => {
      writes += 1;
      return inner.storage.writePlan(key, value);
    },
  };
  const service = new ExecutionService(storage, { readWorkbench: () => ready }, spaces);
  const chen = session('chen', ['north', 'south']);
  const northPlan = ready.appliedPlans.find((plan) => plan.taskId === 'task');
  const southPlan = ready.appliedPlans.find((plan) => plan.taskId === 'task-south');
  for (const [applied, idempotencyKey] of [
    [northPlan, 'start-north'],
    [southPlan, 'start-south'],
  ]) {
    const started = await service.startPlan(chen, {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey,
    });
    assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  }
  const locate = (applied) => ({
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    after: 0,
  });
  const north = await service.events(chen, { ...locate(northPlan), spaceId: 'north' });
  assert.equal(north.ok, true, north.ok ? '' : north.error.code);
  assert.equal(north.value.actorId, 'chen');
  assert.equal(north.value.spaceId, 'north');
  assert.equal(north.value.taskId, 'task');
  assert.equal(north.value.planId, northPlan.id);
  assert.equal(north.value.revision, northPlan.revision);
  assert.equal(north.value.nodeId, 'design');
  assert.deepEqual(
    north.value.events.map((event) => event.type),
    ['node-started'],
  );
  const south = await service.events(chen, { ...locate(southPlan), spaceId: 'south' });
  assert.equal(south.ok, true, south.ok ? '' : south.error.code);
  assert.equal(south.value.actorId, 'chen');
  assert.equal(south.value.spaceId, 'south');
  assert.equal(south.value.taskId, 'task-south');
  assert.equal(south.value.nodeId, 'design');
  assert.equal(north.value.events[0].eventId, south.value.events[0].eventId);

  const mark = writes;
  const wrong = await service.events(chen, { ...locate(northPlan), spaceId: 'south' });
  const missing = await service.events(chen, {
    ...locate(northPlan),
    nodeId: 'missing-node',
    spaceId: 'north',
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'not-found');
  assert.equal(JSON.stringify(wrong), JSON.stringify(missing));
  assert.equal(JSON.stringify(wrong).includes('evt:'), false);
  assert.equal(JSON.stringify(wrong).includes('sequence'), false);
  const revoked = await service.events(session('chen', ['north']), {
    ...locate(southPlan),
    spaceId: 'south',
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error.code, 'not-found');
  const down = {
    async spaceForProject() {
      throw new Error('space-down-4e1');
    },
  };
  const broken = new ExecutionService(storage, { readWorkbench: () => ready }, down);
  const unavailable = await broken.events(chen, { ...locate(northPlan), spaceId: 'north' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, 'unavailable');
  assert.equal(unavailable.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(unavailable).includes('space-down-4e1'), false);
  assert.equal(JSON.stringify(unavailable).includes('evt:'), false);
  assert.equal(writes, mark);

  const switched = await service.events(chen, {
    ...locate(southPlan),
    spaceId: 'south',
    seenEventIds: [north.value.events[0].eventId],
  });
  assert.equal(switched.ok, true, switched.ok ? '' : switched.error.code);
  assert.equal(switched.value.actorId, 'chen');
  assert.equal(switched.value.spaceId, 'south');
  assert.equal(switched.value.taskId, 'task-south');
  assert.equal(switched.value.planId, southPlan.id);
  assert.equal(switched.value.nodeId, 'design');
  assert.deepEqual(switched.value.events, []);
  const fresh = await service.events(chen, { ...locate(southPlan), spaceId: 'south' });
  assert.equal(fresh.value.events.length, 1);
  assert.equal(fresh.value.events[0].eventId, south.value.events[0].eventId);

  const unscoped = await service.events(chen, locate(northPlan));
  assert.equal(unscoped.ok, true, unscoped.ok ? '' : unscoped.error.code);
  assert.equal(Object.hasOwn(unscoped.value, 'spaceId'), false);
  assert.equal(unscoped.value.actorId, 'chen');
  assert.equal(unscoped.value.taskId, 'task');
  assert.equal(unscoped.value.nodeId, 'design');
  assert.equal(unscoped.value.events.length, 1);
});
