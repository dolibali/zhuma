import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync as makeScratch,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const scratchDirs = [];
function mkdtempSync(prefix) {
  const dir = makeScratch(prefix);
  scratchDirs.push(dir);
  return dir;
}
function discardScratch(dir) {
  spawnSync('chmod', ['-R', 'u+rwx', dir], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
test.after(() => {
  for (const dir of scratchDirs) discardScratch(dir);
});

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
  assert.match(blocked.reason, /来源节点 外部映射表/);
  assert.match(blocked.reason, /版本 9/);
  assert.match(blocked.reason, /missing-file/);
  assert.equal(JSON.stringify(blocked.snapshot).includes('missing.csv'), false);
  session.setContextIncluded('missing', false);
  const first = session.send({ text: '整理开户字段', idempotencyKey: 'k1', attachmentIds: [] });
  assert.equal(first.ok, true);
  const duplicate = session.send({ text: '整理开户字段', idempotencyKey: 'k1' });
  assert.equal(duplicate.replayed, true);
  assert.equal(session.snapshot().runs.length, 1);
  await session.waitForRun(first.runId, 'running');
  assert.equal(session.snapshot().node.status, 'running');
  const runningView = createAgentWorkspaceView(session.snapshot());
  assert.equal(
    runningView.turns.some((turn) => turn.role === 'executor' && turn.generating),
    true,
  );
  assert.match(runningView.mcp.find((item) => item.id === 'api-docs')?.reason ?? '', /未连接/);
  assert.equal(runningView.mcp.find((item) => item.id === 'api-docs')?.connection, '未连接');
  assert.equal(session.snapshot().config.simulated, true);
  session.releaseActive();
  await session.flush();
  assert.equal(session.snapshot().runs[0].status, 'completed');
  assert.equal(
    createAgentWorkspaceView(session.snapshot()).turns.some((turn) => turn.generating),
    false,
  );
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
  assert.equal(
    session
      .snapshot()
      .turns.some(
        (turn) =>
          turn.runId === started.runId && turn.role === 'executor' && turn.body.trim() === '',
      ),
    true,
  );
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
  assert.equal(
    snapshot.turns.some(
      (turn) => turn.runId === started.runId && turn.role === 'executor' && turn.body.trim() === '',
    ),
    false,
  );
  assert.equal(
    createAgentWorkspaceView(snapshot).turns.some(
      (turn) => turn.role === 'executor' && turn.body.trim() === '',
    ),
    false,
  );
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

test('契约：同一目录上的第二个工作台拿不到写锁，不能把仍在运行的会话标成放弃', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-lock-'));
  const file = path.join(directory, 'session.json');
  const journal = createFileJournal(file);
  const { desk: owner } = desk({ journal });
  const started = owner.send({ text: '保持运行', idempotencyKey: 'locked-run' });
  await owner.waitForRun(started.runId, 'running');
  const before = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(before).runs[0].status, 'running');
  assert.equal(
    JSON.parse(before).claims.some((claim) => claim.active),
    true,
  );

  const intruder = createFileJournal(file);
  assert.equal(journal.writable, true);
  assert.equal(intruder.writable, false);
  const restored = ExecutionDesk.restore(intruder.load(), {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
    journal: intruder,
  });
  const verified = restored.verifyAbandoned();
  assert.equal(verified.ok, false);
  assert.equal(verified.code, 'write-locked');
  assert.equal(restored.snapshot().runs[0].status, 'running');
  assert.equal(restored.snapshot().node.status, 'running');
  assert.equal(restored.snapshot().faults.length, 0);
  assert.equal(readFileSync(file, 'utf8'), before);

  const stopped = await owner.stop();
  assert.equal(stopped.ok, true);
  const after = journal.load();
  assert.equal(after.runs[0].status, 'cancelled');
  assert.equal(after.nodeState.status, 'cancelled');
});

