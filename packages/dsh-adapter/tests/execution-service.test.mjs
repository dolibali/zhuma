import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand, nodeRecordKey } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const missingTaskId = '11111111-1111-4111-8111-111111111111';

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
    // `writes` counts puts, so storing an unchanged record still changes the snapshot.
    snapshot() {
      return structuredClone({
        nodes: [...nodes.entries()],
        plans: [...plans.entries()],
        writes,
      });
    },
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

const projectSpaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);

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
  const inbox = await service.inbox({}, {});
  assert.equal(inbox.ok, false);
  assert.equal(inbox.error.code, 'unauthenticated');
  assert.equal((await service.inbox({ kind: 'owner' }, {})).error.code, 'unauthenticated');

  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
    actorId: 'outside',
  });
  assert.equal(started.error.code, 'actor-from-body');
  assert.equal(
    (await service.inbox(session('chen'), { nested: { memberId: 'lin' } })).error.code,
    'actor-from-body',
  );
  assert.equal((await service.inbox(session('outside'), {})).value.actorId, 'outside');
  assert.equal((await service.inbox(session('ghost'), {})).error.code, 'not-in-directory');
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
  assert.equal(failed.error.message, '执行记录暂时写不进去，请用同一个请求再试一次。');
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

test('a non-member and a non-participant are refused without the delivery text', async () => {
  const mallory = {
    id: 'mallory',
    name: '马洛',
    kind: 'human',
    role: '',
    capabilities: [],
    instructions: '',
    available: true,
  };
  const { state, applied } = confirm(
    [
      workflowNode({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['lin'],
      }),
    ],
    [lin, mallory],
  );
  state.tasks[0].participantIds = state.tasks[0].participantIds.filter((id) => id !== 'mallory');
  const { service, store } = create(state);
  await startChen(service, applied);
  const secret = '只有执行者能看见的说明';
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'secret-1'),
    text: secret,
  });
  assert.equal(submitted.ok, true);
  const replay = await service.submit(session('outside'), {
    ...locate(applied, 'design', 1, 'secret-1'),
    text: secret,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, 'not-participant');
  assert.equal(JSON.stringify(replay).includes(secret), false);
  assert.equal(replay.value, undefined);
  const ghost = await service.submit(session('ghost'), {
    ...locate(applied, 'design', 1, 'secret-1'),
    text: secret,
  });
  assert.equal(ghost.error.code, 'not-in-directory');
  assert.equal(JSON.stringify(ghost).includes(secret), false);

  const stolenVote = await service.ballot(session('outside'), {
    ...locate(applied, 'design', store.node('design').command.version, 'vote-lin'),
    roundId: submitted.value.node.currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
    action: 'approve',
  });
  assert.equal(stolenVote.ok, false);
  assert.equal(JSON.stringify(stolenVote).includes(secret), false);

  const ghostStart = await service.startPlan(session('ghost'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'ghost-start',
  });
  assert.equal(ghostStart.error.code, 'not-in-directory');
  const malloryReport = await service.report(session('mallory'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(malloryReport.error.code, 'not-participant');
  assert.equal(JSON.stringify(malloryReport).includes(secret), false);
  const ghostReport = await service.report(session('ghost'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(ghostReport.error.code, 'not-in-directory');
  const ghostInbox = await service.inbox(session('ghost'), {});
  assert.equal(ghostInbox.ok, false);
  const malloryInbox = await service.inbox(session('mallory'), {});
  assert.equal(malloryInbox.ok, true);
  assert.equal(malloryInbox.value.nodes.length, 0);
  const ghostSettle = await service.settle(session('ghost'), {
    ...locate(applied, 'design', store.node('design').command.version, 'ghost-settle'),
    roundId: submitted.value.node.currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
  });
  assert.equal(ghostSettle.ok, false);
  assert.equal(JSON.stringify(ghostSettle).includes(secret), false);
  const participantReport = await service.report(session('lin'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(participantReport.ok, true);
});

test('authorization, stale delivery, and a failed write leave the node unchanged', async () => {
  const { state, applied } = confirm(
    [
      workflowNode({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['lin'],
      }),
    ],
    [lin],
  );
  const { service, store } = create(state);
  await startChen(service, applied);
  const body = locate(applied, 'design', 1, 'deliver-1');
  const outsider = await service.submit(session('outside'), { ...body, text: '代交' });
  assert.equal(outsider.error.code, 'not-participant');
  const otherParticipant = await service.submit(session('lin'), { ...body, text: '代交' });
  assert.equal(otherParticipant.error.code, 'not-assignee');
  assert.equal(otherParticipant.error.details.canSubmitNode, false);
  assert.equal(store.node('design').artifactVersions.length, 0);

  const empty = await service.submit(session('chen'), { ...body, text: '   ' });
  assert.equal(empty.error.code, 'empty-delivery');
  const incomplete = await service.submit(session('chen'), {
    ...body,
    files: [
      {
        id: 'notes',
        mediaType: 'text/plain',
        byteSize: 4,
        checksum: 'abc',
        accessPolicyId: 'task-read',
        uploadComplete: false,
      },
    ],
  });
  assert.equal(incomplete.error.code, 'files-not-accepted');
  assert.equal(incomplete.error.message, '文件还不能随这次提交完成。请只提交文字或链接。');
  assert.equal(store.node('design').receipts.length, 0);
  assert.equal(store.node('design').command.version, 1);

  store.arm(1);
  const failed = await service.submit(session('chen'), { ...body, text: '接口说明' });
  assert.equal(failed.error.code, 'unavailable');
  assert.equal(failed.error.message, '执行记录暂时写不进去，请用同一个请求再试一次。');
  assert.equal(store.node('design').command.version, 1);
  assert.equal(store.node('design').receipts.length, 0);

  store.arm(0);
  const submitted = await service.submit(session('chen'), { ...body, text: '接口说明' });
  assert.equal(submitted.value.disposition, 'applied');
  assert.equal(submitted.value.node.status, 'in-review');
  const replay = await service.submit(session('chen'), {
    ...body,
    expectedVersion: 0,
    text: '接口说明',
  });
  assert.equal(replay.value.disposition, 'replayed');
  assert.equal(store.node('design').artifactVersions.length, 1);
  const mismatch = await service.submit(session('chen'), { ...body, text: '另一份说明' });
  assert.equal(mismatch.error.code, 'idempotency-mismatch');
  assert.equal(
    (await service.submit(session('chen'), { ...body, text: '接口说明', extra: true })).error.code,
    'unknown-field',
  );

  const roundId = submitted.value.node.currentRoundId;
  const artifactVersionId = submitted.value.node.artifacts.at(-1).id;
  const wrongReviewer = await service.ballot(session('chen'), {
    ...locate(applied, 'design', store.node('design').command.version, 'vote-outside'),
    roundId,
    artifactVersionId,
    action: 'approve',
  });
  assert.equal(wrongReviewer.error.code, 'not-assigned-reviewer');
  assert.equal(
    (
      await service.ballot(session('lin'), {
        ...locate(applied, 'design', store.node('design').command.version, 'vote-lin'),
        roundId,
        artifactVersionId,
        action: 'approve',
        reviewerId: 'outside',
      })
    ).error.code,
    'actor-from-body',
  );
});

test('file metadata cannot complete a node before trusted upload', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const { service, store } = create(state);
  await startChen(service, applied);
  const file = {
    id: 'synthetic',
    mediaType: 'text/plain',
    byteSize: 4,
    checksum: 'abc',
    accessPolicyId: 'task-read',
    uploadComplete: true,
  };
  const refused = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'file-1'),
    text: '有说明',
    files: [file],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'files-not-accepted');
  assert.equal(refused.error.message, '文件还不能随这次提交完成。请只提交文字或链接。');
  assert.equal(store.node('design').command.version, 1);
  assert.equal(store.node('design').artifactVersions.length, 0);
  assert.equal(store.node('design').receipts.length, 0);
  const missing = await service.submit(session('chen'), {
    ...locate(applied, 'missing', 1, 'file-missing'),
    files: [file],
  });
  assert.equal(missing.error.code, 'not-found');
  const textOnly = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'text-1'),
    text: '只有文字',
    files: [],
  });
  assert.equal(textOnly.ok, true, JSON.stringify(textOnly));
  assert.equal(textOnly.value.disposition, 'applied');
  assert.equal(store.node('design').artifactVersions.length, 1);
});

