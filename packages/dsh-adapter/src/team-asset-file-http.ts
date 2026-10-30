import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import {
  MemberAssetErrorCodeSchema,
  MemberAssetFileReadSchema,
  MemberAssetFileReserveSchema,
} from '@zhuma/agent-core';
import { resolveMember } from './member-session.js';
import { registerProductFetch } from './member-web-transport.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';
import { TeamAssetFileError } from './team-asset-file.js';
import type { TeamAssetFileService, TeamAssetFileReadHandle } from './team-asset-file-service.js';
import {
  teamAssetFilePresentation,
  TEAM_ASSET_FILE_RESPONSE_HEADERS,
} from './team-asset-file-preview.js';

export const TEAM_ASSET_FILE_HTTP_PATHS = Object.freeze({
  upload: '/api/zhuma-member/asset-file-upload',
  read: '/api/zhuma-member/asset-file-read',
  text: '/api/zhuma-member/asset-file-text',
});
const readSchema = MemberAssetFileReadSchema.extend({
  mode: z.enum(['download', 'preview']).default('download'),
});
const textSchema = MemberAssetFileReadSchema.extend({
  offset: z.number().int().nonnegative().refine(Number.isSafeInteger),
  length: z.number().int().positive().max(8192),
});
const uploadHeaders = [
  'space-id',
  'asset-id',
  'expected-version',
  'idempotency-key',
  'file-name',
  'file-type',
  'file-size',
  'file-sha256',
] as const;
function declaration(headers: Headers) {
  const values = Object.fromEntries(
    uploadHeaders.map((name) => [name, headers.get(`x-zhuma-${name}`)]),
  );
  if (
    uploadHeaders.some((name) => !values[name]) ||
    Buffer.byteLength(JSON.stringify(values)) > 4096
  )
    throw new TeamAssetFileError('invalid');
  if (
    !/^[1-9]\d*$/u.test(values['expected-version']!) ||
    !/^(?:0|[1-9]\d*)$/u.test(values['file-size']!)
  )
    throw new TeamAssetFileError('invalid');
  return MemberAssetFileReserveSchema.parse({
    spaceId: values['space-id'],
    assetId: values['asset-id'],
    expectedVersion: Number(values['expected-version']),
    idempotencyKey: values['idempotency-key'],
    declare: {
      name: decodeURIComponent(values['file-name']!),
      mediaType: values['file-type'],
      byteSize: Number(values['file-size']),
      sha256: values['file-sha256'],
    },
  });
}
/** Lazy iterator: no getReader/next before the original D reservation succeeds.
 * return() cancels a pending read immediately rather than queuing behind it. */
function requestBytes(request: Request, signal: AbortSignal): AsyncIterableIterator<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    closed = false;
  let closing: Promise<void> | undefined;
  const stop = () => {
    if (closing) return closing;
    if (closed) return Promise.resolve();
    closed = true;
    signal.removeEventListener('abort', abort);
    return (closing = (async () => {
      if (reader) {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    })());
  };
  const abort = () => {
    void stop().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      signal.throwIfAborted();
      if (closed) return { done: true, value: undefined };
      if (!request.body) throw new TeamAssetFileError('invalid');
      reader ??= request.body.getReader();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (closed) throw new TeamAssetFileError('cancelled');
      if (chunk.done) {
        closed = true;
        signal.removeEventListener('abort', abort);
        reader.releaseLock();
        return { done: true, value: undefined };
      }
      return { done: false, value: chunk.value };
    },
    async return() {
      await stop();
      return { done: true, value: undefined };
    },
  };
}
const responseError = (error: unknown, aborted: boolean) => {
  if (aborted) return { code: 'asset-cancelled', status: 408 };
  if (error instanceof WorkbenchBodyError)
    return {
      code:
        error.status === 408
          ? 'asset-cancelled'
          : error.status === 413
            ? 'asset-quota'
            : 'asset-invalid',
      status: error.status,
    };
  if (error instanceof TeamAssetFileError) {
    const code =
      error.code === 'cancelled' || error.code === 'timeout'
        ? 'asset-cancelled'
        : error.code === 'limit'
          ? 'asset-quota'
          : error.code === 'unavailable'
            ? 'asset-unavailable'
            : 'asset-file-invalid';
    return {
      code,
      status:
        code === 'asset-cancelled'
          ? 408
          : code === 'asset-quota'
            ? 413
            : code === 'asset-unavailable'
              ? 503
              : 400,
    };
  }
  const typed = MemberAssetErrorCodeSchema.safeParse(
    error && typeof error === 'object' && 'code' in error ? error.code : undefined,
  );
  if (typed.success) {
    const code = typed.data;
    return {
      code,
      status:
        code === 'asset-forbidden' || code === 'asset-reference-denied'
          ? 403
          : code === 'asset-not-found'
            ? 404
            : code === 'asset-conflict' ||
                code === 'asset-request-reused' ||
                code === 'asset-upload-pending'
              ? 409
              : code === 'asset-quota'
                ? 413
                : code === 'asset-cancelled'
                  ? 408
                  : code === 'asset-invalid' || code === 'asset-file-invalid'
                    ? 400
                    : 503,
    };
  }
  return {
    code:
      error instanceof z.ZodError || error instanceof URIError
        ? 'asset-invalid'
        : 'asset-unavailable',
    status: error instanceof z.ZodError || error instanceof URIError ? 400 : 503,
  };
};

/** Registration/transport leaf only. A supplies the SAME service and owns its
 * shutdown after these routes, before D authority and original attachments. */