test('契约：写锁在进程退出时释放，同机已死或别的主机都不能被误抢', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-lock-exit-'));
  const file = path.join(directory, 'session.json');
  const ready = path.join(directory, 'ready');
  const adapter = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js'),
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { writeFileSync } from 'node:fs';
       import { createFileJournal } from ${JSON.stringify(adapter)};
       const journal = createFileJournal(${JSON.stringify(file)});
       if (journal.writable !== true) process.exit(2);
       journal.save({ held: true });
       writeFileSync(${JSON.stringify(ready)}, 'held');
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const startedAt = Date.now();
  while (!existsSync(ready)) {
    if (Date.now() - startedAt > 5000) {
      child.kill();
      throw new Error(stderr || '子进程没有拿到写锁');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const blocked = createFileJournal(file);
  assert.equal(blocked.writable, false);
  assert.throws(
    () => blocked.save({ no: true }),
    (error) => error.code === 'ELOCKED',
  );
  child.kill();
  await once(child, 'exit');
  assert.equal(existsSync(`${file}.write.lock`), false);
  const taken = createFileJournal(file);
  assert.equal(taken.writable, true);
  assert.equal(taken.load().held, true);

  let deadPid = 0;
  for (let attempt = 0; attempt < 5 && deadPid === 0; attempt += 1) {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await once(dead, 'exit');
    try {
      process.kill(dead.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') deadPid = dead.pid;
    }
  }
  assert.notEqual(deadPid, 0);
  const staleDir = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-lock-stale-'));
  const staleFile = path.join(staleDir, 'session.json');
  writeFileSync(
    `${staleFile}.write.lock`,
    JSON.stringify({ pid: deadPid, hostname: hostname(), startedAt: '2026-10-23T00:00:00.000Z' }),
  );
  const stolen = createFileJournal(staleFile);
  assert.equal(stolen.writable, true);
  const lock = JSON.parse(readFileSync(`${staleFile}.write.lock`, 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.hostname, hostname());

  const foreignDir = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-lock-host-'));
  const foreignFile = path.join(foreignDir, 'session.json');
  writeFileSync(
    `${foreignFile}.write.lock`,
    JSON.stringify({ pid: 1, hostname: 'not-this-host', startedAt: '2026-10-23T00:00:00.000Z' }),
  );
  const foreign = createFileJournal(foreignFile);
  assert.equal(foreign.writable, false);
  const still = JSON.parse(readFileSync(`${foreignFile}.write.lock`, 'utf8'));
  assert.equal(still.hostname, 'not-this-host');
});

test('契约：日志改名失败时清掉临时文件', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-journal-tmp-'));
  const file = path.join(directory, 'session.json');
  mkdirSync(file);
  const journal = createFileJournal(file);
  const temporary = `${file}.${process.pid}.tmp`;
  assert.equal(journal.writable, true);
  assert.throws(
    () => journal.save({ kept: false }),
    (error) => error.code === 'EISDIR',
  );
  assert.equal(existsSync(temporary), false);
  assert.equal(existsSync(file), true);
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
  const configured = readDshModelConfig({
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1/',
    ZHUMA_MODEL_API_KEY: 'test-key',
    ZHUMA_MODEL_ID: 'test-model',
  });
  assert.equal(configured.ok, true);
  assert.equal(configured.config.modelId, 'test-model');
  assert.equal(configured.config.baseUrl.endsWith('/'), false);
  const missingModel = readDshModelConfig({
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1',
    ZHUMA_MODEL_API_KEY: 'test-key',
  });
  assert.equal(missingModel.ok, false);
  assert.equal(missingModel.reason, '缺少 ZHUMA_MODEL_ID。不会改用模拟执行器。');
  assert.equal(missingModel.reason.includes('https://example.invalid'), false);
  assert.equal(missingModel.reason.includes('test-key'), false);
  const blankModel = readDshModelConfig({
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1',
    ZHUMA_MODEL_API_KEY: 'test-key',
    ZHUMA_MODEL_ID: ' \t ',
  });
  assert.equal(blankModel.ok, false);
  assert.equal(blankModel.reason, '缺少 ZHUMA_MODEL_ID。不会改用模拟执行器。');
  const named = new DshChatExecutor({
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1',
    ZHUMA_MODEL_API_KEY: 'test-key',
  });
  assert.equal(named.capabilities.verified, false);
  await assert.rejects(async () => {
    for await (const event of named.run(runRequest('dsh-missing-model'))) void event;
  }, /ZHUMA_MODEL_ID/);
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
  assert.equal(refused.code, 'entry-inconsistent');
  assert.equal(missing.snapshot().node.status, 'cancelled');
  assert.equal(missing.persistence().nodeState.entryStatus, undefined);
  assert.equal(missing.snapshot().downstreamLaunches, 0);
  assert.equal(createAgentWorkspaceView(missing.snapshot()).nodeStatusKey, 'record-broken');
  assert.equal(createAgentWorkspaceView(missing.snapshot()).retry.enabled, false);
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

const RECORD_NEXT = '不要按这份记录重试或结束运行。先核对节点命令里的 entryStatus。';

function assertLostRecordClosed(session, journal, label, nodeStatus) {
  const snap = session.snapshot();
  assert.equal(snap.node.status, nodeStatus, label);
  assert.equal(snap.node.status === 'ready', false, label);
  assert.equal(snap.node.status === 'completed', false, label);
  assert.equal(session.persistence().nodeState.entryStatus, undefined, label);
  assert.equal(snap.downstreamLaunches, 0, label);
  assert.equal(snap.lastError.code, 'entry-inconsistent', label);
  const view = createAgentWorkspaceView(snap);
  assert.equal(view.nodeStatusKey, 'record-broken', label);
  assert.match(view.nodeStatusText, /节点记录异常/, label);
  assert.equal(view.nodeStatusText.includes('执行中'), false, label);
  assert.equal(view.nextAction, RECORD_NEXT, label);
  assert.equal(view.primary.enabled, false, label);
  assert.equal(view.stop.enabled, false, label);
  assert.equal(view.retry.enabled, false, label);
  assert.equal(view.retry.visible, true, label);

  const saved = journal.load();
  assert.equal(saved.nodeState.status, nodeStatus, label);
  assert.equal(saved.nodeState.entryStatus, undefined, label);
  assert.equal(saved.lastError.code, 'entry-inconsistent', label);
  assert.equal(saved.downstreamLaunches, 0, label);
  const frozen = JSON.parse(JSON.stringify(saved));

  const sent = session.send({ text: '不要再发', idempotencyKey: `${label}-send` });
  assert.equal(sent.ok, false, label);
  assert.equal(sent.code, 'entry-inconsistent', label);
  const retried = session.retry(`${label}-retry`);
  assert.equal(retried.ok, false, label);
  assert.equal(session.snapshot().node.status, nodeStatus, label);
  assert.equal(session.persistence().nodeState.entryStatus, undefined, label);
  assert.equal(session.snapshot().downstreamLaunches, 0, label);
  const completed = session.confirmCompleted();
  assert.equal(completed.ok, false, label);
  assert.equal(completed.code, 'entry-inconsistent', label);
  assert.equal(session.snapshot().node.status, nodeStatus, label);
  assert.equal(session.snapshot().node.status === 'completed', false, label);
  assert.equal(session.snapshot().downstreamLaunches, 0, label);
  assert.equal(session.persistence().nodeState.entryStatus, undefined, label);

  const again = ExecutionDesk.restore(frozen, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal,
  });
  again.resumeInteraction();
  const restored = again.snapshot();
  assert.equal(restored.node.status, nodeStatus, label);
  assert.equal(again.persistence().nodeState.entryStatus, undefined, label);
  assert.equal(restored.lastError.code, 'entry-inconsistent', label);
  assert.equal(restored.downstreamLaunches, 0, label);
  const againView = createAgentWorkspaceView(restored);
  assert.equal(againView.nodeStatusKey, 'record-broken', label);
  assert.equal(againView.nextAction, RECORD_NEXT, label);
  assert.equal(againView.retry.enabled, false, label);
  assert.equal(againView.primary.enabled, false, label);
  const retriedAgain = again.retry(`${label}-retry-restored`);
  assert.equal(retriedAgain.ok, false, label);
  assert.equal(again.snapshot().node.status, nodeStatus, label);
  assert.equal(again.persistence().nodeState.entryStatus, undefined, label);
  assert.equal(again.snapshot().downstreamLaunches, 0, label);
}

test('契约：丢失入口后停止仍是节点记录异常', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-record-stop-'));
  const journal = createFileJournal(path.join(directory, 'session.json'));
  const { desk: session } = desk({ journal });
  const started = session.send({ text: '停之前丢入口', idempotencyKey: 'rb-stop' });
  await session.waitForRun(started.runId, 'running');
  session.dropRecordedEntry();
  const stopped = await session.stop();
  assert.equal(stopped.snapshot.runs.at(-1).status, 'cancelled');
  assertLostRecordClosed(session, journal, 'stop', 'cancelled');
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
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-record-fail-'));
  const journal = createFileJournal(path.join(directory, 'session.json'));
  const session = ExecutionDesk.create(seed(), {
    executors: [executor],
    newId: ids(),
    journal,
  });
  session.updateConfig({ executorId: 'simulated' });
  const started = session.send({ text: '失败前丢入口', idempotencyKey: 'rb-fail' });
  await session.waitForRun(started.runId, 'running');
  session.dropRecordedEntry();
  executor.release(started.runId);
  await session.flush();
  assert.equal(session.snapshot().runs.at(-1).status, 'failed');
  assert.equal(session.snapshot().faults.length > 0, true);
  assertLostRecordClosed(session, journal, 'fail', 'failed');
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
  assert.equal(verified.snapshot.lastError.code, 'entry-inconsistent');
  assertLostRecordClosed(restored, journal, 'abandon', 'failed');
});

async function driveUnreadableRead(summary) {
  const root = mkdtempSync(path.join(tmpdir(), 'zhuma-ctx-read-'));
  writeFileSync(path.join(root, 'need.csv'), 'secret-body\n');
  const planted = seed();
  planted.fileRoot = root;
  planted.handoff = {
    ...planted.handoff,
    inputRefs: [{ sourceNodeId: 'node-a', artifactVersionId: 'art-1' }],
  };
  planted.contextItems = [
    ...planted.contextItems.filter((item) => item.sourceNodeId === undefined),
    {
      id: 'need',
      kind: 'upstream-artifact',
      sourceId: 'node-a',
      sourceNodeId: 'node-a',
      artifactVersionId: 'art-1',
      version: '1',
      permission: 'granted',
      summary,
      required: true,
      includedByDefault: true,
      relativePath: 'need.csv',
    },
  ];
  const dir = mkdtempSync(path.join(tmpdir(), 'zhuma-read-fault-'));
  const preload = path.join(dir, 'preload.mjs');
  const script = path.join(dir, 'drive.mjs');
  const plantedFile = path.join(dir, 'planted.json');
  writeFileSync(plantedFile, JSON.stringify(planted));
  const needle = JSON.stringify(`${path.sep}need.csv`);
  writeFileSync(
    preload,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs');",
      `const denied = (target) => String(target).endsWith(${needle});`,
      'const refuse = (target, verb) => {',
      "  const error = new Error(`EACCES: permission denied, ${verb} '${target}'`);",
      "  error.code = 'EACCES';",
      '  throw error;',
      '};',
      'const originalAccess = fs.accessSync;',
      'fs.accessSync = (target, mode) => {',
      "  if (denied(target)) refuse(target, 'access');",
      '  return originalAccess(target, mode);',
      '};',
      'const originalRead = fs.readFileSync;',
      'fs.readFileSync = (target, options) => {',
      "  if (denied(target)) refuse(target, 'open');",
      '  return originalRead(target, options);',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    script,
    [
      'const { ExecutionDesk, SimulatedAgentExecutor, UnimplementedNativeExecutor } = await import(process.env.ZHUMA_ADAPTER);',
      "const { readFileSync } = await import('node:fs');",
      'const planted = JSON.parse(readFileSync(process.env.ZHUMA_PLANTED, "utf8"));',
      'const requests = [];',
      'const simulated = new SimulatedAgentExecutor({ chunkDelayMs: 0 });',
      'const run = simulated.run.bind(simulated);',
      'simulated.run = (request) => {',
      '  requests.push(request);',
      '  return run(request);',
      '};',
      'let n = 0;',
      'const session = ExecutionDesk.create(planted, {',
      "  executors: [simulated, new UnimplementedNativeExecutor('dsh')],",
      '  newId: (prefix) => `${prefix}-${++n}`,',
      '  probe: () => ({ ok: true, exists: true, readable: true }),',
      '});',
      'session.updateConfig({',
      "  executorId: 'simulated',",
      "  skillIds: ['test-design'],",
      "  mcpIds: ['api-docs'],",
      '});',
      'const quiet = (snapshot) => ({',
      '  node: snapshot.node.status,',
      '  runs: snapshot.runs.length,',
      '  turns: snapshot.turns.length,',
      '  citations: snapshot.citations.length,',
      '  blocks: snapshot.contextBlocks.length,',
      '  claims: snapshot.claims.length,',
      '  interventions: snapshot.interventions.length,',
      '});',
      'const before = quiet(session.snapshot());',
      "const result = session.send({ text: '开始', idempotencyKey: 'denied' });",
      'await session.flush();',
      'process.stdout.write(JSON.stringify({',
      '  ok: result.ok,',
      '  code: result.code,',
      '  reason: result.reason,',
      '  requests: requests.length,',
      '  before,',
      '  after: quiet(session.snapshot()),',
      '  resultQuiet: quiet(result.snapshot),',
      '  runsWithContext: result.snapshot.runs.some((item) => item.contextRefs?.length > 0),',
      '}));',
      '',
    ].join('\n'),
  );
  const adapter = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js'),
  ).href;
  const env = {
    ...process.env,
    ZHUMA_ADAPTER: adapter,
    ZHUMA_PLANTED: plantedFile,
  };
  delete env.ZHUMA_MODEL_API_KEY;
  const child = spawn(process.execPath, ['--import', preload, script], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
  if (code !== 0) throw new Error(`读取故障注入进程退出 ${code}\n${stderr}\n${stdout}`);
  return JSON.parse(stdout);
}

async function driveReadThrow(summary, code) {
  const root = mkdtempSync(path.join(tmpdir(), 'zhuma-ctx-read-'));
  writeFileSync(path.join(root, 'need.csv'), 'secret-body\n');
  const planted = seed();
  planted.fileRoot = root;
  planted.handoff = {
    ...planted.handoff,
    inputRefs: [{ sourceNodeId: 'node-a', artifactVersionId: 'art-1' }],
  };
  planted.contextItems = [
    ...planted.contextItems.filter((item) => item.sourceNodeId === undefined),
    {
      id: 'need',
      kind: 'upstream-artifact',
      sourceId: 'node-a',
      sourceNodeId: 'node-a',
      artifactVersionId: 'art-1',
      version: '1',
      permission: 'granted',
      summary,
      required: true,
      includedByDefault: true,
      relativePath: 'need.csv',
    },
  ];
  const dir = mkdtempSync(path.join(tmpdir(), 'zhuma-read-fault-'));
  const preload = path.join(dir, 'preload.mjs');
  const script = path.join(dir, 'drive.mjs');
  const plantedFile = path.join(dir, 'planted.json');
  writeFileSync(plantedFile, JSON.stringify(planted));
  const needle = JSON.stringify(`${path.sep}need.csv`);
  writeFileSync(
    preload,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs');",
      `const denied = (target) => String(target).endsWith(${needle});`,
      'const originalRead = fs.readFileSync;',
      'fs.readFileSync = (target, options) => {',
      '  if (denied(target)) {',
      '    const error = new Error(`${process.env.ZHUMA_READ_CODE}: read`);',
      '    error.code = process.env.ZHUMA_READ_CODE;',
      '    globalThis.__zhumaReadCode = error.code;',
      '    throw error;',
      '  }',
      '  return originalRead(target, options);',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    script,
    [
      'const { ExecutionDesk, SimulatedAgentExecutor, UnimplementedNativeExecutor } = await import(process.env.ZHUMA_ADAPTER);',
      "const { readFileSync, existsSync } = await import('node:fs');",
      "const path = await import('node:path');",
      'const planted = JSON.parse(readFileSync(process.env.ZHUMA_PLANTED, "utf8"));',
      'const requests = [];',
      'const simulated = new SimulatedAgentExecutor({ chunkDelayMs: 0 });',
      'const run = simulated.run.bind(simulated);',
      'simulated.run = (request) => {',
      '  requests.push(request);',
      '  return run(request);',
      '};',
      'let n = 0;',
      'const session = ExecutionDesk.create(planted, {',
      "  executors: [simulated, new UnimplementedNativeExecutor('dsh')],",
      '  newId: (prefix) => `${prefix}-${++n}`,',
      '});',
      'session.updateConfig({',
      "  executorId: 'simulated',",
      "  skillIds: ['test-design'],",
      "  mcpIds: ['api-docs'],",
      '});',
      'let thrown = "";',
      'let result = null;',
      'try {',
      "  result = session.send({ text: '开始', idempotencyKey: 'read-throw' });",
      '  await session.flush();',
      '} catch (error) {',
      '  thrown = error && error.message ? error.message : String(error);',
      '}',
      'process.stdout.write(JSON.stringify({',
      '  threw: thrown.length > 0,',
      '  thrown,',
      '  ok: result ? result.ok : null,',
      '  code: result ? result.code ?? "" : "",',
      '  reason: result ? result.reason ?? "" : "",',
      '  requests: requests.length,',
      '  readCode: globalThis.__zhumaReadCode ?? "",',
      '  fileStillThere: existsSync(path.join(planted.fileRoot, "need.csv")),',
      '}));',
      '',
    ].join('\n'),
  );
  const adapter = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js'),
  ).href;
  const env = {
    ...process.env,
    ZHUMA_ADAPTER: adapter,
    ZHUMA_PLANTED: plantedFile,
    ZHUMA_READ_CODE: code,
  };
  delete env.ZHUMA_MODEL_API_KEY;
  const child = spawn(process.execPath, ['--import', preload, script], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const [status] = await once(child, 'exit');
    if (status !== 0) throw new Error(`读取抛错注入进程退出 ${status}\n${stderr}\n${stdout}`);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}

test('契约：上游文件读失败时阻塞，不把摘要当成正文', async (t) => {
  const summary = '上游字段表（标签摘要）';
  const text = 'field,rule\nname,required\n';
  const roots = [];
  t.after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    for (const root of roots) assert.equal(existsSync(root), false);
  });
  const open = (fileName, content, probe) => {
    const root = mkdtempSync(path.join(tmpdir(), 'zhuma-ctx-read-'));
    roots.push(root);
    if (content !== null) writeFileSync(path.join(root, fileName), content);
    const planted = seed();
    planted.fileRoot = root;
    planted.handoff = {
      ...planted.handoff,
      inputRefs: [{ sourceNodeId: 'node-a', artifactVersionId: 'art-1' }],
    };
    planted.contextItems = [
      ...planted.contextItems.filter((item) => item.sourceNodeId === undefined),
      {
        id: 'need',
        kind: 'upstream-artifact',
        sourceId: 'node-a',
        sourceNodeId: 'node-a',
        artifactVersionId: 'art-1',
        version: '1',
        permission: 'granted',
        summary,
        required: true,
        includedByDefault: true,
        relativePath: fileName,
      },
    ];
    const requests = [];
    const simulated = new SimulatedAgentExecutor({ chunkDelayMs: 0 });
    const run = simulated.run.bind(simulated);
    simulated.run = (request) => {
      requests.push(request);
      return run(request);
    };
    const session = ExecutionDesk.create(planted, {
      executors: [simulated, new UnimplementedNativeExecutor('dsh')],
      newId: ids('ctx-read'),
      ...(probe !== undefined ? { probe } : {}),
    });
    session.updateConfig({
      executorId: 'simulated',
      skillIds: ['test-design'],
      mcpIds: ['api-docs'],
    });
    return { session, requests, root };
  };
  const quiet = (snapshot) => ({
    node: snapshot.node.status,
    runs: snapshot.runs.length,
    turns: snapshot.turns.length,
    citations: snapshot.citations.length,
    blocks: snapshot.contextBlocks.length,
    claims: snapshot.claims.length,
    interventions: snapshot.interventions.length,
  });
  const blocked = async (opened, key) => {
    const before = quiet(opened.session.snapshot());
    const result = opened.session.send({ text: '开始', idempotencyKey: key });
    await opened.session.flush();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'context-blocked');
    assert.match(result.reason, /来源节点 node-a/);
    assert.match(result.reason, /art-1/);
    assert.match(result.reason, /不会改用摘要/);
    assert.equal(result.reason.includes(summary), false);
    assert.equal(opened.requests.length, 0);
    assert.deepEqual(quiet(result.snapshot), before);
    assert.deepEqual(quiet(opened.session.snapshot()), before);
    assert.equal(
      result.snapshot.runs.some((run) => run.contextRefs?.length > 0),
      false,
    );
  };
  const readable = () => ({ ok: true, exists: true, readable: true });

  await blocked(open('need.csv', 'abc\u0000def'), 'nul');
  await blocked(
    open('need.csv', null, () => readable()),
    'missing',
  );
  const denied = await driveUnreadableRead(summary);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'context-blocked');
  assert.match(denied.reason, /来源节点 node-a/);
  assert.match(denied.reason, /art-1/);
  assert.match(denied.reason, /不会改用摘要/);
  assert.equal(denied.reason.includes(summary), false);
  assert.equal(denied.requests, 0);
  assert.deepEqual(denied.resultQuiet, denied.before);
  assert.deepEqual(denied.after, denied.before);
  assert.equal(denied.runsWithContext, false);
  let dropOnAccept = false;
  let dropRoot = '';
  const timed = open('need.csv', text, (relativePath) => {
    if (dropOnAccept && relativePath === 'need.csv') {
      const file = path.join(dropRoot, relativePath);
      if (existsSync(file)) unlinkSync(file);
    }
    return readable();
  });
  dropRoot = timed.root;
  dropOnAccept = true;
  const deleted = timed.session.send({ text: '开始', idempotencyKey: 'deleted' });
  await timed.session.flush();
  assert.equal(deleted.ok, false);
  assert.equal(deleted.code, 'context-blocked');
  assert.match(deleted.reason, /来源节点 node-a/);
  assert.match(deleted.reason, /art-1/);
  assert.match(deleted.reason, /不会改用摘要/);
  assert.equal(timed.requests.length, 0);
  assert.equal(deleted.snapshot.runs.length, 0);
  assert.equal(deleted.snapshot.turns.length, 0);
  assert.equal(deleted.snapshot.citations.length, 0);
  assert.equal(deleted.snapshot.node.status, 'ready');
  assert.equal(existsSync(path.join(dropRoot, 'need.csv')), false);

  const ok = open('need.csv', text);
  const before = quiet(ok.session.snapshot());
  const sent = ok.session.send({ text: '开始', idempotencyKey: 'plain' });
  assert.equal(sent.ok, true);
  await ok.session.flush();
  assert.equal(ok.requests.length, 1);
  const block = ok.requests[0].promptContext.find((item) => item.id === 'need');
  assert.equal(block.body, text);
  assert.equal(block.body.includes(summary), false);
  assert.deepEqual(ok.requests[0].contextReferences, ['upstream-artifact:node-a@1']);
  assert.equal(quiet(ok.session.snapshot()).runs, before.runs + 1);
});

