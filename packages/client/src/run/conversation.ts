import { ExecutionError } from '../execution/ExecutionApi.js';
import type {
  NativeConversationFrame,
  NativeRunInbox,
  NativeRunSummary,
} from './native-run-contract.js';

function invalid(): never {
  throw new ExecutionError('validation', '会话数据不完整，请刷新。');
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}
function text(value: unknown, max = 200, min = 1): string {
  return typeof value === 'string' && value.length >= min && value.length <= max
    ? value
    : invalid();
}
function number(value: unknown, min = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
    ? value
    : invalid();
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === 'string' && choices.includes(value as T) ? (value as T) : invalid();
}
function array(value: unknown, max = 10_000): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}
function envelope(raw: unknown, run: NativeRunSummary, spaceId: string) {
  const value = object(raw),
    target = object(value.target);
  for (const key of [
    'taskId',
    'planId',
    'revision',
    'nodeId',
    'runId',
    'generation',
    'segmentId',
  ] as const)
    if (target[key] !== run[key]) invalid();
  if (target.spaceId !== spaceId || !run.native || value.sessionId !== run.native.sessionId)
    invalid();
  return value;
}
function messageKey(value: unknown, seq: number, run: NativeRunSummary): string {
  return value === `${run.native?.sessionId}:seq:${seq}` ? (value as string) : invalid();
}
export function readNativeInbox(
  raw: unknown,
  run: NativeRunSummary,
  spaceId: string,
): NativeRunInbox {
  const value = envelope(raw, run, spaceId);
  const receipts = array(value.receipts).map((raw) => {
    const item = object(raw);
    return {
      requestId: text(item.requestId),
      messageId: text(item.messageId),
      mode: oneOf(item.mode, ['followup', 'steer', 'queue']),
      status: oneOf(item.status, ['received', 'claimed', 'unknown']),
    };
  });
  const items = array(value.items).map((raw) => {
    const item = object(raw);
    const result = {
      id: text(item.id),
      text: text(item.text, 16_384),
      target: oneOf(item.target, ['next-turn', 'next-step']),
      requestId: text(item.requestId),
      mode: oneOf(item.mode, ['followup', 'steer', 'queue']),
      status: oneOf(item.status, ['received']),
    };
    if (
      !receipts.some(
        (receipt) =>
          receipt.messageId === result.id &&
          receipt.requestId === result.requestId &&
          receipt.mode === result.mode &&
          receipt.status === 'received',
      )
    )
      invalid();
    return result;
  });
  if (
    new Set(receipts.map((item) => item.messageId)).size !== receipts.length ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    invalid();
  return { asOfSeq: number(value.asOfSeq, -1), receipts, items };
}
export function readNativeTurnEnd(
  raw: unknown,
): Extract<NativeConversationFrame, { type: 'turn-end' }> {
  const value = object(raw),
    reason = object(value.reason);
  return {
    type: 'turn-end',
    seq: number(value.seq),
    time: number(value.time),
    turn: number(value.turn, 1),
    reason: {
      kind: oneOf(reason.kind, [
        'completed',
        'blocked',
        'max-tokens',
        'error',
        'aborted',
        'interrupted',
        'forked',
        'unknown',
      ]),
    },
  };
}

export function readConversationFrame(
  raw: unknown,
  run: NativeRunSummary,
  spaceId: string,
): NativeConversationFrame {
  const value = envelope(raw, run, spaceId);
  if (value.type === 'ready') return { type: 'ready' };
  if (value.type === 'turn-end') return readNativeTurnEnd(value);
  if (value.type === 'message') {
    const seq = number(value.seq);
    return {
      type: 'message',
      seq,
      messageKey: messageKey(value.messageKey, seq, run),
      id: text(value.id, 1000),
      role: oneOf(value.role, ['user', 'assistant']),
      text: text(value.text, 262_144),
      ...(value.interrupted === true ? { interrupted: true } : {}),
    };
  }
  if (value.type === 'status')
    return { type: 'status', status: oneOf(value.status, ['idle', 'running']) };
  if (value.type === 'gap') return { type: 'gap', after: number(value.after, -1) };
  if (value.type !== 'assistant-stream') invalid();
  const frame = object(value.frame);
  if (frame.type === 'snapshot') {
    const active = frame.activeAttempt === undefined ? undefined : object(frame.activeAttempt);
    const toolNames = active ? array(active.toolNames, 128).map((name) => text(name)) : [];
    if (
      new Set(toolNames).size !== toolNames.length ||
      toolNames.some((name) => /[\u0000-\u001f\u007f]/u.test(name))
    )
      invalid();
    const snapshot = {
      type: 'assistant-stream' as const,
      frame: {
        type: 'snapshot' as const,
        revision: number(frame.revision),
        ...(active
          ? {
              activeAttempt: {
                attemptId: text(active.attemptId, 1000),
                startedAfterSeq: number(active.startedAfterSeq, -1),
                nextIndex: number(active.nextIndex),
                text: text(active.text, 262_144, 0),
                toolNames,
              },
            }
          : {}),
      },
    };
    // The original public frame budget excludes the transport's target/session envelope.
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 262_144) invalid();
    return snapshot;
  }
  const common = { attemptId: text(frame.attemptId, 1000), revision: number(frame.revision) };
  if (frame.type === 'start') return { type: value.type, frame: { type: 'start', ...common } };
  const index = number(frame.index);
  if (frame.type === 'chunk') {
    const chunk = {
      type: 'chunk' as const,
      ...common,
      index,
      ...(frame.text === undefined ? {} : { text: text(frame.text, 262_144) }),
      ...(frame.toolName === undefined ? {} : { toolName: text(frame.toolName) }),
    };
    if (!chunk.text && !chunk.toolName) invalid();
    return { type: value.type, frame: chunk };
  }
  if (frame.type !== 'end') invalid();
  const outcome = object(frame.outcome);
  if (outcome.kind === 'abandoned')
    return {
      type: value.type,
      frame: { type: 'end', ...common, index, outcome: { kind: 'abandoned' } },
    };
  if (outcome.kind !== 'committed') invalid();
  const seq = number(outcome.seq);
  return {
    type: value.type,
    frame: {
      type: 'end',
      ...common,
      index,
      outcome: {
        kind: 'committed',
        eventType: oneOf(outcome.eventType, ['assistant/message', 'assistant/attempt']),
        seq,
        messageKey: messageKey(outcome.messageKey, seq, run),
      },
    },
  };
}

/** Bound each wire line, including split UTF-8 chunks. A trailing partial JSON frame is invalid. */
export async function* conversationLines(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let buffer = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.value && part.value.byteLength > 2 * 1024 * 1024) invalid();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line || new TextEncoder().encode(line).length > 512 * 1024) invalid();
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          invalid();
        }
        yield value;
      }
      if (buffer.length > 512 * 1024) invalid();
      if (part.done) {
        if (buffer) invalid();
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
