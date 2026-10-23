import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionFaultKind } from '@zhuma/agent-core';
import { foreignWriteLockHeld } from './file-journal.js';
import {
  ExecutorNotImplementedError,
  readDshModelConfig,
  taskPrompt,
  type AgentExecutor,
  type AgentRunEvent,
  type AgentRunRequest,
  type CancelReceipt,
  type DshModelConfigResult,
  type ExecutorCapabilities,
} from './agent-executor.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const builtBinary = path.join(repoRoot, 'upstream/deepseek-harness/apps/cli/lib/bin.js');

export interface DshExecutorOptions {
  readonly bin?: string;
  readonly mode?: string;
  readonly initTimeoutMs?: number;
  readonly promptTimeoutMs?: number;
  readonly onSpawn?: (pid: number) => void;
  /** 工作台数据目录。会话家目录在其下用 mkdtemp 生成。 */
  readonly dataDir?: string;
  /** 进程启动时清掉索引里没有的会话目录。 */
  readonly sweepOrphans?: boolean;
}

interface SkillGrant {
  readonly id: string;
  readonly version: string;
  readonly label?: string;
  readonly description?: string;
  readonly body?: string;
}

interface McpGrant {
  readonly id: string;
  readonly version: string;
  readonly label?: string;
  readonly transport?: 'stdio' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
}

interface LiveRun {
  child: ChildProcessWithoutNullStreams;
  stopping: boolean;
  accepted: boolean;
  receipt?: (receipt: CancelReceipt) => void;
}

interface SessionEvent {
  readonly type?: string;
  readonly data?: {
    readonly message?: { readonly content?: unknown };
    readonly reason?: { readonly kind?: string };
    readonly stream?: unknown;
  };
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { event?: SessionEvent };
  result?: unknown;
  error?: { message?: string };
}

interface SessionIndex {
  sessions: Record<string, string>;
}

/** 内置工具默认关闭。白名单里的名字或插件 id 打开对应的一组。 */
const TOOL_GROUPS: readonly {
  readonly ids: readonly string[];
  readonly names: readonly string[];
}[] = [
  {
    ids: ['tool-bash', 'tool-pwsh', 'tool-jobs'],
    names: ['bash', 'shell', 'tool-bash', 'tool-pwsh', 'tool-jobs'],
  },
  {
    ids: ['tool-fs', 'tool-fs-search'],
    names: ['write', 'edit', 'read', 'fs', 'tool-fs', 'tool-fs-search'],
  },
  {
    ids: ['web', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'],
    names: [
      'web',
      'web_fetch',
      'web_search',
      'web-fetch',
      'web-search',
      'tool-web',
      'web-fetch-http',
      'web-search-deepseek',
      'web-deepseek-api',
    ],
  },
  {
    ids: [
      'subagent',
      'subagent-spawn-in-process',
      'subagent-fork-in-process',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-control',
      'tool-subagent-list-agents',
    ],
    names: [
      'subagent',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-control',
      'tool-subagent-list-agents',
      'subagent-spawn-in-process',
      'subagent-fork-in-process',
    ],
  },
  {
    ids: ['tool-workflow', 'workflow-ptc'],
    names: ['workflow', 'tool-workflow', 'workflow-ptc'],
  },
];

/** `ZHUMA_DSH_BIN`，否则使用上游构建出的 CLI。两者都不存在时返回 null。 */
export function resolveDshBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.ZHUMA_DSH_BIN?.trim() ?? '';
  if (override.length > 0) return existsSync(override) ? override : null;
  return existsSync(builtBinary) ? builtBinary : null;
}

export function missingDshRuntimeReason(): string {
  return '没有找到 DSH 运行时。请运行 pnpm upstream:build-dsh，或设置 ZHUMA_DSH_BIN。还需要 ZHUMA_MODEL_BASE_URL、ZHUMA_MODEL_API_KEY 和 ZHUMA_MODEL_ID。不会改用模拟执行器。';
}

/** 源码构建没有随包的 Office 技能。界面和目录用这句话说明。 */
export const OFFICE_SKILL_UNAVAILABLE = '当前构建没有 Office 技能文件，授权不会加载文档技能。';

/** 上游插件只在 assetRoot 下有 office/SKILL.md 时才能加载文档技能。 */
export function officeSkillsReady(env: NodeJS.ProcessEnv = process.env): boolean {
  const bundled = env.DSH_BUNDLED_OFFICE_SKILLS?.trim() ?? '';
  if (bundled.length > 0 && isOfficeRoot(bundled)) return true;
  const runtime = (env.DSH_PRIMARY_RUNTIME ?? env.DSH_BUNDLED_PRIMARY_RUNTIME ?? '').trim();
  if (runtime.length === 0) return false;
  return isOfficeRoot(path.resolve(runtime, '..', 'office-skills'));
}

function isOfficeRoot(root: string): boolean {
  return existsSync(path.join(root, 'office', 'SKILL.md'));
}

/**
 * 当前 SDK 接入方式的 file 块必须带已经入库的附件引用。客户端发不出这个引用。
 * 文本、JSON 和 png、jpeg、webp、gif 可以发送。其余在上传时拒绝。
 */
export function attachmentRefusalReason(name: string, mediaType: string): string | null {
  const type = mediaType.trim().toLowerCase();
  if (type.startsWith('text/') || type === 'application/json') return null;
  if (isImageMime(type)) return null;
  const label = name.trim().length > 0 ? name.trim() : '这个文件';
  return `${label} 不能交给当前执行器。当前 SDK 接入方式只接受文本和内联图片，PDF 及其他文件没有可发送的附件引用。`;
}

export function mcpTransportReady(item: {
  readonly transport?: 'stdio' | 'streamable-http';
  readonly command?: string;
  readonly url?: string;
}): boolean {
  if (item.transport === 'stdio') return (item.command ?? '').length > 0;
  if (item.transport === 'streamable-http') return (item.url ?? '').length > 0;
  return false;
}

