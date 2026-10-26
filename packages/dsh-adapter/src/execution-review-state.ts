import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AppliedPlanSchema,
  canonicalPayload,
  createNodeHandoffs,
  type AppliedPlan,
  type ArtifactVersion,
  type ExecutionNodeRecord,
} from '@zhuma/agent-core';
import {
  EXECUTION_RUN_LIMITS,
  readExecutionRunState,
  type ExecutionRunState,
} from './execution-run-state.js';
import {
  EXECUTION_REVIEW_LIMITS,
  ExecutionReviewError,
  executionReviewStateSchema,
  executionReviewTargetSchema,
  prepareExecutionReviewSchema,
  type ExecutionReviewAttempt,
  type ExecutionReviewBinding,
  type ExecutionReviewErrorCode,
  type ExecutionReviewState,
  type ExecutionReviewTarget,
} from './execution-review-contract.js';

/** Prepared data only. No storage, member authentication, native send, or voting here. */
const reviewOnlySchema = z.strictObject({ schemaVersion: z.literal(2) });
type ReviewNativeState = {
  readonly schemaVersion: 2;
  readonly review: ExecutionReviewState;
} & Partial<Omit<ExecutionRunState, 'schemaVersion'>>;
export type ExecutionReviewNode = ExecutionNodeRecord & {
  readonly nativeExecution: ReviewNativeState;
};

function refuse(code: ExecutionReviewErrorCode): never {
  throw new ExecutionReviewError(code);
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalPayload(value)).digest('hex');
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
function nativeParts(record: ExecutionNodeRecord): {
  author?: ExecutionRunState;
  review?: ExecutionReviewState;
} {
  if (!Object.hasOwn(record, 'nativeExecution')) return {};
  const raw = (record as { nativeExecution?: unknown }).nativeExecution;
  if (!raw || typeof raw !== 'object') return refuse('review-state-invalid');
  if (!Object.hasOwn(raw, 'review')) {
    try {
      const author = readExecutionRunState(record);
      return author ? { author: raw as ExecutionRunState } : refuse('review-state-invalid');
    } catch {
      return refuse('review-state-invalid');
    }
  }
  const { review, ...rest } = raw as Record<string, unknown>;
  if (rest.schemaVersion !== 2) return refuse('review-state-invalid');
  const parsed = executionReviewStateSchema.safeParse(review);
  if (!parsed.success) return refuse('review-state-invalid');
  if (Object.keys(rest).length === 1) {
    if (!reviewOnlySchema.safeParse(rest).success) return refuse('review-state-invalid');
    return { review: parsed.data };
  }
  try {
    const author = readExecutionRunState({
      ...record,
      nativeExecution: { ...rest, schemaVersion: 1 },
    } as ExecutionNodeRecord);
    if (!author) return refuse('review-state-invalid');
    // Retain the original author's fields verbatim after validation, including
    // optional-field presence and key order. Review preparation does not rewrite them.
    return {
      author: { ...rest, schemaVersion: 1 } as ExecutionRunState,
      review: parsed.data,
    };
  } catch {
    return refuse('review-state-invalid');
  }
}

export function executionReviewArtifactFingerprint(artifact: ArtifactVersion): string {
  return hash(artifact);
}

/** Exact current open target, including contents and immutable file references. */
export function executionReviewTarget(
  record: ExecutionNodeRecord,
  spaceId: string,
): ExecutionReviewTarget {
  const round = record.rounds.find((item) => item.id === record.currentRoundId);
  const artifact = record.artifactVersions.find((item) => item.id === round?.artifactVersionId);
  if (
    record.command.status !== 'in-review' ||
    !record.handoff.reviewRequired ||
    !round ||
    round.status !== 'open' ||
    !artifact ||
    artifact.nodeId !== record.nodeId
  )
    return refuse('review-target-stale');
  const parsed = executionReviewTargetSchema.safeParse({
    spaceId,
    taskId: record.taskId,
    planId: record.planId,
    revision: record.revision,
    nodeId: record.nodeId,
    roundId: round.id,
    artifactVersionId: artifact.id,
    artifactFingerprint: executionReviewArtifactFingerprint(artifact),
  });
  return parsed.success ? parsed.data : refuse('review-validation');
}

