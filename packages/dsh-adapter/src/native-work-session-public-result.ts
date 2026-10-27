import { createHash } from 'node:crypto';
import type { NativeHistoryEvent, NativeWorkFrame } from './native-work-session-contract.js';
import { NATIVE_RESULT_LIMITS, NATIVE_RESULT_TOOL } from './native-work-session-result-contract.js';
import { NATIVE_REVIEW_TOOL } from './native-work-session-review-contract.js';

const isCompletionTool = (name: unknown): boolean =>
  name === NATIVE_RESULT_TOOL || name === NATIVE_REVIEW_TOOL;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const callId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const index = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Presentation metadata only: not model arguments, an artifact digest or authorization. */
function omit(value: ObjectValue, field: string): ObjectValue {
  if (!Object.hasOwn(value, field)) return value;
  const original = value[field];
  const serialized = typeof original === 'string' ? original : JSON.stringify(original);
  if (serialized === undefined) return value;
  const bytes = Buffer.byteLength(serialized);
  // Keep the original public capacity rejection for sources beyond the private
  // result scan bound. Never increase that bound or process an unbounded digest.
  if (bytes > NATIVE_RESULT_LIMITS.scanBytes) return value;
  const { [field]: _body, ...rest } = value;
  return {
    ...rest,
    zhumaNativeResultProjection: {
      version: 1,
      omitted: field,
      bytes,
      sha256: createHash('sha256').update(serialized).digest('hex'),
    },
  };
}

function toolBlock(value: unknown): unknown {
  const block = object(value);
  return block?.type === 'tool-call' && isCompletionTool(block.name) && callId(block.id)
    ? omit(block, 'arguments')
    : value;
}

/** One attempt only. Names may arrive once, followed by unnamed argument chunks. */
class ResultArgumentChunks {
  private readonly names = new Map<number, string>();

  private complete(position: unknown, id: unknown, name: unknown): boolean {
    if (!index(position) || !callId(id)) return false;
    if (typeof name === 'string') {
      if (!isCompletionTool(name)) this.names.delete(position);
      else if (this.names.has(position) || this.names.size < 128) this.names.set(position, id);
      return isCompletionTool(name);
    }
    if (this.names.get(position) === id) return true;
    this.names.delete(position);
    return false;
  }

  chunk(value: unknown): unknown {
    const chunk = object(value);
    if (!chunk) return value;
    if (chunk.type === 'block-start' && index(chunk.index)) this.names.delete(chunk.index);
    if (chunk.type === 'tool-call-delta' && this.complete(chunk.index, chunk.id, chunk.name))
      return omit(chunk, 'argumentsDelta');
    if (chunk.type === 'block-end') {
      if (index(chunk.index)) this.names.delete(chunk.index);
      const block = toolBlock(chunk.block);
      if (block !== chunk.block) {
        return { ...chunk, block };
      }
    }
    return value;
  }

  record(value: unknown): unknown {
    const record = object(value);
    if (!record) return value;
    if (record.type === 'tool-call-chunks' && this.complete(record.index, record.id, record.name))
      return omit(record, 'args');
    if (record.type === 'chunk') {
      const chunk = this.chunk(record.chunk);
      return chunk === record.chunk ? value : { ...record, chunk };
    }
    return value;
  }
}

/** Same native event identity/order; only explicit completion argument carriers change. */
export function publicNativeResultEvent(event: NativeHistoryEvent): NativeHistoryEvent {
  const data = object(event.data);
  if (!data) return event;
  if (event.type === 'tool/call' && isCompletionTool(data.name) && callId(data.callId)) {
    const projected = omit(data, 'arguments');
    return projected === data ? event : { ...event, data: projected };
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return event;
  const message = object(data.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const chunks = new ResultArgumentChunks();
  const stream = Array.isArray(data.stream)
    ? data.stream.map((value) => chunks.record(value))
    : data.stream;
  const blocks = content.map(toolBlock);
  const changedBlocks = blocks.some((value, i) => value !== content[i]);
  const changedStream =
    Array.isArray(stream) && stream.some((value, i) => value !== (data.stream as unknown[])[i]);
  // Opaque replay may also contain ordinary chat/other calls. Preserve it and
  // the existing capacity failure instead of guessing its private structure.
  const projectedMessage = message && changedBlocks ? { ...message, content: blocks } : message;
  if (!changedBlocks && !changedStream && projectedMessage === message) return event;
  return {
    ...event,
    data: {
      ...data,
      ...(projectedMessage !== message ? { message: projectedMessage } : {}),
      ...(changedStream ? { stream } : {}),
    },
  };
}

/** Observer-local state; never changes the SDK's durable log or private cut reader. */
export class NativePublicResultProjection {
  private attempt: unknown;
  private chunks = new ResultArgumentChunks();
  frame(value: NativeWorkFrame): NativeWorkFrame {
    if (value.type === 'event') {
      const event = publicNativeResultEvent(value.event);
      return event === value.event ? value : { ...value, event };
    }
    if (value.type !== 'assistant-stream') return value;
    const frame = object(value.frame);
    if (!frame) return value;
    if (frame.type === 'start') {
      this.attempt = typeof frame.attemptId === 'string' ? frame.attemptId : undefined;
      this.chunks = new ResultArgumentChunks();
    }
    if (frame.type === 'chunk' && this.attempt !== undefined && frame.attemptId === this.attempt) {
      const chunk = this.chunks.chunk(frame.chunk);
      return chunk === frame.chunk ? value : { ...value, frame: { ...frame, chunk } };
    }
    if (frame.type === 'end' && frame.attemptId === this.attempt) {
      this.attempt = undefined;
      this.chunks = new ResultArgumentChunks();
    }
    return value;
  }
}
