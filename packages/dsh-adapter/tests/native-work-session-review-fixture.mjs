/** Synthetic protocol data only; no read authority or actual SDK provenance. */
import { createHash } from 'node:crypto';
import {
  NATIVE_REVIEW_READ_TOOL_VERSION,
  nativeReviewReadRef,
} from '../dist/native-work-session-review-contract.js';

export const scope = Object.freeze({
  actorId: 'controller',
  spaceId: 'space',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'review-run',
  generation: 1,
  segmentId: 'review-segment',
});
export function context() {
  return {
    schemaVersion: 1,
    role: 'review',
    scope: { ...scope },
    review: {
      target: {
        spaceId: scope.spaceId,
        taskId: scope.taskId,
        planId: scope.planId,
        revision: scope.revision,
        nodeId: scope.nodeId,
        roundId: 'round',
        artifactVersionId: 'artifact',
        artifactFingerprint: 'a'.repeat(64),
      },
      principal: {
        kind: 'expert',
        controllerMemberId: scope.actorId,
        reviewerRef: { id: 'expert', version: scope.planId, digest: 'e'.repeat(64) },
      },
    },
  };
}
export function binding() {
  return {
    schemaVersion: 1,
    scope: { ...scope },
    nativeSessionId: 'review-native',
    nativeAgentId: 'review-native',
    selection: {
      provider: 'contract',
      model: 'contract',
      maxTokens: 1000,
      configurationId: 'configuration',
    },
    receipts: [],
  };
}
export function runSource() {
  return {
    context: context(),
    nativeSessionId: 'review-native',
    nativeAgentId: 'review-native',
    configurationId: 'configuration',
  };
}
export function page({
  text = 'actual text',
  offset = 0,
  total,
  resourceRef = 'body',
  callId = 'read-call',
} = {}) {
  const bytes = Buffer.from(text);
  const source = { ...runSource(), resourceRef, resourceFingerprint: 'b'.repeat(64) };
  const range = { offset, length: bytes.length, total: total ?? 100000 };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    ok: true,
    protocolVersion: 1,
    toolVersion: NATIVE_REVIEW_READ_TOOL_VERSION,
    callId,
    readRef: nativeReviewReadRef(source, callId, range, sha256),
    source,
    range,
    encoding: 'utf-8',
    sha256,
    text,
  };
}
export function evidence(value = page(), callSeq = 0, resultSeq = 1) {
  const { readRef, source, callId, range, encoding, sha256 } = value;
  return { readRef, source, callId, callSeq, resultSeq, range, encoding, sha256 };
}
export function manifest(reads = [evidence()]) {
  return { reads, unavailableRequired: [] };
}
export function content(reads = [evidence()]) {
  return {
    conclusion: 'approve',
    rationale: 'Checked the returned body range.',
    anchors: [{ resourceRef: 'body', offset: 0, length: 4 }],
    evidenceRefs: reads.map((read) => read.readRef),
  };
}