export function resolveDshDataDir(env: NodeJS.ProcessEnv, dataDir?: string): string {
  const explicit = dataDir?.trim() ?? '';
  if (explicit.length > 0) return path.resolve(explicit);
  const fromEnv = env.ZHUMA_DATA_DIR?.trim() ?? '';
  if (fromEnv.length > 0) return path.resolve(fromEnv);
  const sessionFile = env.ZHUMA_SESSION_FILE?.trim() ?? '';
  if (sessionFile.length > 0) return path.dirname(path.resolve(sessionFile));
  return path.join(homedir(), '.zhuma', 'workbench');
}

/** 启动时清掉会话根目录里不在索引中的目录。别的活进程持有写锁时整次跳过。 */
export function sweepDshSessionOrphans(root: string): void {
  if (foreignWriteLockHeld(path.dirname(root))) return;
  if (!existsSync(root)) return;
  const index = readIndex(root);
  const live = new Set(Object.values(index.sessions));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (live.has(entry.name)) continue;
    rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
  let changed = false;
  for (const [id, name] of Object.entries(index.sessions)) {
    if (existsSync(path.join(root, name))) continue;
    delete index.sessions[id];
    changed = true;
  }
  if (changed) writeIndex(root, index);
}

/**
 * 从上游会话事件里取出正文和结束原因。
 * 正文在 `data.message.content`，随整段 `assistant/message` 到达。
 * `data.stream` 是这条事件上的事后记录。当前 SDK 接入方式没有逐字通知。
 * 结束原因在 `data.reason.kind`。
 */
export function describeDshSessionEvent(event: unknown): {
  type: string;
  text: string;
  tools: boolean;
  reasonKind: string | null;
} {
  if (event === null || typeof event !== 'object') {
    return { type: '', text: '', tools: false, reasonKind: null };
  }
  const record = event as SessionEvent;
  const data = record.data;
  const reason = data?.reason && typeof data.reason.kind === 'string' ? data.reason.kind : null;
  const read = readAssistantPayload(data);
  return {
    type: typeof record.type === 'string' ? record.type : '',
    text: read.text,
    tools: read.tools,
    reasonKind: reason,
  };
}

/**
 * 显式选择后启动 `dsh --profile sdk`，经 stdio JSON-RPC 对话。
 * `accepted` 只在 `session/prompt` 返回 messageId 之后发出。
 * 停止没有协议方法：结束子进程，回执来自进程退出或 `turn/end` 的 `aborted`。
 * 会话可以 `session/resume`，所以 `sessionResume` 为 true。
 */
export class DshChatExecutor implements AgentExecutor {
  readonly id = 'dsh' as const;
  readonly capabilities: ExecutorCapabilities;
  readonly unavailableReason?: string;
  private readonly configResult: DshModelConfigResult;
  private readonly bin: string | null;
  private readonly mode?: string;
  private readonly initTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly onSpawn?: (pid: number) => void;
  private readonly sessionsRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly instanceId = randomBytes(4).toString('hex');
  private readonly known = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly stopping = new Set<string>();
  private readonly live = new Map<string, LiveRun>();
  private readonly earlyReceipt = new Map<string, (receipt: CancelReceipt) => void>();

  constructor(env: NodeJS.ProcessEnv = process.env, options: DshExecutorOptions = {}) {
    this.env = env;
    this.configResult = readDshModelConfig(env);
    this.bin = options.bin ?? resolveDshBinary(env);
    if (options.mode !== undefined) this.mode = options.mode;
    this.initTimeoutMs = options.initTimeoutMs ?? 30_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 30_000;
    if (options.onSpawn !== undefined) this.onSpawn = options.onSpawn;
    this.sessionsRoot = path.join(resolveDshDataDir(env, options.dataDir), 'dsh-sessions');
    if (options.sweepOrphans) sweepDshSessionOrphans(this.sessionsRoot);
    const reason = !this.configResult.ok
      ? this.configResult.reason
      : this.bin === null
        ? missingDshRuntimeReason()
        : undefined;
    if (reason !== undefined) this.unavailableReason = reason;
    this.capabilities = Object.freeze({
      liveInjection: false,
      sessionResume: true,
      cancelReceipt: true,
      streaming: false,
      verified: this.configResult.ok && this.bin !== null,
      mode: 'native',
    });
  }

  /** 当前构建是否带有可加载的 Office 技能文件。 */
  officeReady(): boolean {
    return officeSkillsReady(this.env);
  }

  /** 运行作废或节点结束后删掉这次会话目录。 */
  discardSession(sessionId: string): void {
    const home = this.lookup(sessionId);
    this.forget(sessionId);
    if (home !== null) rmSync(home, { recursive: true, force: true });
  }

  /** 索引和目录都还在，才可以 session/resume。 */
  hasSessionDirectory(sessionId: string): boolean {
    const home = this.lookup(sessionId);
    return home !== null && existsSync(home);
  }

