import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateReview,
  applyReviewToNode,
  changeReviewers,
  interpretAgentReview,
  openReviewRound,
  reviewRoundAfterNodeTransition,
  submitBallot,
  transitionForSubmission,
  transitionNode,
} from '@zhuma/agent-core';

function open(reviewerIds = ['h1', 'h2', 'agent-1'], artifactVersionId = 'art-1', id = 'round-1') {
  const opened = openReviewRound({ id, artifactVersionId, reviewerIds });
  assert.equal(opened.ok, true);
  return opened.round;
}

function ballot(reviewerId, action, extra = {}) {
  return { reviewerId, roundId: 'round-1', artifactVersionId: 'art-1', action, ...extra };
}

function cast(round, ballotInput, comments = []) {
  return submitBallot(round, ballotInput, ballotInput.reviewerId, comments);
}

function settle(status, round, evaluation, current = {}) {
  return applyReviewToNode(status, {
    evaluation,
    round,
    currentRoundId: current.currentRoundId ?? round.id,
    currentArtifactVersionId: current.currentArtifactVersionId ?? round.artifactVersionId,
  });
}

test('requires every assigned reviewer and treats any rejection as changes requested', () => {
  let current = open();
  for (const reviewerId of ['h1', 'agent-1']) {
    const accepted = cast(current, ballot(reviewerId, 'approve'));
    assert.equal(accepted.ok, true);
    assert.equal(accepted.evaluation.outcome, 'pending');
    current = accepted.round;
  }
  assert.deepEqual(current.status, 'open');
  assert.ok(aggregateReview(current).outstandingReviewerIds.includes('h2'));

  const rejected = cast(current, ballot('h2', 'request-changes', { comment: '请改错误码' }));
  assert.equal(rejected.ok, true);
  assert.equal(rejected.evaluation.outcome, 'changes-requested');
  assert.deepEqual(rejected.evaluation.rejectedBy, ['h2']);
  assert.equal(rejected.round.status, 'changes-requested');

  const lateApproval = cast(rejected.round, ballot('h1', 'approve'));
  assert.equal(lateApproval.ok, false);
  assert.equal(lateApproval.code, 'round-closed');
  assert.equal(rejected.round.status, 'changes-requested');

  const moved = settle('in-review', rejected.round, rejected.evaluation);
  assert.equal(moved.ok, true);
  assert.equal(moved.to, 'needs-revision');
  assert.equal(moved.effects.includes('accept-handoff'), false);
});

test('approves the node only after every current reviewer passes', () => {
  let current = open(['h1', 'h2']);
  current = cast(current, ballot('h1', 'approve')).round;
  const finished = cast(current, ballot('h2', 'approve'));
  assert.equal(finished.evaluation.outcome, 'approved');
  assert.equal(finished.round.status, 'approved');
  const moved = settle('in-review', finished.round, finished.evaluation);
  assert.equal(moved.to, 'completed');
  assert.deepEqual(moved.effects, ['accept-handoff']);
  const staleVersion = settle('in-review', finished.round, finished.evaluation, {
    currentArtifactVersionId: 'art-next',
  });
  assert.equal(staleVersion.code, 'stale-version');
});

test('comments, timeouts, unavailability, and silence are not approvals', () => {
  const commented = cast(open(['h1', 'h2']), ballot('h1', 'comment', { comment: '只是疑问' }));
  assert.equal(commented.evaluation.outcome, 'pending');
  assert.deepEqual(commented.evaluation.outstandingReviewerIds, ['h1', 'h2']);

  const timedOut = cast(open(['h1']), ballot('h1', 'approve', { availability: 'timed-out' }));
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'non-passing-availability');

  const unavailable = cast(open(['h1']), ballot('h1', 'comment', { availability: 'unavailable' }));
  assert.equal(unavailable.evaluation.outcome, 'pending');
  assert.deepEqual(unavailable.evaluation.outstandingReviewerIds, ['h1']);

  const round = open(['h1', 'h2']);
  const silent = aggregateReview(round);
  assert.equal(silent.outcome, 'pending');
  assert.deepEqual(silent.outstandingReviewerIds, ['h1', 'h2']);
  const pendingNode = settle('in-review', round, silent);
  assert.equal(pendingNode.changed, false);
  assert.equal(pendingNode.to, 'in-review');
});

test('a rejection already in the ballots blocks completion even when another vote approves', () => {
  const evaluation = aggregateReview({
    id: 'round-1',
    artifactVersionId: 'art-1',
    reviewerIds: ['h1', 'h2', 'agent-1'],
    ballots: [
      ballot('h1', 'approve'),
      ballot('h2', 'request-changes', { comment: '退回' }),
      ballot('agent-1', 'approve'),
    ],
  });
  assert.equal(evaluation.outcome, 'changes-requested');
  assert.deepEqual(evaluation.rejectedBy, ['h2']);
});