test('concurrent submits conflict once, and two deciding ballots unlock one downstream', async () => {
  const { state, applied } = confirm(
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
  const { service, store } = create(state);
  await startChen(service, applied);
  const firstBody = { ...locate(applied, 'design', 1, 'deliver-a'), text: '第一份' };
  const secondBody = { ...locate(applied, 'design', 1, 'deliver-b'), text: '第二份' };
  const [first, second] = await Promise.all([
    service.submit(session('chen'), firstBody),
    service.submit(session('chen'), secondBody),
  ]);
  const results = [first, second];
  assert.equal(results.filter((item) => item.ok && item.value.disposition === 'applied').length, 1);
  assert.equal(results.filter((item) => !item.ok && item.error.code === 'conflict').length, 1);
  assert.equal(results.find((item) => !item.ok).error.details.currentVersion, 2);
  assert.equal(store.node('design').artifactVersions.length, 1);

  const design = store.node('design');
  const roundId = design.currentRoundId;
  const artifactVersionId = design.artifactVersions.at(-1).id;
  const version = design.command.version;
  const vote = (actorId) =>
    service.ballot(session(actorId), {
      ...locate(applied, 'design', version, `vote-${actorId}`),
      roundId,
      artifactVersionId,
      action: 'approve',
    });
  const [linVote, outsideVote] = await Promise.all([vote('lin'), vote('outside')]);
  assert.equal(linVote.ok && outsideVote.ok, true);
  assert.equal(store.node('design').command.status, 'completed');
  assert.equal(store.node('design').rounds[0].ballots.length, 2);
  assert.equal(store.node('publish').command.status, 'ready');
  assert.equal(store.node('publish').handoff.inputRefs.length, 1);
  const again = await service.reconcile();
  assert.equal(again.value.unlocked, 0);
  assert.equal(store.node('publish').command.version, 2);

  const key = nodeRecordKey(store.node('publish'));
  assert.equal(
    store.storage.readNode(key).receipts.some((item) => item.idempotencyKey.startsWith('unlock:')),
    false,
  );
  assert.ok(
    store
      .node('publish')
      .command.stored.some((item) => String(item.idempotencyKey).startsWith('unlock:')),
  );
});

test('a send-back does not unlock, and the old round cannot accept another vote', async () => {
  const { state, applied } = confirm(
    [
      workflowNode({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['lin'],
      }),
      workflowNode({ id: 'publish', title: '发布', dependsOn: ['design'] }),
    ],
    [lin],
  );
  const { service, store } = create(state);
  await startChen(service, applied);
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'deliver-1'),
    text: '初稿',
  });
  const roundId = submitted.value.node.currentRoundId;
  const artifactVersionId = submitted.value.node.artifacts.at(-1).id;
  const sentBack = await service.ballot(session('lin'), {
    ...locate(applied, 'design', submitted.value.node.version, 'vote-back'),
    roundId,
    artifactVersionId,
    action: 'request-changes',
    comment: '请补充错误码',
  });
  assert.equal(sentBack.value.node.status, 'needs-revision');
  assert.equal(store.node('publish').command.status, 'blocked');
  const revised = await service.submit(session('chen'), {
    ...locate(applied, 'design', store.node('design').command.version, 'deliver-2'),
    text: '补充了错误码',
  });
  assert.equal(revised.value.node.status, 'in-review');
  assert.notEqual(revised.value.node.currentRoundId, roundId);
  const stale = await service.ballot(session('lin'), {
    ...locate(applied, 'design', revised.value.node.version, 'vote-stale'),
    roundId,
    artifactVersionId,
    action: 'approve',
  });
  assert.equal(stale.error.code, 'stale-round');
  const reports = await service.report(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(
    reports.value.reports.find((item) => item.nodeId === 'design').reviewOutcome,
    'pending',
  );
  assert.equal(
    reports.value.reports.find((item) => item.nodeId === 'publish').blockReason,
    '等待前置节点完成',
  );
});

test('an over-deep body and an oversized delivery are validation errors', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const { service } = create(state);
  await startChen(service, applied);
  const deep = [];
  let cursor = deep;
  for (let index = 0; index < 20000; index += 1) {
    const next = [];
    cursor.push(next);
    cursor = next;
  }
  const nested = await service.inbox(session('chen'), { nested: deep });
  assert.equal(nested.error.code, 'validation');
  const huge = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'huge'),
    text: 'x'.repeat(5_000_000),
  });
  assert.equal(huge.error.code, 'validation');
  const bounded = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'short'),
    text: '短说明',
  });
  assert.equal(bounded.value.disposition, 'applied');
});

test('a half-written start rejects node writes until retry, then delivery fills input refs', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计' }),
    workflowNode({ id: 'publish', title: '发布', assigneeId: 'outside', dependsOn: ['design'] }),
  ]);
  const { service, store } = create(state);
  const startBody = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-half',
  };
  store.arm(2);
  const failed = await service.startPlan(session('chen'), startBody);
  assert.equal(failed.error.code, 'unavailable');
  assert.equal(store.planCount(), 0);
  assert.equal(store.node('publish'), undefined);
  const inbox = await service.inbox(session('chen'), {});
  assert.equal(inbox.value.items.length, 0);
  const hidden = await service.report(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(hidden.error.code, 'plan-incomplete');
  assert.equal(JSON.stringify(hidden).includes('在计划半启动时交付'), false);

  store.arm(0);
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'early'),
    text: '在计划半启动时交付',
  });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error.code, 'plan-incomplete');
  assert.equal(JSON.stringify(submitted).includes('在计划半启动时交付'), false);
  const voted = await service.ballot(session('chen'), {
    ...locate(applied, 'design', 1, 'early-vote'),
    roundId: 'round-missing',
    artifactVersionId: 'artifact-missing',
    action: 'approve',
  });
  assert.equal(voted.error.code, 'plan-incomplete');
  const settled = await service.settle(session('chen'), {
    ...locate(applied, 'design', 1, 'early-settle'),
    roundId: 'round-missing',
    artifactVersionId: 'artifact-missing',
  });
  assert.equal(settled.error.code, 'plan-incomplete');
  assert.equal(store.node('design').command.status, 'ready');
  assert.equal(store.node('design').command.version, 1);

  const retry = await service.startPlan(session('chen'), startBody);
  assert.equal(retry.value.disposition, 'applied');
  assert.equal(store.planCount(), 1);
  assert.equal(store.node('publish').command.status, 'blocked');
  assert.equal(store.node('publish').handoff.inputRefs.length, 0);

  const delivered = await service.submit(session('chen'), {
    ...locate(applied, 'design', store.node('design').command.version, 'after-receipt'),
    text: '计划完整后交付',
  });
  assert.equal(delivered.value.disposition, 'applied');
  assert.equal(store.node('design').command.status, 'completed');
  assert.equal(store.node('publish').command.status, 'ready');
  assert.equal(store.node('publish').handoff.inputRefs.length, 1);
  assert.equal(
    store.node('publish').handoff.inputRefs[0].artifactVersionId,
    store.node('design').acceptedArtifactVersionId,
  );
  const reconciled = await service.reconcile();
  assert.equal(reconciled.value.unlocked, 0);
  const visible = await service.inbox(session('outside'), {});
  assert.equal(
    visible.value.items.some((item) => item.nodeId === 'publish' && item.action === 'submit'),
    true,
  );

  store.node('publish').handoff = { ...store.node('publish').handoff, inputRefs: [] };
  const repaired = await service.reconcile();
  assert.equal(repaired.value.unlocked, 1);
  assert.equal(store.node('publish').handoff.inputRefs.length, 1);
  const quiet = await service.reconcile();
  assert.equal(quiet.value.unlocked, 0);
});