  async cancel(runId: string): Promise<CancelReceipt> {
    if (!this.known.has(runId)) return { receipt: 'rejected', reason: '没有这次运行。' };
    if (this.finished.has(runId)) {
      return { receipt: 'rejected', reason: '运行已经结束，迟到的停止不能改写结果。' };
    }
    this.stopping.add(runId);
    const current = this.live.get(runId);
    if (current) {
      current.stopping = true;
      current.child.kill('SIGTERM');
    }
    return new Promise((resolve) => {
      if (current) current.receipt = resolve;
      else this.earlyReceipt.set(runId, resolve);
    });
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    if (!this.configResult.ok) throw new ExecutorNotImplementedError(this.configResult.reason);
    if (this.bin === null) throw new ExecutorNotImplementedError(missingDshRuntimeReason());
    this.known.add(request.runId);
    const unsupported = unsupportedAttachment(request);
    if (unsupported !== null) {
      this.finished.add(request.runId);
      const pending = this.earlyReceipt.get(request.runId);
      this.earlyReceipt.delete(request.runId);
      pending?.({ receipt: 'rejected', reason: '运行已经结束。' });
      yield {
        type: 'failed',
        fault: 'attachment-rejected',
        message: unsupported,
        simulated: false,
      };
      return;
    }
    const bin = this.bin;
    if (!canExecute(bin)) {
      this.finished.add(request.runId);
      yield {
        type: 'failed',
        fault: 'executor-disconnected',
        message: '执行器启动失败。',
        simulated: false,
      };
      return;
    }
    const config = this.configResult.config;
    const sessionId = sanitizeId(request.resumeSessionId ?? this.allocateSessionId());
    let home = '';
    let created = false;
    try {
      const located = this.locate(sessionId);
      home = located.home;
      created = located.created;
      writeRunHome(
        home,
        {
          skills: request.skills ?? [],
          mcp: request.mcp ?? [],
          toolAllowlist: request.toolAllowlist ?? [],
          modelId: config.modelId,
          baseUrl: config.baseUrl,
        },
        this.env,
      );
    } catch (error) {
      this.finished.add(request.runId);
      const pending = this.earlyReceipt.get(request.runId);
      this.earlyReceipt.delete(request.runId);
      pending?.({ receipt: 'rejected', reason: '运行已经结束。' });
      if (created) this.discardCreatedHome(home, sessionId);
      yield {
        type: 'failed',
        fault: 'executor-disconnected',
        message: startupFailureMessage(error),
        simulated: false,
      };
      return;
    }
    const child = spawn(bin, ['--profile', 'sdk'], {
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv(home, config.apiKey, this.mode),
    });
    if (child.pid !== undefined) this.onSpawn?.(child.pid);
    const early = this.earlyReceipt.get(request.runId);
    this.earlyReceipt.delete(request.runId);
    const state: LiveRun = {
      child,
      stopping: this.stopping.has(request.runId),
      accepted: false,
      ...(early !== undefined ? { receipt: early } : {}),
    };
    this.live.set(request.runId, state);
    if (state.stopping) child.kill('SIGTERM');
    const rpc = new StdioRpc(child, config.apiKey);
    let cancelYielded = false;
    let initialized = false;
    let droppedSessionId: string | undefined;
    const fail = async (fault: ExecutionFaultKind, message: string): Promise<AgentRunEvent> => {
      await rpc.sealStderr();
      return {
        type: 'failed',
        fault,
        message: state.accepted ? message : withStderr(message, rpc.stderr),
        simulated: false,
      };
    };
    try {
      await rpc.request(
        'initialize',
        { cwd: home, provider: 'zhuma', model: config.modelId },
        this.initTimeoutMs,
      );
      initialized = true;
      restrictTree(home);
      if (request.resumeSessionId !== undefined) {
        try {
          await rpc.request('session/resume', { sessionId }, this.promptTimeoutMs);
        } catch (resumeError) {
          droppedSessionId = sessionId;
          if (existsSync(home)) rmSync(home, { recursive: true, force: true });
          this.forget(sessionId);
          throw resumeError;
        }
      }
      const prompted = await rpc.request(
        'session/prompt',
        { sessionId, contentBlocks: promptBlocks(request) },
        this.promptTimeoutMs,
      );
      if (state.stopping) {
        await rpc.exited;
        cancelYielded = true;
        yield { type: 'cancelled', simulated: false };
        return;
      }
      const messageId = messageIdOf(prompted);
      if (messageId === null) {
        await stopChild(child, rpc);
        yield await fail('model-error', '执行器没有返回接收回执。');
        return;
      }
      state.accepted = true;
      yield* noiseActivities(request.runId, rpc);
      yield { type: 'accepted', executorRunId: messageId, sessionId, simulated: false };
      const outcome = yield* readTurn(rpc, state, this.promptTimeoutMs);
      yield* noiseActivities(request.runId, rpc);
      if (outcome.kind === 'cancelled') {
        cancelYielded = true;
        yield { type: 'cancelled', simulated: false };
        return;
      }
      if (outcome.kind === 'failed') {
        yield {
          type: 'failed',
          fault: outcome.fault,
          message: outcome.message,
          simulated: false,
        };
        return;
      }
      yield {
        type: 'completed',
        result: {
          executorRunId: messageId,
          simulated: false,
          summary: outcome.text,
          draftText: outcome.text,
          sourceReferences: [...request.contextReferences],
          verification: [],
        },
      };
    } catch (error) {
      if (!rpc.closed) await stopChild(child, rpc);
      if (state.stopping) {
        cancelYielded = true;
        yield { type: 'cancelled', simulated: false };
        return;
      }
      const timedOut = error instanceof Error && error.message === 'timeout';
      const failed = await fail(
        timedOut ? 'network-interruption' : 'executor-disconnected',
        droppedSessionId !== undefined
          ? '恢复会话失败，已改用新会话。'
          : timedOut
            ? initialized
              ? state.accepted
                ? '执行器没有在时限内返回结果。'
                : '执行器没有在时限内接收。'
              : '执行器启动超时。'
            : '执行器启动失败。',
      );
      if (failed.type === 'failed' && droppedSessionId !== undefined) {
        yield { ...failed, droppedSessionId };
      } else {
        yield failed;
      }
    } finally {
      if (!rpc.closed) await stopChild(child, rpc);
      await rpc.sealStderr();
      if (existsSync(home)) {
        if (state.accepted) {
          writeFileSync(path.join(home, 'zhuma-collected-stderr.txt'), rpc.stderr, {
            encoding: 'utf8',
            mode: 0o600,
          });
          restrictTree(home);
        } else if (created) {
          rmSync(home, { recursive: true, force: true });
          this.forget(sessionId);
        } else {
          restrictTree(home);
        }
      }
      this.finished.add(request.runId);
      this.live.delete(request.runId);
      state.receipt?.({
        receipt: cancelYielded || state.stopping ? 'cancelled' : 'rejected',
        reason: '运行已经结束。',
      });
    }
  }

  private allocateSessionId(): string {
    return `zhuma-${this.instanceId}-${randomBytes(6).toString('hex')}`;
  }

