import { z } from 'zod';
import { interpretAgentReview } from '@zhuma/agent-core';
import { remoteReviewBindingSchema } from './remote-review-state.js';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const integer = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = integer.refine((value) => value > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactId = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => value.trim() === value);

/** Host-internal data contracts. Parsing these values never issues authority. */
export const EXECUTION_REVIEW_LIMITS = Object.freeze({
  attempts: 64,
  receipts: 256,
  attemptsPerTargetReviewer: 1,
  automaticRevisions: 0,
  rationaleCharacters: 100_000,
  citations: 50,
  citationCharacters: 2000,
});

export const executionReviewTargetSchema = z.strictObject({
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  roundId: artifactId,
  artifactVersionId: artifactId,
  artifactFingerprint: digest,
});
export type ExecutionReviewTarget = z.infer<typeof executionReviewTargetSchema>;

export const executionReviewPrincipalSchema = z.strictObject({
  kind: z.literal('expert'),
  controllerMemberId: id,
  reviewerRef: z.strictObject({ id, version: id, digest }),
});
export type ExecutionReviewPrincipal = z.infer<typeof executionReviewPrincipalSchema>;

export const executionReviewBindingSchema = z.strictObject({
  target: executionReviewTargetSchema,
  principal: executionReviewPrincipalSchema,
});
export type ExecutionReviewBinding = z.infer<typeof executionReviewBindingSchema>;

/** Separate persistence/session lane; actorId remains the real human controller. */
export const executionReviewScopeSchema = z
  .strictObject({
    actorId: id,
    spaceId: id,
    taskId: id,
    planId: id,
    revision: positive,
    nodeId: id,
    runId: id,
    generation: positive,
    segmentId: id,
    review: executionReviewBindingSchema,
  })
  .refine(
    (scope) =>
      scope.actorId === scope.review.principal.controllerMemberId &&
      scope.spaceId === scope.review.target.spaceId &&
      scope.taskId === scope.review.target.taskId &&
      scope.planId === scope.review.target.planId &&
      scope.revision === scope.review.target.revision &&
      scope.nodeId === scope.review.target.nodeId &&
      scope.review.principal.reviewerRef.version === scope.planId,
  );
export type ExecutionReviewScope = z.infer<typeof executionReviewScopeSchema>;

/** Content only: evidence strings are never proof that a tool actually read the target. */
export const executionReviewOutputSchema = z
  .strictObject({
    conclusion: z.enum(['approve', 'request-changes', 'comment']),
    rationale: z.string().max(EXECUTION_REVIEW_LIMITS.rationaleCharacters),
    anchors: z
      .array(z.string().max(EXECUTION_REVIEW_LIMITS.citationCharacters))
      .max(EXECUTION_REVIEW_LIMITS.citations)
      .optional(),
    evidence: z
      .array(z.string().max(EXECUTION_REVIEW_LIMITS.citationCharacters))
      .max(EXECUTION_REVIEW_LIMITS.citations)
      .optional(),
  })
  .refine(
    (output) =>
      interpretAgentReview({
        conclusion: output.conclusion,
        rationale: output.rationale,
        ...(output.anchors === undefined ? {} : { anchors: output.anchors }),
        ...(output.evidence === undefined ? {} : { evidence: output.evidence }),
      }).ok,
  );
export type ExecutionReviewOutput = z.infer<typeof executionReviewOutputSchema>;

