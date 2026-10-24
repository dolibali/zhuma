import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { hashPassword } from '../dist/identity-session.js';
import { bootIdentity, disposeHost } from './member-host.mjs';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const password = 'member-password-session';
const passwordHash = hashPassword(password);
const lin = {
  id: 'lin',
  name: '林夏',
  kind: 'human',
  role: '复核',
  capabilities: [],
  instructions: '',
  available: true,
};
const zhao = {
  id: 'zhao',
  name: '赵衡',
  kind: 'human',
  role: '北方',
  capabilities: [],
  instructions: '',
  available: true,
};

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
  let writes = 0;
  let failOn = 0;
  const storage = {
    readNode: (key) => nodes.get(key),
    writeNode: async (key, value) => {
      writes += 1;
      if (writes === failOn) throw new Error('disk full');
      nodes.set(key, structuredClone(value));
    },
    listNodes: () => [...nodes.values()],
    readPlan: (key) => plans.get(key),
    writePlan: async (key, value) => {
      writes += 1;
      if (writes === failOn) throw new Error('disk full');
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

let host;
const cookies = {};

test.before(async () => {
  host = await bootIdentity(
    {
      accounts: ['chen', 'lin', 'outside', 'zhao'].map((id) => ({ id, passwordHash })),
      notes: [
        {
          id: 'south',
          spaceId: 'project',
          ownerId: 'chen',
          teamMemberIds: ['chen', 'lin', 'outside'],
          text: 'south',
        },
        {
          id: 'north',
          spaceId: 'north',
          ownerId: 'zhao',
          teamMemberIds: ['zhao'],
          text: 'north',
        },
      ],
    },
    'multi-member',
    // spaceIdsFor reads the trusted directory. These memberships match the
    // notes above: chen, lin, and outside share project; zhao only has north.
    {
      spaces: [
        { id: 'project', kind: 'team', name: '项目空间' },
        { id: 'north', kind: 'team', name: '北方空间' },
      ],
      memberships: [
        { spaceId: 'project', accountId: 'chen' },
        { spaceId: 'project', accountId: 'lin' },
        { spaceId: 'project', accountId: 'outside' },
        { spaceId: 'north', accountId: 'zhao' },
      ],
    },
  );
  for (const id of ['chen', 'lin', 'outside', 'zhao']) {
    cookies[id] = await host.login(id, password);
  }
});

test.after(async () => {
  await disposeHost(host);
});

test('cleanup skips a host that never started', async () => {
  let started;
  await assert.rejects(
    () => bootIdentity({ accounts: [{ id: 'chen', passwordHash }] }, 'single-user'),
    /identity startup refused: deployment mode is not configured/,
  );
  await disposeHost(started);
});

test('a rejected identity import does not dispose an identity fiber that never finished', async () => {
  await assert.rejects(
    () => bootIdentity({ accounts: [] }, 'multi-member'),
    /identity import was rejected: accounts is empty/,
  );
});

test('multi-member does not map an owner cookie even for one named account', async () => {
  const alone = await bootIdentity(
    {
      accounts: [{ id: 'chen', passwordHash }],
      ownerAccountId: 'chen',
      notes: [
        {
          id: 'only',
          spaceId: 'project',
          ownerId: 'chen',
          teamMemberIds: ['chen'],
          text: 'local',
        },
      ],
    },
    'multi-member',
  );
  try {
    const member = await alone.member(alone.ownerCookie());
    assert.equal(member.ok, false);
    assert.equal(member.code, 'unauthenticated');
  } finally {
    await disposeHost(alone);
  }
});

async function actor(accountId) {
  const member = await host.member(cookies[accountId]);
  assert.equal(member.ok, true, JSON.stringify(member));
  assert.equal(member.memberId, accountId);
  return { member };
}

const projectSpaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);

function open(state) {
  const store = memory();
  const service = new ExecutionService(
    store.storage,
    { readWorkbench: () => state },
    projectSpaces,
  );
  return { service, store };
}

test('resolveMember rejects an owner cookie, a forged cookie, and the wrong space', async () => {
  const ownerOnly = await host.member(host.ownerCookie());
  assert.equal(ownerOnly.ok, false);
  assert.equal(ownerOnly.code, 'unauthenticated');
  const forged = await host.member('zhuma-member=forged');
  assert.equal(forged.code, 'unauthenticated');
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })], [zhao]);
  const { service } = open(state);
  const hidden = await service.startPlan(await actor('zhao'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-north',
  });
  assert.equal(hidden.error.code, 'not-found');
  const outsider = await service.startPlan(await actor('outside'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-outside',
  });
  assert.equal(outsider.error.code, 'not-participant');
  assert.equal((await service.inbox({}, {})).error.code, 'unauthenticated');
  assert.equal(service.bindOwner, undefined);
});

