/** Cross-layer data compatibility; no native grant, physical IO, model or review vote is created. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  remoteNativeReviewContextSchema,
  remoteNativeReviewReadEvidenceSchema,
  remoteNativeReviewReadManifestSchema,
  remoteNativeReviewContentSchema,
  remoteNativeFixedReviewFactsSchema,
  remoteCompletedNativeFileRecordSchema,
  remoteResultDeclarationSchema,
  remoteFileValueSchema,
} from '@zhuma/agent-core';
import {
  nativeReviewContextSchema,
  nativeReviewReadEvidenceSchema,
  nativeReviewReadManifestSchema,
  nativeReviewContentSchema,
  nativeReviewManifestDigest,
  nativeReviewContentDigest,
} from '../dist/native-work-session-review-contract.js';
import { artifactFileReference, nativeOutputFileSourceSchema } from '../dist/artifact-files.js';
import { nativePublicationManifestDigest } from '../dist/native-work-session-result-publications-source.js';
import {
  nativeResultManifestRecords,
  nativeManifestResultDigest,
  nativeResultPublicationsSourceSchema,
} from '../dist/execution-native-result-delivery.js';
import {
  scope,
  context,
  runSource,
  evidence,
  manifest,
  content,
} from './native-work-session-review-fixture.mjs';

test('remote review carriers preserve original C context, content and ordered read manifest exactly', () => {
  for (const [wire, original, value] of [
    [remoteNativeReviewContextSchema, nativeReviewContextSchema, context()],
    [remoteNativeReviewReadEvidenceSchema, nativeReviewReadEvidenceSchema, evidence()],
    [remoteNativeReviewReadManifestSchema, nativeReviewReadManifestSchema, manifest()],
    [remoteNativeReviewContentSchema, nativeReviewContentSchema, content()],
  ])
    assert.deepEqual(wire.parse(value), original.parse(value));
  const readManifest = manifest();
  const readManifestDigest = nativeReviewManifestDigest(readManifest);
  const value = {
    source: {
      ...runSource(),
      toolVersion: 'zhuma-native-review-intent@1',
      intentId: 'intent',
      callId: 'complete',
      cut: { callSeq: 2, resultSeq: 3, turnEndSeq: 4, asOfSeq: 4 },
      readManifestDigest,
    },
    content: content(),
    readManifest,
    readManifestDigest,
    digest: nativeReviewContentDigest(content(), readManifestDigest),
    provenanceFingerprint: 'f'.repeat(64),
  };
  assert.deepEqual(remoteNativeFixedReviewFactsSchema.parse(value), value);
});

test('remote review codec is never the original SDK proof: original source validator still rejects forged read hashes', () => {
  const forged = evidence();
  forged.readRef = `review_read_${'0'.repeat(64)}`;
  assert.equal(remoteNativeReviewReadEvidenceSchema.safeParse(forged).success, true);
  assert.equal(nativeReviewReadEvidenceSchema.safeParse(forged).success, false);
  for (const rationale of [' '.repeat(120001) + 'x', '汉'.repeat(40001), '\\'.repeat(60001)]) {
    const value = { ...content(), rationale };
    assert.equal(remoteNativeReviewContentSchema.safeParse(value).success, false);
    assert.equal(nativeReviewContentSchema.safeParse(value).success, false);
  }
});

test('remote actual native file receipt survives original v2 full-manifest validation without reconstructing any record field', () => {
  const sha = 'c'.repeat(64);
  const source = nativeOutputFileSourceSchema.parse({
    scope,
    nativeSessionId: 'native',
    nativeAgentId: 'native',
    configurationId: 'config',
    expertVersionId: 'plan',
    toolVersion: 'zhuma-native-output-file@1',
    callId: 'publish',
  });
  const record = {
    uploadId: 'publication',
    attachmentId: `sha256:${sha}`,
    name: 'report.txt',
    mediaType: 'text/plain',
    byteSize: 3,
    sha256: sha,
    spaceId: scope.spaceId,
    taskId: scope.taskId,
    planId: scope.planId,
    revision: scope.revision,
    nodeId: scope.nodeId,
    uploadedBy: scope.actorId,
    idempotencyKey: 'original-native-key',
    state: 'completed',
    uploadedAt: '2026-10-28T01:02:03.004Z',
    producer: { kind: 'native-run-output', version: 1, source, selectorFingerprint: sha },
  };
  const publication = {
    publicationId: record.uploadId,
    source,
    callSeq: 1,
    resultSeq: 2,
    selectorFingerprint: sha,
    name: record.name,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    sha256: sha,
  };
  const originalManifest = [{ evidence: publication, record }];
  const manifestDigest = nativePublicationManifestDigest(originalManifest);
  const fixedSource = nativeResultPublicationsSourceSchema.parse({
    scope,
    nativeSessionId: 'native',
    nativeAgentId: 'native',
    configurationId: 'config',
    intentId: 'intent',
    callId: 'complete',
    toolVersion: 'zhuma-native-result-intent@2',
    cut: { callSeq: 3, resultSeq: 4, turnEndSeq: 5, asOfSeq: 5 },
    manifestDigest,
    expertVersionId: 'plan',
  });
  const remoteScope = { backendId: randomUUID(), ...scope };
  const returned = remoteFileValueSchema.parse({
    scope: remoteScope,
    uploadId: record.uploadId,
    idempotencyKey: record.idempotencyKey,
    status: 'completed',
    file: artifactFileReference(record),
    record: remoteCompletedNativeFileRecordSchema.parse(record),
  });
  const restored = nativeResultManifestRecords(fixedSource, [publication], manifestDigest, (id) =>
    id === record.uploadId ? returned.record : undefined,
  );
  assert.deepEqual(restored, originalManifest);
  const draft = { links: [], files: [returned.file] };
  remoteResultDeclarationSchema.parse({
    requestId: randomUUID(),
    source: fixedSource,
    publications: [publication],
    digest: nativeManifestResultDigest(draft, manifestDigest, [publication]),
    artifactDigest: sha,
  });
  const fabricated = structuredClone(returned.record);
  fabricated.uploadedAt = 'reconstructed-after-recovery';
  assert.throws(() =>
    nativeResultManifestRecords(fixedSource, [publication], manifestDigest, () => fabricated),
  );
});
