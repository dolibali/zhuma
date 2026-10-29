import { NativeWorkError, type NativeHistoryEvent } from './native-work-session-contract.js';
import { NativeConversationProjection } from './native-work-session-view.js';

const PAGE_BYTES = 262_144;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Fixed presentation whitelist. Original durable logs and result cuts are unchanged. */
export function publicNativeHistoryEvent(event: NativeHistoryEvent): NativeHistoryEvent {
  const base = { seq: event.seq, time: event.time };
  const data = record(event.data);
  if (event.type === 'turn/end') {
    const frame = new NativeConversationProjection('public-history').push({ type: 'event', event });
    if (frame?.type === 'turn-end')
      return { ...base, type: 'turn/end', data: { turn: frame.turn, reason: frame.reason } };
  }
  if (event.type === 'tool/call' && typeof data?.name === 'string')
    return { ...base, type: 'tool/call', data: { name: data.name.slice(0, 200) } };
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    const message = event.type === 'user/message' ? data : record(data?.message);
    const role = event.type === 'user/message' ? 'user' : 'assistant';
    if (
      message?.role === role &&
      record(message.source)?.kind === (role === 'user' ? 'user' : 'model') &&
      Array.isArray(message.content)
    ) {
      const content = message.content.flatMap((value: unknown) => {
        const item = record(value);
        return item?.type === 'text' && typeof item.text === 'string'
          ? [{ type: 'text', text: item.text.slice(0, 262144) }]
          : [];
      });
      const projected = {
        role,
        source: { kind: role === 'user' ? 'user' : 'model' },
        content,
        ...(typeof message.id === 'string' ? { id: message.id } : {}),
      };
      return {
        ...base,
        type: event.type,
        data: role === 'user' ? projected : { message: projected },
      };
    }
  }
  return { ...base, type: 'redacted', data: {} };
}

/** A maximal bounded prefix, including redacted cursor markers. Never skip an event
 * to fit a later one, truncate a visible message to the page budget or raise it. */
export function publicNativeHistoryPage(events: readonly NativeHistoryEvent[]) {
  const page: NativeHistoryEvent[] = [];
  let bytes = 2;
  for (const event of events) {
    const projected = publicNativeHistoryEvent(event);
    const size = Buffer.byteLength(JSON.stringify(projected)) + (page.length ? 1 : 0);
    if (bytes + size > PAGE_BYTES) {
      if (!page.length) throw new NativeWorkError('capacity');
      break;
    }
    page.push(projected);
    bytes += size;
  }
  return page;
}
