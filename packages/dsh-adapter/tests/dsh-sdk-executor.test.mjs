import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync as makeScratch,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  DshChatExecutor,
  ExecutionDesk,
  createFileJournal,
  createWorkbenchServer,
  describeDshSessionEvent,
  dshSessionHome,
  sweepDshSessionOrphans,
} from '@zhuma/dsh-adapter';
import { StderrRedactor, missingDshRuntimeReason } from '../dist/dsh-sdk-executor.js';
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

const stub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh-boundary-stub.mjs');
chmodSync(stub, 0o755);
const marker = 'zhuma-marker-secret-value';

function ids(tag = 'desk') {
  let n = 0;
  return (prefix) => `${tag}-${prefix}-${++n}`;
}

function modelEnv(apiKey = 'test-key') {
  return {
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1',
    ZHUMA_MODEL_API_KEY: apiKey,
    ZHUMA_MODEL_ID: 'test-model',
    ZHUMA_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'zhuma-dsh-data-')),
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ZHUMA_PARENT_ONLY: 'parent-marker',
  };
}

function executor(mode, extra = {}) {
  const pids = [];
  const env = extra.env ?? modelEnv(extra.apiKey);
  const engine = new DshChatExecutor(env, {
    bin: extra.bin ?? stub,
    mode,
    // Content/permission positives use the real executor's normal budgets;
    // only timing/fault fixtures need the shorter test-specific overrides.
    ...(extra.runtimeDeadlines
      ? {}
      : {
          initTimeoutMs: extra.initTimeoutMs ?? 2000,
          promptTimeoutMs: extra.promptTimeoutMs ?? 2000,
        }),
    onSpawn: (pid) => pids.push(pid),
  });
  return { engine, pids, env };
}

function seed() {
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
      inputRefs: [{ sourceNodeId: 'node-a', artifactVersionId: 'art-1' }],
      expertRef: { id: 'api-impl', version: 'api-impl-v1' },
      skillRefs: [
        { id: 'test-design', version: 'plan-skill-1' },
        { id: 'review-code', version: 'plan-review-1' },
      ],
      mcpRefs: [
        { id: 'api-docs', version: 'plan-mcp-1' },
        { id: 'billing-mcp', version: 'plan-bill-1' },
      ],
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
      skills: [
        { id: 'test-design', version: '1', label: '测试设计', available: true },
        { id: 'review-code', version: '1', label: '代码评审', available: true },
        { id: 'billing', version: '1', label: '账单', available: true },
      ],
      mcp: [
        { id: 'api-docs', version: '1', label: '接口文档只读', available: true },
        { id: 'billing-mcp', version: '1', label: '账单工具', available: true },
        { id: 'extra-mcp', version: '1', label: '额外工具', available: true },
      ],
      executors: [
        { id: 'dsh', label: 'DSH', available: true, verified: true, simulated: false },
        { id: 'simulated', label: '模拟执行器', available: true, verified: false, simulated: true },
      ],
    },
    contextItems: [
      {
        id: 'kept',
        kind: 'node-input',
        sourceId: 'kept-source',
        version: '1',
        permission: 'granted',
        summary: '匹配的上下文',
        required: true,
        includedByDefault: true,
        body: '应该进入提示',
        sourceNodeId: 'node-a',
        artifactVersionId: 'art-1',
      },
      {
        id: 'dropped',
        kind: 'node-input',
        sourceId: 'dropped-source',
        version: '1',
        permission: 'granted',
        summary: '版本不同',
        required: false,
        includedByDefault: true,
        body: '不要进入提示',
        sourceNodeId: 'node-a',
        artifactVersionId: 'art-2',
      },
    ],
    reviewRounds: [],
  };
}

function open(mode, extra = {}) {
  const { engine, pids, env } = executor(mode, extra);
  const planted = seed();
  if (extra.reviewRequired !== undefined) planted.handoff.reviewRequired = extra.reviewRequired;
  if (extra.reviewerIds !== undefined) planted.handoff.reviewerIds = extra.reviewerIds;
  if (extra.inputNote !== undefined) planted.handoff.inputNote = extra.inputNote;
  if (extra.expectedOutput !== undefined) planted.handoff.expectedOutput = extra.expectedOutput;
  const desk = ExecutionDesk.create(planted, {
    executors: [engine],
    newId: ids(mode),
    journal: extra.journal,
  });
  desk.updateConfig({
    executorId: 'dsh',
    skillIds: extra.skillIds ?? ['test-design', 'billing'],
    mcpIds: extra.mcpIds ?? ['api-docs', 'extra-mcp'],
  });
  return { desk, pids, env };
}

function homeOf(desk, env, runId) {
  const run = desk.snapshot().runs.find((item) => item.id === runId);
  if (run?.sessionId === undefined) throw new Error(`运行没有会话标识：${runId}`);
  return dshSessionHome(run.sessionId, env);
}