test('multi-member calls come from the resolver, and another space is not-found', async () => {
  const reviewer = {
    id: 'lin',
    name: '林夏',
    kind: 'human',
    role: '复核',
    capabilities: [],
    instructions: '',
    available: true,
  };
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewerIds: ['lin'], reviewRequired: true })],
    [reviewer],
  );
  const { service, store } = create(state);

  const absent = await service.inbox({}, {});
  assert.equal(absent.error.code, 'unauthenticated');
  const untrusted = await service.startPlan(
    { member: { ok: false, status: 403, code: 'untrusted-request' } },
    {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: 'start-untrusted',
    },
  );
  assert.equal(untrusted.error.code, 'untrusted-request');
  assert.deepEqual(untrusted.error.details, {});
  assert.equal(JSON.stringify(untrusted).includes('设计登录流程'), false);
  const ownerBrowser = await service.startPlan(
    { kind: 'owner', memberId: 'chen' },
    {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: 'start-owner',
    },
  );
  assert.equal(ownerBrowser.error.code, 'unauthenticated');
  assert.equal(JSON.stringify(ownerBrowser).includes('chen'), false);

  const hidden = await service.startPlan(session('chen', ['north']), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-north',
  });
  assert.equal(hidden.error.code, 'not-found');
  assert.equal(JSON.stringify(hidden).includes('设计登录流程'), false);
  assert.equal(JSON.stringify(hidden).includes(applied.id), false);
  assert.equal(store.node('design'), undefined);

  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-chen',
  });
  assert.equal(started.ok, true);
  const delivered = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'chen-only'),
    text: '只给陈宁的说明',
  });
  assert.equal(delivered.value.disposition, 'applied');

  const crossed = await service.report(session('lin', ['north']), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(crossed.error.code, 'not-found');
  assert.equal(JSON.stringify(crossed).includes('只给陈宁的说明'), false);
  const crossedSubmit = await service.submit(session('lin', ['north']), {
    ...locate(applied, 'design', delivered.value.node.version, 'lin-cross'),
    text: '跨空间提交',
  });
  assert.equal(crossedSubmit.error.code, 'not-found');
  assert.equal(JSON.stringify(crossedSubmit).includes('只给陈宁的说明'), false);

  const chenInbox = await service.inbox(session('chen'), {});
  const linInbox = await service.inbox(session('lin'), {});
  assert.equal(chenInbox.value.actorId, 'chen');
  assert.equal(linInbox.value.actorId, 'lin');
  assert.equal(
    chenInbox.value.items.some((item) => item.actorId === 'lin'),
    false,
  );
  assert.equal(
    linInbox.value.items.some((item) => item.action === 'review' && item.actorId === 'lin'),
    true,
  );
  assert.equal(
    chenInbox.value.items.some((item) => item.action === 'review'),
    false,
  );
});

test('a corrupt stored record is skipped by inbox and report', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计' }),
    workflowNode({ id: 'publish', title: '发布', assigneeId: 'outside', dependsOn: ['design'] }),
  ]);
  const { service, store } = create(state);
  await startChen(service, applied);
  store.node('publish').handoff = {};
  const inbox = await service.inbox(session('chen'), {});
  assert.equal(inbox.ok, true);
  assert.equal(
    inbox.value.items.some((item) => item.nodeId === 'publish'),
    false,
  );
  const report = await service.report(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(report.ok, true);
  assert.equal(
    report.value.reports.some((item) => item.nodeId === 'design'),
    true,
  );
  assert.equal(
    report.value.reports.some((item) => item.nodeId === 'publish'),
    false,
  );
});

test('a reviewer removed from the task can no longer ballot or report', async () => {
  const { state, applied } = confirm(
    [
      workflowNode({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['lin'],
      }),
    ],
    [lin],
  );
  const { service } = create(state);
  await startChen(service, applied);
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'deliver-kept'),
    text: '初稿',
  });
  assert.equal(submitted.ok, true);
  state.tasks[0].participantIds = state.tasks[0].participantIds.filter((id) => id !== 'lin');
  const ballot = await service.ballot(session('lin'), {
    ...locate(applied, 'design', submitted.value.node.version, 'vote-removed'),
    roundId: submitted.value.node.currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
    action: 'approve',
  });
  assert.equal(ballot.ok, false);
  assert.equal(ballot.error.code, 'not-participant');
  assert.equal(JSON.stringify(ballot).includes('初稿'), false);
  const report = await service.report(session('lin'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(report.error.code, 'not-participant');
  assert.equal(JSON.stringify(report).includes('初稿'), false);
  const inbox = await service.inbox(session('lin'), {});
  assert.equal(inbox.ok, true);
  assert.equal(inbox.value.items.length, 0);
  assert.equal(inbox.value.nodes.length, 0);
  assert.equal(JSON.stringify(inbox).includes('初稿'), false);
  const settled = await service.settle(session('lin'), {
    ...locate(applied, 'design', submitted.value.node.version, 'settle-removed'),
    roundId: submitted.value.node.currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
  });
  assert.equal(settled.error.code, 'not-participant');
  assert.equal(JSON.stringify(settled).includes('初稿'), false);
  const replayedStart = await service.startPlan(session('lin'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(replayedStart.error.code, 'not-participant');
  assert.equal(JSON.stringify(replayedStart).includes('初稿'), false);
  const still = await service.report(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(still.ok, true);
});

test('a participant who is neither assignee nor reviewer cannot settle', async () => {
  const { state, applied } = confirm(
    [
      workflowNode({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['lin'],
      }),
    ],
    [lin],
  );
  state.tasks[0].participantIds = [...state.tasks[0].participantIds, 'outside'];
  const { service, store } = create(state);
  await startChen(service, applied);
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'deliver-role'),
    text: '只有执行者和评审人能结算',
  });
  assert.equal(submitted.ok, true);
  const version = store.node('design').command.version;
  const settled = await service.settle(session('outside'), {
    ...locate(applied, 'design', version, 'settle-outsider'),
    roundId: submitted.value.node.currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
  });
  assert.equal(settled.ok, false);
  assert.equal(settled.error.code, 'not-assigned-reviewer');
  assert.equal(JSON.stringify(settled).includes('只有执行者和评审人能结算'), false);
  assert.equal(store.node('design').command.version, version);
  assert.equal(store.node('design').command.status, 'in-review');
});

function confirmProject(projectId, nodes) {
  const { state, task } = fixture();
  state.projects = [{ id: projectId, name: '门户', description: '空间里的项目' }];
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      projectId,
      workflows: [{ ...task.workflows[0], nodes }],
      status: 'ready',
    },
  });
  const applied = ready.appliedPlans.at(-1);
  assert.ok(applied);
  assert.notEqual(projectId, 'team-north');
  return { state: ready, applied };
}

test('a project in a different space id is accepted only for that space', async () => {
  const projectId = 'portal';
  const spaceId = 'team-north';
  const { state, applied } = confirmProject(projectId, [
    workflowNode({ id: 'design', title: '设计' }),
  ]);
  const spaces = boundedProjectSpaces([{ projectId, spaceId }]);
  const { service, store } = create(state, spaces);
  const body = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-portal',
  };
  const started = await service.startPlan(session('chen', [spaceId]), body);
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const inbox = await service.inbox(session('chen', [spaceId]), {});
  assert.equal(
    inbox.value.items.some((item) => item.taskId === applied.taskId && item.nodeId === 'design'),
    true,
  );
  const hiddenInbox = await service.inbox(session('chen', ['team-south']), {});
  assert.equal(hiddenInbox.value.items.length, 0);
  const report = await service.report(session('chen', [spaceId]), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(
    report.value.reports.some((item) => item.nodeId === 'design'),
    true,
  );
  const delivered = await service.submit(session('chen', [spaceId]), {
    ...locate(applied, 'design', 1, 'portal-deliver'),
    text: '北队交付',
  });
  assert.equal(delivered.ok, true);

  const other = await service.startPlan(session('chen', ['team-south']), {
    ...body,
    idempotencyKey: 'start-south',
  });
  assert.equal(other.error.code, 'not-found');
  assert.equal(JSON.stringify(other).includes('北队交付'), false);
  assert.equal(JSON.stringify(other).includes('设计登录流程'), false);
  const crossed = await service.submit(session('chen', ['team-south']), {
    ...locate(applied, 'design', store.node('design').command.version, 'south-deliver'),
    text: '南队越权',
  });
  assert.equal(crossed.error.code, 'not-found');
  assert.equal(JSON.stringify(crossed).includes('北队交付'), false);
  assert.equal(store.node('design').receipts.length, 1);
  const aliased = await service.report(session('chen', [projectId]), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(aliased.error.code, 'not-found');
  assert.equal(JSON.stringify(aliased).includes('北队交付'), false);
});

test('a project with no space record is refused even when the project id is offered as a space', async () => {
  const { state, applied } = confirmProject('portal', [
    workflowNode({ id: 'design', title: '设计' }),
  ]);
  const { service, store } = create(state, boundedProjectSpaces([]));
  const started = await service.startPlan(session('chen', ['team-north', 'portal']), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-unmapped',
  });
  assert.equal(started.error.code, 'not-found');
  assert.equal(JSON.stringify(started).includes('设计登录流程'), false);
  assert.equal(store.planCount(), 0);
  assert.equal(store.node('design'), undefined);
  const inbox = await service.inbox(session('chen', ['team-north', 'portal']), {});
  assert.equal(inbox.ok, true);
  assert.equal(inbox.value.items.length, 0);
  assert.equal(JSON.stringify(inbox).includes('设计登录流程'), false);
});

