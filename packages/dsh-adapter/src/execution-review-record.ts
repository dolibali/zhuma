import { createHash } from 'node:crypto';
import {
  canonicalPayload,
  type ArtifactVersion,
  type ExecutionNodeRecord,
} from '@zhuma/agent-core';
import type { ExecutionRunState } from './execution-run-state.js';
import { remoteReviewBindingMatches } from './remote-review-state.js';
import { readExecutionReviewComposition } from './execution-review-composition.js';
import {
  readExecutionReviewFixedReceipt,
  readExecutionReviewFailure,
} from './execution-review-fixed-result.js';
import {
  executionReviewStateSchema,
  ExecutionReviewError,
  type ExecutionReviewAttempt,
  type ExecutionReviewState,
} from './execution-review-contract.js';

function refuse(code: 'review-state-invalid'): never {
  throw new ExecutionReviewError(code);
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalPayload(value)).digest('hex');
}
/** Structural history only. Reusing this lane still requires the original
 * Service's exact Stop, current target/no-vote and genuine C drain checks. */
export function isStoppedReviewHistory(attempt: ExecutionReviewAttempt): boolean {
  return (
    attempt.status === 'cancelled' &&
    attempt.stopPhase === 'confirmed' &&
    attempt.resources === 'settled' &&
    ((attempt.dispatch === 'received' &&
      !!attempt.nativeSessionId &&
      attempt.nativeAgentId === attempt.nativeSessionId) ||
      (attempt.dispatch === 'reserved' &&
        !attempt.nativeSessionId &&
        !attempt.nativeAgentId &&
        'remote' in attempt &&
        !!attempt.remote?.workflow &&
        attempt.remote.stopRequested &&
        attempt.remote.lastObservation === 'drained')) &&
    attempt.result === undefined &&
    attempt.failure === undefined
  );
}
export function executionReviewArtifactFingerprint(artifact: ArtifactVersion): string {
  return hash(artifact);
}
function reservationFingerprint(requestId: string, attempt: ExecutionReviewAttempt): string {
  const { scope } = attempt;
  return hash({
    requestId,
    target: scope.review.target,
    reviewerId: scope.review.principal.reviewerRef.id,
    controllerMemberId: scope.actorId,
    configurationId: attempt.configurationId,
    newRunId: scope.runId,
    newSegmentId: scope.segmentId,
    binding: scope.review,
  });
}

/** Strip only the explicitly versioned review envelope, never arbitrary unknown fields.
 * The original author parser validates author; the shared validator below checks review. */
export function splitExecutionReviewRecord(record: ExecutionNodeRecord): {
  author: unknown;
  review?: ExecutionReviewState;
} {
  if (!Object.hasOwn(record, 'nativeExecution')) return { author: undefined };
  const raw = (record as { nativeExecution?: unknown }).nativeExecution;
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'review')) return { author: raw };
  const { review, ...rest } = raw as Record<string, unknown>;
  if (rest.schemaVersion !== 2) return refuse('review-state-invalid');
  const parsed = executionReviewStateSchema.safeParse(review);
  if (!parsed.success) return refuse('review-state-invalid');
  return {
    author: Object.keys(rest).length === 1 ? undefined : { ...rest, schemaVersion: 1 },
    review: parsed.data,
  };
}

