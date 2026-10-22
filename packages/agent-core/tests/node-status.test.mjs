import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UNVERIFIED_EXTERNAL_SIGNALS,
  applyNodeTransitionCommand,
  initialNodeCommandState,
  recordCommandEvent,
  transitionNode,
  unverifiedSignalChangesNode,
} from '@zhuma/agent-core';

const envelope = (payload, idempotencyKey, expectedVersion) => ({
  idempotencyKey,
  actorId: 'human-1',
  objectId: 'node-1',
  expectedVersion,
  payload,
});

test('follows the legal node transitions and their effects', () => {
  const legal = [
    [
      'draft',
      { type: 'plan-started', dependenciesSatisfied: false },
      'blocked',
      ['hold-for-dependencies'],
    ],
    [
      'draft',
      { type: 'plan-started', dependenciesSatisfied: true },
      'ready',
      ['become-actionable'],
    ],
    [
      'blocked',
      { type: 'dependencies-changed', dependenciesSatisfied: true },
      'ready',
      ['become-actionable'],
    ],
    [
      'ready',
      { type: 'dependencies-changed', dependenciesSatisfied: false },
      'blocked',
      ['hold-for-dependencies'],
    ],
    ['ready', { type: 'execution-acknowledged' }, 'running', []],
    ['needs-revision', { type: 'execution-acknowledged' }, 'running', []],
    [
      'ready',
      { type: 'submit-artifact', reviewRequired: true },
      'in-review',
      ['open-review', 'block-downstream'],
    ],
    ['ready', { type: 'submit-artifact', reviewRequired: false }, 'completed', ['accept-handoff']],
    [
      'running',
      { type: 'submit-artifact', reviewRequired: true, entryStatus: 'ready' },
      'in-review',
      ['open-review', 'block-downstream'],
    ],
    [
      'needs-revision',
      { type: 'submit-artifact', reviewRequired: true },
      'in-review',
      ['open-review', 'block-downstream'],
    ],
    ['running', { type: 'execution-finished', returnTo: 'ready' }, 'ready', ['await-human-submit']],
    [
      'waiting-for-input',
      { type: 'execution-finished', returnTo: 'ready' },
      'ready',
      ['await-human-submit'],
    ],
    [
      'running',
      { type: 'execution-finished', returnTo: 'needs-revision' },
      'needs-revision',
      ['await-human-submit'],
    ],
    ['running', { type: 'input-required' }, 'waiting-for-input', []],
    ['waiting-for-input', { type: 'input-supplied' }, 'running', ['resume-execution']],
    ['ready', { type: 'child-workflow-started' }, 'child-workflow', []],
    ['needs-revision', { type: 'child-workflow-started' }, 'child-workflow', []],
    ['child-workflow', { type: 'child-workflow-returned' }, 'ready', ['await-parent-submit']],
    ['running', { type: 'execution-failed' }, 'failed', ['record-failure', 'block-downstream']],
    [
      'waiting-for-input',
      { type: 'execution-failed' },
      'failed',
      ['record-failure', 'block-downstream'],
    ],
    [
      'running',
      { type: 'cancel-confirmed' },
      'cancelled',
      ['record-cancellation', 'block-downstream'],
    ],
    [
      'in-review',
      { type: 'cancel-confirmed' },
      'cancelled',
      ['record-cancellation', 'block-downstream'],
    ],
    ['failed', { type: 'retry', returnTo: 'ready' }, 'ready', ['become-actionable']],
    [
      'failed',
      { type: 'retry', returnTo: 'needs-revision' },
      'needs-revision',
      ['block-downstream'],
    ],
    ['cancelled', { type: 'restart', returnTo: 'ready' }, 'ready', ['become-actionable']],
    [
      'cancelled',
      { type: 'restart', returnTo: 'needs-revision' },
      'needs-revision',
      ['block-downstream'],
    ],
    [
      'running',
      { type: 'submit-artifact', reviewRequired: true, entryStatus: 'needs-revision' },
      'in-review',
      ['open-review', 'block-downstream'],
    ],
    [
      'running',
      { type: 'submit-artifact', reviewRequired: false, entryStatus: 'ready' },
      'completed',
      ['accept-handoff'],
    ],
    ['completed', { type: 'reopen-for-rework' }, 'needs-revision', ['block-downstream']],
  ];
  for (const [from, transition, to, effects] of legal) {
    const before = structuredClone(transition);
    const result = transitionNode(from, transition);
    assert.equal(result.ok, true, `${from} ${transition.type}`);
    assert.equal(result.to, to, `${from} ${transition.type}`);
    assert.deepEqual(result.effects, effects, `${from} ${transition.type}`);
    assert.deepEqual(transition, before);
  }
});