test('refuses a late vote from an old round or an old artifact version', () => {
  const current = open();
  const staleRound = cast(current, { ...ballot('h1', 'approve'), roundId: 'round-old' });
  assert.equal(staleRound.ok, false);
  assert.equal(staleRound.code, 'stale-round');
  assert.equal(current.ballots.length, 0);

  const staleVersion = cast(current, {
    ...ballot('h1', 'approve'),
    artifactVersionId: 'art-old',
  });
  assert.equal(staleVersion.ok, false);
  assert.equal(staleVersion.code, 'stale-version');
  assert.equal(current.ballots.length, 0);
  assert.equal(current.status, 'open');
});

test('does not let a reviewer vote for someone else or send an empty rejection', () => {
  const outsider = cast(open(), ballot('outsider', 'approve'));
  assert.equal(outsider.code, 'not-assigned-reviewer');
  const empty = cast(open(['h1']), ballot('h1', 'request-changes'));
  assert.equal(empty.code, 'empty-request-changes');
  const citedWithoutSnapshot = cast(
    open(['h1']),
    ballot('h1', 'request-changes', { unresolvedCommentIds: ['c-1'] }),
  );
  assert.equal(citedWithoutSnapshot.code, 'comment-not-unresolved');
});

test('records a ballot only when the actor is that reviewer', () => {
  const round = open(['h1', 'h2']);
  const impersonated = submitBallot(round, ballot('h2', 'approve'), 'h1');
  assert.equal(impersonated.ok, false);
  assert.equal(impersonated.code, 'actor-mismatch');
  assert.equal(round.ballots.length, 0);
  const blankActor = submitBallot(round, ballot('h1', 'approve'), ' ');
  assert.equal(blankActor.code, 'actor-mismatch');
  const own = submitBallot(round, ballot('h1', 'approve'), 'h1');
  assert.equal(own.ok, true);
  assert.equal(own.recorded, true);
});

test('a send-back may cite only comments that exist and are still unresolved', () => {
  const round = open(['h1']);
  const resolved = cast(round, ballot('h1', 'request-changes', { unresolvedCommentIds: ['c-1'] }), [
    { id: 'c-1', status: 'resolved' },
  ]);
  assert.equal(resolved.code, 'comment-not-unresolved');
  const missing = cast(
    round,
    ballot('h1', 'request-changes', { unresolvedCommentIds: ['missing'] }),
    [{ id: 'c-1', status: 'open' }],
  );
  assert.equal(missing.code, 'comment-not-unresolved');
  const mixed = cast(
    round,
    ballot('h1', 'request-changes', { comment: '见评论', unresolvedCommentIds: ['c-1', 'gone'] }),
    [{ id: 'c-1', status: 'open' }],
  );
  assert.equal(mixed.code, 'comment-not-unresolved');
  const openComment = cast(
    round,
    ballot('h1', 'request-changes', { unresolvedCommentIds: [' c-1 '] }),
    [{ id: 'c-1', status: 'open' }],
  );
  assert.equal(openComment.ok, true);
  assert.equal(openComment.evaluation.outcome, 'changes-requested');
  const textOnly = cast(round, ballot('h1', 'request-changes', { comment: '请改错误码' }));
  assert.equal(textOnly.ok, true);
});

test('cannot drop a rejecting reviewer, and a new round does not inherit old votes', () => {
  let current = open(['h1', 'h2']);
  current = cast(current, ballot('h1', 'approve')).round;
  current = cast(current, ballot('h2', 'request-changes', { comment: '不能过' })).round;
  const dropped = changeReviewers(current, ['h1']);
  assert.equal(dropped.ok, false);
  assert.equal(dropped.code, 'cannot-drop-rejection');
  assert.deepEqual(dropped.rejectedBy, ['h2']);

  const kept = changeReviewers(current, ['h1', 'h2']);
  assert.equal(kept.ok, false);
  assert.equal(kept.code, 'round-closed');

  const next = openReviewRound({
    id: 'round-2',
    artifactVersionId: 'art-2',
    reviewerIds: ['h1', 'h2'],
  });
  assert.equal(next.ok, true);
  assert.equal(next.round.ballots.length, 0);
  assert.equal(aggregateReview(next.round).outcome, 'pending');
  const carried = cast(next.round, {
    ...ballot('h1', 'approve'),
    roundId: 'round-1',
    artifactVersionId: 'art-1',
  });
  assert.equal(carried.code, 'stale-round');
});

