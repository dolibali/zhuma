import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWorkspaceView, phaseReached } from '@zhuma/client';

test('契约：下一轮待生效还没到已应用，补充路径不把待生效算进去', () => {
  assert.equal(phaseReached({ phase: 'pending', kind: 'next-turn' }, 'sent'), true);
  assert.equal(phaseReached({ phase: 'pending', kind: 'next-turn' }, 'received'), true);
  assert.equal(phaseReached({ phase: 'pending', kind: 'next-turn' }, 'pending'), true);
  assert.equal(phaseReached({ phase: 'pending', kind: 'next-turn' }, 'applied'), false);
  assert.equal(phaseReached({ phase: 'pending', kind: 'supplement' }, 'pending'), false);
  assert.equal(phaseReached({ phase: 'received', kind: 'supplement' }, 'applied'), false);
  assert.equal(phaseReached({ phase: 'applied', kind: 'resume-input' }, 'pending'), false);
  assert.equal(phaseReached({ phase: 'applied', kind: 'resume-input' }, 'applied'), true);
});

test('契约：投影标出模拟、不改快照，也不把交付写成已完成', () => {
  const snapshot = workspaceSnapshot();
  const before = structuredClone(snapshot);
  const view = createAgentWorkspaceView(snapshot);
  assert.deepEqual(snapshot, before);
  assert.equal(view.delivered, false);
  assert.equal(view.simulated, true);
  assert.match(view.banner, /模拟/);
  assert.match(view.nodeStatusText, /^状态：/);
  assert.equal(view.nextAction, '继续 Agent 处理');
  assert.equal(view.interventions[0].phases.find((phase) => phase.id === 'applied').reached, false);
  assert.equal(view.interventions[0].phases.find((phase) => phase.id === 'pending').reached, true);
  assert.equal(view.drafts[0].note.includes('尚未交付'), true);
  assert.equal(JSON.stringify(view).includes('/home/'), false);

  const unselected = createAgentWorkspaceView(
    workspaceSnapshot({
      config: {
        ...snapshot.config,
        executorId: null,
        simulated: false,
        modelLabel: '尚未选择执行器',
      },
    }),
  );
  assert.match(unselected.banner, /不会自动改用模拟执行器/);
  assert.equal(unselected.primary.enabled, false);
});

test('契约：运行中丢了入口记录时，状态不再写成执行中', () => {
  const base = workspaceSnapshot();
  const broken = createAgentWorkspaceView(
    workspaceSnapshot({
      runs: [{ ...base.runs[0], status: 'failed' }],
      lastError: {
        code: 'entry-inconsistent',
        objectLabel: '节点',
        reason: '节点记录异常，需要人工处理',
        nextStep: '不要按这份记录重试或结束运行。先核对节点命令里的 entryStatus。',
      },
    }),
  );
  assert.equal(broken.nodeStatus, 'running');
  assert.equal(broken.nodeStatusKey, 'record-broken');
  assert.equal(broken.nodeStatusText, '状态：节点记录异常，需要人工处理');
  assert.equal(broken.nodeStatusText.includes('执行中'), false);
  assert.equal(broken.primary.enabled, false);

  const refused = createAgentWorkspaceView(
    workspaceSnapshot({
      node: { status: 'needs-revision', version: 2, upstreamAffected: false },
      runs: [],
      lastError: {
        code: 'entry-inconsistent',
        objectLabel: '节点',
        reason: '读回的入口和节点状态对不上',
        nextStep: '不要按这份记录发送。先核对节点命令里的 entryStatus。',
      },
    }),
  );
  assert.equal(refused.nodeStatusText, '状态：需修改');
  assert.equal(refused.nodeStatusKey, 'needs-revision');
});

function workspaceSnapshot(overrides = {}) {
  const config = {
    id: 'cfg-1',
    expertId: 'api-impl',
    expertVersionId: 'api-impl-v1',
    expertLabel: '接口实现',
    expertSummary: '整理字段',
    expertEnabled: true,
    executorId: 'simulated',
    executorLabel: '模拟执行器',
    executorAvailable: true,
    executorVerified: false,
    simulated: true,
    modelLabel: '由模拟执行器声明：不连接真实模型',
    modelInheritance: 'executor-managed',
    modelCompatible: true,
    skills: [],
    mcp: [],
    attachmentIds: [],
    contextSummaries: [],
  };
  return {
    schema: 1,
    interactionReady: true,
    taskTitle: '企业客户门户季度交付',
    taskGoal: '完成开户闭环',
    actorId: 'chen-ning',
    handoff: {
      nodeId: 'node-fields',
      taskId: 'task-portal',
      workflowVersionId: 'plan-1',
      revision: 3,
      goal: '确认开户字段',
      assignee: { id: 'chen-ning', kind: 'human' },
      dependencyNodeIds: [],
      reviewRequired: true,
      reviewerIds: ['lin-ke'],
      inputRefs: [],
    },
    node: { status: 'running', version: 2, upstreamAffected: false },
    assignee: { id: 'chen-ning', kind: 'human' },
    runs: [
      {
        id: 'run-1',
        nodeId: 'node-fields',
        workflowVersionId: 'plan-1',
        planRevision: 3,
        attempt: 1,
        generation: 1,
        executor: 'simulated',
        status: 'running',
        contextRefs: [],
        lastEventSequence: 1,
        idempotencyKey: 'k1',
        payloadHash: 'h1',
        simulated: true,
        acknowledged: true,
        expertVersionId: 'api-impl-v1',
        configSnapshotId: 'cfg-1',
        stopPhase: 'none',
        entryNodeStatus: 'ready',
      },
    ],
    turns: [],
    interventions: [
      {
        id: 'queue-1',
        runId: 'run-1',
        kind: 'next-turn',
        phase: 'pending',
        body: '下一轮再改',
        idempotencyKey: 'q1',
        payloadHash: 'hq',
        notice: '执行器不支持实时注入，已转入下一轮队列。发送成功不等于已应用。',
      },
    ],
    lateRecords: [],
    activities: [],
    faults: [],
    attachments: [],
    drafts: [
      {
        nodeId: 'node-fields',
        text: '草稿',
        autoDeliver: false,
        skipReview: false,
        editable: true,
        review: {
          mode: 'new-round-required',
          roundId: 'round-2',
          previousRoundIds: ['round-1'],
          rejectOldRoundResults: true,
        },
      },
    ],
    recoveryRequests: [],
    downstreamLaunches: 0,
    delivered: false,
    resumeGap: null,
    lastError: null,
    reviewRounds: [],
    activeRoundId: null,
    config,
    contextItems: [
      {
        id: 'missing',
        kind: 'project-knowledge',
        sourceId: '外部映射表',
        version: '9',
        summary: '外部映射表',
        required: false,
        included: false,
        permission: 'granted',
        fileState: 'missing',
      },
    ],
    citations: [],
    contextBlocks: [],
    catalog: {
      experts: [
        {
          id: 'api-impl',
          versionId: 'api-impl-v1',
          label: '接口实现',
          summary: '整理字段',
          enabled: true,
          presetSkillIds: [],
          presetMcpIds: [],
        },
      ],
      skills: [],
      mcp: [],
      executors: [
        {
          id: 'simulated',
          label: '模拟执行器',
          available: true,
          verified: false,
          simulated: true,
        },
      ],
    },
    claims: [],
    ...overrides,
  };
}
