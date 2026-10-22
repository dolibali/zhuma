import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyNodeTransitionCommand,
  applyReviewSettlementCommand,
  initialNodeCommandState,
  openReviewRound,
  submitBallot,
} from '@zhuma/agent-core';

const envelope = (payload, idempotencyKey, expectedVersion) => ({
  idempotencyKey,
  actorId: 'human-1',
  objectId: 'node-1',
  expectedVersion,
  payload,
});

function command(state, payload, key) {
  return applyNodeTransitionCommand(state, envelope(payload, key, state.version));
}

function sentBack(version = 0) {
  return { status: 'needs-revision', version, upstreamAffected: false, stored: [] };
}

function assertRejected(result) {
  assert.equal(result.decision.status, 'rejected');
  assert.equal(result.decision.code, 'illegal-transition');
  assert.notEqual(result.state.status, 'completed');
}

test('a lost entry after child return cannot complete from ready', () => {
  let state = sentBack();
  state = command(state, { type: 'child-workflow-started' }, 'lost-child').state;
  state = command(state, { type: 'child-workflow-returned' }, 'lost-back').state;
  assert.equal(state.status, 'ready');
  assert.equal(state.entryStatus, 'needs-revision');
  const lost = { ...state };
  delete lost.entryStatus;
  const version = lost.version;
  const submitted = command(
    lost,
    { type: 'submit-artifact', reviewRequired: false },
    'lost-submit',
  );
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'ready');
  assert.equal(submitted.state.version, version);
  const forged = command(
    lost,
    { type: 'submit-artifact', reviewRequired: false, entryStatus: 'ready' },
    'lost-forge',
  );
  assertRejected(forged);
  assert.equal(forged.state.status, 'ready');
  assert.equal(forged.state.version, version);
});

test('a lost entry after blocked becomes ready cannot complete', () => {
  let state = initialNodeCommandState();
  state = command(
    state,
    { type: 'plan-started', dependenciesSatisfied: false },
    'block-start',
  ).state;
  assert.equal(state.status, 'blocked');
  state = command(
    state,
    { type: 'dependencies-changed', dependenciesSatisfied: true },
    'block-ready',
  ).state;
  assert.equal(state.status, 'ready');
  assert.equal(state.entryStatus, 'ready');
  const kept = command(state, { type: 'submit-artifact', reviewRequired: false }, 'block-keep');
  assert.equal(kept.decision.status, 'applied');
  assert.equal(kept.state.status, 'completed');
  const lost = { ...state };
  delete lost.entryStatus;
  const version = lost.version;
  const submitted = command(lost, { type: 'submit-artifact', reviewRequired: false }, 'block-lose');
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'ready');
  assert.equal(submitted.state.version, version);
  const forged = command(
    lost,
    { type: 'submit-artifact', reviewRequired: false, entryStatus: 'ready' },
    'block-forge',
  );
  assertRejected(forged);
  assert.equal(forged.state.status, 'ready');
});

test('P1 child return after send-back cannot submit without review', () => {
  let state = sentBack();
  state = command(state, { type: 'child-workflow-started' }, 'p1-start').state;
  assert.equal(state.status, 'child-workflow');
  assert.equal(state.entryStatus, 'needs-revision');
  state = command(state, { type: 'child-workflow-returned' }, 'p1-return').state;
  assert.equal(state.status, 'ready');
  assert.equal(state.entryStatus, 'needs-revision');
  const version = state.version;
  const submitted = command(state, { type: 'submit-artifact', reviewRequired: false }, 'p1-submit');
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'ready');
  assert.equal(submitted.state.entryStatus, 'needs-revision');
  assert.equal(submitted.state.version, version);
});

test('P2 forged ready entry after child return cannot complete the node', () => {
  let state = sentBack();
  state = command(state, { type: 'child-workflow-started' }, 'p2-start').state;
  state = command(state, { type: 'child-workflow-returned' }, 'p2-return').state;
  state = command(state, { type: 'execution-acknowledged' }, 'p2-ack').state;
  assert.equal(state.status, 'running');
  assert.equal(state.entryStatus, 'needs-revision');
  const submitted = command(
    state,
    { type: 'submit-artifact', reviewRequired: false, entryStatus: 'ready' },
    'p2-submit',
  );
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'running');
  assert.equal(submitted.state.entryStatus, 'needs-revision');
});

