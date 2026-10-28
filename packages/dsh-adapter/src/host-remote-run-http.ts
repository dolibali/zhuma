import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import {
  REMOTE_RUN_LIMITS,
  REMOTE_RUN_OPERATIONS,
  REMOTE_RUN_PERMIT_HEADER,
  remoteRunRequestSchema,
  type RemoteRunOperation,
} from '@zhuma/agent-core';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExecutionService } from './execution-service.js';
import { resolveMember } from './member-session.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';

/** One compiled map shared with the outgoing local Host; no guessed method URLs. */
export const MEMBER_LOCAL_REMOTE_METHODS = Object.freeze(
  Object.fromEntries(
    REMOTE_RUN_OPERATIONS.map((operation) => [operation, `zhuma-remote-run/${operation}`]),
  ) as Record<RemoteRunOperation, string>,
);

/** Product routes only. Cleanup is the sole exact no-current-cookie exception;
 * D still validates its original persisted scope/device signature/private proof. */
export function openHostRemoteRunHttp(
  ctx: Context,
  current: () => Pick<ExecutionService, 'remoteRun'> | undefined,
) {
  const lifetime = new AbortController();
  const active = new Set<Promise<void>>();
  const disposers = new Set<() => void>();
  let closing: Promise<void> | undefined;
  ctx.inject(['webServer'], (web) => {
    for (const operation of REMOTE_RUN_OPERATIONS) {
      const dispose = web.webServer.register({
        kind: 'exact',
        path: `/api/${MEMBER_LOCAL_REMOTE_METHODS[operation]}`,
        handler(req, res) {
          const pending = handle(operation, req, res);
          active.add(pending);
          void pending.finally(() => active.delete(pending)).catch(() => undefined);
          return pending;
        },
      });
      disposers.add(dispose);
      web.effect(() => () => {
        disposers.delete(dispose);
        dispose();
      });
    }
  });
  async function handle(operation: RemoteRunOperation, req: IncomingMessage, res: ServerResponse) {
    let rpcId = '';
    const disconnected = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) disconnected.abort();
    };
    res.on('close', onClose);
    const signal = AbortSignal.any([lifetime.signal, disconnected.signal]);
    const reply = (result: unknown, status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(req.readableEnded ? {} : { connection: 'close' }),
      });
      res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
    };
    const fail = (code: string, status: number) => reply({ ok: false, error: { code } }, status);
    try {
      signal.throwIfAborted();
      if (ctx.connection.requestRejection({ headers: req.headers }) === 403)
        return fail('remote-forbidden', 403);
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return fail('remote-validation', 405);
      }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json')
        return fail('remote-validation', 415);
      if (operation !== 'cleanup') {
        const member = await resolveMember(ctx, req);
        signal.throwIfAborted();
        if (!member.ok) return fail('remote-unauthenticated', member.status);
      }
      const request = new Request('http://zhuma.internal/', {
        method: 'POST',
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
        body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
        duplex: 'half',
        signal,
      } as RequestInit & { duplex: 'half' });
      const envelope = clientRequestSchema.safeParse(
        await readWorkbenchBody(
          request,
          {
            bodyBytes: REMOTE_RUN_LIMITS.requestBytes,
            bodyTimeoutMs: REMOTE_RUN_LIMITS.httpTimeoutMs,
          },
          signal,
        ),
      );
      if (!envelope.success || envelope.data.method !== MEMBER_LOCAL_REMOTE_METHODS[operation])
        return fail('remote-validation', 400);
      rpcId = envelope.data.rpcId;
      const body = remoteRunRequestSchema.safeParse(envelope.data.payload);
      if (!body.success || body.data.operation !== operation) return fail('remote-validation', 400);
      signal.throwIfAborted();
      const service = current();
      if (!service) return fail('remote-unavailable', 503);
      const permit = req.headers[REMOTE_RUN_PERMIT_HEADER];
      if (permit !== undefined && typeof permit !== 'string') return fail('remote-validation', 400);
      const result = await service.remoteRun(req, body.data, permit);
      // A disconnected/aborted wait cannot undo a durable D operation. No
      // synthetic rollback or success is inferred from transport cancellation.
      signal.throwIfAborted();
      reply(result);
    } catch (error) {
      if (error instanceof WorkbenchBodyError)
        return fail(error.status === 413 ? 'remote-quota' : 'remote-validation', error.status);
      if (!res.headersSent) fail('remote-unavailable', 503);
      else if (!res.writableEnded) res.destroy();
    } finally {
      res.off('close', onClose);
    }
  }
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      for (const dispose of disposers) dispose();
      disposers.clear();
      await Promise.allSettled(active);
    })());
  ctx.effect(() => close);
  return { close };
}
