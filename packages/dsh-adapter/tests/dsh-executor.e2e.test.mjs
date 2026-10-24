import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync as makeScratch, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DshChatExecutor,
  ExecutionDesk,
  dshSessionHome,
  readDshModelConfig,
  resolveDshBinary,
} from '@zhuma/dsh-adapter';

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

function isolatedEnv(extra = {}) {
  return {
    ...process.env,
    ZHUMA_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'zhuma-e2e-')),
    ...extra,
  };
}

test('真实执行器：发送、停止回执、失败展示和重新开始', { timeout: 180_000 }, async (t) => {
  const config = readDshModelConfig(process.env);
  if (!config.ok) {
    t.skip(`跳过真实执行器：${config.reason}`);
    return;
  }
  if (resolveDshBinary(process.env) === null) {
    throw new Error(
      '模型环境已配置，但没有 DSH 运行时。请运行 pnpm upstream:build-dsh，或设置 ZHUMA_DSH_BIN。',
    );
  }
  const secrets = [config.config.baseUrl, config.config.apiKey];
  const env = isolatedEnv();
  const desk = openDesk(new DshChatExecutor(env));

  const sent = desk.send({ text: '用一句话回复：收到。', idempotencyKey: 'e2e-send' });
  assert.equal(sent.ok, true);
  await desk.flush();
  const afterSend = desk.snapshot();
  const sentRun = afterSend.runs.find((run) => run.id === sent.runId);
  const reply = afterSend.turns.find(
    (turn) => turn.runId === sent.runId && turn.role === 'executor',
  );
  assert.equal(sentRun?.status, 'completed');
  assert.equal(sentRun?.simulated, false);
  assert.equal(sentRun?.executor, 'dsh');
  assert.equal(afterSend.node.status, 'ready');
  assert.equal(desk.persistence().nodeState.entryStatus, 'ready');
  assert.equal((reply?.body ?? '').trim().length > 0, true);
  assert.equal(reply?.simulated, false);
  assertClean(afterSend, secrets);
  console.log('发送：通过');

  const stopped = await stopWhileRunning(desk);
  const stoppedRun = stopped.snapshot.runs.find((run) => run.id === stopped.runId);
  assert.equal(stoppedRun?.status, 'cancelled');
  assert.equal(stoppedRun?.stopPhase, 'confirmed');
  assert.equal(stopped.snapshot.node.status, 'cancelled');
  assert.equal(desk.persistence().nodeState.entryStatus, 'ready');
  assertClean(stopped.snapshot, secrets);
  console.log('停止回执：通过');

  await assertFailureDisplay(secrets, env);
  console.log('失败展示：通过');

  const restarted = desk.retry('e2e-restart');
  assert.equal(restarted.ok, true);
  assert.notEqual(restarted.runId, stopped.runId);
  const returned = desk
    .persistence()
    .nodeState.stored.some(
      (command) => command.result.from === 'cancelled' && command.result.to === 'ready',
    );
  assert.equal(returned, true);
  assert.equal(desk.persistence().nodeState.entryStatus, 'ready');
  await desk.flush();
  const afterRestart = desk.snapshot();
  const nextRun = afterRestart.runs.find((run) => run.id === restarted.runId);
  assert.equal(nextRun?.status, 'completed');
  assert.equal(nextRun?.executor, 'dsh');
  assert.equal(afterRestart.node.status, 'ready');
  assert.equal(desk.persistence().nodeState.entryStatus, 'ready');
  assert.equal(
    afterRestart.runs.some((run) => run.id === stopped.runId && run.status === 'cancelled'),
    true,
  );
  assertClean(afterRestart, secrets);
  await assertRestartFromRevision(new DshChatExecutor(env));
  console.log('重新开始：通过');
});

