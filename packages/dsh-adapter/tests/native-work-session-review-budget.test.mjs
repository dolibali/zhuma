/** Argument/projection contracts only; SDK admission is tested separately. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_REVIEW_LIMITS,
  parseNativeReviewArguments,
} from '../dist/native-work-session-review-contract.js';
import { describeNativeReviewTool } from '../dist/native-work-session-review-tool.js';
import {
  publicNativeResultEvent,
  NativePublicResultProjection,
} from '../dist/native-work-session-public-result.js';
import { content } from './native-work-session-review-fixture.mjs';

test('review argument byte contract: ASCII/UTF-8 normal content survives intact; character limit does not override total JSON bytes', () => {
  for (const rationale of ['x'.repeat(100000), '审'.repeat(30000)]) {
    const input = { ...content(), rationale };
    assert.equal(parseNativeReviewArguments(input, JSON.stringify(input)).rationale, rationale);
  }
  for (const rationale of ['审'.repeat(100000), '🙂'.repeat(50000)])
    assert.throws(() => parseNativeReviewArguments({ ...content(), rationale }), {
      code: 'output-too-large',
    });
  assert.equal(NATIVE_REVIEW_LIMITS.argumentBytes, 120000);
  assert.match(describeNativeReviewTool().description, /120000 UTF-8 bytes/);
});

test('review argument byte contract: exact serialized boundary includes syntax, escaping and SDK call whitespace', () => {
  const value = content();
  const serialized = JSON.stringify(value);
  const remaining = NATIVE_REVIEW_LIMITS.argumentBytes - Buffer.byteLength(serialized);
  assert.deepEqual(parseNativeReviewArguments(value, serialized + ' '.repeat(remaining)), value);
  assert.throws(() => parseNativeReviewArguments(value, serialized + ' '.repeat(remaining + 1)), {
    code: 'output-too-large',
  });
  assert.throws(() => parseNativeReviewArguments({ ...value, rationale: '\u0000'.repeat(30000) }), {
    code: 'output-too-large',
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const raw of [undefined, cyclic, { ...value, rationale: ' ' }])
    assert.throws(() => parseNativeReviewArguments(raw), { code: 'invalid-arguments' });
});

test('review public projection: only the exact completion tool is summarized, with identity/order/native source unchanged', () => {
  const argumentsText = JSON.stringify({ ...content(), rationale: '审'.repeat(30000) });
  const source = {
    seq: 7,
    time: 2,
    type: 'tool/call',
    sourceEventSeqs: [6],
    data: { name: 'complete_review', callId: 'review-call', arguments: argumentsText },
  };
  const original = JSON.stringify(source);
  const view = publicNativeResultEvent(source);
  assert.equal(view.seq, source.seq);
  assert.deepEqual(view.sourceEventSeqs, source.sourceEventSeqs);
  assert.equal(view.data.arguments, undefined);
  assert.equal(view.data.zhumaNativeResultProjection.bytes, Buffer.byteLength(argumentsText));
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 2048);
  assert.equal(JSON.stringify(source), original);
  for (const name of ['complete_review_extra', 'read_review_target', 'arbitrary_tool']) {
    const ordinary = { ...source, data: { ...source.data, name } };
    assert.equal(publicNativeResultEvent(ordinary), ordinary);
  }
});

test('review public projection: named and unnamed live chunks/compact carriers retain exact tool and attempt boundaries', () => {
  const p = new NativePublicResultProjection();
  const frame = (type, rest = {}) => ({
    type: 'assistant-stream',
    frame: { type, attemptId: 'attempt', revision: 1, ...rest },
  });
  p.frame(frame('start'));
  const chunk = frame('chunk', {
    chunk: {
      type: 'tool-call-delta',
      index: 0,
      id: 'review-call',
      name: 'complete_review',
      argumentsDelta: 'large',
    },
  });
  assert.equal(p.frame(chunk).frame.chunk.argumentsDelta, undefined);
  const next = frame('chunk', {
    chunk: { type: 'tool-call-delta', index: 0, id: 'review-call', argumentsDelta: 'continuation' },
  });
  assert.equal(p.frame(next).frame.chunk.argumentsDelta, undefined);
  p.frame(frame('end'));
  assert.equal(p.frame(next), next);
  const event = {
    seq: 8,
    time: 3,
    type: 'assistant/attempt',
    data: {
      turn: 1,
      step: 2,
      stream: [
        {
          type: 'tool-call-chunks',
          index: 0,
          id: 'review-call',
          name: 'complete_review',
          args: ['large'],
          dt: [],
        },
      ],
    },
  };
  assert.equal(publicNativeResultEvent(event).data.stream[0].args, undefined);
  assert.deepEqual(event.data.stream[0].args, ['large']);
});
