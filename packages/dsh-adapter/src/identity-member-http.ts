import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { WorkbenchError } from '@zhuma/agent-core';
import type { IdentityMemberLifecycleHandle } from './identity-member-lifecycle.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';

const endpoints = [
  '/zhuma-id/register',
  '/zhuma-id/password',
  '/zhuma-id/teams',
  '/zhuma-id/team-members',
] as const;
const statusFor = (code: string): number => {
  if (code === 'validation') return 400;
  if (code === 'invalid-login' || code === 'unauthenticated') return 401;
  if (code === 'forbidden' || code === 'untrusted-request') return 403;
  if (code === 'not-found') return 404;
  if (code === 'conflict' || code === 'recovery-required') return 409;
  if (code === 'rate-limited' || code === 'quota-exceeded') return 429;
  return 503;
};

/** Public member lifecycle routes use the original identity handle, never SDK owner admission. */
export function openIdentityMemberHttp(
  ctx: Context,
  current: () => IdentityMemberLifecycleHandle | undefined,
) {
  const lifetime = new AbortController();
  const active = new Set<Promise<void>>();
  const stops: (() => void)[] = [];
  let closing: Promise<void> | undefined;
  ctx.inject(['webServer'], (web) => {
    for (const path of endpoints) {
      const stop = web.webServer.register({
        kind: 'exact',
        path,
        handler(req, res) {
          const work = handle(path, req, res);
          active.add(work);
          void work.finally(() => active.delete(work)).catch(() => undefined);
          return work;
        },
      });
      stops.push(stop);
      web.effect(() => stop);
    }
  });
  function send(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
  }
  async function handle(
    path: (typeof endpoints)[number],
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const disconnect = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) disconnect.abort();
    };
    res.on('close', onClose);
    const signal = AbortSignal.any([disconnect.signal, lifetime.signal]);
    try {
      signal.throwIfAborted();
      if (ctx.connection.requestRejection({ headers: req.headers }) === 403)
        throw new WorkbenchError('untrusted-request', '请求未接受。');
      const handle = current();
      if (!handle || handle.signal.aborted)
        throw new WorkbenchError('unavailable', '成员服务未就绪。');
      const url = new URL(req.url ?? path, 'http://dsh.internal');
      const method = req.method ?? 'GET';
      const get =
        method === 'GET' && (path === '/zhuma-id/teams' || path === '/zhuma-id/team-members');
      if (!get && method !== 'POST') {
        send(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      let payload: unknown;
      if (get && path === '/zhuma-id/team-members') {
        if (
          [...url.searchParams.keys()].some((key) => key !== 'spaceId') ||
          url.searchParams.getAll('spaceId').length !== 1
        )
          throw new WorkbenchError('validation', '参数不完整。');
        payload = { spaceId: url.searchParams.get('spaceId') };
      } else {
        if (url.search) throw new WorkbenchError('validation', '参数不完整。');
        if (!get) {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
            send(res, 415, { ok: false, error: 'unsupported-media-type' });
            return;
          }
          const request = new Request(url, {
            method,
            headers: Object.fromEntries(
              Object.entries(req.headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            ),
            body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
            signal,
            duplex: 'half',
          } as RequestInit & { duplex: 'half' });
          payload = await readWorkbenchBody(request, { bodyBytes: 8192, bodyTimeoutMs: 10_000 });
        }
      }
      signal.throwIfAborted();
      // Pass the original request, including its actual socket address for admission budgets.
      const value =
        path === '/zhuma-id/register'
          ? await handle.register(req, payload)
          : path === '/zhuma-id/password'
            ? await handle.changePassword(req, payload)
            : path === '/zhuma-id/teams'
              ? get
                ? await handle.teams(req)
                : await handle.createTeam(req, payload)
              : get
                ? await handle.members(req, payload)
                : await handle.setMember(req, payload);
      // Disconnect ends waiting, not an admitted durable identity operation.
      if (!signal.aborted && !res.destroyed) send(res, 200, { ok: true, value });
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const code =
          error instanceof WorkbenchError
            ? error.code
            : error instanceof WorkbenchBodyError
              ? 'validation'
              : 'unavailable';
        const status = error instanceof WorkbenchBodyError ? error.status : statusFor(code);
        if (!req.readableEnded) res.setHeader('connection', 'close');
        send(res, status, { ok: false, error: code });
      }
    } finally {
      res.off('close', onClose);
    }
  }
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      stops.forEach((stop) => stop());
      await Promise.allSettled(active);
    })());
  ctx.effect(() => close);
  return { close };
}
