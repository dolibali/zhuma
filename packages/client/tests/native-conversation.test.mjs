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
const snapshot = (revision, activeAttempt) => ({
  type: 'assistant-stream',
  frame: { type: 'snapshot', revision, ...(activeAttempt ? { activeAttempt } : {}) },
});
const activeAttempt = (patch = {}) => ({
  attemptId: 'attempt',
  startedAfterSeq: 9,
  nextIndex: 4,
  text: 'visible prefix ',
  toolNames: ['skill'],
  ...patch,
});
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

test('conversation turn boundary: strict safe metadata preserves the durable reason without private diagnostics or changing running state', () => {
  const value = {
    type: 'turn-end',
    seq: 18,
    time: 19,
    turn: 2,
    reason: { kind: 'max-tokens', error: { message: 'PRIVATE_PATH_OR_KEY' } },
    replay: 'PRIVATE',
  };
  const parsed = readConversationFrame(wire(value), run, 'north');
  assert.deepEqual(parsed, {
    type: 'turn-end',
    seq: 18,
    time: 19,
    turn: 2,
    reason: { kind: 'max-tokens' },
  });
  assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false);
  for (const patch of [
    { seq: -1 },
    { turn: 0 },
    { time: Infinity },
    { reason: { kind: 'unvalidated-private-kind' } },
  ])
    assert.throws(() => readConversationFrame(wire({ ...value, ...patch }), run, 'north'));
  const state = createConversationState();
  state.frame(parsed);
  state.frame({ ...parsed, seq: 10, reason: { kind: 'completed' } });
  assert.deepEqual(state.turnEnd(), parsed);
  state.frame({ type: 'status', status: 'running' });
  assert.deepEqual(
    state.turnEnd(),
    parsed,
    'history boundary does not replace actual SDK status or submission',
  );
  state.clear();
  assert.equal(state.turnEnd(), undefined);
});

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

