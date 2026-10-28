import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveMember } from './member-session.js';

const enabled = new WeakSet<object>();
const productPath = /^\/api\/zhuma-(?:member|exec|knowledge)\/[a-z][a-z-]*$/u;

async function* chunks(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const value = await reader.read();
      if (value.done) return;
      yield value.value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Explicit composition only; ordinary Desktop/owner transports retain their behavior. */
export function enableMemberWeb(ctx: Context): void {
  enabled.add(ctx.root);
  ctx.effect(() => () => enabled.delete(ctx.root));
}

/**
 * Reuse the product's exact handler without admitting a browser as SDK owner.
 * No shared RPC dispatcher, owner Peer, websocket or launch token is exposed.
 * Each handler still validates its member, space, fixed versions and body budget.
 */
export function registerProductFetch(
  ctx: Context,
  route: ConnectionFetchRoute,
): () => Promise<void> {
  if (!enabled.has(ctx.root)) return ctx.connection.fetch.register(route);
  if (!productPath.test(route.path)) throw new Error('Unsupported public product route');
  const lifetime = new AbortController();
  const active = new Set<Promise<void>>();
  let stopWeb: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const stopOwner = ctx.connection.fetch.register(route);
  ctx.inject(['webServer'], (web) => {
    stopWeb = web.webServer.register({
      kind: 'exact',
      path: route.path,
      handler(req, res) {
        const pending = handle(req, res);
        active.add(pending);
        void pending.finally(() => active.delete(pending)).catch(() => undefined);
        return pending;
      },
    });
    web.effect(() => () => stopWeb?.());
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const disconnected = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) disconnected.abort();
    };
    res.on('close', onClose);
    const signal = AbortSignal.any([lifetime.signal, disconnected.signal]);
    try {
      signal.throwIfAborted();
      if (ctx.connection.requestRejection({ headers: req.headers }) === 403) {
        res.writeHead(403, { 'cache-control': 'no-store', connection: 'close' });
        res.end();
        return;
      }
      if (!route.methods.some((method) => method === (req.method ?? 'GET'))) {
        res.writeHead(405, { allow: route.methods.join(', '), connection: 'close' });
        res.end();
        return;
      }
      const member = await resolveMember(ctx, { headers: req.headers });
      signal.throwIfAborted();
      if (!member.ok) {
        res.writeHead(member.status, { 'cache-control': 'no-store', connection: 'close' });
        res.end();
        return;
      }
      const method = req.method ?? 'GET';
      const request = new Request(new URL(req.url ?? route.path, 'http://dsh.internal'), {
        method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
        signal,
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }),
      } as RequestInit & { duplex?: 'half' });
      const response = await route.fetch(request);
      signal.throwIfAborted();
      const unread = !req.readableEnded;
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        'cache-control': 'no-store',
        ...(unread ? { connection: 'close' } : {}),
      });
      if (response.body) {
        await pipeline(Readable.from(chunks(response.body, signal)), res, { signal });
      } else res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(503, { 'cache-control': 'no-store', connection: 'close' });
        res.end();
      } else if (!res.writableEnded) res.destroy();
    } finally {
      res.off('close', onClose);
    }
  }
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      stopWeb?.();
      try {
        await stopOwner();
      } finally {
        await Promise.allSettled(active);
      }
    })());
  ctx.effect(() => close);
  return close;
}
