import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import {
  REMOTE_RUN_ERRORS,
  REMOTE_TEAM_ASSET_FILE_PATH,
  REMOTE_TEAM_ASSET_FILE_METHOD,
  REMOTE_RUN_PERMIT_HEADER,
  remoteTeamAssetFileReadRequestSchema,
  canonicalPayload,
  type RemoteRunErrorCode,
} from '@zhuma/agent-core';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExecutionService } from './execution-service.js';
import type { TeamAssetFileService, TeamAssetFileReadHandle } from './team-asset-file-service.js';
import { TeamAssetFileError } from './team-asset-file.js';
import { resolveMember } from './member-session.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';

export interface TeamAssetRunFileHttpSources {
  readonly execution: Pick<ExecutionService, 'openRemoteTeamAssetFile'>;
  readonly files: Pick<TeamAssetFileService, 'openReadTracked'>;
}
type ReadGrant = Awaited<ReturnType<ExecutionService['openRemoteTeamAssetFile']>>;
const sha256 = (value: unknown) =>
  createHash('sha256').update(canonicalPayload(value)).digest('hex');
function errorResponse(error: unknown): { code: RemoteRunErrorCode; status: number } {
  if (error instanceof WorkbenchBodyError)
    return {
      code: error.status === 413 ? 'remote-quota' : 'remote-validation',
      status: error.status,
    };
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && REMOTE_RUN_ERRORS.includes(code as RemoteRunErrorCode))
    return { code: code as RemoteRunErrorCode, status: 200 };
  if (code === 'asset-forbidden' || code === 'asset-reference-denied')
    return { code: 'remote-forbidden', status: 403 };
  if (code === 'asset-not-found') return { code: 'remote-not-found', status: 404 };
  if (error instanceof TeamAssetFileError) {
    if (error.code === 'limit') return { code: 'remote-quota', status: 413 };
    if (error.code === 'digest-mismatch' || error.code === 'invalid')
      return { code: 'remote-input-stale', status: 409 };
  }
  return { code: 'remote-unavailable', status: 503 };
}
/** One Node binary leaf. The original signed Run authority owns permission and
 * budgets; the original file service owns attachment verification/read leases.
 * A supplies both actual owners and disposes this transport before either. */