test('conversation snapshot wire: exact Run/session and visible baseline fields only, including empty prefix or no active attempt', () => {
  const value = snapshot(5, activeAttempt({ text: '' }));
  const raw = structuredClone(value);
  raw.frame.activeAttempt.reasoning = 'PRIVATE';
  raw.frame.activeAttempt.arguments = { token: 'PRIVATE' };
  raw.frame.raw = 'PRIVATE';
  assert.deepEqual(readConversationFrame(wire(raw), run, 'north'), value);
  assert.equal(
    JSON.stringify(readConversationFrame(wire(raw), run, 'north')).includes('PRIVATE'),
    false,
  );
  assert.deepEqual(readConversationFrame(wire(snapshot(6)), run, 'north'), snapshot(6));
});
test('conversation snapshot wire: original UTF-8 frame budget and strict cursor/tool-name bounds reject invalid or oversized baselines', () => {
  const encoder = new TextEncoder();
  const empty = snapshot(5, activeAttempt({ text: '', toolNames: [] }));
  const overhead = encoder.encode(JSON.stringify(empty)).byteLength;
  const exact = snapshot(5, activeAttempt({ text: 'x'.repeat(262_144 - overhead), toolNames: [] }));
  assert.equal(encoder.encode(JSON.stringify(exact)).byteLength, 262_144);
  assert.deepEqual(readConversationFrame(wire(exact), run, 'north'), exact);
  for (const value of [
    snapshot(-1, activeAttempt()),
    snapshot(Number.MAX_SAFE_INTEGER + 1),
    snapshot(5, activeAttempt({ startedAfterSeq: -2 })),
    snapshot(5, activeAttempt({ nextIndex: -1 })),
    snapshot(5, activeAttempt({ nextIndex: Number.MAX_SAFE_INTEGER + 1 })),
    snapshot(5, activeAttempt({ attemptId: '' })),
    snapshot(5, activeAttempt({ text: exact.frame.activeAttempt.text + 'x', toolNames: [] })),
    snapshot(5, activeAttempt({ text: '中'.repeat(90_000) })),
    ...[
      null,
      [''],
      ['skill', 'skill'],
      ['tool\nprivate'],
      ['tool\u007f'],
      ['x'.repeat(201)],
      Array.from({ length: 129 }, (_, index) => `tool-${index}`),
      [{ name: 'skill', arguments: 'PRIVATE' }],
    ].map((toolNames) => snapshot(5, activeAttempt({ toolNames }))),
  ])
    assert.throws(() => readConversationFrame(wire(value), run, 'north'), { code: 'validation' });
  assert.throws(
    () =>
      readConversationFrame({ ...wire(empty), target: { ...target, generation: 2 } }, run, 'north'),
    { code: 'validation' },
  );
  assert.throws(() => readConversationFrame({ ...wire(empty), sessionId: 'other' }, run, 'north'), {
    code: 'validation',
  });
});
test('conversation snapshot projection: a late observer shows the existing prefix and appends newer sparse-index chunks', () => {
  const state = createConversationState();
  state.history([{ id: 'event-9', sequence: 9, role: 'user', text: 'goal' }], 9);
  assert.equal(state.frame(snapshot(5, activeAttempt())), false);
  assert.equal(state.messages().length, 2);
  assert.equal(state.messages()[1].text, 'visible prefix ');
  assert.equal(state.messages()[1].delivery, 'streaming');
  assert.equal(
    state.frame(stream({ type: 'chunk', revision: 8, index: 7, text: 'continues' })),
    false,
  );
  assert.equal(state.messages()[1].text, 'visible prefix continues');
  state.frame(stream({ type: 'chunk', revision: 7, index: 6, text: 'STALE' }));
  assert.equal(state.messages()[1].text, 'visible prefix continues');
});
test('conversation snapshot projection: stale baselines cannot overwrite newer partials, while same-revision reconnect restores a lost partial', () => {
  const state = createConversationState();
  state.frame(snapshot(5, activeAttempt()));
  state.frame(stream({ type: 'chunk', revision: 8, index: 7, text: 'continues' }));
  state.frame(snapshot(5, activeAttempt({ text: 'STALE' })));
  state.frame(snapshot(7));
  assert.equal(state.messages()[0].text, 'visible prefix continues');
  state.disconnect();
  assert.deepEqual(state.messages(), []);
  state.frame(snapshot(7, activeAttempt({ text: 'STALE' })));
  assert.deepEqual(state.messages(), []);
  state.frame(snapshot(8, activeAttempt({ nextIndex: 4, text: 'STALE' })));
  assert.deepEqual(
    state.messages(),
    [],
    'a same-revision reconnect still cannot roll back the known index',
  );
  const baseline = snapshot(8, activeAttempt({ nextIndex: 8, text: 'visible prefix continues' }));
  assert.equal(state.frame(baseline), false);
  assert.equal(state.messages()[0].text, 'visible prefix continues');
  state.frame(snapshot(8, activeAttempt({ nextIndex: 4, text: 'STALE' })));
  assert.equal(state.messages()[0].text, 'visible prefix continues');
  state.frame(stream({ type: 'chunk', revision: 9, index: 11, text: ' again' }));
  assert.equal(state.messages()[0].text, 'visible prefix continues again');
  state.clear();
  state.frame(snapshot(0, activeAttempt({ nextIndex: 0, startedAfterSeq: -1, text: 'new scope' })));
  assert.equal(state.messages()[0].text, 'new scope');
});
test('conversation snapshot projection: a durable assistant after the start cursor suppresses duplicate partial before and after commit', () => {
  const state = createConversationState();
  state.history(
    [{ id: 'event-12', sequence: 12, nativeId: 'final', role: 'assistant', text: 'durable body' }],
    12,
  );
  assert.equal(state.frame(snapshot(5, activeAttempt())), false);
  assert.equal(state.messages().length, 1);
  state.frame(
    stream({
      type: 'end',
      revision: 6,
      index: 4,
      outcome: {
        kind: 'committed',
        eventType: 'assistant/message',
        seq: 12,
        messageKey: 'native:seq:12',
      },
    }),
  );
  assert.equal(state.messages().length, 1);
  assert.equal(state.messages()[0].text, 'durable body');
  state.frame(
    snapshot(
      7,
      activeAttempt({
        attemptId: 'next-attempt',
        startedAfterSeq: 12,
        nextIndex: 0,
        text: 'new work',
      }),
    ),
  );
  assert.equal(
    state.messages().length,
    2,
    'older durable assistant must not suppress a new attempt',
  );
  state.frame({
    type: 'message',
    seq: 15,
    messageKey: 'native:seq:15',
    id: 'next-final',
    role: 'assistant',
    text: 'next durable',
  });
  assert.equal(state.messages().length, 2);
  assert.equal(state.messages()[1].text, 'next durable');
});
test('conversation snapshot projection: an invalid forward index keeps the original gap recovery, and later history replaces restored partial once', () => {
  const state = createConversationState();
  state.frame(snapshot(5, activeAttempt()));
  assert.equal(
    state.frame(stream({ type: 'chunk', revision: 6, index: 3, text: 'INVALID' })),
    true,
  );
  assert.deepEqual(state.messages(), []);
  state.frame(snapshot(6, activeAttempt({ nextIndex: 4, text: 'restored prefix' })));
  assert.equal(state.messages()[0].text, 'restored prefix');
  state.history(
    [{ id: 'event-12', sequence: 12, nativeId: 'final', role: 'assistant', text: 'final history' }],
    12,
  );
  assert.equal(state.messages().length, 1);
  assert.equal(state.messages()[0].text, 'final history');
  state.frame(
    snapshot(
      7,
      activeAttempt({ attemptId: 'next', nextIndex: 0, startedAfterSeq: 12, text: 'next attempt' }),
    ),
  );
  assert.equal(state.messages().length, 2);
  assert.equal(state.messages()[1].text, 'next attempt');
});
test('conversation snapshot projection: no-active clears only transient text/tools and retains durable, syncing and pending messages', () => {
  const state = createConversationState();
  state.history([{ id: 'event-9', sequence: 9, role: 'user', text: 'saved goal' }], 9);
  state.inbox(inbox);
  state.frame(snapshot(5, activeAttempt({ text: '' })));
  assert.ok(state.messages().some((message) => message.text === '正在使用 skill'));
  assert.equal(state.frame(snapshot(6)), false);
  assert.equal(state.messages().length, 2);
  state.frame(snapshot(6, activeAttempt({ text: 'STALE' })));
  assert.equal(
    state.messages().length,
    2,
    'an inactive baseline cannot be resurrected at the same revision',
  );
  assert.equal(
    state.messages().some((message) => message.delivery === 'streaming'),
    false,
  );
  state.frame(snapshot(7, activeAttempt({ text: 'committed prefix' })));
  state.frame(
    stream({
      type: 'end',
      revision: 8,
      index: 4,
      outcome: {
        kind: 'committed',
        eventType: 'assistant/message',
        seq: 12,
        messageKey: 'native:seq:12',
      },
    }),
  );
  assert.equal(
    state.messages().find((message) => message.delivery === 'syncing')?.text,
    'committed prefix',
  );
  state.frame(snapshot(9));
  assert.equal(state.messages().length, 3);
  assert.equal(state.messages().find((message) => message.delivery === 'syncing')?.sequence, 12);
  state.history(
    [
      {
        id: 'event-12',
        sequence: 12,
        nativeId: 'native-final',
        role: 'assistant',
        text: 'committed body',
      },
    ],
    12,
  );
  assert.equal(state.messages().length, 3);
  assert.equal(
    state.messages().some((message) => message.delivery === 'syncing'),
    false,
  );
});
