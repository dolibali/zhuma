import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareExecutionReview,
  readExecutionReviewState,
} from '../dist/execution-review-state.js';
import {
  admitExecutionReview,
  recordExecutionReviewEvent,
} from '../dist/execution-review-lifecycle.js';
import { freezeExecutionReviewComposition } from '../dist/execution-review-composition.js';
import { readExecutionRunState } from '../dist/execution-run-state.js';
import { reviewCompositionFacts } from './execution-review-composition-fixture.mjs';

// Pure lifecycle contracts; events and physical cleanup claims are explicit inputs,
// not genuine native evidence or authority to produce a ballot.
function reserved() {
  const facts = reviewCompositionFacts();
  const composition = freezeExecutionReviewComposition(facts);
  const prepared = prepareExecutionReview(facts.node, facts.applied, {
    requestId: 'review-reservation',
    expectedReviewVersion: 0,
    target: facts.scope.review.target,
    reviewerId: 'qa',
    controllerMemberId: 'chen',
    configurationId: composition.configurationId,
    newRunId: facts.scope.runId,
    newSegmentId: facts.scope.segmentId,
  });
  return { ...facts, composition, record: prepared.record, attempt: prepared.attempt };
}
function admitted() {
  const f = reserved();
  return {
    ...f,
    ...admitExecutionReview(f.record, {
      scope: f.scope,
      expectedAttemptVersion: 1,
      composition: f.composition,
    }),
  };
}
function event(record, kind, patch = {}) {
  const attempt = readExecutionReviewState(record).attempts[0];
  return {
    scope: attempt.scope,
    sequence: (attempt.lastEventSequence ?? 0) + 1,
    kind,
    ...(['received', 'accepted'].includes(kind)
      ? { nativeSessionId: 'independent-session', nativeAgentId: 'independent-session' }
      : {}),
    ...patch,
  };
}
function apply(record, kind, patch) {
  return recordExecutionReviewEvent(record, event(record, kind, patch));
}

test('review lifecycle: admission freezes composition in the original envelope without fabricating author Run or changing node/ballots', () => {
  const f = reserved(),
    before = JSON.stringify(f.record);
  const result = admitExecutionReview(f.record, {
    scope: f.scope,
    expectedAttemptVersion: 1,
    composition: f.composition,
  });
  assert.equal(result.attempt.status, 'requested');
  assert.equal(result.attempt.version, 2);
  assert.equal(result.attempt.resources, 'held');
  assert.equal(JSON.stringify(f.record), before);
  assert.equal(readExecutionRunState(result.record), undefined);
  for (const key of ['command', 'rounds', 'artifactVersions', 'receipts', 'comments'])
    assert.deepEqual(result.record[key], f.record[key]);
  assert.equal(result.record.command.status, 'in-review');
  const replay = admitExecutionReview(result.record, {
    scope: f.scope,
    expectedAttemptVersion: 1,
    composition: f.composition,
  });
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.record, result.record);
});

test('review lifecycle: prepared metadata alone cannot receive native events', () => {
  const f = reserved();
  assert.throws(() => apply(f.record, 'accepted'), { code: 'review-not-admitted' });
  assert.throws(
    () =>
      admitExecutionReview(f.record, {
        scope: f.scope,
        expectedAttemptVersion: 9,
        composition: f.composition,
      }),
    { code: 'review-conflict' },
  );
});

test('review lifecycle: preserving an unadmitted marker never permits two admitted attempts in the same lane', () => {
  const f = reserved();
  const scope = {
    ...f.scope,
    runId: 'new-review-run',
    segmentId: 'new-review-segment',
    generation: 2,
  };
  const composition = freezeExecutionReviewComposition({ ...f, scope });
  const request = {
    requestId: 'new-review-request',
    expectedReviewVersion: 1,
    target: scope.review.target,
    reviewerId: 'qa',
    controllerMemberId: 'chen',
    configurationId: composition.configurationId,
    newRunId: scope.runId,
    newSegmentId: scope.segmentId,
  };
  // This set is a pure helper contract. Only the Service may derive it from
  // the original queued Stop; no public request accepts it.
  const next = prepareExecutionReview(f.record, f.applied, request, new Set([f.scope.runId]));
  assert.deepEqual(next.record.nativeExecution.review.attempts[0], f.attempt);
  const live = admitExecutionReview(next.record, {
    scope,
    expectedAttemptVersion: 1,
    composition,
  }).record;
  assert.equal(readExecutionReviewState(live).attempts[1].status, 'requested');
  assert.throws(
    () =>
      admitExecutionReview(live, {
        scope: f.scope,
        expectedAttemptVersion: 1,
        composition: f.composition,
      }),
    { code: 'review-state-invalid' },
  );
  assert.throws(
    () =>
      prepareExecutionReview(
        live,
        f.applied,
        {
          ...request,
          requestId: 'third-review',
          expectedReviewVersion: live.nativeExecution.review.version,
          newRunId: 'third-run',
          newSegmentId: 'third-segment',
        },
        new Set([f.scope.runId, scope.runId]),
      ),
    { code: 'review-attempt-budget' },
  );
});