function sessionHomes(env) {
  const root = path.join(env.ZHUMA_DATA_DIR, 'dsh-sessions');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith('dsh-'));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function walk(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function assertNoSecret(dir, secret) {
  for (const file of walk(dir)) {
    assert.equal(readFileSync(file).includes(secret), false, file);
  }
}

async function collect(mode, extra = {}) {
  const { engine, pids, env } = executor(mode, extra);
  const events = [];
  for await (const event of engine.run({
    runId: extra.runId ?? `run-${mode}`,
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
    ...(extra.attachments !== undefined ? { attachments: extra.attachments } : {}),
    ...(extra.skills !== undefined ? { skills: extra.skills } : {}),
    goal: '确认字段',
    simulatedRequested: false,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return { events, pids, env };
}

test('契约：未授权的技能和 MCP 进不了这次运行', async () => {
  const { desk, pids, env } = open('ok', { runtimeDeadlines: true });
  const image = desk.addAttachment({
    name: '图.png',
    mediaType: 'image/png',
    text: 'zhuma-image-bytes',
  });
  const other = desk.addAttachment({
    name: '旁路.txt',
    mediaType: 'text/plain',
    text: '不要发给模型',
  });
  const pdf = desk.addAttachment({
    name: '说明.pdf',
    mediaType: 'application/pdf',
    bytesBase64: Buffer.from('%PDF-1.4 binary').toString('base64'),
  });
  assert.equal(image.ok, true);
  assert.equal(other.ok, true);
  assert.equal(pdf.ok, false);
  assert.equal(pdf.code, 'attachment-unsupported');
  assert.match(pdf.reason, /没有可发送的附件引用/);
  assert.equal(
    pdf.snapshot.attachments.some((item) => item.name === '说明.pdf'),
    false,
  );
  assert.equal(pdf.snapshot.runs.length, 0);
  const imageId = image.snapshot.attachments[0].id;
  const sent = desk.send({
    text: '只带这一张图',
    idempotencyKey: 'grant-send',
    attachmentIds: [imageId],
  });
  assert.equal(sent.ok, true);
  await desk.flush();
  assert.equal(
    desk.snapshot().runs.find((run) => run.id === sent.runId)?.status,
    'completed',
    desk
      .snapshot()
      .faults.map((fault) => fault.reason)
      .join('\n'),
  );
  const home = homeOf(desk, env, sent.runId);
  const visible = JSON.parse(readFileSync(path.join(home, 'zhuma-visible.json'), 'utf8'));
  assert.deepEqual(visible.skills, [{ id: 'test-design', version: 'plan-skill-1' }]);
  assert.deepEqual(visible.mcp, []);
  assert.equal(visible.toolsDisabled.includes('tool-bash'), true);
  assert.equal(visible.toolsDisabled.includes('tool-web'), true);
  assert.equal(visible.toolsDisabled.includes('tool-subagent'), true);
  const skill = readFileSync(path.join(home, 'granted-skills', 'test-design', 'SKILL.md'), 'utf8');
  assert.match(skill, /name: test-design/);
  assert.match(skill, /description: "测试设计"/);
  assert.match(skill, /版本：plan-skill-1/);
  assert.equal(existsSync(path.join(home, 'zhuma-mode.json')), false);
  const patch = readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
  assert.equal(patch.trimStart().startsWith('-'), true);
  assert.equal(/^plugins\s*:/m.test(patch), false);
  assert.match(patch, /id: skill-office[\s\S]*disabled: true/);
  assert.match(patch, /includeDefaultRoots: false/);
  assert.match(patch, /id: tool-bash\n  disabled: true/);
  assert.match(patch, /input:\n {14}- text\n {14}- image/);
  await assertUpstreamPatch(path.join(home, 'cordis.patch.yml'));
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(home, 'cordis.patch.yml')).mode & 0o777, 0o600);
  const prompt = readFileSync(path.join(home, 'zhuma-prompt.json'), 'utf8');
  assert.match(prompt, /应该进入提示/);
  assert.match(prompt, /本次运行已授权的 MCP：api-docs/);
  assert.equal(prompt.includes('extra-mcp'), false);
  assert.equal(prompt.includes('billing-mcp'), false);
  assert.equal(prompt.includes('不要进入提示'), false);
  assert.equal(prompt.includes('不要发给模型'), false);
  assert.equal(prompt.includes('%PDF-1.4'), false);
  assert.equal(prompt.includes('"type":"file"'), false);
  assert.match(prompt, /"type":"image"/);
  const encoded = Buffer.from('zhuma-image-bytes', 'utf8').toString('base64');
  const admitted = readFileSync(path.join(home, 'zhuma-attachments', 'image-0'));
  assert.deepEqual(admitted, Buffer.from('zhuma-image-bytes', 'utf8'));
  assert.equal(
    readFileSync(path.join(home, 'zhuma-session.jsonl'), 'utf8').includes(encoded),
    false,
  );
  assert.equal(
    pids.every((pid) => !alive(pid)),
    true,
  );
  assert.equal(
    desk
      .snapshot()
      .activities.some(
        (item) =>
          item.title === 'MCP' && item.succeeded === false && item.detail.includes('未连接'),
      ),
    true,
  );
  rmSync(home, { recursive: true, force: true });
});

test('契约：空的上下文引用不会把上下文包放进提示', async () => {
  const { engine, pids, env } = executor('ok', { runtimeDeadlines: true });
  const bare = seed();
  bare.handoff.inputRefs = [];
  const desk = ExecutionDesk.create(bare, { executors: [engine], newId: ids('empty-context') });
  desk.updateConfig({ executorId: 'dsh', skillIds: ['test-design'], mcpIds: ['api-docs'] });
  const sent = desk.send({ text: '没有上下文包', idempotencyKey: 'empty-context' });
  await desk.flush();
  assert.equal(
    desk.snapshot().runs.find((run) => run.id === sent.runId)?.status,
    'completed',
    desk
      .snapshot()
      .faults.map((fault) => fault.reason)
      .join('\n'),
  );
  const prompt = readFileSync(
    path.join(homeOf(desk, env, sent.runId), 'zhuma-prompt.json'),
    'utf8',
  );
  assert.equal(prompt.includes('应该进入提示'), false);
  assert.equal(desk.snapshot().citations.length, 0);
  assert.equal(desk.snapshot().runs[0].contextRefs.length, 0);
  assert.equal(
    pids.every((pid) => !alive(pid)),
    true,
  );
  rmSync(homeOf(desk, env, sent.runId), { recursive: true, force: true });
});

test('契约：启动超时、握手失败和接收前停止都记为未应用', async () => {
  const timed = open('hang-init', { initTimeoutMs: 200, promptTimeoutMs: 200 });
  const first = timed.desk.send({ text: '还没接上', idempotencyKey: 'timeout-send' });
  const queued = timed.desk.send({
    text: '排队的补充',
    idempotencyKey: 'timeout-queue',
    intent: 'supplement',
  });
  assert.equal(first.ok, true);
  assert.equal(queued.ok, true);
  await timed.desk.flush();
  assert.equal(timed.desk.snapshot().runs[0].status, 'failed');
  assert.equal(timed.desk.snapshot().runs[0].acknowledged, false);
  assert.equal(timed.desk.snapshot().node.status, 'ready');
  assert.equal(timed.desk.snapshot().interventions[0].phase, 'not-applied');
  assert.match(timed.desk.snapshot().faults[0].reason, /启动超时/);
  assert.equal(
    timed.desk
      .persistence()
      .nodeState.stored.some((item) => item.idempotencyKey.startsWith('ack:')),
    false,
  );
  assert.deepEqual(sessionHomes(timed.env), []);
  assert.equal(
    timed.pids.every((pid) => !alive(pid)),
    true,
  );

  const crashed = open('crash-init');
  const crashSend = crashed.desk.send({ text: '握手失败', idempotencyKey: 'crash-send' });
  crashed.desk.send({ text: '崩溃前的补充', idempotencyKey: 'crash-queue', intent: 'supplement' });
  await crashed.desk.flush();
  assert.equal(crashed.desk.snapshot().runs[0].status, 'failed');
  assert.equal(crashed.desk.snapshot().runs[0].acknowledged, false);
  assert.equal(crashed.desk.snapshot().node.status, 'ready');
  assert.equal(crashed.desk.snapshot().interventions[0].phase, 'not-applied');
  assert.match(crashed.desk.snapshot().faults[0].reason, /启动失败/);
  assert.deepEqual(sessionHomes(crashed.env), []);
  assert.equal(
    crashed.pids.every((pid) => !alive(pid)),
    true,
  );

  const stopped = open('hang-prompt', { promptTimeoutMs: 8000 });
  const stopSend = stopped.desk.send({ text: '接收前停止', idempotencyKey: 'stop-send' });
  stopped.desk.send({ text: '停止前的补充', idempotencyKey: 'stop-queue', intent: 'supplement' });
  const receipt = await stopped.desk.stop();
  await stopped.desk.flush();
  assert.equal(receipt.ok, true);
  assert.equal(stopped.desk.snapshot().runs[0].status, 'cancelled');
  assert.equal(stopped.desk.snapshot().runs[0].acknowledged, false);
  assert.equal(stopped.desk.snapshot().node.status, 'ready');
  assert.equal(stopped.desk.snapshot().interventions[0].phase, 'not-applied');
  assert.equal(
    stopped.desk
      .persistence()
      .nodeState.stored.some((item) => item.idempotencyKey.startsWith('cancel:')),
    false,
  );
  assert.equal(
    stopped.pids.every((pid) => !alive(pid)),
    true,
  );
  assert.deepEqual(sessionHomes(stopped.env), []);
});

test('契约：停止后能恢复历史，进程表里没有残留', async () => {
  process.env.ZHUMA_PARENT_ONLY = 'parent-marker';
  const { desk, pids, env } = open('hold-after-messageId', {
    apiKey: marker,
    promptTimeoutMs: 8000,
  });
  try {
    const sent = desk.send({ text: '第一段历史', idempotencyKey: 'resume-send' });
    await desk.waitForRun(sent.runId, 'running');
    const sessionId = desk.snapshot().runs[0].sessionId;
    assert.match(sessionId, /^zhuma-[0-9a-f]{8}-[0-9a-f]{12}$/);
    assert.notEqual(sessionId, `zhuma-${sent.runId}`);
    const home = dshSessionHome(sessionId, env);
    const pid = Number(readFileSync(path.join(home, 'zhuma-pid'), 'utf8'));
    assert.equal(alive(pid), true);
    const cmdline = execFileSync('ps', ['-p', String(pid), '-o', 'args=']).toString();
    assert.equal(cmdline.includes(marker), false);
    assert.match(cmdline, /--profile sdk/);
    const argv = JSON.parse(readFileSync(path.join(home, 'zhuma-argv.json'), 'utf8'));
    assert.deepEqual(argv, ['--profile', 'sdk']);
    const keys = JSON.parse(readFileSync(path.join(home, 'zhuma-env-keys.json'), 'utf8'));
    assert.equal(keys.includes('ZHUMA_MODEL_API_KEY'), true);
    assert.equal(keys.includes('DSH_TELEMETRY_DISABLED'), true);
    assert.equal(keys.includes('DSH_TELEMETRY_MODE'), true);
    assert.equal(keys.includes('ZHUMA_PARENT_ONLY'), false);
    assertNoSecret(home, marker);
    assertNoSecret(home, 'parent-marker');
    const stopped = await desk.stop();
    await desk.flush();
    assert.equal(stopped.ok, true);
    assert.equal(desk.snapshot().node.status, 'cancelled');
    assert.equal(alive(pid), false);
    const again = desk.retry('resume-again');
    await desk.waitForRun(again.runId, 'running');
    const history = readFileSync(path.join(home, 'zhuma-history.json'), 'utf8');
    assert.match(history, /第一段历史/);
    const second = Number(readFileSync(path.join(home, 'zhuma-pid'), 'utf8'));
    writeFileSync(path.join(home, 'zhuma-release'), '1');
    await desk.flush();
    assert.equal(alive(second), false);
    assert.equal(
      pids.every((item) => !alive(item)),
      true,
    );
    const stderr = readFileSync(path.join(home, 'zhuma-collected-stderr.txt'), 'utf8');
    assert.match(stderr, /\[redacted\]/);
    assert.equal(stderr.includes(marker), false);
    const snapshot = desk.snapshot();
    const view = createAgentWorkspaceView(snapshot);
    const visible = JSON.stringify({ snapshot, view });
    assert.equal(visible.includes(marker), false);
    rmSync(home, { recursive: true, force: true });
  } finally {
    delete process.env.ZHUMA_PARENT_ONLY;
  }
});

test('契约：非 JSON 行不会卡住，空回复和工具调用不算成功', async () => {
  const noise = await collect('noise', { runId: 'noise-run' });
  assert.equal(noise.events.at(-1).type, 'completed');
  assert.equal(
    noise.events.some(
      (event) => event.type === 'activity' && event.activity.detail.includes('非 JSON'),
    ),
    true,
  );
  assert.equal(
    noise.events.some(
      (event) => event.type === 'failed' && event.fault === 'executor-disconnected',
    ),
    false,
  );
  assert.equal(
    noise.pids.every((pid) => !alive(pid)),
    true,
  );

  const empty = await collect('empty', { runId: 'empty-run' });
  assert.equal(empty.events.at(-1).type, 'failed');
  assert.equal(empty.events.at(-1).fault, 'model-error');
  assert.equal(
    empty.events.some((event) => event.type === 'completed'),
    false,
  );

  const tools = await collect('tools', { runId: 'tools-run' });
  assert.equal(tools.events.at(-1).fault, 'tool-failure');
  assert.equal(
    tools.events.some((event) => event.type === 'completed'),
    false,
  );

  const missing = await collect('no-message-id', { runId: 'missing-id' });
  assert.equal(
    missing.events.some((event) => event.type === 'accepted'),
    false,
  );
  assert.match(missing.events.at(-1).message, /没有返回接收回执/);
  for (const item of [noise, empty, tools, missing]) {
    const accepted = item.events.find((event) => event.type === 'accepted');
    if (accepted?.sessionId !== undefined) {
      rmSync(dshSessionHome(accepted.sessionId, item.env), { recursive: true, force: true });
    }
    assert.equal(
      item.events.some((event) => event.type === 'accepted') || sessionHomes(item.env).length === 0,
      true,
    );
  }
  assert.deepEqual(sessionHomes(missing.env), []);
});

test('契约：找不到运行时会明确失败，不改用模拟', async () => {
  const missing = new DshChatExecutor({
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1',
    ZHUMA_MODEL_API_KEY: 'test-key',
    ZHUMA_MODEL_ID: 'test-model',
    ZHUMA_DSH_BIN: '/tmp/zhuma-no-such-dsh',
  });
  assert.equal(missing.capabilities.verified, false);
  await assert.rejects(async () => {
    for await (const event of missing.run({
      runId: 'missing-bin',
      attempt: 1,
      generation: 1,
      taskId: 'task',
      nodeId: 'node',
      workflowVersionId: 'plan',
      planRevision: 1,
      contextReferences: [],
      expertVersionId: 'expert-v1',
      resourceGrants: [],
      instruction: '不要调用',
      attachmentIds: [],
      goal: '确认字段',
      simulatedRequested: false,
      signal: new AbortController().signal,
    })) {
      void event;
    }
  }, /pnpm upstream:build-dsh/);
  const runtimeReason = missingDshRuntimeReason();
  assert.match(runtimeReason, /ZHUMA_DSH_BIN/);
  assert.match(runtimeReason, /ZHUMA_MODEL_BASE_URL/);
  assert.match(runtimeReason, /ZHUMA_MODEL_API_KEY/);
  assert.match(runtimeReason, /ZHUMA_MODEL_ID/);
  assert.match(runtimeReason, /不会改用模拟执行器/);
  const serverSource = readFileSync(
    fileURLToPath(new URL('../../../examples/agent-workspace/server.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(serverSource, /还需要 ZHUMA_MODEL_BASE_URL、ZHUMA_MODEL_API_KEY 和 ZHUMA_MODEL_ID/);
  const desk = ExecutionDesk.create(seed(), { executors: [missing], newId: ids('missing-bin') });
  desk.updateConfig({ executorId: 'dsh' });
  const refused = desk.send({ text: '不要调用', idempotencyKey: 'missing-bin-send' });
  assert.equal(refused.ok, false);
  assert.equal(refused.snapshot.runs.length, 0);
  assert.equal(refused.reason, runtimeReason);
  assert.match(refused.reason, /ZHUMA_MODEL_ID/);
  assert.equal(refused.reason.includes('模拟'), true);
  assert.equal(missing.capabilities.sessionResume, true);
  assert.equal(missing.capabilities.streaming, false);
});

test('契约：录制的上游事件能读出正文和结束原因', () => {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'dsh-recorded-event.json',
  );
  const notes = JSON.parse(readFileSync(file, 'utf8'));
  const assistant = describeDshSessionEvent(notes[0].params.event);
  assert.equal(assistant.type, 'assistant/message');
  assert.equal(assistant.text, '你好，这是录制的回复。');
  const end = describeDshSessionEvent(notes[1].params.event);
  assert.equal(end.type, 'turn/end');
  assert.equal(end.reasonKind, 'completed');
});

test('契约：取消勾选后，提示、运行引用和界面引用是同一组', async () => {
  const { engine, env } = executor('ok');
  const input = seed();
  input.handoff.inputRefs = [
    ...input.handoff.inputRefs,
    {
      sourceNodeId: 'node-optional',
      artifactVersionId: 'art-optional',
      contextPackId: 'pack-optional',
    },
  ];
  input.contextItems.push({
    id: 'optional',
    kind: 'node-input',
    sourceId: 'optional-source',
    version: '1',
    permission: 'granted',
    summary: '可选上下文',
    required: false,
    includedByDefault: true,
    body: 'OPTIONAL-BODY',
    sourceNodeId: 'node-optional',
    artifactVersionId: 'art-optional',
    contextPackId: 'pack-optional',
  });
  const desk = ExecutionDesk.create(input, { executors: [engine], newId: ids('uncheck') });
  desk.updateConfig({ executorId: 'dsh', skillIds: ['test-design'], mcpIds: [] });
  const sent = desk.send({ text: '带上可选项', idempotencyKey: 'opt-1' });
  await desk.flush();
  const first = readFileSync(path.join(homeOf(desk, env, sent.runId), 'zhuma-prompt.json'), 'utf8');
  assert.match(first, /OPTIONAL-BODY/);
  assert.match(first, /应该进入提示/);
  assert.equal(desk.snapshot().runs[0].contextRefs.includes('node-input:optional-source@1'), true);
  assert.equal(
    desk.snapshot().citations.some((item) => item.summary === '可选上下文'),
    true,
  );
  desk.setContextIncluded('optional', false);
  const again = desk.send({ text: '去掉可选项', idempotencyKey: 'opt-2' });
  await desk.flush();
  const secondHome = dshSessionHome(desk.snapshot().runs[1].sessionId, env);
  const second = readFileSync(path.join(secondHome, 'zhuma-prompt.json'), 'utf8');
  assert.equal(second.includes('OPTIONAL-BODY'), false);
  assert.match(second, /应该进入提示/);
  const latest = desk.snapshot();
  assert.equal(latest.runs[1].contextRefs.includes('node-input:optional-source@1'), false);
  assert.equal(
    latest.citations.some((item) => item.summary === '可选上下文'),
    false,
  );
  assert.equal(
    latest.citations.some((item) => item.summary === '匹配的上下文'),
    true,
  );
  const view = createAgentWorkspaceView(latest);
  assert.equal(
    view.citations.some((item) => item.summary === '可选上下文'),
    false,
  );
  assert.equal(
    view.citations.some((item) => item.summary === '匹配的上下文'),
    true,
  );
});

test('契约：进程立即退出或不许执行时，这次运行失败且不拖垮调用方', async () => {
  const env = modelEnv(marker);
  const started = Date.now();
  const boot = await collect('stderr-boot', {
    env,
    apiKey: marker,
    initTimeoutMs: 30_000,
    runId: 'stderr-boot',
  });
  assert.equal(Date.now() - started < 5000, true);
  assert.equal(boot.events.at(-1).type, 'failed');
  assert.match(boot.events.at(-1).message, /启动失败/);
  assert.match(boot.events.at(-1).message, /\[redacted\]/);
  assert.equal(boot.events.at(-1).message.includes(marker), false);
  assert.deepEqual(sessionHomes(env), []);

  const deniedAt = Date.now();
  const bin = path.join(env.ZHUMA_DATA_DIR, 'not-executable');
  writeFileSync(bin, '#!/bin/sh\necho no\n');
  chmodSync(bin, 0o644);
  const denied = await collect('ok', {
    env,
    bin,
    initTimeoutMs: 30_000,
    runId: 'denied-bin',
  });
  assert.equal(Date.now() - deniedAt < 5000, true);
  assert.match(denied.events.at(-1).message, /启动失败/);

  const falseEnv = modelEnv('false-marker');
  const falseAt = Date.now();
  const crashed = await collect('ok', {
    env: falseEnv,
    bin: '/bin/false',
    initTimeoutMs: 30_000,
    runId: 'false-bin',
  });
  assert.equal(Date.now() - falseAt < 5000, true);
  assert.equal(crashed.events.at(-1).type, 'failed');
  assert.match(crashed.events.at(-1).message, /启动失败/);
});

test('契约：密钥跨数据块时不会进入失败消息或收集的标准错误', async () => {
  const secret = 'zhuma-synthetic-marker';
  const env = modelEnv(secret);
  const startup = '执行器启动失败。\npreface-[redacted]-tail';
  for (let index = 1; index < secret.length; index += 1) {
    const boot = await collect(`stderr-boot-split:${index}`, {
      env,
      initTimeoutMs: 20_000,
      runId: `stderr-split-${index}`,
    });
    const failed = boot.events.at(-1);
    assert.equal(failed.type, 'failed');
    assert.equal(failed.message, startup);
    assert.equal(JSON.stringify(boot.events).includes(secret), false);
  }

  const bytes = await collect('stderr-boot-bytes', {
    env,
    initTimeoutMs: 20_000,
    runId: 'stderr-bytes',
  });
  assert.equal(bytes.events.at(-1).type, 'failed');
  assert.equal(bytes.events.at(-1).message, startup);
  assert.equal(JSON.stringify(bytes.events).includes(secret), false);

  const repeated = await collect('stderr-boot-repeat', {
    env,
    initTimeoutMs: 20_000,
    runId: 'stderr-repeat',
  });
  assert.equal(repeated.events.at(-1).type, 'failed');
  assert.equal(
    repeated.events.at(-1).message,
    '执行器启动失败。\nhead [redacted] gap [redacted] tail',
  );
  assert.equal(JSON.stringify(repeated.events).includes(secret), false);

  const ok = await collect('stderr-ok-split', {
    env,
    initTimeoutMs: 20_000,
    promptTimeoutMs: 20_000,
    runId: 'stderr-ok-split',
  });
  assert.equal(ok.events.at(-1).type, 'completed');
  assert.equal(JSON.stringify(ok.events).includes(secret), false);
  const accepted = ok.events.find((event) => event.type === 'accepted');
  const home = dshSessionHome(accepted.sessionId, env);
  assert.equal(
    readFileSync(path.join(home, 'zhuma-collected-stderr.txt'), 'utf8'),
    'preface-[redacted]-tail',
  );
});

const grandchildHoldMs = 8000;
const stderrSealBoundMs = 2000;

function grandchildPidFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'zhuma-gc-')), 'pid');
}

async function reapGrandchild(pidFile) {
  const dir = path.dirname(pidFile);
  let pid = 0;
  try {
    pid = Number(readFileSync(pidFile, 'utf8'));
  } catch {
    pid = 0;
  }
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出。
    }
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive(pid), false, `孙进程 ${pid} 还在`);
  }
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
}

function runInput(runId) {
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
    simulatedRequested: false,
    signal: new AbortController().signal,
  };
}

