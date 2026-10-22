import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateReview,
  applyReviewToNode,
  changeReviewers,
  interpretAgentReview,
  openReviewRound,
  submitBallot,
  transitionForSubmission,
} from '@zhuma/agent-core';

function open(reviewerIds = ['h1', 'h2', 'agent-1'], artifactVersionId = 'art-1', id = 'round-1') {
  const opened = openReviewRound({ id, artifactVersionId, reviewerIds });
  assert.equal(opened.ok, true);
  return opened.round;
}

function ballot(reviewerId, action, extra = {}) {
  return { reviewerId, roundId: 'round-1', artifactVersionId: 'art-1', action, ...extra };
}

test('requires every assigned reviewer and treats any rejection as changes requested', () => {
  let current = open();
  for (const reviewerId of ['h1', 'agent-1']) {
    const accepted = submitBallot(current, ballot(reviewerId, 'approve'));
    assert.equal(accepted.ok, true);
    assert.equal(accepted.evaluation.outcome, 'pending');
    current = accepted.round;
  }
  assert.deepEqual(current.status, 'open');
  assert.ok(aggregateReview(current).outstandingReviewerIds.includes('h2'));

  const rejected = submitBallot(
    current,
    ballot('h2', 'request-changes', { comment: '请改错误码' }),
  );
  assert.equal(rejected.ok, true);
  assert.equal(rejected.evaluation.outcome, 'changes-requested');
  assert.deepEqual(rejected.evaluation.rejectedBy, ['h2']);
  assert.equal(rejected.round.status, 'changes-requested');

  const lateApproval = submitBallot(rejected.round, ballot('h1', 'approve'));
  assert.equal(lateApproval.ok, false);
  assert.equal(lateApproval.code, 'round-closed');
  assert.equal(rejected.round.status, 'changes-requested');

  const moved = applyReviewToNode('in-review', rejected.evaluation);
  assert.equal(moved.ok, true);
  assert.equal(moved.to, 'needs-revision');
  assert.equal(moved.effects.includes('accept-handoff'), false);
});

test('approves the node only after every current reviewer passes', () => {
  let current = open(['h1', 'h2']);
  current = submitBallot(current, ballot('h1', 'approve')).round;
  const finished = submitBallot(current, ballot('h2', 'approve'));
  assert.equal(finished.evaluation.outcome, 'approved');
  assert.equal(finished.round.status, 'approved');
  const moved = applyReviewToNode('in-review', finished.evaluation);
  assert.equal(moved.to, 'completed');
  assert.deepEqual(moved.effects, ['accept-handoff']);
});

test('comments, timeouts, unavailability, and silence are not approvals', () => {
  const commented = submitBallot(
    open(['h1', 'h2']),
    ballot('h1', 'comment', { comment: '只是疑问' }),
  );
  assert.equal(commented.evaluation.outcome, 'pending');
  assert.deepEqual(commented.evaluation.outstandingReviewerIds, ['h1', 'h2']);

  const timedOut = submitBallot(
    open(['h1']),
    ballot('h1', 'approve', { availability: 'timed-out' }),
  );
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'non-passing-availability');

  const unavailable = submitBallot(
    open(['h1']),
    ballot('h1', 'comment', { availability: 'unavailable' }),
  );
  assert.equal(unavailable.evaluation.outcome, 'pending');
  assert.deepEqual(unavailable.evaluation.outstandingReviewerIds, ['h1']);

  const silent = aggregateReview(open(['h1', 'h2']));
  assert.equal(silent.outcome, 'pending');
  assert.deepEqual(silent.outstandingReviewerIds, ['h1', 'h2']);
  const pendingNode = applyReviewToNode('in-review', silent);
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
  const staleRound = submitBallot(current, { ...ballot('h1', 'approve'), roundId: 'round-old' });
  assert.equal(staleRound.ok, false);
  assert.equal(staleRound.code, 'stale-round');
  assert.equal(current.ballots.length, 0);

  const staleVersion = submitBallot(current, {
    ...ballot('h1', 'approve'),
    artifactVersionId: 'art-old',
  });
  assert.equal(staleVersion.ok, false);
  assert.equal(staleVersion.code, 'stale-version');
  assert.equal(current.ballots.length, 0);
  assert.equal(current.status, 'open');
});

test('does not let a reviewer vote for someone else or send an empty rejection', () => {
  const outsider = submitBallot(open(), ballot('outsider', 'approve'));
  assert.equal(outsider.code, 'not-assigned-reviewer');
  const empty = submitBallot(open(['h1']), ballot('h1', 'request-changes'));
  assert.equal(empty.code, 'empty-request-changes');
  const cited = submitBallot(
    open(['h1']),
    ballot('h1', 'request-changes', { unresolvedCommentIds: ['c-1'] }),
  );
  assert.equal(cited.ok, true);
  assert.equal(cited.evaluation.outcome, 'changes-requested');
});

test('cannot drop a rejecting reviewer, and a new round does not inherit old votes', () => {
  let current = open(['h1', 'h2']);
  current = submitBallot(current, ballot('h1', 'approve')).round;
  current = submitBallot(current, ballot('h2', 'request-changes', { comment: '不能过' })).round;
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
  const carried = submitBallot(next.round, {
    ...ballot('h1', 'approve'),
    roundId: 'round-1',
    artifactVersionId: 'art-1',
  });
  assert.equal(carried.code, 'stale-round');
});

test('an open round can shrink to the reviewers who already approved', () => {
  let current = open(['h1', 'h2']);
  current = submitBallot(current, ballot('h1', 'approve')).round;
  const narrowed = changeReviewers(current, ['h1']);
  assert.equal(narrowed.ok, true);
  assert.equal(narrowed.evaluation.outcome, 'approved');
});

test('a repeated identical vote is not recorded again and a flipped vote is refused', () => {
  const current = open(['h1', 'h2']);
  const first = submitBallot(current, ballot('h1', 'approve'));
  const repeat = submitBallot(first.round, ballot('h1', 'approve'));
  assert.equal(repeat.ok, true);
  assert.equal(repeat.recorded, false);
  assert.equal(repeat.round.ballots.length, 1);
  const flipped = submitBallot(first.round, ballot('h1', 'request-changes', { comment: '改主意' }));
  assert.equal(flipped.code, 'conflicting-ballot');
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
  const stayed = applyReviewToNode('in-review', invalid);
  assert.equal(stayed.changed, false);
  assert.equal(
    transitionForSubmission('ready', { reviewRequired: true, reviewerIds: [] }).code,
    'review-requires-reviewers',
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