test('P3 retry returnTo ready cannot clear a send-back', () => {
  let state = sentBack();
  state = command(state, { type: 'execution-acknowledged' }, 'p3-ack').state;
  assert.equal(state.status, 'running');
  state = command(state, { type: 'execution-failed' }, 'p3-fail').state;
  assert.equal(state.status, 'failed');
  assert.equal(state.entryStatus, 'needs-revision');
  const retried = command(state, { type: 'retry', returnTo: 'ready' }, 'p3-retry');
  assertRejected(retried);
  assert.equal(retried.state.status, 'failed');
  assert.equal(retried.state.entryStatus, 'needs-revision');
  const submitted = command(
    retried.state,
    { type: 'submit-artifact', reviewRequired: false },
    'p3-submit',
  );
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'failed');
  const returned = command(retried.state, { type: 'retry', returnTo: 'needs-revision' }, 'p3-back');
  assert.equal(returned.decision.status, 'applied');
  assert.equal(returned.state.status, 'needs-revision');
  assert.equal(returned.state.entryStatus, 'needs-revision');
  const stillBlocked = command(
    returned.state,
    { type: 'submit-artifact', reviewRequired: false },
    'p3-still',
  );
  assertRejected(stillBlocked);
  assert.equal(stillBlocked.state.status, 'needs-revision');
});

test('P4 restart returnTo ready cannot clear a send-back', () => {
  let state = sentBack();
  state = command(state, { type: 'cancel-confirmed' }, 'p4-cancel').state;
  assert.equal(state.status, 'cancelled');
  assert.equal(state.entryStatus, 'needs-revision');
  const restarted = command(state, { type: 'restart', returnTo: 'ready' }, 'p4-restart');
  assertRejected(restarted);
  assert.equal(restarted.state.status, 'cancelled');
  assert.equal(restarted.state.entryStatus, 'needs-revision');
  const submitted = command(
    restarted.state,
    { type: 'submit-artifact', reviewRequired: false },
    'p4-submit',
  );
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'cancelled');
  const returned = command(
    restarted.state,
    { type: 'restart', returnTo: 'needs-revision' },
    'p4-back',
  );
  assert.equal(returned.decision.status, 'applied');
  assert.equal(returned.state.status, 'needs-revision');
  assert.equal(returned.state.entryStatus, 'needs-revision');
  const stillBlocked = command(
    returned.state,
    { type: 'submit-artifact', reviewRequired: false },
    'p4-still',
  );
  assertRejected(stillBlocked);
});

test('P5 running submit without entryStatus cannot skip send-back review', () => {
  let state = sentBack(5);
  state = command(state, { type: 'execution-acknowledged' }, 'p5-ack').state;
  assert.equal(state.status, 'running');
  assert.equal(state.entryStatus, 'needs-revision');
  const version = state.version;
  const submitted = command(state, { type: 'submit-artifact', reviewRequired: false }, 'p5-submit');
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'running');
  assert.equal(submitted.state.entryStatus, 'needs-revision');
  assert.equal(submitted.state.version, version);
});

test('send-back review survives waiting for input', () => {
  let state = sentBack(1);
  for (const [key, payload] of [
    ['wait-ack', { type: 'execution-acknowledged' }],
    ['wait-ask', { type: 'input-required' }],
    ['wait-answer', { type: 'input-supplied' }],
  ]) {
    state = command(state, payload, key).state;
    assert.equal(state.entryStatus, 'needs-revision');
  }
  assert.equal(state.status, 'running');
  const submitted = command(
    state,
    { type: 'submit-artifact', reviewRequired: false },
    'wait-submit',
  );
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'running');
});

test('a missing or forged entry cannot move a run that never recorded one', () => {
  const running = { status: 'running', version: 2, upstreamAffected: false, stored: [] };
  const omitted = command(running, { type: 'submit-artifact', reviewRequired: false }, 'miss-omit');
  assertRejected(omitted);
  assert.equal(omitted.state.status, 'running');
  const forged = command(
    running,
    { type: 'submit-artifact', reviewRequired: false, entryStatus: 'ready' },
    'miss-forge',
  );
  assertRejected(forged);
  const failed = { status: 'failed', version: 2, upstreamAffected: false, stored: [] };
  const retried = command(failed, { type: 'retry', returnTo: 'ready' }, 'miss-retry');
  assertRejected(retried);
  assert.equal(retried.state.status, 'failed');
  const cancelled = { status: 'cancelled', version: 2, upstreamAffected: false, stored: [] };
  const restarted = command(
    cancelled,
    { type: 'restart', returnTo: 'needs-revision' },
    'miss-restart',
  );
  assertRejected(restarted);
});

test('a ready node cannot claim a needs-revision entry to change the rule', () => {
  const ready = { status: 'ready', version: 1, upstreamAffected: false, stored: [] };
  const claimed = command(
    ready,
    { type: 'submit-artifact', reviewRequired: false, entryStatus: 'needs-revision' },
    'claim',
  );
  assertRejected(claimed);
  assert.equal(claimed.state.status, 'ready');
});

