/** Projection contracts. These synthetic frames do not prove native streaming. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeConversationProjection } from '../dist/native-work-session-view.js';

const stream = (frame) => ({ type: 'assistant-stream', frame });
const start = (revision = 1) => stream({ type: 'start', attemptId: 'attempt-1', revision });
const chunk = (index, revision, content, attemptId = 'attempt-1') =>
  stream({
    type: 'chunk',
    attemptId,
    index,
    revision,
    chunk: content,
  });

test('view contract: durable turn end exposes only a fixed reason kind and never private failure or cancellation details', () => {
  for (const kind of [
    'completed',
    'blocked',
    'max-tokens',
    'error',
    'aborted',
    'interrupted',
    'forked',
  ]) {
    const view = new NativeConversationProjection('session');
    const frame = view.push({
      type: 'event',
      event: {
        seq: 12,
        time: 17,
        type: 'turn/end',
        data: {
          turn: 2,
          reason: {
            kind,
            error: { message: 'private-provider-key-or-path', code: 'private-code' },
            reason: { kind: 'hook', reason: 'private-hook-path' },
            replayState: 'private-replay',
          },
          request: 'private-request',
        },
      },
    });
    assert.deepEqual(frame, { type: 'turn-end', seq: 12, time: 17, turn: 2, reason: { kind } });
    assert.equal(JSON.stringify(frame).includes('private'), false);
  }
});

test('view contract: unknown turn reasons are coarse and malformed boundaries are never guessed as completed', () => {
  const event = {
    seq: 1,
    time: 2,
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'private-new-provider-reason' } },
  };
  assert.deepEqual(new NativeConversationProjection('session').push({ type: 'event', event }), {
    type: 'turn-end',
    seq: 1,
    time: 2,
    turn: 1,
    reason: { kind: 'unknown' },
  });
  for (const data of [
    { turn: 0 },
    { turn: 1.5 },
    { turn: Number.MAX_SAFE_INTEGER + 1 },
    { reason: { kind: 'completed' } },
  ])
    assert.equal(
      new NativeConversationProjection('session').push({
        type: 'event',
        event: { ...event, data },
      }),
      undefined,
    );
});

test('view contract: only textual body and necessary tool names cross the stream projection', () => {
  const view = new NativeConversationProjection('native-session');
  const frames = [view.push(start())];
  for (const [index, content] of [
    { type: 'reasoning-delta', text: 'synthetic-private-reasoning' },
    { type: 'usage', usage: { credential: 'synthetic-private-credential' } },
    { type: 'text-delta', text: 'visible body', providerMetadata: 'private-provider-data' },
    { type: 'tool-call-delta', name: 'read_file', argumentsDelta: 'synthetic-private-arguments' },
    { type: 'tool-call-delta', name: 'read_file', argumentsDelta: 'more-private-arguments' },
    { type: 'finish', replayState: { credential: 'private-replay' } },
  ].entries()) {
    const frame = view.push(chunk(index, index + 2, content));
    if (frame) frames.push(frame);
  }
  assert.deepEqual(frames[1].frame, {
    type: 'chunk',
    attemptId: 'attempt-1',
    revision: 4,
    index: 2,
    text: 'visible body',
  });
  assert.equal(frames[2].frame.toolName, 'read_file');
  assert.equal(frames.length, 3);
  assert.equal(
    /private-|credential|arguments|reasoning|replay/iu.test(JSON.stringify(frames)),
    false,
  );
});

test('view contract: duplicate revisions are ignored and wrong attempts or missing native indices produce a gap', () => {
  for (const fault of ['attempt', 'index']) {
    const view = new NativeConversationProjection('session');
    view.push(start());
    const first = chunk(0, 2, { type: 'text-delta', text: 'once' });
    assert.equal(view.push(first).frame.text, 'once');
    assert.equal(view.push(first), undefined);
    assert.deepEqual(
      view.push(
        chunk(
          fault === 'index' ? 3 : 1,
          3,
          { type: 'text-delta', text: 'must not appear' },
          fault === 'attempt' ? 'wrong-attempt' : 'attempt-1',
        ),
      ),
      { type: 'gap', after: -1 },
    );
  }
  const joinedLate = new NativeConversationProjection('session', 42);
  assert.deepEqual(
    joinedLate.push(chunk(5, 20, { type: 'text-delta', text: 'not a complete prefix' })),
    { type: 'gap', after: 42 },
  );
});

test('view contract: durable assistant text and stream settlement share one key without exposing raw source or runtime events', () => {
  const view = new NativeConversationProjection('session');
  for (const type of ['system/message', 'runtime/message', 'tool/result', 'assistant/attempt'])
    assert.equal(
      view.push({ type: 'event', event: { seq: 0, time: 1, type, data: { text: 'hidden' } } }),
      undefined,
    );
  assert.equal(
    view.push({
      type: 'event',
      event: {
        seq: 1,
        time: 1,
        type: 'user/message',
        data: {
          id: 'runtime-as-user',
          source: { kind: 'runtime' },
          content: [{ type: 'text', text: 'hidden' }],
        },
      },
    }),
    undefined,
  );
  view.push(start());
  view.push(chunk(0, 2, { type: 'text-delta', text: 'body' }));
  const committed = view.push({
    type: 'event',
    event: {
      seq: 2,
      time: 3,
      type: 'assistant/message',
      data: {
        interrupted: true,
        message: {
          id: 'message-1',
          source: { kind: 'model', provider: 'private-provider', replayState: 'hidden' },
          content: [
            { type: 'reasoning', text: 'private-reasoning' },
            { type: 'text', text: 'body' },
          ],
        },
      },
    },
  });
  const end = view.push(
    stream({
      type: 'end',
      attemptId: 'attempt-1',
      revision: 3,
      index: 1,
      outcome: { kind: 'committed', seq: 2, eventType: 'assistant/message' },
    }),
  );
  assert.equal(committed.messageKey, end.frame.outcome.messageKey);
  assert.equal(committed.interrupted, true);
  assert.equal(committed.text, 'body');
  assert.equal(JSON.stringify([committed, end]).includes('private'), false);
});