/** A durable reservation is not a native start, a completed review, or a ballot. */
const reviewAttemptFields = {
  version: positive,
  scope: executionReviewScopeSchema,
  configurationId: id,
};
const preparedReviewAttemptSchema = z.strictObject({
  ...reviewAttemptFields,
  status: z.literal('prepared'),
  dispatch: z.literal('reserved'),
  resources: z.literal('held'),
});
const admittedReviewAttemptSchema = z
  .strictObject({
    ...reviewAttemptFields,
    // The shared record validator verifies the actual serialized composition;
    // the data contract must not import a runtime/composition dependency here.
    composition: z.unknown(),
    remote: remoteReviewBindingSchema.optional(),
    result: z.unknown().optional(),
    failure: z.unknown().optional(),
    status: z.enum(['requested', 'running', 'completed', 'failed', 'cancelled']),
    dispatch: z.enum(['reserved', 'received', 'unknown']),
    resources: z.enum(['held', 'settled']),
    stopPhase: z.enum(['none', 'requested', 'confirmed']),
    lastEventSequence: integer,
    nativeSessionId: id.optional(),
    nativeAgentId: id.optional(),
    lastEvent: z.strictObject({ sequence: positive, fingerprint: digest }).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.version < 2 ||
      (value.nativeSessionId === undefined) !== (value.nativeAgentId === undefined) ||
      (value.nativeSessionId !== undefined && value.nativeSessionId !== value.nativeAgentId) ||
      (value.nativeSessionId !== undefined && value.dispatch === 'reserved') ||
      (['running', 'completed'].includes(value.status) && !value.nativeSessionId) ||
      (value.status === 'requested' && value.dispatch === 'received' && !value.nativeSessionId) ||
      (value.resources === 'settled' && ['requested', 'running'].includes(value.status)) ||
      (value.status === 'cancelled' && value.stopPhase !== 'confirmed') ||
      (value.status !== 'cancelled' && value.stopPhase === 'confirmed') ||
      (value.status === 'completed' && value.stopPhase !== 'none') ||
      (value.result !== undefined && value.status !== 'completed') ||
      (value.failure !== undefined && value.status !== 'failed') ||
      (value.lastEventSequence === 0 &&
        (value.status !== 'requested' ||
          value.stopPhase !== 'none' ||
          value.resources !== 'held' ||
          value.dispatch !== 'reserved' ||
          value.nativeSessionId !== undefined)) ||
      (value.lastEventSequence === 0
        ? value.lastEvent !== undefined
        : value.lastEvent?.sequence !== value.lastEventSequence)
    )
      context.addIssue({ code: 'custom', message: 'Invalid review attempt lifecycle.' });
  });
export const executionReviewAttemptSchema = z.union([
  preparedReviewAttemptSchema,
  admittedReviewAttemptSchema,
]);
export type ExecutionReviewAttempt = z.infer<typeof executionReviewAttemptSchema>;

export const executionReviewStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: positive,
  attempts: z.array(executionReviewAttemptSchema).min(1).max(EXECUTION_REVIEW_LIMITS.attempts),
  receipts: z
    .array(z.strictObject({ requestId: id, fingerprint: digest, runId: id }))
    .min(1)
    .max(EXECUTION_REVIEW_LIMITS.receipts),
});
export type ExecutionReviewState = z.infer<typeof executionReviewStateSchema>;

export const prepareExecutionReviewSchema = z.strictObject({
  requestId: id,
  expectedReviewVersion: integer,
  target: executionReviewTargetSchema,
  reviewerId: id,
  controllerMemberId: id,
  configurationId: id,
  newRunId: id,
  newSegmentId: id,
});

export const EXECUTION_REVIEW_ERRORS = [
  'review-validation',
  'review-state-invalid',
  'review-target-stale',
  'review-plan-mismatch',
  'review-not-controller',
  'review-expert-unavailable',
  'review-not-assigned',
  'review-self-review',
  'review-provenance-invalid',
  'review-already-voted',
  'review-conflict',
  'review-idempotency-mismatch',
  'review-capacity',
  'review-attempt-budget',
  'review-run-id-conflict',
  'review-author-active',
  'review-not-prepared',
  'review-not-admitted',
  'review-not-running',
  'review-stopping',
  'review-stop-not-requested',
  'review-event-mismatch',
  'review-session-mismatch',
  'review-native-active',
] as const;
export type ExecutionReviewErrorCode = (typeof EXECUTION_REVIEW_ERRORS)[number];
export class ExecutionReviewError extends Error {
  constructor(readonly code: ExecutionReviewErrorCode) {
    super('专家评审操作未完成。');
    this.name = 'ExecutionReviewError';
  }
}
