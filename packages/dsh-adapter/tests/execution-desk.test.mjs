import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DshChatExecutor,
  ExecutionDesk,
  SimulatedAgentExecutor,
  UnimplementedNativeExecutor,
  createFileJournal,
  createWorkbenchServer,
  probeRelativeFile,
  readDshModelConfig,
  selectAgentExecutor,
} from '@zhuma/dsh-adapter';
import { createAgentWorkspaceView } from '../../client/dist/index.js';

function ids() {
  let n = 0;
  return (prefix) => `${prefix}-${++n}`;
}

function seed(overrides = {}) {
  return {
    handoff: {
      nodeId: 'node-fields',
      taskId: 'task-portal',
      workflowVersionId: 'plan-1',
      revision: 3,
      goal: '确认企业开户字段与校验规则',
      assignee: { id: 'chen-ning', kind: 'human' },
      dependencyNodeIds: [],
      reviewRequired: true,
      reviewerIds: ['lin-ke'],
      inputRefs: [],
      expertRef: { id: 'api-impl', version: 'api-impl-v1' },
      skillRefs: [],
      mcpRefs: [],
      inputNote: '',
      expectedOutput: '',
    },
    taskTitle: '企业客户门户季度交付',
    taskGoal: '完成企业客户开户闭环',
    actorId: 'chen-ning',
    nodeStatus: 'ready',
    catalog: {
      experts: [
        {
          id: 'api-impl',
          versionId: 'api-impl-v1',
          label: '接口实现',
          summary: '整理接口字段',
          enabled: true,
          presetSkillIds: ['test-design'],
          presetMcpIds: ['api-docs'],
        },
        {
          id: 'reviewer',
          versionId: 'reviewer-v2',
          label: '评审专家',
          summary: '核对交付',
          enabled: true,
          presetSkillIds: [],
          presetMcpIds: [],
        },
        {
          id: 'retired',
          versionId: 'retired-v1',
          label: '停用专家',
          summary: '不可用',
          enabled: false,
          unavailableReason: '专家已停用',
          presetSkillIds: [],
          presetMcpIds: [],
        },
      ],
      skills: [
        { id: 'test-design', version: '1', label: '测试设计', available: true },
        { id: 'review-code', version: '1', label: '代码审阅', available: true },
        {
          id: 'legacy',
          version: '1',
          label: '旧检索',
          available: false,
          unavailableReason: '资产已停用',
        },
      ],
      mcp: [
        { id: 'api-docs', version: '1', label: '接口文档只读', available: true },
        { id: 'issue-search', version: '1', label: '工单检索', available: true },
      ],
      executors: [
        {
          id: 'simulated',
          label: '模拟执行器',
          available: true,
          verified: false,
          simulated: true,
        },
        {
          id: 'dsh',
          label: 'DSH 原生',
          available: false,
          verified: false,
          simulated: false,
          unavailableReason: 'DSH 执行器尚未实现，也未验证',
        },
      ],
    },
    contextItems: [
      {
        id: 'goal',
        kind: 'goal',
        sourceId: 'task-portal',
        version: '3',
        permission: 'granted',
        summary: '确认企业开户字段',
        required: true,
        includedByDefault: true,
      },
      {
        id: 'parent',
        kind: 'parent-goal',
        sourceId: 'task-parent',
        version: '1',
        permission: 'granted',
        summary: '企业客户门户季度交付',
        required: true,
        includedByDefault: true,
      },
      {
        id: 'missing',
        kind: 'project-knowledge',
        sourceId: '外部映射表',
        version: '9',
        permission: 'granted',
        summary: '外部映射表',
        required: false,
        includedByDefault: false,
        relativePath: 'missing.csv',
      },
    ],
    reviewRounds: [{ id: 'round-old', status: 'changes-requested' }],
    ...overrides,
  };
}

function desk(options = {}) {
  const simulated = new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 });
  const created = ExecutionDesk.create(seed(options.seed), {
    executors: [
      simulated,
      new UnimplementedNativeExecutor('dsh'),
      new UnimplementedNativeExecutor('codearts-cli'),
    ],
    newId: ids(),
    probe(relativePath) {
      if (relativePath === 'missing.csv') return { ok: true, exists: false, readable: false };
      return { ok: true, exists: true, readable: true };
    },
    journal: options.journal,
  });
  created.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  return { desk: created, simulated };
}

