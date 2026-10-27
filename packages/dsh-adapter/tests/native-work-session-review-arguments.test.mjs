/** UTF-8/escaping/envelope contracts; not actual SDK admission or scan proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_REVIEW_LIMITS,
  nativeReviewContentSchema,
  parseNativeReviewArguments,
} from '../dist/native-work-session-review-contract.js';
import { validateNativeReviewEvidence } from '../dist/native-work-session-review-source.js';
import { describeNativeReviewTool } from '../dist/native-work-session-review-tool.js';
import { content, manifest, runSource, scope } from './native-work-session-review-fixture.mjs';

const framed = (value) => ({
  type: 'event',
  scope,
  event: {
    seq: 3,
    time: 1,
    type: 'tool/call',
    data: {
      turn: 1,
      step: 2,
      callId: 'completion',
      name: 'complete_review',
      arguments: JSON.stringify(value),
    },
  },
});
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function sized(size) {
  const empty = { ...content(), rationale: '' },
    length = size - bytes(empty);
  return { ...empty, rationale: '审'.repeat(Math.floor(length / 3)) + 'x'.repeat(length % 3) };
}

test('review argument budget contract: Chinese, NUL escaping and quote/backslash overflows fail schema and evidence before declaration', () => {
  for (const rationale of [
    '审'.repeat(100000),
    '\u0000'.repeat(100000),
    '"'.repeat(100000),
    '\\'.repeat(100000),
  ]) {
    const input = { ...content(), rationale };
    assert.ok(bytes(framed(input)) > NATIVE_REVIEW_LIMITS.publicFrameBytes);
    assert.equal(nativeReviewContentSchema.safeParse(input).success, false);
    assert.throws(() => parseNativeReviewArguments(input), { code: 'output-too-large' });
    assert.throws(() => validateNativeReviewEvidence(input, manifest(), runSource(), 2), {
      code: 'output-too-large',
    });
  }
  for (const rationale of [
    'x'.repeat(100000),
    '审'.repeat(30000),
    '\u0000'.repeat(10000),
    '"'.repeat(50000),
    '\\'.repeat(50000),
  ]) {
    const input = { ...content(), rationale };
    assert.equal(parseNativeReviewArguments(input).rationale, rationale);
    assert.ok(
      bytes(framed(input)) + NATIVE_REVIEW_LIMITS.frameEnvelopeBytes <=
        NATIVE_REVIEW_LIMITS.publicFrameBytes,
    );
  }
});

test('review argument budget contract: exact serialized boundary, SDK source whitespace and pre-trim data are counted without truncation', () => {
  const boundary = sized(NATIVE_REVIEW_LIMITS.argumentBytes);
  assert.equal(bytes(boundary), 120000);
  assert.deepEqual(nativeReviewContentSchema.parse(boundary), boundary);
  assert.equal(parseNativeReviewArguments(boundary).rationale, boundary.rationale);
  const over = sized(NATIVE_REVIEW_LIMITS.argumentBytes + 1);
  assert.equal(bytes(over), 120001);
  assert.equal(nativeReviewContentSchema.safeParse(over).success, false);
  assert.throws(() => parseNativeReviewArguments(over), { code: 'output-too-large' });
  const input = content(),
    source = JSON.stringify(input);
  const padding = NATIVE_REVIEW_LIMITS.argumentBytes - Buffer.byteLength(source);
  assert.deepEqual(parseNativeReviewArguments(input, source + ' '.repeat(padding)), input);
  assert.throws(() => parseNativeReviewArguments(input, source + ' '.repeat(padding + 1)), {
    code: 'output-too-large',
  });
  const trimmed = { ...input, rationale: ' '.repeat(120000) + 'ok' };
  assert.equal(nativeReviewContentSchema.safeParse(trimmed).success, false);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const raw of [undefined, cyclic, { ...input, rationale: ' ' }])
    assert.throws(() => parseNativeReviewArguments(raw), { code: 'invalid-arguments' });
});

test('review argument budget contract: getter and reserved envelope agree with unchanged frame and scan limits', () => {
  assert.equal(NATIVE_REVIEW_LIMITS.publicFrameBytes, 262144);
  assert.equal(NATIVE_REVIEW_LIMITS.frameEnvelopeBytes, 16384);
  assert.equal(NATIVE_REVIEW_LIMITS.scanBytes, 8 * 1024 * 1024);
  assert.ok(
    2 * NATIVE_REVIEW_LIMITS.argumentBytes +
      Buffer.byteLength('{"arguments":""}') +
      NATIVE_REVIEW_LIMITS.frameEnvelopeBytes <
      NATIVE_REVIEW_LIMITS.publicFrameBytes,
  );
  const getter = describeNativeReviewTool();
  for (const text of [
    '100000 characters',
    '120000 UTF-8 bytes',
    '16384-byte',
    '262144-byte',
    'before intent/ACK without truncation',
  ])
    assert.ok(getter.description.includes(text), text);
});