export function openTeamAssetFileHttp(
  ctx: Context,
  current: () => TeamAssetFileService | undefined,
) {
  const lifetime = new AbortController(),
    pending = new Set<Promise<unknown>>(),
    stops: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const retain = (job: Promise<unknown>) => {
    pending.add(job);
    void job.then(
      () => pending.delete(job),
      () => pending.delete(job),
    );
  };
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      const settled = await Promise.allSettled(stops.map((stop) => Promise.resolve().then(stop)));
      while (pending.size) await Promise.allSettled([...pending]);
      if (settled.some((result) => result.status === 'rejected'))
        throw new TeamAssetFileError('unavailable');
    })());
  ctx.effect(() => close);
  async function handle(
    kind: keyof typeof TEAM_ASSET_FILE_HTTP_PATHS,
    request: Request,
  ): Promise<Response> {
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    let rpcId = '',
      source: AsyncIterableIterator<Uint8Array> | undefined;
    const json = (result: object, status = 200) =>
      Response.json(rpcId ? { type: 'server-response', rpcId, result } : result, {
        status,
        headers: TEAM_ASSET_FILE_RESPONSE_HEADERS,
      });
    try {
      signal.throwIfAborted();
      const original = { headers: Object.fromEntries(request.headers) };
      const member = await resolveMember(ctx, original);
      if (!member.ok)
        return json(
          {
            ok: false,
            error: {
              code: 'asset-forbidden',
              message: '文件操作尚未授权。',
            },
          },
          member.status,
        );
      signal.throwIfAborted();
      const service = current();
      if (!service) throw new TeamAssetFileError('unavailable');
      if (kind === 'upload') {
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream')
          return json(
            { ok: false, error: { code: 'asset-invalid', message: '需要文件字节流。' } },
            415,
          );
        const input = declaration(request.headers);
        source = requestBytes(request, signal);
        const receipt = await service.upload(original, input, source, signal);
        if (current() !== service || signal.aborted) throw new TeamAssetFileError('cancelled');
        return json({ ok: true, value: receipt });
      }
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
        return json(
          { ok: false, error: { code: 'asset-invalid', message: '需要有界文件请求。' } },
          415,
        );
      const envelope = clientRequestSchema.parse(
        await readWorkbenchBody(request, { bodyBytes: 16384, bodyTimeoutMs: 5000 }, signal),
      );
      if (envelope.method !== `zhuma-member/asset-file-${kind}`)
        throw new TeamAssetFileError('invalid');
      rpcId = envelope.rpcId;
      if (kind === 'text') {
        const { offset, length, ...target } = textSchema.parse(envelope.payload);
        const value = await service.text(original, target, { offset, length }, signal);
        if (current() !== service || signal.aborted) throw new TeamAssetFileError('cancelled');
        return json({ ok: true, value: { target, ...value } });
      }
      const { mode, ...target } = readSchema.parse(envelope.payload);
      const content = await service.openRead(original, target, signal);
      try {
        if (current() !== service || signal.aborted) throw new TeamAssetFileError('cancelled');
        const hint =
          mode === 'preview'
            ? teamAssetFilePresentation(content.file, content.bytes)
            : { disposition: 'attachment', contentType: 'application/octet-stream' };
        let resolve!: () => void;
        const ended = new Promise<void>((done) => {
          resolve = done;
        });
        retain(ended);
        const body = output(content, () => current() === service, resolve);
        const name = encodeURIComponent(content.file.name).replace(
          /['()*]/gu,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        return new Response(body, {
          headers: {
            ...TEAM_ASSET_FILE_RESPONSE_HEADERS,
            'content-type': hint.contentType,
            'content-disposition': `${hint.disposition}; filename="file"; filename*=UTF-8''${name}`,
            'content-length': String(content.bytes.byteLength),
            'x-zhuma-file-sha256': content.file.sha256,
            'x-zhuma-asset-file-context': encodeURIComponent(JSON.stringify({ ...target, mode })),
          },
        });
      } catch (error) {
        content.release();
        throw error;
      }
    } catch (error) {
      const failure = responseError(error, signal.aborted);
      return json(
        {
          ok: false,
          error: { code: failure.code, message: '文件操作未完成，请重新核对当前空间与版本。' },
        },
        failure.status,
      );
    } finally {
      await source?.return?.();
    }
  }
  try {
    for (const kind of ['upload', 'read', 'text'] as const)
      stops.push(
        registerProductFetch(ctx, {
          path: TEAM_ASSET_FILE_HTTP_PATHS[kind],
          methods: ['POST'],
          requestBody: 'streaming',
          fetch(request) {
            const job = handle(kind, request);
            retain(job);
            return job;
          },
        }),
      );
  } catch {
    void close().catch(() => undefined);
    throw new TeamAssetFileError('unavailable');
  }
  return { close };
}

function output(content: TeamAssetFileReadHandle, current: () => boolean, ended: () => void) {
  let offset = 0,
    finished = false,
    abort: () => void = () => {};
  const timer = setTimeout(() => abort(), 60_000);
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    content.signal.removeEventListener('abort', abort);
    content.release();
    ended();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          if (!finished) controller.error(new Error('asset-cancelled'));
          finish();
        };
        content.signal.addEventListener('abort', abort, { once: true });
        if (content.signal.aborted) abort();
      },
      pull(controller) {
        try {
          content.check();
          if (!current()) throw new TeamAssetFileError('unavailable');
          if (offset >= content.bytes.byteLength) {
            controller.close();
            finish();
            return;
          }
          const next = Math.min(offset + 65536, content.bytes.byteLength);
          controller.enqueue(content.bytes.slice(offset, next));
          offset = next;
        } catch {
          controller.error(new Error('asset-file-unavailable'));
          finish();
        }
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );
}
