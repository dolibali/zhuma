import type { HostRunFrameSink } from './host-run-reader.js';
import { NativeWorkError } from './native-work-session-contract.js';

export const HOST_RUN_FRAME_BYTES = 512 * 1024;

/** One demand-driven frame at a time. Cancelling the body cancels only this read. */
export function hostRunStream(options: {
  readonly rpcId: string;
  readonly signal: AbortSignal;
  observe(sink: HostRunFrameSink, signal: AbortSignal): Promise<void>;
  failure(error: unknown): unknown;
}) {
  const reading = new AbortController();
  const signal = AbortSignal.any([reading.signal, options.signal]);
  const stream = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    { highWaterMark: 1 },
    { highWaterMark: 0 },
  );
  const writer = stream.writable.getWriter();
  const abort = () => {
    reading.abort();
    void writer
      .abort(new DOMException('Conversation read cancelled', 'AbortError'))
      .catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  void writer.closed.catch(abort);
  const encoder = new TextEncoder();
  async function write(value: unknown, authority: AbortSignal = signal) {
    signal.throwIfAborted();
    authority.throwIfAborted();
    const bytes = encoder.encode(`${JSON.stringify(value)}\n`);
    if (bytes.byteLength > HOST_RUN_FRAME_BYTES) throw new NativeWorkError('capacity');
    authority.addEventListener('abort', abort, { once: true });
    try {
      await writer.write(bytes);
      authority.throwIfAborted();
      signal.throwIfAborted();
    } finally {
      authority.removeEventListener('abort', abort);
    }
  }
  const drained = (async () => {
    try {
      signal.throwIfAborted();
      await options.observe(
        (frame, authority) =>
          write({ type: 'server-frame', rpcId: options.rpcId, frame }, authority),
        signal,
      );
      await writer.close();
    } catch (error) {
      if (!signal.aborted) {
        try {
          await write({
            type: 'server-response',
            rpcId: options.rpcId,
            result: options.failure(error),
          });
          await writer.close();
        } catch {
          abort();
        }
      } else abort();
    } finally {
      signal.removeEventListener('abort', abort);
      reading.abort();
    }
  })();
  return {
    drained,
    response: new Response(stream.readable, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    }),
  };
}