// 回归：封口时不销毁本轮 spawn 的 stdin/stdout/stderr，close 要等孙进程退出。
// 不读 /proc。子进程里把 /proc 挡成 ENOENT，Linux 和 macOS 走同一条断言。
async function driveTrackedStdio(pidFile) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'zhuma-stdio-pipe-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'zhuma-stdio-drive-'));
  const script = path.join(dir, 'drive.mjs');
  writeFileSync(
    script,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      'const denyProc = (target) => {',
      '  const text = String(target ?? "");',
      "  if (text === '/proc' || text.startsWith('/proc/')) {",
      "    const error = new Error(`ENOENT: no such file or directory, open '${text}'`);",
      "    error.code = 'ENOENT';",
      '    throw error;',
      '  }',
      '};',
      'for (const name of ["accessSync", "lstatSync", "openSync", "readdirSync", "readFileSync", "statSync"]) {',
      '  const original = fs[name];',
      '  fs[name] = (target, ...args) => {',
      '    denyProc(target);',
      '    return original.call(fs, target, ...args);',
      '  };',
      '}',
      'let procBlocked = false;',
      'try {',
      "  fs.readdirSync('/proc/self/fd');",
      '} catch (error) {',
      "  procBlocked = error?.code === 'ENOENT';",
      '}',
      'const tracked = [];',
      'const originalSpawn = cp.spawn;',
      'cp.spawn = (...args) => {',
      '  const child = originalSpawn(...args);',
      '  const pipes = { stdin: false, stdout: false, stderr: false };',
      "  for (const name of ['stdin', 'stdout', 'stderr']) {",
      "    child[name]?.on('close', () => {",
      '      pipes[name] = true;',
      '    });',
      '  }',
      '  tracked.push(pipes);',
      '  return child;',
      '};',
      'const { DshChatExecutor } = await import(process.env.ZHUMA_ADAPTER);',
      'const started = Date.now();',
      'const engine = new DshChatExecutor(',
      '  {',
      '    ZHUMA_MODEL_BASE_URL: process.env.ZHUMA_MODEL_BASE_URL,',
      '    ZHUMA_MODEL_API_KEY: process.env.ZHUMA_MODEL_API_KEY,',
      '    ZHUMA_MODEL_ID: process.env.ZHUMA_MODEL_ID,',
      '    ZHUMA_DATA_DIR: process.env.ZHUMA_DATA_DIR,',
      '    PATH: process.env.PATH,',
      '    HOME: process.env.HOME,',
      '    TMPDIR: process.env.TMPDIR,',
      '  },',
      '  {',
      '    bin: process.env.ZHUMA_STUB,',
      '    mode: `stdio-gc:${process.env.ZHUMA_PID_FILE}`,',
      '    initTimeoutMs: 20000,',
      '  },',
      ');',
      'const events = [];',
      'for await (const event of engine.run({',
      "  runId: 'stdio-gc',",
      '  attempt: 1,',
      '  generation: 1,',
      "  taskId: 'task',",
      "  nodeId: 'node',",
      "  workflowVersionId: 'plan',",
      '  planRevision: 1,',
      '  contextReferences: [],',
      "  expertVersionId: 'expert-v1',",
      '  resourceGrants: [],',
      "  instruction: '整理字段',",
      '  attachmentIds: [],',
      "  goal: '确认字段',",
      '  simulatedRequested: false,',
      '  signal: new AbortController().signal,',
      '})) {',
      '  events.push({ type: event.type, message: event.message ?? "" });',
      '}',
      'const roundElapsed = Date.now() - started;',
      'const deadline = started + 2000;',
      'while (',
      '  Date.now() < deadline &&',
      '  tracked.some((item) => !item.stdin || !item.stdout || !item.stderr)',
      ') {',
      '  await new Promise((resolve) => setTimeout(resolve, 20));',
      '}',
      'const last = events.at(-1) ?? {};',
      'const pipes = tracked[0] ?? { stdin: false, stdout: false, stderr: false };',
      'const openLeft = tracked.filter((item) => !item.stdin || !item.stdout || !item.stderr).length;',
      'const payload = JSON.stringify({',
      '  type: last.type ?? "",',
      '  message: last.message ?? "",',
      '  roundElapsed,',
      '  spawned: tracked.length,',
      '  stdinClosed: pipes.stdin,',
      '  stdoutClosed: pipes.stdout,',
      '  stderrClosed: pipes.stderr,',
      '  openLeft,',
      '  procBlocked,',
      '});',
      'await new Promise((resolve) => process.stdout.write(payload, () => resolve()));',
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  const env = {
    ...process.env,
    ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1',
    ZHUMA_MODEL_API_KEY: 'zhuma-synthetic-marker',
    ZHUMA_MODEL_ID: 'test-model',
    ZHUMA_DATA_DIR: dataDir,
    ZHUMA_PID_FILE: pidFile,
    ZHUMA_STUB: stub,
    ZHUMA_ADAPTER: pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js'),
    ).href,
  };
  const child = spawn(process.execPath, [script], { env });
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
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(`管道跟踪进程退出 ${code}\n${stderr}\n${stdout}`);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('契约：孙进程占着三条管道时，一轮结束后这三条管道都已关闭', async () => {
  const pidFile = grandchildPidFile();
  try {
    const reported = await driveTrackedStdio(pidFile);
    assert.equal(reported.type, 'failed');
    assert.match(reported.message, /stderr-held/);
    assert.equal(
      reported.roundElapsed < stderrSealBoundMs,
      true,
      `失败事件等了 ${reported.roundElapsed}ms，孙进程还要活 ${grandchildHoldMs}ms`,
    );
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(alive(grandchild), true);
    assert.equal(readFileSync(`${pidFile}.held`, 'utf8'), '1');
    assert.equal(reported.spawned, 1);
    assert.equal(reported.stdoutClosed, true);
    assert.equal(reported.stderrClosed, true);
    assert.equal(reported.stdinClosed, true);
    assert.equal(reported.openLeft, 0);
    assert.equal(reported.procBlocked, true);
  } finally {
    await reapGrandchild(pidFile);
    rmSync(path.dirname(pidFile), { recursive: true, force: true });
  }
});

test('契约：孙进程占着标准错误时失败事件仍在时限内', async () => {
  const pidFile = grandchildPidFile();
  const secret = 'zhuma-synthetic-marker';
  const started = Date.now();
  try {
    const boot = await collect(`stderr-gc-fail:${pidFile}`, {
      env: modelEnv(secret),
      initTimeoutMs: 20_000,
      runId: 'stderr-gc-fail',
    });
    const elapsed = Date.now() - started;
    assert.equal(boot.events.at(-1).type, 'failed');
    assert.match(boot.events.at(-1).message, /boot crashed/);
    assert.equal(boot.events.at(-1).message.includes(secret), false);
    assert.equal(
      elapsed < stderrSealBoundMs,
      true,
      `失败事件等了 ${elapsed}ms，孙进程还要活 ${grandchildHoldMs}ms`,
    );
  } finally {
    await reapGrandchild(pidFile);
  }
});

test('契约：孙进程占着标准错误时运行结束仍在时限内', async () => {
  const pidFile = grandchildPidFile();
  const secret = 'zhuma-synthetic-marker';
  const started = Date.now();
  try {
    const done = await collect(`stderr-gc-ok:${pidFile}`, {
      env: modelEnv(secret),
      initTimeoutMs: 20_000,
      promptTimeoutMs: 20_000,
      runId: 'stderr-gc-ok',
    });
    const elapsed = Date.now() - started;
    assert.equal(done.events.at(-1).type, 'completed');
    assert.equal(JSON.stringify(done.events).includes(secret), false);
    assert.equal(
      elapsed < stderrSealBoundMs,
      true,
      `运行结束等了 ${elapsed}ms，孙进程还要活 ${grandchildHoldMs}ms`,
    );
  } finally {
    await reapGrandchild(pidFile);
  }
});

test('契约：孙进程占着标准错误时停止回执仍在时限内', async () => {
  const pidFile = grandchildPidFile();
  const secret = 'zhuma-synthetic-marker';
  const { engine } = executor(`stderr-gc-hold:${pidFile}`, {
    env: modelEnv(secret),
    initTimeoutMs: 20_000,
    promptTimeoutMs: 20_000,
  });
  const runId = 'stderr-gc-hold';
  const started = Date.now();
  let receiptMs = grandchildHoldMs;
  const receipts = [];
  try {
    for await (const event of engine.run(runInput(runId))) {
      if (event.type === 'accepted') {
        const marked = Date.now();
        receipts.push(
          engine.cancel(runId).then((receipt) => {
            receiptMs = Date.now() - marked;
            return receipt;
          }),
        );
      }
    }
    const receipt = await receipts[0];
    const elapsed = Date.now() - started;
    assert.equal(receipt.receipt, 'cancelled');
    assert.equal(
      receiptMs < stderrSealBoundMs,
      true,
      `停止回执等了 ${receiptMs}ms，孙进程还要活 ${grandchildHoldMs}ms`,
    );
    assert.equal(elapsed < stderrSealBoundMs, true, `运行结束等了 ${elapsed}ms`);
  } finally {
    await reapGrandchild(pidFile);
  }
});

test('契约：受理后的标准错误超过 8KB 时保留结尾原因，切口不留下密钥片段', async () => {
  const secret = 'zhuma-synthetic-marker-0123456789abcde';
  const half = Math.floor(secret.length / 2);
  const prefix = secret.slice(0, half);
  const suffix = secret.slice(half);
  const done = await collect('stderr-cap', {
    env: modelEnv(secret),
    initTimeoutMs: 20_000,
    promptTimeoutMs: 20_000,
    runId: 'stderr-cap',
  });
  assert.equal(done.events.at(-1).type, 'completed');
  const accepted = done.events.find((event) => event.type === 'accepted');
  const stderr = readFileSync(
    path.join(dshSessionHome(accepted.sessionId, done.env), 'zhuma-collected-stderr.txt'),
    'utf8',
  );
  assert.equal(stderr.split('\n').at(-1), 'cause: disk-full-reason');
  assert.match(stderr, /（已截断 \d+ 字节）/);
  assert.equal(stderr.length <= 8192, true);
  assert.equal(stderr.startsWith('a'.repeat(64)), true);
  assert.equal(stderr.includes(secret), false);
  assert.equal(stderr.includes(prefix), false);
  assert.equal(stderr.includes(suffix), false);
});

// 回归：545ee34 的切口会落在 emoji 两个代理字符中间。下游按每次输出计字节、取码点，开头收进半个 emoji。
test('契约：stderr 每次输出都不把代理字符对切开', () => {
  const secret = `QA-SK-${'A'.repeat(32)}`;
  assert.equal(secret.length, 38);
  const lone = (text) => /[\uD800-\uDBFF]$/.test(text) || /^[\uDC00-\uDFFF]/.test(text);
  const pushAll = (chunks) => {
    const redactor = new StderrRedactor(secret);
    const pieces = [];
    for (const chunk of chunks) {
      const out = redactor.push(chunk);
      if (out.length > 0) pieces.push(out);
    }
    const tail = redactor.flush();
    if (tail.length > 0) pieces.push(tail);
    return pieces;
  };
  const assertIntact = (chunks, label) => {
    const pieces = pushAll(chunks);
    const joined = pieces.join('');
    assert.equal(joined, chunks.join(''), label);
    for (const piece of pieces) assert.equal(lone(piece), false, label);
    const bytes = pieces.reduce((sum, piece) => sum + Buffer.byteLength(piece), 0);
    assert.equal(bytes, Buffer.byteLength(joined), label);
  };
  for (const prefix of [2040, 2041, 2042, 2043, 2044, 2045, 2046]) {
    for (const pad of [34, 35, 36, 37, 38]) {
      const text = `${'a'.repeat(prefix)}😀${'x'.repeat(pad)}`;
      assertIntact([text], `p${prefix}-pad${pad}`);
      assertIntact([text.slice(0, 5), text.slice(5)], `p${prefix}-pad${pad}-split5`);
      assertIntact(
        [text.slice(0, prefix + 1), text.slice(prefix + 1)],
        `p${prefix}-pad${pad}-pair`,
      );
    }
  }
  for (const parts of [2, 3, 7]) {
    const count = 2048;
    const per = Math.ceil(count / parts);
    const chunks = [];
    for (let index = 0; index < count; index += per) {
      chunks.push('😀'.repeat(Math.min(per, count - index)));
    }
    assertIntact(chunks, `exact-8192-${parts}`);
  }
});

// 回归：改回 .length / .slice 后，落盘超过 8192 字节，标注的省略数对不上，并且切开 emoji 得到 U+FFFD。
test('契约：标准错误按 UTF-8 字节截断，中文和 emoji 的切口不拆开字符', async () => {
  const done = await collect('stderr-cap-utf8', {
    env: modelEnv('zhuma-synthetic-marker-0123456789abcde'),
    initTimeoutMs: 20_000,
    promptTimeoutMs: 20_000,
    runId: 'stderr-cap-utf8',
  });
  assert.equal(done.events.at(-1).type, 'completed');
  const accepted = done.events.find((event) => event.type === 'accepted');
  const home = dshSessionHome(accepted.sessionId, done.env);
  const file = readFileSync(path.join(home, 'zhuma-collected-stderr.txt'));
  const source = readFileSync(path.join(home, 'zhuma-stderr-source.txt'));
  const stderr = file.toString('utf8');
  const original = source.toString('utf8');
  const matched = stderr.match(/（已截断 (\d+) 字节）/);
  assert.notEqual(matched, null);
  const mark = matched[0];
  const omitted = Number(matched[1]);
  const head = stderr.slice(0, matched.index);
  const tail = stderr.slice(matched.index + mark.length);
  const kept = head + tail;
  assert.equal(file.length <= 8192, true);
  assert.equal(file.includes(Buffer.from('efbfbd', 'hex')), false);
  assert.equal(stderr.includes('\uFFFD'), false);
  assert.equal(omitted, source.length - Buffer.byteLength(kept), '标注的字节数');
  assert.equal(original.startsWith(head), true);
  assert.equal(original.endsWith(tail), true);
  assert.equal(original.includes('中'), true);
  assert.equal(head.includes('中'), false);
  assert.equal(tail.includes('中'), false);
  const next = String.fromCodePoint(original.codePointAt(head.length));
  assert.equal(Buffer.byteLength(next) > 1, true);
  assert.equal(Buffer.byteLength(head) <= 2048, true);
  assert.equal(Buffer.byteLength(head) + Buffer.byteLength(next) > 2048, true);
  const tailAt = original.length - tail.length;
  const before = [...original.slice(0, tailAt)].at(-1);
  const room = 8192 - Buffer.byteLength(head) - Buffer.byteLength(mark);
  assert.equal(Buffer.byteLength(before) > 1, true);
  assert.equal(Buffer.byteLength(tail) <= room, true);
  assert.equal(Buffer.byteLength(tail) + Buffer.byteLength(before) > room, true);
  assert.equal(stderr.split('\n').at(-1), 'cause: disk-full-reason');
});

