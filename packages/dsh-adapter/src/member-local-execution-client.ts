import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';

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
  readonly authentication: (signal: AbortSignal) => HeadersInit | Promise<HeadersInit>;
  /** Compiled private application headers from the authoritative contract. */
  readonly privateHeaderNames?: readonly string[];
  readonly timeoutMs?: number;
}
const RESPONSE_BYTES = 256 * 1024;
const serverResponse = z.strictObject({
  type: z.literal('server-response'),
  rpcId: z.string(),
  result: z.unknown(),
});

/** Outbound JSON sender only. It neither grants a Run nor publishes incoming
 * owner RPC. A owns server/HTTP/Host mounts; D owns all business DTOs/decoders. */
export class MemberLocalExecutionClient {
  private readonly origin: string;
  private readonly methods: ReadonlySet<string>;
  private readonly privateHeaderNames: ReadonlySet<string>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly timeoutMs: number;
  private closing?: Promise<void>;
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
  invoke<T>(
    method: string,
    payload: unknown,
    decode: (result: unknown) => T,
    signal?: AbortSignal,
    privateHeaders?: HeadersInit,
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
        body = JSON.stringify(
          clientRequestSchema.parse({ type: 'client-request', method, rpcId, payload }),
        );
      if (Buffer.byteLength(body) > RESPONSE_BYTES) throw new MemberLocalTransportError('limit');
      const authorization = await this.options.authentication(bounded);
      bounded.throwIfAborted();
      const headers = new Headers(authorization);
      for (const [name, value] of scopedHeaders) headers.set(name, value);
      headers.set('content-type', 'application/json');
      const response = await fetch(`${this.origin}/api/${method}`, {
        method: 'POST',
        headers,
        body,
        signal: bounded,
        redirect: 'error',
        cache: 'no-store',
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
    });
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    // Keep the underlying job retained even if an auth provider ignores cancellation.
    // Once it returns, the abort check prevents a late network command.
    return this.wait(work, bounded).catch((error: unknown) => {
      if (bounded.aborted) throw new MemberLocalTransportError('cancelled');
      if (error instanceof MemberLocalTransportError) throw error;
      throw new MemberLocalTransportError('unavailable');
    });
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
