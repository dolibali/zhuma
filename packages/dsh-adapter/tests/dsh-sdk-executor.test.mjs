import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
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
  describeDshSessionEvent,
  dshSessionHome,
  sweepDshSessionOrphans,
} from '@zhuma/dsh-adapter';
import { createAgentWorkspaceView } from '../../client/dist/index.js';

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
    initTimeoutMs: extra.initTimeoutMs ?? 2000,
    promptTimeoutMs: extra.promptTimeoutMs ?? 2000,
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
  const { desk, pids, env } = open('ok');
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
  const { engine, pids, env } = executor('ok');
  const bare = seed();
  bare.handoff.inputRefs = [];
  const desk = ExecutionDesk.create(bare, { executors: [engine], newId: ids('empty-context') });
  desk.updateConfig({ executorId: 'dsh', skillIds: ['test-design'], mcpIds: ['api-docs'] });
  const sent = desk.send({ text: '没有上下文包', idempotencyKey: 'empty-context' });
  await desk.flush();
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
  const desk = ExecutionDesk.create(seed(), { executors: [missing], newId: ids('missing-bin') });
  desk.updateConfig({ executorId: 'dsh' });
  const refused = desk.send({ text: '不要调用', idempotencyKey: 'missing-bin-send' });
  assert.equal(refused.ok, false);
  assert.equal(refused.snapshot.runs.length, 0);
  assert.match(refused.reason, /pnpm upstream:build-dsh/);
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
    '执行器启动失败。\nhead [redacted][redacted] gap [redacted] tail',
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
    execFileSync('sudo', ['-n', 'chown', '-R', 'root:root', blocked]);
    execFileSync('sudo', ['-n', 'chmod', '555', blocked]);
    execFileSync('sudo', ['-n', 'chmod', '444', path.join(blocked, 'SKILL.md')]);
    const before = pids.length;
    const failed = await drive('skill-round-cleanup', [skill('skill-b', 'v3')], sessionId);
    assert.equal(pids.length, before);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].type, 'failed');
    assert.equal(failed[0].fault, 'executor-disconnected');
    assert.equal(failed[0].message, '执行器启动失败。');
    assert.equal(existsSync(home), true);
    assert.equal(readFileSync(path.join(home, 'keep-me.txt'), 'utf8'), 'keep\n');
    assert.equal(existsSync(path.join(blocked, 'SKILL.md')), true);
    assert.equal(existsSync(path.join(home, 'granted-skills', 'skill-b')), false);
    assert.equal(existsSync(path.join(home, 'decoy-skills', 'skill-evil', 'SKILL.md')), true);
  } finally {
    execFileSync('sudo', ['-n', 'rm', '-rf', home]);
  }
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