  private locate(sessionId: string): { home: string; created: boolean } {
    const existing = this.lookup(sessionId);
    if (existing !== null && existsSync(existing)) return { home: existing, created: false };
    mkdirSync(this.sessionsRoot, { recursive: true, mode: 0o700 });
    chmodSync(this.sessionsRoot, 0o700);
    const home = mkdtempSync(path.join(this.sessionsRoot, 'dsh-'));
    chmodSync(home, 0o700);
    this.remember(sessionId, path.basename(home));
    return { home, created: true };
  }

  private lookup(sessionId: string): string | null {
    const name = readIndex(this.sessionsRoot).sessions[sanitizeId(sessionId)];
    if (name === undefined) return null;
    return path.join(this.sessionsRoot, name);
  }

  private remember(sessionId: string, dirName: string): void {
    const index = readIndex(this.sessionsRoot);
    index.sessions[sanitizeId(sessionId)] = dirName;
    writeIndex(this.sessionsRoot, index);
  }

  private forget(sessionId: string): void {
    const index = readIndex(this.sessionsRoot);
    if (index.sessions[sanitizeId(sessionId)] === undefined) return;
    delete index.sessions[sanitizeId(sessionId)];
    writeIndex(this.sessionsRoot, index);
  }

  /** 新建会话还没启动就失败时，目录和索引记录一起清掉。已有会话不动。 */
  private discardCreatedHome(home: string, sessionId: string): void {
    try {
      if (home.length > 0 && existsSync(home)) rmSync(home, { recursive: true, force: true });
    } catch {
      // 清目录失败不能盖住原来的启动错误。
    }
    try {
      this.forget(sessionId);
    } catch {
      // 清索引失败不能盖住原来的启动错误。
    }
  }
}

export function dshSessionHome(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = path.join(resolveDshDataDir(env), 'dsh-sessions');
  const name = readIndex(root).sessions[sanitizeId(sessionId)];
  if (name === undefined) return path.join(root, 'missing', sanitizeId(sessionId));
  return path.join(root, name);
}

function childEnv(home: string, apiKey: string, mode: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    ZHUMA_MODEL_API_KEY: apiKey,
  };
  if (mode !== undefined) env.ZHUMA_DSH_STUB_MODE = mode;
  return env;
}

function promptBlocks(request: AgentRunRequest): readonly Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: 'text', text: taskPrompt(request) }];
  const mcpNote = mcpPrompt(request.mcp ?? []);
  if (mcpNote.length > 0) blocks.push({ type: 'text', text: mcpNote });
  for (const item of request.promptContext ?? []) {
    blocks.push({ type: 'text', text: item.body });
  }
  for (const item of request.attachments ?? []) {
    if (isImageMime(item.mediaType)) {
      blocks.push({
        type: 'image',
        data: Buffer.from(item.bytes).toString('base64'),
        mimeType: item.mediaType,
      });
    } else if (isTextMedia(item.mediaType)) {
      blocks.push({ type: 'text', text: Buffer.from(item.bytes).toString('utf8') });
    }
  }
  return blocks;
}

function mcpPrompt(items: readonly McpGrant[]): string {
  if (items.length === 0) return '';
  const lines = items.map((item) => {
    const ready = mcpReady(item);
    const access = ready ? '已按配置的传输接入' : '没有配置传输，不会连接外部服务';
    return `${item.id}（${item.label ?? item.id}，版本 ${item.version}，${access}）`;
  });
  return `本次运行已授权的 MCP：${lines.join('、')}。`;
}

function isImageMime(
  value: string,
): value is 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  return (
    value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/webp' ||
    value === 'image/gif'
  );
}

function isTextMedia(value: string): boolean {
  return value.startsWith('text/') || value === 'application/json';
}

function messageIdOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || !('messageId' in value)) return null;
  const messageId = value.messageId;
  return typeof messageId === 'string' && messageId.length > 0 ? messageId : null;
}

function* noiseActivities(runId: string, rpc: StdioRpc): Generator<AgentRunEvent> {
  for (const [index, line] of rpc.drainNoise().entries()) {
    void line;
    yield {
      type: 'activity',
      activity: {
        id: `noise-${runId}-${index}`,
        title: '执行器输出',
        detail: '忽略了一行非 JSON 输出。',
        simulated: false,
        succeeded: false,
      },
    };
  }
}

type TurnOutcome =
  | { readonly kind: 'completed'; readonly text: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly fault: ExecutionFaultKind; readonly message: string };

async function* readTurn(
  rpc: StdioRpc,
  state: LiveRun,
  timeoutMs: number,
): AsyncGenerator<AgentRunEvent, TurnOutcome> {
  let text = '';
  let tools = false;
  while (!rpc.closed) {
    if (state.stopping) {
      await rpc.exited;
      return { kind: 'cancelled' };
    }
    const note = await rpc.nextNote(timeoutMs);
    if (note === 'timeout') {
      return {
        kind: 'failed',
        fault: 'network-interruption',
        message: '执行器没有在时限内返回结果。',
      };
    }
    if (note === 'closed') {
      await rpc.exited;
      return state.stopping
        ? { kind: 'cancelled' }
        : { kind: 'failed', fault: 'executor-disconnected', message: '执行器启动失败。' };
    }
    const event = note.params?.event;
    if (event?.type === 'assistant/message') {
      const read = readAssistantPayload(event.data);
      tools = tools || read.tools;
      const next = mergeAssistantText(text, read.text);
      if (next.delta.length > 0) {
        text = next.text;
        yield { type: 'delta', text: next.delta, simulated: false };
      }
    }
    if (event?.type === 'turn/end') {
      const kind = event.data?.reason?.kind;
      if (kind === 'aborted' || state.stopping) {
        await rpc.exited;
        return { kind: 'cancelled' };
      }
      if (kind === 'error') {
        return { kind: 'failed', fault: 'model-error', message: '模型调用失败。' };
      }
      if (tools && text.trim().length === 0) {
        return {
          kind: 'failed',
          fault: 'tool-failure',
          message: '模型只返回了工具调用，没有可展示的正文。',
        };
      }
      if (text.trim().length === 0) {
        return { kind: 'failed', fault: 'model-error', message: '模型没有返回正文。' };
      }
      return { kind: 'completed', text: text.trim() };
    }
  }
  await rpc.exited;
  return state.stopping
    ? { kind: 'cancelled' }
    : { kind: 'failed', fault: 'executor-disconnected', message: '执行器启动失败。' };
}

