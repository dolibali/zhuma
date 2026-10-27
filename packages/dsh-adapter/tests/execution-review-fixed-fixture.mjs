// Public consistency data and domain contracts only: no C original issuer,
// SDK history/cut, physical retirement or actual model approval is proved here.
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { reviewCompositionFacts } from './execution-review-composition-fixture.mjs';
import { freezeExecutionReviewComposition } from '../dist/execution-review-composition.js';
import { prepareExecutionReview } from '../dist/execution-review-state.js';
import {
  admitExecutionReview,
  recordExecutionReviewEvent,
} from '../dist/execution-review-lifecycle.js';
import { reviewTargetResources } from '../dist/execution-review-target-reader.js';
import {
  nativeReviewContextFromScope,
  nativeReviewReadRef,
  nativeReviewManifestDigest,
  nativeReviewContentDigest,
  NATIVE_REVIEW_TOOL_VERSION,
} from '../dist/native-work-session-review-contract.js';

export function runningReview(options) {
  const f = structuredClone(reviewCompositionFacts(options));
  if (options?.peer) {
    f.applied.participants.push({
      ...f.applied.participants.find((p) => p.id === 'chen'),
      id: 'outside',
    });
    f.applied.task.participantIds.push('outside');
    f.applied.task.workflows[0].nodes[0].reviewerIds.push('outside');
    f.node.handoff.reviewerIds.push('outside');
    f.node.rounds[0].reviewerIds.push('outside');
  }
  const composition = freezeExecutionReviewComposition(f);
  const prepared = prepareExecutionReview(f.node, f.applied, {
    requestId: 'prepare-fixed-review',
    expectedReviewVersion: 0,
    target: f.scope.review.target,
    reviewerId: 'qa',
    controllerMemberId: 'chen',
    configurationId: composition.configurationId,
    newRunId: f.scope.runId,
    newSegmentId: f.scope.segmentId,
  });
  const admitted = admitExecutionReview(prepared.record, {
    scope: f.scope,
    expectedAttemptVersion: 1,
    composition,
  });
  const accepted = recordExecutionReviewEvent(admitted.record, {
    scope: f.scope,
    sequence: 1,
    kind: 'accepted',
    nativeSessionId: 'native-review-contract',
    nativeAgentId: 'native-review-contract',
  });
  return { ...f, composition, record: accepted.record, attempt: accepted.attempt };
}
export function fixedReviewFacts(f, { ranges, conclusion = 'approve', proofScope = f.scope } = {}) {
  const artifact = f.record.artifactVersions.find(
    (item) => item.id === f.scope.review.target.artifactVersionId,
  );
  const bytes = Buffer.from(artifact.text),
    resource = reviewTargetResources(artifact)[0];
  const origin = {
    context: nativeReviewContextFromScope(proofScope),
    nativeSessionId: f.attempt.nativeSessionId,
    nativeAgentId: f.attempt.nativeAgentId,
    configurationId: f.attempt.configurationId,
  };
  const reads = (ranges ?? [[0, bytes.length]]).map(([offset, length], index) => {
    const source = {
      ...origin,
      resourceRef: resource.resourceRef,
      resourceFingerprint: resource.resourceFingerprint,
    };
    const range = { offset, length, total: bytes.length },
      callId = `read-${index}`;
    const sha256 = createHash('sha256')
      .update(bytes.subarray(offset, offset + length))
      .digest('hex');
    return {
      readRef: nativeReviewReadRef(source, callId, range, sha256),
      source,
      callId,
      callSeq: index * 2,
      resultSeq: index * 2 + 1,
      range,
      encoding: 'utf-8',
      sha256,
    };
  });
  const readManifest = { reads, unavailableRequired: [] },
    readManifestDigest = nativeReviewManifestDigest(readManifest);
  const callSeq = reads.length * 2 + 2;
  const source = {
    ...origin,
    toolVersion: NATIVE_REVIEW_TOOL_VERSION,
    intentId: 'fixed-review-intent',
    callId: 'complete-review-call',
    cut: { callSeq, resultSeq: callSeq + 1, turnEndSeq: callSeq + 2, asOfSeq: callSeq + 2 },
    readManifestDigest,
  };
  const content = {
    conclusion,
    rationale: 'Checked the exact fixed material and recorded the review reason.',
    anchors: [
      {
        resourceRef: resource.resourceRef,
        offset: reads[0].range.offset,
        length: Math.min(2, reads[0].range.length),
      },
    ],
    evidenceRefs: reads.map((item) => item.readRef),
  };
  const digest = nativeReviewContentDigest(content, readManifestDigest);
  return {
    source,
    content,
    readManifest,
    readManifestDigest,
    digest,
    provenanceFingerprint: createHash('sha256')
      .update(canonicalPayload({ source, digest, readManifestDigest }))
      .digest('hex'),
  };
}