test('契约：未显式选择模拟执行器时不降级，真实执行器未实现时不伪造运行', async () => {
  const simulated = new SimulatedAgentExecutor();
  assert.throws(() => selectAgentExecutor('dsh', [simulated]), /不会静默改用模拟执行器/);
  const native = new UnimplementedNativeExecutor('dsh');
  await assert.rejects(async () => {
    for await (const _event of native.run()) void _event;
  }, /尚未实现/);
  const { desk: session } = desk();
  session.updateConfig({ executorId: null });
  const missing = session.send({ text: '开始', idempotencyKey: 'k-missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.snapshot.runs.length, 0);
  session.updateConfig({ executorId: 'dsh' });
  const unverified = session.send({ text: '开始', idempotencyKey: 'k-dsh' });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.snapshot.runs.length, 0);
  assert.equal(unverified.snapshot.delivered, false);
});

test('契约：重复发送、上下文阻塞、两轮修改、刷新和切换专家', async () => {
  const journalState = { value: null };
  const journal = {
    load: () => journalState.value,
    save: (value) => {
      journalState.value = JSON.parse(JSON.stringify(value));
    },
  };
  const { desk: session } = desk({ journal });
  const before = session.snapshot().runs.length;
  session.snapshot();
  session.snapshot();
  assert.equal(session.snapshot().runs.length, before);
  assert.equal(session.viewDidNotSchedule(), true);
  session.setContextIncluded('missing', true);
  const blocked = session.send({ text: '带上缺失文件', idempotencyKey: 'k-block' });
  assert.equal(blocked.code, 'context-blocked');
  assert.equal(blocked.snapshot.runs.length, 0);
  assert.match(blocked.reason, /外部映射表|missing-file/);
  assert.equal(JSON.stringify(blocked.snapshot).includes('missing.csv'), false);
  session.setContextIncluded('missing', false);
  const first = session.send({ text: '整理开户字段', idempotencyKey: 'k1', attachmentIds: [] });
  assert.equal(first.ok, true);
  const duplicate = session.send({ text: '整理开户字段', idempotencyKey: 'k1' });
  assert.equal(duplicate.replayed, true);
  assert.equal(session.snapshot().runs.length, 1);
  await session.waitForRun(first.runId, 'running');
  assert.equal(session.snapshot().node.status, 'running');
  assert.equal(session.snapshot().config.simulated, true);
  session.releaseActive();
  await session.flush();
  assert.equal(session.snapshot().runs[0].status, 'completed');
  assert.equal(session.snapshot().node.status, 'ready');
  assert.equal(session.snapshot().delivered, false);
  assert.equal(session.snapshot().downstreamLaunches, 0);
  const second = session.send({ text: '补充统一社会信用代码', idempotencyKey: 'k2' });
  await session.waitForRun(second.runId, 'running');
  session.releaseActive();
  await session.flush();
  assert.equal(session.snapshot().runs.length, 2);
  assert.equal(session.snapshot().turns.filter((turn) => turn.role === 'user').length, 2);
  const restored = ExecutionDesk.restore(journalState.value, {
    executors: [
      new SimulatedAgentExecutor({ pauseAfterAccept: true }),
      new UnimplementedNativeExecutor('dsh'),
    ],
    newId: ids(),
    probe: () => ({ ok: true, exists: true, readable: true }),
  });
  assert.equal(restored.snapshot().interactionReady, false);
  assert.equal(restored.snapshot().runs.length, 2);
  const refused = restored.send({ text: '恢复期间', idempotencyKey: 'k-restore' });
  assert.equal(refused.code, 'restore-facts-first');
  assert.equal(restored.snapshot().runs.length, 2);
  restored.resumeInteraction();
  const turnsBefore = restored.snapshot().turns.length;
  restored.updateConfig({ expertId: 'reviewer' });
  assert.equal(restored.snapshot().turns.length, turnsBefore);
  assert.equal(restored.snapshot().config.expertVersionId, 'reviewer-v2');
  assert.equal(restored.snapshot().assignee.id, 'chen-ning');
  const roundsBefore = restored.snapshot().reviewRounds.length;
  const draft = restored.saveDraft('手工修订后的字段说明');
  assert.equal(draft.ok, true);
  assert.equal(draft.snapshot.drafts[0].autoDeliver, false);
  assert.equal(draft.snapshot.drafts[0].skipReview, false);
  assert.equal(draft.snapshot.node.status, 'ready');
  assert.notEqual(draft.snapshot.drafts[0].review.roundId, 'round-old');
  assert.equal(draft.snapshot.reviewRounds.length, roundsBefore);
  const again = restored.saveDraft('第二次只替换草稿');
  assert.equal(again.ok, true);
  assert.equal(again.snapshot.drafts.length, 1);
  assert.equal(again.snapshot.drafts[0].text, '第二次只替换草稿');
  assert.equal(again.snapshot.drafts[0].review.roundId, draft.snapshot.drafts[0].review.roundId);
  assert.equal(again.snapshot.reviewRounds.length, roundsBefore);
  const old = restored.acceptReviewResult('round-old', 'open');
  assert.equal(old.code, 'old-round-rejected');
  assert.equal(restored.snapshot().node.status, 'ready');
});

test('契约：补充进入队列，停止有回执，迟到结果不推进，重试使用新的运行', async () => {
  const { desk: session } = desk();
  const started = session.send({ text: '第一轮', idempotencyKey: 'run-a' });
  await session.waitForRun(started.runId, 'running');
  const queued = session.send({
    text: '补充异常分支',
    idempotencyKey: 'queue-1',
    intent: 'supplement',
  });
  assert.equal(queued.ok, true);
  const intervention = queued.snapshot.interventions[0];
  assert.equal(intervention.phase, 'pending');
  assert.match(intervention.notice, /实时注入/);
  assert.equal(intervention.phase === 'applied', false);
  const runsDuring = queued.snapshot.runs.length;
  const stopped = await session.stop();
  assert.equal(stopped.ok, true);
  const snapshot = stopped.snapshot;
  assert.equal(snapshot.node.status, 'cancelled');
  assert.equal(snapshot.runs[0].status, 'cancelled');
  assert.equal(snapshot.runs[0].stopPhase, 'confirmed');
  assert.equal(snapshot.lateRecords.length > 0, true);
  assert.equal(
    snapshot.lateRecords.every((record) => record.mayChangeNodeStatus === false),
    true,
  );
  assert.equal(
    snapshot.lateRecords.every((record) => record.mayTriggerDownstream === false),
    true,
  );
  assert.equal(snapshot.downstreamLaunches, 0);
  assert.equal(snapshot.delivered, false);
  assert.equal(snapshot.interventions[0].phase, 'not-applied');
  assert.equal(snapshot.interventions[0].body, '补充异常分支');
  assert.match(snapshot.interventions[0].notice, /未应用/);
  assert.equal(snapshot.runs.length, runsDuring);
  assert.equal(
    snapshot.activities.every((activity) => activity.succeeded === false),
    true,
  );
  const retried = session.retry('retry-1');
  assert.equal(retried.ok, true);
  assert.notEqual(retried.runId, started.runId);
  await session.waitForRun(retried.runId, 'running');
  assert.equal(session.snapshot().runs.length, 2);
  assert.equal(session.snapshot().lateRecords[0].runId, started.runId);
  session.releaseActive();
  await session.flush();
  assert.equal(session.snapshot().downstreamLaunches, 0);
  assert.notEqual(session.snapshot().node.status, 'completed');
});

test('契约：服务重启先恢复事实，专家停用和执行器断开不伪造运行', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-'));
  const file = path.join(directory, 'session.json');
  const journal = createFileJournal(file);
  const { desk: session } = desk({ journal });
  const started = session.send({ text: '保持运行', idempotencyKey: 'held' });
  await session.waitForRun(started.runId, 'running');
  const saved = journal.load();
  const restored = ExecutionDesk.restore(saved, {
    executors: [
      new SimulatedAgentExecutor({ pauseAfterAccept: true }),
      new UnimplementedNativeExecutor('dsh'),
    ],
    newId: ids(),
    probe: () => ({ ok: true, exists: true, readable: true }),
  });
  assert.equal(restored.snapshot().runs[0].status, 'running');
  assert.equal(restored.snapshot().resumeGap.reason, 'session-not-resumed');
  assert.equal(restored.snapshot().node.status, 'running');
  restored.resumeInteraction();
  const verified = restored.verifyAbandoned();
  assert.equal(verified.ok, true);
  assert.equal(verified.snapshot.node.status, 'failed');
  assert.equal(verified.snapshot.faults[0].kind, 'executor-disconnected');
  assert.equal(verified.snapshot.faults[0].forgesRun, false);
  assert.equal(verified.snapshot.delivered, false);
  const { desk: another } = desk();
  another.setAvailability({ expertId: 'api-impl', enabled: false });
  const disabled = another.send({ text: '不应运行', idempotencyKey: 'disabled' });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.snapshot.runs.length, 0);
  another.setAvailability({ expertId: 'api-impl', enabled: true });
  another.updateConfig({ executorId: 'simulated' });
  another.setAvailability({ executorId: 'simulated', connected: false });
  const disconnected = another.send({ text: '不应运行', idempotencyKey: 'disconnected' });
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.snapshot.runs.length, 0);
});

