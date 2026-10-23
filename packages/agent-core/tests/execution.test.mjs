import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptRoundResult,
  acceptUserMessage,
  acknowledgeRun,
  admitExecutionSignal,
  advanceIntervention,
  assigneeAfterAgentAssist,
  executionTodoHint,
  mcpSelectionAuthorizesAllTools,
  normalizeActivity,
  openRunAttempt,
  prepareArtifactDraft,
  classifyExecutorFailure,
  presentExecutionFault,
  preservedTurnsAfterExpertSwitch,
  recoveryCommandFor,
  requestRunStop,
  routeLiveInput,
  settleExecutionRun,
  triggerMayCreateRun,
  validateExecutionConfig,
} from '@zhuma/agent-core';

const base = {
  nodeStatus: 'ready',
  runs: [],
  idempotencyKey: 'run-key',
  payloadHash: 'hash-1',
  executor: 'simulated',
  expertEnabled: true,
  executorConnected: true,
  trigger: 'explicit-run-request',
  nodeId: 'node-1',
  workflowVersionId: 'plan-1',
  planRevision: 3,
  contextRefs: ['goal:task@1'],
  expertVersionId: 'expert-v1',
  configSnapshotId: 'cfg-1',
  simulated: true,
  newRunId: 'run-1',
  modelLabel: '由模拟执行器声明：不连接真实模型',
};

test('契约：重复请求不创建第二次运行，刷新和切换视图也不调度', () => {
  const opened = openRunAttempt(base);
  assert.equal(opened.ok, true);
  assert.equal(opened.reused, false);
  assert.equal(opened.attempt.status, 'requested');
  assert.equal(opened.attempt.acknowledged, false);
  const replay = openRunAttempt({ ...base, runs: [opened.attempt], newRunId: 'run-2' });
  assert.equal(replay.reused, true);
  assert.equal(replay.attempt.id, 'run-1');
  const mismatch = openRunAttempt({
    ...base,
    runs: [opened.attempt],
    payloadHash: 'hash-2',
    newRunId: 'run-3',
  });
  assert.equal(mismatch.code, 'idempotency-mismatch');
  for (const trigger of ['view-refresh', 'view-switch', 'session-restore', 'late-event']) {
    assert.equal(triggerMayCreateRun(trigger), false);
    const refused = openRunAttempt({
      ...base,
      trigger,
      idempotencyKey: `k-${trigger}`,
      newRunId: `id-${trigger}`,
    });
    assert.equal(refused.code, 'trigger-does-not-schedule');
  }
});

test('契约：已完成节点、停用专家和断开的执行器都不会创建运行', () => {
  assert.equal(openRunAttempt({ ...base, nodeStatus: 'completed' }).code, 'node-already-completed');
  assert.equal(openRunAttempt({ ...base, expertEnabled: false }).code, 'expert-disabled');
  assert.equal(openRunAttempt({ ...base, executorConnected: false }).code, 'executor-disconnected');
  assert.equal(openRunAttempt({ ...base, executor: null }).code, 'executor-not-selected');
  const active = openRunAttempt(base).attempt;
  const second = openRunAttempt({
    ...base,
    runs: [{ ...active, status: 'running', acknowledged: true }],
    idempotencyKey: 'other',
    newRunId: 'run-2',
  });
  assert.equal(second.code, 'active-run-exists');
});

