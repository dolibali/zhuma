/** Wire consistency only: neither successful parsing nor synthetic digests are execution evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { canonicalPayload } from '../dist/concurrency.js';
import {
  remoteRunRequestSchema,
  remoteRunResponseSchema,
  remoteResultDeclarationSchema,
  remoteFileValueSchema,
  remoteFileReservationValueSchema,
  remoteReviewRequestSchema,
  remoteReviewDeviceSigningInput,
  remoteExecutionRequestSchema,
  remoteNativeReviewReadManifestSchema,
  remoteNativeReviewContentSchema,
  remoteReviewRunViewSchema,
  remoteReviewReconcileValueSchema,
  remoteReviewResponseSchema,
} from '../dist/remote-run-contract.js';

const sha = 'a'.repeat(64);
const scope = {
  backendId: randomUUID(),
  actorId: 'member',
  spaceId: 'space',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'run',
  generation: 1,
  segmentId: 'segment',
};
const { backendId: _backend, ...nativeScope } = scope;
const permit = { id: randomUUID(), sha256: sha };
const header = {
  protocolVersion: 1,
  backendId: scope.backendId,
  deviceId: randomUUID(),
  requestId: randomUUID(),
  proof: { issuedAt: 1, nonce: randomUUID(), signature: 'A'.repeat(86) },
};
const fileSource = {
  scope: nativeScope,
  nativeSessionId: 'native',
  nativeAgentId: 'native',
  configurationId: 'config',
  expertVersionId: 'plan',
  toolVersion: 'zhuma-native-output-file@1',
  callId: 'publish',
};
const fileRecord = () => ({
  uploadId: 'actual-upload',
  attachmentId: `sha256:${sha}`,
  name: 'report.txt',
  mediaType: 'text/plain',
  byteSize: 3,
  sha256: sha,
  spaceId: 'space',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  uploadedBy: 'member',
  idempotencyKey: 'native-key',
  state: 'completed',
  uploadedAt: '2026-10-28T00:00:00Z',
  producer: { kind: 'native-run-output', version: 1, source: fileSource, selectorFingerprint: sha },
});
const fileValue = () => ({
  scope,
  uploadId: 'actual-upload',
  idempotencyKey: 'native-key',
  status: 'completed',
  record: fileRecord(),
  file: {
    id: 'actual-upload',
    mediaType: 'text/plain',
    byteSize: 3,
    checksum: sha,
    accessPolicyId: 'space:space',
    uploadComplete: true,
  },
});
const cut = { callSeq: 3, resultSeq: 4, turnEndSeq: 5, asOfSeq: 6 };
const review = {
  target: {
    spaceId: 'space',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    roundId: 'round',
    artifactVersionId: 'artifact',
    artifactFingerprint: sha,
  },
  principal: {
    kind: 'expert',
    controllerMemberId: 'member',
    reviewerRef: { id: 'reviewer', version: 'plan', digest: sha },
  },
};
const reviewScope = { ...scope, review };
const reviewSource = () => ({
  context: structuredClone({ schemaVersion: 1, role: 'review', scope: nativeScope, review }),
  nativeSessionId: 'review-native',
  nativeAgentId: 'review-native',
  configurationId: 'config',
});
const fixed = () => ({
  source: {
    ...reviewSource(),
    toolVersion: 'zhuma-native-review-intent@1',
    intentId: 'intent',
    callId: 'complete',
    cut,
    readManifestDigest: sha,
  },
  content: {
    conclusion: 'approve',
    rationale: 'Read the supplied range.',
    anchors: [],
    evidenceRefs: [`review_read_${sha}`],
  },
  readManifest: {
    reads: [
      {
        readRef: `review_read_${sha}`,
        source: { ...reviewSource(), resourceRef: 'body', resourceFingerprint: sha },
        callId: 'read',
        callSeq: 1,
        resultSeq: 2,
        range: { offset: 0, length: 3, total: 3 },
        encoding: 'utf-8',
        sha256: sha,
      },
    ],
    unavailableRequired: [],
  },
  readManifestDigest: sha,
  digest: sha,
  provenanceFingerprint: sha,
});
const result = () => {
  const { source, digest, readManifestDigest, provenanceFingerprint } = fixed();
  return { requestId: randomUUID(), source, digest, readManifestDigest, provenanceFingerprint };
};
const reviewRequest = (operation, payload) => ({
  ...header,
  purpose: 'review',
  operation,
  payload,
});
const submit = () =>
  reviewRequest('submit-result', { scope: reviewScope, permit, result: result(), fixed: fixed() });

test('file wire: lookup does not claim an IO reservation; reserve uses an opaque handle before an actual upload exists', () => {
  const lookup = {
    ...header,
    operation: 'publish-file',
    payload: {
      scope,
      permit,
      mode: 'lookup',
      idempotencyKey: 'key',
      source: fileSource,
      selectorFingerprint: sha,
      name: 'report.txt',
    },
  };
  remoteRunRequestSchema.parse(lookup);
  assert.equal(
    remoteRunRequestSchema.safeParse({ ...lookup, payload: { ...lookup.payload, maximumBytes: 3 } })
      .success,
    false,
  );
  const reserve = { ...lookup, payload: { ...lookup.payload, mode: 'reserve', maximumBytes: 3 } };
  remoteRunRequestSchema.parse(reserve);
  for (const maximumBytes of [-1, 20 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      remoteRunRequestSchema.safeParse({
        ...reserve,
        payload: { ...reserve.payload, maximumBytes },
      }).success,
      false,
    );
  const reserved = {
    scope,
    reservationId: randomUUID(),
    idempotencyKey: 'key',
    status: 'reserved',
    maximumBytes: 3,
  };
  remoteFileReservationValueSchema.parse(reserved);
  assert.equal(
    remoteFileReservationValueSchema.safeParse({ ...reserved, uploadId: 'invented' }).success,
    false,
  );
  remoteRunResponseSchema('publish-file').parse({
    ok: true,
    value: { scope, idempotencyKey: 'key', status: 'absent' },
  });
  remoteRunResponseSchema('abandon-file').parse({
    ok: true,
    value: { ...reserved, status: 'released' },
  });
  assert.equal(
    remoteRunRequestSchema.safeParse({
      ...header,
      operation: 'abandon-file',
      payload: {
        scope,
        permit,
        uploadId: 'completed-native-publication',
      },
    }).success,
    false,
  );
});

test('file wire: a completed native record is mandatory and must agree with the original scoped artifact reference', () => {
  remoteFileValueSchema.parse(fileValue());
  for (const mutate of [
    (v) => {
      delete v.record;
    },
    (v) => {
      v.record.uploadedBy = 'other';
    },
    (v) => {
      v.record.attachmentId = '';
    },
    (v) => {
      v.record.state = 'abandoned';
    },
    (v) => {
      v.record.producer.source.scope.segmentId = 'other';
    },
    (v) => {
      v.file.checksum = 'b'.repeat(64);
    },
    (v) => {
      v.file.accessPolicyId = 'space:other';
    },
    (v) => {
      v.status = 'pending';
    },
    (v) => {
      v.uploadId = 'reservation';
    },
  ]) {
    const value = structuredClone(fileValue());
    mutate(value);
    assert.equal(remoteFileValueSchema.safeParse(value).success, false);
  }
});

test('file wire: original publication evidence belongs to the same immutable source and precedes completion', () => {
  const value = {
    requestId: randomUUID(),
    digest: sha,
    artifactDigest: sha,
    source: {
      scope: nativeScope,
      nativeSessionId: 'native',
      nativeAgentId: 'native',
      configurationId: 'config',
      intentId: 'intent',
      callId: 'complete',
      toolVersion: 'zhuma-native-result-intent@2',
      cut,
      manifestDigest: sha,
      expertVersionId: 'plan',
    },
    publications: [
      {
        publicationId: 'publication',
        source: structuredClone(fileSource),
        callSeq: 1,
        resultSeq: 2,
        selectorFingerprint: sha,
        name: 'report.txt',
        mediaType: 'text/plain',
        byteSize: 3,
        sha256: sha,
      },
    ],
  };
  remoteResultDeclarationSchema.parse(value);
  for (const mutate of [
    (v) => {
      v.publications[0].resultSeq = 3;
    },
    (v) => {
      v.publications[0].source.nativeAgentId = 'other';
    },
    (v) => {
      v.publications[0].source.scope.segmentId = 'other';
    },
    (v) => {
      v.publications.push(v.publications[0]);
    },
    (v) => {
      delete v.publications[0].source;
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.equal(remoteResultDeclarationSchema.safeParse(invalid).success, false);
  }
});

test('review wire: purpose, immutable round/reviewer and all fixed-result fields are signed; work decoder stays strict', () => {
  const value = submit();
  remoteExecutionRequestSchema.parse(value);
  assert.equal(remoteRunRequestSchema.safeParse(value).success, false);
  const signed = canonicalPayload(remoteReviewDeviceSigningInput(value));
  assert.equal(signed.includes(value.proof.signature), false);
  for (const mutate of [
    (v) => {
      v.purpose = 'work';
    },
    (v) => {
      v.payload.fixed.digest = 'b'.repeat(64);
    },
    (v) => {
      v.payload.scope.review.target.roundId = 'other';
    },
    (v) => {
      v.payload.scope.review.principal.reviewerRef.id = 'other';
    },
    (v) => {
      v.payload.fixed.source.context.role = 'work';
    },
    (v) => {
      v.payload.result.source.nativeAgentId = 'author-native';
    },
    (v) => {
      v.payload.fixed.readManifest.reads[0].resultSeq = 3;
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.notEqual(canonicalPayload(remoteReviewDeviceSigningInput(invalid)), signed);
    assert.equal(remoteReviewRequestSchema.safeParse(invalid).success, false);
  }
});

test('review wire: raw UTF-8 and escaped frame budgets apply before trimming arguments', () => {
  const value = fixed().content;
  remoteNativeReviewContentSchema.parse(value);
  for (const rationale of [' '.repeat(120001) + 'x', '汉'.repeat(40001), '\\'.repeat(60001)])
    assert.equal(remoteNativeReviewContentSchema.safeParse({ ...value, rationale }).success, false);
  assert.equal(
    remoteNativeReviewContentSchema.safeParse({ ...value, evidenceRefs: [] }).success,
    false,
  );
});

test('review wire: ordered read pages are bounded, source-consistent data; hashes still require original native validation', () => {
  const value = fixed().readManifest;
  remoteNativeReviewReadManifestSchema.parse(value);
  for (const mutate of [
    (v) => {
      v.reads[0].range.length = 8193;
    },
    (v) => {
      v.reads[0].source.context.review.principal.controllerMemberId = 'other';
    },
    (v) => {
      v.reads[0].range.total = 2;
    },
    (v) => {
      v.reads[0].callSeq = v.reads[0].resultSeq;
    },
    (v) => {
      v.reads.push(v.reads[0]);
    },
    (v) => {
      v.unavailableRequired = [
        { resourceRef: 'file', code: 'review-unavailable' },
        { resourceRef: 'file', code: 'review-unavailable' },
      ];
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.equal(remoteNativeReviewReadManifestSchema.safeParse(invalid).success, false);
  }
});

test('review wire: sealed transport data retains original running/held until atomic ballot commit; cold reconcile never drives', () => {
  const stop = {
    protocolVersion: 1,
    requestId: randomUUID(),
    backendId: scope.backendId,
    purpose: 'review',
    operation: 'stop',
    payload: { scope: reviewScope, expectedAttemptVersion: 1 },
  };
  remoteReviewRequestSchema.parse(stop);
  assert.equal(
    remoteReviewRequestSchema.safeParse({
      ...stop,
      payload: { scope: reviewScope, expectedReviewVersion: 1 },
    }).success,
    false,
  );
  const view = {
    purpose: 'review',
    scope: reviewScope,
    deviceId: header.deviceId,
    serverTime: 1,
    authority: 'commit-only',
    permit: { id: permit.id, epoch: randomUUID(), expiresAt: 10 },
    cleanup: { id: randomUUID(), epoch: randomUUID(), expiresAt: 20 },
    nodeVersion: 1,
    reviewVersion: 1,
    attemptVersion: 1,
    nextSequence: 4,
    stopRequested: false,
    resources: 'held',
    runStatus: 'running',
    result: result(),
  };
  remoteReviewRunViewSchema.parse(view);
  assert.equal(remoteReviewRunViewSchema.safeParse({ ...view, authority: 'drive' }).success, false);
  assert.equal(
    remoteReviewRunViewSchema.safeParse({ ...view, runStatus: 'completed', resources: 'settled' })
      .success,
    false,
  );
  remoteReviewRequestSchema.parse(
    reviewRequest('event', {
      scope: reviewScope,
      permit,
      event: {
        kind: 'sealed',
        sequence: 3,
        idle: true,
        flushed: true,
        resourcesSettled: true,
        result: result(),
      },
    }),
  );
  assert.equal(
    remoteReviewRequestSchema.safeParse(
      reviewRequest('event', {
        scope: reviewScope,
        permit,
        event: {
          kind: 'completed',
          sequence: 3,
          idle: true,
          flushed: true,
          resourcesSettled: true,
          result: result(),
        },
      }),
    ).success,
    false,
  );
  const cold = {
    ...view,
    shared: { configurationId: 'config', composition: {}, resources: [] },
    selection: {
      provider: 'contract',
      model: 'contract',
      maxTokens: 1000,
      configurationId: 'config',
    },
  };
  remoteReviewReconcileValueSchema.parse(cold);
  assert.equal(
    remoteReviewReconcileValueSchema.safeParse({ ...cold, authority: 'drive', result: undefined })
      .success,
    false,
  );
  assert.equal(
    remoteReviewResponseSchema('cleanup').safeParse({
      ok: true,
      value: { ...view, disposition: 'applied' },
    }).success,
    false,
  );
});