test('契约：文件探针拒绝逃出工作区的路径，且不返回绝对路径', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-files-'));
  writeFileSync(path.join(directory, 'spec.md'), '字段规范');
  const readable = probeRelativeFile(directory, 'spec.md');
  assert.deepEqual(readable, { ok: true, exists: true, readable: true });
  assert.equal(probeRelativeFile(directory, '../spec.md').code, 'path-rejected');
  assert.equal(probeRelativeFile(directory, '/etc/passwd').code, 'path-rejected');
  assert.equal(JSON.stringify(readable).includes(directory), false);
  const missing = probeRelativeFile(directory, 'missing.csv');
  assert.deepEqual(missing, { ok: true, exists: false, readable: false });
  assert.equal(readFileSync(path.join(directory, 'spec.md'), 'utf8'), '字段规范');
  symlinkSync('/etc/passwd', path.join(directory, 'escape.md'));
  assert.equal(probeRelativeFile(directory, 'escape.md').code, 'path-rejected');
  symlinkSync(path.join(directory, 'spec.md'), path.join(directory, 'inside.md'));
  assert.deepEqual(probeRelativeFile(directory, 'inside.md'), {
    ok: true,
    exists: true,
    readable: true,
  });
});

test('契约：队列按顺序消费每一条，同一请求在更换技能后仍然重放', async () => {
  const { desk: session } = desk();
  const started = session.send({ text: '第一轮', idempotencyKey: 'fifo-run' });
  await session.waitForRun(started.runId, 'running');
  session.send({ text: '补充一', idempotencyKey: 'q1', intent: 'supplement' });
  session.send({ text: '补充二', idempotencyKey: 'q2', intent: 'supplement' });
  assert.equal(session.snapshot().interventions.length, 2);
  session.releaseActive();
  await session.flush();
  const second = session.snapshot().runs[1];
  await session.waitForRun(second.id, 'running');
  const mid = session.snapshot();
  assert.equal(mid.interventions.find((item) => item.body === '补充一').phase, 'applied');
  const rest = mid.interventions.find((item) => item.body === '补充二');
  assert.equal(rest.phase, 'pending');
  assert.equal(rest.runId, second.id);
  session.releaseActive();
  await session.flush();
  const third = session.snapshot().runs[2];
  await session.waitForRun(third.id, 'running');
  assert.equal(
    session.snapshot().interventions.find((item) => item.body === '补充二').phase,
    'applied',
  );
  session.releaseActive();
  await session.flush();
  session.updateConfig({ skillIds: ['review-code'] });
  const replay = session.send({ text: '第一轮', idempotencyKey: 'fifo-run' });
  assert.equal(replay.replayed, true);
  assert.equal(
    session.snapshot().runs.filter((run) => run.idempotencyKey === 'fifo-run').length,
    1,
  );
});

test('契约：等待输入结束后回到入口状态，未知附件不创建运行', async () => {
  const { desk: session } = desk();
  const started = session.send({ text: '等待后再结束', idempotencyKey: 'wait-finish' });
  await session.waitForRun(started.runId, 'running');
  const waiting = session.markWaitingForInput();
  assert.equal(waiting.ok, true);
  assert.equal(waiting.snapshot.node.status, 'waiting-for-input');
  session.releaseActive();
  await session.flush();
  assert.equal(session.snapshot().runs[0].status, 'completed');
  assert.equal(session.snapshot().node.status, 'ready');
  const missing = session.send({
    text: '带上不存在的附件',
    idempotencyKey: 'missing-file',
    attachmentIds: ['no-such-file'],
  });
  assert.equal(missing.code, 'unknown-attachment');
  assert.equal(missing.snapshot.runs.length, 1);
});

