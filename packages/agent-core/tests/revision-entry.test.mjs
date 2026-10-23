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

test('a lost record cannot be rewritten by a child workflow round trip', () => {
  let state = sentBack();
  state = command(state, { type: 'child-workflow-started' }, 'trip-child').state;
  state = command(state, { type: 'child-workflow-returned' }, 'trip-back').state;
  assert.equal(state.status, 'ready');
  assert.equal(state.entryStatus, 'needs-revision');
  const lost = { ...state };
  delete lost.entryStatus;
  const version = lost.version;
  const started = command(lost, { type: 'child-workflow-started' }, 'trip-again');
  assertRejected(started);
  assert.equal(started.state.status, 'ready');
  assert.equal(started.state.entryStatus, undefined);
  assert.equal(started.state.version, version);
  const returned = command(started.state, { type: 'child-workflow-returned' }, 'trip-return');
  assertRejected(returned);
  assert.equal(returned.state.status, 'ready');
  assert.equal(returned.state.entryStatus, undefined);
  const submitted = command(
    returned.state,
    { type: 'submit-artifact', reviewRequired: false },
    'trip-submit',
  );
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'ready');
});

test('a lost record cannot be rewritten by a dependency round trip', () => {
  let state = sentBack();
  state = command(state, { type: 'child-workflow-started' }, 'dep-child').state;
  state = command(state, { type: 'child-workflow-returned' }, 'dep-back').state;
  const lost = { ...state };
  delete lost.entryStatus;
  const version = lost.version;
  const blocked = command(
    lost,
    { type: 'dependencies-changed', dependenciesSatisfied: false },
    'dep-down',
  );
  assertRejected(blocked);
  assert.equal(blocked.state.status, 'ready');
  assert.equal(blocked.state.entryStatus, undefined);
  assert.equal(blocked.state.version, version);
  const reopened = command(
    blocked.state,
    { type: 'dependencies-changed', dependenciesSatisfied: true },
    'dep-up',
  );
  assertRejected(reopened);
  assert.equal(reopened.state.status, 'ready');
  assert.equal(reopened.state.entryStatus, undefined);
  const submitted = command(
    reopened.state,
    { type: 'submit-artifact', reviewRequired: false },
    'dep-submit',
  );
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'ready');
});

test('a plan-started node records ready and can finish without review', () => {
  let state = initialNodeCommandState();
  state = command(state, { type: 'plan-started', dependenciesSatisfied: true }, 'born').state;
  assert.equal(state.status, 'ready');
  assert.equal(state.entryStatus, 'ready');
  const submitted = command(
    state,
    { type: 'submit-artifact', reviewRequired: false },
    'born-submit',
  );
  assert.equal(submitted.decision.status, 'applied');
  assert.equal(submitted.state.status, 'completed');
});

test('a recorded block and a recorded child trip keep their entry', () => {
  let fresh = initialNodeCommandState();
  fresh = command(
    fresh,
    { type: 'plan-started', dependenciesSatisfied: false },
    'keep-block',
  ).state;
  assert.equal(fresh.status, 'blocked');
  assert.equal(fresh.entryStatus, 'ready');
  fresh = command(
    fresh,
    { type: 'dependencies-changed', dependenciesSatisfied: true },
    'keep-ready',
  ).state;
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.entryStatus, 'ready');
  const finished = command(fresh, { type: 'submit-artifact', reviewRequired: false }, 'keep-done');
  assert.equal(finished.decision.status, 'applied');
  assert.equal(finished.state.status, 'completed');

  let child = initialNodeCommandState();
  child = command(child, { type: 'plan-started', dependenciesSatisfied: true }, 'keep-start').state;
  child = command(child, { type: 'child-workflow-started' }, 'keep-split').state;
  child = command(child, { type: 'child-workflow-returned' }, 'keep-join').state;
  assert.equal(child.status, 'ready');
  assert.equal(child.entryStatus, 'ready');
  const childDone = command(
    child,
    { type: 'submit-artifact', reviewRequired: false },
    'keep-child',
  );
  assert.equal(childDone.decision.status, 'applied');
  assert.equal(childDone.state.status, 'completed');

  let sent = sentBack();
  sent = command(sent, { type: 'child-workflow-started' }, 'keep-rev-child').state;
  sent = command(sent, { type: 'child-workflow-returned' }, 'keep-rev-back').state;
  sent = command(
    sent,
    { type: 'dependencies-changed', dependenciesSatisfied: false },
    'keep-rev-down',
  ).state;
  assert.equal(sent.status, 'blocked');
  assert.equal(sent.entryStatus, 'needs-revision');
  sent = command(
    sent,
    { type: 'dependencies-changed', dependenciesSatisfied: true },
    'keep-rev-up',
  ).state;
  assert.equal(sent.status, 'ready');
  assert.equal(sent.entryStatus, 'needs-revision');
  const still = command(
    sent,
    { type: 'submit-artifact', reviewRequired: false },
    'keep-rev-submit',
  );
  assertRejected(still);
  assert.equal(still.state.status, 'ready');
  assert.equal(still.state.entryStatus, 'needs-revision');
});

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

function bare(status) {
  return { status, version: 3, upstreamAffected: false, stored: [] };
}

