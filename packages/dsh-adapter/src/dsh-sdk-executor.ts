import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionFaultKind } from '@zhuma/agent-core';
import {
  ExecutorNotImplementedError,
  readDshModelConfig,
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
}

interface LiveRun {
  child: ChildProcessWithoutNullStreams;
  stopping: boolean;
  accepted: boolean;
  receipt?: (receipt: CancelReceipt) => void;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { event?: { type?: string; reason?: { kind?: string }; content?: unknown } };
  result?: unknown;
  error?: { message?: string };
}

/** `ZHUMA_DSH_BIN`，否则使用上游构建出的 CLI。两者都不存在时返回 null。 */
export function resolveDshBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.ZHUMA_DSH_BIN?.trim() ?? '';
  if (override.length > 0) return existsSync(override) ? override : null;
  return existsSync(builtBinary) ? builtBinary : null;
}

export function missingDshRuntimeReason(): string {
  return '没有找到 DSH 运行时。请运行 pnpm upstream:build-dsh，或设置 ZHUMA_DSH_BIN。还需要 ZHUMA_MODEL_BASE_URL 和 ZHUMA_MODEL_API_KEY。不会改用模拟执行器。';
}

/**
 * 显式选择后启动 `dsh --profile sdk`，经 stdio JSON-RPC 对话。
 * `accepted` 只在 `session/prompt` 返回 messageId 之后发出。
 * 停止没有协议方法：结束子进程，回执来自进程退出或 `turn/end` 的 `aborted`。
 */
export class DshChatExecutor implements AgentExecutor {
  readonly id = 'dsh' as const;
  readonly capabilities: ExecutorCapabilities;
  readonly unavailableReason?: string;
  private readonly configResult: DshModelConfigResult;
  private readonly bin: string | null;
  private readonly mode: string;
  private readonly initTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly onSpawn?: (pid: number) => void;
  private readonly known = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly stopping = new Set<string>();
  private readonly live = new Map<string, LiveRun>();
  private readonly earlyReceipt = new Map<string, (receipt: CancelReceipt) => void>();

  constructor(env: NodeJS.ProcessEnv = process.env, options: DshExecutorOptions = {}) {
    this.configResult = readDshModelConfig(env);
    this.bin = options.bin ?? resolveDshBinary(env);
    this.mode = options.mode ?? 'ok';
    this.initTimeoutMs = options.initTimeoutMs ?? 30_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 30_000;
    if (options.onSpawn !== undefined) this.onSpawn = options.onSpawn;
    const reason = !this.configResult.ok
      ? this.configResult.reason
      : this.bin === null
        ? missingDshRuntimeReason()
        : undefined;
    if (reason !== undefined) this.unavailableReason = reason;
    this.capabilities = Object.freeze({
      liveInjection: false,
      sessionResume: false,
      cancelReceipt: true,
      streaming: true,
      verified: this.configResult.ok && this.bin !== null,
      mode: 'native',
    });
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
    const bin = this.bin;
    const config = this.configResult.config;
    const sessionId = sanitizeId(request.resumeSessionId ?? `zhuma-${request.runId}`);
    const home = path.join(tmpdir(), 'zhuma-dsh-sessions', sessionId);
    const created = !existsSync(path.join(home, 'zhuma-session.jsonl'));
    writeRunHome(home, {
      skills: request.skills ?? [],
      mcp: request.mcp ?? [],
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      mode: this.mode,
    });
    const child = spawn(bin, ['--profile', 'sdk'], {
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv(home, config.apiKey),
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
    const rpc = new StdioRpc(child, (text) => redact(text, config.apiKey));
    let cancelYielded = false;
    let initialized = false;
    try {
      await rpc.request(
        'initialize',
        { cwd: home, provider: 'zhuma', model: config.modelId },
        this.initTimeoutMs,
      );
      initialized = true;
      if (request.resumeSessionId !== undefined) {
        await rpc.request('session/resume', { sessionId }, this.promptTimeoutMs);
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
        yield {
          type: 'failed',
          fault: 'model-error',
          message: '执行器没有返回接收回执。',
          simulated: false,
        };
        return;
      }
      state.accepted = true;
      yield* noiseActivities(request.runId, rpc);
      yield { type: 'accepted', executorRunId: messageId, sessionId, simulated: false };
      const outcome = await readTurn(rpc, state, this.promptTimeoutMs);
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
      yield { type: 'delta', text: outcome.text, simulated: false };
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
      if (state.stopping) {
        await rpc.exited;
        cancelYielded = true;
        yield { type: 'cancelled', simulated: false };
        return;
      }
      const timedOut = error instanceof Error && error.message === 'timeout';
      yield {
        type: 'failed',
        fault: timedOut ? 'network-interruption' : 'executor-disconnected',
        message: timedOut
          ? initialized
            ? state.accepted
              ? '执行器没有在时限内返回结果。'
              : '执行器没有在时限内接收。'
            : '执行器启动超时。'
          : '执行器启动失败。',
        simulated: false,
      };
    } finally {
      if (!rpc.closed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // 进程已经退出。
        }
        await rpc.exited;
      }
      if (existsSync(home)) {
        writeFileSync(path.join(home, 'zhuma-collected-stderr.txt'), rpc.stderr, 'utf8');
      }
      if (!state.accepted && created) rmSync(home, { recursive: true, force: true });
      this.finished.add(request.runId);
      this.live.delete(request.runId);
      state.receipt?.({
        receipt: cancelYielded || state.stopping ? 'cancelled' : 'rejected',
        reason: '运行已经结束。',
      });
    }
  }
}

function childEnv(home: string, apiKey: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    DSH_HOME: home,
    ZHUMA_MODEL_API_KEY: apiKey,
  };
}