test('rejects transitions that would skip review, delivery, or an explicit restart', () => {
  const illegal = [
    ['draft', { type: 'cancel-confirmed' }],
    ['draft', { type: 'execution-acknowledged' }],
    ['draft', { type: 'submit-artifact', reviewRequired: false }],
    ['blocked', { type: 'submit-artifact', reviewRequired: false }],
    ['blocked', { type: 'execution-acknowledged' }],
    ['ready', { type: 'execution-finished', returnTo: 'ready' }],
    ['ready', { type: 'input-required' }],
    ['ready', { type: 'review-resolved', outcome: 'approved' }],
    ['ready', { type: 'plan-started', dependenciesSatisfied: true }],
    ['running', { type: 'child-workflow-started' }],
    ['running', { type: 'retry' }],
    ['running', { type: 'review-resolved', outcome: 'approved' }],
    ['waiting-for-input', { type: 'submit-artifact', reviewRequired: false }],
    ['child-workflow', { type: 'submit-artifact', reviewRequired: true }],
    ['child-workflow', { type: 'review-resolved', outcome: 'approved' }],
    ['in-review', { type: 'submit-artifact', reviewRequired: true }],
    ['in-review', { type: 'execution-failed' }],
    ['needs-revision', { type: 'submit-artifact', reviewRequired: false }],
    ['running', { type: 'submit-artifact', reviewRequired: false }],
    ['running', { type: 'submit-artifact', reviewRequired: true }],
    ['running', { type: 'submit-artifact', reviewRequired: false, entryStatus: 'needs-revision' }],
    ['running', { type: 'submit-artifact', reviewRequired: true, entryStatus: 'blocked' }],
    ['ready', { type: 'submit-artifact', reviewRequired: false, entryStatus: 'needs-revision' }],
    ['needs-revision', { type: 'submit-artifact', reviewRequired: true, entryStatus: 'ready' }],
    ['failed', { type: 'retry' }],
    ['failed', { type: 'retry', returnTo: 'running' }],
    ['cancelled', { type: 'restart' }],
    ['cancelled', { type: 'restart', returnTo: 'completed' }],
    ['needs-revision', { type: 'review-resolved', outcome: 'approved' }],
    ['in-review', { type: 'review-resolved', outcome: 'approved' }],
    ['in-review', { type: 'review-resolved', outcome: 'changes-requested' }],
    ['completed', { type: 'submit-artifact', reviewRequired: true }],
    ['completed', { type: 'execution-finished', returnTo: 'ready' }],
    ['completed', { type: 'execution-acknowledged' }],
    ['completed', { type: 'plan-started', dependenciesSatisfied: true }],
    ['completed', { type: 'retry' }],
    ['failed', { type: 'execution-acknowledged' }],
    ['failed', { type: 'restart' }],
    ['failed', { type: 'submit-artifact', reviewRequired: false }],
    ['cancelled', { type: 'retry' }],
    ['cancelled', { type: 'submit-artifact', reviewRequired: false }],
    ['cancelled', { type: 'execution-acknowledged' }],
  ];
  for (const [from, transition] of illegal) {
    const result = transitionNode(from, transition);
    assert.equal(result.ok, false, `${from} ${transition.type}`);
    assert.equal(result.code, 'illegal-transition');
    assert.equal(result.from, from);
    assert.equal(result.transition, transition.type);
  }
});

test('revision entry survives stop and restart, and a later submit must be reviewed', () => {
  const acknowledged = transitionNode('needs-revision', { type: 'execution-acknowledged' });
  assert.equal(acknowledged.to, 'running');
  const cancelled = transitionNode('running', { type: 'cancel-confirmed' });
  assert.equal(cancelled.to, 'cancelled');
  const restarted = transitionNode('cancelled', { type: 'restart', returnTo: 'needs-revision' });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.to, 'needs-revision');
  assert.deepEqual(restarted.effects, ['block-downstream']);

  const skipped = transitionNode('running', {
    type: 'submit-artifact',
    reviewRequired: false,
    entryStatus: 'needs-revision',
  });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.code, 'illegal-transition');
  const reviewed = transitionNode('running', {
    type: 'submit-artifact',
    reviewRequired: true,
    entryStatus: 'needs-revision',
  });
  assert.equal(reviewed.to, 'in-review');

  const missing = transitionNode('cancelled', { type: 'restart' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'illegal-transition');
  assert.equal(missing.to, undefined);
  const retried = transitionNode('failed', { type: 'retry' });
  assert.equal(retried.ok, false);
  assert.equal(retried.code, 'illegal-transition');
  assert.equal(retried.to, undefined);
});

