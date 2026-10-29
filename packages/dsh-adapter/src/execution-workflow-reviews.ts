import { createHash } from 'node:crypto';
import {
  canonicalPayload,
  type RemoteWorkflowIntent,
  type ExecutionNodeRecord,
} from '@zhuma/agent-core';
import { executionReviewTarget, readExecutionReviewState } from './execution-review-state.js';
import type { ExecutionReviewAttempt, ExecutionReviewTarget } from './execution-review-contract.js';
import { readExecutionRunState } from './execution-run-state.js';
import type { WorkflowExecutionIntent } from './execution-workflow-contract.js';
import { isStoppedReviewHistory } from './execution-review-record.js';

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
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

/** Original durable Stop facts, not a native drain or driving authority. The
 * Service checks them only under its original writer/member/queue gates. */
export function hasCommittedWorkflowStop(
  node: ExecutionNodeRecord,
  intent: WorkflowExecutionIntent,
  generation: number,
): boolean {
  return intent.commandReceipts.some(
    (receipt) =>
      receipt.kind === 'stop' &&
      receipt.generation === generation &&
      receipt.fingerprint ===
        hash({
          kind: 'stop',
          memberId: intent.actorId,
          spaceId: intent.spaceId,
          taskId: node.taskId,
          planId: node.planId,
          revision: node.revision,
          requestId: receipt.requestId,
          intentId: intent.intentId,
          generation,
        }),
  );
}

/** Review attempt generations count attempts, not workflow generations. Locate
 * the actual automatic receipt's generation and its original committed Stop. */
export function stoppedWorkflowReviewGeneration(
  node: ExecutionNodeRecord,
  intent: WorkflowExecutionIntent,
  attempt: ExecutionReviewAttempt,
): number | undefined {
  const { scope } = attempt;
  if (
    node.ownerId !== intent.actorId ||
    scope.actorId !== intent.actorId ||
    scope.spaceId !== intent.spaceId ||
    scope.taskId !== node.taskId ||
    scope.planId !== node.planId ||
    scope.revision !== node.revision ||
    scope.nodeId !== node.nodeId
  )
    return undefined;
  const receipt = readExecutionReviewState(node)?.receipts.find(
    (item) => item.runId === scope.runId,
  );
  return intent.commandReceipts.find(
    (stop) =>
      stop.kind === 'stop' &&
      stop.generation <= intent.generation &&
      receipt?.requestId ===
        workflowReviewRequestId(
          { ...intent, generation: stop.generation },
          scope.review.target,
          scope.review.principal.reviewerRef.id,
        ) &&
      hasCommittedWorkflowStop(node, intent, stop.generation),
  )?.generation;
}

/** Exact logical reservations fenced before native admission. A committed Stop
 * is written after the original queue barrier: earlier successful admission is
 * then no longer prepared, and the fenced claim cannot admit later. Keep all
 * metadata/held labels; this set never asserts physical retirement. */
export function stoppedPreparedWorkflowReviewRunIds(
  node: ExecutionNodeRecord,
  intent: WorkflowExecutionIntent,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (node.command.status !== 'in-review') return result;
  const state = readExecutionReviewState(node);
  if (!state?.attempts.some((attempt) => attempt.status === 'prepared')) return result;
  const target = executionReviewTarget(node, intent.spaceId);
  const round = node.rounds.find((item) => item.id === target.roundId)!;
  const stopped = stoppedPreparedReservations(node, intent);
  for (const attempt of state?.attempts ?? []) {
    if (
      stopped.has(attempt.scope.runId) &&
      canonicalPayload(attempt.scope.review.target) === canonicalPayload(target) &&
      !round.ballots.some(
        (ballot) => ballot.reviewerId === attempt.scope.review.principal.reviewerRef.id,
      )
    )
      result.add(attempt.scope.runId);
  }
  return result;
}

/** Logical reservations on closed targets only. The author Service must still
 * validate its returned round, member, writer and old native author drain. This
 * neither changes the retained prepared/held record nor certifies native drain. */
export function stoppedPreparedWorkflowReviewRunIdsForRevision(
  node: ExecutionNodeRecord,
  intent: WorkflowExecutionIntent,
): ReadonlySet<string> {
  if (
    node.command.status !== 'needs-revision' ||
    node.rounds.find((round) => round.id === node.currentRoundId)?.status !== 'changes-requested'
  )
    return new Set<string>();
  const stopped = stoppedPreparedReservations(node, intent);
  return new Set(
    (readExecutionReviewState(node)?.attempts ?? [])
      .filter(
        (attempt) =>
          stopped.has(attempt.scope.runId) &&
          node.rounds.find((round) => round.id === attempt.scope.review.target.roundId)?.status !==
            'open',
      )
      .map((attempt) => attempt.scope.runId),
  );
}

function stoppedPreparedReservations(
  node: ExecutionNodeRecord,
  intent: WorkflowExecutionIntent,
): ReadonlySet<string> {
  const result = new Set<string>();
  const state = readExecutionReviewState(node);
  for (const attempt of state?.attempts ?? []) {
    if (
      attempt.status !== 'prepared' ||
      attempt.version !== 1 ||
      attempt.dispatch !== 'reserved' ||
      attempt.resources !== 'held' ||
      !/^review_composition_[a-f0-9]{64}$/u.test(attempt.configurationId)
    )
      continue;
    const target = attempt.scope.review.target;
    const receipt = state!.receipts.find((item) => item.runId === attempt.scope.runId)!;
    const reservation = hash({
      location: target,
      controllerMemberId: attempt.scope.actorId,
      requestId: receipt.requestId,
    });
    const generation = stoppedWorkflowReviewGeneration(node, intent, attempt);
    if (
      generation === undefined ||
      (generation === intent.generation && intent.status !== 'stopping') ||
      attempt.scope.runId !== `review-run-${reservation}` ||
      attempt.scope.segmentId !== `review-segment-${reservation}`
    )
      continue;
    result.add(attempt.scope.runId);
  }
  return result;
}
export type WorkflowReviewResource = Exclude<ExecutionReviewAttempt, { status: 'prepared' }>;
/** Only explicit Stop/Resume may replace a cancelled, unvoted review of this
 * same fixed target. The actual original C proof is mandatory in this Host;
 * stored settled labels, a different vote or a caller list are insufficient. */