test('契约：读取时遇到目录或文件刚被删，仍然阻塞且不用摘要', async () => {
  const summary = '上游字段表（标签摘要）';
  for (const code of ['EISDIR', 'ENOENT']) {
    const reported = await driveReadThrow(summary, code);
    assert.equal(reported.threw, false, reported.thrown);
    assert.equal(reported.ok, false);
    assert.equal(reported.code, 'context-blocked');
    assert.match(reported.reason, /来源节点 node-a/);
    assert.match(reported.reason, /art-1/);
    assert.match(reported.reason, /不会改用摘要/);
    assert.equal(reported.reason.includes(summary), false);
    assert.equal(reported.requests, 0);
    assert.equal(reported.readCode, code);
    assert.equal(reported.fileStillThere, true);
  }
});

test('契约：多轮结束后不再累积钉住的文件正文', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'zhuma-pin-round-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  });
  const firstBody = 'round-one-body-alpha\n';
  const secondBody = 'round-two-body-beta\n';
  writeFileSync(path.join(root, 'need.csv'), firstBody);
  const planted = seed();
  planted.fileRoot = root;
  planted.handoff = {
    ...planted.handoff,
    inputRefs: [{ sourceNodeId: 'node-a', artifactVersionId: 'art-1' }],
  };
  planted.contextItems = [
    ...planted.contextItems.filter((item) => item.sourceNodeId === undefined),
    {
      id: 'need',
      kind: 'upstream-artifact',
      sourceId: 'node-a',
      sourceNodeId: 'node-a',
      artifactVersionId: 'art-1',
      version: '1',
      permission: 'granted',
      summary: '不应留下来的摘要',
      required: true,
      includedByDefault: true,
      relativePath: 'need.csv',
    },
  ];
  const requests = [];
  const simulated = new SimulatedAgentExecutor({ chunkDelayMs: 0 });
  const run = simulated.run.bind(simulated);
  simulated.run = (request) => {
    requests.push(request);
    return run(request);
  };
  const session = ExecutionDesk.create(planted, {
    executors: [simulated, new UnimplementedNativeExecutor('dsh')],
    newId: ids(),
  });
  session.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  const retained = () => JSON.stringify([...session.pinnedPrompt.values()]);
  const first = session.send({ text: '第一轮', idempotencyKey: 'pin-round-1' });
  assert.equal(first.ok, true);
  await session.flush();
  assert.equal(session.snapshot().runs.at(-1).status, 'completed');
  assert.equal(session.pinnedPrompt.size, 0);
  assert.equal(retained().includes(firstBody), false);
  writeFileSync(path.join(root, 'need.csv'), secondBody);
  const second = session.send({ text: '第二轮', idempotencyKey: 'pin-round-2' });
  assert.equal(second.ok, true);
  await session.flush();
  assert.equal(session.snapshot().runs.at(-1).status, 'completed');
  assert.equal(session.snapshot().runs.length, 2);
  assert.equal(session.pinnedPrompt.size, 0);
  assert.equal(retained().includes(firstBody), false);
  assert.equal(retained().includes(secondBody), false);
  assert.equal(requests[0].promptContext.find((item) => item.id === 'need').body, firstBody);
  assert.equal(requests[1].promptContext.find((item) => item.id === 'need').body, secondBody);
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
  const goodRefs = [{ sourceNodeId: 'n0', artifactVersionId: 'av1' }];
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
  assert.equal(view.nodeStatusKey, 'record-broken');
  assert.equal(view.nextAction, RECORD_NEXT);
  assert.equal(view.retry.visible, true);
  assert.equal(view.retry.enabled, false);
  const retried = session.retry('missing-entry');
  assert.equal(retried.ok, false);
  assert.equal(retried.code, 'entry-inconsistent');
  assert.equal(session.snapshot().node.status, 'failed');
  assert.equal(session.persistence().nodeState.entryStatus, undefined);
  assert.equal(session.snapshot().downstreamLaunches, 0);
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

test('契约：启动期间入口丢失且接收被拒时停掉执行器并标成记录异常', async () => {
  const cancelled = [];
  const executor = new SimulatedAgentExecutor({ pauseBeforeAccept: true, chunkDelayMs: 0 });
  const cancel = executor.cancel.bind(executor);
  executor.cancel = async (runId) => {
    cancelled.push(runId);
    return cancel(runId);
  };
  const session = ExecutionDesk.create(seed(), {
    executors: [executor],
    newId: ids(),
  });
  session.updateConfig({ executorId: 'simulated' });
  const started = session.send({ text: '启动中丢掉入口', idempotencyKey: 'n23' });
  assert.equal(started.ok, true);
  assert.equal(session.snapshot().runs.at(-1).status, 'requested');
  assert.equal(createAgentWorkspaceView(session.snapshot()).nodeStatusKey, 'starting');
  session.dropRecordedEntry();
  executor.release(started.runId);
  await session.flush();
  const snap = session.snapshot();
  assert.equal(snap.runs.at(-1).status, 'failed');
  assert.equal(snap.node.status, 'ready');
  assert.equal(snap.lastError.code, 'entry-inconsistent');
  const view = createAgentWorkspaceView(snap);
  assert.equal(view.nodeStatusKey, 'record-broken');
  assert.equal(view.primary.enabled, false);
  assert.equal(view.stop.visible, false);
  assert.deepEqual(cancelled, [started.runId]);
  const sent = session.send({ text: '不要再发', idempotencyKey: 'n23-send' });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'entry-inconsistent');
  const stopped = await session.stop();
  assert.equal(stopped.ok, false);
  assert.equal(stopped.code, 'entry-inconsistent');
});

