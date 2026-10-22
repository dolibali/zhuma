import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExecutionDesk,
  SimulatedAgentExecutor,
  UnimplementedNativeExecutor,
  createFileJournal,
  probeRelativeFile,
  selectAgentExecutor,
} from '@zhuma/dsh-adapter';

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
  const draft = restored.saveDraft('手工修订后的字段说明');
  assert.equal(draft.ok, true);
  assert.equal(draft.snapshot.drafts[0].autoDeliver, false);
  assert.equal(draft.snapshot.drafts[0].skipReview, false);
  assert.equal(draft.snapshot.node.status, 'ready');
  assert.notEqual(draft.snapshot.drafts[0].review.roundId, 'round-old');
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
  assert.equal(snapshot.interventions[0].phase, 'pending');
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
});