export function stoppedWorkflowReviewRunIds(
  node: ExecutionNodeRecord,
  intent: WorkflowExecutionIntent,
  assertDrained?: (review: WorkflowReviewResource) => void,
): ReadonlySet<string> {
  const result = new Set(stoppedPreparedWorkflowReviewRunIds(node, intent));
  if (!assertDrained || node.command.status !== 'in-review') return result;
  const state = readExecutionReviewState(node);
  if (!state?.attempts.some(isStoppedReviewHistory)) return result;
  const target = executionReviewTarget(node, intent.spaceId);
  const round = node.rounds.find((item) => item.id === target.roundId)!;
  if (node.acceptedArtifactVersionId === target.artifactVersionId) return result;
  for (const attempt of state.attempts) {
    if (
      attempt.status === 'prepared' ||
      !isStoppedReviewHistory(attempt) ||
      canonicalPayload(attempt.scope.review.target) !== canonicalPayload(target) ||
      round.ballots.some(
        (ballot) => ballot.reviewerId === attempt.scope.review.principal.reviewerRef.id,
      )
    )
      continue;
    const generation = stoppedWorkflowReviewGeneration(node, intent, attempt);
    if (
      generation === undefined ||
      (generation === intent.generation && intent.status !== 'stopping')
    )
      continue;
    try {
      const checked: unknown = assertDrained(attempt);
      if (checked !== undefined) {
        void Promise.resolve(checked).catch(() => undefined);
        continue;
      }
      result.add(attempt.scope.runId);
    } catch {
      // No fresh original C proof means the original attention/budget remains.
    }
  }
  return result;
}
/** Remote retry eligibility comes only from the original signed cleanup and
 * committed Stop followed by an explicit new generation on this same device.
 * A read query identifies these facts; it cannot arm or authorize a new Run. */
export function stoppedRemoteWorkflowReviewRunIds(
  node: ExecutionNodeRecord,
  intent: RemoteWorkflowIntent,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (intent.status !== 'running' || node.command.status !== 'in-review') return result;
  const target = executionReviewTarget(node, intent.spaceId);
  const round = node.rounds.find((item) => item.id === target.roundId)!;
  if (node.acceptedArtifactVersionId === target.artifactVersionId) return result;
  for (const attempt of readExecutionReviewState(node)?.attempts ?? []) {
    if (attempt.status === 'prepared' || !isStoppedReviewHistory(attempt)) continue;
    const remote = attempt.remote,
      binding = remote?.workflow;
    if (
      !remote ||
      !binding ||
      !remote.stopRequested ||
      remote.lastObservation !== 'drained' ||
      binding.intentId !== intent.intentId ||
      binding.generation >= intent.generation ||
      remote.deviceId !== intent.deviceId ||
      remote.keyEpoch !== intent.keyEpoch ||
      attempt.scope.actorId !== intent.actorId ||
      attempt.scope.spaceId !== intent.spaceId ||
      canonicalPayload(attempt.scope.review.target) !== canonicalPayload(target) ||
      round.ballots.some(
        (ballot) => ballot.reviewerId === attempt.scope.review.principal.reviewerRef.id,
      )
    )
      continue;
    const stop = intent.commandReceipts.some(
      (receipt) =>
        receipt.kind === 'stop' &&
        receipt.generation === binding.generation &&
        receipt.fingerprint ===
          hash({
            actorId: intent.actorId,
            deviceId: intent.deviceId,
            kind: 'stop',
            payload: {
              target: {
                spaceId: intent.spaceId,
                taskId: node.taskId,
                planId: node.planId,
                revision: node.revision,
              },
              workflow: { intentId: intent.intentId, generation: binding.generation },
            },
          }),
    );
    if (stop) result.add(attempt.scope.runId);
  }
  return result;
}
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
  intent?: WorkflowExecutionIntent,
  assertDrained?: (review: WorkflowReviewResource) => void,
): WorkflowReviewAttention[] {
  return nodes.flatMap((node) => {
    if (node.command.status !== 'in-review') return [];
    const stopped = intent
      ? stoppedWorkflowReviewRunIds(node, intent, assertDrained)
      : new Set<string>();
    return (readExecutionReviewState(node)?.attempts ?? []).flatMap(
      (attempt): WorkflowReviewAttention[] => {
        const { target, principal } = attempt.scope.review;
        const round = node.rounds.find((round) => round.id === target.roundId);
        if (round?.status !== 'open') return [];
        if (stopped.has(attempt.scope.runId)) return [];
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
  assertDrained?: (review: WorkflowReviewResource) => void,
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
    const stopped = stoppedWorkflowReviewRunIds(node, intent, assertDrained);
    if (
      state?.attempts.some(
        (attempt) =>
          attempt.status === 'prepared' &&
          !stopped.has(attempt.scope.runId) &&
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
            !stopped.has(attempt.scope.runId) &&
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
