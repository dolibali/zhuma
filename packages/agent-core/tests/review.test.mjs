import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateReview,
  applyReviewSettlementCommand,
  applyReviewToNode,
  changeReviewers,
  initialNodeCommandState,
  interpretAgentReview,
  openReviewRound,
  replaceReviewRound,
  reviewRoundAfterNodeTransition,
  submitBallot,
  transitionForSubmission,
  transitionNode,
} from '@zhuma/agent-core';

const lead = { actorId: 'lead', authorized: true };

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
  const wrongVersion = cast(
    round,
    ballot('h1', 'request-changes', { unresolvedCommentIds: ['c-1'] }),
    [{ id: 'c-1', status: 'open', versionId: 'art-other' }],
  );
  assert.equal(wrongVersion.code, 'comment-not-unresolved');
  const wrongTarget = cast(
    round,
    ballot('h1', 'request-changes', { unresolvedCommentIds: ['c-1'] }),
    [{ id: 'c-1', status: 'open', versionId: 'art-1', targetId: 'other-artifact' }],
  );
  assert.equal(wrongTarget.code, 'comment-not-unresolved');
  const bound = cast(round, ballot('h1', 'request-changes', { unresolvedCommentIds: ['c-1'] }), [
    { id: 'c-1', status: 'open', versionId: 'art-1', targetId: 'art-1' },
  ]);
  assert.equal(bound.ok, true);
  assert.equal(bound.evaluation.outcome, 'changes-requested');
});

