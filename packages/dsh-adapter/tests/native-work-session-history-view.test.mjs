/** Fixed presentation and cursor contracts; synthetic records are not SDK proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publicNativeHistoryEvent,
  publicNativeHistoryPage,
} from '../dist/native-work-session-history-view.js';

const message = (seq, text) => ({
  seq,
  time: seq,
  type: 'assistant/message',
  data: {
    message: {
      id: `m-${seq}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'PRIVATE' },
      content: [
        { type: 'text', text },
        { type: 'tool-call', arguments: 'PRIVATE' },
      ],
    },
    stream: 'PRIVATE'.repeat(50000),
    private: 'PRIVATE',
  },
});
test('public history contract: budget the whitelist, retain redacted cursors and safe turn kinds', () => {
  const original = [
    { seq: 0, time: 0, type: 'request/context', data: { private: 'PRIVATE'.repeat(50000) } },
    message(1, 'Visible message'),
    { seq: 2, time: 2, type: 'tool/call', data: { name: 'complete_work', arguments: 'PRIVATE' } },
    {
      seq: 3,
      time: 3,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', message: 'PRIVATE' } },
    },
  ];
  const before = structuredClone(original),
    page = publicNativeHistoryPage(original);
  assert.deepEqual(
    page.map((e) => e.seq),
    [0, 1, 2, 3],
  );
  assert.equal(page[0].type, 'redacted');
  assert.deepEqual(page[3].data, { turn: 1, reason: { kind: 'error' } });
  assert.equal(JSON.stringify(page).includes('PRIVATE'), false);
  assert.deepEqual(original, before);
  assert.deepEqual(
    page.map(publicNativeHistoryEvent),
    page,
    'Existing Host whitelist remains idempotent',
  );
});
test('public history contract: return the bounded original prefix without losing or skipping any sequence', () => {
  const original = [
    message(4, '中'.repeat(50000)),
    message(5, '中'.repeat(50000)),
    message(6, 'Last'),
  ];
  const page = publicNativeHistoryPage(original);
  assert.deepEqual(
    page.map((e) => e.seq),
    [4],
  );
  assert(Buffer.byteLength(JSON.stringify(page)) <= 262144);
  assert.equal(page[0].data.message.content[0].text, original[0].data.message.content[0].text);
  const tail = publicNativeHistoryPage(original.filter((e) => e.seq > page.at(-1).seq));
  assert.deepEqual(
    [...page, ...tail].map((e) => e.seq),
    [4, 5, 6],
  );
  assert.throws(
    () => publicNativeHistoryPage([message(7, '中'.repeat(100000)), message(8, 'must not skip')]),
    { code: 'capacity' },
  );
});
