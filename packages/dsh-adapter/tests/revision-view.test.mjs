import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand, nodeRecordKey } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { readRevisionView } from '../dist/revision-view.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
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

function record() {
  return {
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'design',
    ownerId: 'chen',
    handoff: {
      assignee: { id: 'chen', kind: 'human' },
      reviewerIds: ['lin'],
      goal: '设计登录接口',
      expectedOutput: '接口说明',
    },
    command: { status: 'needs-revision', version: 3 },
    currentRoundId: 'round-1',
    rounds: [
      {
        id: 'round-1',
        status: 'changes-requested',
        artifactVersionId: 'artifact-2',
        reviewerIds: ['lin', 'gone'],
        ballots: [
          {
            reviewerId: 'lin',
            roundId: 'round-1',
            artifactVersionId: 'artifact-2',
            action: 'request-changes',
            comment: '请补充错误码',
            unresolvedCommentIds: ['c-1', 'missing'],
          },
          {
            reviewerId: 'lin',
            roundId: 'round-1',
            artifactVersionId: 'artifact-2',
            action: 'approve',
            comment: 'approve-note-4e1',
          },
        ],
      },
    ],
    artifactVersions: [
      {
        id: 'artifact-1',
        nodeId: 'design',
        version: 1,
        text: '第一版说明',
        files: [],
        links: [],
        submittedBy: 'chen',
      },
      {
        id: 'artifact-2',
        nodeId: 'design',
        version: 2,
        text: '错误码还没写',
        files: [
          {
            id: 'spec',
            mediaType: 'text/plain',
            byteSize: 12,
            checksum: 'checksum-do-not-leak',
            accessPolicyId: 'task-read',
            uploadComplete: true,
          },
        ],
        links: ['https://example.test/spec'],
        submittedBy: 'chen',
      },
    ],
    comments: [{ id: 'c-1', status: 'open', versionId: 'artifact-2', targetId: 'artifact-2' }],
    receipts: [],
  };
}

test('readRevisionView shows the reviewed version, return notes, and the previous version to the assignee', () => {
  const view = readRevisionView(record(), 'chen', { lin: '林夏' });
  assert.equal(view.ok, true);
  assert.equal(view.view.reviewed.text, '错误码还没写');
  assert.equal(view.view.reviewed.version, 2);
  assert.equal(view.view.reviewed.files[0].id, 'spec');
  assert.equal(view.view.reviewed.files[0].byteSize, 12);
  assert.equal('checksum' in view.view.reviewed.files[0], false);
  assert.equal(view.view.reviewed.links[0], 'https://example.test/spec');
  assert.equal(view.view.previous.text, '第一版说明');
  assert.equal(view.view.notes.length, 1);
  assert.equal(view.view.notes[0].id, 'return-round-1-0');
  assert.equal(view.view.notes[0].reviewerName, '林夏');
  assert.equal(view.view.notes[0].body, '请补充错误码');
  assert.deepEqual(view.view.notes[0].citedCommentIds, ['c-1']);
  assert.equal(view.view.notes[0].artifactVersionId, 'artifact-2');
  assert.equal(JSON.stringify(view.view).includes('checksum-do-not-leak'), false);
  assert.equal(JSON.stringify(view.view.notes).includes('approve-note-4e1'), false);
  assert.equal(JSON.stringify(view.view.notes).includes('lin'), false);
});