// 回归：开头剩下的字节放不下下一个码点时不封口，后一次写入会补进开头，最后一行不再是原因。
test('契约：标准错误开头放不下一个码点后封口，后面的写入不再拼进开头', async () => {
  const cases = [
    ['cjk-gap', 'END'],
    ['emoji-gap', 'END'],
    ['cause-line', 'cause: 磁盘已满'],
  ];
  for (const [name, lastLine] of cases) {
    const done = await collect(`stderr-head-seal:${name}`, {
      env: modelEnv('zhuma-synthetic-marker-0123456789abcde'),
      initTimeoutMs: 20_000,
      promptTimeoutMs: 20_000,
      runId: `stderr-head-seal-${name}`,
    });
    assert.equal(done.events.at(-1).type, 'completed', name);
    const accepted = done.events.find((event) => event.type === 'accepted');
    const home = dshSessionHome(accepted.sessionId, done.env);
    const file = readFileSync(path.join(home, 'zhuma-collected-stderr.txt'));
    const source = readFileSync(path.join(home, 'zhuma-stderr-source.txt'));
    const stderr = file.toString('utf8');
    const original = source.toString('utf8');
    const matched = stderr.match(/（已截断 (\d+) 字节）/);
    assert.notEqual(matched, null, name);
    const head = stderr.slice(0, matched.index);
    const tail = stderr.slice(matched.index + matched[0].length);
    assert.equal(original.startsWith(head), true, name);
    assert.equal(original.endsWith(tail), true, name);
    assert.equal(stderr.split('\n').at(-1), lastLine, name);
    assert.equal(Number(matched[1]), source.length - Buffer.byteLength(head + tail), name);
    const next = String.fromCodePoint(original.codePointAt(head.length));
    assert.equal(Buffer.byteLength(head) <= 2048, true, name);
    assert.equal(Buffer.byteLength(head) + Buffer.byteLength(next) > 2048, true, name);
    rmSync(done.env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：受理后的标准错误切口避开代理字符对，8KB 与码点封口保持不变', async () => {
  const secret = `QA-SK-${'A'.repeat(32)}`;
  const lone = (text) =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
  const head = await collect('stderr-surrogate:head', {
    env: modelEnv(secret),
    initTimeoutMs: 20_000,
    promptTimeoutMs: 20_000,
    runId: 'stderr-surrogate-head',
  });
  assert.equal(head.events.at(-1).type, 'completed');
  const headHome = dshSessionHome(
    head.events.find((event) => event.type === 'accepted').sessionId,
    head.env,
  );
  const headFile = readFileSync(path.join(headHome, 'zhuma-collected-stderr.txt'), 'utf8');
  const headSource = readFileSync(path.join(headHome, 'zhuma-stderr-source.txt'), 'utf8');
  const marked = headFile.match(/（已截断 (\d+) 字节）/);
  assert.notEqual(marked, null);
  const headText = headFile.slice(0, marked.index);
  const tailText = headFile.slice(marked.index + marked[0].length);
  assert.equal(headFile.includes('\uFFFD'), false);
  assert.equal(lone(headFile), false);
  assert.equal(headSource.startsWith(headText), true);
  assert.equal(headSource.endsWith(tailText), true);
  assert.equal(
    Number(marked[1]),
    Buffer.byteLength(headSource) - Buffer.byteLength(headText + tailText),
  );
  assert.equal(Buffer.byteLength(headText) <= 2048, true);
  const next = String.fromCodePoint(headSource.codePointAt(headText.length));
  assert.equal(Buffer.byteLength(headText) + Buffer.byteLength(next) > 2048, true);
  assert.equal(headText.includes('😀'), true);
  rmSync(head.env.ZHUMA_DATA_DIR, { recursive: true, force: true });

  const exact = await collect('stderr-surrogate:exact', {
    env: modelEnv(secret),
    initTimeoutMs: 20_000,
    promptTimeoutMs: 20_000,
    runId: 'stderr-surrogate-exact',
  });
  assert.equal(exact.events.at(-1).type, 'completed');
  const exactHome = dshSessionHome(
    exact.events.find((event) => event.type === 'accepted').sessionId,
    exact.env,
  );
  const exactFile = readFileSync(path.join(exactHome, 'zhuma-collected-stderr.txt'), 'utf8');
  assert.equal(exactFile, '😀'.repeat(2048));
  assert.equal(Buffer.byteLength(exactFile), 8192);
  assert.equal(exactFile.includes('（已截断'), false);
  assert.equal(exactFile.includes('\uFFFD'), false);
  rmSync(exact.env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

// 回归：改回 slice(0, 2000) 后，最后一行 cause 不在失败消息里。
test('契约：启动前失败的标准错误按 UTF-8 字节保留头尾，最后一行还在', async () => {
  const emoji = '😀';
  const original = `${'a'.repeat(511)}${emoji}${'中'.repeat(800)}${emoji}${'b'.repeat(1438)}\ncause: disk-full-reason`;
  const boot = await collect('stderr-boot-bound', {
    env: modelEnv('zhuma-synthetic-marker'),
    initTimeoutMs: 20_000,
    runId: 'stderr-boot-bound',
  });
  const message = boot.events.at(-1).message;
  assert.equal(boot.events.at(-1).type, 'failed');
  assert.equal(message.includes('cause: disk-full-reason'), true);
  const extra = message.slice('执行器启动失败。\n'.length);
  const matched = extra.match(/（已截断 (\d+) 字节）/);
  assert.notEqual(matched, null);
  const head = extra.slice(0, matched.index);
  const tail = extra.slice(matched.index + matched[0].length);
  assert.equal(Buffer.byteLength(extra) <= 2000, true);
  assert.equal(extra.includes('\uFFFD'), false);
  assert.equal(Number(matched[1]), Buffer.byteLength(original) - Buffer.byteLength(head + tail));
  assert.equal(original.startsWith(head), true);
  assert.equal(original.endsWith(tail), true);
  assert.equal(tail.endsWith('cause: disk-full-reason'), true);
  const next = String.fromCodePoint(original.codePointAt(head.length));
  assert.equal(Buffer.byteLength(next) > 1, true);
  assert.equal(Buffer.byteLength(head) + Buffer.byteLength(next) > 512, true);
  const tailAt = original.length - tail.length;
  const before = [...original.slice(0, tailAt)].at(-1);
  const room = 2000 - Buffer.byteLength(head) - Buffer.byteLength(matched[0]);
  assert.equal(Buffer.byteLength(before) > 1, true);
  assert.equal(Buffer.byteLength(tail) + Buffer.byteLength(before) > room, true);
});

// 回归：收尾时连 1 到 3 个字符的前缀也换成 [redacted]，本用例得到 preface-[redacted]。
test('契约：收尾时长度不足 4 的密钥前缀原样留下，满 4 个才换成 [redacted]', async () => {
  const secret = 'zhuma-synthetic-marker';
  const short = await collect('stderr-boot-prefix-len:3', {
    env: modelEnv(secret),
    initTimeoutMs: 20_000,
    runId: 'stderr-prefix-3',
  });
  assert.equal(short.events.at(-1).type, 'failed');
  assert.equal(short.events.at(-1).message, `执行器启动失败。\npreface-${secret.slice(0, 3)}`);
  const floor = await collect('stderr-boot-prefix-len:4', {
    env: modelEnv(secret),
    initTimeoutMs: 20_000,
    runId: 'stderr-prefix-4',
  });
  assert.equal(floor.events.at(-1).type, 'failed');
  assert.equal(floor.events.at(-1).message, '执行器启动失败。\npreface-[redacted]');
  assert.equal(floor.events.at(-1).message.includes(secret.slice(0, 4)), false);
});

test('契约：标准错误在密钥前缀处截断时不会漏出前缀', async () => {
  const secret = 'zhuma-synthetic-marker-0123456789abcde';
  const prefix = secret.slice(0, secret.length - 1);
  assert.equal(secret.length, 38);
  assert.equal(prefix.length, 37);
  const boot = await collect('stderr-boot-prefix', {
    env: modelEnv(secret),
    initTimeoutMs: 20_000,
    runId: 'stderr-boot-prefix',
  });
  const message = boot.events.at(-1).message;
  assert.equal(boot.events.at(-1).type, 'failed');
  assert.equal(message, '执行器启动失败。\npreface-[redacted]');
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes(prefix), false);
  assert.equal(JSON.stringify(boot.events).includes(prefix), false);
});

function longestKeyFragment(text, secret) {
  let best = 0;
  for (let start = 0; start < secret.length; start += 1) {
    for (let end = start + best + 1; end <= secret.length; end += 1) {
      if (text.includes(secret.slice(start, end))) best = end - start;
      else break;
    }
  }
  return best;
}

function assertNoKeyFragment(text, secret, label) {
  const longest = longestKeyFragment(text, secret);
  assert.equal(longest < 4, true, `${label} 留下 ${longest} 位片段`);
}

async function assertPrefixHidden(kind, length) {
  const secret = 'K1-synthetic-0123456789abcdefX-TAIL';
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-prefix-http-'));
  const sessionFile = path.join(directory, 'session.json');
  const { desk } = open(`stderr-prefix-${kind}:${length}`, {
    env: modelEnv(secret),
    journal: createFileJournal(sessionFile),
    initTimeoutMs: 20_000,
  });
  const server = createWorkbenchServer({
    desk,
    present: (snapshot) => snapshot,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  try {
    const posted = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '不要带出前缀', idempotencyKey: `prefix-${kind}-${length}` }),
    });
    assert.equal(posted.ok, true);
    await desk.flush();
    const loaded = await fetch(`http://127.0.0.1:${port}/api/workspace`);
    const body = await loaded.text();
    const saved = readFileSync(sessionFile, 'utf8');
    assertNoKeyFragment(body, secret, `${kind}-${length} http`);
    assertNoKeyFragment(saved, secret, `${kind}-${length} session`);
    assert.equal(body.includes('[redacted]'), true, `${kind}-${length} http`);
    assert.equal(saved.includes('[redacted]'), true, `${kind}-${length} session`);
  } finally {
    server.close();
  }
}

for (const length of [4, 12, 30]) {
  test(`契约：收尾剩下的 ${length} 位密钥前缀不会进入 HTTP 响应或会话文件`, async () => {
    await assertPrefixHidden('end', length);
  });
  test(`契约：流中间的 ${length} 位密钥前缀不会进入 HTTP 响应或会话文件`, async () => {
    await assertPrefixHidden('mid', length);
  });
}

function redactChunks(secret, chunks) {
  const redactor = new StderrRedactor(secret);
  let out = '';
  for (const chunk of chunks) out += redactor.push(chunk);
  out += redactor.flush();
  return out;
}

function assertRedactedChunks(secret, chunks) {
  const out = redactChunks(secret, chunks);
  assertNoKeyFragment(out, secret, 'stderr');
  assert.equal(out.includes('[redacted]'), true);
  return out;
}

for (const length of [4, 12, 30]) {
  test(`契约：流中间 ${length} 位前缀里达到 4 位的片段都不会留下`, () => {
    const secret = 'K1-synthetic-0123456789abcdefX-TAIL';
    const out = redactChunks(secret, [`mid-${secret.slice(0, length)}zz\n`]);
    assert.equal(out, 'mid-[redacted]zz\n');
    assertNoKeyFragment(out, secret, `mid-${length}`);
  });
}

test('契约：同一块里从失败前缀中间开始的完整密钥会换成 [redacted]', () => {
  const secret = 'aab-synthetic-marker-0123456789';
  assert.equal(assertRedactedChunks(secret, [`a${secret}\n`]), 'a[redacted]\n');
  assert.equal(
    assertRedactedChunks(secret, [`aa${secret} and a${secret}\n`]),
    'aa[redacted] and a[redacted]\n',
  );
  assert.equal(redactChunks(secret, `preface-${secret}-tail`.split('')), 'preface-[redacted]-tail');
});

test('契约：跨块时从失败前缀中间开始的完整密钥会换成 [redacted]', () => {
  const secret = 'aab-synthetic-marker-0123456789';
  const text = `a${secret}\n`;
  for (let at = 1; at < text.length; at += 1) {
    assert.equal(
      assertRedactedChunks(secret, [text.slice(0, at), text.slice(at)]),
      'a[redacted]\n',
      `拆在第 ${at} 个字符`,
    );
  }
  assert.equal(assertRedactedChunks(secret, ['a', ...secret, '\n']), 'a[redacted]\n');
});

test('契约：达到 4 位的重叠前缀不会把密钥后半段放出来', () => {
  const repeated = 'qrsqrsqrt-synthetic-marker-0123456789';
  for (const lead of [1, 2, 3, 4, 5, 6]) {
    const out = assertRedactedChunks(repeated, [`x ${repeated.slice(0, lead)}${repeated} y\n`]);
    assert.equal(out.includes(repeated.slice(-20)), false, `lead ${lead}`);
  }
  assert.equal(
    assertRedactedChunks(repeated, [
      `x ${repeated.slice(0, 6)}`,
      repeated.slice(0, 4),
      `${repeated.slice(4)} y\n`,
    ]),
    'x [redacted] y\n',
  );
  const head = 'abcabc';
  const tail = 'z0123456789abcdef0123456789abcdefX';
  assert.equal(tail.length, 34);
  assert.equal(tail.startsWith('a'), false);
  const folded = `${head}${tail}`;
  const foldedOut = assertRedactedChunks(folded, [`${folded.slice(0, 3)}${folded} end\n`]);
  assert.equal(foldedOut.includes(tail), false);
  // 前面 3 位自己也是达到 4 位的前缀的一部分，和后面的完整密钥连成同一段。
  assert.equal(foldedOut, '[redacted] end\n');
});

async function assertOverlapHidden(mode, secret) {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-overlap-http-'));
  const sessionFile = path.join(directory, 'session.json');
  const { desk } = open(mode, {
    env: modelEnv(secret),
    journal: createFileJournal(sessionFile),
    initTimeoutMs: 20_000,
  });
  const server = createWorkbenchServer({
    desk,
    present: (snapshot) => snapshot,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  try {
    const posted = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '不要带出重叠密钥', idempotencyKey: mode }),
    });
    assert.equal(posted.ok, true);
    await desk.flush();
    const body = await (await fetch(`http://127.0.0.1:${port}/api/workspace`)).text();
    const saved = readFileSync(sessionFile, 'utf8');
    assertNoKeyFragment(body, secret, `${mode} http`);
    assertNoKeyFragment(saved, secret, `${mode} session`);
    assertNoKeyPrefix(body, secret, `${mode} http`);
    assertNoKeyPrefix(saved, secret, `${mode} session`);
    if (secret.length >= 12) {
      assert.equal(body.includes(secret.slice(0, 12)), false, `${mode} http 留下 12 位前缀`);
      assert.equal(saved.includes(secret.slice(0, 12)), false, `${mode} session 留下 12 位前缀`);
    }
    assert.equal(body.includes('[redacted]'), true, mode);
    assert.equal(saved.includes('[redacted]'), true, mode);
    return { body, saved };
  } finally {
    server.close();
  }
}

test('契约：同一块重叠密钥不会进入 HTTP 响应或会话文件', async () => {
  await assertOverlapHidden('stderr-overlap:same', 'aab-synthetic-marker-0123456789');
});

test('契约：拆在第 5 个字符的重叠密钥不会进入 HTTP 响应或会话文件', async () => {
  await assertOverlapHidden('stderr-overlap:split:5', 'aab-synthetic-marker-0123456789');
});

test('契约：逐字节写出的重叠密钥不会进入 HTTP 响应或会话文件', async () => {
  await assertOverlapHidden('stderr-overlap:bytes', 'aab-synthetic-marker-0123456789');
});

test('契约：qrs 这种达到 4 位的重叠不会进入 HTTP 响应或会话文件', async () => {
  const secret = 'qrsqrsqrt-synthetic-marker-0123456789';
  await assertOverlapHidden('stderr-overlap:lead:3', secret);
  await assertOverlapHidden('stderr-overlap:lead:6', secret);
  await assertOverlapHidden('stderr-overlap:lead-split:6', secret);
});

test('契约：abc 重复前缀的重叠不会进入 HTTP 响应或会话文件', async () => {
  const secret = 'abcabcz0123456789abcdef0123456789abcdefX';
  await assertOverlapHidden('stderr-overlap:lead:3', secret);
});

/** 朴素参考：每个位置取最长密钥前缀，达到 4 位或等于整条密钥就遮住，相邻遮盖合成一段。 */
function referenceRedaction(raw, secret) {
  if (secret.length === 0) return raw;
  const mask = new Array(raw.length).fill(false);
  for (let start = 0; start < raw.length; start += 1) {
    let matched = 0;
    while (
      matched < secret.length &&
      start + matched < raw.length &&
      raw[start + matched] === secret[matched]
    ) {
      matched += 1;
    }
    if (matched >= 4 || matched === secret.length) {
      for (let index = start; index < start + matched; index += 1) mask[index] = true;
    }
  }
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    if (mask[index]) {
      if (index === 0 || !mask[index - 1]) out += '[redacted]';
    } else out += raw[index];
  }
  return out;
}

function assertNoKeyPrefix(text, secret, label) {
  if (secret.length < 4) return;
  const cleared = text.split('[redacted]').join('\u0000');
  assert.equal(cleared.includes(secret.slice(0, 4)), false, `${label} 留下密钥前缀`);
}

function chunkings(text) {
  const ways = [[text], [...text]];
  if (text.length > 5) ways.push([text.slice(0, 5), text.slice(5)]);
  return ways;
}

function assertMatchesReference(secret, text) {
  const expected = referenceRedaction(text, secret);
  for (const chunks of chunkings(text)) {
    const out = redactChunks(secret, chunks);
    assert.equal(out, expected, `拆成 ${chunks.length} 段`);
    assertNoKeyPrefix(out, secret, 'stderr');
  }
  return expected;
}

test('契约：重叠起点上不完整的长前缀在整块、逐字符和第 5 个字符切开时输出一致', () => {
  const secret = 'aab-synthetic-marker-0123456789';
  assert.equal(
    assertMatchesReference(secret, `${secret.slice(0, 1)}${secret.slice(0, 22)}c\n`),
    'a[redacted]c\n',
  );
  assert.equal(
    assertMatchesReference(secret, `${secret.slice(0, 1)}${secret.slice(0, 30)}\n`),
    'a[redacted]\n',
  );
  assert.equal(
    assertMatchesReference(secret, `${secret.slice(0, 1)}${secret.slice(0, 7)}`),
    'a[redacted]',
  );
  assert.equal(assertMatchesReference(secret, `${secret.slice(0, 22)}c\n`), '[redacted]c\n');
  assert.equal(
    assertMatchesReference(secret, `${secret.slice(0, 1)}${secret.slice(0, 12)}zz\n`),
    'a[redacted]zz\n',
  );
  assertMatchesReference(secret, `x ${secret.slice(0, 1)}${secret.slice(0, 12)}zz more\n`);
  assertMatchesReference(secret, `x ${secret.slice(0, 1)}${secret.slice(0, 12)}`);
  const repeated = 'qrsqrsqrt-synthetic-marker-0123456789';
  assertMatchesReference(repeated, `x ${repeated.slice(0, 3)}${repeated.slice(0, 20)}zz\n`);
  const keyed = 'qrstuvwxyzqabcdefghijabcdefghijabcdefghi';
  assert.equal(keyed.length, 40);
  assert.equal(keyed[10], keyed[0]);
  assert.equal(keyed.slice(1, 10).includes(keyed[0]), false);
  assert.equal(keyed.slice(11).includes(keyed[0]), false);
  assertMatchesReference(keyed, `x ${keyed.slice(0, 11)}${keyed.slice(1, 25)}zz\n`);
});

