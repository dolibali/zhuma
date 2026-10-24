import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

  for (const status of ['failed', 'cancelled']) {
    const closed = createAgentWorkspaceView(
      workspaceSnapshot({
        node: { status, version: 3, upstreamAffected: false },
        runs: [{ ...base.runs[0], status }],
        downstreamLaunches: 0,
        lastError: {
          code: 'entry-inconsistent',
          objectLabel: '节点',
          reason: '节点记录异常，需要人工处理',
          nextStep: '不要按这份记录重试或结束运行。先核对节点命令里的 entryStatus。',
        },
      }),
    );
    assert.equal(closed.nodeStatus, status);
    assert.equal(closed.nodeStatusKey, 'record-broken', status);
    assert.match(closed.nodeStatusText, /节点记录异常/, status);
    assert.equal(
      closed.nextAction,
      '不要按这份记录重试或结束运行。先核对节点命令里的 entryStatus。',
      status,
    );
    assert.equal(closed.retry.visible, true, status);
    assert.equal(closed.retry.enabled, false, status);
    assert.equal(closed.primary.enabled, false, status);
  }
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

test('契约：会话历史没有带入时，投影写出说明', () => {
  const noted = createAgentWorkspaceView(
    workspaceSnapshot({ historyNote: '没有带上之前的历史。' }),
  );
  assert.equal(noted.historyNote, '没有带上之前的历史。');
  assert.equal(createAgentWorkspaceView(workspaceSnapshot()).historyNote, null);
});

test('契约：已丢弃的会话在运行记录上标出，取消后的空执行器气泡不显示', () => {
  const snapshot = workspaceSnapshot();
  snapshot.runs[0].status = 'cancelled';
  snapshot.runs[0].sessionId = 'zhuma-old';
  snapshot.runs[0].sessionDiscarded = true;
  snapshot.turns = [
    {
      id: 'turn-empty',
      runId: 'run-1',
      nodeId: 'node-fields',
      role: 'executor',
      body: '',
      attachmentIds: [],
      expertVersionId: 'api-impl-v1',
      configSnapshotId: 'cfg-1',
      simulated: false,
      sequence: 1,
    },
    {
      id: 'turn-user',
      runId: 'run-1',
      nodeId: 'node-fields',
      role: 'user',
      body: '停止',
      attachmentIds: [],
      expertVersionId: 'api-impl-v1',
      configSnapshotId: 'cfg-1',
      simulated: false,
      sequence: 2,
    },
  ];
  snapshot.activities = [
    {
      id: 'mcp-1',
      runId: 'run-1',
      title: 'MCP',
      detail: '接口文档只读：未连接。没有配置传输，不会连接外部服务。',
      simulated: false,
      succeeded: false,
    },
    {
      id: 'mcp-2',
      runId: 'run-2',
      title: 'MCP',
      detail: '接口文档只读：未连接。没有配置传输，不会连接外部服务。',
      simulated: false,
      succeeded: false,
    },
  ];
  const view = createAgentWorkspaceView(snapshot);
  assert.equal(view.runs[0].sessionDiscarded, true);
  assert.equal(
    view.turns.some((turn) => turn.role === 'executor'),
    false,
  );
  assert.equal(
    view.turns.some((turn) => turn.role === 'user'),
    true,
  );
  assert.equal(view.activities.filter((item) => item.title === 'MCP').length, 1);
});

test('契约：接收回执之前显示启动中', () => {
  const snapshot = workspaceSnapshot();
  snapshot.node = { status: 'ready', version: 1, upstreamAffected: false };
  snapshot.runs[0].status = 'requested';
  snapshot.runs[0].acknowledged = false;
  const view = createAgentWorkspaceView(snapshot);
  assert.equal(view.nodeStatusText, '状态：启动中');
  assert.equal(view.nodeStatusKey, 'starting');
  assert.equal(view.nodeStatusText.includes('执行中'), false);
  const running = createAgentWorkspaceView(workspaceSnapshot());
  assert.equal(running.nodeStatusText, '状态：执行中');
});

test('契约：持久化故障出现在投影里', () => {
  const snapshot = workspaceSnapshot();
  assert.equal(createAgentWorkspaceView(snapshot).persistenceFault, null);
  snapshot.persistenceFault = {
    code: 'persist-failed',
    objectLabel: '日志',
    reason: `日志没有写进去（EACCES）。EACCES: permission denied ${path.join(tmpdir(), 'zhuma-secret', 'session.json')}`,
    nextStep: '存储恢复后重写这份日志。重写成功前，不要把界面上的运行当成已经受理或已经落盘。',
  };
  snapshot.lastError = {
    code: 'persist-failed',
    objectLabel: '日志',
    reason: snapshot.persistenceFault.reason,
    nextStep: snapshot.persistenceFault.nextStep,
  };
  const view = createAgentWorkspaceView(snapshot);
  assert.equal(view.error, null);
  assert.equal(view.persistenceFault.objectLabel, '日志');
  assert.equal(view.persistenceFault.reason, '日志没有写进去（EACCES）。EACCES: permission denied');
  assert.equal(view.persistenceFault.reason.includes(tmpdir()), false);
  assert.equal(
    view.persistenceFault.reason.includes(path.join(tmpdir(), 'zhuma-secret', 'session.json')),
    false,
  );
  assert.match(view.persistenceFault.nextStep, /重写/);
  snapshot.lastError = {
    code: 'entry-inconsistent',
    objectLabel: '节点',
    reason: '节点记录异常，需要人工处理',
    nextStep: '不要按这份记录重试或结束运行。',
  };
  const distinct = createAgentWorkspaceView(snapshot);
  assert.equal(distinct.error.reason, '节点记录异常，需要人工处理');
  assert.equal(distinct.persistenceFault.objectLabel, '日志');
});

test('契约：没有字节的附件标成需重新上传', () => {
  const snapshot = workspaceSnapshot();
  snapshot.attachments = [
    {
      id: 'file-1',
      name: 'context.txt',
      mediaType: 'text/plain',
      byteSize: 5,
      checksum: 'abc',
      reference: 'attachment:file-1',
      contentAvailable: false,
    },
  ];
  const view = createAgentWorkspaceView(snapshot);
  assert.equal(view.attachments[0].reupload, true);
  assert.equal(view.attachments[0].name, 'context.txt');
});