test('契约：重启后的未结束运行不再显示为可发送，停止不会改写停止阶段', async () => {
  const journalState = { value: null };
  const journal = {
    load: () => journalState.value,
    save: (value) => {
      journalState.value = JSON.parse(JSON.stringify(value));
    },
  };
  const { desk: session } = desk({ journal });
  const started = session.send({ text: '保持运行', idempotencyKey: 'gap-run' });
  await session.waitForRun(started.runId, 'running');
  const restored = ExecutionDesk.restore(journal.load(), {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true })],
    newId: ids(),
  });
  restored.resumeInteraction();
  const sent = restored.send({ text: '不要发', idempotencyKey: 'gap-send' });
  assert.equal(sent.code, 'resume-gap');
  assert.equal(sent.snapshot.runs.length, 1);
  assert.equal(sent.snapshot.runs[0].stopPhase, 'none');
  const stopped = await restored.stop();
  assert.equal(stopped.code, 'resume-gap');
  assert.equal(stopped.snapshot.runs[0].stopPhase, 'none');
  assert.equal(stopped.snapshot.runs[0].status, 'running');
});

test('契约：未知运行的取消立即返回，提前释放不会卡住', async () => {
  const executor = new SimulatedAgentExecutor({ pauseAfterAccept: true });
  const started = Date.now();
  const missing = await executor.cancel('missing-run');
  assert.equal(missing.receipt, 'rejected');
  assert.equal(Date.now() - started < 1000, true);
  executor.release('run-early');
  const events = [];
  for await (const event of executor.run(runRequest('run-early'))) {
    events.push(event.type);
  }
  assert.equal(events.includes('completed'), true);
  assert.equal(events.includes('accepted'), true);
});

test('契约：缺少模型配置时 DSH 明确失败且不降级', async () => {
  const missing = readDshModelConfig({});
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /ZHUMA_MODEL_BASE_URL/);
  assert.match(missing.reason, /ZHUMA_MODEL_API_KEY/);
  assert.equal(missing.reason.includes('http'), false);
  const executor = new DshChatExecutor({});
  assert.equal(executor.capabilities.verified, false);
  await assert.rejects(async () => {
    for await (const event of executor.run(runRequest('dsh-missing'))) void event;
  }, /ZHUMA_MODEL_BASE_URL/);
  const unknown = await executor.cancel('dsh-missing');
  assert.equal(unknown.receipt, 'rejected');
  const badModel = readDshModelConfig({
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1',
    ZHUMA_MODEL_API_KEY: 'test-key',
    ZHUMA_MODEL_ID: 'not-a-model',
  });
  assert.equal(badModel.ok, false);
  const configured = readDshModelConfig({
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1/',
    ZHUMA_MODEL_API_KEY: 'test-key',
  });
  assert.equal(configured.ok, true);
  assert.equal(configured.config.modelId, 'zhanlu/glm-5.3-flash');
  assert.equal(configured.config.baseUrl.endsWith('/'), false);
  const { desk: session } = desk();
  session.updateConfig({ executorId: 'dsh' });
  const refused = session.send({ text: '不要调用', idempotencyKey: 'dsh-refused' });
  assert.equal(refused.ok, false);
  assert.equal(refused.snapshot.runs.length, 0);
  assert.match(refused.reason, /尚未实现|尚未验证|ZHUMA_MODEL_BASE_URL|不可用/);
});

test('契约：跨站 POST 被拒绝，没有 Origin 的请求可以进入', async () => {
  const session = ExecutionDesk.create(seed(), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  const server = createWorkbenchServer({
    desk: session,
    present: (snapshot) => ({ runs: snapshot.runs.length }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    const cross = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(cross.status, 403);
    const local = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executorId: 'simulated' }),
    });
    assert.equal(local.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('契约：停止回执超时后不把节点标成已取消', async () => {
  const hanging = {
    id: 'simulated',
    capabilities: {
      liveInjection: false,
      sessionResume: false,
      cancelReceipt: true,
      streaming: false,
      verified: false,
      mode: 'simulated',
    },
    async *run(request) {
      yield { type: 'accepted', executorRunId: `held-${request.runId}`, simulated: true };
      await new Promise(() => {});
    },
    cancel() {
      return new Promise(() => {});
    },
  };
  const session = ExecutionDesk.create(seed(), {
    executors: [hanging],
    newId: ids(),
  });
  session.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  const started = session.send({ text: '卡住', idempotencyKey: 'hang' });
  await session.waitForRun(started.runId, 'running');
  const stopped = await session.stop();
  assert.equal(stopped.code, 'stop-receipt-missing');
  assert.equal(stopped.snapshot.node.status, 'running');
  assert.equal(stopped.snapshot.runs[0].status, 'running');
  assert.equal(stopped.snapshot.runs[0].stopPhase, 'receipt-rejected');
});

test('契约：重新开始只带回节点记下的需修改入口', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-entry-'));
  const journal = createFileJournal(path.join(directory, 'session.json'));
  const { desk: session } = desk({ journal, seed: { nodeStatus: 'needs-revision' } });
  const started = session.send({ text: '按退回意见再跑', idempotencyKey: 'rev-run' });
  await session.waitForRun(started.runId, 'running');
  const stopped = await session.stop();
  assert.equal(stopped.ok, true);
  const saved = journal.load();
  assert.equal(saved.nodeState.status, 'cancelled');
  assert.equal(saved.nodeState.entryStatus, 'needs-revision');
  saved.runs[0].entryNodeStatus = 'ready';
  const restored = ExecutionDesk.restore(saved, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
    journal,
  });
  restored.resumeInteraction();
  const retried = restored.retry('retry-revision');
  assert.equal(retried.ok, true);
  await restored.waitForRun(retried.runId, 'running');
  assert.equal(journal.load().nodeState.entryStatus, 'needs-revision');
  assert.equal(journal.load().nodeState.status, 'running');

  const blocked = journal.load();
  delete blocked.nodeState.entryStatus;
  blocked.nodeState.status = 'cancelled';
  const missing = ExecutionDesk.restore(blocked, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
  });
  missing.resumeInteraction();
  const refused = missing.retry('retry-missing-entry');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'recovery-not-available');
  assert.equal(missing.snapshot().node.status, 'cancelled');
  assert.equal(missing.snapshot().runs.length, blocked.runs.length);
});

