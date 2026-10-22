import assert from 'node:assert/strict';
import test from 'node:test';
import { DshChatExecutor, ExecutionDesk, readDshModelConfig } from '@zhuma/dsh-adapter';

test('真实执行器：发送、停止回执、失败展示和重新开始', { timeout: 180_000 }, async (t) => {
  const config = readDshModelConfig(process.env);
  if (!config.ok) {
    t.skip(`跳过真实执行器：${config.reason}`);
    return;
  }
  const reachable = await gatewayReachable(config.config);
  if (!reachable.ok) {
    t.skip(reachable.reason);
    return;
  }
  const secrets = [config.config.baseUrl, config.config.apiKey];
  const desk = openDesk(new DshChatExecutor(process.env));

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

  await assertFailureDisplay(secrets);
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
  console.log('重新开始：通过');
});

async function gatewayReachable(config) {
  const probe = new AbortController();
  const timer = setTimeout(() => probe.abort(), 8000);
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      method: 'GET',
      signal: probe.signal,
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      return { ok: false, reason: `跳过真实执行器：模型网关返回 HTTP ${response.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: '跳过真实执行器：模型网关不可达。这不是实现失败。' };
  } finally {
    clearTimeout(timer);
  }
}

function openDesk(executor) {
  let n = 0;
  const desk = ExecutionDesk.create(realSeed(), {
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
    if (run?.status === 'completed' && snapshot.node.status === 'ready') continue;
    throw new Error(`停止没有回执：${stopped.ok ? 'completed-without-receipt' : stopped.code}`);
  }
  throw new Error('三次都在停止前结束，没有取得停止回执');
}

async function assertFailureDisplay(secrets) {
  const unknown = openDesk(
    new DshChatExecutor({
      ...process.env,
      ZHUMA_MODEL_ID: 'not-a-model',
    }),
  );
  const refused = unknown.send({ text: '不要调用', idempotencyKey: 'e2e-unknown-model' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'executor-unverified');
  assert.equal(refused.snapshot.runs.length, 0);
  assert.equal(refused.snapshot.config.simulated, false);
  assert.notEqual(refused.snapshot.node.status, 'completed');
  assertClean(refused.snapshot, secrets);

  const wrong = openDesk(
    new DshChatExecutor({
      ...process.env,
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
  assert.match(snapshot.faults[0]?.reason ?? '', /模型网关返回 HTTP|模型调用失败/);
  assertClean(snapshot, [...secrets, 'invalid-key']);
}

function assertClean(value, secrets) {
  const text = JSON.stringify(value);
  if (/https?:\/\//.test(text)) throw new Error('结果里出现了地址');
  for (const secret of secrets) {
    if (secret.length > 0 && text.includes(secret)) throw new Error('结果里出现了地址或密钥');
  }
}

function realSeed() {
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