test('a second return keeps the first round notes under reviewer names', () => {
  const node = record();
  node.currentRoundId = 'round-2';
  node.handoff.reviewerIds = ['lin'];
  node.rounds = [
    {
      id: 'round-1',
      status: 'changes-requested',
      artifactVersionId: 'artifact-1',
      reviewerIds: ['qiu'],
      ballots: [
        {
          reviewerId: 'qiu',
          roundId: 'round-1',
          artifactVersionId: 'artifact-1',
          action: 'request-changes',
          comment: '第一轮意见-4e1',
        },
      ],
    },
    {
      id: 'round-2',
      status: 'changes-requested',
      artifactVersionId: 'artifact-2',
      reviewerIds: ['lin'],
      ballots: [
        {
          reviewerId: 'lin',
          roundId: 'round-2',
          artifactVersionId: 'artifact-2',
          action: 'request-changes',
          comment: '第二轮意见-4e1',
        },
      ],
    },
  ];
  const names = { lin: '林夏', qiu: '邱明' };
  const view = readRevisionView(node, 'chen', names);
  assert.equal(view.ok, true);
  assert.deepEqual(
    view.view.notes.map((note) => note.body),
    ['第一轮意见-4e1', '第二轮意见-4e1'],
  );
  assert.deepEqual(
    view.view.notes.map((note) => note.reviewerName),
    ['邱明', '林夏'],
  );
  assert.equal(view.view.reviewed.text, '错误码还没写');
  assert.equal(JSON.stringify(view.view.notes).includes('qiu'), false);
  assert.equal(JSON.stringify(view.view.notes).includes('lin'), false);
  node.handoff.reviewerIds = ['lin', 'qiu'];
  assert.equal(readRevisionView(node, 'qiu', names).code, 'not-found');
  assert.equal(readRevisionView(node, 'lin', names).view.notes[0].body, '第一轮意见-4e1');
});

test('readRevisionView allows a current reviewer and refuses a removed reviewer', () => {
  assert.equal(readRevisionView(record(), 'lin').ok, true);
  const removed = record();
  removed.handoff.reviewerIds = [];
  assert.equal(readRevisionView(removed, 'lin').code, 'not-found');
  assert.equal(readRevisionView(record(), 'gone').code, 'not-found');
  const otherRound = record();
  otherRound.handoff.reviewerIds = ['lin', 'qa'];
  assert.equal(readRevisionView(otherRound, 'qa').code, 'not-found');
  const quiet = record();
  quiet.rounds = [];
  quiet.currentRoundId = undefined;
  assert.equal(readRevisionView(quiet, 'chen').code, 'not-returned');
  assert.equal(readRevisionView(quiet, 'outsider').code, 'not-found');
});

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
    node: (id) => [...nodes.values()].find((item) => item.nodeId === id),
  };
}

function confirm() {
  const { state, task } = fixture();
  state.participants.push(lin);
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'lin', 'outside'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            {
              ...task.workflows[0].nodes[0],
              id: 'design',
              assigneeId: 'chen',
              reviewerIds: ['lin'],
              reviewRequired: true,
              dependsOn: [],
            },
          ],
        },
      ],
      status: 'ready',
    },
  });
  return { state: ready, applied: ready.appliedPlans.at(-1) };
}

function session(memberId, spaceIds = ['project']) {
  return { member: { ok: true, memberId, spaceIds } };
}