test('真实执行器：拒绝 PDF 后纯文本仍然成功', { timeout: 180_000 }, async (t) => {
  const config = readDshModelConfig(process.env);
  if (!config.ok) {
    t.skip(`跳过真实执行器：${config.reason}`);
    return;
  }
  if (resolveDshBinary(process.env) === null) {
    throw new Error(
      '模型环境已配置，但没有 DSH 运行时。请运行 pnpm upstream:build-dsh，或设置 ZHUMA_DSH_BIN。',
    );
  }
  const secrets = [config.config.baseUrl, config.config.apiKey];
  const desk = openDesk(new DshChatExecutor(isolatedEnv()));
  const pdf = desk.addAttachment({
    name: '说明.pdf',
    mediaType: 'application/pdf',
    bytesBase64: Buffer.from('%PDF-1.4\n').toString('base64'),
  });
  assert.equal(pdf.ok, false);
  assert.equal(pdf.code, 'attachment-unsupported');
  assert.match(pdf.reason, /没有可发送的附件引用/);
  assert.equal(desk.snapshot().runs.length, 0);
  assert.equal(desk.snapshot().node.status, 'ready');
  assertClean(pdf.snapshot, secrets);
  console.log('上传 PDF：拒绝，没有运行');

  const first = desk.send({ text: '用一句话回复：收到。', idempotencyKey: 'e2e-pdf-text' });
  assert.equal(first.ok, true);
  await desk.flush();
  assert.equal(desk.snapshot().runs.find((run) => run.id === first.runId)?.status, 'completed');
  assert.equal(desk.snapshot().node.status, 'ready');
  assertClean(desk.snapshot(), secrets);
  console.log('第一轮纯文本：通过');

  const second = desk.send({ text: '用一句话回复：继续。', idempotencyKey: 'e2e-pdf-next' });
  assert.equal(second.ok, true);
  await desk.flush();
  const after = desk.snapshot();
  assert.equal(after.runs.find((run) => run.id === second.runId)?.status, 'completed');
  assert.equal(
    after.runs.find((run) => run.id === second.runId)?.sessionId,
    after.runs[0].sessionId,
  );
  assert.equal(after.node.status, 'ready');
  assertClean(after, secrets);
  console.log('第二轮纯文本：通过');
});

test('真实执行器：核实断开后再发一轮成功', { timeout: 180_000 }, async (t) => {
  const ready = realReady(t);
  if (!ready) return;
  const { secrets, env } = ready;
  const pids = [];
  const desk = openDesk(new DshChatExecutor(env, { onSpawn: (pid) => pids.push(pid) }));
  const captured = await captureRunning(desk);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已经退出。
    }
  }
  let n = 0;
  const restored = ExecutionDesk.restore(captured.saved, {
    executors: [new DshChatExecutor(env)],
    newId: (prefix) => `e2e-abandon-${prefix}-${++n}`,
  });
  restored.resumeInteraction();
  const verified = restored.verifyAbandoned();
  assert.equal(verified.ok, true);
  assert.equal(existsSync(dshSessionHome(captured.sessionId, env)), false);
  assert.equal(restored.snapshot().runs[0].sessionId, captured.sessionId);
  assert.equal(restored.snapshot().runs[0].sessionDiscarded, true);
  assert.match(restored.snapshot().historyNote ?? '', /没有带上之前的历史/);
  assert.equal(
    restored
      .snapshot()
      .turns.some((turn) => turn.role === 'executor' && turn.body.trim().length === 0),
    false,
  );
  const again = restored.retry('e2e-after-abandon');
  assert.equal(again.ok, true);
  await restored.flush();
  const next = restored.snapshot().runs.at(-1);
  assert.equal(next?.status, 'completed');
  assert.notEqual(next?.sessionId, captured.sessionId);
  assert.equal(restored.snapshot().runs[0].sessionId, captured.sessionId);
  assert.equal(restored.snapshot().historyNote, undefined);
  assert.equal(restored.snapshot().node.status, 'ready');
  assertClean(restored.snapshot(), secrets);
  console.log('核实断开后再发一轮：通过');
});