test('review lifecycle: exact native receipt/acceptance is independent, while idle and completed never create a vote or settle resources', () => {
  let { record } = admitted();
  record = apply(record, 'received').record;
  assert.equal(readExecutionReviewState(record).attempts[0].status, 'requested');
  record = apply(record, 'accepted').record;
  assert.equal(readExecutionReviewState(record).attempts[0].status, 'running');
  record = apply(record, 'idle').record;
  assert.equal(readExecutionReviewState(record).attempts[0].status, 'running');
  const complete = apply(record, 'completed');
  assert.equal(complete.attempt.status, 'completed');
  assert.equal(complete.attempt.resources, 'held');
  assert.equal(complete.record.rounds[0].ballots.length, 0);
  assert.equal(complete.record.command.status, 'in-review');
  const drained = apply(complete.record, 'cleanup');
  assert.equal(drained.attempt.resources, 'settled');
  assert.equal(drained.record.rounds[0].ballots.length, 0);
});

test('review lifecycle: stopping blocks completion; only explicit stop receipt precedes cleanup', () => {
  let { record } = admitted();
  record = apply(record, 'accepted').record;
  assert.throws(() => apply(record, 'stopped'), { code: 'review-stop-not-requested' });
  assert.throws(() => apply(record, 'cleanup'), { code: 'review-native-active' });
  record = apply(record, 'stop-requested').record;
  assert.throws(() => apply(record, 'completed'), { code: 'review-stopping' });
  assert.throws(() => apply(record, 'accepted'), { code: 'review-stopping' });
  const stopped = apply(record, 'stopped');
  assert.equal(stopped.attempt.status, 'cancelled');
  assert.equal(stopped.attempt.resources, 'held');
  assert.equal(apply(stopped.record, 'cleanup').attempt.resources, 'settled');
});

test('review lifecycle: exact sequence replays, conflicting reuse refuses, stale and post-terminal events do not mutate', () => {
  const f = admitted(),
    accepted = event(f.record, 'accepted');
  const current = recordExecutionReviewEvent(f.record, accepted);
  assert.equal(recordExecutionReviewEvent(current.record, accepted).disposition, 'replayed');
  assert.throws(
    () => recordExecutionReviewEvent(current.record, { ...accepted, nativeSessionId: 'different' }),
    { code: 'review-event-mismatch' },
  );
  const idle = apply(current.record, 'idle');
  assert.equal(recordExecutionReviewEvent(idle.record, accepted).disposition, 'ignored');
  const failed = apply(idle.record, 'failed');
  const late = apply(failed.record, 'completed');
  assert.equal(late.disposition, 'ignored');
  assert.equal(late.record, failed.record);
});

test('review lifecycle: mismatched native IDs and exact scope never replace the bound session', () => {
  const f = admitted();
  assert.throws(() => apply(f.record, 'accepted', { nativeAgentId: 'other' }), {
    code: 'review-session-mismatch',
  });
  const received = apply(f.record, 'received');
  assert.throws(
    () => apply(received.record, 'accepted', { nativeSessionId: 'other', nativeAgentId: 'other' }),
    { code: 'review-session-mismatch' },
  );
  assert.throws(() => apply(f.record, 'accepted', { scope: { ...f.scope, segmentId: 'other' } }), {
    code: 'review-not-prepared',
  });
});

test('review lifecycle: malformed persisted admission is rejected by the original shared reader', () => {
  const f = admitted();
  for (const mutate of [
    (a) => {
      a.composition.payload.model.model = 'invented';
    },
    (a) => {
      a.status = 'completed';
    },
    (a) => {
      a.resources = 'settled';
    },
    (a) => {
      a.nativeSessionId = 'borrowed';
      a.nativeAgentId = 'different';
    },
    (a) => {
      a.lastEventSequence = 4;
    },
  ]) {
    const copy = structuredClone(f.record);
    mutate(copy.nativeExecution.review.attempts[0]);
    assert.throws(() => readExecutionReviewState(copy), { code: 'review-state-invalid' });
  }
});

test('review lifecycle: another named expert cannot borrow the first reviewers native session', () => {
  const f = structuredClone(reserved());
  f.applied.participants.push({
    ...f.applied.participants.find((p) => p.id === 'qa'),
    id: 'qa-two',
  });
  f.applied.task.participantIds.push('qa-two');
  f.applied.task.workflows[0].nodes[0].reviewerIds.push('qa-two');
  f.record.handoff.reviewerIds.push('qa-two');
  f.record.rounds[0].reviewerIds.push('qa-two');
  let first = admitExecutionReview(f.record, {
    scope: f.scope,
    expectedAttemptVersion: 1,
    composition: f.composition,
  });
  first = apply(first.record, 'accepted');
  const peerRequest = {
    requestId: 'peer-review',
    expectedReviewVersion: readExecutionReviewState(first.record).version,
    target: f.scope.review.target,
    reviewerId: 'qa-two',
    controllerMemberId: 'chen',
    configurationId: 'candidate',
    newRunId: 'peer-run',
    newSegmentId: 'peer-segment',
  };
  const candidate = prepareExecutionReview(first.record, f.applied, peerRequest);
  const composition = freezeExecutionReviewComposition({
    ...f,
    node: first.record,
    scope: candidate.attempt.scope,
  });
  const prepared = prepareExecutionReview(first.record, f.applied, {
    ...peerRequest,
    configurationId: composition.configurationId,
  });
  const peer = admitExecutionReview(prepared.record, {
    scope: prepared.attempt.scope,
    expectedAttemptVersion: 1,
    composition,
  });
  assert.throws(
    () =>
      recordExecutionReviewEvent(peer.record, {
        scope: peer.attempt.scope,
        sequence: 1,
        kind: 'accepted',
        nativeSessionId: 'independent-session',
        nativeAgentId: 'independent-session',
      }),
    { code: 'review-session-mismatch' },
  );
  assert.equal(readExecutionReviewState(peer.record).attempts[1].status, 'requested');
});