test('revision refuses people outside the space and removed participants', async () => {
  const { state, applied } = confirm();
  const store = memory();
  const spaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);
  const service = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  const locate = (version, key) => ({
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    expectedVersion: version,
    idempotencyKey: key,
  });
  assert.equal((await service.revision({}, locate(1, 'ignored'))).error.code, 'unauthenticated');
  assert.equal(
    (await service.revision(session('chen'), { ...locate(1, 'ignored'), actorId: 'lin' })).error
      .code,
    'actor-from-body',
  );
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const submitted = await service.submit(session('chen'), {
    ...locate(1, 'deliver-1'),
    text: '初稿',
  });
  assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.code);
  const roundId = submitted.value.node.currentRoundId;
  const artifactVersionId = submitted.value.node.artifacts.at(-1).id;
  const sent = await service.ballot(session('lin'), {
    ...locate(submitted.value.node.version, 'vote-back'),
    roundId,
    artifactVersionId,
    action: 'request-changes',
    comment: '请补充错误码',
  });
  assert.equal(sent.ok, true, sent.ok ? '' : sent.error.code);

  const query = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
  };
  const assignee = await service.revision(session('chen'), query);
  assert.equal(assignee.ok, true);
  assert.equal(assignee.value.view.reviewed.text, '初稿');
  assert.equal(assignee.value.view.previous, undefined);
  assert.equal(assignee.value.view.notes[0].body, '请补充错误码');
  assert.equal(JSON.stringify(assignee.value).includes('receipts'), false);
  const reviewer = await service.revision(session('lin'), query);
  assert.equal(reviewer.ok, true);
  assert.equal(reviewer.value.view.notes[0].reviewerName, '林夏');
  assert.equal(JSON.stringify(reviewer.value.view.notes).includes('lin'), false);

  assert.equal(
    (await service.revision(session('chen', ['elsewhere']), query)).error.code,
    'not-found',
  );
  const outsider = await service.revision(session('outside'), query);
  const missingNode = await service.revision(session('outside'), {
    ...query,
    nodeId: 'absent-node',
  });
  assert.equal(Buffer.compare(responseBytes(outsider), responseBytes(missingNode)), 0);
  assert.deepEqual(outsider, {
    ok: false,
    error: { code: 'not-found', message: '找不到这个节点。', details: {} },
  });
  const closed = new ExecutionService(store.storage, { readWorkbench: () => state }, undefined);
  assert.equal((await closed.revision(session('chen'), query)).error.code, 'not-found');

  state.tasks[0].participantIds = state.tasks[0].participantIds.filter((id) => id !== 'lin');
  assert.equal((await service.revision(session('lin'), query)).error.code, 'not-participant');
  state.tasks[0].participantIds.push('lin');

  const design = store.node('design');
  await store.storage.writeNode(nodeRecordKey(design), {
    ...design,
    handoff: { ...design.handoff, reviewerIds: [] },
  });
  const removedReviewer = await service.revision(session('lin'), query);
  const removedMissing = await service.revision(session('lin'), {
    ...query,
    nodeId: 'absent-node',
  });
  assert.equal(Buffer.compare(responseBytes(removedReviewer), responseBytes(removedMissing)), 0);
  assert.deepEqual(removedReviewer, {
    ok: false,
    error: { code: 'not-found', message: '找不到这个节点。', details: {} },
  });
  const still = await service.revision(session('chen'), query);
  assert.equal(still.ok, true);
  assert.equal(still.value.view.notes[0].body, '请补充错误码');
});

function responseBytes(value) {
  return Buffer.from(JSON.stringify(value));
}

test('an illegal directory answer is the same unavailable bytes whether or not the task exists', async () => {
  const shapes = [{ ok: true, spaceId: '' }, { ok: true }, { ok: 'yes', spaceId: 5 }];
  const query = { planId: 'plan', revision: 1, nodeId: 'design' };
  for (const shape of shapes) {
    const { state } = confirm();
    const store = memory();
    await store.storage.writeNode('task:plan:1:design', { nodeId: 'design', broken: true });
    const before = JSON.stringify(store.storage.listNodes());
    const directory = {
      async spaceForProject() {
        return shape;
      },
    };
    const service = new ExecutionService(store.storage, { readWorkbench: () => state }, directory);
    const missing = await service.revision(session('chen', ['elsewhere']), {
      ...query,
      taskId: 'absent-task',
    });
    const present = await service.revision(session('chen', ['elsewhere']), {
      ...query,
      taskId: 'task',
    });
    assert.equal(Buffer.compare(responseBytes(missing), responseBytes(present)), 0);
    assert.deepEqual(missing, {
      ok: false,
      error: {
        code: 'unavailable',
        message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
        details: {},
      },
    });
    assert.equal(JSON.stringify(missing).includes('absent-task'), false);
    assert.equal(JSON.stringify(missing).includes('broken'), false);
    assert.equal(JSON.stringify(store.storage.listNodes()), before);
  }
});

test('revision returns the same unavailable bytes when the directory is down', async () => {
  const { state } = confirm();
  const query = { taskId: 'task', planId: 'plan', revision: 1, nodeId: 'design' };
  const down = {
    async spaceForProject() {
      throw new Error('space-down-4e1');
    },
  };
  const ask = (store) =>
    new ExecutionService(store.storage, { readWorkbench: () => state }, down).revision(
      session('chen'),
      query,
    );
  const absent = await ask(memory());
  const store = memory();
  const node = record();
  node.handoff.dependencyNodeIds = [];
  await store.storage.writeNode(nodeRecordKey(node), node);
  const present = await ask(store);
  assert.equal(Buffer.compare(responseBytes(absent), responseBytes(present)), 0);
  assert.deepEqual(absent.error, {
    code: 'unavailable',
    message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
    details: {},
  });
  assert.equal(JSON.stringify(present).includes('space-down-4e1'), false);
  assert.equal(JSON.stringify(present).includes('design'), false);
});