test('契约：快照交出的交接引用是副本', () => {
  const input = seed();
  input.handoff.inputRefs = [{ sourceNodeId: 'n0', artifactVersionId: 'av1' }];
  const session = ExecutionDesk.create(input, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  const exposed = session.snapshot().handoff.inputRefs;
  exposed[0].sourceNodeId = 'MUTATED';
  exposed.push({ sourceNodeId: 'extra' });
  assert.equal(session.snapshot().handoff.inputRefs.length, 1);
  assert.equal(session.snapshot().handoff.inputRefs[0].sourceNodeId, 'n0');
  assert.equal(session.persistence().seed.handoff.inputRefs[0].sourceNodeId, 'n0');
});

const REBUILD_HANDOFF = '交接引用无法读取。请重新建立交接，不要补写来源节点或产物版本。';

test('契约：缺来源或产物版本的交接引用在新建时拒绝，恢复时不补写', () => {
  const partials = [
    [{ sourceNodeId: 'n0' }],
    [{ artifactVersionId: 'av1' }],
    [{ contextPackId: 'pack-optional' }],
    [{ sourceNodeId: '  ', artifactVersionId: 'av1' }],
    [{ sourceNodeId: 'n0', artifactVersionId: ' ', contextPackId: 'pack-optional' }],
  ];
  for (const inputRefs of partials) {
    const planted = seed();
    planted.handoff = { ...planted.handoff, inputRefs };
    assert.throws(
      () =>
        ExecutionDesk.create(planted, {
          executors: [new SimulatedAgentExecutor()],
          newId: ids(),
        }),
      /invalid-handoff/,
    );
  }

  const good = ExecutionDesk.create(seed(), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  const saved = JSON.parse(JSON.stringify(good.persistence()));
  saved.seed.handoff.inputRefs = [{ sourceNodeId: 'n0', contextPackId: 'pack-old' }];
  const broken = ExecutionDesk.restore(saved, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  assert.equal(broken.persistence().handoffInvalid, true);
  assert.equal(broken.snapshot().lastError.code, 'invalid-handoff');
  assert.equal(broken.snapshot().lastError.nextStep, REBUILD_HANDOFF);
  assert.equal(
    broken.snapshot().handoff.inputRefs.some((ref) => ref.artifactVersionId !== undefined),
    false,
  );
  assert.equal(
    broken.snapshot().handoff.inputRefs.some((ref) => ref.sourceNodeId === 'n0'),
    false,
  );
  const view = createAgentWorkspaceView(broken.snapshot());
  assert.equal(view.nodeStatusKey, 'record-broken');
  assert.equal(view.nextAction, REBUILD_HANDOFF);
  broken.resumeInteraction();
  const sent = broken.send({ text: '不要按残缺引用发送', idempotencyKey: 'partial-ref' });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'invalid-handoff');
  assert.equal(sent.nextStep, REBUILD_HANDOFF);
  const stored = broken.persistence();
  assert.equal(stored.handoffInvalid, true);
  assert.equal(
    stored.seed.handoff.inputRefs.some((ref) => ref.artifactVersionId !== undefined),
    false,
  );
  const reloaded = ExecutionDesk.restore(JSON.parse(JSON.stringify(stored)), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  assert.equal(reloaded.persistence().handoffInvalid, true);
  assert.equal(reloaded.snapshot().lastError.nextStep, REBUILD_HANDOFF);
  assert.equal(createAgentWorkspaceView(reloaded.snapshot()).nodeStatusKey, 'record-broken');
  assert.equal(
    reloaded.snapshot().handoff.inputRefs.some((ref) => ref.artifactVersionId !== undefined),
    false,
  );
});

test('契约：恢复非法交接时该节点记录异常，其他节点仍能装入', () => {
  const good = ExecutionDesk.create(seed(), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  const saved = JSON.parse(JSON.stringify(good.persistence()));
  saved.seed.handoff.inputRefs = [{ bogus: 1 }];
  const broken = ExecutionDesk.restore(saved, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  assert.equal(broken.snapshot().lastError.code, 'invalid-handoff');
  assert.equal(createAgentWorkspaceView(broken.snapshot()).nodeStatusKey, 'record-broken');
  broken.resumeInteraction();
  const sent = broken.send({ text: '不要发送', idempotencyKey: 'bad-handoff' });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'invalid-handoff');
  const reloaded = ExecutionDesk.restore(broken.persistence(), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  assert.equal(reloaded.snapshot().lastError.code, 'invalid-handoff');
  assert.equal(createAgentWorkspaceView(reloaded.snapshot()).nodeStatusKey, 'record-broken');
  const other = ExecutionDesk.restore(JSON.parse(JSON.stringify(good.persistence())), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
  });
  other.resumeInteraction();
  other.updateConfig({ executorId: 'simulated' });
  assert.equal(other.snapshot().lastError, null);
  assert.equal(createAgentWorkspaceView(other.snapshot()).nodeStatusKey, 'ready');
  const opened = other.send({ text: '其他节点可以发送', idempotencyKey: 'other-node' });
  assert.equal(opened.ok, true);
});

test('契约：输入说明和交付说明进入模拟执行', async () => {
  const planted = seed();
  planted.handoff.inputNote = '需求文档';
  planted.handoff.expectedOutput = '接口定义';
  const session = ExecutionDesk.create(planted, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true })],
    newId: ids(),
  });
  session.updateConfig({ executorId: 'simulated', skillIds: [], mcpIds: [] });
  const sent = session.send({ text: '开始实现', idempotencyKey: 'notes' });
  await session.waitForRun(sent.runId, 'running');
  session.releaseActive();
  await session.flush();
  const body = session.snapshot().turns.find((turn) => turn.role === 'executor')?.body ?? '';
  assert.match(body, /输入说明：需求文档/);
  assert.match(body, /交付说明：接口定义/);
  assert.match(body, /【模拟】/);
});