test('a failed project-space lookup is refused and does not write', async () => {
  const { state, applied } = confirmProject('portal', [
    workflowNode({ id: 'design', title: '设计' }),
  ]);
  const denied = create(state, {
    async spaceForProject() {
      return { ok: false, reason: 'unavailable' };
    },
  });
  const blocked = await denied.service.startPlan(session('chen', ['team-north', 'portal']), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-unavailable',
  });
  assert.equal(blocked.error.code, 'unavailable');
  assert.equal(blocked.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(denied.store.planCount(), 0);
  assert.equal(denied.store.node('design'), undefined);

  let fail = false;
  const { service, store } = create(state, {
    async spaceForProject() {
      if (fail) throw new Error('space-directory-down');
      return { ok: true, spaceId: 'team-north' };
    },
  });
  const started = await service.startPlan(session('chen', ['team-north']), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-then-down',
  });
  assert.equal(started.ok, true);
  fail = true;
  const submitted = await service.submit(session('chen', ['team-north', 'portal']), {
    ...locate(applied, 'design', 1, 'after-down'),
    text: '目录故障后的交付',
  });
  assert.equal(submitted.error.code, 'unavailable');
  assert.equal(submitted.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(submitted).includes('space-directory-down'), false);
  assert.equal(JSON.stringify(submitted).includes('目录故障后的交付'), false);
  assert.equal(store.node('design').receipts.length, 0);
  const inbox = await service.inbox(session('chen', ['team-north']), {});
  assert.equal(inbox.error.code, 'unavailable');
  const report = await service.report(session('chen', ['team-north']), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(report.error.code, 'unavailable');
  assert.equal(JSON.stringify(report).includes('设计登录流程'), false);
});

test('a missing project-space directory refuses start, submit, inbox, and report', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const store = memory();
  const service = new ExecutionService(store.storage, { readWorkbench: () => state }, undefined);
  const member = session('chen', ['project']);
  const started = await service.startPlan(member, {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-uninjected',
  });
  assert.equal(started.ok, false);
  assert.equal(started.error.code, 'not-found');
  assert.equal(JSON.stringify(started).includes('设计登录流程'), false);
  const submitted = await service.submit(member, {
    ...locate(applied, 'design', 1, 'submit-uninjected'),
    text: '未注入目录的交付',
  });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error.code, 'not-found');
  assert.equal(JSON.stringify(submitted).includes('未注入目录的交付'), false);
  const inbox = await service.inbox(member, {});
  assert.equal(inbox.ok, false);
  assert.equal(inbox.error.code, 'not-found');
  const report = await service.report(member, {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'not-found');
  assert.equal(JSON.stringify(report).includes('设计登录流程'), false);
  assert.equal(store.planCount(), 0);
  assert.equal(store.node('design'), undefined);
});

test('rejected submit, ballot, and settle leave the storage snapshot unchanged', async () => {
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  state.tasks[0].participantIds = [...state.tasks[0].participantIds, 'outside'];
  const { service, store } = create(state);
  await startChen(service, applied);
  const before = store.snapshot();

  const submitted = await service.submit(session('lin'), {
    ...locate(applied, 'design', 1, 'reject-submit'),
    text: '评审人不能提交',
  });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error.code, 'not-assignee');

  const voted = await service.ballot(session('chen'), {
    ...locate(applied, 'design', 1, 'reject-ballot'),
    roundId: 'round-missing',
    artifactVersionId: 'artifact-missing',
    action: 'approve',
  });
  assert.equal(voted.ok, false);
  assert.equal(voted.error.code, 'not-assigned-reviewer');

  const settled = await service.settle(session('outside'), {
    ...locate(applied, 'design', 1, 'reject-settle'),
    roundId: 'round-missing',
    artifactVersionId: 'artifact-missing',
  });
  assert.equal(settled.ok, false);
  assert.equal(settled.error.code, 'not-assigned-reviewer');
  assert.deepEqual(store.snapshot(), before);
});

test('a missing task and a task in another space return the same body', async () => {
  const spaceId = 'team-north';
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const spaces = boundedProjectSpaces([{ projectId: 'project', spaceId }]);
  const { service, store } = create(state, spaces);
  const started = await service.startPlan(session('chen', [spaceId]), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-visible',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const before = store.snapshot();
  const hiddenCaller = session('chen', ['team-south']);
  const notFound = {
    ok: false,
    error: { code: 'not-found', message: '找不到这个节点。', details: {} },
  };

  async function probe(taskId, idempotencyKey) {
    const located = {
      taskId,
      planId: applied.id,
      revision: applied.revision,
      nodeId: 'design',
      expectedVersion: 1,
    };
    return {
      'start-plan': await service.startPlan(hiddenCaller, {
        taskId,
        planId: applied.id,
        revision: applied.revision,
        idempotencyKey: `${idempotencyKey}-start`,
      }),
      submit: await service.submit(hiddenCaller, {
        ...located,
        idempotencyKey: `${idempotencyKey}-submit`,
        text: '不应写入',
      }),
      ballot: await service.ballot(hiddenCaller, {
        ...located,
        idempotencyKey: `${idempotencyKey}-ballot`,
        roundId: 'round-probe',
        artifactVersionId: 'artifact-probe',
        action: 'approve',
      }),
      settle: await service.settle(hiddenCaller, {
        ...located,
        idempotencyKey: `${idempotencyKey}-settle`,
        roundId: 'round-probe',
        artifactVersionId: 'artifact-probe',
      }),
      report: await service.report(hiddenCaller, {
        taskId,
        planId: applied.id,
        revision: applied.revision,
      }),
    };
  }

  const hidden = await probe(applied.taskId, 'hidden');
  const missing = await probe(missingTaskId, 'missing');
  for (const endpoint of ['start-plan', 'submit', 'ballot', 'settle', 'report']) {
    assert.deepEqual(hidden[endpoint], missing[endpoint]);
    assert.deepEqual(hidden[endpoint], notFound);
  }

  const hiddenInbox = await service.inbox(hiddenCaller, {});
  const removed = state.tasks.splice(0, state.tasks.length);
  const missingInbox = await service.inbox(hiddenCaller, {});
  state.tasks.push(...removed);
  assert.deepEqual(hiddenInbox, missingInbox);
  assert.equal(hiddenInbox.ok, true);
  assert.deepEqual(hiddenInbox.value.items, []);
  assert.deepEqual(hiddenInbox.value.nodes, []);

  const wrongRevision = await service.startPlan(session('chen', [spaceId]), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision + 1,
    idempotencyKey: 'start-wrong-revision',
  });
  assert.equal(wrongRevision.ok, false);
  assert.equal(wrongRevision.error.code, 'plan-not-found');
  assert.equal(wrongRevision.error.message, '找不到指定的已确认计划版本。');
  assert.deepEqual(store.snapshot(), before);
});

function sameBytes(left, right, label) {
  const actual = Buffer.from(JSON.stringify(left));
  const expected = Buffer.from(JSON.stringify(right));
  assert.equal(
    actual.equals(expected),
    true,
    `${label}\n${actual.toString()}\n${expected.toString()}`,
  );
}