test('cannot drop a rejecting reviewer, and a new round does not inherit old votes', () => {
  let current = open(['h1', 'h2']);
  current = cast(current, ballot('h1', 'approve')).round;
  current = cast(current, ballot('h2', 'request-changes', { comment: '不能过' })).round;
  const dropped = changeReviewers(current, ['h1'], lead);
  assert.equal(dropped.ok, false);
  assert.equal(dropped.code, 'cannot-drop-rejection');
  assert.deepEqual(dropped.rejectedBy, ['h2']);

  const kept = changeReviewers(current, ['h1', 'h2'], lead);
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

test('shrinking an open roster never auto-approves and needs an authorized actor', () => {
  let current = open(['h1', 'h2', 'agent-1']);
  current = cast(current, ballot('h1', 'approve')).round;
  current = cast(
    current,
    ballot('agent-1', 'comment', { comment: '发现严重问题', availability: 'timed-out' }),
  ).round;
  const narrowed = changeReviewers(current, ['h1'], lead);
  assert.equal(narrowed.ok, false);
  assert.equal(narrowed.code, 'requires-new-round');
  assert.equal(current.status, 'open');
  assert.equal(aggregateReview(current).outcome, 'pending');

  const anonymous = changeReviewers(current, ['h1', 'h3']);
  assert.equal(anonymous.code, 'unauthorized');
  const refused = changeReviewers(current, ['h1', 'h3'], { actorId: 'lead', authorized: false });
  assert.equal(refused.code, 'unauthorized');
  const blankActor = changeReviewers(current, ['h1', 'h3'], { actorId: ' ', authorized: true });
  assert.equal(blankActor.code, 'unauthorized');

  const reassigned = changeReviewers(current, ['h1', 'h3'], lead);
  assert.equal(reassigned.ok, true);
  assert.equal(reassigned.evaluation.outcome, 'pending');
  assert.deepEqual(reassigned.evaluation.outstandingReviewerIds, ['h3']);
  assert.equal(reassigned.round.status, 'open');

  const voidedRoster = changeReviewers({ ...current, status: 'voided' }, ['h1'], lead);
  assert.equal(voidedRoster.code, 'voided-round');
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

  const restart = transitionNode('cancelled', { type: 'restart', returnTo: 'ready' });
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
  const replacement = open(['h1'], 'art-2', 'round-2');
  assert.equal(
    reviewRoundAfterNodeTransition(openAgain, submitted, {
      type: 'submit-artifact',
      reviewRequired: true,
    }).status,
    'open',
  );
  assert.equal(
    reviewRoundAfterNodeTransition(
      replacement,
      submitted,
      {
        type: 'submit-artifact',
        reviewRequired: true,
      },
      replacement.id,
    ).status,
    'open',
  );
  assert.equal(
    reviewRoundAfterNodeTransition(
      openAgain,
      submitted,
      {
        type: 'submit-artifact',
        reviewRequired: true,
      },
      replacement.id,
    ).status,
    'voided',
  );
  const replaced = replaceReviewRound(open(['h1']), {
    id: 'round-9',
    artifactVersionId: 'art-9',
    reviewerIds: ['h1'],
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.round.status, 'open');
  assert.equal(replaced.superseded.status, 'voided');
  assert.equal(
    replaceReviewRound(replaced.round, {
      id: replaced.round.id,
      artifactVersionId: 'art-9',
      reviewerIds: ['h1'],
    }).superseded,
    undefined,
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

test('settlement rejects a round that has no ballots', () => {
  const state = { ...initialNodeCommandState(), status: 'in-review', version: 4 };
  const round = {
    id: 'round-1',
    artifactVersionId: 'art-1',
    status: 'open',
    reviewerIds: ['h1'],
  };
  const settled = applyReviewSettlementCommand(
    state,
    {
      idempotencyKey: 'missing-ballots',
      actorId: 'svc',
      objectId: 'node-1',
      expectedVersion: 4,
      payload: { roundId: 'round-1', artifactVersionId: 'art-1' },
    },
    round,
    { roundId: 'round-1', artifactVersionId: 'art-1' },
  );
  assert.equal(settled.decision.status, 'rejected');
  assert.equal(settled.decision.code, 'unbound-evaluation');
  assert.equal(settled.state.status, 'in-review');
  assert.equal(settled.state.version, 4);
  assert.equal(settled.state.stored.length, 0);
  assert.equal(aggregateReview(round).outcome, 'invalid-policy');
});

test('a duplicate reviewer roster cannot be completed by one vote', () => {
  assert.equal(
    openReviewRound({ id: 'round-1', artifactVersionId: 'art-1', reviewerIds: ['a', 'a'] }).code,
    'duplicate-reviewer',
  );
  assert.equal(
    openReviewRound({ id: 'round-1', artifactVersionId: 'art-1', reviewerIds: ['a', ' a '] }).code,
    'duplicate-reviewer',
  );
  const round = {
    id: 'round-1',
    artifactVersionId: 'art-1',
    status: 'open',
    reviewerIds: ['a', 'a'],
    ballots: [
      { reviewerId: 'a', roundId: 'round-1', artifactVersionId: 'art-1', action: 'approve' },
    ],
  };
  const evaluation = aggregateReview(round);
  assert.equal(evaluation.outcome, 'invalid-policy');
  assert.equal(evaluation.reason, 'duplicate-reviewer');
  const stayed = applyReviewToNode('in-review', {
    evaluation,
    round,
    currentRoundId: round.id,
    currentArtifactVersionId: round.artifactVersionId,
  });
  assert.equal(stayed.ok, true);
  assert.equal(stayed.to, 'in-review');
  assert.equal(stayed.changed, false);
  const forged = applyReviewToNode('in-review', {
    evaluation: { outcome: 'approved', approvedBy: ['a', 'a'] },
    round,
    currentRoundId: round.id,
    currentArtifactVersionId: round.artifactVersionId,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'unbound-evaluation');
  assert.notEqual(forged.to, 'completed');
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
    {
      id: 'round-1',
      artifactVersionId: 'art-1',
      status: 'open',
      reviewerIds: [],
      ballots: [],
    },
    invalid,
  );
  assert.equal(stayed.ok, true);
  assert.equal(stayed.to, 'in-review');
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

test('a missing roster, missing ballots, or zero approvals never complete the node', () => {
  const approved = { outcome: 'approved', approvedBy: [] };
  const cases = [
    {
      label: 'missing roster and ballots',
      round: { id: 'r', artifactVersionId: 'v', status: 'approved' },
      evaluation: approved,
    },
    {
      label: 'missing roster',
      round: { id: 'r', artifactVersionId: 'v', status: 'approved', ballots: [] },
      evaluation: approved,
    },
    {
      label: 'missing ballots',
      round: { id: 'r', artifactVersionId: 'v', status: 'approved', reviewerIds: ['h1'] },
      evaluation: { outcome: 'approved', approvedBy: ['h1'] },
    },
    {
      label: 'zero approvals',
      round: {
        id: 'round-1',
        artifactVersionId: 'art-1',
        status: 'approved',
        reviewerIds: ['h1'],
        ballots: [],
      },
      evaluation: approved,
    },
  ];
  for (const item of cases) {
    const result = applyReviewToNode('in-review', {
      evaluation: item.evaluation,
      round: item.round,
      currentRoundId: item.round.id,
      currentArtifactVersionId: item.round.artifactVersionId,
    });
    assert.equal(result.ok, false, item.label);
    assert.equal(result.code, 'unbound-evaluation', item.label);
    assert.notEqual(result.to, 'completed', item.label);
  }
});

test('a forged approved status cannot complete a round that still has a send-back', () => {
  const rejected = cast(
    open(['h1', 'h2']),
    ballot('h2', 'request-changes', { comment: '不能过' }),
  ).round;
  const forged = applyReviewToNode('in-review', {
    evaluation: { outcome: 'approved', approvedBy: ['h1', 'h2'] },
    round: { ...rejected, status: 'approved' },
    currentRoundId: rejected.id,
    currentArtifactVersionId: rejected.artifactVersionId,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'unbound-evaluation');
  const settled = settle('in-review', rejected, aggregateReview(rejected));
  assert.equal(settled.to, 'needs-revision');
});

test('review settlement is a versioned idempotent command and recomputes the ballots', () => {
  const approved = cast(open(['h1']), ballot('h1', 'approve')).round;
  const state = { ...initialNodeCommandState(), status: 'in-review', version: 4 };
  const current = { roundId: approved.id, artifactVersionId: approved.artifactVersionId };
  const envelope = {
    idempotencyKey: 'settle',
    actorId: 'svc',
    objectId: 'node-1',
    expectedVersion: 4,
    payload: { roundId: approved.id, artifactVersionId: approved.artifactVersionId },
  };
  const applied = applyReviewSettlementCommand(state, envelope, approved, current);
  assert.equal(applied.decision.status, 'applied');
  assert.equal(applied.state.status, 'completed');
  assert.equal(applied.state.version, 5);
  assert.deepEqual(applied.decision.result.effects, ['accept-handoff']);

  const replay = applyReviewSettlementCommand(
    applied.state,
    { ...envelope, expectedVersion: 9 },
    approved,
    current,
  );
  assert.equal(replay.decision.status, 'replayed');
  assert.equal(replay.state.status, 'completed');
  assert.equal(replay.state.version, 5);
  assert.equal(replay.state.stored.length, 1);

  const conflict = applyReviewSettlementCommand(
    state,
    { ...envelope, idempotencyKey: 'other', expectedVersion: 0 },
    approved,
    current,
  );
  assert.equal(conflict.decision.status, 'conflict');
  assert.equal(conflict.decision.currentVersion, 4);
  assert.equal(conflict.state.version, 4);
  assert.equal(conflict.state.status, 'in-review');

  const stale = applyReviewSettlementCommand(
    state,
    { ...envelope, idempotencyKey: 'stale' },
    approved,
    {
      roundId: 'round-other',
      artifactVersionId: approved.artifactVersionId,
    },
  );
  assert.equal(stale.decision.status, 'rejected');
  assert.equal(stale.decision.code, 'stale-round');
  assert.equal(stale.state.version, 4);
  assert.equal(stale.state.stored.length, 0);

  const otherActor = applyReviewSettlementCommand(
    applied.state,
    { ...envelope, actorId: 'other', expectedVersion: 5 },
    approved,
    current,
  );
  assert.equal(otherActor.decision.status, 'idempotency-mismatch');

  const pending = open(['h1', 'h2']);
  const waiting = applyReviewSettlementCommand(
    state,
    {
      ...envelope,
      idempotencyKey: 'wait',
      payload: { roundId: pending.id, artifactVersionId: pending.artifactVersionId },
    },
    pending,
    { roundId: pending.id, artifactVersionId: pending.artifactVersionId },
  );
  assert.equal(waiting.decision.status, 'ignored');
  assert.equal(waiting.state.version, 4);
  assert.equal(waiting.state.stored.length, 0);

  const rejected = cast(
    open(['h1', 'h2']),
    ballot('h2', 'request-changes', { comment: '退回' }),
  ).round;
  const forgedRound = { ...rejected, status: 'approved' };
  const sentBack = applyReviewSettlementCommand(
    state,
    {
      ...envelope,
      idempotencyKey: 'reject',
      payload: { roundId: forgedRound.id, artifactVersionId: forgedRound.artifactVersionId },
    },
    forgedRound,
    { roundId: forgedRound.id, artifactVersionId: forgedRound.artifactVersionId },
  );
  assert.equal(sentBack.decision.status, 'applied');
  assert.equal(sentBack.state.status, 'needs-revision');
  assert.deepEqual(sentBack.decision.result.effects, ['block-downstream']);
});