test('a half-written plan stays closed until the same start is retried', async () => {
  const { state, applied } = confirm([
    workflowNode({ id: 'design', title: '设计' }),
    workflowNode({ id: 'publish', title: '发布', dependsOn: ['design'] }),
  ]);
  const { service, store } = open(state);
  const chen = await actor('chen');
  const body = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-half',
  };
  store.arm(2);
  const failed = await service.startPlan(chen, body);
  assert.equal(failed.error.code, 'unavailable');
  assert.equal(store.planCount(), 0);
  const early = await service.submit(chen, {
    ...locate(applied, 'design', 1, 'too-soon'),
    text: '还没回执',
  });
  assert.equal(early.error.code, 'plan-incomplete');
  store.arm(0);
  const started = await service.startPlan(chen, body);
  assert.equal(started.value.disposition, 'applied');
  assert.equal(store.planCount(), 1);
});

test('a stale version and a stale round are refused', async () => {
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  const { service } = open(state);
  await service.startPlan(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-stale',
  });
  const submitted = await service.submit(await actor('chen'), {
    ...locate(applied, 'design', 1, 'deliver-stale'),
    text: '初稿',
  });
  const staleVersion = await service.submit(await actor('chen'), {
    ...locate(applied, 'design', 1, 'deliver-next'),
    text: '旧版本',
  });
  assert.equal(staleVersion.error.code, 'conflict');
  const sent = await service.ballot(await actor('lin'), {
    ...locate(applied, 'design', submitted.value.node.version, 'vote-back'),
    roundId: submitted.value.node.currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
    action: 'request-changes',
    comment: '补一段',
  });
  assert.equal(sent.value.node.status, 'needs-revision');
  const revised = await service.submit(await actor('chen'), {
    ...locate(applied, 'design', sent.value.node.version, 'deliver-revised'),
    text: '已补充',
  });
  const staleRound = await service.ballot(await actor('lin'), {
    ...locate(applied, 'design', revised.value.node.version, 'vote-old-round'),
    roundId: submitted.value.node.currentRoundId,
    artifactVersionId: submitted.value.node.artifacts.at(-1).id,
    action: 'approve',
  });
  assert.equal(staleRound.error.code, 'stale-round');
});

test('duplicate and concurrent submits keep one delivery', async () => {
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  const { service } = open(state);
  const chen = await actor('chen');
  await service.startPlan(chen, {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-dup',
  });
  const body = { ...locate(applied, 'design', 1, 'deliver-dup'), text: '同一份' };
  const replay = await service.submit(chen, body);
  const again = await service.submit(chen, body);
  assert.equal(replay.value.disposition, 'applied');
  assert.equal(again.value.disposition, 'replayed');
  const racedPlan = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  const raceService = new ExecutionService(
    memory().storage,
    { readWorkbench: () => racedPlan.state },
    projectSpaces,
  );
  await raceService.startPlan(chen, {
    taskId: racedPlan.applied.taskId,
    planId: racedPlan.applied.id,
    revision: racedPlan.applied.revision,
    idempotencyKey: 'start-race',
  });
  const [first, second] = await Promise.all([
    raceService.submit(chen, { ...locate(racedPlan.applied, 'design', 1, 'race-a'), text: '甲' }),
    raceService.submit(chen, { ...locate(racedPlan.applied, 'design', 1, 'race-b'), text: '乙' }),
  ]);
  const results = [first, second];
  assert.equal(results.filter((item) => item.ok && item.value.disposition === 'applied').length, 1);
  assert.equal(results.filter((item) => !item.ok && item.error.code === 'conflict').length, 1);
});