function mergeAssistantText(seen: string, incoming: string): { text: string; delta: string } {
  if (incoming.length === 0) return { text: seen, delta: '' };
  if (incoming.startsWith(seen)) return { text: incoming, delta: incoming.slice(seen.length) };
  if (seen.endsWith(incoming) || seen.includes(incoming)) return { text: seen, delta: '' };
  return { text: seen + incoming, delta: incoming };
}

function readAssistantPayload(data: SessionEvent['data']): { text: string; tools: boolean } {
  const content = readBlocks(data?.message?.content);
  if (content.text.length > 0 || content.tools) return content;
  return { text: textFromStream(data?.stream), tools: false };
}

function readBlocks(content: unknown): { text: string; tools: boolean } {
  if (!Array.isArray(content)) return { text: '', tools: false };
  let text = '';
  let tools = false;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if ('type' in block && block.type === 'tool-call') tools = true;
    if (
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      text += block.text;
    }
  }
  return { text, tools };
}

function textFromStream(stream: unknown): string {
  if (!Array.isArray(stream)) return '';
  let pieces = '';
  let block = '';
  for (const item of stream) {
    if (item === null || typeof item !== 'object') continue;
    if ('texts' in item && Array.isArray(item.texts)) {
      for (const piece of item.texts) {
        if (typeof piece === 'string') pieces += piece;
      }
    }
    const chunk = 'chunk' in item ? item.chunk : undefined;
    if (
      chunk !== null &&
      typeof chunk === 'object' &&
      'text' in chunk &&
      typeof chunk.text === 'string'
    ) {
      block = chunk.text;
    }
  }
  return pieces.length > 0 ? pieces : block;
}

/** 子进程已经退出后，孙进程仍占着标准错误时最多再等多久。 */
const stderrSealMs = 500;
/** 受理后写入会话的标准错误上限，按 UTF-8 字节计。超出后保留开头和最新结尾，中间写明省略了多少字节。 */
const stderrCollectLimit = 8192;
const stderrHeadLimit = 2048;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 不超过 maxBytes 的最长完整码点前缀。不切开代理对。 */
function takeUtf8Prefix(text: string, maxBytes: number): { taken: string; rest: string } {
  if (maxBytes <= 0 || text.length === 0) return { taken: '', rest: text };
  if (utf8Bytes(text) <= maxBytes) return { taken: text, rest: '' };
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return { taken: text.slice(0, end), rest: text.slice(end) };
}

/** 丢掉开头的完整码点，直到剩余字节数不超过 maxBytes。返回实际丢掉的字节数。 */
function limitUtf8Suffix(text: string, maxBytes: number): { dropped: number; rest: string } {
  const size = utf8Bytes(text);
  if (size <= maxBytes) return { dropped: 0, rest: text };
  const overflow = size - Math.max(0, maxBytes);
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += utf8Bytes(char);
    end += char.length;
    if (bytes >= overflow) break;
  }
  return { dropped: bytes, rest: text.slice(end) };
}

