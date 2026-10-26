import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conversationLines,
  readConversationFrame,
  readNativeInbox,
} from '../dist/run/conversation.js';
import { createConversationState } from '../dist/run/conversation-state.js';

// Client wire/presentation contracts only; fixtures do not establish authority.
const target = {
  spaceId: 'north',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'run',
  generation: 1,
  segmentId: 'segment',
};
const run = { ...target, native: { sessionId: 'native' } };
const wire = (frame) => ({ target, sessionId: 'native', ...frame });
const stream = (frame) => ({ type: 'assistant-stream', frame: { attemptId: 'attempt', ...frame } });
const inbox = {
  asOfSeq: 5,
  receipts: [{ requestId: 'request', messageId: 'pending', mode: 'queue', status: 'received' }],
  items: [
    {
      id: 'pending',
      text: 'queued body',
      requestId: 'request',
      target: 'next-turn',
      mode: 'queue',
      status: 'received',
    },
  ],
};

test('conversation wire contract: exact Run/session and canonical message key; extra private fields never become view props', () => {
  const message = {
    type: 'message',
    seq: 8,
    time: 1,
    id: 'message',
    messageKey: 'native:seq:8',
    role: 'assistant',
    text: 'public body',
    reasoning: 'PRIVATE',
  };
  const parsed = readConversationFrame(wire(message), run, 'north');
  assert.equal(parsed.text, 'public body');
  assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false);
  for (const value of [
    { ...wire(message), target: { ...target, generation: 2 } },
    { ...wire(message), sessionId: 'other' },
    wire({ ...message, messageKey: 'other:seq:8' }),
    wire({
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'attempt', revision: 1, index: 2, reasoning: 'PRIVATE' },
    }),
  ])
    assert.throws(() => readConversationFrame(value, run, 'north'), { code: 'validation' });
});

test('conversation inbox contract: received/claimed stay distinct and inconsistent or duplicate pending references reject', () => {
  assert.deepEqual(readNativeInbox(wire(inbox), run, 'north'), inbox);
  assert.throws(
    () =>
      readNativeInbox(
        wire({ ...inbox, receipts: [{ ...inbox.receipts[0], status: 'claimed' }] }),
        run,
        'north',
      ),
    { code: 'validation' },
  );
  assert.throws(
    () =>
      readNativeInbox(wire({ ...inbox, items: [...inbox.items, ...inbox.items] }), run, 'north'),
    { code: 'validation' },
  );
});

test('conversation projection contract: sparse visible indexes stream early and one durable record replaces partial/end text', () => {
  const state = createConversationState();
  assert.equal(state.frame(stream({ type: 'start', revision: 0 })), false);
  assert.equal(
    state.frame(stream({ type: 'chunk', revision: 2, index: 3, text: 'partial ' })),
    false,
  );
  assert.equal(state.frame(stream({ type: 'chunk', revision: 5, index: 8, text: 'body' })), false);
  assert.equal(state.messages()[0].text, 'partial body');
  assert.equal(state.messages()[0].delivery, 'streaming');
  state.frame({ type: 'message', seq: 20, id: 'final', role: 'assistant', text: 'complete body' });
  assert.equal(state.messages().length, 1, 'final native event may precede stream end');
  state.frame(
    stream({
      type: 'end',
      revision: 6,
      index: 9,
      outcome: {
        kind: 'committed',
        eventType: 'assistant/message',
        seq: 20,
        messageKey: 'native:seq:20',
      },
    }),
  );
  state.history(
    [{ id: 'event-20', sequence: 20, nativeId: 'final', role: 'assistant', text: 'complete body' }],
    21,
  );
  assert.equal(state.messages().length, 1);
  assert.equal(state.messages()[0].text, 'complete body');
});

test('conversation projection contract: pending becomes a single saved user record; claimed is never rendered as model adoption', () => {
  const state = createConversationState();
  state.inbox(inbox);
  assert.equal(state.messages()[0].delivery, 'received');
  state.frame({ type: 'message', seq: 9, id: 'pending', role: 'user', text: 'queued body' });
  assert.equal(state.messages().length, 1);
  assert.equal(state.messages()[0].delivery, undefined);
  state.inbox({ asOfSeq: 9, receipts: [{ ...inbox.receipts[0], status: 'claimed' }], items: [] });
  assert.equal(JSON.stringify(state.messages()).includes('adopted'), false);
});

test('conversation projection contract: gaps/abandoned attempts remove transient body; committed attempts are not fabricated messages', () => {
  const state = createConversationState();
  const start = () => {
    state.frame(stream({ type: 'start', revision: 0 }));
    state.frame(stream({ type: 'chunk', revision: 1, index: 0, text: 'provisional' }));
  };
  start();
  assert.equal(state.frame({ type: 'gap', after: 999 }), true);
  assert.deepEqual(state.messages(), []);
  start();
  state.frame(
    stream({
      type: 'end',
      revision: 2,
      index: 1,
      outcome: {
        kind: 'committed',
        eventType: 'assistant/attempt',
        seq: 1,
        messageKey: 'native:seq:1',
      },
    }),
  );
  assert.deepEqual(state.messages(), []);
  start();
  state.disconnect();
  assert.deepEqual(state.messages(), []);
});

test('conversation wire contract: split UTF-8 and multiple lines parse; partial JSON, invalid UTF-8 and oversize frames reject', async () => {
  const encoded = new TextEncoder().encode('{"text":"中文"}\n{"other":true}\n');
  const body = new ReadableStream({
    start(c) {
      for (const byte of encoded) c.enqueue(Uint8Array.of(byte));
      c.close();
    },
  });
  const values = [];
  for await (const value of conversationLines(body, new AbortController().signal))
    values.push(value);
  assert.deepEqual(values, [{ text: '中文' }, { other: true }]);
  for (const bytes of [
    new TextEncoder().encode('{"unfinished":'),
    Uint8Array.of(255, 10),
    new TextEncoder().encode('x'.repeat(512 * 1024 + 1)),
  ]) {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    await assert.rejects(async () => {
      for await (const value of conversationLines(body, new AbortController().signal)) void value;
    });
  }
});

test('conversation wire contract: cancelling a blocked read releases the body without a new command', async () => {
  let cancelled = 0;
  const controller = new AbortController();
  const body = new ReadableStream({
    cancel() {
      cancelled++;
    },
  });
  const iterator = conversationLines(body, controller.signal);
  const next = iterator.next();
  controller.abort();
  await assert.rejects(next, { name: 'AbortError' });
  assert.equal(cancelled, 1);
});
