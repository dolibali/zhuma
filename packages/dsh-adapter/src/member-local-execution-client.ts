import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import {
  canonicalPayload,
  REMOTE_TEAM_ASSET_FILE_METHOD,
  REMOTE_RUN_PERMIT_HEADER,
  remoteTeamAssetFileReadRequestSchema,
  type RemoteTeamAssetFileReadRequest,
} from '@zhuma/agent-core';
import {
  MemberLocalTeamAssetTransportError,
  readMemberLocalTeamAssetFileValue,
  readMemberLocalTeamAssetResponse,
  type MemberLocalTeamAssetFileValue,
  type MemberLocalTeamAssetResponse,
  type MemberLocalTrackedOperation,
} from './member-local-execution-team-assets.js';
import {
  REMOTE_RUN_UPLOAD_MEDIA_TYPE,
  REMOTE_RUN_UPLOAD_METHOD,
  encodeRemoteRunUploadPrefix,
} from './remote-run-file-transport.js';

export type MemberLocalTransportCode =
  'invalid' | 'unavailable' | 'cancelled' | 'limit' | 'rejected' | 'protocol';
/** An interrupted HTTP wait says nothing about a remote commit or native drain. */
export class MemberLocalTransportError extends Error {
  readonly outcome = 'unknown' as const;
  constructor(readonly code: MemberLocalTransportCode) {
    super('成员本机执行通信未完成。');
  }
}
export interface MemberLocalClientOptions {
  /** Explicitly chosen backend origin; never a model argument or arbitrary tool URL. */
  readonly origin: string;
  /** Exact compiled operation names from D's single remote-run contract. */
  readonly methods: readonly string[];
  /** Original Host credential owner; secrets never enter ordinary metadata. */
  readonly authentication: (
    signal: AbortSignal,
    context: { readonly method: string },
  ) => HeadersInit | Promise<HeadersInit>;
  /** Compiled private application headers from the authoritative contract. */
  readonly privateHeaderNames?: readonly string[];
  readonly timeoutMs?: number;
}
const RESPONSE_BYTES = 256 * 1024;
export interface MemberLocalSourceOptions {
  readonly waitForSourceSettlement: true;
  /** Only the original publisher supplies bytes. No model-selected URL or DTO. */
  readonly upload?: AsyncIterable<Uint8Array>;
}
const serverResponse = z.strictObject({
  type: z.literal('server-response'),
  rpcId: z.string(),
  result: z.unknown(),
});

/** Outbound sender only. It neither grants a Run nor publishes incoming
 * owner RPC. A owns server/HTTP/Host mounts; D owns all business DTOs/decoders. */
