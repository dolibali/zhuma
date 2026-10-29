import { createHash } from 'node:crypto';

/** Bounded, backpressured carrier only. The original file service owns grants
 * and publication. Cancellation drains the reader; it is not a business receipt. */
export function guardSharedFileStream(
  source: ReadableStream<Uint8Array>,
  options: {
    signal: AbortSignal;
    check(): Promise<void>;
    maxBytes: number;
    expectedBytes?: number;
    sha256?: string;
  },
) {
  const reader = source.getReader();
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const hash = options.sha256 ? createHash('sha256') : undefined;
  let bytes = 0;
  let finished = false;
  let draining: Promise<void> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (draining) return draining;
    finished = true;
    options.signal.removeEventListener('abort', abort);
    return (draining = (async () => {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
        resolveSettled();
      }
    })());
  };
  const abort = () => {
    if (!finished) output.error(new DOMException('File carrier cancelled', 'AbortError'));
    void finish().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    },
    async pull(controller) {
      try {
        options.signal.throwIfAborted();
        await options.check();
        const next = await reader.read();
        if (finished) return;
        options.signal.throwIfAborted();
        await options.check();
        if (finished) return;
        if (next.done) {
          if (
            (options.expectedBytes !== undefined && bytes !== options.expectedBytes) ||
            (hash && hash.digest('hex') !== options.sha256)
          )
            throw Error('File carrier integrity check failed');
          controller.close();
          await finish();
          return;
        }
        bytes += next.value.byteLength;
        if (
          bytes > options.maxBytes ||
          (options.expectedBytes !== undefined && bytes > options.expectedBytes)
        )
          throw Error('File carrier limit exceeded');
        hash?.update(next.value);
        controller.enqueue(next.value);
      } catch {
        if (!finished) controller.error(Error('File carrier unavailable'));
        await finish().catch(() => undefined);
      }
    },
    cancel: finish,
  });
  return { body, settled, cancel: finish };
}