test('an unknown transition type is illegal and does not throw', () => {
  const named = transitionNode('running', { type: 'cancel-unconfirmed' });
  assert.equal(named.ok, false);
  assert.equal(named.code, 'illegal-transition');
  assert.equal(named.from, 'running');
  assert.equal(named.transition, 'cancel-unconfirmed');
  const unnamed = transitionNode('running', { type: 1 });
  assert.equal(unnamed.ok, false);
  assert.equal(unnamed.code, 'illegal-transition');
  assert.equal(unnamed.transition, 'unknown');
});

test('a returned child workflow waits for the parent submit and does not hand off', () => {
  const result = transitionNode('child-workflow', { type: 'child-workflow-returned' });
  assert.equal(result.to, 'ready');
  assert.deepEqual(result.effects, ['await-parent-submit']);
  assert.equal(result.effects.includes('accept-handoff'), false);
});

test('upstream changes mark settled work without reopening or rescheduling it', () => {
  for (const status of ['running', 'in-review', 'completed', 'failed', 'cancelled']) {
    const result = transitionNode(status, {
      type: 'dependencies-changed',
      dependenciesSatisfied: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.to, status);
    assert.equal(result.changed, false);
    assert.deepEqual(result.effects, ['mark-upstream-affected']);
  }
});

test('unverified external signals never change a node', () => {
  for (const signal of UNVERIFIED_EXTERNAL_SIGNALS) {
    assert.equal(unverifiedSignalChangesNode(signal), false);
  }
});

test('null transition inputs are rejected and do not throw', () => {
  const state = {
    status: 'ready',
    version: 3,
    upstreamAffected: false,
    stored: [],
    entryStatus: 'ready',
  };
  const missingPayload = applyNodeTransitionCommand(state, {
    idempotencyKey: 'null-payload',
    actorId: 'human-1',
    objectId: 'node-1',
    expectedVersion: 3,
    payload: null,
  });
  assert.equal(missingPayload.decision.status, 'rejected');
  assert.equal(missingPayload.decision.code, 'illegal-transition');
  assert.equal(missingPayload.state.status, 'ready');
  assert.equal(missingPayload.state.version, 3);
  const missingEnvelope = applyNodeTransitionCommand(state, null);
  assert.equal(missingEnvelope.decision.code, 'illegal-transition');
  assert.equal(missingEnvelope.state.status, 'ready');
  assert.equal(missingEnvelope.state.version, 3);
  const missingState = applyNodeTransitionCommand(null, {
    idempotencyKey: 'null-state',
    actorId: 'human-1',
    objectId: 'node-1',
    expectedVersion: 0,
    payload: { type: 'plan-started', dependenciesSatisfied: true },
  });
  assert.equal(missingState.decision.status, 'rejected');
  assert.equal(missingState.decision.code, 'illegal-transition');
  const direct = transitionNode('running', null);
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'illegal-transition');
});

test('an accepted command is not applied twice and an illegal one does not bump the version', () => {
  let state = initialNodeCommandState();
  const started = applyNodeTransitionCommand(
    state,
    envelope({ type: 'plan-started', dependenciesSatisfied: true }, 'start', 0),
  );
  state = started.state;
  assert.equal(state.status, 'ready');
  assert.equal(state.version, 1);

  const submitted = applyNodeTransitionCommand(
    state,
    envelope({ type: 'submit-artifact', reviewRequired: true }, 'submit', 1),
  );
  assert.equal(submitted.decision.status, 'applied');
  assert.equal(submitted.state.status, 'in-review');
  assert.equal(submitted.state.version, 2);
  assert.equal(submitted.state.stored.length, 2);

  const replay = applyNodeTransitionCommand(
    submitted.state,
    envelope({ type: 'submit-artifact', reviewRequired: true }, 'submit', 2),
  );
  assert.equal(replay.decision.status, 'replayed');
  assert.equal(replay.decision.result.to, 'in-review');
  assert.equal(replay.state.status, 'in-review');
  assert.equal(replay.state.version, 2);
  assert.equal(replay.state.stored.length, submitted.state.stored.length);

  const replayEvent = recordCommandEvent({
    decisionStatus: replay.decision.status,
    log: [],
    event: {
      eventId: 'evt-replay',
      sequence: 1,
      occurredAt: '2026-10-22T00:00:00.000Z',
      actorId: 'human-1',
      object: { type: 'node', id: 'node-1' },
      type: 'node.submit-artifact',
      payload: {},
    },
  });
  assert.equal(replayEvent.emitted, false);
  assert.deepEqual(replayEvent.log, []);

  const illegal = applyNodeTransitionCommand(
    replay.state,
    envelope({ type: 'submit-artifact', reviewRequired: true }, 'submit-again', 2),
  );
  assert.equal(illegal.decision.status, 'rejected');
  assert.equal(illegal.decision.code, 'illegal-transition');
  assert.equal(illegal.state.version, 2);
  assert.equal(illegal.state.status, 'in-review');
  assert.equal(illegal.state.stored.length, 2);
});