async function commandProbe(service, taskId, applied, idempotencyKey, caller) {
  const located = {
    taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    expectedVersion: 1,
  };
  return {
    'start-plan': await service.startPlan(caller, {
      taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: `${idempotencyKey}-start`,
    }),
    submit: await service.submit(caller, {
      ...located,
      idempotencyKey: `${idempotencyKey}-submit`,
      text: '目录故障时不应写入',
    }),
    ballot: await service.ballot(caller, {
      ...located,
      idempotencyKey: `${idempotencyKey}-ballot`,
      roundId: 'round-probe',
      artifactVersionId: 'artifact-probe',
      action: 'approve',
    }),
    settle: await service.settle(caller, {
      ...located,
      idempotencyKey: `${idempotencyKey}-settle`,
      roundId: 'round-probe',
      artifactVersionId: 'artifact-probe',
    }),
    report: await service.report(caller, {
      taskId,
      planId: applied.id,
      revision: applied.revision,
    }),
  };
}

test('inbox returns the same unavailable bytes whether or not a node is stored', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const down = {
    async spaceForProject() {
      throw new Error('space-down-4e1');
    },
  };
  const empty = create(state, down);
  const filled = create(state, down);
  const node = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    ownerId: 'chen',
    handoff: {
      assignee: { id: 'chen', kind: 'human' },
      reviewerIds: [],
      dependencyNodeIds: [],
      goal: '设计',
      expectedOutput: '说明',
    },
    command: { status: 'needs-revision', version: 2 },
    rounds: [],
    artifactVersions: [],
    comments: [],
    receipts: [],
  };
  await filled.store.storage.writeNode(nodeRecordKey(node), node);
  await filled.store.storage.writePlan(`${applied.taskId}:${applied.id}:${applied.revision}`, {
    idempotencyKey: 'stored-plan',
    fingerprint: 'stored',
    nodeIds: ['design'],
  });
  const absent = await empty.service.inbox(session('chen'), {});
  const present = await filled.service.inbox(session('chen'), {});
  sameBytes(absent, present, 'inbox');
  assert.equal(absent.error.code, 'unavailable');
  assert.equal(absent.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(present).includes('space-down-4e1'), false);
  assert.equal(JSON.stringify(present).includes('design'), false);
});

test('a directory fault returns the same unavailable bytes whether or not the task exists', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const caller = session('chen');
  const directories = [
    {
      async spaceForProject() {
        return { ok: false, reason: 'unavailable' };
      },
    },
    {
      async spaceForProject() {
        throw new Error('space-directory-down');
      },
    },
  ];
  for (const directory of directories) {
    const { service } = create(state, directory);
    const present = await commandProbe(service, applied.taskId, applied, 'present', caller);
    const absent = await commandProbe(service, missingTaskId, applied, 'absent', caller);
    for (const endpoint of ['start-plan', 'submit', 'ballot', 'settle', 'report']) {
      sameBytes(present[endpoint], absent[endpoint], endpoint);
      assert.equal(present[endpoint].error.code, 'unavailable');
      assert.equal(
        present[endpoint].error.message,
        '执行记录暂时不可用，请稍后用同一个请求再试一次。',
      );
    }
  }
});

test('a missing task asks the directory with the task id and never an empty project id', async () => {
  const seen = [];
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const { service, store } = create(state, {
    async spaceForProject(projectId) {
      seen.push(projectId);
      if (projectId === 'project') return { ok: true, spaceId: 'project' };
      return { ok: false, reason: 'unknown' };
    },
  });
  await startChen(service, applied);
  seen.length = 0;
  const before = store.snapshot();
  const absent = await service.report(session('chen'), {
    taskId: missingTaskId,
    planId: applied.id,
    revision: applied.revision,
  });
  const otherSpace = await service.report(session('chen', ['team-south']), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(absent.error.code, 'not-found');
  assert.equal(otherSpace.error.code, 'not-found');
  assert.deepEqual(absent, otherSpace);
  assert.deepEqual(seen, [missingTaskId, 'project']);
  assert.equal(seen.includes(''), false);
  assert.deepEqual(store.snapshot(), before);
});

test('a task id that was not generated is not-found and is not sent to the directory', async () => {
  const seen = [];
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const { service, store } = create(state, {
    async spaceForProject(projectId) {
      seen.push(projectId);
      if (projectId === 'project') return { ok: true, spaceId: 'project' };
      if (projectId === missingTaskId) return { ok: false, reason: 'unknown' };
      throw new Error('untrusted-id');
    },
  });
  await startChen(service, applied);
  seen.length = 0;
  const before = store.snapshot();
  const caller = session('chen');
  const legal = await commandProbe(service, missingTaskId, applied, 'legal-missing', caller);
  const illegalIds = ['x'.repeat(200_000), "'; drop table --"];
  const endpoints = ['start-plan', 'submit', 'ballot', 'settle', 'report'];
  for (const taskId of illegalIds) {
    const illegal = await commandProbe(service, taskId, applied, 'illegal', caller);
    for (const endpoint of endpoints) {
      const left = Buffer.from(JSON.stringify(illegal[endpoint]));
      const right = Buffer.from(JSON.stringify(legal[endpoint]));
      assert.equal(Buffer.compare(left, right), 0, `${endpoint}\n${left}\n${right}`);
      assert.equal(illegal[endpoint].error.code, 'not-found');
      assert.equal(illegal[endpoint].error.message, '找不到这个节点。');
      assert.equal(left.includes(Buffer.from('untrusted-id')), false);
      assert.equal(left.includes(Buffer.from('drop table')), false);
    }
  }
  assert.deepEqual(seen, Array(endpoints.length).fill(missingTaskId));
  assert.deepEqual(store.snapshot(), before);
});

test('a task id is accepted only inside the workbench length and character rule', async () => {
  const hundred = 'a'.repeat(100);
  const seen = [];
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const { service, store } = create(state, {
    async spaceForProject(projectId) {
      seen.push(projectId);
      if (projectId === 'project') return { ok: true, spaceId: 'project' };
      if (projectId === hundred) return { ok: false, reason: 'unknown' };
      throw new Error('untrusted-id');
    },
  });
  await startChen(service, applied);
  seen.length = 0;
  const before = store.snapshot();
  const caller = session('chen');
  const endpoints = ['start-plan', 'submit', 'ballot', 'settle', 'report'];
  const accepted = await commandProbe(service, hundred, applied, 'hundred', caller);
  for (const endpoint of endpoints) {
    assert.equal(accepted[endpoint].error.code, 'not-found', endpoint);
    assert.equal(accepted[endpoint].error.message, '找不到这个节点。');
  }
  assert.deepEqual(seen, Array(endpoints.length).fill(hundred));
  assert.deepEqual(store.snapshot(), before);

  const rejected = ['a'.repeat(101), 'é', '\u212A', '\u017F', '中文', '.', '/', '%'];
  for (const taskId of rejected) {
    const illegal = await commandProbe(service, taskId, applied, 'ruled-out', caller);
    for (const endpoint of endpoints) {
      assert.equal(
        illegal[endpoint].error.code,
        'not-found',
        `${endpoint} ${JSON.stringify(taskId)}`,
      );
      assert.equal(illegal[endpoint].error.message, '找不到这个节点。');
      assert.equal(JSON.stringify(illegal[endpoint]).includes('untrusted-id'), false);
    }
  }
  assert.deepEqual(seen, Array(endpoints.length).fill(hundred));
  assert.deepEqual(store.snapshot(), before);
});

test('a directory fault returns the same bytes for a non-uuid task id whether or not the task exists', async () => {
  const plainId = 'task';
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  assert.equal(applied.taskId, plainId);
  const absent = structuredClone(state);
  absent.tasks = [];
  const caller = session('chen');
  const faults = [
    {
      async spaceForProject() {
        return { ok: false, reason: 'unavailable' };
      },
    },
    {
      async spaceForProject() {
        throw new Error('space-directory-down');
      },
    },
  ];
  for (const directory of faults) {
    const presentService = create(state, directory);
    const absentService = create(absent, directory);
    const beforePresent = presentService.store.snapshot();
    const beforeAbsent = absentService.store.snapshot();
    const present = await commandProbe(presentService.service, plainId, applied, 'plain', caller);
    const missing = await commandProbe(absentService.service, plainId, applied, 'plain', caller);
    for (const endpoint of ['start-plan', 'submit', 'ballot', 'settle', 'report']) {
      const left = Buffer.from(JSON.stringify(present[endpoint]));
      const right = Buffer.from(JSON.stringify(missing[endpoint]));
      assert.equal(Buffer.compare(left, right), 0, `${endpoint}\n${left}\n${right}`);
      assert.equal(present[endpoint].error.code, 'unavailable');
      assert.equal(
        present[endpoint].error.message,
        '执行记录暂时不可用，请稍后用同一个请求再试一次。',
      );
      assert.equal(left.includes(Buffer.from('space-directory-down')), false);
    }
    assert.deepEqual(presentService.store.snapshot(), beforePresent);
    assert.deepEqual(absentService.store.snapshot(), beforeAbsent);
  }
});

test('an unusable ok from the directory is the same unavailable bytes whether or not the task exists', async () => {
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  let lookup = { ok: true, spaceId: 'project' };
  const { service, store } = create(state, {
    async spaceForProject() {
      return lookup;
    },
  });
  await startChen(service, applied);
  const before = store.snapshot();
  const callers = [session('chen', ['project']), session('lin', ['team-south'])];
  const shapes = [{ ok: true, spaceId: '' }, { ok: true }, { ok: 'yes', spaceId: 5 }];
  let compared = 0;
  for (const shape of shapes) {
    lookup = shape;
    for (const caller of callers) {
      const present = await commandProbe(service, applied.taskId, applied, 'shaped', caller);
      const absent = await commandProbe(service, missingTaskId, applied, 'shaped-absent', caller);
      for (const endpoint of ['start-plan', 'submit', 'ballot', 'settle', 'report']) {
        const left = Buffer.from(JSON.stringify(present[endpoint]));
        const right = Buffer.from(JSON.stringify(absent[endpoint]));
        assert.equal(
          Buffer.compare(left, right),
          0,
          `${endpoint}\n${left.toString()}\n${right.toString()}`,
        );
        assert.equal(present[endpoint].error.code, 'unavailable');
        assert.equal(
          present[endpoint].error.message,
          '执行记录暂时不可用，请稍后用同一个请求再试一次。',
        );
        compared += 1;
      }
    }
  }
  assert.equal(compared, 5 * 2 * 3);
  assert.deepEqual(store.snapshot(), before);
});

test('submit, ballot, and settle leave the storage snapshot unchanged when the directory throws', async () => {
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  let down = false;
  const { service, store } = create(state, {
    async spaceForProject() {
      if (down) throw new Error('space-directory-down');
      return { ok: true, spaceId: 'project' };
    },
  });
  await startChen(service, applied);
  const before = store.snapshot();
  down = true;
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'throw-submit'),
    text: '目录抛错后的交付',
  });
  const voted = await service.ballot(session('lin'), {
    ...locate(applied, 'design', 1, 'throw-ballot'),
    roundId: 'round-missing',
    artifactVersionId: 'artifact-missing',
    action: 'approve',
  });
  const settled = await service.settle(session('chen'), {
    ...locate(applied, 'design', 1, 'throw-settle'),
    roundId: 'round-missing',
    artifactVersionId: 'artifact-missing',
  });
  assert.equal(submitted.error.code, 'unavailable');
  assert.equal(voted.error.code, 'unavailable');
  assert.equal(settled.error.code, 'unavailable');
  assert.equal(JSON.stringify(submitted).includes('目录抛错后的交付'), false);
  assert.equal(JSON.stringify(submitted).includes('space-directory-down'), false);
  assert.deepEqual(store.snapshot(), before);
});