class StdioRpc {
  readonly exited: Promise<number>;
  closed = false;
  stderr = '';
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly notes: RpcMessage[] = [];
  private readonly noise: string[] = [];
  private noteWait: (() => void) | null = null;
  private readonly finish: (code: number) => void;
  private readonly redactor: StderrRedactor;
  private stderrFlushed = false;
  private stderrTruncated = false;
  private stderrHead = '';
  private stderrHeadClosed = false;
  private stderrTail = '';
  private stderrOmitted = 0;
  private stderrTimer: ReturnType<typeof setTimeout> | null = null;
  private stdioReleased = false;
  private readonly stderrDone: Promise<void>;
  private readonly markStderr: () => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    secret: string,
  ) {
    this.redactor = new StderrRedactor(secret);
    let finish = (_code: number) => {};
    this.finish = (code) => finish(code);
    this.exited = new Promise((resolve) => {
      finish = resolve;
    });
    let markStderr = () => {};
    this.stderrDone = new Promise((resolve) => {
      markStderr = resolve;
    });
    this.markStderr = () => markStderr();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => {
      // 子进程已经退出时，写入会得到 EPIPE。运行失败由退出路径处理，不能打垮工作台。
    });
    child.stdout.on('data', (chunk: string) => this.push(chunk));
    child.stderr.on('data', (chunk: string) => {
      if (this.stderrFlushed) return;
      // 先替换完整密钥，再按头尾切开。窗口切在密钥中间时，后半段不会留下来。
      this.appendStderr(this.redactor.push(chunk));
    });
    child.stderr.on('close', () => this.flushStderr());
    const close = (code: number) => {
      if (this.closed) return;
      this.closed = true;
      this.finish(code);
      for (const waiter of this.pending.values()) waiter.reject(new Error('closed'));
      this.pending.clear();
      this.noteWait?.();
      this.armStderrDeadline();
    };
    child.on('exit', (code) => close(code ?? 1));
    child.on('error', () => close(1));
  }

  /** 标准错误管道关闭并冲洗残留后才可以拿出去或写入磁盘。子进程退出后最多再等 stderrSealMs。到点后标准输出和标准错误一并销毁，避免孙进程占着管道。 */
  sealStderr(): Promise<void> {
    return this.stderrDone.then(() => {
      this.releaseStdio();
    });
  }

  /** 孙进程继承的管道不会随子进程退出而关闭。销毁后本进程不再占着这些文件描述符。 */
  private releaseStdio(): void {
    if (this.stdioReleased) return;
    this.stdioReleased = true;
    for (const stream of [this.child.stdout, this.child.stderr, this.child.stdin]) {
      stream.on('error', () => {});
      const unref = (stream as { unref?: () => void }).unref;
      unref?.call(stream);
      stream.destroy();
    }
  }

  private armStderrDeadline(): void {
    if (this.stderrFlushed || this.stderrTimer !== null) return;
    this.stderrTimer = setTimeout(() => this.abandonStderr(), stderrSealMs);
    this.stderrTimer.unref();
  }

  private flushStderr(): void {
    if (this.stderrTimer !== null) {
      clearTimeout(this.stderrTimer);
      this.stderrTimer = null;
    }
    if (this.stderrFlushed) return;
    this.stderrFlushed = true;
    this.appendStderr(this.redactor.flush());
    this.markStderr();
  }

  private appendStderr(text: string): void {
    if (text.length === 0) return;
    if (!this.stderrTruncated) {
      if (utf8Bytes(this.stderr) + utf8Bytes(text) <= stderrCollectLimit) {
        this.stderr += text;
        return;
      }
      const already = this.stderr;
      this.stderr = '';
      this.stderrTruncated = true;
      this.stderrHead = '';
      this.stderrTail = '';
      this.stderrOmitted = 0;
      this.keepBounded(already);
      this.keepBounded(text);
      this.publishCollectedStderr();
      return;
    }
    this.keepBounded(text);
    this.publishCollectedStderr();
  }

  /**
   * 开头按字节留到放不下下一个码点为止，然后封口。
   * 封口之后的写入只进尾部，不再补进开头剩下的字节。切口落在完整码点上。
   */
  private keepBounded(text: string): void {
    if (text.length === 0) return;
    if (!this.stderrHeadClosed) {
      const room = stderrHeadLimit - utf8Bytes(this.stderrHead);
      if (room > 0) {
        const { taken, rest } = takeUtf8Prefix(text, room);
        this.stderrHead += taken;
        if (rest.length === 0) return;
        this.stderrHeadClosed = true;
        this.pushTail(rest);
        return;
      }
      this.stderrHeadClosed = true;
    }
    this.pushTail(text);
  }

  private pushTail(text: string): void {
    const cap = stderrCollectLimit - stderrHeadLimit;
    if (utf8Bytes(text) >= cap) {
      this.stderrOmitted += utf8Bytes(this.stderrTail) + utf8Bytes(text);
      const fitted = limitUtf8Suffix(text, cap);
      this.stderrOmitted -= utf8Bytes(fitted.rest);
      this.stderrTail = fitted.rest;
      return;
    }
    const combined = this.stderrTail + text;
    if (utf8Bytes(combined) <= cap) {
      this.stderrTail = combined;
      return;
    }
    const fitted = limitUtf8Suffix(combined, cap);
    this.stderrOmitted += fitted.dropped;
    this.stderrTail = fitted.rest;
  }

  private publishCollectedStderr(): void {
    let omitted = this.stderrOmitted;
    let tail = this.stderrTail;
    let mark = `（已截断 ${omitted} 字节）`;
    while (utf8Bytes(this.stderrHead) + utf8Bytes(mark) + utf8Bytes(tail) > stderrCollectLimit) {
      const budget = stderrCollectLimit - utf8Bytes(this.stderrHead) - utf8Bytes(mark);
      const fitted = limitUtf8Suffix(tail, Math.max(0, budget));
      if (fitted.dropped <= 0) break;
      omitted += fitted.dropped;
      tail = fitted.rest;
      mark = `（已截断 ${omitted} 字节）`;
    }
    this.stderr = `${this.stderrHead}${mark}${tail}`;
  }

  /** 到点仍没关上：按收尾规则处理未凑齐的前缀，不再读后续字节。 */
  private abandonStderr(): void {
    this.stderrTimer = null;
    if (this.stderrFlushed) return;
    this.flushStderr();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('closed'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('closed'));
      }
    });
  }

  nextNote(timeoutMs: number): Promise<RpcMessage | 'timeout' | 'closed'> {
    const queued = this.notes.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve('closed');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.noteWait = null;
        resolve('timeout');
      }, timeoutMs);
      this.noteWait = () => {
        clearTimeout(timer);
        this.noteWait = null;
        const note = this.notes.shift();
        resolve(note ?? (this.closed ? 'closed' : 'timeout'));
      };
    });
  }

  drainNoise(): string[] {
    return this.noise.splice(0, this.noise.length);
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.take(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private take(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.noise.push(line);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error('rpc'));
      else waiter?.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      this.notes.push(message);
      this.noteWait?.();
    }
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams, rpc: StdioRpc): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // 进程已经退出。
  }
  await rpc.exited;
}

/** 启动前失败要把原因留下来，但不能带出本机路径。 */
function startupFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = stripLocalPaths(raw)
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (detail.length === 0) return '执行器启动失败。';
  return `执行器启动失败。\n${detail}`;
}

/**
 * 引号里的路径整段去掉。
 * 不带引号的绝对路径可以从行首、空白、冒号、括号或 file:// 后面开始。
 * 段里可以有空格、括号和非 ASCII。空格只有在后面紧接着的分隔符不是另起一条路径时才算在路径里。
 * 最后一段可以带一个空格和文件名。路径结束后的说明，以及 http 网址，都留下。
 */
function stripLocalPaths(text: string): string {
  const quoted = /(?:[/\\]|[A-Za-z]:[/\\])[^'"]*/;
  return stripUnquotedLocalPaths(
    text
      .replace(new RegExp(`'${quoted.source}'`, 'g'), "''")
      .replace(new RegExp(`"${quoted.source}"`, 'g'), '""'),
  );
}

function stripUnquotedLocalPaths(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const start = findLocalPathStart(text, index);
    if (start < 0) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, start);
    index = localPathEnd(text, start);
  }
  return result;
}

function findLocalPathStart(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const previous = index === 0 ? '' : text[index - 1];
    if (previous !== undefined && /[\w.]/.test(previous)) continue;
    const char = text[index];
    if (
      (char === '/' || char === '\\') &&
      schemeSlashRun(text, index) !== 2 &&
      localPathEnd(text, index) > index
    ) {
      return index;
    }
    if (
      char !== undefined &&
      /[A-Za-z]/.test(char) &&
      text[index + 1] === ':' &&
      (text[index + 2] === '/' || text[index + 2] === '\\') &&
      localPathEnd(text, index) > index
    ) {
      return index;
    }
  }
  return -1;
}