export function openTeamAssetRunFileHttp(
  ctx: Context,
  current: () => TeamAssetRunFileHttpSources | undefined,
) {
  const lifetime = new AbortController(),
    active = new Set<Promise<void>>(),
    disposers = new Set<() => void>();
  let closing: Promise<void> | undefined,
    cleanupFailed = false;
  ctx.inject(['webServer'], (web) => {
    if (lifetime.signal.aborted) return;
    const dispose = web.webServer.register({
      kind: 'exact',
      path: REMOTE_TEAM_ASSET_FILE_PATH,
      handler(req, res) {
        const pending = handle(req, res);
        active.add(pending);
        void pending.then(
          () => active.delete(pending),
          () => {
            cleanupFailed = true;
            active.delete(pending);
          },
        );
        return pending;
      },
    });
    disposers.add(dispose);
    web.effect(() => () => {
      disposers.delete(dispose);
      dispose();
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    let rpcId = '',
      grant: ReadGrant | undefined,
      file: TeamAssetFileReadHandle | undefined;
    let physical = Promise.resolve();
    const disconnected = new AbortController(),
      deadline = new AbortController(),
      operation = new AbortController();
    const signal = AbortSignal.any([
      lifetime.signal,
      disconnected.signal,
      deadline.signal,
      operation.signal,
    ]);
    const timer = setTimeout(() => deadline.abort(), 60_000);
    let finishOutput!: () => void;
    const output = new Promise<void>((done) => {
      finishOutput = done;
    });
    const onFinish = () => finishOutput();
    const onClose = () => {
      if (!res.writableFinished) disconnected.abort();
      finishOutput();
    };
    const onError = () => {
      disconnected.abort();
    };
    const onAbort = () => {
      if (!res.writableFinished && !res.destroyed) res.destroy();
    };
    const onGrantAbort = () => operation.abort();
    res.once('finish', onFinish);
    res.once('close', onClose);
    res.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
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
    const fail = (code: RemoteRunErrorCode, status: number) =>
      reply({ ok: false, error: { code } }, status);
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
      const member = await resolveMember(ctx, req);
      signal.throwIfAborted();
      if (!member.ok) return fail('remote-unauthenticated', member.status);
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
        await readWorkbenchBody(request, { bodyBytes: 16 * 1024, bodyTimeoutMs: 5000 }, signal),
      );
      if (!envelope.success || envelope.data.method !== REMOTE_TEAM_ASSET_FILE_METHOD)
        return fail('remote-validation', 400);
      rpcId = envelope.data.rpcId;
      const parsed = remoteTeamAssetFileReadRequestSchema.safeParse(envelope.data.payload);
      if (!parsed.success) return fail('remote-validation', 400);
      const source = current();
      if (!source) return fail('remote-unavailable', 503);
      const permit = req.headers[REMOTE_RUN_PERMIT_HEADER];
      if (permit !== undefined && typeof permit !== 'string') return fail('remote-validation', 400);
      grant = await source.execution.openRemoteTeamAssetFile(req, parsed.data, permit, signal);
      grant.signal.addEventListener('abort', onGrantAbort, { once: true });
      if (grant.signal.aborted) onGrantAbort();
      const check = () => {
        signal.throwIfAborted();
        grant!.signal.throwIfAborted();
        const latest = current();
        if (latest?.execution !== source.execution || latest.files !== source.files)
          throw new TeamAssetFileError('unavailable');
        grant!.check();
        file?.signal.throwIfAborted();
        file?.check();
      };
      check();
      if (parsed.data.payload.mode === 'check') {
        reply({
          ok: true,
          value: { scope: grant.scope, reference: grant.reference, file: grant.file },
        });
        return;
      }
      const reading = source.files.openReadTracked(
        grant.request,
        {
          spaceId: grant.reference.spaceId,
          assetId: grant.reference.assetId,
          versionId: grant.reference.versionId,
        },
        signal,
        output,
      );
      physical = reading.drain;
      file = await reading.result;
      check();
      if (
        canonicalPayload(file.file) !== canonicalPayload(grant.file) ||
        file.bytes.byteLength !== grant.file.byteSize
      )
        throw new TeamAssetFileError('digest-mismatch');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': file.file.byteSize,
        'x-zhuma-rpc-id': rpcId,
        'x-zhuma-run-scope-sha256': sha256(grant.scope),
        'x-zhuma-team-asset-reference': encodeURIComponent(JSON.stringify(grant.reference)),
        'x-zhuma-team-asset-file': encodeURIComponent(JSON.stringify(grant.file)),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      for (let offset = 0; offset < file.bytes.byteLength; offset += 65536) {
        check();
        if (
          !res.write(file.bytes.subarray(offset, Math.min(offset + 65536, file.bytes.byteLength)))
        ) {
          await new Promise<void>((resolve, reject) => {
            const clear = () => {
              res.off('drain', onDrain);
              signal.removeEventListener('abort', abort);
            };
            const onDrain = () => {
              clear();
              resolve();
            };
            const abort = () => {
              clear();
              reject(new TeamAssetFileError('cancelled'));
            };
            res.once('drain', onDrain);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
          check();
        }
      }
      check();
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        const mapped = errorResponse(error);
        fail(mapped.code, mapped.status);
      } else if (!res.writableFinished && !res.destroyed) res.destroy();
    } finally {
      if (!res.writableEnded && !res.destroyed) res.destroy();
      if (res.writableFinished || res.closed) finishOutput();
      // Promise.all rejects early; actual drains must all settle even on failure.
      const drain = Promise.allSettled([physical, output]).then((results) => {
        if (results.some((value) => value.status === 'rejected'))
          throw new TeamAssetFileError('unavailable');
      });
      try {
        // The ORIGINAL grant begins logical cancellation in releaseAfter().
        // Call it only after output finish/close, otherwise a successful end()
        // would abort its own still-flushing response. Its reservation remains
        // owned throughout the actual attachment/output drains.
        try {
          await drain;
        } finally {
          await grant?.releaseAfter(drain);
        }
      } finally {
        try {
          file?.release();
        } finally {
          grant?.signal.removeEventListener('abort', onGrantAbort);
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          res.off('finish', onFinish);
          res.off('close', onClose);
          res.off('error', onError);
        }
      }
    }
  }
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      for (const dispose of disposers) dispose();
      disposers.clear();
      while (active.size) await Promise.allSettled([...active]);
      if (cleanupFailed) throw new TeamAssetFileError('unavailable');
    })());
  ctx.effect(() => close);
  return { close };
}
