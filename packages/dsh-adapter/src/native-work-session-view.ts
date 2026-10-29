import { z } from 'zod';
import {
  NativeWorkError,
  NATIVE_TURN_END_KINDS,
  type NativeConversationFrame,
  type NativeWorkFrame,
} from './native-work-session-contract.js';

const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const identity = z.string().min(1).max(1000);
const turnEndSchema = z.object({
  seq: natural,
  time: z.number().finite().nonnegative(),
  data: z.object({
    turn: z.number().int().positive().refine(Number.isSafeInteger),
    reason: z.unknown(),
  }),
});
const common = { attemptId: identity, revision: natural };
const streamSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    revision: natural,
    activeAttempt: z
      .object({
        attemptId: identity,
        startedAfterSeq: z.number().int().min(-1).refine(Number.isSafeInteger),
        nextIndex: natural,
        text: z.string(),
        toolNames: z
          .array(
            z
              .string()
              .min(1)
              .max(200)
              .refine((name) => !/[\u0000-\u001f\u007f]/u.test(name)),
          )
          .max(128)
          .refine((names) => new Set(names).size === names.length),
      })
      .optional(),
  }),
  z.object({ ...common, type: z.literal('start') }),
  z.object({ ...common, type: z.literal('chunk'), index: natural, chunk: z.unknown() }),
  z.object({
    ...common,
    type: z.literal('end'),
    index: natural,
    outcome: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('committed'),
        eventType: z.enum(['assistant/message', 'assistant/attempt']),
        seq: natural,
      }),
      z.object({ kind: z.literal('abandoned') }),
    ]),
  }),
]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Ephemeral observer projection only; native persistence remains the sole transcript. */
export class NativeConversationProjection {
  private revision = -1;
  private cursor = -1;
  private active: { id: string; nextIndex: number; toolNames: Set<string> } | undefined;

  constructor(
    private readonly sessionId: string,
    after = -1,
  ) {
    this.cursor = after;
  }

  private messageKey(seq: number): string {
    return `${this.sessionId}:seq:${seq}`;
  }

  push(value: NativeWorkFrame): NativeConversationFrame | undefined {
    let projected: NativeConversationFrame | undefined;
    if (value.type === 'event') {
      const event = value.event;
      this.cursor = Math.max(this.cursor, event.seq);
      if (event.type === 'turn/end') {
        const parsed = turnEndSchema.safeParse(event);
        if (!parsed.success) return;
        const raw = object(parsed.data.data.reason),
          kind = NATIVE_TURN_END_KINDS.find((kind) => kind === raw?.kind) ?? 'unknown';
        // Only the official durable turn boundary and its coarse reason cross
        // this view. Error/provider/hook details can contain private content.
        return {
          type: 'turn-end',
          seq: parsed.data.seq,
          time: parsed.data.time,
          turn: parsed.data.data.turn,
          reason: { kind },
        };
      }
      if (event.type !== 'user/message' && event.type !== 'assistant/message') return;
      const data = object(event.data);
      const message = event.type === 'assistant/message' ? object(data?.message) : data;
      const source = object(message?.source);
      if (
        !message ||
        typeof message.id !== 'string' ||
        !Array.isArray(message.content) ||
        (event.type === 'user/message' ? source?.kind !== 'user' : source?.kind !== 'model')
      )
        return;
      const text = message.content
        .flatMap((value: unknown) => {
          const block = object(value);
          return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
        })
        .join('\n');
      if (!text) return;
      projected = {
        type: 'message',
        seq: event.seq,
        time: event.time,
        messageKey: this.messageKey(event.seq),
        role: event.type === 'user/message' ? 'user' : 'assistant',
        id: message.id,
        text,
        ...(data?.interrupted === true ? { interrupted: true } : {}),
      };
    } else if (value.type === 'assistant-stream') {
      const parsed = streamSchema.safeParse(value.frame);
      if (!parsed.success) throw new NativeWorkError('unavailable');
      const frame = parsed.data;
      if (frame.revision <= this.revision) return;
      this.revision = frame.revision;
      if (frame.type === 'snapshot') {
        this.active = frame.activeAttempt
          ? {
              id: frame.activeAttempt.attemptId,
              nextIndex: frame.activeAttempt.nextIndex,
              toolNames: new Set(frame.activeAttempt.toolNames),
            }
          : undefined;
        projected = {
          type: 'assistant-stream',
          frame: {
            type: 'snapshot',
            revision: frame.revision,
            ...(frame.activeAttempt ? { activeAttempt: frame.activeAttempt } : {}),
          },
        };
        if (Buffer.byteLength(JSON.stringify(projected)) > 262_144)
          throw new NativeWorkError('capacity');
        return projected;
      }
      if (frame.type === 'start') {
        if (this.active) return { type: 'gap', after: this.cursor };
        this.active = { id: frame.attemptId, nextIndex: 0, toolNames: new Set() };
        return {
          type: 'assistant-stream',
          frame: { type: 'start', attemptId: frame.attemptId, revision: frame.revision },
        };
      }
      if (!this.active || frame.attemptId !== this.active.id)
        return { type: 'gap', after: this.cursor };
      if (frame.index !== this.active.nextIndex) return { type: 'gap', after: this.cursor };
      if (frame.type === 'end') {
        this.active = undefined;
        return {
          type: 'assistant-stream',
          frame: {
            type: 'end',
            attemptId: frame.attemptId,
            revision: frame.revision,
            index: frame.index,
            outcome:
              frame.outcome.kind === 'committed'
                ? {
                    kind: 'committed',
                    eventType: frame.outcome.eventType,
                    seq: frame.outcome.seq,
                    messageKey: this.messageKey(frame.outcome.seq),
                  }
                : { kind: 'abandoned' },
          },
        };
      }
      this.active.nextIndex++;
      const chunk = object(frame.chunk);
      const text =
        chunk?.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : undefined;
      const toolName =
        chunk?.type === 'tool-call-delta' && typeof chunk.name === 'string'
          ? chunk.name
          : undefined;
      if (toolName && (toolName.length > 200 || /[\u0000-\u001f\u007f]/u.test(toolName)))
        throw new NativeWorkError('unavailable');
      const newName = toolName && !this.active.toolNames.has(toolName) ? toolName : undefined;
      if (newName) {
        if (this.active.toolNames.size >= 128) throw new NativeWorkError('capacity');
        this.active.toolNames.add(newName);
      }
      if (!text && !newName) return;
      projected = {
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: frame.attemptId,
          revision: frame.revision,
          index: frame.index,
          ...(text ? { text } : {}),
          ...(newName ? { toolName: newName } : {}),
        },
      };
    } else {
      return value.type === 'status'
        ? { type: 'status', status: value.status }
        : { type: 'gap', after: value.after };
    }
    if (Buffer.byteLength(JSON.stringify(projected)) > 262_144)
      throw new NativeWorkError('capacity');
    return projected;
  }
}
