/** Parser/byte-range/order contracts; not actual source, SDK execution or ballot proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nativeReviewContextSchema,
  nativeReviewContextFromScope,
  nativeReviewSessionKey,
  nativeReviewScopeKey,
  nativeReviewRecordSchema,
  nativeReviewAwareRecordSchema,
  nativeReviewReadRequestSchema,
  nativeReviewReadOutputSchema,
  nativeReviewReadEvidenceSchema,
  nativeReviewReadManifestSchema,
  nativeReviewContentSchema,
  nativeReviewIntentSchema,
  nativeReviewManifestDigest,
  nativeReviewReadRef,
} from '../dist/native-work-session-review-contract.js';
import {
  nativeScopeSchema,
  nativeWorkSessionKey,
  nativeScopeKey,
  migrationFingerprint,
} from '../dist/native-work-session-record.js';
import { validateNativeReviewEvidence } from '../dist/native-work-session-review-source.js';
import {
  scope,
  context,
  binding,
  runSource,
  page,
  evidence,
  manifest,
  content,
} from './native-work-session-review-fixture.mjs';

test('review key contract: explicit role/round/artifact/reviewer/version isolate the same real node without changing author keys', () => {
  const author = '["controller","space","task","plan",1,"node"]';
  assert.equal(nativeWorkSessionKey(scope), author);
  assert.equal(nativeScopeKey(scope), JSON.stringify([author, 'review-run', 1, 'review-segment']));
  const original = context(),
    key = nativeReviewSessionKey(original);
  assert.notEqual(key, author);
  assert.deepEqual(JSON.parse(key)[2], JSON.parse(author));
  assert.deepEqual(JSON.parse(key)[3], original.review);
  for (const mutate of [
    (r) => {
      r.review.target.roundId = 'other-round';
    },
    (r) => {
      r.review.target.artifactVersionId = 'other-artifact';
    },
    (r) => {
      r.review.target.artifactFingerprint = 'c'.repeat(64);
    },
    (r) => {
      r.review.principal.reviewerRef.id = 'other-expert';
    },
    (r) => {
      r.review.principal.reviewerRef.digest = 'c'.repeat(64);
    },
  ]) {
    const other = context();
    mutate(other);
    assert.notEqual(nativeReviewSessionKey(other), key);
  }
  const next = context();
  next.scope = { ...next.scope, runId: 'next-run', generation: 2, segmentId: 'next-segment' };
  assert.equal(nativeReviewSessionKey(next), key);
  assert.notEqual(nativeReviewScopeKey(next), nativeReviewScopeKey(original));
  assert.equal(next.scope.nodeId, original.scope.nodeId);
  assert.equal(next.scope.actorId, original.scope.actorId);
});

test('review schema contract: original strict scope is not widened and unknown role/version fields fail', () => {
  assert.equal(nativeScopeSchema.safeParse({ ...scope, role: 'review' }).success, false);
  assert.equal(nativeScopeSchema.safeParse({ ...scope, review: context().review }).success, false);
  for (const extra of [{ role: 'author' }, { schemaVersion: 2 }, { actorId: 'expert' }])
    assert.equal(nativeReviewContextSchema.safeParse({ ...context(), ...extra }).success, false);
  assert.deepEqual(nativeReviewContextFromScope({ ...scope, review: context().review }), context());
  for (const mutate of [
    (r) => {
      r.review.target.nodeId = 'other-node';
    },
    (r) => {
      r.review.target.roundId = ' ';
    },
    (r) => {
      r.review.principal.controllerMemberId = 'expert';
    },
    (r) => {
      r.review.principal.reviewerRef.version = 'invented-version-id';
    },
    (r) => {
      r.review.configuredReviewerId = 'duplicate-authority';
    },
  ]) {
    const invalid = context();
    mutate(invalid);
    assert.equal(nativeReviewContextSchema.safeParse(invalid).success, false);
  }
});

test('review v3 contract: author v1/v2 remain byte-compatible members of the new union', () => {
  const current = binding();
  const prior = binding();
  prior.scope = { ...scope, runId: 'prior-run', generation: 1, segmentId: 'prior-segment' };
  current.scope = { ...scope, runId: 'next-run', generation: 2, segmentId: 'next-segment' };
  prior.nativeSessionId = prior.nativeAgentId = 'prior-native';
  const lineage = {
    schemaVersion: 2,
    version: 2,
    current,
    prior: [
      {
        binding: prior,
        migration: {
          requestId: 'migration',
          inputFingerprint: 'd'.repeat(64),
          fingerprint: migrationFingerprint(
            prior.scope,
            current.scope,
            current.selection,
            'd'.repeat(64),
          ),
        },
      },
    ],
  };
  for (const record of [binding(), lineage])
    assert.equal(
      JSON.stringify(nativeReviewAwareRecordSchema.parse(record)),
      JSON.stringify(record),
    );
  const reviewContext = context();
  reviewContext.scope = current.scope;
  const record = { schemaVersion: 3, role: 'review', context: reviewContext, binding: lineage };
  assert.deepEqual(nativeReviewRecordSchema.parse(record), record);
});

test('review v3 contract: no author completion, author budget, mismatched scope or unversioned payload in review rows', () => {
  const record = { schemaVersion: 3, role: 'review', context: context(), binding: binding() };
  assert.equal(nativeReviewRecordSchema.safeParse(record).success, true);
  for (const mutate of [
    (r) => {
      r.binding.scope.actorId = 'forged-expert-as-member';
    },
    (r) => {
      r.binding.scope.nodeId = 'another-node';
    },
    (r) => {
      r.binding.nativeAgentId = 'author-native';
    },
    (r) => {
      r.binding.inputReadBudget = { attempts: 0, chargedBytes: 0 };
    },
    (r) => {
      r.binding.resultIntent = {
        protocolVersion: 1,
        toolVersion: 'zhuma-native-result-intent@1',
        intentId: 'intent',
        callId: 'call',
        digest: 'a'.repeat(64),
      };
    },
    (r) => {
      r.readBudget = { attempts: 17, chargedBytes: 0 };
    },
    (r) => {
      r.readBudget = { attempts: 1, chargedBytes: 65537 };
    },
    (r) => {
      r.readBudget = { attempts: 0, chargedBytes: 1 };
    },
    (r) => {
      r.readBudget = { attempts: 1, chargedBytes: 8193 };
    },
    (r) => {
      r.readBudget = { attempts: 1, chargedBytes: 0 };
    },
    (r) => {
      r.content = 'a second body store';
    },
    (r) => {
      r.schemaVersion = 4;
    },
  ]) {
    const invalid = structuredClone(record);
    mutate(invalid);
    assert.equal(nativeReviewRecordSchema.safeParse(invalid).success, false);
  }
});

test('review read request contract: bounded exact byte ranges and no selected authority or paths', () => {
  assert.deepEqual(
    nativeReviewReadRequestSchema.parse({ resourceRef: 'body', offset: 0, length: 8192 }),
    { resourceRef: 'body', offset: 0, length: 8192 },
  );
  for (const query of [
    { resourceRef: 'body', offset: -1, length: 1 },
    { resourceRef: 'body', offset: 0, length: 0 },
    { resourceRef: 'body', offset: 0, length: 8193 },
    { resourceRef: 'body', offset: 0.5, length: 1 },
    { resourceRef: 'body', offset: Number.MAX_SAFE_INTEGER, length: 1 },
    { resourceRef: 'body', offset: 0, length: 1, actorId: 'other' },
    { resourceRef: 'body', offset: 0, length: 1, path: '/foreign' },
  ])
    assert.equal(nativeReviewReadRequestSchema.safeParse(query).success, false);
});

test('review read output contract: UTF-8 returned bytes, digest, range, source and read-ref must agree', () => {
  const value = page({ text: '审阅', offset: 12, total: 30 });
  assert.equal(value.range.length, 6);
  assert.deepEqual(nativeReviewReadOutputSchema.parse(value), value);
  for (const mutate of [
    (r) => {
      r.text = 'changed';
    },
    (r) => {
      r.range.length = 2;
    },
    (r) => {
      r.sha256 = 'c'.repeat(64);
    },
    (r) => {
      r.readRef = `review_read_${'c'.repeat(64)}`;
    },
    (r) => {
      r.source.context.scope.runId = 'author-run';
    },
    (r) => {
      r.source.nativeAgentId = 'different-agent';
    },
    (r) => {
      r.encoding = 'binary';
    },
    (r) => {
      r.path = 'metadata';
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.equal(nativeReviewReadOutputSchema.safeParse(invalid).success, false);
  }
  assert.equal(
    nativeReviewReadOutputSchema.safeParse(page({ text: '\u0000'.repeat(8192) })).success,
    false,
    'actual JSON output cap, not just body length',
  );
});

test('review body evidence contract: EOF may be a read response but metadata/empty/failed/unlinked calls cannot count as a body read', () => {
  assert.equal(nativeReviewReadOutputSchema.safeParse(page({ text: '' })).success, true);
  assert.equal(
    nativeReviewReadEvidenceSchema.safeParse(evidence(page({ text: '' }))).success,
    false,
  );
  const value = evidence();
  assert.equal(
    nativeReviewReadEvidenceSchema.safeParse({ ...value, resultSeq: value.callSeq }).success,
    false,
  );
  assert.equal(
    nativeReviewReadEvidenceSchema.safeParse({ ...value, encoding: 'binary' }).success,
    false,
  );
  assert.equal(
    nativeReviewReadEvidenceSchema.safeParse({ ...value, metadata: true }).success,
    false,
  );
  assert.equal(nativeReviewReadManifestSchema.safeParse(manifest([])).success, false);
});

test('review manifest contract: no mixed Run/controller/reviewer/configuration or duplicate/unsorted reads', () => {
  const a = evidence(),
    b = evidence(page({ offset: 20, callId: 'second' }), 2, 3);
  assert.equal(nativeReviewReadManifestSchema.safeParse(manifest([a, b])).success, true);
  for (const mutate of [
    (r) => {
      r.source.context.scope.runId = 'foreign-run';
    },
    (r) => {
      r.source.context.review.principal.reviewerRef.id = 'foreign-expert';
    },
    (r) => {
      r.source.configurationId = 'foreign-configuration';
    },
    (r) => {
      r.source.resourceFingerprint = 'd'.repeat(64);
    },
    (r) => {
      r.range.total += 1;
    },
  ]) {
    const changed = structuredClone(b);
    mutate(changed);
    changed.readRef = nativeReviewReadRef(
      changed.source,
      changed.callId,
      changed.range,
      changed.sha256,
    );
    assert.equal(nativeReviewReadManifestSchema.safeParse(manifest([a, changed])).success, false);
  }
  for (const reads of [[a, a], [b, a], Array.from({ length: 17 }, () => a)])
    assert.equal(nativeReviewReadManifestSchema.safeParse(manifest(reads)).success, false);
  const large = Array.from({ length: 9 }, (_, i) =>
    evidence(page({ text: 'x'.repeat(8192), callId: `call-${i}` }), i * 2, i * 2 + 1),
  );
  assert.equal(nativeReviewReadManifestSchema.safeParse(manifest(large)).success, false);
});

test('review evidence consistency: source and successful read results precede completion, reference set exactly matches actual manifest', () => {
  const h = manifest(),
    c = content();
  const valid = validateNativeReviewEvidence(c, h, runSource(), 2);
  assert.equal(valid.readManifestDigest, nativeReviewManifestDigest(h));
  assert.match(valid.digest, /^[a-f0-9]{64}$/);
  for (const seq of [1, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => validateNativeReviewEvidence(c, h, runSource(), seq), {
      code: 'review-read-mismatch',
    });
  const other = runSource();
  other.context.scope.runId = 'other-run';
  assert.throws(() => validateNativeReviewEvidence(c, h, other, 2), {
    code: 'review-read-mismatch',
  });
  assert.throws(() => validateNativeReviewEvidence(c, manifest([]), runSource(), 2), {
    code: 'review-read-required',
  });
  const second = evidence(page({ callId: 'second' }), 2, 3);
  assert.throws(
    () => validateNativeReviewEvidence(c, manifest([evidence(), second]), runSource(), 4),
    { code: 'review-read-mismatch' },
  );
  const foreign = { ...c, evidenceRefs: [`review_read_${'f'.repeat(64)}`] };
  assert.throws(() => validateNativeReviewEvidence(foreign, h, runSource(), 2), {
    code: 'review-read-mismatch',
  });
});

test('review anchors cover only actual byte-range unions, including partial reads and gaps', () => {
  const a = evidence(page({ text: 'abcde', total: 100 }));
  const b = evidence(page({ text: 'fghij', offset: 5, total: 100, callId: 'second' }), 2, 3);
  const h = manifest([a, b]),
    c = { ...content([a, b]), anchors: [{ resourceRef: 'body', offset: 2, length: 8 }] };
  const partial = validateNativeReviewEvidence(c, h, runSource(), 4);
  assert.deepEqual(
    partial.readManifest.reads.map((r) => r.range),
    [a.range, b.range],
  );
  for (const anchors of [
    [{ resourceRef: 'body', offset: 2, length: 9 }],
    [{ resourceRef: 'unread-file', offset: 0, length: 1 }],
    [{ resourceRef: 'body', offset: 99, length: 1 }],
  ])
    assert.throws(() => validateNativeReviewEvidence({ ...c, anchors }, h, runSource(), 4), {
      code: 'review-range-invalid',
    });
  const gap = evidence(page({ text: 'klmno', offset: 10, total: 100, callId: 'gap' }), 2, 3);
  assert.throws(
    () =>
      validateNativeReviewEvidence(
        { ...c, evidenceRefs: [a.readRef, gap.readRef] },
        manifest([a, gap]),
        runSource(),
        4,
      ),
    { code: 'review-range-invalid' },
  );
});

test('review limitations contract: required unsupported material blocks approve/request-changes; comment retains the limitation', () => {
  const h = {
    ...manifest(),
    unavailableRequired: [{ resourceRef: 'required-binary', code: 'review-unsupported-material' }],
  };
  for (const conclusion of ['approve', 'request-changes'])
    assert.throws(
      () => validateNativeReviewEvidence({ ...content(), conclusion }, h, runSource(), 2),
      { code: 'review-unsupported-material' },
    );
  const result = validateNativeReviewEvidence(
    { ...content(), conclusion: 'comment' },
    h,
    runSource(),
    2,
  );
  assert.equal(result.content.conclusion, 'comment');
  assert.deepEqual(result.readManifest.unavailableRequired, h.unavailableRequired);
  assert.notEqual(result.readManifestDigest, nativeReviewManifestDigest(manifest()));
});

test('review content and fixed metadata contracts: three original actions, bounded data and no model authority/read-proof claims', () => {
  for (const conclusion of ['approve', 'request-changes', 'comment'])
    assert.equal(nativeReviewContentSchema.safeParse({ ...content(), conclusion }).success, true);
  for (const extra of [
    { actorId: 'other' },
    { reviewerId: 'other' },
    { roundId: 'other' },
    { allFilesRead: true },
    { conclusion: 'approved' },
    { rationale: ' ' },
    { rationale: 'x'.repeat(100001) },
    { evidenceRefs: [] },
    { evidenceRefs: [...content().evidenceRefs, ...content().evidenceRefs] },
    { anchors: [{ resourceRef: 'body', offset: 0, length: 0 }] },
    { anchors: [{ resourceRef: 'body', offset: Number.MAX_SAFE_INTEGER, length: 1 }] },
    { anchors: Array.from({ length: 51 }, () => ({ resourceRef: 'body', offset: 0, length: 1 })) },
  ])
    assert.equal(nativeReviewContentSchema.safeParse({ ...content(), ...extra }).success, false);
  const intent = {
    protocolVersion: 1,
    toolVersion: 'zhuma-native-review-intent@1',
    intentId: 'intent',
    callId: 'completion',
    digest: 'd'.repeat(64),
    readManifestDigest: 'e'.repeat(64),
    cut: { callSeq: 2, resultSeq: 3, turnEndSeq: 4, asOfSeq: 4 },
  };
  assert.equal(nativeReviewIntentSchema.safeParse(intent).success, true);
  for (const extra of [
    { protocolVersion: 2 },
    { toolVersion: 'zhuma-native-result-intent@1' },
    { content: content() },
    { cut: { callSeq: 3, resultSeq: 2, turnEndSeq: 4, asOfSeq: 4 } },
  ])
    assert.equal(nativeReviewIntentSchema.safeParse({ ...intent, ...extra }).success, false);
});