test('契约：完整密钥内部的字符不会在重叠的下一次匹配里漏出来', () => {
  const secret = 'abcdabcd';
  const text = `${secret}abcd`;
  assert.equal(assertMatchesReference(secret, text), '[redacted]');
  assert.equal(redactChunks(secret, [secret.slice(0, 6), text.slice(6)]), '[redacted]');
});

test('契约：固定种子的随机拆块和朴素参考输出一致', () => {
  let seed = 20261023;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const ri = (n) => Math.floor(rnd() * n);
  const forms = [
    'aab-synthetic-marker-0123456789',
    'qrsqrsqrt-synthetic-marker-0123456789',
    'aaaaaaabfghijkfghijk',
    'abaababaabxyzxyz',
    'abcabcabdzzzzzzzzzzzzzzzzzzz',
    '密钥密钥密x甲乙丙丁戊',
    'abcdabcd',
  ];
  for (const secret of forms) {
    for (let index = 0; index < 80; index += 1) {
      const parts = [];
      const count = 1 + ri(6);
      for (let part = 0; part < count; part += 1) {
        const kind = ri(6);
        if (kind === 0) parts.push(secret);
        else if (kind === 1) parts.push(secret.slice(0, 1 + ri(secret.length)));
        else if (kind === 2)
          parts.push(
            secret.slice(0, 1 + ri(Math.min(3, secret.length))) +
              secret.slice(0, 1 + ri(secret.length)),
          );
        else if (kind === 3) parts.push(secret.slice(0, Math.max(0, secret.length - 1)));
        else parts.push(' #=:'.slice(ri(4), ri(4) + 1));
      }
      const text = parts.join('');
      const expected = referenceRedaction(text, secret);
      const chunks = [];
      let cursor = 0;
      while (cursor < text.length) {
        const step = 1 + ri(5);
        chunks.push(text.slice(cursor, cursor + step));
        cursor += step;
      }
      const out = redactChunks(secret, chunks.length > 0 ? chunks : ['']);
      assert.equal(out, expected);
      assertNoKeyPrefix(out, secret, secret.slice(0, 4));
    }
  }
});

for (const [kind, how] of [
  ['0c', ''],
  ['0c', 'bytes'],
  ['0c', 'split5'],
  ['almost', ''],
  ['almost', 'bytes'],
  ['almost', 'split5'],
  ['end', ''],
  ['end', 'bytes'],
  ['end', 'split5'],
]) {
  const mode =
    how.length === 0 ? `stderr-overlap:review:${kind}` : `stderr-overlap:review:${kind}:${how}`;
  test(`契约：重叠长前缀 ${kind} ${how || 'same'} 不会进入 HTTP 响应或会话文件`, async () => {
    await assertOverlapHidden(mode, 'aab-synthetic-marker-0123456789');
  });
}

test('契约：失配后只部分匹配的 12 位重叠前缀同一块写出时不会进入 HTTP 响应或会话文件', async () => {
  const secret = 'aab-synthetic-marker-0123456789';
  const seen = await assertOverlapHidden('stderr-overlap:review:p12', secret);
  assert.equal(seen.body.includes('a[redacted]zz'), true);
  assert.equal(seen.saved.includes('a[redacted]zz'), true);
  assert.equal(seen.body.includes('aaab-syntheti'), false);
  assert.equal(seen.saved.includes('aaab-syntheti'), false);
});

test('契约：失配后只部分匹配的 12 位重叠前缀在第 5 个字符切开时不会进入 HTTP 响应或会话文件', async () => {
  const secret = 'aab-synthetic-marker-0123456789';
  const seen = await assertOverlapHidden('stderr-overlap:review:p12:split5', secret);
  assert.equal(seen.body.includes('a[redacted]zz'), true);
  assert.equal(seen.saved.includes('a[redacted]zz'), true);
  assert.equal(seen.body.includes('aaab-syntheti'), false);
  assert.equal(seen.saved.includes('aaab-syntheti'), false);
});

test('契约：封口超时时跨在缓冲边界上的密钥不会漏出', async () => {
  const pidFile = grandchildPidFile();
  const secret = 'zhuma-synthetic-marker-0123456789abcde';
  const at = secret.length - 1;
  const prefix = secret.slice(0, at);
  const started = Date.now();
  try {
    const boot = await collect(`stderr-gc-split:${at}:${pidFile}`, {
      env: modelEnv(secret),
      initTimeoutMs: 20_000,
      runId: 'stderr-gc-split',
    });
    const elapsed = Date.now() - started;
    const message = boot.events.at(-1).message;
    assert.equal(boot.events.at(-1).type, 'failed');
    assert.match(message, /preface-/);
    assert.equal(message.includes(secret), false);
    assert.equal(message.includes(prefix), false);
    assert.equal(JSON.stringify(boot.events).includes(secret), false);
    assert.equal(JSON.stringify(boot.events).includes(prefix), false);
    assert.equal(
      elapsed < stderrSealBoundMs,
      true,
      `失败事件等了 ${elapsed}ms，孙进程还要活 ${grandchildHoldMs}ms`,
    );
  } finally {
    await reapGrandchild(pidFile);
  }
});