test('契约：执行回执之前节点不能算执行中，终态运行的迟到信号不改节点', () => {
  const requested = openRunAttempt(base).attempt;
  const refused = acknowledgeRun(requested, { accepted: false });
  assert.equal(refused.attempt.status, 'failed');
  assert.equal(refused.mayMarkNodeRunning, false);
  const accepted = acknowledgeRun(requested, { accepted: true, executorRunId: 'sim-1' });
  assert.equal(accepted.mayMarkNodeRunning, true);
  assert.equal(accepted.attempt.status, 'running');
  for (const status of ['completed', 'failed', 'cancelled']) {
    for (const signal of ['succeeded', 'failed', 'cancel-confirmed', 'output-arrived']) {
      const admission = admitExecutionSignal({
        runStatus: status,
        runId: 'run-1',
        runGeneration: 1,
        activeRunId: 'run-1',
        currentGeneration: 1,
        signal,
      });
      assert.equal(admission.disposition, 'attach-only', `${status} ${signal}`);
      assert.equal(admission.mayChangeNodeStatus, false);
      assert.equal(admission.mayTriggerDownstream, false);
      assert.equal(admission.mayUpdateRunRecord, false);
      assert.equal(admission.reason, 'terminal-run');
    }
  }
  const stale = admitExecutionSignal({
    runStatus: 'running',
    runId: 'run-1',
    runGeneration: 1,
    activeRunId: 'run-2',
    currentGeneration: 2,
    signal: 'succeeded',
  });
  assert.equal(stale.reason, 'stale-generation');
  assert.equal(stale.mayTriggerDownstream, false);
  const superseded = admitExecutionSignal({
    runStatus: 'running',
    runId: 'run-1',
    runGeneration: 2,
    activeRunId: 'run-2',
    currentGeneration: 2,
    signal: 'failed',
  });
  assert.equal(superseded.reason, 'superseded-run');
  assert.equal(superseded.mayChangeNodeStatus, false);
  const earlyFailure = admitExecutionSignal({
    runStatus: 'requested',
    runId: 'run-1',
    runGeneration: 1,
    activeRunId: 'run-1',
    currentGeneration: 1,
    signal: 'failed',
  });
  assert.equal(earlyFailure.disposition, 'apply');
  assert.equal(earlyFailure.mayChangeNodeStatus, false);
  assert.equal(earlyFailure.mayUpdateRunRecord, true);
  assert.equal(earlyFailure.mayTriggerDownstream, false);
  assert.equal(earlyFailure.suggestedTransition, undefined);
  const earlySuccess = admitExecutionSignal({
    runStatus: 'requested',
    runId: 'run-1',
    runGeneration: 1,
    activeRunId: 'run-1',
    currentGeneration: 1,
    signal: 'succeeded',
  });
  assert.equal(earlySuccess.disposition, 'attach-only');
  assert.equal(earlySuccess.mayUpdateRunRecord, false);
  assert.equal(earlySuccess.mayChangeNodeStatus, false);
  assert.equal(earlySuccess.mayTriggerDownstream, false);
  assert.equal(earlySuccess.reason, undefined);
  const runningFailure = admitExecutionSignal({
    runStatus: 'running',
    runId: 'run-1',
    runGeneration: 1,
    activeRunId: 'run-1',
    currentGeneration: 1,
    signal: 'failed',
  });
  assert.equal(runningFailure.disposition, 'apply');
  assert.equal(runningFailure.mayChangeNodeStatus, true);
  assert.equal(runningFailure.suggestedTransition, 'execution-failed');
});

test('契约：停止先等待回执，未确认的取消和结束后的回执都不改节点', () => {
  const running = { ...openRunAttempt(base).attempt, status: 'running', acknowledged: true };
  const requested = requestRunStop(running);
  assert.equal(requested.attempt.stopPhase, 'requested');
  assert.equal(requested.attempt.status, 'running');
  const unconfirmed = settleExecutionRun(running, 'cancelled');
  assert.equal(unconfirmed.code, 'cancel-unconfirmed');
  assert.equal(unconfirmed.mayChangeNodeStatus, false);
  assert.equal(unconfirmed.attempt.status, 'running');
  const confirmed = settleExecutionRun(requested.attempt, 'cancelled');
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.attempt.status, 'cancelled');
  assert.equal(confirmed.nodeTransition.type, 'cancel-confirmed');
  const quiet = settleExecutionRun(
    requestRunStop({ ...running, acknowledged: false, status: 'requested' }).attempt,
    'cancelled',
  );
  assert.equal(quiet.ok, true);
  assert.equal(quiet.nodeTransition.type, 'none');
  assert.equal(quiet.attempt.status, 'cancelled');
  const late = settleExecutionRun(confirmed.attempt, 'completed');
  assert.equal(late.code, 'terminal-run');
  assert.equal(late.mayChangeNodeStatus, false);
  assert.equal(late.attempt.status, 'cancelled');
  const finished = settleExecutionRun(running, 'completed');
  assert.equal(finished.nodeTransition.type, 'execution-finished');
  assert.equal(finished.nodeTransition.returnTo, 'ready');
  assert.equal(finished.attempt.status, 'completed');
  const lateFail = settleExecutionRun(finished.attempt, 'failed');
  assert.equal(lateFail.mayChangeNodeStatus, false);
  assert.equal(recoveryCommandFor('failed', 'ready').transition, 'retry');
  assert.equal(recoveryCommandFor('failed', 'needs-revision').returnTo, 'needs-revision');
  assert.equal(recoveryCommandFor('cancelled', 'ready').transition, 'restart');
  assert.equal(recoveryCommandFor('cancelled').ok, false);
  assert.equal(recoveryCommandFor('completed', 'ready').code, 'recovery-not-available');
});