function localPathEnd(text: string, start: number): number {
  let index = start;
  const drive = text[index];
  if (
    drive !== undefined &&
    /[A-Za-z]/.test(drive) &&
    text[index + 1] === ':' &&
    (text[index + 2] === '/' || text[index + 2] === '\\')
  ) {
    index += 2;
  }
  if (text[index] !== '/' && text[index] !== '\\') return start;
  if (text[index + 1] === '/' || text[index + 1] === '\\') return start;
  let lastGood = start;
  let cursor = index + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\n' || char === "'" || char === '"') break;
    if (char === '/' || char === '\\') {
      cursor += 1;
      lastGood = cursor;
      continue;
    }
    if (char === ':') break;
    if (char !== undefined && /\s/.test(char)) {
      const glued = gluedSeparator(text, cursor);
      if (glued >= 0) {
        cursor = glued;
        continue;
      }
      const tail = trailingFilenameEnd(text, cursor);
      if (tail > cursor) lastGood = tail;
      break;
    }
    cursor += 1;
    lastGood = cursor;
  }
  if (lastGood <= index) return start;
  return trimWrappingParen(text, start, lastGood);
}

/** `//` 是网址分隔，不当成路径；`file:///` 的第三道斜杠才开始本地路径。 */
function schemeSlashRun(text: string, index: number): number {
  if (text[index] !== '/' && text[index] !== '\\') return 0;
  if (index > 0 && text[index - 1] !== '/' && text[index - 1] !== '\\') return 1;
  let run = 1;
  let back = index;
  while (back > 0 && (text[back - 1] === '/' || text[back - 1] === '\\')) {
    run += 1;
    back -= 1;
  }
  return run;
}

/** 空格后面的分隔符贴着文件名时，这一段还在同一条路径里。前面是空格的分隔符是下一条路径。 */
function gluedSeparator(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n' || char === "'" || char === '"') return -1;
    if (char !== '/' && char !== '\\') continue;
    const previous = text[index - 1];
    if (previous !== undefined && !/\s/.test(previous)) return index;
    return -1;
  }
  return -1;
}

/** 最后一段可以是「名字 名字」。说明词和错误码留在路径外面。 */
function trailingFilenameEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length && text[index] !== '\n' && /\s/.test(text[index] ?? '')) index += 1;
  const start = index;
  while (
    index < text.length &&
    text[index] !== '\n' &&
    text[index] !== '/' &&
    text[index] !== '\\' &&
    text[index] !== ':' &&
    text[index] !== "'" &&
    text[index] !== '"' &&
    !/\s/.test(text[index] ?? '')
  ) {
    index += 1;
  }
  if (index === start) return -1;
  let rest = index;
  while (rest < text.length && text[rest] !== '\n' && /\s/.test(text[rest] ?? '')) rest += 1;
  if (rest !== text.length && text[rest] !== '\n' && text[rest] !== "'" && text[rest] !== '"') {
    return -1;
  }
  const token = text.slice(start, index);
  if (/^[a-z]+$/.test(token) || /^[A-Z][A-Z0-9_]*$/.test(token)) return -1;
  return index;
}

function trimWrappingParen(text: string, start: number, end: number): number {
  if (start === 0 || text[start - 1] !== '(') return end;
  let depth = 1;
  for (let index = start; index < end; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return end;
}

/** 启动前失败附带的标准错误上限，按 UTF-8 字节计。超出后保留开头和最新结尾。 */
const failureStderrLimit = 2000;
const failureStderrHead = 512;

function withStderr(message: string, stderr: string): string {
  const extra = stderr.trim();
  if (extra.length === 0) return message;
  return `${message}\n${boundFailureStderr(extra)}`;
}

function boundFailureStderr(extra: string): string {
  if (utf8Bytes(extra) <= failureStderrLimit) return extra;
  const { taken, rest } = takeUtf8Prefix(extra, failureStderrHead);
  let tail = limitUtf8Suffix(rest, failureStderrLimit - utf8Bytes(taken)).rest;
  let mark = failureOmissionMark(extra, taken, tail);
  while (utf8Bytes(taken) + utf8Bytes(mark) + utf8Bytes(tail) > failureStderrLimit) {
    const budget = failureStderrLimit - utf8Bytes(taken) - utf8Bytes(mark);
    const next = limitUtf8Suffix(tail, Math.max(0, budget));
    if (next.dropped <= 0 || next.rest === tail) break;
    tail = next.rest;
    mark = failureOmissionMark(extra, taken, tail);
  }
  return `${taken}${mark}${tail}`;
}

function failureOmissionMark(extra: string, head: string, tail: string): string {
  const omitted = utf8Bytes(extra) - utf8Bytes(head) - utf8Bytes(tail);
  return `（已截断 ${omitted} 字节）`;
}

function canExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function writeRunHome(
  home: string,
  input: {
    readonly skills: readonly SkillGrant[];
    readonly mcp: readonly McpGrant[];
    readonly toolAllowlist: readonly string[];
    readonly modelId: string;
    readonly baseUrl: string;
  },
  env: NodeJS.ProcessEnv,
): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const granted = path.join(home, 'granted-skills');
  convergeGrantedSkills(granted, input.skills);
  writePrivate(
    path.join(home, 'zhuma-grant.json'),
    JSON.stringify({
      skills: input.skills.map((skill) => ({ id: skill.id, version: skill.version })),
      mcp: input.mcp.map((item) => ({ id: item.id, version: item.version })),
      toolAllowlist: input.toolAllowlist,
    }),
  );
  writePrivate(path.join(home, 'cordis.patch.yml'), renderPatch(home, input, env));
  restrictTree(home);
}

