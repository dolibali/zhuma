import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { REMOTE_RUN_LIMITS, remoteRunRequestSchema } from '@zhuma/agent-core';

/** One length-prefixed original signed request followed by raw file bytes.
 * No alternate metadata header, file JSON/base64, business DTO or signature. */
export const REMOTE_RUN_UPLOAD_MEDIA_TYPE = 'application/x-zhuma-run-upload';
export const REMOTE_RUN_UPLOAD_METHOD = 'zhuma-remote-run/publish-file';
export const REMOTE_RUN_UPLOAD_TAIL_BYTES = 64 * 1024;
export class RemoteRunUploadFramingError extends Error {
  constructor(readonly status: 400 | 408 | 413) {
    super('文件上传运输未完成。');
  }
}
function publication(raw: unknown) {
  try {
    const envelope = clientRequestSchema.parse(raw),
      request = remoteRunRequestSchema.parse(envelope.payload);
    if (envelope.method !== REMOTE_RUN_UPLOAD_METHOD || request.operation !== 'publish-file')
      throw new Error();
    const payload = request.payload;
    if (payload.mode !== 'publish') throw new Error();
    return { ...envelope, payload: { ...request, payload } };
  } catch {
    throw new RemoteRunUploadFramingError(400);
  }
}
/** C prepends this exact 4-byte BE length and UTF-8 original envelope to
 * its original byte source. Property order is not part of the signed domain DTO. */
export function encodeRemoteRunUploadPrefix(raw: unknown): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(publication(raw)), 'utf8');
  if (bytes.byteLength > REMOTE_RUN_LIMITS.requestBytes) throw new RemoteRunUploadFramingError(413);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([size, bytes]);
}

/** Member authentication precedes construction. Framing can retain only a
 * bounded same-chunk tail; D checks full signed authority before file consumers.
 * Transport flushes early replies BEFORE closing unread Node request bytes. */
export class RemoteRunUploadReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private remainder: Uint8Array = new Uint8Array(0);
  private pending = 0;
  private ended = false;
  private released = false;
  private reading = false;
  private ready = false;
  private closing?: Promise<void>;
  private readonly cancelled = () => {
    void this.close().catch(() => undefined);
  };
  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly signal: AbortSignal,
  ) {
    this.reader = stream.getReader();
    signal.addEventListener('abort', this.cancelled, { once: true });
    if (signal.aborted) this.cancelled();
  }
  private release() {
    if (this.ended && !this.pending && !this.released) {
      this.released = true;
      this.reader.releaseLock();
    }
  }
  private async pull(wait: AbortSignal) {
    wait.throwIfAborted();
    this.pending++;
    const reading = this.reader.read().finally(() => {
      this.pending--;
      this.release();
    });
    let stop: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      stop = () => reject(wait.reason);
      wait.addEventListener('abort', stop, { once: true });
      if (wait.aborted) stop();
    });
    try {
      const next = await Promise.race([reading, aborted]);
      wait.throwIfAborted();
      return next;
    } finally {
      if (stop) wait.removeEventListener('abort', stop);
    }
  }
  private async exactly(
    length: number,
    wait: AbortSignal,
    tailBytes = REMOTE_RUN_UPLOAD_TAIL_BYTES,
  ) {
    const output = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      if (!this.remainder.byteLength) {
        const next = await this.pull(wait);
        if (next.done) throw new RemoteRunUploadFramingError(400);
        if (next.value.byteLength > length - offset + tailBytes)
          throw new RemoteRunUploadFramingError(413);
        this.remainder = next.value;
      }
      const count = Math.min(length - offset, this.remainder.byteLength);
      output.set(this.remainder.subarray(0, count), offset);
      this.remainder = this.remainder.subarray(count);
      offset += count;
    }
    return output;
  }
  async metadata(timeoutMs = REMOTE_RUN_LIMITS.httpTimeoutMs) {
    if (this.reading || this.ended) throw new RemoteRunUploadFramingError(400);
    this.reading = true;
    const deadline = new AbortController(),
      timer = setTimeout(() => deadline.abort(), timeoutMs);
    const wait = AbortSignal.any([this.signal, deadline.signal]);
    try {
      const size = (
        await this.exactly(4, wait, REMOTE_RUN_LIMITS.requestBytes + REMOTE_RUN_UPLOAD_TAIL_BYTES)
      ).readUInt32BE();
      if (!size) throw new RemoteRunUploadFramingError(400);
      if (size > REMOTE_RUN_LIMITS.requestBytes) throw new RemoteRunUploadFramingError(413);
      if (this.remainder.byteLength > size + REMOTE_RUN_UPLOAD_TAIL_BYTES)
        throw new RemoteRunUploadFramingError(413);
      const bytes = await this.exactly(size, wait);
      if (this.remainder.byteLength > REMOTE_RUN_UPLOAD_TAIL_BYTES)
        throw new RemoteRunUploadFramingError(413);
      const envelope = publication(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      this.signal.throwIfAborted();
      this.ready = true;
      return envelope;
    } catch (error) {
      this.signal.throwIfAborted();
      if (deadline.signal.aborted) throw new RemoteRunUploadFramingError(408);
      throw error instanceof RemoteRunUploadFramingError
        ? error
        : new RemoteRunUploadFramingError(400);
    } finally {
      clearTimeout(timer);
    }
  }
  readonly data: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: async () => {
      this.signal.throwIfAborted();
      if (!this.ready) throw new RemoteRunUploadFramingError(400);
      if (this.ended) return { done: true, value: undefined };
      if (this.remainder.byteLength) {
        const value = this.remainder;
        this.remainder = new Uint8Array(0);
        return { done: false, value };
      }
      const next = await this.pull(this.signal);
      if (next.done) await this.close();
      return next;
    },
    return: async () => {
      await this.close();
      return { done: true, value: undefined };
    },
  };
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.ended = true;
      this.remainder = new Uint8Array(0);
      this.signal.removeEventListener('abort', this.cancelled);
      try {
        await this.reader.cancel();
      } finally {
        this.release();
      }
    })());
  }
}