test('契约：不支持实时注入时进入队列，发送成功不能直接变成已应用', () => {
  const queued = routeLiveInput({
    runStatus: 'running',
    supportsLiveInjection: false,
    intent: 'supplement',
  });
  assert.equal(queued.kind, 'next-turn');
  assert.equal(queued.queued, true);
  assert.match(queued.notice, /实时注入/);
  const jumped = advanceIntervention('sent', 'apply');
  assert.equal(jumped.code, 'send-is-not-adoption');
  let phase = advanceIntervention('sent', 'receive');
  phase = advanceIntervention(phase.phase, 'queue');
  assert.equal(phase.phase, 'pending');
  const applied = advanceIntervention(phase.phase, 'apply');
  assert.equal(applied.phase, 'applied');
  const duplicate = acceptUserMessage({
    idempotencyKey: 'm1',
    payloadHash: 'h',
    existing: [{ idempotencyKey: 'm1', payloadHash: 'h', id: 'q1' }],
  });
  assert.equal(duplicate.action, 'replay');
  const mismatch = acceptUserMessage({
    idempotencyKey: 'm1',
    payloadHash: 'other',
    existing: [{ idempotencyKey: 'm1', payloadHash: 'h', id: 'q1' }],
  });
  assert.equal(mismatch.action, 'mismatch');
});