function convergeGrantedSkills(granted: string, skills: readonly SkillGrant[]): void {
  mkdirSync(granted, { recursive: true, mode: 0o700 });
  chmodSync(granted, 0o700);
  const keep = new Set<string>();
  for (const skill of skills) {
    if (skill.id === 'skill-office') continue;
    keep.add(sanitizeId(skill.id));
  }
  for (const entry of readdirSync(granted, { withFileTypes: true })) {
    const realDirectory = entry.isDirectory() && !entry.isSymbolicLink();
    if (!realDirectory && !entry.isSymbolicLink()) continue;
    if (realDirectory && keep.has(entry.name)) continue;
    rmSync(path.join(granted, entry.name), { recursive: true, force: true });
  }
  for (const skill of skills) {
    if (skill.id === 'skill-office') continue;
    const dir = path.join(granted, sanitizeId(skill.id));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writePrivate(path.join(dir, 'SKILL.md'), skillDocument(skill));
  }
}

function skillDocument(skill: SkillGrant): string {
  const name = kebab(skill.id);
  const plain = oneLine(skill.description ?? skill.label ?? name);
  const body = (skill.body ?? skill.label ?? plain).trim();
  return `---\nname: ${name}\ndescription: ${yamlQuote(plain)}\n---\n\n${body}\n\n版本：${skill.version}\n`;
}

function renderPatch(
  home: string,
  input: {
    readonly skills: readonly SkillGrant[];
    readonly mcp: readonly McpGrant[];
    readonly toolAllowlist: readonly string[];
    readonly modelId: string;
    readonly baseUrl: string;
  },
  env: NodeJS.ProcessEnv,
): string {
  const allow = new Set(input.toolAllowlist);
  const lines = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      zhuma:',
    '        api: openai-completions',
    '        apiKeyEnv: ZHUMA_MODEL_API_KEY',
    `        baseURL: ${yamlQuote(input.baseUrl)}`,
    '        models:',
    `          - id: ${yamlQuote(input.modelId)}`,
    '            input:',
    '              - text',
    '              - image',
    '- id: skill-filesystem',
    '  config:',
    '    includeDefaultRoots: false',
    '    customSkillDirs:',
    `      - ${yamlQuote(path.join(home, 'granted-skills'))}`,
    '- id: skill-office',
    `  disabled: ${
      input.skills.some((skill) => skill.id === 'skill-office') && officeSkillsReady(env)
        ? 'false'
        : 'true'
    }`,
  ];
  for (const group of TOOL_GROUPS) {
    const enabled =
      group.ids.some((id) => allow.has(id)) || group.names.some((name) => allow.has(name));
    for (const id of group.ids) {
      lines.push(`- id: ${id}`, `  disabled: ${enabled ? 'false' : 'true'}`);
    }
  }
  const ready = input.mcp.filter(mcpReady);
  if (ready.length > 0) {
    lines.push('- insert:');
    for (const item of ready) {
      const serverName = sanitizeId(item.id).slice(0, 32);
      lines.push(
        `  - id: mcp-${serverName}`,
        '    name: "@deepseek-ai/dsh-mcp-client"',
        '    config:',
        `      serverName: ${yamlQuote(serverName)}`,
        `      transport: ${item.transport}`,
      );
      if (item.transport === 'stdio' && item.command !== undefined) {
        lines.push(`      command: ${yamlQuote(item.command)}`);
        if (item.args !== undefined && item.args.length > 0) {
          lines.push('      args:');
          for (const arg of item.args) lines.push(`        - ${yamlQuote(arg)}`);
        }
      }
      if (item.transport === 'streamable-http' && item.url !== undefined) {
        lines.push(`      url: ${yamlQuote(item.url)}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function mcpReady(item: McpGrant): boolean {
  return mcpTransportReady(item);
}

function unsupportedAttachment(request: AgentRunRequest): string | null {
  for (const item of request.attachments ?? []) {
    const reason = attachmentRefusalReason(item.name ?? item.id, item.mediaType);
    if (reason !== null) return reason;
  }
  return null;
}

function writePrivate(file: string, text: string): void {
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
}

function restrictTree(root: string): void {
  if (!existsSync(root)) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) restrictTree(full);
    else if (entry.isFile()) chmodSync(full, 0o600);
  }
}

function readIndex(root: string): SessionIndex {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, 'index.json'), 'utf8')) as SessionIndex;
    if (parsed === null || typeof parsed !== 'object' || parsed.sessions === null) {
      return { sessions: {} };
    }
    return { sessions: { ...parsed.sessions } };
  } catch {
    return { sessions: {} };
  }
}

function writeIndex(root: string, index: SessionIndex): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  writePrivate(path.join(root, 'index.json'), JSON.stringify(index));
}

function sanitizeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned : 'session';
}

function kebab(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'skill';
}

function oneLine(value: string): string {
  const cleaned = value.replace(/[\r\n]+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : 'skill';
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function redact(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * 完整密钥换成 [redacted]。
 * 还没写完的前缀先留着，下一块能接上就继续匹配。
 * 流中间一旦确认不是完整密钥，以及收尾时还剩下的前缀，长度达到 4 就替换。
 * 不足 4 的前缀原样留下。
 */
class StderrRedactor {
  private pending = '';

  constructor(private readonly secret: string) {}

  push(chunk: string): string {
    const raw = this.pending + chunk;
    this.pending = '';
    return this.scan(raw, false);
  }

  flush(): string {
    const raw = this.pending;
    this.pending = '';
    return this.scan(raw, true);
  }

  private scan(raw: string, ending: boolean): string {
    if (this.secret.length === 0 || raw.length === 0) return raw;
    let out = '';
    let index = 0;
    while (index < raw.length) {
      if (raw.startsWith(this.secret, index)) {
        out += '[redacted]';
        index += this.secret.length;
        continue;
      }
      let matched = 0;
      const limit = Math.min(this.secret.length - 1, raw.length - index);
      while (matched < limit && raw[index + matched] === this.secret[matched]) matched += 1;
      if (matched === 0) {
        out += raw[index];
        index += 1;
        continue;
      }
      const atEnd = index + matched === raw.length;
      if (atEnd && !ending) {
        this.pending = raw.slice(index);
        return out;
      }
      if (ending && matched >= 4) {
        out += '[redacted]';
        index += matched;
        continue;
      }
      if (!atEnd && matched >= 4) {
        out += '[redacted]';
        index += matched;
        continue;
      }
      out += raw.slice(index, index + matched);
      index += matched;
    }
    return out;
  }
}