test('契约：未连接的 MCP 每次运行都记下，界面只显示一次', async () => {
  const planted = seed();
  planted.handoff.mcpRefs = [{ id: 'api-docs', version: '1' }];
  const session = ExecutionDesk.create(planted, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true })],
    newId: ids(),
  });
  session.updateConfig({ executorId: 'simulated', skillIds: [], mcpIds: ['api-docs'] });
  const first = session.send({ text: '第一轮', idempotencyKey: 'mcp-1' });
  await session.waitForRun(first.runId, 'running');
  session.releaseActive();
  await session.flush();
  const second = session.send({ text: '第二轮', idempotencyKey: 'mcp-2' });
  await session.waitForRun(second.runId, 'running');
  session.releaseActive();
  await session.flush();
  const recorded = session.snapshot().activities.filter((item) => item.title === 'MCP');
  assert.equal(recorded.length, 2);
  assert.deepEqual(
    recorded.map((item) => item.runId),
    [first.runId, second.runId],
  );
  assert.equal(
    createAgentWorkspaceView(session.snapshot()).activities.filter((item) => item.title === 'MCP')
      .length,
    1,
  );
});

test('契约：缺入口且不要求评审时，确认完成仍返回记录异常', async () => {
  const planted = seed();
  planted.handoff.reviewRequired = false;
  const { desk: session } = desk({ seed: planted });
  const started = session.send({ text: '不要求评审', idempotencyKey: 'no-review-lost' });
  await session.waitForRun(started.runId, 'running');
  session.dropRecordedEntry();
  const stopped = await session.stop();
  assert.equal(stopped.snapshot.runs.at(-1).status, 'cancelled');
  assert.equal(stopped.snapshot.node.status, 'cancelled');
  const refused = session.confirmCompleted();
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'entry-inconsistent');
  assert.equal(session.snapshot().node.status, 'cancelled');
  assert.equal(session.persistence().nodeState.entryStatus, undefined);
  assert.equal(session.snapshot().downstreamLaunches, 0);
});

test('契约：交接要求评审时确认完成被拒绝', async () => {
  const { desk: session } = desk();
  const sent = session.send({ text: '做完这一轮', idempotencyKey: 'review-gate' });
  await session.waitForRun(sent.runId, 'running');
  session.releaseActive();
  await session.flush();
  const refused = session.confirmCompleted();
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'review-required');
  assert.equal(session.snapshot().node.status, 'ready');
});