test('真实执行器：完成后被退回再发一轮成功', { timeout: 180_000 }, async (t) => {
  const ready = realReady(t);
  if (!ready) return;
  const { secrets, env } = ready;
  const desk = openDesk(new DshChatExecutor(env), 'ready', {
    reviewRequired: false,
    reviewerIds: [],
  });
  const sent = desk.send({ text: '用一句话回复：收到。', idempotencyKey: 'e2e-done-1' });
  assert.equal(sent.ok, true);
  await desk.flush();
  const sessionId = desk.snapshot().runs[0].sessionId;
  assert.equal(typeof sessionId, 'string');
  assert.equal(existsSync(dshSessionHome(sessionId, env)), true);
  const completed = desk.confirmCompleted();
  assert.equal(completed.ok, true);
  assert.equal(desk.snapshot().node.status, 'completed');
  assert.equal(existsSync(dshSessionHome(sessionId, env)), false);
  assert.equal(desk.snapshot().runs[0].sessionId, sessionId);
  assert.equal(desk.snapshot().runs[0].sessionDiscarded, true);
  console.log('节点完成删除会话目录：通过');
  const reopened = desk.reopenForRework();
  assert.equal(reopened.ok, true);
  assert.equal(desk.snapshot().node.status, 'needs-revision');
  assert.match(desk.snapshot().historyNote ?? '', /没有带上之前的历史/);
  const again = desk.send({ text: '用一句话回复：继续。', idempotencyKey: 'e2e-done-2' });
  assert.equal(again.ok, true);
  await desk.flush();
  const next = desk.snapshot().runs.at(-1);
  assert.equal(next?.status, 'completed');
  assert.notEqual(next?.sessionId, sessionId);
  assert.equal(desk.snapshot().historyNote, undefined);
  assert.equal(desk.snapshot().node.status, 'needs-revision');
  assertClean(desk.snapshot(), secrets);
  console.log('完成后被退回再发一轮：通过');
});

function realReady(t) {
  const config = readDshModelConfig(process.env);
  if (!config.ok) {
    t.skip(`跳过真实执行器：${config.reason}`);
    return null;
  }
  if (resolveDshBinary(process.env) === null) {
    throw new Error(
      '模型环境已配置，但没有 DSH 运行时。请运行 pnpm upstream:build-dsh，或设置 ZHUMA_DSH_BIN。',
    );
  }
  return {
    secrets: [config.config.baseUrl, config.config.apiKey],
    env: isolatedEnv(),
  };
}

async function captureRunning(desk) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = desk.send({
      text: `第${attempt}次：请写一段约一百五十字的说明，主题是企业开户字段核对。`,
      idempotencyKey: `e2e-abandon-capture-${attempt}`,
    });
    if (!started.ok) throw new Error(`核实前发送失败：${started.code}`);
    await desk.waitForRun(started.runId, 'running');
    const saved = desk.persistence();
    const run = saved.runs.find((item) => item.id === started.runId);
    if (run?.status === 'running' && typeof run.sessionId === 'string') {
      return { saved, sessionId: run.sessionId, runId: started.runId };
    }
  }
  throw new Error('三次都没有停在执行中');
}

function openDesk(executor, nodeStatus = 'ready', handoffPatch = {}) {
  let n = 0;
  const planted = realSeed(nodeStatus);
  Object.assign(planted.handoff, handoffPatch);
  const desk = ExecutionDesk.create(planted, {
    executors: [executor],
    newId: (prefix) => `${prefix}-${++n}`,
  });
  const configured = desk.updateConfig({
    executorId: 'dsh',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  if (!configured.ok) throw new Error(`配置失败：${configured.code}`);
  return desk;
}

async function stopWhileRunning(desk) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = desk.send({
      text: `第${attempt}次：请写一段约一百五十字的说明，主题是企业开户字段核对。`,
      idempotencyKey: `e2e-stop-${attempt}`,
    });
    if (!started.ok) throw new Error(`停止前发送失败：${started.code}`);
    await desk.waitForRun(started.runId, 'running');
    const stopped = await desk.stop();
    await desk.flush();
    const snapshot = desk.snapshot();
    const run = snapshot.runs.find((item) => item.id === started.runId);
    if (stopped.ok && run?.status === 'cancelled' && run.stopPhase === 'confirmed') {
      return { runId: started.runId, snapshot };
    }
    if (
      run?.status === 'completed' &&
      (snapshot.node.status === 'ready' || snapshot.node.status === 'needs-revision')
    ) {
      continue;
    }
    throw new Error(`停止没有回执：${stopped.ok ? 'completed-without-receipt' : stopped.code}`);
  }
  throw new Error('三次都在停止前结束，没有取得停止回执');
}