test('send-back then resubmit unlocks downstream only after every reviewer approves', async () => {
  const { state, applied } = confirm(
    [
      workflowNode({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['lin', 'outside'],
      }),
      workflowNode({ id: 'publish', title: '发布', assigneeId: 'outside', dependsOn: ['design'] }),
    ],
    [lin],
  );
  const { service, store } = open(state);
  await service.startPlan(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-review',
  });
  const submitted = await service.submit(await actor('chen'), {
    ...locate(applied, 'design', 1, 'deliver-review'),
    text: '初稿',
  });
  const vote = async (accountId, action, key, version, roundId, artifactVersionId, comment) =>
    service.ballot(await actor(accountId), {
      ...locate(applied, 'design', version, key),
      roundId,
      artifactVersionId,
      action,
      ...(comment === undefined ? {} : { comment }),
    });
  const sent = await vote(
    'lin',
    'request-changes',
    'vote-back',
    submitted.value.node.version,
    submitted.value.node.currentRoundId,
    submitted.value.node.artifacts.at(-1).id,
    '请改',
  );
  assert.equal(sent.value.node.status, 'needs-revision');
  assert.equal(store.node('publish').command.status, 'blocked');
  const revised = await service.submit(await actor('chen'), {
    ...locate(applied, 'design', sent.value.node.version, 'deliver-again'),
    text: '已改',
  });
  const roundId = revised.value.node.currentRoundId;
  const artifactVersionId = revised.value.node.artifacts.at(-1).id;
  const version = revised.value.node.version;
  const one = await vote('lin', 'approve', 'vote-lin', version, roundId, artifactVersionId);
  assert.equal(one.ok, true);
  assert.equal(store.node('publish').command.status, 'blocked');
  const two = await vote(
    'outside',
    'approve',
    'vote-outside',
    one.value.node.version,
    roundId,
    artifactVersionId,
  );
  assert.equal(two.ok, true);
  assert.equal(store.node('design').command.status, 'completed');
  assert.equal(store.node('publish').command.status, 'ready');
});

test('a failed write can be retried without losing the previous node', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const { service, store } = open(state);
  const chen = await actor('chen');
  await service.startPlan(chen, {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-recover',
  });
  store.arm(1);
  const failed = await service.submit(chen, {
    ...locate(applied, 'design', 1, 'deliver-fail'),
    text: '第一次',
  });
  assert.equal(failed.error.code, 'unavailable');
  assert.equal(store.node('design').command.version, 1);
  store.arm(0);
  const stored = await service.submit(chen, {
    ...locate(applied, 'design', 1, 'deliver-fail'),
    text: '第一次',
  });
  assert.equal(stored.value.disposition, 'applied');
  assert.equal(store.node('design').command.status, 'completed');
});