test('an open round can shrink to the reviewers who already approved', () => {
  let current = open(['h1', 'h2']);
  current = cast(current, ballot('h1', 'approve')).round;
  const narrowed = changeReviewers(current, ['h1']);
  assert.equal(narrowed.ok, true);
  assert.equal(narrowed.evaluation.outcome, 'approved');
});

test('a repeated identical vote is not recorded again and a flipped vote is refused', () => {
  const current = open(['h1', 'h2']);
  const first = cast(current, ballot('h1', 'approve'));
  const repeat = cast(first.round, ballot('h1', 'approve'));
  assert.equal(repeat.ok, true);
  assert.equal(repeat.recorded, false);
  assert.equal(repeat.round.ballots.length, 1);
  const flipped = cast(first.round, ballot('h1', 'request-changes', { comment: '改主意' }));
  assert.equal(flipped.code, 'conflicting-ballot');
});

test('cancelling, restarting, or resubmitting voids the open round', () => {
  const round = open(['h1', 'h2']);
  const cancel = transitionNode('in-review', { type: 'cancel-confirmed' });
  assert.equal(cancel.ok, true);
  const voided = reviewRoundAfterNodeTransition(round, cancel, { type: 'cancel-confirmed' });
  assert.equal(voided.status, 'voided');
  assert.equal(cast(voided, ballot('h1', 'approve')).code, 'voided-round');

  const restart = transitionNode('cancelled', { type: 'restart' });
  assert.equal(
    reviewRoundAfterNodeTransition(voided, restart, { type: 'restart' }).status,
    'voided',
  );
  assert.equal(
    reviewRoundAfterNodeTransition(open(), restart, { type: 'restart' }).status,
    'voided',
  );

  const resubmit = transitionNode('ready', { type: 'submit-artifact', reviewRequired: true });
  assert.equal(resubmit.to, 'in-review');
  const next = open(['h1', 'h2'], 'art-2', 'round-2');
  const forged = { outcome: 'approved', approvedBy: ['h1', 'h2'] };
  assert.equal(
    settle('in-review', { ...round, status: 'approved' }, forged, {
      currentRoundId: next.id,
      currentArtifactVersionId: next.artifactVersionId,
    }).code,
    'stale-round',
  );
  assert.equal(
    applyReviewToNode('in-review', {
      evaluation: forged,
      round: voided,
      currentRoundId: voided.id,
      currentArtifactVersionId: voided.artifactVersionId,
    }).code,
    'voided-round',
  );

  const openAgain = open(['h1']);
  const submitted = transitionNode('needs-revision', {
    type: 'submit-artifact',
    reviewRequired: true,
  });
  assert.equal(
    reviewRoundAfterNodeTransition(openAgain, submitted, {
      type: 'submit-artifact',
      reviewRequired: true,
    }).status,
    'voided',
  );
  const rejected = transitionNode('draft', { type: 'cancel-confirmed' });
  assert.equal(
    reviewRoundAfterNodeTransition(openAgain, rejected, { type: 'cancel-confirmed' }).status,
    'open',
  );
  assert.equal(
    settle('in-review', { id: 'round-1', artifactVersionId: 'art-1', status: 'open' }, forged).code,
    'unbound-evaluation',
  );
});

test('review cannot be required without reviewers, and abnormal agent output is not approval', () => {
  assert.equal(
    openReviewRound({ id: 'round-1', artifactVersionId: 'art-1', reviewerIds: [] }).code,
    'review-requires-reviewers',
  );
  const invalid = aggregateReview({
    id: 'round-1',
    artifactVersionId: 'art-1',
    reviewerIds: [],
    ballots: [],
  });
  assert.equal(invalid.outcome, 'invalid-policy');
  const stayed = settle(
    'in-review',
    { id: 'round-1', artifactVersionId: 'art-1', status: 'open' },
    invalid,
  );
  assert.equal(stayed.changed, false);
  assert.equal(
    transitionForSubmission('ready', { reviewRequired: true, reviewerIds: [] }).code,
    'review-requires-reviewers',
  );
  assert.equal(
    transitionForSubmission('needs-revision', { reviewRequired: false, reviewerIds: [] }).code,
    'illegal-transition',
  );

  assert.equal(
    interpretAgentReview({ conclusion: 'approve', rationale: '看起来可以' }).code,
    'abnormal-output',
  );
  assert.equal(
    interpretAgentReview({ rationale: '缺少结论', evidence: ['x'] }).code,
    'abnormal-output',
  );
  const accepted = interpretAgentReview({
    conclusion: 'approve',
    rationale: '与接受版本一致',
    anchors: ['第 2 段'],
    evidence: ['art-1'],
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.action, 'approve');
});
