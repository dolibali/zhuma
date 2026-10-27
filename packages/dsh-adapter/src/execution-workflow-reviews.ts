import { createHash } from 'node:crypto';
import { canonicalPayload, type ExecutionNodeRecord } from '@zhuma/agent-core';
import { executionReviewTarget, readExecutionReviewState } from './execution-review-state.js';
import type { ExecutionReviewAttempt, ExecutionReviewTarget } from './execution-review-contract.js';
import { readExecutionRunState } from './execution-run-state.js';
import type { WorkflowExecutionIntent } from './execution-workflow-contract.js';

export const WORKFLOW_REVIEW_REQUEST_PREFIX = 'workflow-review-';
export function workflowReviewRequestId(
  intent: Pick<WorkflowExecutionIntent, 'intentId' | 'generation'>,
  target: ExecutionReviewTarget,
  reviewerId: string,
): string {
  return `${WORKFLOW_REVIEW_REQUEST_PREFIX}${createHash('sha256')
    .update(canonicalPayload([intent.intentId, intent.generation, target, reviewerId]))
    .digest('hex')}`;
}
export type WorkflowReviewResource = Exclude<ExecutionReviewAttempt, { status: 'prepared' }>;
/** Original attempt metadata, not native readiness, a drive or a drain. */
export function workflowReviewResources(nodes: readonly ExecutionNodeRecord[]) {
  return nodes.flatMap((node) =>
    (readExecutionReviewState(node)?.attempts ?? []).filter(
      (attempt): attempt is WorkflowReviewResource => attempt.status !== 'prepared',
    ),
  );
}
export function workflowReviewOccupied(
  nodes: readonly ExecutionNodeRecord[],
  intent: WorkflowExecutionIntent,
): number {
  return nodes.reduce((total, node) => {
    const state = readExecutionReviewState(node);
    return (
      total +
      (state?.attempts ?? []).filter(
        (attempt) =>
          attempt.resources === 'held' &&
          (attempt.status !== 'prepared' ||
            state!.receipts.some(
              (receipt) =>
                receipt.runId === attempt.scope.runId &&
                receipt.requestId ===
                  workflowReviewRequestId(
                    intent,
                    attempt.scope.review.target,
                    attempt.scope.review.principal.reviewerRef.id,
                  ),
            )),
      ).length
    );
  }, 0);
}
export interface WorkflowReviewCandidate {
  readonly requestId: string;
  readonly expectedReviewVersion: number;
  readonly target: ExecutionReviewTarget;
  readonly reviewerRef: { readonly id: string; readonly version: string };
}
export interface WorkflowReviewAttention {
  readonly target: ExecutionReviewTarget;
  readonly reviewerId: string;
  readonly code:
    | 'review-attempt-reserved'
    | 'review-attempt-failed'
    | 'review-stopped'
    | 'review-comment-pending';
}
export function workflowReviewAttention(
  nodes: readonly ExecutionNodeRecord[],
): WorkflowReviewAttention[] {
  return nodes.flatMap((node) => {
    if (node.command.status !== 'in-review') return [];
    return (readExecutionReviewState(node)?.attempts ?? []).flatMap(
      (attempt): WorkflowReviewAttention[] => {
        const { target, principal } = attempt.scope.review;
        const round = node.rounds.find((round) => round.id === target.roundId);
        if (round?.status !== 'open') return [];
        const code =
          attempt.status === 'prepared'
            ? 'review-attempt-reserved'
            : attempt.status === 'failed'
              ? 'review-attempt-failed'
              : attempt.status === 'cancelled'
                ? 'review-stopped'
                : attempt.status === 'completed' &&
                    round.ballots.some(
                      (ballot) =>
                        ballot.reviewerId === principal.reviewerRef.id &&
                        ballot.action === 'comment',
                    )
                  ? 'review-comment-pending'
                  : undefined;
        return code ? [{ target, reviewerId: principal.reviewerRef.id, code }] : [];
      },
    );
  });
}
/** A metadata candidate is not a reservation or dispatch permission. One review
 * per node is prepared at a time; all nodes share the original workflow budget. */
export function workflowReviewCandidates(
  nodes: readonly ExecutionNodeRecord[],
  intent: WorkflowExecutionIntent,
  availableExpertIds: readonly string[],
): WorkflowReviewCandidate[] {
  const result: WorkflowReviewCandidate[] = [];
  for (const node of nodes) {
    const state = readExecutionReviewState(node);
    if (
      node.command.status !== 'in-review' ||
      node.command.upstreamAffected ||
      readExecutionRunState(node)?.runs.some((run) => run.resources !== 'settled') ||
      state?.attempts.some(
        (attempt) => attempt.status !== 'prepared' && attempt.resources !== 'settled',
      )
    )
      continue;
    const target = executionReviewTarget(node, intent.spaceId);
    if (
      state?.attempts.some(
        (attempt) =>
          attempt.status === 'prepared' &&
          attempt.scope.review.target.roundId === target.roundId &&
          attempt.scope.review.target.artifactVersionId === target.artifactVersionId,
      )
    )
      continue;
    const round = node.rounds.find((item) => item.id === target.roundId)!;
    const artifact = node.artifactVersions.find((item) => item.id === target.artifactVersionId)!;
    for (const reviewerId of round.reviewerIds) {
      if (
        !availableExpertIds.includes(reviewerId) ||
        !node.handoff.reviewerIds.includes(reviewerId) ||
        reviewerId === node.handoff.assignee.id ||
        reviewerId === artifact.submittedBy ||
        round.ballots.some((ballot) => ballot.reviewerId === reviewerId) ||
        state?.attempts.some(
          (attempt) =>
            attempt.scope.review.target.roundId === target.roundId &&
            attempt.scope.review.target.artifactVersionId === target.artifactVersionId &&
            attempt.scope.review.principal.reviewerRef.id === reviewerId,
        )
      )
        continue;
      result.push({
        requestId: workflowReviewRequestId(intent, target, reviewerId),
        expectedReviewVersion: state?.version ?? 0,
        target,
        reviewerRef: { id: reviewerId, version: node.planId },
      });
      break;
    }
  }
  return result;
}
