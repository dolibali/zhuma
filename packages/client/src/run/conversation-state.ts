import type {
  NativeConversationFrame,
  NativeRunInbox,
  NativeRunMessage,
} from './native-run-contract.js';

/** Ephemeral presentation only. Durable facts always replace streamed text at the same seq. */
export function createConversationState() {
  const saved = new Map<string, NativeRunMessage>();
  const awaiting = new Map<string, NativeRunMessage>();
  let streamRevision = -1;
  let streamAttempt: { id: string; index: number } | undefined;
  let inbox: NativeRunInbox | undefined;
  let lastTurn: Extract<NativeConversationFrame, { type: 'turn-end' }> | undefined;
  let partial:
    | {
        id: string;
        revision: number;
        index: number;
        text: string;
        tools: Set<string>;
        messageSeen: boolean;
        after: number;
      }
    | undefined;
  return {
    clear() {
      saved.clear();
      awaiting.clear();
      inbox = undefined;
      partial = undefined;
      streamRevision = -1;
      streamAttempt = undefined;
      lastTurn = undefined;
    },
    disconnect() {
      partial = undefined;
    },
    turnEnd() {
      return lastTurn ? structuredClone(lastTurn) : undefined;
    },
    inbox(value: NativeRunInbox) {
      inbox = value;
    },
    history(messages: readonly NativeRunMessage[], through: number) {
      for (const message of messages) {
        saved.set(message.id, message);
        if (message.role === 'assistant' && partial && message.sequence > partial.after)
          partial.messageSeen = true;
      }
      for (const [id, message] of awaiting) if (message.sequence <= through) awaiting.delete(id);
    },
    /** true requests a fresh read from the last locally scanned durable cursor. */
    frame(value: NativeConversationFrame): boolean {
      if (value.type === 'turn-end') {
        if (!lastTurn || value.seq > lastTurn.seq) lastTurn = structuredClone(value);
        return false;
      }
      if (value.type === 'gap') {
        partial = undefined;
        return true;
      }
      if (value.type === 'status' || value.type === 'ready') return false;
      if (value.type === 'message') {
        if (value.role === 'assistant' && partial && value.seq > partial.after)
          partial.messageSeen = true;
        const id = `event-${value.seq}`;
        saved.set(id, {
          id,
          sequence: value.seq,
          nativeId: value.id,
          role: value.role,
          text: value.text,
          ...(value.interrupted ? { label: 'Agent · 已中断' } : {}),
        });
        awaiting.delete(id);
        return false;
      }
      const frame = value.frame;
      if (frame.type === 'snapshot') {
        const active = frame.activeAttempt;
        if (frame.revision < streamRevision) return false;
        if (
          active &&
          ((frame.revision === streamRevision && streamAttempt?.id !== active.attemptId) ||
            (partial && frame.revision === partial.revision) ||
            (streamAttempt?.id === active.attemptId && active.nextIndex - 1 < streamAttempt.index))
        )
          return false;
        streamRevision = frame.revision;
        streamAttempt = active ? { id: active.attemptId, index: active.nextIndex - 1 } : undefined;
        partial = active
          ? {
              id: active.attemptId,
              revision: frame.revision,
              index: active.nextIndex - 1,
              text: active.text,
              tools: new Set(active.toolNames),
              messageSeen: [...saved.values(), ...awaiting.values()].some(
                (message) =>
                  message.role === 'assistant' && message.sequence > active.startedAfterSeq,
              ),
              after: active.startedAfterSeq,
            }
          : undefined;
        return false;
      }
      if (frame.type === 'start') {
        if (frame.revision >= streamRevision) {
          streamRevision = frame.revision;
          streamAttempt = { id: frame.attemptId, index: -1 };
        }
        if (partial) {
          partial = undefined;
          return true;
        }
        partial = {
          id: frame.attemptId,
          revision: frame.revision,
          index: -1,
          text: '',
          tools: new Set(),
          messageSeen: false,
          after: Math.max(-1, ...[...saved.values()].map((message) => message.sequence)),
        };
        return false;
      }
      if (!partial || partial.id !== frame.attemptId) return true;
      if (frame.revision <= partial.revision) return false;
      // C filters reasoning/tool payloads. Visible native indexes may skip values.
      if (frame.index <= partial.index) {
        partial = undefined;
        return true;
      }
      partial.index = frame.index;
      partial.revision = frame.revision;
      if (frame.revision >= streamRevision) {
        streamRevision = frame.revision;
        streamAttempt =
          frame.type === 'chunk' ? { id: frame.attemptId, index: frame.index } : undefined;
      }
      if (frame.type === 'chunk') {
        if (frame.text) partial.text = (partial.text + frame.text).slice(0, 262_144);
        if (frame.toolName && partial.tools.size < 128) partial.tools.add(frame.toolName);
      } else {
        if (
          frame.outcome.kind === 'committed' &&
          frame.outcome.eventType === 'assistant/message' &&
          partial.text
        ) {
          const id = `event-${frame.outcome.seq}`;
          if (!saved.has(id))
            awaiting.set(id, {
              id,
              sequence: frame.outcome.seq,
              role: 'assistant',
              text: partial.text,
              delivery: 'syncing',
            });
        }
        partial = undefined;
      }
      return false;
    },
    messages(): readonly NativeRunMessage[] {
      const durable = [...saved.values(), ...awaiting.values()].sort(
        (a, b) => a.sequence - b.sequence,
      );
      const recorded = new Set(durable.map((message) => message.nativeId).filter(Boolean));
      const pending: NativeRunMessage[] = (inbox?.items ?? [])
        .filter((item) => !recorded.has(item.id))
        .map((item) => ({
          id: `pending-${item.id}`,
          nativeId: item.id,
          sequence: -1,
          role: 'user',
          text: item.text,
          delivery: 'received',
        }));
      const streamed: NativeRunMessage[] =
        partial && !partial.messageSeen && (partial.text || partial.tools.size)
          ? [
              {
                id: `stream-${partial.id}`,
                sequence: -1,
                role: 'assistant',
                text: partial.text || `正在使用 ${[...partial.tools].join('、')}`,
                label:
                  partial.tools.size && !partial.text
                    ? `正在使用 ${[...partial.tools].join('、')}`
                    : 'Agent',
                delivery: 'streaming',
              },
            ]
          : [];
      return [...durable, ...streamed, ...pending];
    },
  };
}