test('契约：新建节点命令带上入口，读回不一致时不改写也不信任', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-entry-init-'));
  const journal = createFileJournal(path.join(directory, 'session.json'));
  desk({ journal });
  const created = journal.load();
  assert.equal(created.nodeState.status, 'ready');
  assert.equal(created.nodeState.entryStatus, 'ready');

  const revisionDir = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-entry-rev-'));
  const revisionJournal = createFileJournal(path.join(revisionDir, 'session.json'));
  desk({ journal: revisionJournal, seed: { nodeStatus: 'needs-revision' } });
  assert.equal(revisionJournal.load().nodeState.entryStatus, 'needs-revision');

  created.nodeState.status = 'needs-revision';
  created.nodeState.entryStatus = 'ready';
  const restored = ExecutionDesk.restore(created, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
  });
  assert.equal(restored.snapshot().lastError.code, 'entry-inconsistent');
  assert.equal(restored.snapshot().node.status, 'needs-revision');
  assert.equal(created.nodeState.entryStatus, 'ready');
  restored.resumeInteraction();
  const retried = restored.retry('retry-inconsistent');
  assert.equal(retried.ok, false);
  assert.equal(retried.code, 'recovery-not-available');
  assert.equal(restored.snapshot().node.status, 'needs-revision');
});

test('契约：运行结束的 returnTo 等于记下的入口', async () => {
  const { desk: session } = desk({ seed: { nodeStatus: 'needs-revision' } });
  const started = session.send({ text: '结束时对一下入口', idempotencyKey: 'finish-entry' });
  await session.waitForRun(started.runId, 'running');
  const index = session.runs.findIndex((item) => item.id === started.runId);
  session.runs[index] = { ...session.runs[index], entryNodeStatus: 'ready' };
  session.releaseActive();
  await session.flush();
  assert.equal(session.snapshot().runs[0].status, 'completed');
  assert.equal(session.snapshot().node.status, 'needs-revision');
});

test('契约：入口、版本、评审轮次和幂等回执随正式命令落盘', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-command-journal-'));
  const journal = createFileJournal(path.join(directory, 'session.json'));
  const { desk: session } = desk({ journal });
  const before = journal.load();
  assert.equal(before.nodeState.entryStatus, 'ready');
  assert.equal(before.nodeState.version, 1);
  assert.equal(before.nodeState.stored.length, 0);
  assert.deepEqual(before.reviewRounds, [{ id: 'round-old', status: 'changes-requested' }]);
  assert.equal(before.activeRoundId, null);

  const started = session.send({ text: '落盘核对', idempotencyKey: 'persist-run' });
  await session.waitForRun(started.runId, 'running');
  const running = journal.load();
  assert.equal(running.nodeState.status, 'running');
  assert.equal(running.nodeState.entryStatus, 'ready');
  assert.equal(running.nodeState.version, before.nodeState.version + 1);
  const acknowledged = running.nodeState.stored.find(
    (item) => item.idempotencyKey === `ack:${started.runId}`,
  );
  assert.equal(acknowledged.actorId, 'chen-ning');
  assert.equal(acknowledged.objectId, 'node-fields');
  assert.equal(acknowledged.result.from, 'ready');
  assert.equal(acknowledged.result.to, 'running');
  assert.deepEqual(running.reviewRounds, before.reviewRounds);

  const stopped = await session.stop();
  assert.equal(stopped.ok, true);
  const cancelled = journal.load();
  const cancel = cancelled.nodeState.stored.find(
    (item) => item.idempotencyKey === `cancel:${started.runId}`,
  );
  assert.equal(cancel.result.from, 'running');
  assert.equal(cancel.result.to, 'cancelled');
  assert.equal(cancelled.nodeState.entryStatus, 'ready');
  assert.equal(cancelled.nodeState.version, running.nodeState.version + 1);
  assert.deepEqual(cancelled.reviewRounds, before.reviewRounds);

  const restored = ExecutionDesk.restore(cancelled, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
    journal,
  });
  restored.resumeInteraction();
  const versionBeforeRetry = restored.persistence().nodeState.version;
  const retried = restored.retry('persist-restart');
  assert.equal(retried.ok, true);
  const after = journal.load();
  const recovery = after.nodeState.stored.find(
    (item) => item.idempotencyKey === 'recovery:persist-restart',
  );
  assert.equal(recovery.result.from, 'cancelled');
  assert.equal(recovery.result.to, 'ready');
  assert.equal(after.nodeState.version, versionBeforeRetry + 1);
  assert.equal(after.nodeState.entryStatus, 'ready');
  assert.deepEqual(after.reviewRounds, before.reviewRounds);
  assert.equal(after.activeRoundId, null);
  assert.equal(after.nodeState.stored.length, cancelled.nodeState.stored.length + 1);
  const kept = journal.load();
  kept.activeRoundId = 'round-kept';
  journal.save(kept);
  const roundTrip = ExecutionDesk.restore(journal.load(), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal,
  });
  assert.equal(roundTrip.persistence().activeRoundId, 'round-kept');
  assert.equal(journal.load().activeRoundId, 'round-kept');
  roundTrip.resumeInteraction();
  roundTrip.setContextIncluded('goal', true);
  assert.equal(journal.load().activeRoundId, 'round-kept');
});