function promptBlocks(request: AgentRunRequest): readonly Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    { type: 'text', text: `${request.goal}\n${request.instruction}` },
  ];
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
    } else {
      blocks.push({ type: 'text', text: Buffer.from(item.bytes).toString('utf8') });
    }
  }
  return blocks;
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

async function readTurn(rpc: StdioRpc, state: LiveRun, timeoutMs: number): Promise<TurnOutcome> {
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
      const read = readAssistant(event.content);
      text += read.text;
      tools = tools || read.tools;
    }
    if (event?.type === 'turn/end') {
      const kind = event.reason?.kind;
      if (kind === 'aborted' || state.stopping) {
        await rpc.exited;
        return { kind: 'cancelled' };
      }
      if (kind === 'error')
        return { kind: 'failed', fault: 'model-error', message: '模型调用失败。' };
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

function readAssistant(content: unknown): { text: string; tools: boolean } {
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

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly redactText: (text: string) => string,
  ) {
    let finish = (_code: number) => {};
    this.finish = (code) => finish(code);
    this.exited = new Promise((resolve) => {
      finish = resolve;
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.push(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr += this.redactText(chunk);
    });
    child.on('exit', (code) => {
      this.closed = true;
      this.finish(code ?? 1);
      for (const waiter of this.pending.values()) waiter.reject(new Error('closed'));
      this.pending.clear();
      this.noteWait?.();
    });
    child.on('error', () => {
      this.closed = true;
      this.finish(1);
    });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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

function writeRunHome(
  home: string,
  input: {
    readonly skills: readonly { readonly id: string; readonly version: string }[];
    readonly mcp: readonly { readonly id: string; readonly version: string }[];
    readonly modelId: string;
    readonly baseUrl: string;
    readonly mode: string;
  },
): void {
  mkdirSync(home, { recursive: true });
  const granted = path.join(home, 'granted-skills');
  mkdirSync(granted, { recursive: true });
  for (const skill of input.skills) {
    const dir = path.join(granted, sanitizeId(skill.id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nid: ${skill.id}\nversion: ${skill.version}\n---\n`,
      'utf8',
    );
  }
  writeFileSync(
    path.join(home, 'zhuma-grant.json'),
    JSON.stringify({ skills: input.skills, mcp: input.mcp }),
    'utf8',
  );
  writeFileSync(path.join(home, 'zhuma-mode.json'), JSON.stringify({ mode: input.mode }), 'utf8');
  const servers = input.mcp
    .map((item) => `        - id: ${item.id}\n          version: ${item.version}`)
    .join('\n');
  writeFileSync(
    path.join(home, 'cordis.patch.yml'),
    [
      'plugins:',
      '  - id: skill-office',
      '    name: "@deepseek-ai/dsh-skill-office"',
      '    disabled: true',
      '  - id: skill-filesystem',
      '    name: "@deepseek-ai/dsh-skill-filesystem"',
      '    config:',
      '      includeDefaultRoots: false',
      '      customSkillDirs:',
      '        - granted-skills',
      '  - id: mcp-client',
      '    name: "@deepseek-ai/dsh-mcp-client"',
      '    config:',
      '      servers:',
      servers.length > 0 ? servers : '        []',
      '  - id: llm',
      '    name: "@deepseek-ai/dsh-llm-pi-ai"',
      '    config:',
      '      providers:',
      '        zhuma:',
      '          api: openai-completions',
      '          apiKeyEnv: ZHUMA_MODEL_API_KEY',
      `          baseURL: "${input.baseUrl}"`,
      '          models:',
      `            - id: "${input.modelId}"`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function sanitizeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned : 'session';
}

function redact(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join('[redacted]');
}

export function dshSessionHome(sessionId: string): string {
  return path.join(tmpdir(), 'zhuma-dsh-sessions', sanitizeId(sessionId));
}
