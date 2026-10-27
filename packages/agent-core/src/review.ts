import { decideCommand, type CommandDecision, type CommandEnvelope } from './concurrency.js';
import {
  initialNodeCommandState,
  transitionNode,
  type AppliedNodeTransition,
  type NodeCommandState,
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
  /** When set, must be this round's artifact version. */
  readonly versionId?: string;
  /** When set, must name that same artifact version. */
  readonly targetId?: string;
}

export type ReviewEvaluation =
  | {
      readonly outcome: 'pending';
      readonly approvedBy: readonly string[];
      readonly outstandingReviewerIds: readonly string[];
    }
  | { readonly outcome: 'changes-requested'; readonly rejectedBy: readonly string[] }
  | { readonly outcome: 'approved'; readonly approvedBy: readonly string[] }
  | {
      readonly outcome: 'invalid-policy';
      readonly reason: 'review-requires-reviewers' | 'duplicate-reviewer' | 'invalid-reviewer-id';
    };

export type BallotRejectionCode =
  | 'stale-round'
  | 'stale-version'
  | 'voided-round'
  | 'round-closed'
  | 'actor-mismatch'
  | 'not-assigned-reviewer'
  | 'empty-request-changes'
  | 'empty-comment'
  | 'comment-not-unresolved'
  | 'non-passing-availability'
  | 'conflicting-ballot'
  | 'invalid-ballot';

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

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060\u180E]/g;

/** Zero-width characters and a soft hyphen do not count as comment text. */
function commentText(value: string | undefined): string {
  return (value ?? '')
    .replace(ZERO_WIDTH, '')
    .replace(/\u00ad/g, '')
    .trim();
}

/** Reviewer ids stay case-sensitive. Zero-width characters are not part of the id. */
function normalizeReviewerId(id: string): string {
  return id.replace(ZERO_WIDTH, '').trim();
}

function commentBelongsToRound(comment: CitedComment, artifactVersionId: string): boolean {
  if (comment.versionId !== undefined && comment.versionId !== artifactVersionId) return false;
  if (comment.targetId !== undefined && comment.targetId !== artifactVersionId) return false;
  return true;
}