test('契约：核实断开、下一轮启动失败和接收前停止都把队列标成未应用', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-queue-abandon-'));
  const journal = createFileJournal(path.join(directory, 'session.json'));
  const { desk: session } = desk({ journal });
  const started = session.send({ text: '保持运行', idempotencyKey: 'held-queue' });
  await session.waitForRun(started.runId, 'running');
  session.send({ text: '补充还没生效', idempotencyKey: 'queued-abandon', intent: 'supplement' });
  const restored = ExecutionDesk.restore(journal.load(), {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
    journal,
  });
  restored.resumeInteraction();
  const verified = restored.verifyAbandoned();
  assert.equal(verified.ok, true);
  assert.equal(verified.snapshot.node.status, 'failed');
  assert.equal(verified.snapshot.interventions[0].phase, 'not-applied');
  assert.match(verified.snapshot.interventions[0].notice, /未应用/);

  const { desk: blocked } = desk();
  const running = blocked.send({ text: '第一轮', idempotencyKey: 'block-run' });
  await blocked.waitForRun(running.runId, 'running');
  blocked.send({ text: '补充被挡住', idempotencyKey: 'block-queue', intent: 'supplement' });
  blocked.setAvailability({ expertId: 'api-impl', enabled: false });
  blocked.releaseActive();
  await blocked.flush();
  assert.equal(blocked.snapshot().runs.length, 1);
  assert.equal(blocked.snapshot().runs[0].status, 'completed');
  assert.equal(blocked.snapshot().interventions[0].phase, 'not-applied');
  assert.match(blocked.snapshot().interventions[0].notice, /下一轮没有启动/);
  assert.match(blocked.snapshot().interventions[0].notice, /专家/);

  const { desk: context } = desk();
  const contextRun = context.send({ text: '第一轮', idempotencyKey: 'context-run' });
  await context.waitForRun(contextRun.runId, 'running');
  context.send({ text: '补充缺文件', idempotencyKey: 'context-queue', intent: 'supplement' });
  context.setContextIncluded('missing', true);
  context.releaseActive();
  await context.flush();
  assert.equal(context.snapshot().runs.length, 1);
  assert.equal(context.snapshot().interventions[0].phase, 'not-applied');
  assert.match(context.snapshot().interventions[0].notice, /下一轮没有启动/);

  const gates = new Map();
  const cancelled = new Set();
  let seen = 0;
  const executor = {
    id: 'simulated',
    capabilities: {
      liveInjection: false,
      sessionResume: false,
      cancelReceipt: true,
      streaming: false,
      verified: false,
      mode: 'simulated',
    },
    release(runId) {
      gates.get(runId)?.();
    },
    async cancel(runId) {
      cancelled.add(runId);
      gates.get(runId)?.();
      return { receipt: 'cancelled' };
    },
    async *run(request) {
      const index = ++seen;
      if (index > 1) {
        await new Promise((resolve) => {
          gates.set(request.runId, resolve);
        });
        if (cancelled.has(request.runId) || request.signal.aborted) {
          yield { type: 'cancelled', simulated: true };
          return;
        }
      }
      yield { type: 'accepted', executorRunId: `sim-${request.runId}`, simulated: true };
      if (index === 1) {
        await new Promise((resolve) => {
          gates.set(request.runId, resolve);
        });
      }
      if (cancelled.has(request.runId) || request.signal.aborted) {
        yield { type: 'cancelled', simulated: true };
        return;
      }
      yield {
        type: 'completed',
        result: {
          executorRunId: `sim-${request.runId}`,
          simulated: true,
          summary: 'ok',
          draftText: 'ok',
          sourceReferences: [],
          verification: [],
        },
      };
    },
  };
  const early = ExecutionDesk.create(seed(), { executors: [executor], newId: ids() });
  early.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  const first = early.send({ text: '先跑完', idempotencyKey: 'early-run' });
  await early.waitForRun(first.runId, 'running');
  early.send({ text: '下一条还没接收', idempotencyKey: 'early-q1', intent: 'supplement' });
  early.send({ text: '再下一条', idempotencyKey: 'early-q2', intent: 'supplement' });
  executor.release(first.runId);
  await early.flush();
  const stopped = await early.stop();
  await early.flush();
  assert.equal(stopped.ok, true);
  const queued = early.snapshot().interventions;
  assert.equal(queued.length, 2);
  assert.equal(
    queued.every((item) => item.phase === 'not-applied'),
    true,
  );
  assert.equal(
    early.snapshot().runs.some((run) => run.status === 'cancelled' && !run.acknowledged),
    true,
  );
});