test('a ready entry can still submit without review', () => {
  let state = initialNodeCommandState();
  state = command(
    state,
    { type: 'plan-started', dependenciesSatisfied: true },
    'ready-start',
  ).state;
  assert.equal(state.status, 'ready');
  assert.equal(state.entryStatus, 'ready');
  state = command(state, { type: 'execution-acknowledged' }, 'ready-ack').state;
  assert.equal(state.entryStatus, 'ready');
  const submitted = command(
    state,
    { type: 'submit-artifact', reviewRequired: false },
    'ready-submit',
  );
  assert.equal(submitted.decision.status, 'applied');
  assert.equal(submitted.state.status, 'completed');
  assert.equal(submitted.state.entryStatus, undefined);
});

test('a child return that did not come from send-back can still submit without review', () => {
  let state = initialNodeCommandState();
  state = command(
    state,
    { type: 'plan-started', dependenciesSatisfied: true },
    'child-start',
  ).state;
  state = command(state, { type: 'child-workflow-started' }, 'child-split').state;
  state = command(state, { type: 'child-workflow-returned' }, 'child-back').state;
  assert.equal(state.status, 'ready');
  assert.equal(state.entryStatus, 'ready');
  const submitted = command(
    state,
    { type: 'submit-artifact', reviewRequired: false },
    'child-submit',
  );
  assert.equal(submitted.decision.status, 'applied');
  assert.equal(submitted.state.status, 'completed');
});

test('approved review clears the revision obligation and a normal submit completes', () => {
  let state = initialNodeCommandState();
  state = command(state, { type: 'plan-started', dependenciesSatisfied: true }, 'rev-start').state;
  state = command(state, { type: 'submit-artifact', reviewRequired: true }, 'rev-submit').state;
  assert.equal(state.status, 'in-review');

  const opened = openReviewRound({
    id: 'round-1',
    artifactVersionId: 'art-1',
    reviewerIds: ['h1'],
  });
  assert.equal(opened.ok, true);
  const rejected = submitBallot(
    opened.round,
    {
      reviewerId: 'h1',
      roundId: 'round-1',
      artifactVersionId: 'art-1',
      action: 'request-changes',
      comment: '改一版',
    },
    'h1',
  );
  assert.equal(rejected.ok, true);
  const sentBack = applyReviewSettlementCommand(
    state,
    envelope({ roundId: 'round-1', artifactVersionId: 'art-1' }, 'rev-reject', state.version),
    rejected.round,
    { roundId: 'round-1', artifactVersionId: 'art-1' },
  );
  assert.equal(sentBack.decision.status, 'applied');
  assert.equal(sentBack.state.status, 'needs-revision');
  assert.equal(sentBack.state.entryStatus, 'needs-revision');
  state = sentBack.state;

  const skipped = command(state, { type: 'submit-artifact', reviewRequired: false }, 'rev-skip');
  assertRejected(skipped);
  state = command(state, { type: 'submit-artifact', reviewRequired: true }, 'rev-resubmit').state;
  assert.equal(state.status, 'in-review');
  assert.equal(state.entryStatus, 'needs-revision');

  const again = openReviewRound({
    id: 'round-2',
    artifactVersionId: 'art-2',
    reviewerIds: ['h1'],
  });
  const approvedBallot = submitBallot(
    again.round,
    { reviewerId: 'h1', roundId: 'round-2', artifactVersionId: 'art-2', action: 'approve' },
    'h1',
  );
  const approved = applyReviewSettlementCommand(
    state,
    envelope({ roundId: 'round-2', artifactVersionId: 'art-2' }, 'rev-approve', state.version),
    approvedBallot.round,
    { roundId: 'round-2', artifactVersionId: 'art-2' },
  );
  assert.equal(approved.decision.status, 'applied');
  assert.equal(approved.state.status, 'completed');
  assert.equal(approved.state.entryStatus, undefined);
  assert.deepEqual(approved.decision.result.effects, ['accept-handoff']);

  const readyAgain = {
    status: 'ready',
    version: approved.state.version,
    upstreamAffected: approved.state.upstreamAffected,
    stored: approved.state.stored,
    entryStatus: 'ready',
  };
  const normal = command(
    readyAgain,
    { type: 'submit-artifact', reviewRequired: false },
    'rev-normal',
  );
  assert.equal(normal.decision.status, 'applied');
  assert.equal(normal.state.status, 'completed');
  assert.equal(normal.state.entryStatus, undefined);
  const withoutRecord = { ...readyAgain };
  delete withoutRecord.entryStatus;
  const skippedReady = command(
    withoutRecord,
    { type: 'submit-artifact', reviewRequired: false },
    'rev-no-record',
  );
  assertRejected(skippedReady);
  assert.equal(skippedReady.state.status, 'ready');
});