test('a missing record still reaches failed or cancelled', () => {
  for (const status of ['running', 'waiting-for-input']) {
    const failed = command(bare(status), { type: 'execution-failed' }, `${status}-fail`);
    assert.equal(failed.decision.status, 'applied', status);
    assert.equal(failed.state.status, 'failed');
    assert.equal(failed.state.entryStatus, undefined);
    assert.equal(failed.state.version, 4);
    assert.deepEqual(failed.decision.result.effects, ['record-failure', 'block-downstream']);

    const cancelled = command(bare(status), { type: 'cancel-confirmed' }, `${status}-cancel`);
    assert.equal(cancelled.decision.status, 'applied', status);
    assert.equal(cancelled.state.status, 'cancelled');
    assert.equal(cancelled.state.entryStatus, undefined);
    assert.equal(cancelled.state.version, 4);
    assert.deepEqual(cancelled.decision.result.effects, [
      'record-cancellation',
      'block-downstream',
    ]);
  }
});

test('retry and restart stay rejected after a record-less close', () => {
  const failed = command(bare('running'), { type: 'execution-failed' }, 'after-fail');
  assert.equal(failed.state.status, 'failed');
  assert.equal(failed.state.entryStatus, undefined);
  for (const returnTo of ['ready', 'needs-revision']) {
    const retried = command(failed.state, { type: 'retry', returnTo }, `after-retry-${returnTo}`);
    assertRejected(retried);
    assert.equal(retried.state.status, 'failed');
    assert.equal(retried.state.entryStatus, undefined);
    assert.equal(retried.state.version, failed.state.version);
  }

  const cancelled = command(
    bare('waiting-for-input'),
    { type: 'cancel-confirmed' },
    'after-cancel',
  );
  assert.equal(cancelled.state.status, 'cancelled');
  assert.equal(cancelled.state.entryStatus, undefined);
  for (const returnTo of ['ready', 'needs-revision']) {
    const restarted = command(
      cancelled.state,
      { type: 'restart', returnTo },
      `after-restart-${returnTo}`,
    );
    assertRejected(restarted);
    assert.equal(restarted.state.status, 'cancelled');
    assert.equal(restarted.state.entryStatus, undefined);
    assert.equal(restarted.state.version, cancelled.state.version);
  }
  const submitted = command(
    cancelled.state,
    { type: 'submit-artifact', reviewRequired: false },
    'after-submit',
  );
  assertRejected(submitted);
  assert.equal(submitted.state.status, 'cancelled');
});

test('other commands still reject a running node that lost its record', () => {
  const state = bare('running');
  for (const payload of [
    { type: 'submit-artifact', reviewRequired: false },
    { type: 'submit-artifact', reviewRequired: true, entryStatus: 'ready' },
    { type: 'input-required' },
    { type: 'execution-acknowledged' },
  ]) {
    const result = command(
      state,
      payload,
      `still-${payload.type}-${payload.reviewRequired ?? 'x'}`,
    );
    assertRejected(result);
    assert.equal(result.state.status, 'running');
    assert.equal(result.state.version, 3);
    assert.equal(result.state.entryStatus, undefined);
  }
});

test('record-less cancel-confirmed reaches cancelled without a new recovery', () => {
  const cases = [
    ['blocked', undefined],
    ['ready', undefined],
    ['child-workflow', undefined],
    ['in-review', undefined],
    ['needs-revision', 'needs-revision'],
  ];
  for (const [status, entry] of cases) {
    const cancelled = command(bare(status), { type: 'cancel-confirmed' }, `lock-${status}`);
    assert.equal(cancelled.decision.status, 'applied', status);
    assert.equal(cancelled.state.status, 'cancelled', status);
    assert.equal(cancelled.state.entryStatus, entry, status);
    assert.equal(cancelled.state.version, 4, status);
    assert.deepEqual(
      cancelled.decision.result.effects,
      ['record-cancellation', 'block-downstream'],
      status,
    );
    for (const returnTo of ['ready', 'needs-revision']) {
      const retried = command(
        cancelled.state,
        { type: 'retry', returnTo },
        `lock-retry-${status}-${returnTo}`,
      );
      assertRejected(retried);
      assert.equal(retried.state.status, 'cancelled', `${status} retry ${returnTo}`);
      assert.equal(retried.state.version, cancelled.state.version, status);

      const restarted = command(
        cancelled.state,
        { type: 'restart', returnTo },
        `lock-restart-${status}-${returnTo}`,
      );
      const keepsObligation = entry === 'needs-revision' && returnTo === 'needs-revision';
      if (keepsObligation) {
        assert.equal(restarted.decision.status, 'applied', status);
        assert.equal(restarted.state.status, 'needs-revision', status);
        assert.equal(restarted.state.entryStatus, 'needs-revision', status);
        continue;
      }
      assertRejected(restarted);
      assert.equal(restarted.state.status, 'cancelled', `${status} restart ${returnTo}`);
      assert.equal(restarted.state.entryStatus, entry, `${status} restart ${returnTo}`);
      assert.equal(restarted.state.version, cancelled.state.version, status);
    }
  }
});

test('a recorded failure still keeps its entry and can retry', () => {
  const failed = command(
    { ...bare('running'), entryStatus: 'ready' },
    { type: 'execution-failed' },
    'recorded-fail',
  );
  assert.equal(failed.decision.status, 'applied');
  assert.equal(failed.state.status, 'failed');
  assert.equal(failed.state.entryStatus, 'ready');
  const retried = command(failed.state, { type: 'retry', returnTo: 'ready' }, 'recorded-retry');
  assert.equal(retried.decision.status, 'applied');
  assert.equal(retried.state.status, 'ready');
  assert.equal(retried.state.entryStatus, 'ready');
});