async function assertFailureDisplay(secrets, env) {
  const withoutModel = { ...env };
  delete withoutModel.ZHUMA_MODEL_ID;
  const missingModel = openDesk(new DshChatExecutor(withoutModel));
  const refused = missingModel.send({ text: '不要调用', idempotencyKey: 'e2e-missing-model' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'executor-unverified');
  assert.equal(refused.snapshot.runs.length, 0);
  assert.equal(refused.snapshot.config.simulated, false);
  assert.notEqual(refused.snapshot.node.status, 'completed');
  assert.match(refused.reason, /ZHUMA_MODEL_ID/);
  assertClean(refused.snapshot, secrets);

  const wrong = openDesk(
    new DshChatExecutor({
      ...env,
      ZHUMA_MODEL_API_KEY: 'invalid-key',
    }),
  );
  const failedSend = wrong.send({ text: '用一句话回复：收到。', idempotencyKey: 'e2e-bad-key' });
  assert.equal(failedSend.ok, true);
  await wrong.flush();
  const snapshot = wrong.snapshot();
  const run = snapshot.runs.find((item) => item.id === failedSend.runId);
  assert.equal(run?.status, 'failed');
  assert.equal(run?.executor, 'dsh');
  assert.equal(run?.simulated, false);
  assert.equal(snapshot.node.status, 'failed');
  assert.notEqual(snapshot.node.status, 'completed');
  assert.equal(snapshot.faults[0]?.forgesRun, false);
  const reason = snapshot.faults[0]?.reason ?? '';
  assert.match(reason, /模型调用失败|执行器启动失败|执行器没有在时限内/);
  assert.equal(reason.includes('invalid-key'), false);
  assertClean(snapshot, [...secrets, 'invalid-key']);
}

async function assertRestartFromRevision(executor) {
  const desk = openDesk(executor, 'needs-revision');
  const sent = desk.send({ text: '用一句话回复：收到。', idempotencyKey: 'e2e-rev-send' });
  assert.equal(sent.ok, true);
  await desk.flush();
  assert.equal(desk.snapshot().node.status, 'needs-revision');
  assert.equal(desk.persistence().nodeState.entryStatus, 'needs-revision');
  const stopped = await stopWhileRunning(desk);
  assert.equal(stopped.snapshot.node.status, 'cancelled');
  assert.equal(desk.persistence().nodeState.entryStatus, 'needs-revision');
  const restarted = desk.retry('e2e-rev-restart');
  assert.equal(restarted.ok, true);
  assert.notEqual(restarted.runId, stopped.runId);
  assert.equal(
    desk
      .persistence()
      .nodeState.stored.some(
        (command) => command.result.from === 'cancelled' && command.result.to === 'needs-revision',
      ),
    true,
  );
  await desk.flush();
  assert.equal(desk.snapshot().runs.find((run) => run.id === restarted.runId)?.status, 'completed');
  assert.equal(desk.snapshot().node.status, 'needs-revision');
  assert.equal(desk.persistence().nodeState.entryStatus, 'needs-revision');
}

function assertClean(value, secrets) {
  const text = JSON.stringify(value);
  if (/https?:\/\//.test(text)) throw new Error('结果里出现了地址');
  for (const secret of secrets) {
    if (secret.length > 0 && text.includes(secret)) throw new Error('结果里出现了地址或密钥');
  }
}

function realSeed(nodeStatus = 'ready') {
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
      inputNote: '读取已通过评审的开户字段说明',
      expectedOutput: '开户字段校验规则说明',
    },
    taskTitle: '企业客户门户季度交付',
    taskGoal: '完成企业客户开户闭环',
    actorId: 'chen-ning',
    nodeStatus,
    catalog: {
      experts: [
        {
          id: 'api-impl',
          versionId: 'api-impl-v1',
          label: '接口实现',
          summary: '整理接口字段与校验',
          enabled: true,
          presetSkillIds: ['test-design'],
          presetMcpIds: ['api-docs'],
        },
      ],
      skills: [{ id: 'test-design', version: '1', label: '测试设计', available: true }],
      mcp: [{ id: 'api-docs', version: '1', label: '接口文档只读', available: true }],
      executors: [
        {
          id: 'dsh',
          label: 'DSH 原生',
          available: true,
          verified: true,
          simulated: false,
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
    ],
    reviewRounds: [],
  };
}
