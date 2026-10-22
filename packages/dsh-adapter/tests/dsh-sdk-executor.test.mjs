import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { tmpdir } from 'node:os';
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
  const desk = ExecutionDesk.create(seed(), { executors: [engine], newId: ids(mode) });
  desk.updateConfig({
    executorId: 'dsh',
    skillIds: extra.skillIds ?? ['test-design', 'billing'],
    mcpIds: extra.mcpIds ?? ['api-docs', 'extra-mcp'],
  });
  return { desk, pids, env };
}

function homeFor(runId, env) {
  return dshSessionHome(`zhuma-${runId}`, env);
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
  assert.equal(pdf.ok, true);
  const imageId = image.snapshot.attachments[0].id;
  const sent = desk.send({
    text: '只带这一张图',
    idempotencyKey: 'grant-send',
    attachmentIds: [imageId, pdf.snapshot.attachments.at(-1).id],
  });
  assert.equal(sent.ok, true);
  await desk.flush();
  const home = homeFor(sent.runId, env);
  const visible = JSON.parse(readFileSync(path.join(home, 'zhuma-visible.json'), 'utf8'));
  assert.deepEqual(visible.skills, [{ id: 'test-design', version: 'plan-skill-1' }]);
  assert.deepEqual(visible.mcp, []);
  assert.equal(visible.toolsDisabled.includes('tool-bash'), true);
  assert.equal(visible.toolsDisabled.includes('tool-web'), true);
  assert.equal(visible.toolsDisabled.includes('tool-subagent'), true);
  const skill = readFileSync(path.join(home, 'granted-skills', 'test-design', 'SKILL.md'), 'utf8');
  assert.match(skill, /name: test-design/);
  assert.match(skill, /description: 测试设计/);
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
  assert.match(prompt, /"type":"file"/);
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
  const prompt = readFileSync(path.join(homeFor(sent.runId, env), 'zhuma-prompt.json'), 'utf8');
  assert.equal(prompt.includes('应该进入提示'), false);
  assert.equal(desk.snapshot().citations.length, 0);
  assert.equal(desk.snapshot().runs[0].contextRefs.length, 0);
  assert.equal(
    pids.every((pid) => !alive(pid)),
    true,
  );
  rmSync(homeFor(sent.runId, env), { recursive: true, force: true });
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
  assert.equal(existsSync(homeFor(first.runId, timed.env)), false);
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
  assert.equal(existsSync(homeFor(crashSend.runId, crashed.env)), false);
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
  rmSync(homeFor(stopSend.runId, stopped.env), { recursive: true, force: true });
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
    const home = dshSessionHome(desk.snapshot().runs[0].sessionId, env);
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
  for (const [runId, env] of [
    ['noise-run', noise.env],
    ['empty-run', empty.env],
    ['tools-run', tools.env],
    ['missing-id', missing.env],
  ]) {
    rmSync(homeFor(runId, env), { recursive: true, force: true });
  }
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
  input.handoff.inputRefs = [...input.handoff.inputRefs, { contextPackId: 'pack-optional' }];
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
    contextPackId: 'pack-optional',
  });
  const desk = ExecutionDesk.create(input, { executors: [engine], newId: ids('uncheck') });
  desk.updateConfig({ executorId: 'dsh', skillIds: ['test-design'], mcpIds: [] });
  const sent = desk.send({ text: '带上可选项', idempotencyKey: 'opt-1' });
  await desk.flush();
  const first = readFileSync(path.join(homeFor(sent.runId, env), 'zhuma-prompt.json'), 'utf8');
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
  assert.equal(existsSync(homeFor('stderr-boot', env)), false);

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

async function assertUpstreamPatch(file) {
  const built = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../upstream/deepseek-harness/packages/boot/app-boot/lib/index.js',
  );
  if (!existsSync(built)) return;
  const mod = await import(pathToFileURL(built).href);
  const patches = mod.loadOverlayPatches('zhuma', file);
  assert.equal(Array.isArray(patches), true);
  assert.equal(
    patches.some((item) => item.id === 'llm-pi-ai'),
    true,
  );
}