test('契约：停止回执超时后迟到的取消仍结束运行', async () => {
  let releaseRun = () => {};
  const executor = {
    id: 'simulated',
    capabilities: {
      liveInjection: false,
      sessionResume: false,
      cancelReceipt: true,
      streaming: false,
      verified: false,
      mode: 'simulated',
    },
    async *run() {
      yield { type: 'accepted', executorRunId: 'late', simulated: true };
      await new Promise((resolve) => {
        releaseRun = resolve;
      });
      yield { type: 'cancelled', simulated: true };
    },
    cancel() {
      return new Promise((resolve) => {
        setTimeout(() => {
          releaseRun();
          resolve({ receipt: 'cancelled' });
        }, 4500);
      });
    },
  };
  const session = ExecutionDesk.create(seed(), { executors: [executor], newId: ids() });
  session.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  const started = session.send({ text: '等迟到取消', idempotencyKey: 'late-cancel' });
  await session.waitForRun(started.runId, 'running');
  const stopped = await session.stop();
  assert.equal(stopped.code, 'stop-receipt-missing');
  assert.equal(stopped.snapshot.runs[0].status, 'running');
  assert.equal(stopped.snapshot.runs[0].stopPhase, 'receipt-rejected');
  await session.flush();
  assert.equal(session.snapshot().runs[0].status, 'cancelled');
  assert.equal(session.snapshot().runs[0].stopPhase, 'confirmed');
  assert.equal(session.snapshot().node.status, 'cancelled');
});

test('契约：入口不一致时拒绝发送，运行中丢记录则停在人工处理', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-entry-send-'));
  const journal = createFileJournal(path.join(directory, 'session.json'));
  desk({ journal });
  const created = journal.load();
  created.nodeState.status = 'needs-revision';
  created.nodeState.entryStatus = 'ready';
  const restored = ExecutionDesk.restore(created, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
  });
  restored.resumeInteraction();
  const refused = restored.send({ text: '不要改写入口', idempotencyKey: 'bad-entry-send' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'entry-inconsistent');
  assert.equal(refused.snapshot.runs.length, 0);
  assert.equal(refused.snapshot.node.status, 'needs-revision');
  assert.equal(created.nodeState.entryStatus, 'ready');

  const { desk: session } = desk();
  const started = session.send({ text: '跑到一半入口坏了', idempotencyKey: 'mid-entry' });
  await session.waitForRun(started.runId, 'running');
  const state = session.nodeState;
  session.nodeState = {
    status: state.status,
    version: state.version,
    upstreamAffected: state.upstreamAffected,
    stored: state.stored,
  };
  session.releaseActive();
  await session.flush();
  const after = session.snapshot();
  assert.equal(after.runs[0].status, 'failed');
  assert.equal(after.node.status, 'running');
  assert.notEqual(after.node.status, 'failed');
  assert.notEqual(after.node.status, 'cancelled');
  assert.equal(session.nodeState.entryStatus, undefined);
  assert.equal(after.lastError.code, 'entry-inconsistent');
  assert.equal(after.lastError.reason, '节点记录异常，需要人工处理');
});

test('契约：人工交接可以不带专家引用', () => {
  const bare = seed();
  delete bare.handoff.expertRef;
  const session = ExecutionDesk.create(bare, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
  });
  session.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  const started = session.send({ text: '人工节点', idempotencyKey: 'human-only' });
  assert.equal(started.ok, true);
  assert.equal(started.snapshot.handoff.expertRef, undefined);
  assert.equal(started.snapshot.assignee.kind, 'human');
});

function runRequest(runId) {
  return {
    runId,
    attempt: 1,
    generation: 1,
    taskId: 'task',
    nodeId: 'node',
    workflowVersionId: 'plan',
    planRevision: 1,
    contextReferences: [],
    expertVersionId: 'expert-v1',
    resourceGrants: [],
    instruction: '整理字段',
    attachmentIds: [],
    goal: '确认字段',
    simulatedRequested: true,
    signal: new AbortController().signal,
  };
}

async function assertRecordBroken(session, label) {
  const view = createAgentWorkspaceView(session.snapshot());
  assert.equal(view.nodeStatusKey, 'record-broken', label);
  assert.match(view.nodeStatusText, /节点记录异常/);
  assert.equal(view.nodeStatusText.includes('执行中'), false, label);
  assert.equal(view.primary.enabled, false, label);
  assert.equal(view.stop.enabled, false, label);
  assert.equal(view.retry.enabled, false, label);
  const sent = session.send({ text: '不要再发', idempotencyKey: `${label}-send` });
  assert.equal(sent.ok, false, label);
  assert.equal(sent.code, 'entry-inconsistent', label);
  const retried = session.retry(`${label}-retry`);
  assert.equal(retried.ok, false, label);
  const stopped = await session.stop();
  assert.equal(stopped.ok, false, label);
  assert.equal(session.snapshot().node.status, 'running', label);
  assert.equal(createAgentWorkspaceView(session.snapshot()).nodeStatusKey, 'record-broken', label);
}

test('契约：丢失入口后停止仍是节点记录异常', async () => {
  const { desk: session } = desk();
  const started = session.send({ text: '停之前丢入口', idempotencyKey: 'rb-stop' });
  await session.waitForRun(started.runId, 'running');
  session.dropRecordedEntry();
  const stopped = await session.stop();
  assert.equal(stopped.snapshot.runs.at(-1).status, 'cancelled');
  assert.equal(stopped.snapshot.node.status, 'running');
  await assertRecordBroken(session, 'stop');
});

