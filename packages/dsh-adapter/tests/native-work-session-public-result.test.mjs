/** Projection contracts only. Actual SDK/authority proof is in the matching spec. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  publicNativeResultEvent,
  NativePublicResultProjection,
} from '../dist/native-work-session-public-result.js';

const large = '中'.repeat(100000);
const args = JSON.stringify({ text: large, links: [] });
const event = (type, data) => ({ seq: 9, time: 123, type, data, sourceEventSeqs: [8] });
const block = (name = 'complete_work') => ({
  type: 'tool-call',
  id: name === 'complete_work' ? 'call' : 'other-call',
  name,
  arguments: args,
});
const metadata = (value, field) => {
  assert.equal(Object.hasOwn(value, field), false);
  const marker = value.zhumaNativeResultProjection;
  assert.equal(marker.version, 1);
  assert.equal(marker.omitted, field);
  assert.equal(marker.bytes, Buffer.byteLength(args));
  assert.equal(marker.sha256, createHash('sha256').update(args).digest('hex'));
};

test('public result contract: explicit tool arguments become trace metadata without changing native event identity or original data', () => {
  const native = event('tool/call', {
    turn: 2,
    step: 1,
    callId: 'call',
    name: 'complete_work',
    arguments: args,
  });
  const original = JSON.stringify(native);
  const result = publicNativeResultEvent(native);
  assert.deepEqual({ ...result, data: undefined }, { ...native, data: undefined });
  assert.equal(result.data.callId, 'call');
  assert.equal(result.data.name, 'complete_work');
  metadata(result.data, 'arguments');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
  assert.equal(JSON.stringify(native), original);
  assert.equal(native.data.arguments, args);
});

test('public result contract: known message/compact carriers change while mixed chat, other tools and opaque replay stay intact', () => {
  const native = event('assistant/message', {
    turn: 2,
    step: 1,
    message: {
      id: 'message',
      role: 'assistant',
      source: { kind: 'model', replayState: { private: args } },
      content: [{ type: 'text', text: 'Normal text.' }, block(), block('other_tool')],
    },
    stream: [
      { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
      {
        type: 'tool-call-chunks',
        time0: 1,
        index: 0,
        id: 'call',
        name: 'complete_work',
        dt: [1],
        args: [args.slice(0, 10), args.slice(10)],
      },
      {
        type: 'tool-call-chunks',
        time0: 3,
        index: 0,
        id: 'call',
        dt: [],
        args: ['unnamed continuation'],
      },
      { type: 'chunk', time: 4, chunk: { type: 'block-end', index: 0, block: block() } },
      {
        type: 'chunk',
        time: 5,
        chunk: { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { private: args } },
      },
    ],
  });
  const original = JSON.stringify(native);
  const result = publicNativeResultEvent(native);
  assert.equal(result.data.message.id, 'message');
  assert.deepEqual(result.data.message.content[0], native.data.message.content[0]);
  metadata(result.data.message.content[1], 'arguments');
  assert.equal(
    result.data.message.content[2],
    native.data.message.content[2],
    'Other tools are never summarized by this seam',
  );
  assert.equal(result.data.stream[1].args, undefined);
  assert.deepEqual(result.data.stream[1].dt, [1]);
  assert.equal(result.data.stream[2].args, undefined);
  metadata(result.data.stream[3].chunk.block, 'arguments');
  assert.equal(result.data.stream[4].chunk.replayState, native.data.stream[4].chunk.replayState);
  assert.equal(result.data.message.source.replayState, native.data.message.source.replayState);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) > 262144,
    'Unlocatable opaque/other-tool content keeps its original public limit',
  );
  assert.deepEqual(result.data.stream[4].chunk.reason, { kind: 'tool-calls' });
  assert.equal(JSON.stringify(native), original);
});

test('public result contract: stopped attempt compact arguments can be projected without a completed message', () => {
  const native = event('assistant/attempt', {
    turn: 1,
    step: 4,
    stream: [
      {
        type: 'tool-call-chunks',
        time0: 1,
        index: 0,
        id: 'call',
        name: 'complete_work',
        dt: [],
        args: [args],
      },
    ],
  });
  const result = publicNativeResultEvent(native);
  assert.equal(result.seq, native.seq);
  assert.equal(result.type, 'assistant/attempt');
  assert.equal(result.data.stream[0].args, undefined);
  assert.equal(native.data.stream[0].args[0], args);
});

test('public result contract: live unnamed chunks remain linked to the original attempt and reset between turns', () => {
  const projection = new NativePublicResultProjection();
  const frame = (type, rest = {}) => ({
    type: 'assistant-stream',
    frame: { type, attemptId: 'attempt', revision: 10, ...rest },
  });
  const start = frame('start');
  assert.equal(projection.frame(start), start);
  const first = frame('chunk', {
    index: 0,
    chunk: {
      type: 'tool-call-delta',
      index: 2,
      id: 'call',
      name: 'complete_work',
      argumentsDelta: args,
    },
  });
  metadata(projection.frame(first).frame.chunk, 'argumentsDelta');
  const next = frame('chunk', {
    index: 1,
    chunk: { type: 'tool-call-delta', index: 2, id: 'call', argumentsDelta: args },
  });
  metadata(projection.frame(next).frame.chunk, 'argumentsDelta');
  const end = frame('end', {
    index: 2,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 },
  });
  assert.equal(projection.frame(end), end);
  assert.equal(
    projection.frame(next),
    next,
    'An old attempt never keeps redaction state after its end',
  );
  const fresh = new NativePublicResultProjection();
  assert.equal(
    fresh.frame(next),
    next,
    "A separate reader cannot inherit another reader's tool identity",
  );
});

test('public result contract: ordinary tools, messages, ACK results, status and unknown carriers retain existing semantics', () => {
  const projection = new NativePublicResultProjection();
  for (const native of [
    event('tool/call', { name: 'other_tool', arguments: args }),
    event('tool/call', { name: 'complete_work_extra', arguments: args }),
    event('user/message', { role: 'user', content: [{ type: 'text', text: large }] }),
    event('assistant/message', {
      message: {
        content: [{ type: 'text', text: large }],
        source: { kind: 'model', replayState: args },
      },
    }),
    event('tool/result', {
      message: {
        toolCallId: 'call',
        isError: false,
        content: [{ type: 'text', text: '{"ok":true,"phase":"declared"}' }],
      },
    }),
    event('turn/end', { turn: 1, reason: { kind: 'cancelled' } }),
  ])
    assert.equal(publicNativeResultEvent(native), native);
  for (const frame of [
    { type: 'status', status: 'idle' },
    { type: 'gap', after: 12 },
  ])
    assert.equal(projection.frame(frame), frame);
});

test('public result contract: a source beyond the existing 8MiB cut policy stays subject to public capacity rejection', () => {
  const native = event('tool/call', {
    name: 'complete_work',
    callId: 'call',
    arguments: 'x'.repeat(8 * 1024 * 1024 + 1),
  });
  assert.equal(publicNativeResultEvent(native), native);
  assert.ok(Buffer.byteLength(JSON.stringify(native)) > 262144);
});

test('public result contract: late, changed or out-of-order identities never borrow a previous call classification', () => {
  const projection = new NativePublicResultProjection();
  const wrap = (chunk, extra = {}) => ({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt', revision: 1, index: 0, chunk, ...extra },
  });
  projection.frame({
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'attempt', revision: 0 },
  });
  const early = wrap({ type: 'tool-call-delta', index: 1, id: 'call', argumentsDelta: args });
  assert.equal(projection.frame(early), early);
  const named = wrap({
    type: 'tool-call-delta',
    index: 1,
    id: 'call',
    name: 'complete_work',
    argumentsDelta: args,
  });
  const first = projection.frame(named);
  assert.deepEqual(
    projection.frame(named),
    first,
    'Duplicate framing produces the same trace metadata',
  );
  const otherIndex = wrap({ type: 'tool-call-delta', index: 2, id: 'call', argumentsDelta: args });
  assert.equal(projection.frame(otherIndex), otherIndex);
  const otherCall = wrap({
    type: 'tool-call-delta',
    index: 1,
    id: 'other-call',
    argumentsDelta: args,
  });
  assert.equal(projection.frame(otherCall), otherCall);
  assert.equal(
    projection.frame(early),
    early,
    'A changed call ID invalidates the old index classification',
  );
  projection.frame(named);
  const otherTool = wrap({
    type: 'tool-call-delta',
    index: 1,
    id: 'call',
    name: 'other_tool',
    argumentsDelta: args,
  });
  assert.equal(projection.frame(otherTool), otherTool);
  assert.equal(projection.frame(early), early);
  projection.frame(named);
  projection.frame(wrap({ type: 'block-end', index: 1, block: block() }));
  assert.equal(projection.frame(early), early, 'Closing a block clears its private classification');
  assert.equal(
    projection.frame({ ...early, frame: { ...early.frame, attemptId: 'foreign' } }).frame.chunk,
    early.frame.chunk,
  );
});