/** Historical lanes remain readable; they do not gain current-round authority. */
export function readExecutionReviewState(
  record: ExecutionNodeRecord,
): ExecutionReviewState | undefined {
  const { author, review } = nativeParts(record);
  if (!review) return undefined;
  if ((author?.runs.length ?? 0) + review.attempts.length > EXECUTION_RUN_LIMITS.runs)
    return refuse('review-state-invalid');
  const runIds = new Set(author?.runs.map((run) => run.attempt.id));
  const segments = new Set(author?.runs.map((run) => run.segmentId));
  const lanes = new Set<string>();
  for (const [index, attempt] of review.attempts.entries()) {
    const { scope } = attempt;
    const { target, principal } = scope.review;
    const artifact = record.artifactVersions.find((item) => item.id === target.artifactVersionId);
    const round = record.rounds.find((item) => item.id === target.roundId);
    const lane = canonicalPayload([target, principal.reviewerRef.id]);
    if (
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
      lanes.has(lane)
    )
      return refuse('review-state-invalid');
    runIds.add(scope.runId);
    segments.add(scope.segmentId);
    lanes.add(lane);
  }
  const requests = new Set<string>();
  const receiptedRuns = new Set<string>();
  for (const receipt of review.receipts) {
    const attempt = review.attempts.find((item) => item.scope.runId === receipt.runId);
    if (
      requests.has(receipt.requestId) ||
      receiptedRuns.has(receipt.runId) ||
      !attempt ||
      receipt.fingerprint !== reservationFingerprint(receipt.requestId, attempt)
    )
      return refuse('review-state-invalid');
    requests.add(receipt.requestId);
    receiptedRuns.add(receipt.runId);
  }
  if (review.receipts.length !== review.attempts.length) return refuse('review-state-invalid');
  return review;
}

/** Caller must first supply the original live member lease and trusted applied snapshot.
 * This pure derivation is intentionally not a grant and cannot call native tools. */
