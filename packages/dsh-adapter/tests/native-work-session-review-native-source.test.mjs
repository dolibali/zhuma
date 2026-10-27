/** Synthetic SDK-event corruption contracts, never actual read/authority proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolResultMessage } from '@deepseek-ai/dsh-llm';
import {
  binding,
  context,
  page,
  evidence,
  manifest,
  content,
  runSource,
} from './native-work-session-review-fixture.mjs';
import { nativeReviewReadRef } from '../dist/native-work-session-review-contract.js';
import { validateNativeReviewEvidence } from '../dist/native-work-session-review-source.js';
import {
  nativeReviewAck,
  nativeReviewDeclaration,
  assertNativeReviewDeclaration,
  qualifyNativeFixedReview,
} from '../dist/native-work-session-review-native-source.js';

function fixture() {
  const readPage = page(),
    review = content(),
    checked = validateNativeReviewEvidence(review, manifest(), runSource(), 2);
  const intent = {
    protocolVersion: 1,
    toolVersion: 'zhuma-native-review-intent@1',
    intentId: 'intent',
    callId: 'completion',
    digest: checked.digest,
    readManifestDigest: checked.readManifestDigest,
  };
  const call = (seq, callId, name, args, step) => ({
    seq,
    time: seq,
    type: 'tool/call',
    data: { turn: 1, step, callId, name, arguments: JSON.stringify(args) },
  });
  const result = (seq, callId, value, source, step) => ({
    seq,
    time: seq,
    type: 'tool/result',
    sourceEventSeqs: [source],
    data: {
      turn: 1,
      step,
      message: structuredClone(
        createToolResultMessage({
          callId,
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        }),
      ),
    },
  });
  const events = [
    call(
      0,
      readPage.callId,
      'read_review_target',
      { resourceRef: 'body', offset: 0, length: 8192 },
      1,
    ),
    result(1, readPage.callId, readPage, 0, 1),
    call(2, 'completion', 'complete_review', review, 2),
    result(3, 'completion', nativeReviewAck(binding(), context(), intent), 2, 2),
    { seq: 4, time: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const snapshot = {
    asOfSeq: 4,
    inheritedEventCount: 0,
    hasPending: false,
    pendingMessageIds: [],
    events,
    check() {},
  };
  return { snapshot, events, intent, readPage, review };
}

test('review native source contract: exact read-call/result precedes declaration and linked ACK/completed turn fixes the source cut', () => {
  const h = fixture();
  assert.equal(
    assertNativeReviewDeclaration(
      { ...h.snapshot, asOfSeq: 2, events: h.events.slice(0, 3) },
      binding(),
      context(),
      h.intent,
      [],
    ),
    undefined,
  );
  const fixed = qualifyNativeFixedReview(h.snapshot, binding(), context(), h.intent, []);
  assert.equal(fixed.content.conclusion, 'approve');
  assert.deepEqual(fixed.cut, { callSeq: 2, resultSeq: 3, turnEndSeq: 4, asOfSeq: 4 });
  assert.deepEqual(
    fixed.readManifest.reads.map((r) => [r.callSeq, r.resultSeq, r.range.length]),
    [[0, 1, 11]],
  );
  assert.equal(
    qualifyNativeFixedReview(
      { ...h.snapshot, events: h.events.slice(0, 3) },
      binding(),
      context(),
      h.intent,
      [],
    ),
    undefined,
  );
});

test('review native source contract: public hashes cannot disguise a foreign native source or configured reviewer', () => {
  for (const mutate of [
    (p) => {
      p.source.nativeSessionId = p.source.nativeAgentId = 'foreign-native';
    },
    (p) => {
      p.source.context.review.principal.reviewerRef.id = 'foreign-reviewer';
    },
    (p) => {
      p.source.context.review.target.roundId = 'foreign-round';
    },
    (p) => {
      p.source.configurationId = 'foreign-configuration';
    },
  ]) {
    const h = fixture();
    mutate(h.readPage);
    h.readPage.readRef = nativeReviewReadRef(
      h.readPage.source,
      h.readPage.callId,
      h.readPage.range,
      h.readPage.sha256,
    );
    h.events[1].data.message.content[0].text = JSON.stringify(h.readPage);
    h.review.evidenceRefs = [h.readPage.readRef];
    h.events[2].data.arguments = JSON.stringify(h.review);
    assert.throws(
      () => nativeReviewDeclaration(h.snapshot, binding(), context(), h.intent.callId, []),
      { code: 'review-read-mismatch' },
    );
  }
});

test('review native source contract: read result linkage, request range and step cannot be substituted', () => {
  for (const mutate of [
    (h) => {
      h.events[1].sourceEventSeqs = [0, 2];
    },
    (h) => {
      h.events[1].data.step = 9;
    },
    (h) => {
      h.events[1].data.message.toolCallId = 'foreign-call';
    },
    (h) => {
      h.events[1].seq = 3;
    },
    (h) => {
      h.events[0].data.arguments = JSON.stringify({ resourceRef: 'body', offset: 0, length: 1 });
    },
    (h) => {
      h.events[0].data.arguments = JSON.stringify({
        resourceRef: 'another-body',
        offset: 0,
        length: 8192,
      });
    },
  ]) {
    const h = fixture();
    mutate(h);
    assert.throws(
      () => nativeReviewDeclaration(h.snapshot, binding(), context(), h.intent.callId, []),
      { code: 'review-read-mismatch' },
    );
  }
});

test('review native source contract: forged ACK, stopped turn, mixed completion and subsequent activity do not fix a result', () => {
  for (const mutate of [
    (h) => {
      h.events[3].sourceEventSeqs = [2, 9];
    },
    (h) => {
      h.events[3].data.step = 1;
    },
    (h) => {
      const ack = JSON.parse(h.events[3].data.message.content[0].text);
      ack.digest = 'f'.repeat(64);
      h.events[3].data.message.content[0].text = JSON.stringify(ack);
    },
    (h) => {
      h.events[4].data.reason.kind = 'cancelled';
    },
    (h) => {
      h.events.push({ seq: 5, time: 5, type: 'tool/call', data: {} });
    },
    (h) => {
      h.events.push({ seq: 5, time: 5, type: 'assistant/message', data: {} });
    },
  ]) {
    const h = fixture();
    mutate(h);
    assert.throws(() => qualifyNativeFixedReview(h.snapshot, binding(), context(), h.intent, []), {
      code: 'review-result-rejected',
    });
  }
  const h = fixture();
  assert.throws(
    () =>
      qualifyNativeFixedReview(
        { ...h.snapshot, hasPending: true },
        binding(),
        context(),
        h.intent,
        [],
      ),
    { code: 'review-input-pending' },
  );
  for (const type of ['user/message', 'turn/start', 'agent/inbox/spliced']) {
    const changed = fixture();
    changed.events.push({ seq: 5, time: 5, type, data: { inserted: [{}] } });
    assert.throws(
      () => qualifyNativeFixedReview(changed.snapshot, binding(), context(), changed.intent, []),
      { code: 'review-input-pending' },
    );
  }
});

test('review native source contract: original call text budget and snapshot currentness remain mandatory', () => {
  const h = fixture();
  h.events[2].data.arguments += ' '.repeat(120000);
  assert.throws(
    () => nativeReviewDeclaration(h.snapshot, binding(), context(), h.intent.callId, []),
    { code: 'output-too-large' },
  );
  const current = fixture();
  assert.throws(
    () =>
      qualifyNativeFixedReview(
        {
          ...current.snapshot,
          check() {
            throw Error('source-revoked');
          },
        },
        binding(),
        context(),
        current.intent,
        [],
      ),
    /source-revoked/,
  );
  assert.throws(
    () => assertNativeReviewDeclaration(current.snapshot, binding(), context(), current.intent, []),
    { code: 'review-result-rejected' },
  );
});

test('review native source contract: Host unsupported errors on required fixed resources remain limitations and never become body evidence', () => {
  const h = fixture();
  h.events[2].seq = 4;
  h.events[3].seq = 5;
  h.events[3].sourceEventSeqs = [4];
  h.events[4].seq = 6;
  h.events.splice(
    2,
    0,
    {
      seq: 2,
      time: 2,
      type: 'tool/call',
      data: {
        turn: 1,
        step: 2,
        name: 'read_review_target',
        callId: 'binary',
        arguments: JSON.stringify({ resourceRef: 'required-binary', offset: 0, length: 32 }),
      },
    },
    {
      seq: 3,
      time: 3,
      type: 'tool/result',
      sourceEventSeqs: [2],
      data: {
        turn: 1,
        step: 2,
        message: createToolResultMessage({
          callId: 'binary',
          isError: false,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, code: 'review-unsupported-material' }),
            },
          ],
        }),
      },
    },
  );
  h.snapshot.asOfSeq = 6;
  assert.throws(
    () => nativeReviewDeclaration(h.snapshot, binding(), context(), h.intent.callId, []),
    { code: 'review-unsupported-material' },
  );
  h.review.conclusion = 'comment';
  h.events[4].data.arguments = JSON.stringify(h.review);
  const declaration = nativeReviewDeclaration(
    h.snapshot,
    binding(),
    context(),
    h.intent.callId,
    [],
  );
  assert.equal(declaration.readManifest.reads.length, 1);
  assert.deepEqual(declaration.readManifest.unavailableRequired, [
    { resourceRef: 'required-binary', code: 'review-unsupported-material' },
  ]);
});
