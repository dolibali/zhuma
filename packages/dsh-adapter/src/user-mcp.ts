import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpOption, McpSelection } from '@zhuma/agent-core';
import {
  appendMcpCall,
  createMcpCallLog,
  readMcpCalls,
  type McpCallLog,
  type McpCallRecord,
} from '@zhuma/context';

const CALL_TIMEOUT_MS = 8_000;
const SUMMARY_LIMIT = 240;

/**
 * 用户 MCP 的最小调用路径。
 * 连接只使用 McpOption 上已有的 stdio 或 streamable-http。
 * 勾选服务器不会授权工具；只有 toolsAuthorized 与 explicitToolGrant 同时为真才允许按名称调用。
 * 调用记录追加到 context。这里不向 DSH 内置工具表注册工具。
 */

export interface UserMcpToolInfo {
  readonly name: string;
  readonly description?: string;
}

export type UserMcpFailureCode =
  | 'mcp-empty'
  | 'mcp-unavailable'
  | 'mcp-transport'
  | 'mcp-not-authorized'
  | 'mcp-tool-unknown'
  | 'mcp-call-failed';

export interface UserMcpCall {
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export type UserMcpCallResult =
  | {
      readonly ok: true;
      readonly serverId: string;
      readonly toolName: string;
      readonly text: string;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly code: UserMcpFailureCode;
      readonly message: string;
      readonly serverId: string;
      readonly toolName: string;
      readonly durationMs: number;
    };

export type UserMcpOpenResult =
  | { readonly ok: true; readonly session: UserMcpSession }
  | {
      readonly ok: false;
      readonly code: 'mcp-empty' | 'mcp-unavailable' | 'mcp-transport';
      readonly message: string;
      readonly log: McpCallLog;
    };

export type UserMcpInvokeResult =
  | {
      readonly ok: true;
      readonly tools: readonly UserMcpToolInfo[];
      readonly results: readonly UserMcpCallResult[];
      readonly log: McpCallLog;
    }
  | {
      readonly ok: false;
      readonly code: 'mcp-empty' | 'mcp-unavailable' | 'mcp-transport';
      readonly message: string;
      readonly log: McpCallLog;
    };

export interface UserMcpSession {
  readonly serverId: string;
  readonly tools: readonly UserMcpToolInfo[];
  readonly log: McpCallLog;
  call(toolName: string, args?: Readonly<Record<string, unknown>>): Promise<UserMcpCallResult>;
  close(): Promise<void>;
}

/** 显式工具授权。勾选 MCP 本身返回 false，也不会因此放行全部工具。 */
export function userMcpExplicitGrant(selection: McpSelection): boolean {
  return selection.available && selection.toolsAuthorized && selection.explicitToolGrant;
}

export async function openUserMcp(input: {
  readonly option: McpOption;
  readonly selection: McpSelection;
  readonly log?: McpCallLog;
}): Promise<UserMcpOpenResult> {
  const log = input.log ?? createMcpCallLog();
  const rejected = rejectClosed(input.option, input.selection);
  if (rejected) return { ...rejected, log };
  let client: Client | undefined;
  try {
    client = await connectClient(input.option);
    const listed = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    const tools = Object.freeze(
      listed.tools.map((tool) => {
        const info: UserMcpToolInfo = { name: tool.name };
        return tool.description === undefined ? info : { ...info, description: tool.description };
      }),
    );
    return {
      ok: true,
      session: new LiveUserMcpSession(client, input.option.id, input.selection, tools, log),
    };
  } catch (error) {
    await client?.close().catch(() => undefined);
    return { ok: false, code: 'mcp-transport', message: errorText(error), log };
  }
}

/** Skill 或 Agent 节点按名称调用已授权工具。空连接不会记成成功。 */
export async function invokeUserMcpTools(input: {
  readonly option: McpOption;
  readonly selection: McpSelection;
  readonly calls: readonly UserMcpCall[];
  readonly log?: McpCallLog;
}): Promise<UserMcpInvokeResult> {
  const opened = await openUserMcp(input);
  if (!opened.ok) return opened;
  const results: UserMcpCallResult[] = [];
  try {
    for (const call of input.calls) {
      results.push(await opened.session.call(call.toolName, call.args ?? {}));
    }
    return {
      ok: true,
      tools: opened.session.tools,
      results: Object.freeze(results),
      log: opened.session.log,
    };
  } finally {
    await opened.session.close();
  }
}

export function readUserMcpCalls(
  log: McpCallLog,
  serverId?: string,
): ReturnType<typeof readMcpCalls> {
  return serverId === undefined ? readMcpCalls(log) : readMcpCalls(log, { serverId });
}

class LiveUserMcpSession implements UserMcpSession {
  private current: McpCallLog;
  private closed = false;

  constructor(
    private readonly client: Client,
    readonly serverId: string,
    private readonly selection: McpSelection,
    readonly tools: readonly UserMcpToolInfo[],
    log: McpCallLog,
  ) {
    this.current = log;
  }

  get log(): McpCallLog {
    return this.current;
  }

