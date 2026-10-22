import {
  transitionNode,
  type NodeStatus,
  type NodeTransition,
  type NodeTransitionResult,
} from './node-status.js';

export const REVIEW_ACTIONS = ['approve', 'request-changes', 'comment'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export type ReviewerAvailability = 'active' | 'unavailable' | 'timed-out';

export type ReviewOutcome = 'pending' | 'approved' | 'changes-requested';

export interface ReviewBallot {
  readonly reviewerId: string;
  readonly roundId: string;
  readonly artifactVersionId: string;
  readonly action: ReviewAction;
  readonly comment?: string;
  readonly unresolvedCommentIds?: readonly string[];
  readonly availability?: ReviewerAvailability;
}

export interface ReviewRound {
  readonly id: string;
  readonly artifactVersionId: string;
  readonly reviewerIds: readonly string[];
  readonly ballots: readonly ReviewBallot[];
  readonly status: 'open' | 'approved' | 'changes-requested' | 'voided';
}

export interface CitedComment {
  readonly id: string;
  readonly status: 'open' | 'resolved';
}

export type ReviewEvaluation =
  | {
      readonly outcome: 'pending';
      readonly approvedBy: readonly string[];
      readonly outstandingReviewerIds: readonly string[];
    }
  | { readonly outcome: 'changes-requested'; readonly rejectedBy: readonly string[] }
  | { readonly outcome: 'approved'; readonly approvedBy: readonly string[] }
  | { readonly outcome: 'invalid-policy'; readonly reason: 'review-requires-reviewers' };

export type BallotRejectionCode =
  | 'stale-round'
  | 'stale-version'
  | 'voided-round'
  | 'round-closed'
  | 'actor-mismatch'
  | 'not-assigned-reviewer'
  | 'empty-request-changes'
  | 'comment-not-unresolved'
  | 'non-passing-availability'
  | 'conflicting-ballot';

export type BallotDecision =
  | {
      readonly ok: true;
      readonly round: ReviewRound;
      readonly evaluation: ReviewEvaluation;
      readonly recorded: boolean;
    }
  | { readonly ok: false; readonly code: BallotRejectionCode };

export interface AgentReviewOutput {
  readonly conclusion?: 'approve' | 'request-changes' | 'comment';
  readonly rationale?: string;
  readonly anchors?: readonly string[];
  readonly evidence?: readonly string[];
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

function citedUnresolved(
  ids: readonly string[] | undefined,
  comments: readonly CitedComment[],
): 'none' | 'valid' | 'invalid' {
  const meaningful = (ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  if (meaningful.length === 0) return 'none';
  const openIds = new Set(
    comments.filter((comment) => comment.status === 'open').map((comment) => comment.id),
  );
  return meaningful.every((id) => openIds.has(id)) ? 'valid' : 'invalid';
}

function countsAsApproval(ballot: ReviewBallot): boolean {
  return (
    ballot.action === 'approve' &&
    (ballot.availability === undefined || ballot.availability === 'active')
  );
}

function countsAsRejection(ballot: ReviewBallot): boolean {
  if (ballot.action !== 'request-changes') return false;
  if (trimmed(ballot.comment).length > 0) return true;
  return (ballot.unresolvedCommentIds ?? []).some((id) => trimmed(id).length > 0);
}

function boundBallots(
  round: Pick<ReviewRound, 'id' | 'artifactVersionId' | 'ballots'>,
  reviewerId: string,
) {
  return round.ballots.filter(
    (ballot) =>
      ballot.reviewerId === reviewerId &&
      ballot.roundId === round.id &&
      ballot.artifactVersionId === round.artifactVersionId,
  );
}

function reviewerDecision(
  round: Pick<ReviewRound, 'id' | 'artifactVersionId' | 'ballots'>,
  reviewerId: string,
): 'approve' | 'request-changes' | 'none' {
  const ballots = boundBallots(round, reviewerId);
  if (ballots.some(countsAsRejection)) return 'request-changes';
  if (ballots.some(countsAsApproval)) return 'approve';
  return 'none';
}

/** All assigned reviewers must approve. One rejection blocks completion. */
export function aggregateReview(
  round: Pick<ReviewRound, 'id' | 'artifactVersionId' | 'reviewerIds' | 'ballots'>,
): ReviewEvaluation {
  if (round.reviewerIds.length === 0) {
    return { outcome: 'invalid-policy', reason: 'review-requires-reviewers' };
  }
  const rejectedBy = round.reviewerIds.filter(
    (reviewerId) => reviewerDecision(round, reviewerId) === 'request-changes',
  );
  if (rejectedBy.length > 0) return { outcome: 'changes-requested', rejectedBy };
  const approvedBy = round.reviewerIds.filter(
    (reviewerId) => reviewerDecision(round, reviewerId) === 'approve',
  );
  const outstandingReviewerIds = round.reviewerIds.filter(
    (reviewerId) => reviewerDecision(round, reviewerId) === 'none',
  );
  if (outstandingReviewerIds.length === 0) return { outcome: 'approved', approvedBy };
  return { outcome: 'pending', approvedBy, outstandingReviewerIds };
}

function duplicateReviewer(reviewerIds: readonly string[]): boolean {
  return new Set(reviewerIds).size !== reviewerIds.length;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

export function openReviewRound(input: {
  readonly id: string;
  readonly artifactVersionId: string;
  readonly reviewerIds: readonly string[];
}):
  | { readonly ok: true; readonly round: ReviewRound }
  | {
      readonly ok: false;
      readonly code: 'review-requires-reviewers' | 'duplicate-reviewer' | 'invalid-round';
    } {
  if (blank(input.id) || blank(input.artifactVersionId))
    return { ok: false, code: 'invalid-round' };
  if (input.reviewerIds.length === 0) return { ok: false, code: 'review-requires-reviewers' };
  if (input.reviewerIds.some((id) => blank(id)) || duplicateReviewer(input.reviewerIds)) {
    return { ok: false, code: 'duplicate-reviewer' };
  }
  return {
    ok: true,
    round: {
      id: input.id,
      artifactVersionId: input.artifactVersionId,
      reviewerIds: Object.freeze([...input.reviewerIds]),
      ballots: Object.freeze([]),
      status: 'open',
    },
  };
}

function terminalAction(
  round: ReviewRound,
  reviewerId: string,
): 'approve' | 'request-changes' | undefined {
  const decision = reviewerDecision(round, reviewerId);
  return decision === 'none' ? undefined : decision;
}

function withStatus(round: ReviewRound, evaluation: ReviewEvaluation): ReviewRound {
  const status =
    evaluation.outcome === 'approved' || evaluation.outcome === 'changes-requested'
      ? evaluation.outcome
      : 'open';
  return { ...round, status };
}

/**
 * Record one reviewer's action on the open round.
 * Votes aimed at another round or artifact version are refused and not stored.
 */
export function submitBallot(
  round: ReviewRound,
  ballot: ReviewBallot,
  actorId: string,
  comments: readonly CitedComment[] = [],
): BallotDecision {
  if (ballot.roundId !== round.id) return { ok: false, code: 'stale-round' };
  if (ballot.artifactVersionId !== round.artifactVersionId)
    return { ok: false, code: 'stale-version' };
  if (round.status === 'voided') return { ok: false, code: 'voided-round' };
  if (round.status !== 'open') return { ok: false, code: 'round-closed' };
  if (blank(actorId) || actorId !== ballot.reviewerId) return { ok: false, code: 'actor-mismatch' };
  if (!round.reviewerIds.includes(ballot.reviewerId))
    return { ok: false, code: 'not-assigned-reviewer' };
  if (ballot.action === 'request-changes') {
    const citation = citedUnresolved(ballot.unresolvedCommentIds, comments);
    if (citation === 'invalid') return { ok: false, code: 'comment-not-unresolved' };
    if (trimmed(ballot.comment).length === 0 && citation !== 'valid') {
      return { ok: false, code: 'empty-request-changes' };
    }
  }
  if (
    ballot.action === 'approve' &&
    ballot.availability !== undefined &&
    ballot.availability !== 'active'
  ) {
    return { ok: false, code: 'non-passing-availability' };
  }
  const existing = terminalAction(round, ballot.reviewerId);
  if (existing && ballot.action !== 'comment') {
    if (existing === ballot.action) {
      return { ok: true, round, evaluation: aggregateReview(round), recorded: false };
    }
    return { ok: false, code: 'conflicting-ballot' };
  }
  const storedBallot: ReviewBallot = {
    reviewerId: ballot.reviewerId,
    roundId: ballot.roundId,
    artifactVersionId: ballot.artifactVersionId,
    action: ballot.action,
    ...(ballot.comment !== undefined ? { comment: ballot.comment } : {}),
    ...(ballot.unresolvedCommentIds !== undefined
      ? { unresolvedCommentIds: Object.freeze([...ballot.unresolvedCommentIds]) }
      : {}),
    ...(ballot.availability !== undefined ? { availability: ballot.availability } : {}),
  };
  const next: ReviewRound = {
    ...round,
    ballots: Object.freeze([...round.ballots, storedBallot]),
  };
  const evaluation = aggregateReview(next);
  return { ok: true, round: withStatus(next, evaluation), evaluation, recorded: true };
}

/**
 * Reviewer edits apply to the open round only.
 * Dropping someone who already requested changes cannot turn the round into a pass.
 */
export function changeReviewers(
  round: ReviewRound,
  nextReviewerIds: readonly string[],
):
  | { readonly ok: true; readonly round: ReviewRound; readonly evaluation: ReviewEvaluation }
  | {
      readonly ok: false;
      readonly code:
        | 'cannot-drop-rejection'
        | 'round-closed'
        | 'review-requires-reviewers'
        | 'duplicate-reviewer';
      readonly rejectedBy?: readonly string[];
    } {
  if (nextReviewerIds.length === 0) return { ok: false, code: 'review-requires-reviewers' };
  if (nextReviewerIds.some((id) => blank(id)) || duplicateReviewer(nextReviewerIds)) {
    return { ok: false, code: 'duplicate-reviewer' };
  }
  const rejectedBy = round.reviewerIds.filter(
    (reviewerId) =>
      reviewerDecision(round, reviewerId) === 'request-changes' &&
      !nextReviewerIds.includes(reviewerId),
  );
  if (rejectedBy.length > 0) return { ok: false, code: 'cannot-drop-rejection', rejectedBy };
  if (round.status !== 'open') return { ok: false, code: 'round-closed' };
  const next: ReviewRound = { ...round, reviewerIds: Object.freeze([...nextReviewerIds]) };
  const evaluation = aggregateReview(next);
  return { ok: true, round: withStatus(next, evaluation), evaluation };
}

/**
 * Structured agent reviews only. Missing conclusion, rationale, or location is not approval.
 */
export function interpretAgentReview(
  output: AgentReviewOutput,
):
  | { readonly ok: true; readonly action: ReviewAction; readonly rationale: string }
  | { readonly ok: false; readonly code: 'abnormal-output' } {
  if (
    output.conclusion !== 'approve' &&
    output.conclusion !== 'request-changes' &&
    output.conclusion !== 'comment'
  ) {
    return { ok: false, code: 'abnormal-output' };
  }
  const rationale = trimmed(output.rationale);
  if (rationale.length === 0) return { ok: false, code: 'abnormal-output' };
  const located =
    (output.anchors ?? []).some((anchor) => trimmed(anchor).length > 0) ||
    (output.evidence ?? []).some((item) => trimmed(item).length > 0);
  if ((output.conclusion === 'approve' || output.conclusion === 'request-changes') && !located) {
    return { ok: false, code: 'abnormal-output' };
  }
  return { ok: true, action: output.conclusion, rationale };
}

const ROUND_VOIDING_TRANSITIONS = new Set<NodeTransition['type']>([
  'cancel-confirmed',
  'restart',
  'submit-artifact',
]);

/** An open round becomes voided. Closed rounds stay closed so their record remains. */
export function voidOpenRound(round: ReviewRound): ReviewRound {
  if (round.status !== 'open') return round;
  return { ...round, status: 'voided' };
}

/**
 * Cancelling, restarting, or submitting a new version voids the open round.
 * A rejected node transition leaves the round untouched.
 */
export function reviewRoundAfterNodeTransition(
  round: ReviewRound,
  result: NodeTransitionResult,
  transition: NodeTransition,
): ReviewRound {
  if (!result.ok || !ROUND_VOIDING_TRANSITIONS.has(transition.type)) return round;
  return voidOpenRound(round);
}

export type ReviewApplicationRejection =
  'stale-round' | 'stale-version' | 'voided-round' | 'unbound-evaluation';

function evaluationMatchesRound(
  round: Pick<ReviewRound, 'status'>,
  evaluation: ReviewEvaluation,
): boolean {
  if (evaluation.outcome === 'approved') return round.status === 'approved';
  if (evaluation.outcome === 'changes-requested') return round.status === 'changes-requested';
  return round.status === 'open';
}

/**
 * Apply a review result only when it belongs to the node's current, non-voided round.
 * Pending and invalid policies do not advance the node.
 */
export function applyReviewToNode(
  status: NodeStatus,
  input: {
    readonly evaluation: ReviewEvaluation;
    readonly round: Pick<ReviewRound, 'id' | 'artifactVersionId' | 'status'>;
    readonly currentRoundId: string;
    readonly currentArtifactVersionId: string;
  },
): NodeTransitionResult | { readonly ok: false; readonly code: ReviewApplicationRejection } {
  if (input.round.status === 'voided') return { ok: false, code: 'voided-round' };
  if (input.round.id !== input.currentRoundId) return { ok: false, code: 'stale-round' };
  if (input.round.artifactVersionId !== input.currentArtifactVersionId) {
    return { ok: false, code: 'stale-version' };
  }
  if (!evaluationMatchesRound(input.round, input.evaluation)) {
    return { ok: false, code: 'unbound-evaluation' };
  }
  if (input.evaluation.outcome === 'pending' || input.evaluation.outcome === 'invalid-policy') {
    if (status !== 'in-review') {
      return { ok: false, code: 'illegal-transition', from: status, transition: 'review-resolved' };
    }
    return { ok: true, from: status, to: status, changed: false, effects: Object.freeze([]) };
  }
  if (status !== 'in-review') {
    return { ok: false, code: 'illegal-transition', from: status, transition: 'review-resolved' };
  }
  if (input.evaluation.outcome === 'approved') {
    return {
      ok: true,
      from: status,
      to: 'completed',
      changed: true,
      effects: Object.freeze(['accept-handoff']),
    };
  }
  return {
    ok: true,
    from: status,
    to: 'needs-revision',
    changed: true,
    effects: Object.freeze(['block-downstream']),
  };
}

/** Review cannot be required with an empty roster. The node does not move in that case. */
export function transitionForSubmission(
  from: NodeStatus,
  input: { readonly reviewRequired: boolean; readonly reviewerIds: readonly string[] },
):
  | NodeTransitionResult
  | { readonly ok: false; readonly code: 'review-requires-reviewers'; readonly from: NodeStatus } {
  if (input.reviewRequired && input.reviewerIds.length === 0) {
    return { ok: false, code: 'review-requires-reviewers', from };
  }
  return transitionNode(from, { type: 'submit-artifact', reviewRequired: input.reviewRequired });
}