async function driveWithBlockedRemove(env, sessionId, blocked) {
  const dir = mkdtempSync(path.join(tmpdir(), 'zhuma-rm-fault-'));
  const preload = path.join(dir, 'preload.mjs');
  const script = path.join(dir, 'drive.mjs');
  writeFileSync(
    preload,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs');",
      "const blocked = process.env.ZHUMA_FAULT_RM ?? '';",
      'const original = fs.rmSync;',
      'fs.rmSync = (target, options) => {',
      '  const text = String(target);',
      "  if (blocked.length > 0 && (text === blocked || text.startsWith(blocked + '/'))) {",
      "    const error = new Error(`EACCES: permission denied, rm '${text}'`);",
      "    error.code = 'EACCES';",
      '    throw error;',
      '  }',
      '  return original(target, options);',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    script,
    [
      'const { DshChatExecutor } = await import(process.env.ZHUMA_ADAPTER);',
      'const pids = [];',
      'const engine = new DshChatExecutor(',
      '  {',
      '    ZHUMA_MODEL_BASE_URL: process.env.ZHUMA_MODEL_BASE_URL,',
      '    ZHUMA_MODEL_API_KEY: process.env.ZHUMA_MODEL_API_KEY,',
      '    ZHUMA_MODEL_ID: process.env.ZHUMA_MODEL_ID,',
      '    ZHUMA_DATA_DIR: process.env.ZHUMA_DATA_DIR,',
      '    PATH: process.env.PATH,',
      '    HOME: process.env.HOME,',
      '    TMPDIR: process.env.TMPDIR,',
      '  },',
      '  {',
      '    bin: process.env.ZHUMA_STUB,',
      "    mode: 'ok',",
      '    initTimeoutMs: 10000,',
      '    promptTimeoutMs: 10000,',
      '    onSpawn: (pid) => pids.push(pid),',
      '  },',
      ');',
      'const events = [];',
      'for await (const event of engine.run({',
      "  runId: 'skill-round-cleanup',",
      '  attempt: 1,',
      '  generation: 1,',
      "  taskId: 'task',",
      "  nodeId: 'node',",
      "  workflowVersionId: 'plan',",
      '  planRevision: 1,',
      '  contextReferences: [],',
      "  expertVersionId: 'expert-v1',",
      '  resourceGrants: [],',
      "  instruction: '整理字段',",
      '  attachmentIds: [],',
      "  skills: [{ id: 'skill-b', version: 'v3', label: 'skill-b', description: 'skill-b', body: 'skill-b' }],",
      "  goal: '确认字段',",
      '  simulatedRequested: false,',
      '  signal: new AbortController().signal,',
      '  resumeSessionId: process.env.ZHUMA_SESSION_ID,',
      '})) {',
      '  events.push({ type: event.type, fault: event.fault, message: event.message });',
      '}',
      'process.stdout.write(JSON.stringify({ spawned: pids.length, events }));',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, ['--import', preload, script], {
    env: {
      ...process.env,
      ZHUMA_MODEL_BASE_URL: env.ZHUMA_MODEL_BASE_URL,
      ZHUMA_MODEL_API_KEY: env.ZHUMA_MODEL_API_KEY,
      ZHUMA_MODEL_ID: env.ZHUMA_MODEL_ID,
      ZHUMA_DATA_DIR: env.ZHUMA_DATA_DIR,
      ZHUMA_FAULT_RM: blocked,
      ZHUMA_STUB: stub,
      ZHUMA_SESSION_ID: sessionId,
      ZHUMA_ADAPTER: pathToFileURL(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js'),
      ).href,
    },
  });
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
  if (code !== 0) throw new Error(`清理故障注入进程退出 ${code}\n${stderr}\n${stdout}`);
  return JSON.parse(stdout);
}

async function driveFreshHomeFault(env, faultText = '', faultCode = 'EACCES') {
  const dir = mkdtempSync(path.join(tmpdir(), 'zhuma-home-fault-'));
  const preload = path.join(dir, 'preload.mjs');
  const script = path.join(dir, 'drive.mjs');
  writeFileSync(
    preload,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const original = fs.writeFileSync;',
      'fs.writeFileSync = (target, data, options) => {',
      '  const text = String(target);',
      '  if (text.endsWith(path.sep + "zhuma-grant.json")) {',
      '    const detail = process.env.ZHUMA_FAULT_TEXT ?? "";',
      '    const error = new Error(',
      "      detail.length > 0 ? detail : `EACCES: permission denied, open '${text}'`,",
      '    );',
      '    const code = process.env.ZHUMA_FAULT_CODE;',
      '    if (code) error.code = code;',
      '    throw error;',
      '  }',
      '  return original(target, data, options);',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    script,
    [
      "const { readdirSync, readFileSync, existsSync } = await import('node:fs');",
      "const path = await import('node:path');",
      'const { DshChatExecutor } = await import(process.env.ZHUMA_ADAPTER);',
      'const pids = [];',
      'const engine = new DshChatExecutor(',
      '  {',
      '    ZHUMA_MODEL_BASE_URL: process.env.ZHUMA_MODEL_BASE_URL,',
      '    ZHUMA_MODEL_API_KEY: process.env.ZHUMA_MODEL_API_KEY,',
      '    ZHUMA_MODEL_ID: process.env.ZHUMA_MODEL_ID,',
      '    ZHUMA_DATA_DIR: process.env.ZHUMA_DATA_DIR,',
      '    PATH: process.env.PATH,',
      '    HOME: process.env.HOME,',
      '    TMPDIR: process.env.TMPDIR,',
      '  },',
      '  {',
      '    bin: process.env.ZHUMA_STUB,',
      "    mode: 'ok',",
      '    initTimeoutMs: 10000,',
      '    onSpawn: (pid) => pids.push(pid),',
      '  },',
      ');',
      'const events = [];',
      'for await (const event of engine.run({',
      "  runId: 'fresh-home-cleanup',",
      '  attempt: 1,',
      '  generation: 1,',
      "  taskId: 'task',",
      "  nodeId: 'node',",
      "  workflowVersionId: 'plan',",
      '  planRevision: 1,',
      '  contextReferences: [],',
      "  expertVersionId: 'expert-v1',",
      '  resourceGrants: [],',
      "  instruction: '整理字段',",
      '  attachmentIds: [],',
      "  goal: '确认字段',",
      '  simulatedRequested: false,',
      '  signal: new AbortController().signal,',
      '})) {',
      '  events.push({ type: event.type, fault: event.fault, message: event.message });',
      '}',
      'const root = path.join(process.env.ZHUMA_DATA_DIR, "dsh-sessions");',
      'const homes = existsSync(root)',
      '  ? readdirSync(root).filter((name) => name.startsWith("dsh-"))',
      '  : [];',
      'let sessions = {};',
      'try {',
      '  sessions = JSON.parse(readFileSync(path.join(root, "index.json"), "utf8")).sessions ?? {};',
      '} catch {}',
      'process.stdout.write(JSON.stringify({ spawned: pids.length, events, homes, sessions }));',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, ['--import', preload, script], {
    env: {
      ...process.env,
      ZHUMA_MODEL_BASE_URL: env.ZHUMA_MODEL_BASE_URL,
      ZHUMA_MODEL_API_KEY: env.ZHUMA_MODEL_API_KEY,
      ZHUMA_MODEL_ID: env.ZHUMA_MODEL_ID,
      ZHUMA_DATA_DIR: env.ZHUMA_DATA_DIR,
      ...(faultText.length > 0 ? { ZHUMA_FAULT_TEXT: faultText } : {}),
      ...(faultCode.length > 0 ? { ZHUMA_FAULT_CODE: faultCode } : {}),
      ZHUMA_STUB: stub,
      ZHUMA_ADAPTER: pathToFileURL(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js'),
      ).href,
    },
  });
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
  if (code !== 0) throw new Error(`新建会话清理注入进程退出 ${code}\n${stderr}\n${stdout}`);
  return JSON.parse(stdout);
}

/** driveFreshHomeFault 默认把 error.code 写成 EACCES。公开文案不从消息正文摘词。 */
const freshHomeStartupFailure = '执行器启动失败。\nEACCES';

test('契约：新建会话还没写好家目录就失败时，目录和索引记录都清掉', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(env);
    assert.equal(failed.spawned, 0);
    assert.equal(failed.events.length, 1);
    assert.equal(failed.events[0].type, 'failed');
    assert.equal(failed.events[0].fault, 'executor-disconnected');
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes(env.ZHUMA_DATA_DIR), false);
    assert.deepEqual(failed.homes, []);
    assert.deepEqual(failed.sessions, {});
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里不带引号的路径，空格、括号和汉字都不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  const leaked = '/tmp/zhuma home/会话(目录)';
  try {
    const failed = await driveFreshHomeFault(env, `EACCES: permission denied, mkdir ${leaked}`);
    const message = failed.events[0].message;
    assert.equal(message, freshHomeStartupFailure);
    assert.equal(message.includes('会话'), false);
    assert.equal(message.includes('(目录)'), false);
    assert.equal(message.includes(' home/'), false);
    assert.equal(message.includes(leaked), false);
    assert.equal(message.includes(env.ZHUMA_DATA_DIR), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里 cwd: 后面的绝对路径不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(env, 'cwd:/home/qa/secret-project/x failed');
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('/home/qa'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里括号中的绝对路径不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(env, '(/home/qa/secret-project/file.txt)');
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('/home/qa'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里调用栈的绝对路径不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(
      env,
      'at Object.<anonymous> (/home/qa/proj/node_modules/x/index.js:10:5)',
    );
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('/home/qa'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里 file:// 后面的绝对路径不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(env, 'file:///home/qa/x.mjs failed');
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('/home/qa'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败不从消息正文抄出 ENOENT', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(
      env,
      'spawn /home/qa user/My Docs (x)/数据/dsh ENOENT',
    );
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('ENOENT'), false);
    assert.equal(failed.events[0].message.includes('My Docs'), false);
    assert.equal(failed.events[0].message.includes('数据'), false);
    assert.equal(failed.events[0].message.includes('/home/qa'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里最后一段带空格的路径不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(env, 'open /home/qa/My Docs');
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('Docs'), false);
    assert.equal(failed.events[0].message.includes('/home/qa'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败不从同一行后面的斜杠说明摘词', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(
      env,
      'open /home/qa/file.txt then see /docs and leave',
    );
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('/home/qa'), false);
    assert.equal(failed.events[0].message.includes('file.txt'), false);
    assert.equal(failed.events[0].message.includes('/docs'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里 UNC 路径不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const missing = await driveFreshHomeFault(env, '\\\\server\\share\\qa\\x.txt missing');
    assert.equal(missing.events[0].message, freshHomeStartupFailure);
    assert.equal(missing.events[0].message.includes('server'), false);
    assert.equal(missing.events[0].message.includes('x.txt'), false);
    const opened = await driveFreshHomeFault(env, 'open \\\\server\\share\\My Docs\\x.txt failed');
    assert.equal(opened.events[0].message, freshHomeStartupFailure);
    assert.equal(opened.events[0].message.includes('share'), false);
    assert.equal(opened.events[0].message.includes('My Docs'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里 file://localhost 后面的本地路径不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(env, 'file://localhost/home/qa/x failed');
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('/home'), false);
    assert.equal(failed.events[0].message.includes('localhost'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败不从路径后面的版本号和缩写摘词', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const version = await driveFreshHomeFault(env, 'open /home/qa/dir v1.2 released');
    assert.equal(version.events[0].message, freshHomeStartupFailure);
    assert.equal(version.events[0].message.includes('/home'), false);
    assert.equal(version.events[0].message.includes('dir'), false);
    const abbrev = await driveFreshHomeFault(env, 'open /home/qa/x e.g. missing');
    assert.equal(abbrev.events[0].message, freshHomeStartupFailure);
    assert.equal(abbrev.events[0].message.includes('/home'), false);
    const duration = await driveFreshHomeFault(env, 'open /home/qa/x 3.5s timeout');
    assert.equal(duration.events[0].message, freshHomeStartupFailure);
    assert.equal(duration.events[0].message.includes('/home'), false);
    const named = await driveFreshHomeFault(env, 'open /home/qa/My Docs/secret file.txt failed');
    assert.equal(named.events[0].message, freshHomeStartupFailure);
    assert.equal(named.events[0].message.includes('file.txt'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里带空格的文件名不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(env, 'open /home/qa/My Docs/secret file.txt failed');
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('file.txt'), false);
    assert.equal(failed.events[0].message.includes('My Docs'), false);
    assert.equal(failed.events[0].message.includes('/home'), false);
    assert.equal(failed.events[0].message.includes('secret'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败里扩展名带数字或下划线的文件名不会进入公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  const lines = [
    ['open /home/qa/My Docs/my clip.mp4 failed', 'clip.mp4'],
    ['open /home/qa/a b.7z failed', 'b.7z'],
    ['open /home/qa/My Docs/old notes.v2 failed', 'notes.v2'],
    ['open /home/qa/My Docs/a b.json_bak failed', 'json_bak'],
  ];
  try {
    for (const [input, leaked] of lines) {
      const failed = await driveFreshHomeFault(env, input);
      assert.equal(failed.events[0].message, freshHomeStartupFailure, input);
      assert.equal(failed.events[0].message.includes(leaked), false, input);
      assert.equal(failed.events[0].message.includes('/home'), false, input);
    }
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

for (const [label, input, residue] of [
  ['数字开头', 'open /home/qa/My Docs/report 2026.pdf failed', '2026.pdf'],
  ['带连字符', 'open /home/qa/My Docs/report final-report.pdf failed', 'final-report.pdf'],
  ['非 ASCII', 'open /home/qa/My Docs/report 报告.pdf failed', '报告.pdf'],
  ['下划线开头', 'open /home/qa/My Docs/report _draft.pdf failed', '_draft.pdf'],
]) {
  test(`契约：启动失败里空格后的${label}文件名不会进入公开文案`, async () => {
    const env = modelEnv('zhuma-synthetic-marker');
    try {
      const failed = await driveFreshHomeFault(env, input);
      assert.equal(failed.events[0].message, freshHomeStartupFailure);
      assert.equal(failed.events[0].message.includes(residue), false);
      assert.equal(failed.events[0].message.includes('/home'), false);
      assert.equal(failed.events[0].message.includes('report'), false);
    } finally {
      rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
    }
  });
}

test('契约：启动失败不从路径后面的网址摘词', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(
      env,
      'open /home/qa/x.json failed: see https://docs.example.invalid/errors',
    );
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('/home'), false);
    assert.equal(failed.events[0].message.includes('x.json'), false);
    assert.equal(failed.events[0].message.includes('example.invalid'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败不把网址抄进公开文案', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(env, 'fetch https://example.invalid/v1/models failed');
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('https'), false);
    assert.equal(failed.events[0].message.includes('example.invalid'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败不从路径后面的普通说明摘词', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  try {
    const failed = await driveFreshHomeFault(
      env,
      'open /home/qa/.zhuma/sessions/a b/home.json and then exit',
    );
    assert.equal(failed.events[0].message, freshHomeStartupFailure);
    assert.equal(failed.events[0].message.includes('home.json'), false);
    assert.equal(failed.events[0].message.includes('/home/qa'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

const unboundedStartupFailures = [
  [
    'A1',
    'open /tmp/synthetic/Cedar Lighthouse brief.txt failed',
    ['Cedar', 'Lighthouse', 'brief', 'synthetic'],
  ],
  [
    'A2',
    String.raw`open C:\\ProjectSecret\\nested\\brief.txt failed`,
    ['ProjectSecret', 'nested', 'brief'],
  ],
  ['C1', 'open /tmp/synthetic/brief.txt failed', ['brief', 'synthetic']],
  [
    'C2',
    String.raw`open C:\ProjectSecret\nested\brief.txt failed`,
    ['ProjectSecret', 'nested', 'brief'],
  ],
  ['C3', 'open /tmp/synthetic/Lighthouse brief.txt failed', ['Lighthouse', 'brief', 'synthetic']],
  [
    'M1',
    'open /tmp/Cedar Lighthouse/nested/brief.txt failed',
    ['Cedar', 'Lighthouse', 'nested', 'brief'],
  ],
  [
    'M2',
    'open /tmp/Cedar Lighthouse Secret/brief.txt failed',
    ['Cedar', 'Lighthouse', 'Secret', 'brief'],
  ],
  [
    'M3',
    'open /tmp/Cedar Lighthouse/Project Secret brief.txt failed',
    ['Cedar', 'Lighthouse', 'Project', 'Secret', 'brief'],
  ],
  [
    'F1',
    'open /tmp/synthetic/Project Cedar Lighthouse brief.txt failed',
    ['Project', 'Cedar', 'Lighthouse', 'brief', 'synthetic'],
  ],
  [
    'F2',
    'open /tmp/synthetic/Cedar Lighthouse brief.txt ENOENT',
    ['Cedar', 'Lighthouse', 'brief', 'synthetic', 'ENOENT'],
  ],
  [
    'F3',
    'open /tmp/synthetic/Cedar Lighthouse brief.txt',
    ['Cedar', 'Lighthouse', 'brief', 'synthetic'],
  ],
  [
    'F4',
    'mkdir /tmp/synthetic/Cedar Lighthouse brief',
    ['Cedar', 'Lighthouse', 'brief', 'synthetic'],
  ],
  [
    'F5',
    'open /tmp/synthetic/Cedar Lighthouse brief.txt: denied',
    ['Cedar', 'Lighthouse', 'brief', 'synthetic'],
  ],
  ['U1', String.raw`open \\server\share\qa\brief.txt failed`, ['server', 'share', 'brief']],
  ['U2', String.raw`open \\\\server\\share\\qa\\brief.txt failed`, ['server', 'share', 'brief']],
  [
    'U3',
    String.raw`open \\server\share\Cedar Lighthouse brief.txt failed`,
    ['server', 'share', 'Cedar', 'Lighthouse', 'brief'],
  ],
  [
    'U4',
    String.raw`open \\ProjectSecret\\nested\\brief.txt failed`,
    ['ProjectSecret', 'nested', 'brief'],
  ],
  ['W1', 'open C:/ProjectSecret/nested/brief.txt failed', ['ProjectSecret', 'nested', 'brief']],
  ['W2', 'open C://ProjectSecret//nested//brief.txt failed', ['ProjectSecret', 'nested', 'brief']],
  [
    'W3',
    'open C:/Project Secret/Cedar Lighthouse brief.txt failed',
    ['Project', 'Secret', 'Cedar', 'Lighthouse', 'brief'],
  ],
  [
    'W4',
    String.raw`open C:\ProjectSecret\\nested\brief.txt failed`,
    ['ProjectSecret', 'nested', 'brief'],
  ],
  [
    'W5',
    String.raw`open C:\ProjectSecret/nested\brief.txt failed`,
    ['ProjectSecret', 'nested', 'brief'],
  ],
  ['W6', String.raw`EACCES: permission denied, mkdir C:\\Users\\qa\\data`, ['Users', 'qa', 'data']],
  [
    'W7',
    String.raw`open C:\\Project Secret\\Cedar Lighthouse brief.txt failed`,
    ['Project', 'Secret', 'Cedar', 'Lighthouse', 'brief'],
  ],
  ['P1', 'open /tmp//ProjectSecret/brief.txt failed', ['ProjectSecret', 'brief']],
  ['P2', 'open //tmp/ProjectSecret/brief.txt failed', ['tmp', 'ProjectSecret', 'brief']],
  ['Q1', "open '/tmp/Cedar Lighthouse brief.txt' failed", ['Cedar', 'Lighthouse', 'brief']],
  ['Q2', 'open "/tmp/Cedar Lighthouse brief.txt" failed', ['Cedar', 'Lighthouse', 'brief']],
  [
    'Q3',
    String.raw`open 'C:\\ProjectSecret\\nested\\brief.txt' failed`,
    ['ProjectSecret', 'nested', 'brief'],
  ],
  ['Q4', String.raw`open '\\\\server\\share\\brief.txt' failed`, ['server', 'share', 'brief']],
  ['Q5', "open '~/ProjectSecret/brief.txt' failed", ['ProjectSecret', 'brief']],
  ['Q6', 'open `/tmp/Cedar Lighthouse brief.txt` failed', ['Cedar', 'Lighthouse', 'brief']],
  ['T1', 'open ~/ProjectSecret/brief.txt failed', ['ProjectSecret', 'brief']],
  [
    'T2',
    'open ~/synthetic/Cedar Lighthouse brief.txt failed',
    ['synthetic', 'Cedar', 'Lighthouse', 'brief'],
  ],
  ['T3', 'open ~qa/ProjectSecret/brief.txt failed', ['qa', 'ProjectSecret', 'brief']],
  [
    'N1a',
    'open /tmp/synthetic/cedar lighthouse brief.txt failed',
    ['cedar', 'lighthouse', 'brief', 'synthetic'],
  ],
  [
    'N1b',
    'open /tmp/synthetic/Cedar LIGHTHOUSE brief.txt failed',
    ['Cedar', 'LIGHTHOUSE', 'brief', 'synthetic'],
  ],
  ['N1c', 'open /home/qa/My Docs/a b c.txt failed', ['c.txt', 'Docs', 'home', 'qa']],
  [
    'N2a',
    'open /tmp/EVIDENCE_SECRET/Cedar Lighthouse brief.txt failed',
    ['EVIDENCE_SECRET', 'EVIDENCE', 'SECRET', 'Cedar', 'Lighthouse', 'brief'],
  ],
  [
    'N2b',
    'open /srv/EXPORTS/Cedar Lighthouse brief.txt failed',
    ['EXPORTS', 'srv', 'Cedar', 'Lighthouse', 'brief'],
  ],
  [
    'N2c',
    String.raw`open C:\Users\EMMA\Cedar Lighthouse brief.txt failed`,
    ['EMMA', 'Users', 'Cedar', 'Lighthouse', 'brief'],
  ],
];

test('契约：启动失败只公开固定文案和 error.code 里的已知错误码', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  const mismatches = [];
  try {
    for (const [id, input, forbidden] of unboundedStartupFailures) {
      const failed = await driveFreshHomeFault(env, input);
      const message = failed.events[0].message;
      if (message !== freshHomeStartupFailure) {
        mismatches.push(
          `${id} expected ${JSON.stringify(freshHomeStartupFailure)} got ${JSON.stringify(message)}`,
        );
      }
      for (const piece of forbidden) {
        if (message.includes(piece))
          mismatches.push(`${id} leaked ${piece} in ${JSON.stringify(message)}`);
      }
      assert.equal(failed.events[0].type, 'failed');
      assert.equal(failed.events[0].fault, 'executor-disconnected');
    }
    assert.deepEqual(mismatches, []);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：启动失败的错误码只取 error.code 里的已知值', async () => {
  const env = modelEnv('zhuma-synthetic-marker');
  const knownText = 'open /srv/EXPORTS/cedar lighthouse brief.txt EACCES';
  const unknownText = String.raw`open C:\Users\EMMA\Cedar Lighthouse brief.txt failed`;
  const missingText = 'open /tmp/EVIDENCE_SECRET/a b c.txt ENOENT';
  try {
    const known = await driveFreshHomeFault(env, knownText, 'ENOENT');
    assert.equal(known.events[0].message, '执行器启动失败。\nENOENT');
    assert.equal(known.events[0].message.includes('EXPORTS'), false);
    assert.equal(known.events[0].message.includes('lighthouse'), false);
    assert.equal(known.events[0].message.includes('EACCES'), false);

    const unknown = await driveFreshHomeFault(env, unknownText, 'EXPORTS');
    assert.equal(unknown.events[0].message, '执行器启动失败。');
    assert.equal(unknown.events[0].message.includes('EXPORTS'), false);
    assert.equal(unknown.events[0].message.includes('EMMA'), false);
    assert.equal(unknown.events[0].message.includes('Lighthouse'), false);

    const missing = await driveFreshHomeFault(env, missingText, '');
    assert.equal(missing.events[0].message, '执行器启动失败。');
    assert.equal(missing.events[0].message.includes('EVIDENCE_SECRET'), false);
    assert.equal(missing.events[0].message.includes('c.txt'), false);
    assert.equal(missing.events[0].message.includes('ENOENT'), false);
  } finally {
    rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
  }
});

test('契约：同一会话撤掉的技能不会在下一轮被扫描', async () => {
  const { engine, pids, env } = executor('ok', {
    initTimeoutMs: 10_000,
    promptTimeoutMs: 10_000,
  });
  const skill = (id, version) => ({ id, version, label: id, description: id, body: id });
  const drive = async (runId, skills, resumeSessionId) => {
    const events = [];
    for await (const event of engine.run({
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
      skills,
      goal: '确认字段',
      simulatedRequested: false,
      signal: new AbortController().signal,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    })) {
      events.push(event);
    }
    return events;
  };
  const visibleSkills = (home) =>
    JSON.parse(readFileSync(path.join(home, 'zhuma-visible.json'), 'utf8')).skills;
  const skillDirs = (home) =>
    readdirSync(path.join(home, 'granted-skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

  const first = await drive('skill-round-a', [skill('skill-a', 'v1')]);
  const accepted = first.find((event) => event.type === 'accepted');
  assert.equal(accepted?.type, 'accepted');
  const sessionId = accepted.sessionId;
  const home = dshSessionHome(sessionId, env);
  writeFileSync(path.join(home, 'keep-me.txt'), 'keep\n', { encoding: 'utf8', mode: 0o600 });
  let thrown;
  try {
    const replaced = await drive('skill-round-b', [skill('skill-b', 'v2')], sessionId);
    assert.equal(replaced.at(-1).type, 'completed');
    assert.deepEqual(visibleSkills(home), [{ id: 'skill-b', version: 'v2' }]);
    assert.deepEqual(skillDirs(home), ['skill-b']);
    assert.equal(existsSync(path.join(home, 'granted-skills', 'skill-a')), false);
    assert.match(
      readFileSync(path.join(home, 'granted-skills', 'skill-b', 'SKILL.md'), 'utf8'),
      /版本：v2/,
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'zhuma-grant.json'), 'utf8')).skills, [
      { id: 'skill-b', version: 'v2' },
    ]);
    assert.equal(readFileSync(path.join(home, 'keep-me.txt'), 'utf8'), 'keep\n');
    assert.equal(existsSync(path.join(home, 'decoy-skills', 'skill-evil', 'SKILL.md')), true);

    const emptied = await drive('skill-round-empty', [], sessionId);
    assert.equal(emptied.at(-1).type, 'completed');
    assert.deepEqual(visibleSkills(home), []);
    assert.deepEqual(skillDirs(home), []);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(home, 'zhuma-grant.json'), 'utf8')).skills,
      [],
    );
    assert.equal(readFileSync(path.join(home, 'keep-me.txt'), 'utf8'), 'keep\n');
    assert.equal(existsSync(path.join(home, 'decoy-skills', 'skill-evil', 'SKILL.md')), true);

    assert.equal(
      (await drive('skill-round-v9', [skill('skill-a', 'v9')], sessionId)).at(-1).type,
      'completed',
    );
    assert.equal(
      (await drive('skill-round-v10', [skill('skill-a', 'v10')], sessionId)).at(-1).type,
      'completed',
    );
    const document = readFileSync(path.join(home, 'granted-skills', 'skill-a', 'SKILL.md'), 'utf8');
    assert.match(document, /版本：v10/);
    assert.equal(document.includes('版本：v9'), false);
    assert.deepEqual(visibleSkills(home), [{ id: 'skill-a', version: 'v10' }]);
    assert.deepEqual(skillDirs(home), ['skill-a']);

    const blocked = path.join(home, 'granted-skills', 'skill-a');
    const before = pids.length;
    const failed = await driveWithBlockedRemove(env, sessionId, blocked);
    assert.equal(pids.length, before);
    assert.equal(failed.spawned, 0);
    assert.equal(failed.events.length, 1);
    assert.equal(failed.events[0].type, 'failed');
    assert.equal(failed.events[0].fault, 'executor-disconnected');
    assert.match(failed.events[0].message, /^执行器启动失败。/);
    assert.match(failed.events[0].message, /EACCES/);
    assert.equal(failed.events[0].message.includes(home), false);
    assert.equal(failed.events[0].message.includes(blocked), false);
    assert.equal(existsSync(home), true);
    assert.equal(readFileSync(path.join(home, 'keep-me.txt'), 'utf8'), 'keep\n');
    assert.equal(existsSync(path.join(blocked, 'SKILL.md')), true);
    assert.equal(existsSync(path.join(home, 'granted-skills', 'skill-b')), false);
    assert.equal(existsSync(path.join(home, 'decoy-skills', 'skill-evil', 'SKILL.md')), true);
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    let cleanupError;
    try {
      rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
      if (existsSync(env.ZHUMA_DATA_DIR)) throw new Error('会话目录还在');
    } catch (error) {
      cleanupError = error;
    }
    if (thrown === undefined && cleanupError !== undefined) throw cleanupError;
    if (cleanupError !== undefined) console.error(cleanupError);
  }
});

test('契约：数据目录不是目录时，定位失败变成启动失败，消息里没有绝对路径', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'zhuma-locate-'));
  const dataDir = path.join(parent, 'not-a-dir');
  writeFileSync(dataDir, 'x');
  const engine = new DshChatExecutor(
    {
      ZHUMA_MODEL_BASE_URL: 'https://example.invalid/v1',
      ZHUMA_MODEL_API_KEY: 'test-key',
      ZHUMA_MODEL_ID: 'test-model',
      ZHUMA_DATA_DIR: dataDir,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
    { bin: stub, mode: 'ok', initTimeoutMs: 2000 },
  );
  const events = [];
  let thrown = null;
  try {
    for await (const event of engine.run(runInput('locate-not-dir'))) events.push(event);
  } catch (error) {
    thrown = error;
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  assert.equal(thrown, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'failed');
  assert.equal(events[0].fault, 'executor-disconnected');
  assert.match(events[0].message, /^执行器启动失败。/);
  assert.match(events[0].message, /ENOTDIR/);
  assert.equal(events[0].message.includes(dataDir), false);
  assert.equal(events[0].message.includes(parent), false);
});

test('契约：启动时清掉孤儿会话目录', () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'zhuma-sweep-')), 'dsh-sessions');
  mkdirSync(root, { recursive: true });
  const live = path.join(root, 'dsh-live');
  const orphan = path.join(root, 'dsh-orphan');
  mkdirSync(live);
  mkdirSync(orphan);
  writeFileSync(path.join(root, 'index.json'), JSON.stringify({ sessions: { s1: 'dsh-live' } }));
  sweepDshSessionOrphans(root);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(orphan), false);
});

test('契约：别的活进程持有写锁时不清它的会话目录', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'zhuma-sweep-lock-'));
  const root = path.join(dataDir, 'dsh-sessions');
  mkdirSync(root, { recursive: true });
  const live = path.join(root, 'dsh-live');
  const orphan = path.join(root, 'dsh-orphan');
  mkdirSync(live);
  mkdirSync(orphan);
  writeFileSync(path.join(root, 'index.json'), JSON.stringify({ sessions: { s1: 'dsh-live' } }));
  const lockPath = path.join(dataDir, 'session.json.write.lock');
  writeFileSync(lockPath, 'not-json');
  sweepDshSessionOrphans(root);
  assert.equal(existsSync(orphan), true);

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: child.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    }),
  );
  try {
    sweepDshSessionOrphans(root);
    assert.equal(existsSync(orphan), true);
    assert.equal(existsSync(live), true);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
  sweepDshSessionOrphans(root);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(live), true);
});

test('契约：技能说明里的特殊字符仍会进入授权清单', async () => {
  const input = seed();
  input.catalog.skills[0].description = '字段: 必填 # 见 [规范] "信用代码"';
  const { engine, env } = executor('ok');
  const desk = ExecutionDesk.create(input, {
    executors: [engine],
    newId: ids('yaml-skill'),
  });
  desk.updateConfig({ executorId: 'dsh', skillIds: ['test-design'], mcpIds: [] });
  const sent = desk.send({ text: '带上技能', idempotencyKey: 'yaml-skill' });
  await desk.flush();
  const home = homeOf(desk, env, sent.runId);
  const visible = JSON.parse(readFileSync(path.join(home, 'zhuma-visible.json'), 'utf8'));
  assert.deepEqual(visible.skills, [{ id: 'test-design', version: 'plan-skill-1' }]);
  const skill = readFileSync(path.join(home, 'granted-skills', 'test-design', 'SKILL.md'), 'utf8');
  assert.equal(skill.includes('name: test-design'), true);
  assert.equal(skill.includes('description: "字段: 必填 # 见 [规范] \\"信用代码\\""'), true);
  rmSync(home, { recursive: true, force: true });
});

test('契约：没有 Office 技能文件时不写占位条目', async () => {
  const input = seed();
  input.handoff.skillRefs.push({ id: 'skill-office', version: 'office-1' });
  input.catalog.skills.push({
    id: 'skill-office',
    version: '1',
    label: 'Office 文档',
    available: true,
  });
  const { engine, env } = executor('ok');
  const desk = ExecutionDesk.create(input, { executors: [engine], newId: ids('office-off') });
  const shown = desk.snapshot().catalog.skills.find((item) => item.id === 'skill-office');
  assert.equal(shown.available, false);
  assert.match(shown.unavailableReason, /没有 Office 技能文件/);
  desk.updateConfig({ executorId: 'dsh', skillIds: ['skill-office'], mcpIds: [] });
  const sent = desk.send({ text: '不要占位', idempotencyKey: 'office-off' });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'resource-unavailable');
  assert.equal(sent.snapshot.runs.length, 0);
  const direct = await collect('ok', {
    env,
    skills: [
      {
        id: 'skill-office',
        version: 'office-1',
        label: 'Office 文档',
        description: '占位说明',
        body: '不要写成占位技能',
      },
    ],
  });
  assert.equal(direct.events.at(-1).type, 'completed');
  const home = dshSessionHome(
    direct.events.find((event) => event.type === 'accepted').sessionId,
    env,
  );
  assert.equal(existsSync(path.join(home, 'granted-skills', 'skill-office')), false);
  const visible = JSON.parse(readFileSync(path.join(home, 'zhuma-visible.json'), 'utf8'));
  assert.equal(
    visible.skills.some((item) => item.id === 'skill-office'),
    false,
  );
  assert.match(
    readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8'),
    /id: skill-office[\s\S]*disabled: true/,
  );
  rmSync(home, { recursive: true, force: true });
});

test('契约：已有 Office 技能文件时才打开插件', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zhuma-office-'));
  mkdirSync(path.join(root, 'office'));
  writeFileSync(
    path.join(root, 'office', 'SKILL.md'),
    '---\nname: office\ndescription: docs\n---\n\nbody\n',
  );
  const env = modelEnv();
  env.DSH_BUNDLED_OFFICE_SKILLS = root;
  try {
    const input = seed();
    input.handoff.skillRefs.push({ id: 'skill-office', version: 'office-1' });
    input.catalog.skills.push({
      id: 'skill-office',
      version: '1',
      label: 'Office 文档',
      available: true,
    });
    const { engine } = executor('ok', { env });
    const desk = ExecutionDesk.create(input, { executors: [engine], newId: ids('office-on') });
    assert.equal(
      desk.snapshot().catalog.skills.find((item) => item.id === 'skill-office').available,
      true,
    );
    desk.updateConfig({ executorId: 'dsh', skillIds: ['skill-office'], mcpIds: [] });
    const sent = desk.send({ text: '打开文档技能', idempotencyKey: 'office-on' });
    await desk.flush();
    const home = homeOf(desk, env, sent.runId);
    assert.equal(existsSync(path.join(home, 'granted-skills', 'skill-office')), false);
    const visible = JSON.parse(readFileSync(path.join(home, 'zhuma-visible.json'), 'utf8'));
    assert.equal(
      visible.skills.some((item) => item.id === 'skill-office'),
      true,
    );
    assert.match(
      readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8'),
      /id: skill-office[\s\S]*disabled: false/,
    );
    rmSync(home, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('契约：相同运行标识不会共用会话目录', async () => {
  const env = modelEnv();
  const once = async () => {
    const engine = new DshChatExecutor(env, {
      bin: stub,
      mode: 'ok',
      initTimeoutMs: 2000,
      promptTimeoutMs: 2000,
    });
    const events = [];
    for await (const event of engine.run(runRequest('run-4'))) events.push(event);
    return events;
  };
  const first = await once();
  const second = await once();
  assert.equal(first.at(-1).type, 'completed');
  assert.equal(second.at(-1).type, 'completed');
  const left = first.find((event) => event.type === 'accepted').sessionId;
  const right = second.find((event) => event.type === 'accepted').sessionId;
  assert.notEqual(left, right);
  assert.notEqual(left, 'zhuma-run-4');
  assert.equal(sessionHomes(env).length, 2);
  rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：重启后从运行记录读回会话标识', async () => {
  const { engine, env } = executor('ok');
  const firstDesk = ExecutionDesk.create(seed(), {
    executors: [engine],
    newId: ids('keep-session'),
  });
  firstDesk.updateConfig({ executorId: 'dsh', skillIds: ['test-design'], mcpIds: [] });
  const sent = firstDesk.send({ text: '第一段要留下来', idempotencyKey: 'keep-1' });
  await firstDesk.flush();
  const sessionId = firstDesk.snapshot().runs[0].sessionId;
  assert.match(sessionId, /^zhuma-[0-9a-f]{8}-[0-9a-f]{12}$/);
  const restored = ExecutionDesk.restore(firstDesk.persistence(), {
    executors: [
      new DshChatExecutor(env, {
        bin: stub,
        mode: 'ok',
        initTimeoutMs: 2000,
        promptTimeoutMs: 2000,
      }),
    ],
    newId: ids('keep-session-2'),
  });
  restored.resumeInteraction();
  const again = restored.send({ text: '第二段纯文本', idempotencyKey: 'keep-2' });
  await restored.flush();
  assert.equal(restored.snapshot().runs.at(-1).status, 'completed');
  assert.equal(restored.snapshot().runs.at(-1).sessionId, sessionId);
  const history = readFileSync(
    path.join(dshSessionHome(sessionId, env), 'zhuma-history.json'),
    'utf8',
  );
  assert.match(history, /第一段要留下来/);
  rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：节点完成时删除会话目录，历史记录保留已丢弃的会话标识', async () => {
  const { desk, env } = open('ok', { mcpIds: [], reviewRequired: false, reviewerIds: [] });
  const sent = desk.send({ text: '完成这一轮', idempotencyKey: 'complete-1' });
  await desk.flush();
  const sessionId = desk.snapshot().runs[0].sessionId;
  const home = dshSessionHome(sessionId, env);
  assert.equal(existsSync(home), true);
  const done = desk.confirmCompleted();
  assert.equal(done.ok, true);
  assert.equal(desk.snapshot().node.status, 'completed');
  assert.equal(existsSync(home), false);
  assert.equal(desk.snapshot().runs[0].sessionId, sessionId);
  assert.equal(desk.snapshot().runs[0].sessionDiscarded, true);
  assert.equal(createAgentWorkspaceView(desk.snapshot()).runs[0].sessionDiscarded, true);
  assert.deepEqual(sessionHomes(env), []);
  const index = JSON.parse(
    readFileSync(path.join(env.ZHUMA_DATA_DIR, 'dsh-sessions', 'index.json'), 'utf8'),
  );
  assert.equal(index.sessions[sessionId], undefined);
  assert.match(desk.snapshot().historyNote, /没有带上之前的历史/);
  const reopened = desk.reopenForRework();
  assert.equal(reopened.ok, true);
  assert.equal(desk.snapshot().node.status, 'needs-revision');
  const again = desk.send({ text: '退回后再来一轮', idempotencyKey: 'complete-2' });
  assert.equal(again.ok, true);
  await desk.flush();
  const next = desk.snapshot().runs.at(-1);
  assert.equal(next.status, 'completed');
  assert.notEqual(next.sessionId, sessionId);
  assert.equal(desk.snapshot().runs[0].sessionId, sessionId);
  assert.equal(desk.snapshot().runs[0].sessionDiscarded, true);
  assert.equal(desk.snapshot().historyNote, undefined);
  assert.equal(createAgentWorkspaceView(desk.snapshot()).historyNote, null);
  assert.equal(
    existsSync(path.join(dshSessionHome(next.sessionId, env), 'zhuma-history.json')),
    false,
  );
  rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：确认完成没写上日志时不删会话目录', async () => {
  const state = { value: null, failNext: false };
  const journal = {
    load: () => state.value,
    save(value) {
      if (state.failNext) {
        state.failNext = false;
        const error = new Error('ENOSPC: no space left');
        error.code = 'ENOSPC';
        throw error;
      }
      state.value = JSON.parse(JSON.stringify(value));
    },
  };
  const { desk, env } = open('ok', {
    mcpIds: [],
    reviewRequired: false,
    reviewerIds: [],
    journal,
  });
  desk.send({ text: '完成前先写上', idempotencyKey: 'complete-fail' });
  await desk.flush();
  const sessionId = desk.snapshot().runs[0].sessionId;
  const home = dshSessionHome(sessionId, env);
  assert.equal(existsSync(home), true);
  const before = JSON.parse(JSON.stringify(desk.persistence()));
  state.failNext = true;
  const completed = desk.confirmCompleted();
  assert.equal(completed.ok, false);
  assert.equal(completed.code, 'persist-failed');
  assert.equal(existsSync(home), true);
  assert.deepEqual(desk.persistence(), before);
  assert.equal(desk.snapshot().node.status, 'ready');
  assert.equal(desk.snapshot().runs[0].sessionDiscarded, undefined);
  assert.equal(desk.snapshot().downstreamLaunches, before.downstreamLaunches);
  rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：交接要求评审时不能直接完成', async () => {
  const { desk, env } = open('ok', { mcpIds: [] });
  const sent = desk.send({ text: '先跑完再试图跳过评审', idempotencyKey: 'review-1' });
  await desk.flush();
  const sessionId = desk.snapshot().runs[0].sessionId;
  const home = dshSessionHome(sessionId, env);
  assert.equal(existsSync(home), true);
  const refused = desk.confirmCompleted();
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'review-required');
  assert.match(refused.reason, /交接要求评审/);
  assert.equal(desk.snapshot().node.status, 'ready');
  assert.equal(existsSync(home), true);
  assert.equal(desk.snapshot().runs[0].sessionId, sessionId);
  assert.equal(desk.snapshot().runs[0].sessionDiscarded, undefined);
  rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：输入说明和交付说明进入提示', async () => {
  const inputNote = '读取已通过评审的开户字段说明';
  const expectedOutput = '开户字段校验规则说明';
  const { desk, env } = open('ok', { mcpIds: [], inputNote, expectedOutput });
  const sent = desk.send({ text: '按说明整理', idempotencyKey: 'notes-1' });
  await desk.flush();
  const prompt = readFileSync(
    path.join(homeOf(desk, env, sent.runId), 'zhuma-prompt.json'),
    'utf8',
  );
  assert.match(prompt, /输入说明：读取已通过评审的开户字段说明/);
  assert.match(prompt, /交付说明：开户字段校验规则说明/);
  assert.match(prompt, /节点目标：确认企业开户字段与校验规则/);
  assert.match(prompt, /本轮要求：按说明整理/);
  rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：核实断开后清掉会话引用，再发送会新建会话', async () => {
  const { desk, pids, env } = open('hold-after-messageId');
  const sent = desk.send({ text: '第一段要留下来', idempotencyKey: 'abandon-1' });
  await desk.waitForRun(sent.runId, 'running');
  const sessionId = desk.snapshot().runs[0].sessionId;
  assert.equal(existsSync(dshSessionHome(sessionId, env)), true);
  const saved = desk.persistence();
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已经退出。
    }
  }
  const restored = ExecutionDesk.restore(saved, {
    executors: [
      new DshChatExecutor(env, {
        bin: stub,
        mode: 'ok',
        initTimeoutMs: 2000,
        promptTimeoutMs: 2000,
      }),
    ],
    newId: ids('abandon-2'),
  });
  restored.resumeInteraction();
  const verified = restored.verifyAbandoned();
  assert.equal(verified.ok, true);
  assert.equal(existsSync(dshSessionHome(sessionId, env)), false);
  assert.equal(restored.snapshot().runs[0].sessionId, sessionId);
  assert.equal(restored.snapshot().runs[0].sessionDiscarded, true);
  assert.match(restored.snapshot().historyNote, /没有带上之前的历史/);
  assert.equal(
    restored.snapshot().turns.some((turn) => turn.role === 'executor' && turn.body.trim() === ''),
    false,
  );
  const restarted = ExecutionDesk.restore(restored.persistence(), {
    executors: [
      new DshChatExecutor(env, {
        bin: stub,
        mode: 'ok',
        initTimeoutMs: 2000,
        promptTimeoutMs: 2000,
      }),
    ],
    newId: ids('abandon-3'),
  });
  restarted.resumeInteraction();
  assert.equal(restarted.snapshot().historyNote, undefined);
  assert.equal(restarted.snapshot().runs[0].sessionId, sessionId);
  assert.equal(restarted.snapshot().runs[0].sessionDiscarded, true);
  const again = restarted.retry('abandon-retry');
  assert.equal(again.ok, true);
  await restarted.flush();
  const next = restarted.snapshot().runs.at(-1);
  assert.equal(next.status, 'completed');
  assert.notEqual(next.sessionId, sessionId);
  assert.equal(restarted.snapshot().historyNote, undefined);
  assert.equal(createAgentWorkspaceView(restarted.snapshot()).historyNote, null);
  assert.equal(restarted.snapshot().activities.filter((item) => item.title === 'MCP').length, 2);
  assert.equal(
    createAgentWorkspaceView(restarted.snapshot()).activities.filter((item) => item.title === 'MCP')
      .length,
    1,
  );
  const followed = restarted.send({ text: '再发一轮', idempotencyKey: 'abandon-4' });
  assert.equal(followed.ok, true);
  await restarted.flush();
  assert.equal(restarted.snapshot().runs.at(-1).status, 'completed');
  assert.equal(restarted.snapshot().activities.filter((item) => item.title === 'MCP').length, 3);
  assert.equal(
    createAgentWorkspaceView(restarted.snapshot()).activities.filter((item) => item.title === 'MCP')
      .length,
    1,
  );
  rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：resume 失败后清掉引用，下一轮可以新建会话', async () => {
  const { engine, env } = executor('ok');
  const first = ExecutionDesk.create(seed(), {
    executors: [engine],
    newId: ids('resume-ok'),
  });
  first.updateConfig({ executorId: 'dsh', skillIds: ['test-design'], mcpIds: [] });
  const sent = first.send({ text: '第一段', idempotencyKey: 'resume-1' });
  await first.flush();
  const sessionId = first.snapshot().runs[0].sessionId;
  assert.equal(existsSync(dshSessionHome(sessionId, env)), true);
  const second = ExecutionDesk.restore(first.persistence(), {
    executors: [
      new DshChatExecutor(env, {
        bin: stub,
        mode: 'resume-fail',
        initTimeoutMs: 2000,
        promptTimeoutMs: 2000,
      }),
    ],
    newId: ids('resume-fail'),
  });
  second.resumeInteraction();
  const failed = second.send({ text: '第二段', idempotencyKey: 'resume-2' });
  assert.equal(failed.ok, true);
  await second.flush();
  assert.equal(second.snapshot().runs.at(-1).status, 'failed');
  assert.equal(second.snapshot().node.status, 'ready');
  assert.equal(second.snapshot().runs[0].sessionId, sessionId);
  assert.equal(second.snapshot().runs[0].sessionDiscarded, true);
  assert.equal(second.snapshot().runs.at(-1).sessionId, undefined);
  assert.match(second.snapshot().faults.at(-1).reason, /恢复会话失败，已改用新会话/);
  assert.equal(second.snapshot().faults.at(-1).reason.includes('执行器启动失败'), false);
  assert.match(second.snapshot().historyNote, /没有带上之前的历史/);
  assert.equal(existsSync(dshSessionHome(sessionId, env)), false);
  assert.equal(
    second.snapshot().turns.some((turn) => turn.role === 'executor' && turn.body.trim() === ''),
    false,
  );
  const again = second.send({ text: '第三段', idempotencyKey: 'resume-3' });
  assert.equal(again.ok, true);
  await second.flush();
  const next = second.snapshot().runs.at(-1);
  assert.equal(next.status, 'completed');
  assert.notEqual(next.sessionId, sessionId);
  assert.equal(second.snapshot().historyNote, undefined);
  assert.equal(second.snapshot().runs[0].sessionId, sessionId);
  rmSync(env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：拒绝 PDF 不会留下让下一轮失败的会话', async () => {
  const blocked = await collect('ok', {
    runId: 'pdf-direct',
    attachments: [
      {
        id: 'file-pdf',
        name: '说明.pdf',
        mediaType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4'),
      },
    ],
  });
  assert.equal(
    blocked.events.some((event) => event.type === 'accepted'),
    false,
  );
  assert.equal(blocked.events.at(-1).type, 'failed');
  assert.equal(blocked.events.at(-1).fault, 'attachment-rejected');
  assert.notEqual(blocked.events.at(-1).fault, 'model-error');
  assert.match(blocked.events.at(-1).message, /没有可发送的附件引用/);
  assert.match(blocked.events.at(-1).message, /当前 SDK 接入方式/);
  assert.deepEqual(sessionHomes(blocked.env), []);
  const followed = await collect('ok', { env: blocked.env, runId: 'pdf-direct' });
  assert.equal(followed.events.at(-1).type, 'completed');
  rmSync(blocked.env.ZHUMA_DATA_DIR, { recursive: true, force: true });
});

test('契约：桩对没有附件引用的 file 块先回 messageId，再以 turn/end 失败，并毒化会话', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'zhuma-stub-file-'));
  writeFileSync(
    path.join(home, 'cordis.patch.yml'),
    '- id: skill-office\n  disabled: true\n- id: skill-filesystem\n  config:\n    includeDefaultRoots: false\n    customSkillDirs:\n      - "/tmp/zhuma-none"\n',
  );
  const child = spawn(process.execPath, [stub], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home, ZHUMA_DSH_STUB_MODE: 'ok' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = lineRpc(child);
  const init = await rpc.request('initialize', {});
  assert.equal(init.result.serverInfo.name, 'deepseek-harness-sdk-runtime');
  const rejected = await rpc.request('session/prompt', {
    sessionId: 's',
    contentBlocks: [
      { type: 'text', text: '看附件' },
      {
        type: 'file',
        data: Buffer.from('%PDF-1.4').toString('base64'),
        mimeType: 'application/pdf',
        name: 'a.pdf',
      },
    ],
  });
  assert.equal(typeof rejected.result.messageId, 'string');
  assert.equal(rejected.error, undefined);
  const ended = await rpc.until((note) => note.params?.event?.type === 'turn/end');
  assert.equal(ended.params.event.data.reason.kind, 'error');
  assert.match(ended.params.event.data.reason.error.message, /attachmentId/);
  const firstLog = readFileSync(path.join(home, 'zhuma-session.jsonl'), 'utf8');
  assert.match(firstLog, /"type":"file"/);
  assert.match(firstLog, /a\.pdf/);
  assert.equal(firstLog.includes('%PDF'), false);
  assert.equal(firstLog.includes('桩回复'), false);
  await rpc.exited;

  const child2 = spawn(process.execPath, [stub], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home, ZHUMA_DSH_STUB_MODE: 'ok' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const again = lineRpc(child2);
  await again.request('initialize', {});
  await again.request('session/resume', { sessionId: 's' });
  const followed = await again.request('session/prompt', {
    sessionId: 's',
    contentBlocks: [{ type: 'text', text: '纯文本还可以' }],
  });
  assert.equal(typeof followed.result.messageId, 'string');
  const followedEnd = await again.until((note) => note.params?.event?.type === 'turn/end');
  assert.equal(followedEnd.params.event.data.reason.kind, 'error');
  assert.match(followedEnd.params.event.data.reason.error.message, /attachmentId/);
  const log = readFileSync(path.join(home, 'zhuma-session.jsonl'), 'utf8');
  assert.match(log, /纯文本还可以/);
  assert.equal(log.includes('桩回复'), false);
  await again.exited;
  rmSync(home, { recursive: true, force: true });
});

test('契约：上游已构建但依赖未安装时补丁检查会写出跳过', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zhuma-patch-deps-'));
  const built = path.join(root, 'index.js');
  writeFileSync(
    built,
    "import 'zhuma-patch-check-missing';\nexport function loadOverlayPatches() { return []; }\n",
  );
  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(' '));
  try {
    await assertUpstreamPatch(path.join(root, 'none.yml'), built);
  } finally {
    console.log = original;
  }
  assert.match(messages.join('\n'), /依赖没有安装/);
  assert.match(messages.join('\n'), /pnpm upstream:build-dsh/);
  rmSync(root, { recursive: true, force: true });
});

test('契约：上游未构建时补丁检查会写出跳过', async () => {
  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(' '));
  try {
    await assertUpstreamPatch('/tmp/zhuma-no-patch.yml', '/tmp/zhuma-no-app-boot.js');
  } finally {
    console.log = original;
  }
  assert.match(messages.join('\n'), /skip: 上游 app-boot 未构建/);
  assert.match(messages.join('\n'), /pnpm upstream:build-dsh/);
});

test('契约：录制的内联 PDF 被上游拒绝', () => {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'dsh-pdf-rejected.json',
  );
  const notes = JSON.parse(readFileSync(file, 'utf8'));
  const end = notes.find((note) => note.params?.event?.type === 'turn/end');
  assert.equal(describeDshSessionEvent(end.params.event).reasonKind, 'error');
  assert.match(end.params.event.data.reason.error.message, /attachmentId/);
  const prompt = notes.find((note) => note.id === 2);
  assert.equal(typeof prompt.result.messageId, 'string');
  const text = JSON.stringify(notes);
  assert.equal(/https?:\/\//.test(text), false);
  assert.equal(text.includes('%PDF'), false);
  assert.equal(text.includes('JVBERi'), false);
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
    simulatedRequested: false,
    signal: new AbortController().signal,
  };
}

function lineRpc(child) {
  let buffer = '';
  const notes = [];
  let wake = () => {};
  const waiters = [];
  const arrived = () => {
    wake();
    for (const waiter of waiters) waiter();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        notes.push(JSON.parse(line));
        arrived();
      }
      newline = buffer.indexOf('\n');
    }
  });
  let nextId = 1;
  return {
    exited: new Promise((resolve) => child.on('exit', () => resolve())),
    until(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 2000);
        const pull = () => {
          const found = notes.find(predicate);
          if (!found) return;
          clearTimeout(timer);
          resolve(found);
        };
        waiters.push(pull);
        pull();
      });
    },
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 2000);
        const pull = () => {
          const found = notes.find((note) => note.id === id);
          if (!found) return;
          clearTimeout(timer);
          wake = () => {};
          resolve(found);
        };
        wake = pull;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        pull();
      });
    },
  };
}

function upstreamPatchParser() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../upstream/deepseek-harness/packages/boot/app-boot/lib/index.js',
  );
}

async function assertUpstreamPatch(file, built = upstreamPatchParser()) {
  if (!existsSync(built)) {
    console.log(
      'skip: 上游 app-boot 未构建，没有用 loadOverlayPatches 检查补丁。请先运行 pnpm upstream:build-dsh。',
    );
    return;
  }
  let patches;
  try {
    const mod = await import(pathToFileURL(built).href);
    patches = mod.loadOverlayPatches('zhuma', file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (missingDependency(message)) {
      console.log(
        'skip: 上游 app-boot 已构建，但依赖没有安装，没有用 loadOverlayPatches 检查补丁。请先运行 pnpm upstream:build-dsh。',
      );
      return;
    }
    throw error;
  }
  assert.equal(Array.isArray(patches), true);
  assert.equal(
    patches.some((item) => item.id === 'llm-pi-ai'),
    true,
  );
}

function missingDependency(message) {
  return (
    message.includes('Cannot find module') ||
    message.includes('Cannot find package') ||
    message.includes('ERR_MODULE_NOT_FOUND') ||
    message.includes('ERR_PACKAGE_PATH_NOT_EXPORTED')
  );
}