  async call(
    toolName: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<UserMcpCallResult> {
    const started = performance.now();
    const finish = (
      outcome: McpCallRecord['outcome'],
      extra: { text?: string; code?: UserMcpFailureCode; message?: string },
    ): UserMcpCallResult => {
      const durationMs = elapsed(started);
      if (toolName.trim().length === 0) {
        return {
          ok: false,
          code: 'mcp-tool-unknown',
          message: '工具名为空',
          serverId: this.serverId,
          toolName,
          durationMs,
        };
      }
      const record: McpCallRecord = {
        serverId: this.serverId,
        toolName,
        argsSummary: summarizeArgs(args),
        outcome,
        durationMs,
        ...(extra.code !== undefined ? { errorCode: extra.code } : {}),
      };
      this.current = appendMcpCall(this.current, record);
      if (outcome === 'ok') {
        return {
          ok: true,
          serverId: this.serverId,
          toolName,
          text: extra.text ?? '',
          durationMs,
        };
      }
      return {
        ok: false,
        code: extra.code ?? 'mcp-call-failed',
        message: extra.message ?? '工具调用失败',
        serverId: this.serverId,
        toolName,
        durationMs,
      };
    };
    if (this.closed) {
      return finish('fail', { code: 'mcp-transport', message: 'MCP 连接已关闭' });
    }
    if (!userMcpExplicitGrant(this.selection)) {
      return finish('fail', {
        code: 'mcp-not-authorized',
        message: '选择 MCP 不会授权工具，需要单独的显式授权',
      });
    }
    if (!this.tools.some((tool) => tool.name === toolName)) {
      return finish('fail', { code: 'mcp-tool-unknown', message: `服务器没有工具 ${toolName}` });
    }
    try {
      const result = await this.client.callTool(
        { name: toolName, arguments: { ...args } },
        { timeout: CALL_TIMEOUT_MS },
      );
      const body = toolBody(result);
      if (body.isError) {
        return finish('fail', {
          code: 'mcp-call-failed',
          message: body.text.length > 0 ? body.text : '工具返回失败',
        });
      }
      return finish('ok', { text: body.text });
    } catch (error) {
      return finish('fail', { code: 'mcp-call-failed', message: errorText(error) });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }
}

function rejectClosed(
  option: McpOption,
  selection: McpSelection,
): { ok: false; code: 'mcp-empty' | 'mcp-unavailable'; message: string } | null {
  if (option.id.trim().length === 0 || option.version.trim().length === 0) {
    return { ok: false, code: 'mcp-empty', message: 'MCP 连接缺少标识或版本' };
  }
  if (!option.available) {
    return {
      ok: false,
      code: 'mcp-unavailable',
      message: option.unavailableReason?.trim() || 'MCP 不可用',
    };
  }
  if (option.transport === undefined) {
    return { ok: false, code: 'mcp-empty', message: '没有配置传输，不会连接外部服务' };
  }
  if (option.transport === 'stdio' && (option.command ?? '').trim().length === 0) {
    return { ok: false, code: 'mcp-empty', message: 'stdio 连接缺少命令，不会当作已连接' };
  }
  if (option.transport === 'streamable-http' && !httpUrl(option.url)) {
    return { ok: false, code: 'mcp-empty', message: 'HTTP 连接缺少可用地址，不会当作已连接' };
  }
  if (selection.id !== option.id || selection.version !== option.version) {
    return { ok: false, code: 'mcp-unavailable', message: 'MCP 选择与连接不一致' };
  }
  if (!selection.available) {
    return {
      ok: false,
      code: 'mcp-unavailable',
      message: selection.unavailableReason?.trim() || 'MCP 选择不可用',
    };
  }
  return null;
}

function httpUrl(value: string | undefined): boolean {
  const raw = value?.trim() ?? '';
  if (raw.length === 0) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function connectClient(option: McpOption): Promise<Client> {
  const client = new Client({ name: 'zhuma-user-mcp', version: '1.2.0' });
  if (option.transport === 'stdio') {
    await client.connect(
      new StdioClientTransport({
        command: (option.command ?? '').trim(),
        args: [...(option.args ?? [])],
        stderr: 'pipe',
      }),
      { timeout: CALL_TIMEOUT_MS },
    );
    return client;
  }
  await client.connect(new StreamableHTTPClientTransport(new URL((option.url ?? '').trim())), {
    timeout: CALL_TIMEOUT_MS,
  });
  return client;
}

function toolBody(result: unknown): { isError: boolean; text: string } {
  if (result === null || typeof result !== 'object') return { isError: false, text: '' };
  const record = result as { isError?: unknown; content?: unknown };
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((block) => {
      if (block !== null && typeof block === 'object' && 'text' in block) {
        const value = block.text;
        return typeof value === 'string' ? value : '';
      }
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
  return { isError: record.isError === true, text };
}

function summarizeArgs(args: Readonly<Record<string, unknown>>): string {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    redacted[key] = /key|token|secret|password|authorization/i.test(key) ? '[redacted]' : value;
  }
  let text: string;
  try {
    text = JSON.stringify(redacted) ?? '{}';
  } catch {
    text = '[unserializable]';
  }
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT - 3)}...` : flat;
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : 'MCP 连接失败';
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat || 'MCP 连接失败';
}