test('revision returns the same unavailable bytes for the applied plan when the directory is down', async () => {
  const { state, applied } = confirm();
  const query = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
  };
  const down = {
    async spaceForProject() {
      throw new Error('space-down-4e1');
    },
  };
  const ask = (store) =>
    new ExecutionService(store.storage, { readWorkbench: () => state }, down).revision(
      session('chen'),
      query,
    );
  const absent = await ask(memory());
  const store = memory();
  const node = record();
  node.taskId = applied.taskId;
  node.planId = applied.id;
  node.revision = applied.revision;
  node.handoff.dependencyNodeIds = [];
  await store.storage.writeNode(nodeRecordKey(node), node);
  const present = await ask(store);
  assert.equal(Buffer.compare(responseBytes(absent), responseBytes(present)), 0);
  assert.deepEqual(absent.error, {
    code: 'unavailable',
    message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
    details: {},
  });
  assert.equal(JSON.stringify(present).includes('space-down-4e1'), false);
  assert.equal(JSON.stringify(present).includes('design'), false);
});

test('revision returns the same not-found bytes for a missing node and another space', async () => {
  const { state } = confirm();
  const spaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);
  const query = { taskId: 'task', planId: 'plan', revision: 1, nodeId: 'design' };
  const ask = (store, spaceIds) =>
    new ExecutionService(store.storage, { readWorkbench: () => state }, spaces).revision(
      session('chen', spaceIds),
      query,
    );
  const absent = await ask(memory(), ['project']);
  const store = memory();
  const node = record();
  node.handoff.dependencyNodeIds = [];
  await store.storage.writeNode(nodeRecordKey(node), node);
  const hidden = await ask(store, ['elsewhere']);
  assert.equal(Buffer.compare(responseBytes(absent), responseBytes(hidden)), 0);
  assert.deepEqual(absent.error, {
    code: 'not-found',
    message: '找不到这个节点。',
    details: {},
  });
});

test('revision returns the same not-found bytes when the task is missing or in another space', async () => {
  const { state } = confirm();
  const spaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);
  const store = memory();
  const node = record();
  node.handoff.dependencyNodeIds = [];
  await store.storage.writeNode(nodeRecordKey(node), node);
  await store.storage.writePlan('task:plan:1', {
    idempotencyKey: 'plan-key',
    fingerprint: 'plan',
    nodeIds: ['design'],
  });
  const service = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  const caller = session('chen', ['elsewhere']);
  const ask = (taskId) =>
    service.revision(caller, { taskId, planId: 'plan', revision: 1, nodeId: 'design' });
  const hidden = await ask('task');
  const missing = await ask('absent-task');
  assert.equal(Buffer.compare(responseBytes(hidden), responseBytes(missing)), 0);
  assert.deepEqual(hidden, {
    ok: false,
    error: { code: 'not-found', message: '找不到这个节点。', details: {} },
  });
  assert.equal(JSON.stringify(hidden).includes('错误码还没写'), false);
  assert.equal(JSON.stringify(hidden).includes('absent-task'), false);
});