test('契约：需修改必须进入新轮次，作废轮次和旧轮次结果不能推进', () => {
  const rejected = prepareArtifactDraft({
    nodeId: 'node-1',
    text: '修订说明',
    previousRoundIds: ['round-old'],
    existingRounds: [{ id: 'round-old', status: 'changes-requested' }],
    newRoundId: 'round-old',
  });
  assert.equal(rejected.code, 'old-round-rejected');
  const voided = prepareArtifactDraft({
    nodeId: 'node-1',
    text: '修订说明',
    previousRoundIds: [],
    existingRounds: [{ id: 'round-void', status: 'voided' }],
    newRoundId: 'round-void',
  });
  assert.equal(voided.code, 'voided-round');
  const draft = prepareArtifactDraft({
    nodeId: 'node-1',
    text: ' 新的草稿 ',
    previousRoundIds: ['round-old'],
    existingRounds: [{ id: 'round-old', status: 'changes-requested' }],
    newRoundId: 'round-new',
    producerRunId: 'run-1',
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.draft.autoDeliver, false);
  assert.equal(draft.draft.skipReview, false);
  assert.equal(draft.draft.review.rejectOldRoundResults, true);
  assert.equal(
    acceptRoundResult({ roundId: 'round-old', roundStatus: 'open', activeRoundId: 'round-new' })
      .code,
    'old-round-rejected',
  );
  assert.equal(
    acceptRoundResult({ roundId: 'round-new', roundStatus: 'voided', activeRoundId: 'round-new' })
      .code,
    'voided-round',
  );
  assert.equal(
    acceptRoundResult({ roundId: 'round-new', roundStatus: 'open', activeRoundId: 'round-new' }).ok,
    true,
  );
});

test('契约：故障分开呈现且不伪造运行，切换专家不丢历史，责任人不变', () => {
  for (const kind of [
    'model-error',
    'tool-failure',
    'network-interruption',
    'executor-disconnected',
    'expert-disabled',
    'attachment-rejected',
  ]) {
    const fault = presentExecutionFault(kind);
    assert.equal(fault.forgesRun, false);
    assert.notEqual(fault.objectLabel, '');
    assert.notEqual(fault.nextStep, '');
  }
  assert.notEqual(
    presentExecutionFault('model-error').objectLabel,
    presentExecutionFault('tool-failure').objectLabel,
  );
  assert.equal(presentExecutionFault('attachment-rejected').objectLabel, '附件');
  assert.notEqual(
    presentExecutionFault('attachment-rejected').objectLabel,
    presentExecutionFault('model-error').objectLabel,
  );
  assert.notEqual(
    presentExecutionFault('tool-failure').reason,
    presentExecutionFault('network-interruption').reason,
  );
  const turns = [
    { id: 't1', body: '第一轮' },
    { id: 't2', body: '第二轮' },
  ];
  const copied = preservedTurnsAfterExpertSwitch(turns);
  assert.equal(copied.length, 2);
  assert.equal(copied[0].id, 't1');
  assert.equal(copied[0].body, '第一轮');
  copied[0].body = '改写';
  assert.equal(turns[0].body, '第一轮');
  const originalNested = [{ id: 't3', body: '第三轮', attachmentIds: ['file-1'] }];
  const cloned = preservedTurnsAfterExpertSwitch(originalNested);
  cloned[0].attachmentIds.push('file-2');
  cloned[0].body = '改写';
  assert.deepEqual(originalNested[0].attachmentIds, ['file-1']);
  assert.equal(originalNested[0].body, '第三轮');
  assert.equal(classifyExecutorFailure('网络超时 ETIMEDOUT'), 'network-interruption');
  assert.equal(classifyExecutorFailure('工具调用失败'), 'tool-failure');
  assert.equal(classifyExecutorFailure('模型拒绝'), 'model-error');
  assert.equal(classifyExecutorFailure('尚未实现'), 'executor-disconnected');
  assert.equal(classifyExecutorFailure('未知错误'), 'executor-disconnected');
  assert.equal(classifyExecutorFailure('Unexpected token { in JSON'), 'model-error');
  assert.equal(classifyExecutorFailure('text/event-stream'), 'model-error');
  assert.equal(classifyExecutorFailure('请求超时'), 'network-interruption');
  assert.equal(classifyExecutorFailure('socket hang up'), 'network-interruption');
  assert.deepEqual(assigneeAfterAgentAssist({ id: 'chen-ning', kind: 'human' }), {
    id: 'chen-ning',
    kind: 'human',
  });
  const activity = normalizeActivity({
    id: 'a1',
    runId: 'run-1',
    title: '模拟',
    detail: '工具',
    simulated: true,
    succeeded: true,
  });
  assert.equal(activity.succeeded, false);
  assert.equal(mcpSelectionAuthorizesAllTools(), false);
  assert.equal(
    executionTodoHint({ nodeStatus: 'running', stopPhase: 'requested' }).nextAction,
    'wait-for-stop-receipt',
  );
  assert.equal(executionTodoHint({ nodeStatus: 'waiting-for-input' }).nextAction, 'supply-input');
  assert.equal(executionTodoHint({ nodeStatus: 'failed' }).nextAction, 'retry');
  assert.equal(executionTodoHint({ nodeStatus: 'completed' }).nextAction, 'none');
  assert.equal(executionTodoHint({ nodeStatus: 'ready' }).nextAction, 'edit-or-send');
  assert.equal(
    executionTodoHint({ nodeStatus: 'needs-revision' }).nextAction,
    'revise-in-new-round',
  );
  assert.equal(executionTodoHint({ nodeStatus: 'cancelled' }).nextAction, 'restart');
  assert.equal(
    executionTodoHint({
      nodeStatus: 'running',
      actorId: 'chen-ning',
      assignee: { id: 'chen-ning', kind: 'human' },
    }).nextAction,
    'continue-agent',
  );
  assert.equal(
    executionTodoHint({ nodeStatus: 'ready', runStatus: 'waiting-for-input' }).nextAction,
    'supply-input',
  );
});

test('契约：模拟配置不能声称真实模型已经生效', () => {
  const issues = validateExecutionConfig({
    id: 'cfg',
    expertId: 'ex',
    expertVersionId: 'ex-v',
    expertLabel: '接口实现',
    expertSummary: '字段',
    expertEnabled: true,
    executorId: 'simulated',
    executorLabel: '模拟执行器',
    executorAvailable: true,
    executorVerified: false,
    simulated: true,
    modelLabel: 'sample-model',
    modelInheritance: 'node-override',
    modelCompatible: true,
    modelId: 'sample-model',
    skills: [],
    mcp: [
      {
        id: 'mcp',
        version: '1',
        label: '文档',
        origin: 'added',
        available: true,
        toolsAuthorized: true,
        explicitToolGrant: false,
      },
    ],
    attachmentIds: [],
    contextSummaries: [],
  });
  assert.equal(issues.ok, false);
  assert.ok(issues.issues.some((issue) => issue.code === 'model-claims-real-success'));
  assert.ok(issues.issues.some((issue) => issue.code === 'mcp-not-auto-authorized'));
});

test('契约：simulated 不是未配置时的回退', () => {
  const issues = validateExecutionConfig({
    id: 'cfg',
    expertId: 'ex',
    expertVersionId: 'ex-v',
    expertLabel: '接口实现',
    expertSummary: '字段',
    expertEnabled: true,
    executorId: 'dsh',
    executorLabel: 'DSH',
    executorAvailable: true,
    executorVerified: false,
    simulated: false,
    modelLabel: '',
    modelInheritance: 'executor-managed',
    modelCompatible: false,
    skills: [],
    mcp: [],
    attachmentIds: [],
    contextSummaries: [],
  });
  assert.equal(issues.ok, false);
  assert.equal(
    issues.issues.some((issue) => issue.code === 'executor-unverified'),
    true,
  );
  assert.equal(
    issues.issues.some((issue) => issue.code === 'simulated-mismatch'),
    false,
  );
});
