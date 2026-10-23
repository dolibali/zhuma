import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { ExecutionDeskSnapshot, ExecutionEngine } from '@zhuma/agent-core';
import { ExecutionDesk } from './execution-desk.js';

export interface WorkbenchServerOptions {
  readonly desk: ExecutionDesk;
  readonly present: (snapshot: ExecutionDeskSnapshot) => unknown;
  readonly publicDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/** 本地演示用的工作区服务。读取事实不会创建运行。 */
export function createWorkbenchServer(options: WorkbenchServerOptions): Server {
  return createServer((request, response) => {
    void handle(options, request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '服务处理失败';
      sendJson(response, 500, {
        ok: false,
        objectLabel: '工作区服务',
        reason: message,
        nextStep: '查看服务日志后重试。这不是运行完成。',
      });
    });
  });
}

async function handle(
  options: WorkbenchServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/api/workspace') {
    sendJson(response, 200, payload(options));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, runs: options.desk.snapshot().runs.length });
    return;
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!originAllowed(request)) {
      sendJson(response, 403, {
        ok: false,
        objectLabel: '来源',
        reason: '跨站请求被拒绝',
        nextStep: '从本机页面操作。',
      });
      return;
    }
    const body = (await readBody(request)) as Record<string, unknown>;
    const result = await dispatch(options.desk, url.pathname, body);
    sendJson(response, result.ok ? 200 : 409, {
      ...result,
      view: options.present(result.snapshot),
    });
    return;
  }
  if (request.method === 'GET' && options.publicDir) {
    serveStatic(options.publicDir, url.pathname, response);
    return;
  }
  sendJson(response, 404, {
    ok: false,
    objectLabel: url.pathname,
    reason: '没有这个路径',
    nextStep: '返回 Agent 处理页',
  });
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  const host = request.headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function payload(options: WorkbenchServerOptions) {
  const snapshot = options.desk.snapshot();
  return { ok: true, snapshot, view: options.present(snapshot) };
}

async function dispatch(desk: ExecutionDesk, pathname: string, body: Record<string, unknown>) {
  if (pathname === '/api/messages') {
    return desk.send({
      text: stringField(body, 'text'),
      idempotencyKey: stringField(body, 'idempotencyKey'),
      intent: intentField(body),
      attachmentIds: stringList(body, 'attachmentIds'),
    });
  }
  if (pathname === '/api/stop') return desk.stop();
  if (pathname === '/api/retry') return desk.retry(stringField(body, 'idempotencyKey'));
  if (pathname === '/api/recovery') {
    const kind = body.kind === 'human-takeover' ? 'human-takeover' : 'reassign';
    return desk.recover(kind);
  }
  if (pathname === '/api/draft') return desk.saveDraft(stringField(body, 'text'));
  if (pathname === '/api/release') {
    desk.releaseActive();
    return { ok: true as const, replayed: false, snapshot: desk.snapshot() };
  }
  if (pathname === '/api/test/drop-entry' && process.env.ZHUMA_TEST_HOOKS === '1') {
    desk.dropRecordedEntry();
    return { ok: true as const, replayed: false, snapshot: desk.snapshot() };
  }
  if (pathname === '/api/resume') return desk.resumeInteraction();
  if (pathname === '/api/persistence/rewrite') return desk.rewritePersistence();
  if (pathname === '/api/config') {
    return desk.updateConfig({
      ...(typeof body.expertId === 'string' ? { expertId: body.expertId } : {}),
      ...(body.executorId === null || typeof body.executorId === 'string'
        ? { executorId: body.executorId as ExecutionEngine | null }
        : {}),
      ...(Array.isArray(body.skillIds) ? { skillIds: stringList(body, 'skillIds') } : {}),
      ...(Array.isArray(body.mcpIds) ? { mcpIds: stringList(body, 'mcpIds') } : {}),
    });
  }
  if (pathname === '/api/availability') {
    return desk.setAvailability({
      ...(typeof body.expertId === 'string' ? { expertId: body.expertId } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.executorId === 'string'
        ? { executorId: body.executorId as ExecutionEngine }
        : {}),
      ...(typeof body.connected === 'boolean' ? { connected: body.connected } : {}),
    });
  }
  if (pathname === '/api/context') {
    return desk.setContextIncluded(stringField(body, 'id'), body.included === true);
  }
  if (pathname === '/api/attachments') {
    return desk.addAttachment({
      name: stringField(body, 'name'),
      mediaType: stringField(body, 'mediaType'),
      ...(typeof body.bytesBase64 === 'string'
        ? { bytesBase64: body.bytesBase64 }
        : { text: stringField(body, 'text') }),
    });
  }
  if (pathname === '/api/attachments/remove') return desk.removeAttachment(stringField(body, 'id'));
  if (pathname === '/api/review-result') {
    return desk.acceptReviewResult(stringField(body, 'roundId'), stringField(body, 'roundStatus'));
  }
  if (pathname === '/api/verify-abandoned') return desk.verifyAbandoned();
  return {
    ok: false as const,
    code: 'not-found',
    objectLabel: pathname,
    reason: '没有这个操作',
    nextStep: '返回 Agent 处理页',
    snapshot: desk.snapshot(),
  };
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function stringList(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function intentField(body: Record<string, unknown>): 'new' | 'supplement' | 'next-turn' {
  if (body.intent === 'next-turn' || body.intent === 'supplement' || body.intent === 'new')
    return body.intent;
  return 'new';
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.byteLength,
    'cache-control': 'no-store',
  });
  response.end(encoded);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1024 * 1024) throw new Error('请求体超过 1 MB');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  return JSON.parse(text) as unknown;
}

function serveStatic(root: string, pathname: string, response: ServerResponse): void {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, `.${requested}`);
  const relative = path.relative(rootResolved, target);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !existsSync(target) ||
    !statSync(target).isFile()
  ) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('未找到页面');
    return;
  }
  const extension = path.extname(target);
  response.writeHead(200, {
    'content-type': MIME[extension] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(response);
}