test('submit asks the directory before reading the node, for every illegal answer', async () => {
  const { state, applied } = confirm();
  const store = memory();
  const spaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);
  const opened = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  const started = await opened.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const intact = store.node('design');
  const key = nodeRecordKey(intact);
  const shapes = [
    { throw: true },
    { ok: false, reason: 'unavailable' },
    null,
    'nope',
    { ok: false, reason: 'later' },
    { ok: true, spaceId: '' },
    { ok: true },
    { ok: 'yes', spaceId: 5 },
  ];
  const body = (nodeId) => ({
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId,
    expectedVersion: 1,
    idempotencyKey: 'submit-down',
    text: '写不了-4e1',
  });
  for (const shape of shapes) {
    const directory = {
      async spaceForProject() {
        if (shape.throw) throw new Error('space-down-4e1');
        return shape;
      },
    };
    const service = new ExecutionService(store.storage, { readWorkbench: () => state }, directory);
    const before = JSON.stringify(store.storage.listNodes());
    const present = await service.submit(session('chen'), body('design'));
    assert.equal(JSON.stringify(store.storage.listNodes()), before);
    const absent = await service.submit(session('chen'), body('absent-node'));
    assert.equal(JSON.stringify(store.storage.listNodes()), before);
    const broken = structuredClone(intact);
    delete broken.handoff.reviewerIds;
    await store.storage.writeNode(key, broken);
    const damagedBefore = JSON.stringify(store.storage.listNodes());
    const damaged = await service.submit(session('chen'), body('design'));
    assert.equal(JSON.stringify(store.storage.listNodes()), damagedBefore);
    await store.storage.writeNode(key, intact);
    assert.equal(Buffer.compare(responseBytes(present), responseBytes(absent)), 0);
    assert.equal(Buffer.compare(responseBytes(present), responseBytes(damaged)), 0);
    assert.deepEqual(present, {
      ok: false,
      error: {
        code: 'unavailable',
        message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
        details: {},
      },
    });
    assert.equal(JSON.stringify(present).includes('space-down-4e1'), false);
    assert.equal(JSON.stringify(present).includes('写不了-4e1'), false);
    assert.equal(JSON.stringify(present).includes('absent-node'), false);
  }
});

test('ballot and settle ask the directory before reading the node, for every illegal answer', async () => {
  const { state, applied } = confirm();
  const store = memory();
  const spaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);
  const opened = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  const started = await opened.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-ballot-dir',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const intact = store.node('design');
  const key = nodeRecordKey(intact);
  const shapes = [
    { throw: true },
    { ok: false, reason: 'unavailable' },
    null,
    'nope',
    { ok: false, reason: 'later' },
    { ok: true, spaceId: '' },
    { ok: true },
    { ok: 'yes', spaceId: 5 },
  ];
  const locate = (nodeId) => ({
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId,
    expectedVersion: 1,
    roundId: 'round-down',
    artifactVersionId: 'artifact-down',
  });
  for (const shape of shapes) {
    const directory = {
      async spaceForProject() {
        if (shape.throw) throw new Error('space-down-4e1');
        return shape;
      },
    };
    const service = new ExecutionService(store.storage, { readWorkbench: () => state }, directory);
    const before = JSON.stringify(store.storage.listNodes());
    const ballotPresent = await service.ballot(session('chen'), {
      ...locate('design'),
      idempotencyKey: 'ballot-down',
      action: 'approve',
    });
    const ballotAbsent = await service.ballot(session('chen'), {
      ...locate('absent-node'),
      idempotencyKey: 'ballot-down',
      action: 'approve',
    });
    const settlePresent = await service.settle(session('chen'), {
      ...locate('design'),
      idempotencyKey: 'settle-down',
    });
    const settleAbsent = await service.settle(session('chen'), {
      ...locate('absent-node'),
      idempotencyKey: 'settle-down',
    });
    assert.equal(JSON.stringify(store.storage.listNodes()), before);
    const broken = structuredClone(intact);
    delete broken.handoff.reviewerIds;
    await store.storage.writeNode(key, broken);
    const damagedBefore = JSON.stringify(store.storage.listNodes());
    const ballotDamaged = await service.ballot(session('chen'), {
      ...locate('design'),
      idempotencyKey: 'ballot-down',
      action: 'approve',
    });
    const settleDamaged = await service.settle(session('chen'), {
      ...locate('design'),
      idempotencyKey: 'settle-down',
    });
    assert.equal(JSON.stringify(store.storage.listNodes()), damagedBefore);
    await store.storage.writeNode(key, intact);
    for (const [label, present, absent, damaged] of [
      ['ballot', ballotPresent, ballotAbsent, ballotDamaged],
      ['settle', settlePresent, settleAbsent, settleDamaged],
    ]) {
      assert.equal(Buffer.compare(responseBytes(present), responseBytes(absent)), 0, label);
      assert.equal(Buffer.compare(responseBytes(present), responseBytes(damaged)), 0, label);
      assert.deepEqual(present, {
        ok: false,
        error: {
          code: 'unavailable',
          message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
          details: {},
        },
      });
      assert.equal(JSON.stringify(present).includes('space-down-4e1'), false);
      assert.equal(JSON.stringify(present).includes('absent-node'), false);
    }
  }
});