export function prepareExecutionReview(
  record: ExecutionNodeRecord,
  appliedInput: AppliedPlan,
  input: unknown,
): {
  readonly disposition: 'applied' | 'replayed';
  readonly record: ExecutionReviewNode;
  readonly attempt: ExecutionReviewAttempt;
} {
  const parsed = prepareExecutionReviewSchema.safeParse(input);
  if (!parsed.success) return refuse('review-validation');
  const request = parsed.data;
  const plan = AppliedPlanSchema.safeParse(appliedInput);
  if (!plan.success) return refuse('review-plan-mismatch');
  const applied = plan.data;
  let handoff;
  try {
    handoff = createNodeHandoffs(applied).find((node) => node.nodeId === record.nodeId);
  } catch {
    return refuse('review-plan-mismatch');
  }
  // Accepted upstream references are materialized later by the original queue.
  // They are not a mutation of the frozen node definition.
  const { inputRefs: _expectedInputs, ...expectedHandoff } = handoff ?? {};
  const { inputRefs: _actualInputs, ...actualHandoff } = record.handoff;
  if (
    applied.taskId !== record.taskId ||
    applied.id !== record.planId ||
    applied.revision !== record.revision ||
    !handoff ||
    canonicalPayload(expectedHandoff) !== canonicalPayload(actualHandoff)
  )
    return refuse('review-plan-mismatch');
  if (
    record.ownerId !== applied.task.ownerId ||
    request.controllerMemberId !== record.ownerId ||
    !applied.participants.some(
      (p) => p.id === request.controllerMemberId && p.kind === 'human' && p.available,
    )
  )
    return refuse('review-not-controller');
  const reviewer = applied.participants.find((p) => p.id === request.reviewerId);
  if (
    !reviewer ||
    reviewer.kind !== 'expert' ||
    !reviewer.available ||
    !reviewer.instructions.trim() ||
    reviewer.origin?.missing.length
  )
    return refuse('review-expert-unavailable');
  const target = executionReviewTarget(record, request.target.spaceId);
  if (canonicalPayload(target) !== canonicalPayload(request.target))
    return refuse('review-target-stale');
  const round = record.rounds.find((item) => item.id === target.roundId)!;
  const artifact = record.artifactVersions.find((item) => item.id === target.artifactVersionId)!;
  if (reviewer.id === record.handoff.assignee.id || reviewer.id === artifact.submittedBy)
    return refuse('review-self-review');
  if (!handoff.reviewerIds.includes(reviewer.id) || !round.reviewerIds.includes(reviewer.id))
    return refuse('review-not-assigned');
  const { author } = nativeParts(record);
  const state = readExecutionReviewState(record);
  if (author?.runs.some((run) => run.resources !== 'settled'))
    return refuse('review-author-active');
  if (
    artifact.producerRunId !== undefined &&
    !author?.runs.some(
      (run) => run.attempt.id === artifact.producerRunId && run.attempt.status === 'completed',
    )
  )
    return refuse('review-provenance-invalid');
  const binding: ExecutionReviewBinding = {
    target,
    principal: {
      kind: 'expert',
      controllerMemberId: request.controllerMemberId,
      reviewerRef: { id: reviewer.id, version: applied.id, digest: hash(reviewer) },
    },
  };
  const { expectedReviewVersion: _expected, ...identity } = request;
  const fingerprint = hash({ ...identity, binding });
  const prior = state?.receipts.find((receipt) => receipt.requestId === request.requestId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) return refuse('review-idempotency-mismatch');
    const attempt = state!.attempts.find((item) => item.scope.runId === prior.runId)!;
    return { disposition: 'replayed', record: record as ExecutionReviewNode, attempt };
  }
  if (
    round.ballots.some((ballot) => ballot.reviewerId === reviewer.id && ballot.action !== 'comment')
  )
    return refuse('review-already-voted');
  if (request.expectedReviewVersion !== (state?.version ?? 0)) return refuse('review-conflict');
  if (
    (author?.runs.length ?? 0) + (state?.attempts.length ?? 0) >= EXECUTION_RUN_LIMITS.runs ||
    (state?.receipts.length ?? 0) >= EXECUTION_REVIEW_LIMITS.receipts
  )
    return refuse('review-capacity');
  if (
    state?.attempts.some(
      (attempt) =>
        attempt.scope.review.target.roundId === target.roundId &&
        attempt.scope.review.target.artifactVersionId === target.artifactVersionId &&
        attempt.scope.review.principal.reviewerRef.id === reviewer.id,
    )
  )
    return refuse('review-attempt-budget');
  if (
    author?.runs.some(
      (run) => run.attempt.id === request.newRunId || run.segmentId === request.newSegmentId,
    ) ||
    state?.attempts.some(
      (attempt) =>
        attempt.scope.runId === request.newRunId ||
        attempt.scope.segmentId === request.newSegmentId,
    )
  )
    return refuse('review-run-id-conflict');
  const attempt: ExecutionReviewAttempt = {
    version: 1,
    scope: {
      actorId: request.controllerMemberId,
      spaceId: target.spaceId,
      taskId: target.taskId,
      planId: target.planId,
      revision: target.revision,
      nodeId: target.nodeId,
      runId: request.newRunId,
      generation: (state?.attempts.length ?? 0) + 1,
      segmentId: request.newSegmentId,
      review: binding,
    },
    configurationId: request.configurationId,
    status: 'prepared',
    dispatch: 'reserved',
    resources: 'held',
  };
  const review: ExecutionReviewState = {
    schemaVersion: 1,
    version: (state?.version ?? 0) + 1,
    attempts: [...(state?.attempts ?? []), attempt],
    receipts: [
      ...(state?.receipts ?? []),
      { requestId: request.requestId, fingerprint, runId: request.newRunId },
    ],
  };
  const next: ExecutionReviewNode = {
    ...record,
    nativeExecution: { ...author, schemaVersion: 2, review },
  };
  readExecutionReviewState(next);
  return { disposition: 'applied', record: next, attempt };
}