test('single-user mode is the account identity configured, and a removed reviewer cannot vote', async () => {
  let single;
  try {
    single = await bootIdentity(
      {
        accounts: [{ id: 'chen', passwordHash }],
        ownerAccountId: 'chen',
        notes: [
          {
            id: 'only',
            spaceId: 'project',
            ownerId: 'chen',
            teamMemberIds: ['chen'],
            text: 'local',
          },
        ],
      },
      'legacy-single-user',
      {
        spaces: [{ id: 'project', kind: 'personal', name: '个人空间' }],
        memberships: [{ spaceId: 'project', accountId: 'chen' }],
      },
    );
    const member = await single.member(single.ownerCookie());
    assert.equal(member.ok, true);
    assert.equal(member.memberId, 'chen');
    assert.equal(member.spaceIds.includes('project'), true);
    const { state, applied } = confirm(
      [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
      [lin],
    );
    const { service } = open(state);
    const started = await service.startPlan(
      { member },
      {
        taskId: applied.taskId,
        planId: applied.id,
        revision: applied.revision,
        idempotencyKey: 'start-single',
      },
    );
    assert.equal(started.ok, true, started.ok ? '' : started.error.code);
    const submitted = await service.submit(
      { member: await host.member(cookies.chen) },
      { ...locate(applied, 'design', 1, 'deliver-single'), text: '单人也能交' },
    );
    assert.equal(submitted.ok, true);
    state.tasks[0].participantIds = state.tasks[0].participantIds.filter((id) => id !== 'lin');
    const ballot = await service.ballot(await actor('lin'), {
      ...locate(applied, 'design', submitted.value.node.version, 'vote-removed'),
      roundId: submitted.value.node.currentRoundId,
      artifactVersionId: submitted.value.node.artifacts.at(-1).id,
      action: 'approve',
    });
    assert.equal(ballot.error.code, 'not-participant');
  } finally {
    await disposeHost(single);
  }
});

test('a removed reviewer loses the inbox item and its delivery content', async () => {
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  const { service } = open(state);
  await service.startPlan(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-hide',
  });
  const submitted = await service.submit(await actor('chen'), {
    ...locate(applied, 'design', 1, 'deliver-hide'),
    text: '只有成员能看见的正文',
  });
  assert.equal(submitted.ok, true);
  const before = await service.inbox(await actor('lin'), {});
  assert.equal(
    before.value.items.some((item) => item.nodeId === 'design' && item.action === 'review'),
    true,
  );
  assert.equal(
    before.value.nodes.some((node) =>
      node.artifacts.some((artifact) => artifact.text === '只有成员能看见的正文'),
    ),
    true,
  );
  state.tasks[0].participantIds = state.tasks[0].participantIds.filter((id) => id !== 'lin');
  const hidden = await service.inbox(await actor('lin'), {});
  assert.equal(hidden.ok, true);
  assert.equal(hidden.value.items.length, 0);
  assert.equal(hidden.value.nodes.length, 0);
  assert.equal(JSON.stringify(hidden).includes('只有成员能看见的正文'), false);
  const report = await service.report(await actor('lin'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(report.error.code, 'not-participant');
  assert.equal(JSON.stringify(report).includes('只有成员能看见的正文'), false);
});

test('replay by someone who is neither assignee nor reviewer is refused', async () => {
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  state.tasks[0].participantIds = [...state.tasks[0].participantIds, 'outside'];
  const { service } = open(state);
  await service.startPlan(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-replay-role',
  });
  const body = { ...locate(applied, 'design', 1, 'deliver-replay-role'), text: '执行者的正文' };
  const delivered = await service.submit(await actor('chen'), body);
  assert.equal(delivered.value.disposition, 'applied');
  const submitReplay = await service.submit(await actor('outside'), body);
  assert.equal(submitReplay.ok, false);
  assert.equal(submitReplay.error.code, 'not-assignee');
  const voted = await service.ballot(await actor('lin'), {
    ...locate(applied, 'design', delivered.value.node.version, 'vote-replay-role'),
    roundId: delivered.value.node.currentRoundId,
    artifactVersionId: delivered.value.node.artifacts.at(-1).id,
    action: 'approve',
  });
  assert.equal(voted.ok, true);
  const ballotReplay = await service.ballot(await actor('outside'), {
    ...locate(applied, 'design', delivered.value.node.version, 'vote-replay-role'),
    roundId: delivered.value.node.currentRoundId,
    artifactVersionId: delivered.value.node.artifacts.at(-1).id,
    action: 'approve',
  });
  assert.equal(ballotReplay.ok, false);
  assert.equal(ballotReplay.error.code, 'not-assigned-reviewer');
  assert.equal(JSON.stringify(submitReplay).includes('执行者的正文'), false);
  assert.equal(JSON.stringify(ballotReplay).includes('执行者的正文'), false);
});

test('an account outside the directory cannot read execution', async () => {
  const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
  const { service } = open(state);
  await service.startPlan(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-directory',
  });
  await service.submit(await actor('chen'), {
    ...locate(applied, 'design', 1, 'deliver-directory'),
    text: '目录外不可见',
  });
  const inbox = await service.inbox(await actor('zhao'), {});
  assert.equal(inbox.error.code, 'not-in-directory');
  assert.equal(JSON.stringify(inbox).includes('目录外不可见'), false);
  const report = await service.report(await actor('zhao'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  assert.equal(report.error.code, 'not-in-directory');
});

test('concurrent decisive ballots unlock one downstream', async () => {
  const { state, applied } = confirm(
    [
      workflowNode({
        id: 'design',
        title: '设计',
        reviewRequired: true,
        reviewerIds: ['lin', 'outside'],
      }),
      workflowNode({ id: 'publish', title: '发布', assigneeId: 'outside', dependsOn: ['design'] }),
    ],
    [lin],
  );
  const { service, store } = open(state);
  await service.startPlan(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-decisive',
  });
  const submitted = await service.submit(await actor('chen'), {
    ...locate(applied, 'design', 1, 'deliver-decisive'),
    text: '待两人同时通过',
  });
  const roundId = submitted.value.node.currentRoundId;
  const artifactVersionId = submitted.value.node.artifacts.at(-1).id;
  const version = submitted.value.node.version;
  const vote = async (accountId) =>
    service.ballot(await actor(accountId), {
      ...locate(applied, 'design', version, `vote-${accountId}`),
      roundId,
      artifactVersionId,
      action: 'approve',
    });
  const [linVote, outsideVote] = await Promise.all([vote('lin'), vote('outside')]);
  assert.equal(linVote.ok && outsideVote.ok, true);
  assert.equal(store.node('design').command.status, 'completed');
  assert.equal(store.node('publish').command.status, 'ready');
  assert.equal(store.node('publish').handoff.inputRefs.length, 1);
});

test('report and inbox survive a service restart', async () => {
  const { state, applied } = confirm(
    [workflowNode({ id: 'design', title: '设计', reviewRequired: true, reviewerIds: ['lin'] })],
    [lin],
  );
  const { service, store } = open(state);
  await service.startPlan(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-restart',
  });
  await service.submit(await actor('chen'), {
    ...locate(applied, 'design', 1, 'deliver-restart'),
    text: '重启后仍在',
  });
  const beforeReport = await service.report(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  const beforeInbox = await service.inbox(await actor('lin'), {});
  const restored = memory();
  for (const record of store.storage.listNodes()) {
    await restored.storage.writeNode(
      `${record.taskId}:${record.planId}:${record.revision}:${record.nodeId}`,
      record,
    );
  }
  for (const item of store.storage.listPlans()) {
    await restored.storage.writePlan(item.key, item.receipt);
  }
  const restarted = new ExecutionService(
    restored.storage,
    { readWorkbench: () => state },
    projectSpaces,
  );
  const afterReport = await restarted.report(await actor('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
  });
  const afterInbox = await restarted.inbox(await actor('lin'), {});
  assert.equal(JSON.stringify(beforeReport), JSON.stringify(afterReport));
  assert.equal(JSON.stringify(beforeInbox), JSON.stringify(afterInbox));
  assert.equal(JSON.stringify(afterInbox).includes('重启后仍在'), true);
});