test('契约：丢失入口后执行失败仍是节点记录异常', async () => {
  const gates = new Map();
  const executor = {
    id: 'simulated',
    capabilities: {
      liveInjection: false,
      sessionResume: false,
      cancelReceipt: true,
      streaming: false,
      verified: false,
      mode: 'simulated',
    },
    release(runId) {
      gates.get(runId)?.();
    },
    async cancel() {
      return { receipt: 'rejected', reason: '没有这次运行。' };
    },
    async *run(request) {
      yield { type: 'accepted', executorRunId: `fail-${request.runId}`, simulated: true };
      await new Promise((resolve) => {
        gates.set(request.runId, resolve);
      });
      yield {
        type: 'failed',
        fault: 'network-interruption',
        message: '请求超时',
        simulated: false,
      };
    },
  };
  const session = ExecutionDesk.create(seed(), {
    executors: [executor],
    newId: ids(),
  });
  session.updateConfig({ executorId: 'simulated' });
  const started = session.send({ text: '失败前丢入口', idempotencyKey: 'rb-fail' });
  await session.waitForRun(started.runId, 'running');
  session.dropRecordedEntry();
  executor.release(started.runId);
  await session.flush();
  assert.equal(session.snapshot().runs.at(-1).status, 'failed');
  assert.equal(session.snapshot().node.status, 'running');
  assert.equal(session.snapshot().faults.length > 0, true);
  await assertRecordBroken(session, 'fail');
});

test('契约：丢失入口后核实断开仍是节点记录异常', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-record-abandon-'));
  const journal = createFileJournal(path.join(directory, 'session.json'));
  const { desk: session } = desk({ journal });
  const started = session.send({ text: '重启前丢入口', idempotencyKey: 'rb-abandon' });
  await session.waitForRun(started.runId, 'running');
  const data = journal.load();
  delete data.nodeState.entryStatus;
  journal.save(data);
  const restored = ExecutionDesk.restore(journal.load(), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal,
  });
  restored.resumeInteraction();
  const verified = restored.verifyAbandoned();
  assert.equal(verified.snapshot.runs[0].status, 'failed');
  assert.equal(verified.snapshot.node.status, 'running');
  assert.equal(verified.snapshot.lastError.code, 'entry-inconsistent');
  await assertRecordBroken(restored, 'abandon');
  const again = ExecutionDesk.restore(journal.load(), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal,
  });
  again.resumeInteraction();
  assert.equal(createAgentWorkspaceView(again.snapshot()).nodeStatusKey, 'record-broken');
});

test('契约：节点记录异常不会被后续成功操作清掉', async () => {
  const { desk: session } = desk();
  const started = session.send({ text: '结束时丢入口', idempotencyKey: 'rb-follow' });
  await session.waitForRun(started.runId, 'running');
  session.dropRecordedEntry();
  session.releaseActive();
  await session.flush();
  assert.equal(session.snapshot().runs.at(-1).status, 'failed');
  const toggled = session.setContextIncluded('missing', true);
  assert.equal(toggled.ok, true);
  assert.equal(toggled.snapshot.lastError.code, 'entry-inconsistent');
  assert.equal(createAgentWorkspaceView(toggled.snapshot).nodeStatusKey, 'record-broken');
  const drafted = session.saveDraft('仍然不能当成执行中');
  assert.equal(drafted.ok, true);
  assert.equal(createAgentWorkspaceView(drafted.snapshot).nodeStatusKey, 'record-broken');
  assert.equal(createAgentWorkspaceView(drafted.snapshot).primary.enabled, false);
});

test('契约：交接引用先复制，畸形引用被拒绝', () => {
  const refs = [{ sourceNodeId: 'n0', artifactVersionId: 'av1', secretToken: 'x' }, { bogus: 1 }];
  const bad = seed();
  bad.handoff = { ...bad.handoff, inputRefs: refs };
  assert.throws(
    () =>
      ExecutionDesk.create(bad, {
        executors: [new SimulatedAgentExecutor()],
        newId: ids(),
      }),
    /invalid-handoff/,
  );
  const goodRefs = [{ sourceNodeId: 'n0' }];
  const good = seed();
  good.handoff = { ...good.handoff, inputRefs: goodRefs };
  const session = ExecutionDesk.create(good, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  goodRefs[0].sourceNodeId = 'MUTATED';
  assert.equal(session.snapshot().handoff.inputRefs[0].sourceNodeId, 'n0');
  assert.equal(session.persistence().seed.handoff.inputRefs[0].sourceNodeId, 'n0');
});

test('契约：没有入口记录时重试不可用', () => {
  const session = ExecutionDesk.create(seed({ nodeStatus: 'failed' }), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  const view = createAgentWorkspaceView(session.snapshot());
  assert.equal(view.retry.visible, true);
  assert.equal(view.retry.enabled, false);
  const retried = session.retry('missing-entry');
  assert.equal(retried.ok, false);
  assert.equal(retried.code, 'recovery-not-available');
  assert.equal(createAgentWorkspaceView(session.snapshot()).retry.enabled, false);
});

test('契约：重复恢复被拒时说明是哪一次请求', async () => {
  const { desk: session } = desk();
  const started = session.send({ text: '先取消', idempotencyKey: 'rb-recovery' });
  await session.waitForRun(started.runId, 'running');
  const stopped = await session.stop();
  assert.equal(stopped.snapshot.node.status, 'cancelled');
  session.nodeState = {
    ...session.nodeState,
    stored: [
      ...session.nodeState.stored,
      {
        idempotencyKey: 'recovery:again',
        objectId: 'node-fields',
        actorId: 'chen-ning',
        payloadFingerprint: 'different',
        version: session.nodeState.version,
        result: {
          from: 'cancelled',
          to: 'ready',
          changed: true,
          effects: [],
          upstreamAffected: false,
        },
      },
    ],
  };
  const rejected = session.retry('again');
  assert.equal(rejected.code, 'recovery-rejected');
  assert.match(rejected.reason, /again/);
  assert.match(rejected.reason, /不同的迁移/);
  assert.equal(session.snapshot().node.status, 'cancelled');
});