test('start-plan checks an idempotency key only inside the caller space', async () => {
  const { state, task } = fixture();
  state.projects = [
    { id: 'portal', name: '门户', description: '北队项目' },
    { id: 'harbor', name: '港务', description: '南队项目' },
  ];
  const north = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      id: 'north-task',
      projectId: 'portal',
      title: '北队专有',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const ready = applyWorkbenchCommand(north, {
    type: 'save-task',
    task: {
      ...task,
      id: 'south-task',
      projectId: 'harbor',
      title: '南队任务',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const northPlan = ready.appliedPlans.find((plan) => plan.taskId === 'north-task');
  const southPlan = ready.appliedPlans.find((plan) => plan.taskId === 'south-task');
  assert.ok(northPlan);
  assert.ok(southPlan);
  const spaces = boundedProjectSpaces([
    { projectId: 'portal', spaceId: 'team-north' },
    { projectId: 'harbor', spaceId: 'team-south' },
  ]);
  const probed = create(ready, spaces);
  const control = create(ready, spaces);
  const northStart = await probed.service.startPlan(session('chen', ['team-north']), {
    taskId: northPlan.taskId,
    planId: northPlan.id,
    revision: northPlan.revision,
    idempotencyKey: 'shared-key',
  });
  assert.equal(northStart.ok, true, northStart.ok ? '' : northStart.error.code);
  const southBody = {
    taskId: southPlan.taskId,
    planId: southPlan.id,
    revision: southPlan.revision,
    idempotencyKey: 'shared-key',
  };
  const south = await probed.service.startPlan(session('chen', ['team-south']), southBody);
  const alone = await control.service.startPlan(session('chen', ['team-south']), southBody);
  assert.equal(south.ok, true, south.ok ? '' : south.error.code);
  assert.equal(south.value.disposition, 'applied');
  sameBytes(south, alone, 'start-plan');
  assert.equal(JSON.stringify(south).includes('北队专有'), false);
  assert.equal(JSON.stringify(south).includes('north-task'), false);
  const replay = await probed.service.startPlan(session('chen', ['team-south']), {
    ...southBody,
    idempotencyKey: 'shared-key-replay',
  });
  assert.equal(replay.value.disposition, 'replayed');
  const clash = await probed.service.startPlan(session('chen', ['team-south']), {
    ...southBody,
    revision: southPlan.revision + 1,
    idempotencyKey: 'shared-key',
  });
  assert.equal(clash.error.code, 'idempotency-mismatch');
});

test('a thrown lookup for another project in the same space refuses the idempotency key', async () => {
  const { state, task } = fixture();
  state.projects = [
    { id: 'portal', name: '门户', description: '北队项目' },
    { id: 'harbor', name: '港务', description: '同空间的另一个项目' },
  ];
  const north = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      id: 'north-task',
      projectId: 'portal',
      title: '北队专有',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const ready = applyWorkbenchCommand(north, {
    type: 'save-task',
    task: {
      ...task,
      id: 'harbor-task',
      projectId: 'harbor',
      title: '同空间的港务任务',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const northPlan = ready.appliedPlans.find((plan) => plan.taskId === 'north-task');
  const harborPlan = ready.appliedPlans.find((plan) => plan.taskId === 'harbor-task');
  assert.ok(northPlan);
  assert.ok(harborPlan);
  let failPortal = false;
  const { service, store } = create(ready, {
    async spaceForProject(projectId) {
      if (projectId === 'portal' && failPortal) throw new Error('portal lookup failed');
      if (projectId === 'portal' || projectId === 'harbor') {
        return { ok: true, spaceId: 'team-north' };
      }
      return { ok: false, reason: 'unknown' };
    },
  });
  const started = await service.startPlan(session('chen', ['team-north']), {
    taskId: northPlan.taskId,
    planId: northPlan.id,
    revision: northPlan.revision,
    idempotencyKey: 'shared-key',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  failPortal = true;
  const before = store.snapshot();
  const rejected = await service.startPlan(session('chen', ['team-north']), {
    taskId: harborPlan.taskId,
    planId: harborPlan.id,
    revision: harborPlan.revision,
    idempotencyKey: 'shared-key',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'unavailable');
  assert.equal(rejected.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(rejected).includes('portal lookup failed'), false);
  assert.equal(JSON.stringify(rejected).includes('北队专有'), false);
  assert.deepEqual(store.snapshot(), before);
  failPortal = false;
  const clash = await service.startPlan(session('chen', ['team-north']), {
    taskId: harborPlan.taskId,
    planId: harborPlan.id,
    revision: harborPlan.revision,
    idempotencyKey: 'shared-key',
  });
  assert.equal(clash.error.code, 'idempotency-mismatch');
  assert.deepEqual(store.snapshot(), before);
});

test('a directory fault while placing another project refuses the idempotency key', async () => {
  const { state, task } = fixture();
  state.projects = [
    { id: 'portal', name: '门户', description: '北队项目' },
    { id: 'harbor', name: '港务', description: '可以和北队同空间，也可以在南队' },
  ];
  const north = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      id: 'north-task',
      projectId: 'portal',
      title: '北队专有',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const ready = applyWorkbenchCommand(north, {
    type: 'save-task',
    task: {
      ...task,
      id: 'harbor-task',
      projectId: 'harbor',
      title: '港务任务',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const northPlan = ready.appliedPlans.find((plan) => plan.taskId === 'north-task');
  const harborPlan = ready.appliedPlans.find((plan) => plan.taskId === 'harbor-task');
  assert.ok(northPlan);
  assert.ok(harborPlan);
  const faults = [
    { ok: false, reason: 'unavailable' },
    { ok: true, spaceId: '' },
    { ok: true },
    { ok: 'yes', spaceId: 5 },
  ];
  for (const fault of faults) {
    let portalAnswer = { ok: true, spaceId: 'team-north' };
    const { service, store } = create(ready, {
      async spaceForProject(projectId) {
        if (projectId === 'portal') return portalAnswer;
        if (projectId === 'harbor') return { ok: true, spaceId: 'team-north' };
        return { ok: false, reason: 'unknown' };
      },
    });
    const started = await service.startPlan(session('chen', ['team-north']), {
      taskId: northPlan.taskId,
      planId: northPlan.id,
      revision: northPlan.revision,
      idempotencyKey: 'shared-key',
    });
    assert.equal(started.ok, true, started.ok ? '' : started.error.code);
    portalAnswer = fault;
    const before = store.snapshot();
    const rejected = await service.startPlan(session('chen', ['team-north']), {
      taskId: harborPlan.taskId,
      planId: harborPlan.id,
      revision: harborPlan.revision,
      idempotencyKey: 'shared-key',
    });
    assert.equal(rejected.ok, false, JSON.stringify(fault));
    assert.equal(rejected.error.code, 'unavailable');
    assert.equal(rejected.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
    assert.equal(JSON.stringify(rejected).includes('北队专有'), false);
    assert.deepEqual(store.snapshot(), before);
  }

  const spaces = boundedProjectSpaces([
    { projectId: 'portal', spaceId: 'team-north' },
    { projectId: 'harbor', spaceId: 'team-south' },
  ]);
  const probed = create(ready, spaces);
  const control = create(ready, spaces);
  const northStart = await probed.service.startPlan(session('chen', ['team-north']), {
    taskId: northPlan.taskId,
    planId: northPlan.id,
    revision: northPlan.revision,
    idempotencyKey: 'shared-key',
  });
  assert.equal(northStart.ok, true, northStart.ok ? '' : northStart.error.code);
  const southBody = {
    taskId: harborPlan.taskId,
    planId: harborPlan.id,
    revision: harborPlan.revision,
    idempotencyKey: 'shared-key',
  };
  const south = await probed.service.startPlan(session('chen', ['team-south']), southBody);
  const alone = await control.service.startPlan(session('chen', ['team-south']), southBody);
  assert.equal(south.ok, true, south.ok ? '' : south.error.code);
  assert.equal(south.value.disposition, 'applied');
  sameBytes(south, alone, 'start-plan');
  assert.equal(JSON.stringify(south).includes('北队专有'), false);
  assert.equal(JSON.stringify(south).includes('north-task'), false);
});

test('an unknown lookup for another project in this space refuses the idempotency key', async () => {
  const { state, task } = fixture();
  state.projects = [
    { id: 'portal', name: '门户', description: '北队项目' },
    { id: 'harbor', name: '港务', description: '同空间的另一个项目' },
  ];
  const north = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      id: 'north-task',
      projectId: 'portal',
      title: '北队专有',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const ready = applyWorkbenchCommand(north, {
    type: 'save-task',
    task: {
      ...task,
      id: 'harbor-task',
      projectId: 'harbor',
      title: '同空间的港务任务',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const northPlan = ready.appliedPlans.find((plan) => plan.taskId === 'north-task');
  const harborPlan = ready.appliedPlans.find((plan) => plan.taskId === 'harbor-task');
  assert.ok(northPlan);
  assert.ok(harborPlan);
  let portalAnswer = { ok: true, spaceId: 'team-north' };
  const { service, store } = create(ready, {
    async spaceForProject(projectId) {
      if (projectId === 'portal') return portalAnswer;
      if (projectId === 'harbor') return { ok: true, spaceId: 'team-north' };
      return { ok: false, reason: 'unknown' };
    },
  });
  const northBody = {
    taskId: northPlan.taskId,
    planId: northPlan.id,
    revision: northPlan.revision,
    idempotencyKey: 'shared-key',
  };
  const started = await service.startPlan(session('chen', ['team-north']), northBody);
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  portalAnswer = { ok: false, reason: 'unknown' };
  const before = store.snapshot();
  const rejected = await service.startPlan(session('chen', ['team-north']), {
    taskId: harborPlan.taskId,
    planId: harborPlan.id,
    revision: harborPlan.revision,
    idempotencyKey: 'shared-key',
  });
  assert.equal(rejected.ok, false, 'unknown');
  assert.equal(rejected.error.code, 'unavailable');
  assert.equal(rejected.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(rejected).includes('北队专有'), false);
  assert.deepEqual(store.snapshot(), before);
  portalAnswer = { ok: true, spaceId: 'team-north' };
  const again = await service.startPlan(session('chen', ['team-north']), northBody);
  assert.equal(again.ok, true, again.ok ? '' : again.error.code);
  assert.equal(again.value.disposition, 'replayed');
  const clash = await service.startPlan(session('chen', ['team-north']), {
    taskId: harborPlan.taskId,
    planId: harborPlan.id,
    revision: harborPlan.revision,
    idempotencyKey: 'shared-key',
  });
  assert.equal(clash.error.code, 'idempotency-mismatch');
  assert.deepEqual(store.snapshot(), before);
});

test('the original start replays before another project lookup can change it', async () => {
  const { state, task } = fixture();
  state.projects = [
    { id: 'portal', name: '门户', description: '北队项目' },
    { id: 'harbor', name: '港务', description: '南队项目' },
  ];
  const north = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      id: 'north-task',
      projectId: 'portal',
      title: '北队专有',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const ready = applyWorkbenchCommand(north, {
    type: 'save-task',
    task: {
      ...task,
      id: 'harbor-task',
      projectId: 'harbor',
      title: '南队任务',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const northPlan = ready.appliedPlans.find((plan) => plan.taskId === 'north-task');
  const harborPlan = ready.appliedPlans.find((plan) => plan.taskId === 'harbor-task');
  assert.ok(northPlan);
  assert.ok(harborPlan);
  let harborDown = false;
  const { service, store } = create(ready, {
    async spaceForProject(projectId) {
      if (projectId === 'harbor' && harborDown) throw new Error('harbor lookup failed');
      if (projectId === 'portal') return { ok: true, spaceId: 'team-north' };
      if (projectId === 'harbor') return { ok: true, spaceId: 'team-south' };
      return { ok: false, reason: 'unknown' };
    },
  });
  const northBody = {
    taskId: northPlan.taskId,
    planId: northPlan.id,
    revision: northPlan.revision,
    idempotencyKey: 'shared-key',
  };
  const started = await service.startPlan(session('chen', ['team-north']), northBody);
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const south = await service.startPlan(session('chen', ['team-south']), {
    taskId: harborPlan.taskId,
    planId: harborPlan.id,
    revision: harborPlan.revision,
    idempotencyKey: 'shared-key',
  });
  assert.equal(south.ok, true, south.ok ? '' : south.error.code);
  harborDown = true;
  const before = store.snapshot();
  const replay = await service.startPlan(session('chen', ['team-north']), northBody);
  assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
  assert.equal(replay.value.disposition, 'replayed');
  assert.equal(JSON.stringify(replay).includes('南队任务'), false);
  assert.equal(JSON.stringify(replay).includes('harbor lookup failed'), false);
  assert.deepEqual(store.snapshot(), before);
});

test('another plan key in this space does not replay an already started revision', async () => {
  const { state, task } = fixture();
  const first = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      id: 'north-task',
      title: '已启动的修订',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const ready = applyWorkbenchCommand(first, {
    type: 'save-task',
    task: {
      ...task,
      id: 'harbor-task',
      title: '另一个计划',
      workflows: [{ ...task.workflows[0], nodes: [workflowNode({ id: 'design', title: '设计' })] }],
      status: 'ready',
    },
  });
  const startedPlan = ready.appliedPlans.find((plan) => plan.taskId === 'north-task');
  const otherPlan = ready.appliedPlans.find((plan) => plan.taskId === 'harbor-task');
  assert.ok(startedPlan);
  assert.ok(otherPlan);
  const { service, store } = create(ready);
  const caller = session('chen');
  const original = {
    taskId: startedPlan.taskId,
    planId: startedPlan.id,
    revision: startedPlan.revision,
    idempotencyKey: 'original-key',
  };
  const started = await service.startPlan(caller, original);
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  const other = await service.startPlan(caller, {
    taskId: otherPlan.taskId,
    planId: otherPlan.id,
    revision: otherPlan.revision,
    idempotencyKey: 'other-plan-key',
  });
  assert.equal(other.ok, true, other.ok ? '' : other.error.code);
  const before = store.snapshot();
  const crossed = await service.startPlan(caller, {
    ...original,
    idempotencyKey: 'other-plan-key',
  });
  assert.equal(crossed.ok, false, crossed.ok ? crossed.value.disposition : crossed.error.code);
  assert.equal(crossed.error.code, 'idempotency-mismatch');
  assert.deepEqual(store.snapshot(), before);
  const replay = await service.startPlan(caller, original);
  assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
  assert.equal(replay.value.disposition, 'replayed');
  assert.deepEqual(store.snapshot(), before);
});

test('an unexpected handoff failure says the record is unavailable, not that the write failed', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  Object.defineProperty(applied, 'probe', { enumerable: true, value() {} });
  const { service, store } = create(state);
  const before = store.snapshot();
  const failed = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-uncloneable',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'unavailable');
  assert.equal(failed.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(failed).includes('could not be cloned'), false);
  assert.equal(JSON.stringify(failed).includes('写不进去'), false);
  assert.deepEqual(store.snapshot(), before);
});

test('a failed unlock is repaired by the next read, and not while the directory is down', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计' }),
    workflowNode({ id: 'publish', title: '发布', dependsOn: ['design'] }),
  ]);
  let down = false;
  const spaces = {
    async spaceForProject(projectId) {
      if (down) throw new Error('space-down-4e1');
      return projectSpaces.spaceForProject(projectId);
    },
  };
  const { service, store } = create(state, spaces);
  await startChen(service, applied);
  store.arm(2);
  const failed = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'deliver-design'),
    text: '设计说明-4e1',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'unavailable');
  assert.equal(failed.error.message, '执行记录暂时写不进去，请用同一个请求再试一次。');
  assert.equal(store.node('design').command.status, 'completed');
  assert.equal(store.node('publish').command.status, 'blocked');
  assert.equal(store.node('publish').handoff.inputRefs.length, 0);

  down = true;
  const held = JSON.stringify(store.node('publish'));
  const blocked = await service.inbox(session('chen'), {});
  assert.equal(blocked.error.code, 'unavailable');
  assert.equal(blocked.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(blocked).includes('space-down-4e1'), false);
  assert.equal(JSON.stringify(store.node('publish')), held);

  down = false;
  store.arm(1);
  const duringFailure = JSON.stringify(store.node('publish'));
  const repairFailed = await service.inbox(session('chen'), {});
  assert.equal(repairFailed.ok, true, repairFailed.ok ? '' : repairFailed.error.message);
  assert.equal(store.node('publish').command.status, 'blocked');
  assert.equal(store.node('publish').handoff.inputRefs.length, 0);
  assert.equal(JSON.stringify(store.node('publish')), duringFailure);
  store.arm(1);
  const otherSpace = await service.inbox(session('chen', ['team-south']), {});
  assert.equal(otherSpace.ok, true, otherSpace.ok ? '' : otherSpace.error.message);
  assert.equal(JSON.stringify(store.node('publish')), duringFailure);

  store.arm(0);
  const inbox = await service.inbox(session('chen'), {});
  assert.equal(inbox.ok, true);
  assert.equal(store.node('publish').command.status, 'ready');
  assert.equal(store.node('publish').handoff.inputRefs.length, 1);
  assert.equal(
    store.node('publish').handoff.inputRefs[0].artifactVersionId,
    store.node('design').acceptedArtifactVersionId,
  );
  assert.equal(
    inbox.value.items.some((item) => item.nodeId === 'publish' && item.action === 'submit'),
    true,
  );
  const version = store.node('publish').command.version;
  const again = await service.inbox(session('chen'), {});
  assert.equal(again.ok, true);
  assert.equal(store.node('publish').command.version, version);
  assert.equal(store.node('publish').handoff.inputRefs.length, 1);
  assert.equal(JSON.stringify(inbox).includes('设计说明-4e1'), false);
});

test('a failed unlock is repaired by the next write, once', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计' }),
    workflowNode({ id: 'publish', title: '发布', dependsOn: ['design'] }),
    workflowNode({ id: 'notes', title: '备注' }),
  ]);
  const { service, store } = create(state);
  await startChen(service, applied);
  store.arm(2);
  const failed = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'deliver-design'),
    text: '设计说明',
  });
  assert.equal(failed.error.code, 'unavailable');
  assert.equal(store.node('publish').command.status, 'blocked');
  assert.equal(store.node('publish').handoff.inputRefs.length, 0);

  store.arm(0);
  const written = await service.submit(session('chen'), {
    ...locate(applied, 'notes', 1, 'deliver-notes'),
    text: '备注说明',
  });
  assert.equal(written.value.disposition, 'applied');
  assert.equal(store.node('notes').command.status, 'completed');
  assert.equal(store.node('publish').command.status, 'ready');
  assert.equal(store.node('publish').handoff.inputRefs.length, 1);
  assert.equal(store.node('publish').handoff.inputRefs[0].sourceNodeId, 'design');
  const version = store.node('publish').command.version;
  const quiet = await service.report(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(quiet.ok, true);
  assert.equal(
    quiet.value.reports.find((item) => item.nodeId === 'publish').blockReason,
    undefined,
  );
  assert.equal(store.node('publish').command.version, version);
  assert.equal(store.node('publish').handoff.inputRefs.length, 1);
});

test('a refused or missing request does not repair, and another space is not written', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计' }),
    workflowNode({ id: 'publish', title: '发布', dependsOn: ['design'] }),
  ]);
  const { service, store } = create(state);
  await startChen(service, applied);
  store.arm(2);
  const failed = await service.submit(session('chen'), {
    ...locate(applied, 'design', 1, 'deliver-design'),
    text: '设计说明-4e1',
  });
  assert.equal(failed.ok, false);
  assert.equal(store.node('publish').command.status, 'blocked');
  const before = JSON.stringify(store.node('publish'));
  store.arm(0);

  const missing = await service.revision(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'missing-node',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'not-found');
  assert.equal(JSON.stringify(store.node('publish')), before);
  assert.equal(store.snapshot().writes, 0);

  const south = await service.inbox(session('chen', ['team-south']), {});
  assert.equal(south.ok, true, south.ok ? '' : south.error.message);
  assert.equal(JSON.stringify(store.node('publish')), before);
  assert.equal(store.snapshot().writes, 0);

  const outsider = await service.ballot(session('outside'), {
    ...locate(applied, 'design', store.node('design').command.version, 'vote-outsider'),
    roundId: 'round-missing',
    artifactVersionId: 'artifact-missing',
    action: 'approve',
  });
  assert.equal(outsider.ok, false);
  assert.equal(JSON.stringify(store.node('publish')), before);
  assert.equal(store.snapshot().writes, 0);
});