test('needs-revision can only submit a new version that opens another review', () => {
  const state = { ...initialNodeCommandState(), status: 'needs-revision', version: 5 };
  const skipped = applyNodeTransitionCommand(
    state,
    envelope({ type: 'submit-artifact', reviewRequired: false }, 'skip-review', 5),
  );
  assert.equal(skipped.decision.status, 'rejected');
  assert.equal(skipped.decision.code, 'illegal-transition');
  assert.equal(skipped.state.status, 'needs-revision');
  assert.equal(skipped.state.version, 5);
  assert.equal(skipped.state.stored.length, 0);

  const reviewed = applyNodeTransitionCommand(
    state,
    envelope({ type: 'submit-artifact', reviewRequired: true }, 'resubmit', 5),
  );
  assert.equal(reviewed.decision.status, 'applied');
  assert.equal(reviewed.state.status, 'in-review');
  assert.deepEqual(reviewed.decision.result.effects, ['open-review', 'block-downstream']);
  assert.equal(reviewed.state.version, 6);
});

test('a self-reported review result cannot bypass aggregation', () => {
  const state = { ...initialNodeCommandState(), status: 'in-review', version: 2 };
  for (const outcome of ['approved', 'changes-requested']) {
    const reported = applyNodeTransitionCommand(
      state,
      envelope({ type: 'review-resolved', outcome }, `self-${outcome}`, 2),
    );
    assert.equal(reported.decision.status, 'rejected');
    assert.equal(reported.decision.code, 'illegal-transition');
    assert.equal(reported.state.status, 'in-review');
    assert.equal(reported.state.version, 2);
    assert.equal(reported.state.stored.length, 0);
  }
});

test('marking a completed node as upstream-affected does not execute it again', () => {
  const state = { ...initialNodeCommandState(), status: 'completed', version: 3 };
  const marked = applyNodeTransitionCommand(
    state,
    envelope({ type: 'dependencies-changed', dependenciesSatisfied: false }, 'upstream', 3),
  );
  assert.equal(marked.decision.status, 'applied');
  assert.equal(marked.state.status, 'completed');
  assert.equal(marked.state.upstreamAffected, true);
  assert.equal(marked.state.version, 4);
  const replay = applyNodeTransitionCommand(
    marked.state,
    envelope({ type: 'dependencies-changed', dependenciesSatisfied: false }, 'upstream', 4),
  );
  assert.equal(replay.decision.status, 'replayed');
  assert.equal(replay.state.version, 4);
  assert.equal(replay.state.status, 'completed');
});

test('契约：execution-finished 拒绝和入口不一致的 returnTo', () => {
  const running = {
    status: 'running',
    version: 4,
    upstreamAffected: false,
    stored: [],
    entryStatus: 'needs-revision',
  };
  const forged = applyNodeTransitionCommand(
    running,
    envelope({ type: 'execution-finished', returnTo: 'ready' }, 'finish-forged', 4),
  );
  assert.equal(forged.decision.status, 'rejected');
  assert.equal(forged.decision.code, 'illegal-transition');
  assert.equal(forged.state.status, 'running');
  assert.equal(forged.state.entryStatus, 'needs-revision');
  assert.equal(forged.state.version, 4);
  const matched = applyNodeTransitionCommand(
    running,
    envelope({ type: 'execution-finished', returnTo: 'needs-revision' }, 'finish-matched', 4),
  );
  assert.equal(matched.decision.status, 'applied');
  assert.equal(matched.state.status, 'needs-revision');
  assert.equal(matched.decision.result.effects.includes('accept-handoff'), false);
});