export function assertExecutionReviewRecord(
  record: ExecutionNodeRecord,
  review: ExecutionReviewState,
  author: ExecutionRunState | undefined,
  maximumRuns: number,
): void {
  if ((author?.runs.length ?? 0) + review.attempts.length > maximumRuns)
    return refuse('review-state-invalid');
  const runIds = new Set(author?.runs.map((run) => run.attempt.id));
  const segments = new Set(author?.runs.map((run) => run.segmentId));
  const lanes = new Map<string, ExecutionReviewAttempt>();
  const nativeIds = new Set(
    author?.runs.flatMap((run) =>
      [run.attempt.sessionId, run.attempt.executorRunId].filter((id) => id !== undefined),
    ),
  );
  for (const [index, attempt] of review.attempts.entries()) {
    const { scope } = attempt;
    const { target, principal } = scope.review;
    const artifact = record.artifactVersions.find((item) => item.id === target.artifactVersionId);
    const round = record.rounds.find((item) => item.id === target.roundId);
    const lane = canonicalPayload([
      target.roundId,
      target.artifactVersionId,
      principal.reviewerRef.id,
    ]);
    const previous = lanes.get(lane);
    if (
      !remoteReviewBindingMatches(attempt) ||
      scope.taskId !== record.taskId ||
      scope.planId !== record.planId ||
      scope.revision !== record.revision ||
      scope.nodeId !== record.nodeId ||
      scope.generation !== index + 1 ||
      !artifact ||
      artifact.nodeId !== record.nodeId ||
      executionReviewArtifactFingerprint(artifact) !== target.artifactFingerprint ||
      !round ||
      round.artifactVersionId !== artifact.id ||
      !round.reviewerIds.includes(principal.reviewerRef.id) ||
      principal.reviewerRef.id === record.handoff.assignee.id ||
      principal.reviewerRef.id === artifact.submittedBy ||
      runIds.has(scope.runId) ||
      segments.has(scope.segmentId) ||
      (previous !== undefined &&
        !(previous.status === 'prepared' && previous.version === 1) &&
        !isStoppedReviewHistory(previous))
    )
      return refuse('review-state-invalid');
    runIds.add(scope.runId);
    segments.add(scope.segmentId);
    // Stopped history remains immutable when the original Service qualifies a
    // new scope. An active or completed predecessor still blocks the lane;
    // parsing cancellation labels cannot issue the required C drain proof.
    lanes.set(lane, attempt);
    if (attempt.status !== 'prepared') {
      let saved;
      try {
        saved = readExecutionReviewComposition(attempt.composition);
      } catch {
        return refuse('review-state-invalid');
      }
      if (
        saved.configurationId !== attempt.configurationId ||
        canonicalPayload(saved.payload.scope) !== canonicalPayload(scope) ||
        (attempt.nativeSessionId && nativeIds.has(attempt.nativeSessionId)) ||
        (attempt.nativeAgentId && nativeIds.has(attempt.nativeAgentId))
      )
        return refuse('review-state-invalid');
      if (attempt.nativeSessionId) nativeIds.add(attempt.nativeSessionId);
      if (attempt.nativeAgentId) nativeIds.add(attempt.nativeAgentId);
      try {
        const receipt = readExecutionReviewFixedReceipt(record, attempt);
        if (
          attempt.remote &&
          receipt &&
          (!attempt.remote.result ||
            receipt.requestId !== attempt.remote.result.requestId ||
            receipt.digest !== attempt.remote.result.digest ||
            receipt.provenanceFingerprint !== attempt.remote.result.provenanceFingerprint ||
            canonicalPayload(receipt.source) !== canonicalPayload(attempt.remote.result.source))
        )
          return refuse('review-state-invalid');
        readExecutionReviewFailure(record, attempt);
      } catch {
        return refuse('review-state-invalid');
      }
    }
  }
  const requests = new Set<string>();
  const receiptedRuns = new Set<string>();
  for (const receipt of review.receipts) {
    const attempt = review.attempts.find((item) => item.scope.runId === receipt.runId);
    if (
      requests.has(receipt.requestId) ||
      receiptedRuns.has(receipt.runId) ||
      !attempt ||
      ('remote' in attempt &&
        attempt.remote &&
        attempt.remote.acceptRequestId !== receipt.requestId) ||
      receipt.fingerprint !== reservationFingerprint(receipt.requestId, attempt)
    )
      return refuse('review-state-invalid');
    requests.add(receipt.requestId);
    receiptedRuns.add(receipt.runId);
  }
  if (review.receipts.length !== review.attempts.length) return refuse('review-state-invalid');
}