function citedUnresolved(
  ids: readonly string[] | undefined,
  comments: readonly CitedComment[],
  artifactVersionId: string,
): 'none' | 'valid' | 'invalid' {
  const meaningful = (ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  if (meaningful.length === 0) return 'none';
  const openIds = new Set(
    comments
      .filter(
        (comment) => comment.status === 'open' && commentBelongsToRound(comment, artifactVersionId),
      )
      .map((comment) => comment.id),
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
  if (commentText(ballot.comment).length > 0) return true;
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
  if (round == null || typeof round !== 'object') {
    return { outcome: 'invalid-policy', reason: 'review-requires-reviewers' };
  }
  if (!Array.isArray(round.reviewerIds) || !Array.isArray(round.ballots)) {
    return { outcome: 'invalid-policy', reason: 'review-requires-reviewers' };
  }
  if (round.reviewerIds.length === 0) {
    return { outcome: 'invalid-policy', reason: 'review-requires-reviewers' };
  }
  if (round.reviewerIds.some((id) => typeof id !== 'string')) {
    return { outcome: 'invalid-policy', reason: 'invalid-reviewer-id' };
  }
  if (
    round.ballots.some(
      (ballot) =>
        ballot == null || typeof ballot !== 'object' || typeof ballot.reviewerId !== 'string',
    )
  ) {
    return { outcome: 'invalid-policy', reason: 'invalid-reviewer-id' };
  }
  if (duplicateReviewer(round.reviewerIds) || round.reviewerIds.some((id) => blank(id))) {
    return { outcome: 'invalid-policy', reason: 'duplicate-reviewer' };
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

function normalizeReviewerIds(
  reviewerIds: readonly unknown[],
):
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly code: 'invalid-round' | 'duplicate-reviewer' } {
  const ids: string[] = [];
  for (const id of reviewerIds) {
    if (typeof id !== 'string') return { ok: false, code: 'invalid-round' };
    const trimmedId = normalizeReviewerId(id);
    if (trimmedId.length === 0) return { ok: false, code: 'duplicate-reviewer' };
    ids.push(trimmedId);
  }
  if (new Set(ids).size !== ids.length) return { ok: false, code: 'duplicate-reviewer' };
  return { ok: true, ids: Object.freeze(ids) };
}

function duplicateReviewer(reviewerIds: readonly string[]): boolean {
  return !normalizeReviewerIds(reviewerIds).ok;
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
  if (!Array.isArray(input.reviewerIds) || input.reviewerIds.length === 0) {
    return { ok: false, code: 'review-requires-reviewers' };
  }
  const reviewers = normalizeReviewerIds(input.reviewerIds);
  if (!reviewers.ok) return { ok: false, code: reviewers.code };
  return {
    ok: true,
    round: {
      id: input.id,
      artifactVersionId: input.artifactVersionId,
      reviewerIds: reviewers.ids,
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
  if (
    round == null ||
    typeof round !== 'object' ||
    ballot == null ||
    typeof ballot !== 'object' ||
    !Array.isArray(round.ballots) ||
    !Array.isArray(round.reviewerIds)
  ) {
    return { ok: false, code: 'invalid-ballot' };
  }
  if (typeof ballot.reviewerId !== 'string') return { ok: false, code: 'invalid-ballot' };
  if (ballot.roundId !== round.id) return { ok: false, code: 'stale-round' };
  if (ballot.artifactVersionId !== round.artifactVersionId)
    return { ok: false, code: 'stale-version' };
  if (round.status === 'voided') return { ok: false, code: 'voided-round' };
  if (round.status !== 'open') return { ok: false, code: 'round-closed' };
  if (blank(actorId) || actorId !== ballot.reviewerId) return { ok: false, code: 'actor-mismatch' };
  if (!round.reviewerIds.includes(ballot.reviewerId))
    return { ok: false, code: 'not-assigned-reviewer' };
  if (ballot.action === 'request-changes') {
    const citation = citedUnresolved(
      ballot.unresolvedCommentIds,
      comments,
      round.artifactVersionId,
    );
    if (citation === 'invalid') return { ok: false, code: 'comment-not-unresolved' };
    if (commentText(ballot.comment).length === 0 && citation !== 'valid') {
      return { ok: false, code: 'empty-request-changes' };
    }
  }
  if (ballot.action === 'comment' && commentText(ballot.comment).length === 0) {
    return { ok: false, code: 'empty-comment' };
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

export interface ReviewerChangeAuthorization {
  readonly actorId: string;
  readonly authorized: boolean;
}

/**
 * Roster edits apply to the open round only, and only for an authorized actor.
 * Removing reviewers is a new round, not an in-place shrink. A shrink must not
 * turn silence or a timeout into approval. Dropping someone who already
 * requested changes cannot turn the round into a pass.
 */
export function changeReviewers(
  round: ReviewRound,
  nextReviewerIds: readonly string[],
  authorization?: ReviewerChangeAuthorization,
):
  | { readonly ok: true; readonly round: ReviewRound; readonly evaluation: ReviewEvaluation }
  | {
      readonly ok: false;
      readonly code:
        | 'cannot-drop-rejection'
        | 'round-closed'
        | 'voided-round'
        | 'review-requires-reviewers'
        | 'duplicate-reviewer'
        | 'invalid-round'
        | 'unauthorized'
        | 'requires-new-round';
      readonly rejectedBy?: readonly string[];
    } {
  if (!Array.isArray(nextReviewerIds) || nextReviewerIds.length === 0) {
    return { ok: false, code: 'review-requires-reviewers' };
  }
  const reviewers = normalizeReviewerIds(nextReviewerIds);
  if (!reviewers.ok) return { ok: false, code: reviewers.code };
  const roster = reviewers.ids;
  if (round.status === 'voided') return { ok: false, code: 'voided-round' };
  if (authorization === undefined || !authorization.authorized || blank(authorization.actorId)) {
    return { ok: false, code: 'unauthorized' };
  }
  const rejectedBy = round.reviewerIds.filter(
    (reviewerId) =>
      reviewerDecision(round, reviewerId) === 'request-changes' && !roster.includes(reviewerId),
  );
  if (rejectedBy.length > 0) return { ok: false, code: 'cannot-drop-rejection', rejectedBy };
  if (round.status !== 'open') return { ok: false, code: 'round-closed' };
  const removed = round.reviewerIds.filter((reviewerId) => !roster.includes(reviewerId));
  const added = roster.filter((reviewerId) => !round.reviewerIds.includes(reviewerId));
  if (removed.length > 0 && added.length === 0) return { ok: false, code: 'requires-new-round' };
  const next: ReviewRound = { ...round, reviewerIds: roster };
  const evaluation = aggregateReview(next);
  if (removed.length > 0 && evaluation.outcome === 'approved') {
    return { ok: false, code: 'requires-new-round' };
  }
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

/** An open round becomes voided. Closed rounds stay closed so their record remains. */
export function voidOpenRound(round: ReviewRound): ReviewRound {
  if (round.status !== 'open') return round;
  return { ...round, status: 'voided' };
}

/**
 * Cancel and restart void the open round, because the node has left review.
 * A new submission voids a round only when it is not the current round.
 * Passing the round just opened, or omitting the current id, leaves it open.
 * A rejected node transition leaves the round untouched.
 */
export function reviewRoundAfterNodeTransition(
  round: ReviewRound,
  result: NodeTransitionResult,
  transition: NodeTransition,
  currentRoundId?: string,
): ReviewRound {
  if (!result.ok || round.status !== 'open') return round;
  if (transition.type === 'cancel-confirmed' || transition.type === 'restart') {
    return voidOpenRound(round);
  }
  if (transition.type !== 'submit-artifact') return round;
  if (currentRoundId === undefined || round.id === currentRoundId) return round;
  return voidOpenRound(round);
}

/**
 * Open the next round and void the previous one only when it is a different open round.
 * The new round is never voided by being passed through this function.
 */
export function replaceReviewRound(
  previous: ReviewRound | undefined,
  next: {
    readonly id: string;
    readonly artifactVersionId: string;
    readonly reviewerIds: readonly string[];
  },
):
  | {
      readonly ok: true;
      readonly round: ReviewRound;
      readonly superseded?: ReviewRound;
    }
  | {
      readonly ok: false;
      readonly code: 'review-requires-reviewers' | 'duplicate-reviewer' | 'invalid-round';
    } {
  const opened = openReviewRound(next);
  if (!opened.ok) return opened;
  if (previous === undefined || previous.status !== 'open' || previous.id === opened.round.id) {
    return { ok: true, round: opened.round };
  }
  return { ok: true, round: opened.round, superseded: voidOpenRound(previous) };
}

export type ReviewApplicationRejection =
  'stale-round' | 'stale-version' | 'voided-round' | 'unbound-evaluation';

function hasBallotRecord(
  round: Pick<ReviewRound, 'id' | 'artifactVersionId'> &
    Partial<Pick<ReviewRound, 'reviewerIds' | 'ballots'>>,
): round is Pick<ReviewRound, 'id' | 'artifactVersionId' | 'reviewerIds' | 'ballots'> {
  return Array.isArray(round.reviewerIds) && Array.isArray(round.ballots);
}

/**
 * Outcome comes from the ballots. A caller-supplied evaluation or round status
 * that disagrees with that tally is rejected. A round missing its roster or
 * ballots cannot advance by matching the supplied evaluation to its status.
 */
function resolveEvaluation(
  round: Pick<ReviewRound, 'id' | 'artifactVersionId' | 'status'> &
    Partial<Pick<ReviewRound, 'reviewerIds' | 'ballots'>>,
  supplied: ReviewEvaluation,
): ReviewEvaluation | undefined {
  if (!hasBallotRecord(round)) return undefined;
  const recomputed = aggregateReview(round);
  if (recomputed.outcome === 'approved' && recomputed.approvedBy.length === 0) return undefined;
  return recomputed.outcome === supplied.outcome ? recomputed : undefined;
}

/**
 * Apply a review result only when it belongs to the node's current, non-voided round.
 * The outcome is recomputed from the ballots. Pending and invalid policies do not advance the node.
 */
export function applyReviewToNode(
  status: NodeStatus,
  input: {
    readonly evaluation: ReviewEvaluation;
    readonly round: Pick<ReviewRound, 'id' | 'artifactVersionId' | 'status'> &
      Partial<Pick<ReviewRound, 'reviewerIds' | 'ballots'>>;
    readonly currentRoundId: string;
    readonly currentArtifactVersionId: string;
  },
): NodeTransitionResult | { readonly ok: false; readonly code: ReviewApplicationRejection } {
  if (
    input == null ||
    typeof input !== 'object' ||
    input.round == null ||
    typeof input.round !== 'object' ||
    input.evaluation == null
  ) {
    return { ok: false, code: 'unbound-evaluation' };
  }
  if (input.round.status === 'voided') return { ok: false, code: 'voided-round' };
  if (input.round.id !== input.currentRoundId) return { ok: false, code: 'stale-round' };
  if (input.round.artifactVersionId !== input.currentArtifactVersionId) {
    return { ok: false, code: 'stale-version' };
  }
  const evaluation = resolveEvaluation(input.round, input.evaluation);
  if (!evaluation) return { ok: false, code: 'unbound-evaluation' };
  if (evaluation.outcome === 'pending' || evaluation.outcome === 'invalid-policy') {
    if (status !== 'in-review') {
      return { ok: false, code: 'illegal-transition', from: status, transition: 'review-resolved' };
    }
    return { ok: true, from: status, to: status, changed: false, effects: Object.freeze([]) };
  }
  if (status !== 'in-review') {
    return { ok: false, code: 'illegal-transition', from: status, transition: 'review-resolved' };
  }
  if (evaluation.outcome === 'approved') {
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

export interface ReviewSettlement {
  readonly roundId: string;
  readonly artifactVersionId: string;
}

export interface ReviewSettlementCurrent {
  readonly roundId: string;
  readonly artifactVersionId: string;
}

/**
 * Settle the current round through the same compare-and-set and idempotency
 * path as other node commands. The outcome is recomputed from the round's
 * ballots. The envelope payload is the round id and artifact version, so a
 * repeated settlement replays and a different round under the same key mismatches.
 */
export function applyReviewSettlementCommand(
  state: NodeCommandState,
  envelope: CommandEnvelope<ReviewSettlement>,
  round: ReviewRound,
  current: ReviewSettlementCurrent,
): { readonly state: NodeCommandState; readonly decision: CommandDecision<AppliedNodeTransition> } {
  if (
    state == null ||
    typeof state !== 'object' ||
    envelope == null ||
    typeof envelope !== 'object' ||
    envelope.payload == null ||
    typeof envelope.payload !== 'object' ||
    round == null ||
    typeof round !== 'object' ||
    current == null ||
    typeof current !== 'object'
  ) {
    const kept = state != null && typeof state === 'object' ? state : initialNodeCommandState();
    const version = typeof kept.version === 'number' ? kept.version : 0;
    return {
      state: kept,
      decision: { status: 'rejected', code: 'unbound-evaluation', version },
    };
  }
  const outcome = decideCommand({
    envelope,
    currentVersion: state.version,
    stored: state.stored,
    apply: (_nextVersion) => {
      if (!Array.isArray(round.reviewerIds) || !Array.isArray(round.ballots)) {
        return { disposition: 'reject', code: 'unbound-evaluation' };
      }
      if (round.reviewerIds.some((id) => typeof id !== 'string')) {
        return { disposition: 'reject', code: 'invalid-round' };
      }
      if (
        round.ballots.some(
          (ballot) =>
            ballot == null || typeof ballot !== 'object' || typeof ballot.reviewerId !== 'string',
        )
      ) {
        return { disposition: 'reject', code: 'invalid-round' };
      }
      if (envelope.payload.roundId !== round.id) {
        return { disposition: 'reject', code: 'stale-round' };
      }
      if (envelope.payload.artifactVersionId !== round.artifactVersionId) {
        return { disposition: 'reject', code: 'stale-version' };
      }
      const result = applyReviewToNode(state.status, {
        evaluation: aggregateReview(round),
        round,
        currentRoundId: current.roundId,
        currentArtifactVersionId: current.artifactVersionId,
      });
      if (!result.ok) return { disposition: 'reject', code: result.code };
      if (!result.changed && result.effects.length === 0) {
        return { disposition: 'ignore', code: 'no-effect' };
      }
      return {
        disposition: 'accept',
        result: {
          from: result.from,
          to: result.to,
          changed: result.changed,
          effects: result.effects,
          upstreamAffected: state.upstreamAffected,
        },
      };
    },
  });
  if (outcome.decision.status !== 'applied') {
    return { state: { ...state, stored: outcome.stored }, decision: outcome.decision };
  }
  const applied = outcome.decision.result;
  const base = {
    status: applied.to,
    version: outcome.version,
    upstreamAffected: applied.upstreamAffected,
    stored: outcome.stored,
  };
  // Only an approved review (completed) clears a needs-revision entry.
  // A send-back records it. No other command outcome may clear it.
  if (applied.to === 'needs-revision') {
    return {
      decision: outcome.decision,
      state: { ...base, entryStatus: 'needs-revision' },
    };
  }
  return { decision: outcome.decision, state: base };
}

/** Review cannot be required with an empty roster. The node does not move in that case. */
export function transitionForSubmission(
  from: NodeStatus,
  input: {
    readonly reviewRequired: boolean;
    readonly reviewerIds: readonly string[];
    readonly entryStatus?: 'ready' | 'needs-revision';
  },
):
  | NodeTransitionResult
  | { readonly ok: false; readonly code: 'review-requires-reviewers'; readonly from: NodeStatus } {
  if (input.reviewRequired && input.reviewerIds.length === 0) {
    return { ok: false, code: 'review-requires-reviewers', from };
  }
  return transitionNode(from, {
    type: 'submit-artifact',
    reviewRequired: input.reviewRequired,
    ...(input.entryStatus === undefined ? {} : { entryStatus: input.entryStatus }),
  });
}