export class MemberLocalExecutionClient {
  private readonly origin: string;
  private readonly methods: ReadonlySet<string>;
  private readonly privateHeaderNames: ReadonlySet<string>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly timeoutMs: number;
  private closing?: Promise<void>;
  get hasPendingWork(): boolean {
    return this.pending.size > 0;
  }
  constructor(private readonly options: MemberLocalClientOptions) {
    try {
      const url = new URL(options.origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw Error();
      if (
        !options.methods.length ||
        options.methods.some((method) => !/^zhuma-[a-z0-9-]+(?:\/[a-z0-9-]+)+$/u.test(method))
      )
        throw Error();
      this.origin = url.origin;
      this.methods = new Set(options.methods);
      const names = options.privateHeaderNames ?? [];
      if (names.some((name) => !/^x-[a-z0-9-]+$/u.test(name))) throw Error();
      this.privateHeaderNames = new Set(names);
      this.timeoutMs = options.timeoutMs ?? 10_000;
      if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000)
        throw Error();
    } catch {
      throw new MemberLocalTransportError('invalid');
    }
  }
  /** Dedicated binary/check transport, deliberately outside the generic JSON
   * method map. The original protocol supplies a signed request and drive. */
  openTeamAssetFile<Mode extends 'read' | 'check'>(
    request: RemoteTeamAssetFileReadRequest & { readonly payload: { readonly mode: Mode } },
    expected: MemberLocalTeamAssetFileValue,
    secret: string,
    signal: AbortSignal,
  ): MemberLocalTrackedOperation<MemberLocalTeamAssetResponse<Mode>> {
    if (this.lifetime.signal.aborted) throw new MemberLocalTransportError('unavailable');
    if (this.pending.size >= 16) throw new MemberLocalTransportError('limit');
    if (!this.privateHeaderNames.has(REMOTE_RUN_PERMIT_HEADER))
      throw new MemberLocalTransportError('invalid');
    const parsed = remoteTeamAssetFileReadRequestSchema.parse(request),
      // Snapshot before the first async boundary, never follow caller mutation.
      fixed = readMemberLocalTeamAssetFileValue(expected),
      bounded = AbortSignal.any([
        this.lifetime.signal,
        signal,
        AbortSignal.timeout(this.timeoutMs),
      ]);
    if (
      canonicalPayload(parsed.payload.scope) !== canonicalPayload(fixed.scope) ||
      canonicalPayload(parsed.payload.reference) !== canonicalPayload(fixed.reference)
    )
      throw new MemberLocalTransportError('invalid');
    const work = Promise.resolve()
      .then(async () => {
        bounded.throwIfAborted();
        const rpcId = randomUUID(),
          method = REMOTE_TEAM_ASSET_FILE_METHOD,
          envelope = clientRequestSchema.parse({
            type: 'client-request',
            method,
            rpcId,
            payload: parsed,
          }),
          body = JSON.stringify(envelope);
        if (Buffer.byteLength(body) > 16 * 1024) throw new MemberLocalTransportError('limit');
        const authorization = await this.options.authentication(bounded, Object.freeze({ method }));
        bounded.throwIfAborted();
        const headers = new Headers(authorization);
        headers.set(REMOTE_RUN_PERMIT_HEADER, secret);
        headers.set('content-type', 'application/json');
        const response = await fetch(`${this.origin}/api/${method}`, {
          method: 'POST',
          headers,
          body,
          signal: bounded,
          redirect: 'error',
          cache: 'no-store',
        });
        return readMemberLocalTeamAssetResponse(
          response,
          rpcId,
          parsed.payload.mode as Mode,
          fixed,
          bounded,
        );
      })
      .catch((error: unknown) => {
        if (bounded.aborted) throw new MemberLocalTransportError('cancelled');
        if (error instanceof MemberLocalTransportError) throw error;
        if (error instanceof MemberLocalTeamAssetTransportError)
          throw new MemberLocalTransportError(error.code);
        throw new MemberLocalTransportError('unavailable');
      });
    this.pending.add(work);
    const drain = work
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.pending.delete(work);
      });
    return Object.freeze({ result: this.wait(work, bounded), drain });
  }
  invoke<T>(
    method: string,
    payload: unknown,
    decode: (result: unknown) => T,
    signal?: AbortSignal,
    privateHeaders?: HeadersInit,
    options?: MemberLocalSourceOptions,
  ): Promise<T> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(new MemberLocalTransportError('unavailable'));
    if (!this.methods.has(method)) return Promise.reject(new MemberLocalTransportError('invalid'));
    if (this.pending.size >= 16) return Promise.reject(new MemberLocalTransportError('limit'));
    let scopedHeaders: Headers;
    try {
      scopedHeaders = new Headers(privateHeaders);
      for (const [name] of scopedHeaders) if (!this.privateHeaderNames.has(name)) throw Error();
    } catch {
      return Promise.reject(new MemberLocalTransportError('invalid'));
    }
    const bounded = AbortSignal.any([
      this.lifetime.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.timeoutMs),
    ]);
    const work = Promise.resolve().then(async () => {
      bounded.throwIfAborted();
      const rpcId = randomUUID(),
        envelope = clientRequestSchema.parse({ type: 'client-request', method, rpcId, payload }),
        body = JSON.stringify(envelope);
      if (Buffer.byteLength(body) > RESPONSE_BYTES) throw new MemberLocalTransportError('limit');
      const authorization = await this.options.authentication(bounded, Object.freeze({ method }));
      bounded.throwIfAborted();
      const headers = new Headers(authorization);
      for (const [name, value] of scopedHeaders) headers.set(name, value);
      if (options?.upload && method !== REMOTE_RUN_UPLOAD_METHOD)
        throw new MemberLocalTransportError('invalid');
      const uploading = options?.upload
        ? this.upload(encodeRemoteRunUploadPrefix(envelope), options.upload, bounded)
        : undefined;
      headers.set('content-type', uploading ? REMOTE_RUN_UPLOAD_MEDIA_TYPE : 'application/json');
      try {
        const request: RequestInit & { duplex?: 'half' } = {
          method: 'POST',
          headers,
          body: uploading
            ? new ReadableStream<Uint8Array>(
                {
                  async pull(controller) {
                    try {
                      const next = await uploading.next();
                      if (next.done) controller.close();
                      else controller.enqueue(next.value);
                    } catch (error) {
                      controller.error(error);
                    }
                  },
                  async cancel() {
                    await uploading.return();
                  },
                },
                { highWaterMark: 0 },
              )
            : body,
          ...(uploading ? { duplex: 'half' as const } : {}),
          signal: bounded,
          redirect: 'error',
          cache: 'no-store',
        };
        const response = await fetch(`${this.origin}/api/${method}`, {
          ...request,
        });
        if (!response.ok) throw new MemberLocalTransportError('rejected');
        const reader = response.body?.getReader();
        if (!reader) throw new MemberLocalTransportError('protocol');
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            bounded.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > RESPONSE_BYTES) throw new MemberLocalTransportError('limit');
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        bounded.throwIfAborted();
        const bytes = Buffer.concat(chunks, size);
        const envelope = serverResponse.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (envelope.rpcId !== rpcId) throw new MemberLocalTransportError('protocol');
        const value = decode(envelope.result);
        bounded.throwIfAborted();
        return value;
      } finally {
        // fetch returning/aborting is not native byte-source drain. In
        // particular an uncooperative pending next() remains owned until it
        // and the source's original return() really settle.
        await uploading?.return();
      }
    });
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    // Keep the underlying job retained even if an auth provider ignores cancellation.
    // Once it returns, the abort check prevents a late network command.
    // Native input reservations must own the actual source job, including an
    // authentication provider that ignores abort. Ordinary RPC waits keep their
    // existing early cancellation behavior; retained reads do not imply drain.
    return (options?.waitForSourceSettlement ? work : this.wait(work, bounded)).catch(
      (error: unknown) => {
        if (bounded.aborted) throw new MemberLocalTransportError('cancelled');
        if (error instanceof MemberLocalTransportError) throw error;
        throw new MemberLocalTransportError('unavailable');
      },
    );
  }
  private async *upload(
    prefix: Uint8Array,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array, void, unknown> {
    signal.throwIfAborted();
    yield prefix;
    signal.throwIfAborted();
    const iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await iterator.next();
        signal.throwIfAborted();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new MemberLocalTransportError('invalid');
        for (let offset = 0; offset < next.value.byteLength; offset += 65536) {
          signal.throwIfAborted();
          yield next.value.subarray(offset, offset + 65536);
        }
      }
    } finally {
      await iterator.return?.();
    }
  }
  private wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new MemberLocalTransportError('cancelled'));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
    })();
    return this.closing;
  }
}
