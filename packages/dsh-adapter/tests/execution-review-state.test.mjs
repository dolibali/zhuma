import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  castBallot,
  startAppliedPlan,
  submitDelivery,
} from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import {
  executionReviewOutputSchema,
  executionReviewScopeSchema,
  prepareExecutionReviewSchema,
} from '../dist/execution-review-contract.js';
import {
  executionReviewArtifactFingerprint,
  executionReviewTarget,
  prepareExecutionReview,
  readExecutionReviewState,
} from '../dist/execution-review-state.js';
import {
  beginExecutionRun,
  readExecutionRunState,
  nativeExecutionStateSchema,
  withExecutionRunState,
} from '../dist/execution-run-state.js';
import { command, available, applyEvent } from './execution-run-fixture.mjs';

// Pure contracts only: no member authentication, native SDK/model, files, or votes by an Agent.
function reviewFixture() {
  const f = fixture();
  const state = {
    ...f.state,
    participants: [
      ...f.state.participants.map((p) =>
        p.id === 'qa'
          ? { ...p, instructions: 'Read the fixed artifact and review independently.' }
          : p,
      ),
      {
        ...f.state.participants.find((p) => p.id === 'qa'),
        id: 'qa-two',
        instructions: 'Inspect the fixed content independently.',
      },
    ],
  };
  const workbench = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...f.task,
      participantIds: ['chen', 'qa', 'qa-two', 'outside'],
      status: 'ready',
      workflows: [
        {
          ...f.task.workflows[0],
          nodes: [{ ...f.node, reviewerIds: ['qa', 'qa-two', 'outside'] }],
        },
      ],
    },
  });
  const applied = workbench.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(started.ok, true);
  const ready = started.records[0];
  const submitted = submitDelivery({
    record: ready,
    actorId: 'chen',
    idempotencyKey: 'human-submission',
    expectedVersion: ready.command.version,
    artifactId: 'artifact-one',
    roundId: 'round-one',
    draft: {
      text: '## Login API\nPOST /login accepts a one-time challenge.',
      files: [],
      links: [],
    },
  });
  assert.equal(submitted.ok, true);
  return { record: submitted.record, ready, applied };
}
function request(record, patch = {}) {
  return {
    requestId: 'review-request',
    expectedReviewVersion: record.nativeExecution?.review?.version ?? 0,
    target: executionReviewTarget(record, 'north'),
    reviewerId: 'qa',
    controllerMemberId: 'chen',
    configurationId: 'review-configuration',
    newRunId: 'independent-review-run',
    newSegmentId: 'independent-review-segment',
    ...patch,
  };
}
function refused(f, code) {
  assert.throws(f, (error) => error.code === code);
}

test('review contract: legacy read has zero mutations and no eager review state', () => {
  const { record } = reviewFixture();
  const before = JSON.stringify(record);
  assert.equal(readExecutionReviewState(record), undefined);
  assert.equal(JSON.stringify(record), before);
  assert.equal(Object.hasOwn(record, 'nativeExecution'), false);
});

test('review contract: one fixed target and named expert reserve an independent lane, never a vote or author transition', () => {
  const { record, applied } = reviewFixture();
  const before = JSON.stringify(record);
  const prepared = prepareExecutionReview(record, applied, request(record));
  assert.equal(prepared.disposition, 'applied');
  assert.equal(JSON.stringify(record), before);
  assert.equal(prepared.record.command, record.command);
  assert.equal(prepared.record.rounds, record.rounds);
  assert.equal(prepared.record.artifactVersions, record.artifactVersions);
  assert.equal(prepared.record.comments, record.comments);
  assert.equal(prepared.record.receipts, record.receipts);
  assert.equal(prepared.record.command.status, 'in-review');
  assert.equal(prepared.record.rounds[0].ballots.length, 0);
  assert.equal(prepared.record.acceptedArtifactVersionId, undefined);
  assert.equal(prepared.attempt.status, 'prepared');
  assert.equal(prepared.attempt.scope.actorId, 'chen');
  assert.deepEqual(prepared.attempt.scope.review.principal, {
    kind: 'expert',
    controllerMemberId: 'chen',
    reviewerRef: {
      id: 'qa',
      version: applied.id,
      digest: prepared.attempt.scope.review.principal.reviewerRef.digest,
    },
  });
  assert.match(prepared.attempt.scope.review.principal.reviewerRef.digest, /^[a-f0-9]{64}$/u);
  assert.equal(readExecutionReviewState(prepared.record).attempts.length, 1);
  assert.equal(prepared.record.nativeExecution.runs, undefined, 'no fabricated author Run');
  assert.equal(
    nativeExecutionStateSchema.safeParse(prepared.record.nativeExecution).success,
    false,
    'the original strict v1 schema rejects the new envelope',
  );
  assert.equal(
    readExecutionRunState(prepared.record),
    undefined,
    'new reader sees no fabricated author',
  );
});

test('review contract: exact replay is zero change; changed controller/configuration/Run is not the same request', () => {
  const { record, applied } = reviewFixture();
  const body = request(record);
  const first = prepareExecutionReview(record, applied, body);
  const before = JSON.stringify(first.record);
  const again = prepareExecutionReview(first.record, applied, body);
  assert.equal(again.disposition, 'replayed');
  assert.equal(again.record, first.record);
  assert.equal(JSON.stringify(again.record), before);
  refused(
    () => prepareExecutionReview(first.record, applied, { ...body, configurationId: 'other' }),
    'review-idempotency-mismatch',
  );
  refused(
    () => prepareExecutionReview(first.record, applied, { ...body, newRunId: 'other' }),
    'review-idempotency-mismatch',
  );
  refused(
    () => prepareExecutionReview(first.record, applied, { ...body, controllerMemberId: 'qa' }),
    'review-not-controller',
  );
});

test('review contract: two experts keep distinct attempts; other ballots and unrelated node versions do not stale the fixed target', () => {
  const { record, applied } = reviewFixture();
  const first = prepareExecutionReview(record, applied, request(record));
  const second = prepareExecutionReview(
    first.record,
    applied,
    request(first.record, {
      requestId: 'review-two',
      reviewerId: 'qa-two',
      newRunId: 'review-run-two',
      newSegmentId: 'review-segment-two',
    }),
  );
  assert.equal(second.record.nativeExecution.review.attempts.length, 2);
  assert.equal(second.attempt.scope.generation, 2);
  assert.equal(second.record.nativeExecution.review.attempts[0].version, 1);
  const voted = castBallot({
    record: second.record,
    actorId: 'outside',
    idempotencyKey: 'human-review',
    expectedVersion: second.record.command.version,
    ballot: {
      reviewerId: 'outside',
      roundId: 'round-one',
      artifactVersionId: 'artifact-one',
      action: 'approve',
    },
  });
  assert.equal(voted.ok, true);
  assert.equal(voted.record.rounds[0].ballots[0].reviewerId, 'outside');
  assert.deepEqual(executionReviewTarget(voted.record, 'north'), first.attempt.scope.review.target);
  assert.equal(readExecutionReviewState(voted.record).attempts[0].version, 1);
  const advanced = {
    ...voted.record,
    command: { ...voted.record.command, version: voted.record.command.version + 1 },
  };
  assert.deepEqual(executionReviewTarget(advanced, 'north'), first.attempt.scope.review.target);
  assert.equal(readExecutionReviewState(advanced).attempts[0].version, 1);
});

test('review contract: one automatic attempt per target/reviewer; new request IDs cannot create a retry loop', () => {
  const { record, applied } = reviewFixture();
  const first = prepareExecutionReview(record, applied, request(record));
  refused(
    () =>
      prepareExecutionReview(
        first.record,
        applied,
        request(first.record, {
          requestId: 'try-again',
          newRunId: 'try-run',
          newSegmentId: 'try-segment',
        }),
      ),
    'review-attempt-budget',
  );
});

test('review contract: configured expert must also be on the actual fixed round roster and not have a terminal ballot', () => {
  const { record, applied } = reviewFixture();
  const omitted = {
    ...record,
    rounds: record.rounds.map((round) => ({ ...round, reviewerIds: ['outside', 'qa-two'] })),
  };
  refused(() => prepareExecutionReview(omitted, applied, request(omitted)), 'review-not-assigned');
  const voted = castBallot({
    record,
    actorId: 'qa',
    idempotencyKey: 'contract-ballot-only',
    expectedVersion: record.command.version,
    ballot: {
      reviewerId: 'qa',
      roundId: 'round-one',
      artifactVersionId: 'artifact-one',
      action: 'approve',
    },
  });
  assert.equal(voted.ok, true);
  refused(
    () => prepareExecutionReview(voted.record, applied, request(voted.record)),
    'review-already-voted',
  );
});

test('review contract: reviews share the existing 64 Run limit with author history without evicting either', () => {
  const { record, ready, applied } = reviewFixture();
  let history = ready;
  for (let index = 0; index < 63; index++) {
    const opened = beginExecutionRun(
      history,
      command(history, {
        requestId: `author-request-${index}`,
        newRunId: `author-run-${index}`,
        newSegmentId: `author-segment-${index}`,
        mode: index === 0 ? 'begin' : 'retry',
      }),
      [history],
      available,
    ).record;
    history = applyEvent(opened, 'failed', { resourcesSettled: true }).record;
  }
  const withHistory = { ...record, nativeExecution: history.nativeExecution };
  const prepared = prepareExecutionReview(withHistory, applied, request(withHistory));
  assert.equal(prepared.record.nativeExecution.runs.length, 63);
  assert.equal(prepared.record.nativeExecution.review.attempts.length, 1);
  const before = JSON.stringify(prepared.record);
  refused(
    () =>
      prepareExecutionReview(
        prepared.record,
        applied,
        request(prepared.record, {
          requestId: 'over-capacity',
          reviewerId: 'qa-two',
          newRunId: 'over-capacity-run',
          newSegmentId: 'over-capacity-segment',
        }),
      ),
    'review-capacity',
  );
  assert.equal(JSON.stringify(prepared.record), before);
});

for (const [name, patch, code] of [
  ['wrong command version', { expectedReviewVersion: 4 }, 'review-conflict'],
  ['fake human controller', { controllerMemberId: 'qa' }, 'review-not-controller'],
  ['unassigned expert', { reviewerId: 'not-assigned' }, 'review-expert-unavailable'],
  ['human reviewer as expert', { reviewerId: 'outside' }, 'review-expert-unavailable'],
])
  test(`review contract: ${name} rejects with zero mutation`, () => {
    const { record, applied } = reviewFixture();
    const before = JSON.stringify(record);
    refused(() => prepareExecutionReview(record, applied, request(record, patch)), code);
    assert.equal(JSON.stringify(record), before);
  });

test('review contract: frozen plan, expert version, assignment and availability are checked', () => {
  const { record, applied } = reviewFixture();
  for (const change of [
    { ...applied, id: 'another-plan' },
    { ...applied, revision: applied.revision + 1 },
  ])
    refused(() => prepareExecutionReview(record, change, request(record)), 'review-plan-mismatch');
  for (const [patch, code] of [
    [{ instructions: '' }, 'review-expert-unavailable'],
    [{ available: false }, 'review-plan-mismatch'],
  ]) {
    const modified = structuredClone(applied);
    Object.assign(
      modified.participants.find((p) => p.id === 'qa'),
      patch,
    );
    refused(() => prepareExecutionReview(record, modified, request(record)), code);
  }
});

test('review contract: producer cannot be its own reviewer, even if a tampered artifact calls it the submitter', () => {
  const { record, applied } = reviewFixture();
  const changed = {
    ...record,
    artifactVersions: record.artifactVersions.map((a) => ({ ...a, submittedBy: 'qa' })),
  };
  refused(() => prepareExecutionReview(changed, applied, request(changed)), 'review-self-review');
});

test('review contract: stale content, round, fingerprint and closed round cannot reserve or replay', () => {
  const { record, applied } = reviewFixture();
  const body = request(record);
  for (const target of [
    { ...body.target, roundId: 'old-round' },
    { ...body.target, artifactVersionId: 'old-artifact' },
    { ...body.target, artifactFingerprint: 'f'.repeat(64) },
  ])
    refused(
      () => prepareExecutionReview(record, applied, { ...body, target }),
      'review-target-stale',
    );
  const edited = {
    ...record,
    artifactVersions: record.artifactVersions.map((a) => ({ ...a, text: 'different bytes' })),
  };
  refused(() => prepareExecutionReview(edited, applied, body), 'review-target-stale');
  const prepared = prepareExecutionReview(record, applied, body).record;
  const closed = { ...prepared, rounds: prepared.rounds.map((r) => ({ ...r, status: 'voided' })) };
  assert.equal(
    readExecutionReviewState(closed).attempts.length,
    1,
    'historical metadata remains readable',
  );
  refused(() => prepareExecutionReview(closed, applied, body), 'review-target-stale');
});

test('review contract: fingerprint covers file reference, bytes, checksum, text, links and producer lineage', () => {
  const { record } = reviewFixture();
  const artifact = record.artifactVersions[0];
  const original = executionReviewArtifactFingerprint(artifact);
  for (const patch of [
    { text: 'changed' },
    { links: ['https://example.test/fixed'] },
    { producerRunId: 'run-other' },
    {
      files: [
        {
          id: 'file',
          mediaType: 'text/plain',
          byteSize: 2,
          checksum: 'checksum',
          accessPolicyId: 'policy',
          uploadComplete: true,
        },
      ],
    },
  ])
    assert.notEqual(executionReviewArtifactFingerprint({ ...artifact, ...patch }), original);
});

test('review contract: missing producer Run is rejected; the most recent Run is never guessed as producer', () => {
  const { record, applied } = reviewFixture();
  const changed = {
    ...record,
    artifactVersions: record.artifactVersions.map((a) => ({ ...a, producerRunId: 'unknown-run' })),
  };
  refused(
    () => prepareExecutionReview(changed, applied, request(changed)),
    'review-provenance-invalid',
  );
});

test('review contract: an original author Run remains intact; held author resources block preparation', () => {
  const { record, ready, applied } = reviewFixture();
  const running = beginExecutionRun(ready, command(ready), [ready], available).record;
  const held = applyEvent(running, 'failed', { resourcesSettled: false }).record;
  const blocked = { ...record, nativeExecution: held.nativeExecution };
  refused(() => prepareExecutionReview(blocked, applied, request(blocked)), 'review-author-active');
  const failed = applyEvent(running, 'failed', { resourcesSettled: true }).record;
  const withAuthor = { ...record, nativeExecution: failed.nativeExecution };
  const before = structuredClone(withAuthor.nativeExecution);
  const prepared = prepareExecutionReview(withAuthor, applied, request(withAuthor));
  const { schemaVersion, review, ...fields } = prepared.record.nativeExecution;
  assert.equal(schemaVersion, 2);
  assert.deepEqual({ ...fields, schemaVersion: 1 }, before);
  assert.equal(JSON.stringify(fields.runs), JSON.stringify(withAuthor.nativeExecution.runs));
  assert.equal(
    JSON.stringify(fields.receipts),
    JSON.stringify(withAuthor.nativeExecution.receipts),
  );
  assert.equal(prepared.record.command, record.command);
  assert.equal(review.attempts.length, 1);
  const reviewBytes = JSON.stringify(review);
  const updated = withExecutionRunState(prepared.record, {
    ...readExecutionRunState(prepared.record),
    version: before.version + 1,
  });
  assert.equal(updated.nativeExecution.version, before.version + 1);
  assert.equal(
    JSON.stringify(updated.nativeExecution.review),
    reviewBytes,
    'the original author-state replacement preserves the review lane verbatim',
  );
  refused(
    () =>
      prepareExecutionReview(
        withAuthor,
        applied,
        request(withAuthor, { newRunId: before.currentRunId }),
      ),
    'review-run-id-conflict',
  );
});

test('review contract: malformed present state fails closed rather than becoming an empty lane', () => {
  const { record, applied } = reviewFixture();
  const prepared = prepareExecutionReview(record, applied, request(record)).record;
  for (const mutate of [
    (r) => {
      r.nativeExecution.review = undefined;
    },
    (r) => {
      r.nativeExecution.review.extra = true;
    },
    (r) => {
      r.nativeExecution.review.attempts[0].scope.actorId = 'qa';
    },
    (r) => {
      r.nativeExecution.review.attempts[0].scope.review.principal.reviewerRef.digest = 'c'.repeat(
        64,
      );
    },
    (r) => {
      r.nativeExecution.review.receipts[0].fingerprint = 'a'.repeat(64);
    },
    (r) => {
      r.nativeExecution.review.receipts.push(r.nativeExecution.review.receipts[0]);
    },
    (r) => {
      r.nativeExecution.review.attempts.push(r.nativeExecution.review.attempts[0]);
    },
    (r) => {
      r.nativeExecution.schemaVersion = 1;
    },
  ]) {
    const corrupt = structuredClone(prepared);
    mutate(corrupt);
    refused(() => readExecutionReviewState(corrupt), 'review-state-invalid');
  }
});

test('review contract: strict inputs cannot smuggle principal/actor or cross-bind scope locations', () => {
  const { record, applied } = reviewFixture();
  const body = request(record);
  assert.equal(prepareExecutionReviewSchema.safeParse({ ...body, actorId: 'qa' }).success, false);
  assert.equal(
    prepareExecutionReviewSchema.safeParse({ ...body, principal: { kind: 'expert' } }).success,
    false,
  );
  const scope = prepareExecutionReview(record, applied, body).attempt.scope;
  for (const patch of [{ actorId: 'qa' }, { nodeId: 'different' }, { spaceId: 'different' }])
    assert.equal(executionReviewScopeSchema.safeParse({ ...scope, ...patch }).success, false);
});

test('review contract: structured conclusions retain original semantics and bounded content', () => {
  for (const conclusion of ['approve', 'request-changes', 'comment'])
    assert.equal(
      executionReviewOutputSchema.safeParse({
        conclusion,
        rationale: 'Checked the login input.',
        anchors: ['POST /login'],
      }).success,
      true,
    );
  assert.equal(
    executionReviewOutputSchema.safeParse({ conclusion: 'comment', rationale: 'Please clarify.' })
      .success,
    true,
  );
  for (const output of [
    { conclusion: 'approve', rationale: 'fine' },
    { conclusion: 'request-changes', rationale: 'fix it' },
    { conclusion: 'approve', rationale: ' ', anchors: ['line 1'] },
    { conclusion: 'approve', rationale: 'done', evidence: [' '] },
    { conclusion: 'approve', rationale: 'x'.repeat(100_001), anchors: ['line 1'] },
    { conclusion: 'approve', rationale: 'done', anchors: Array(51).fill('line 1') },
    { conclusion: 'approve', rationale: 'done', anchors: ['line 1'], reviewerId: 'qa' },
  ])
    assert.equal(executionReviewOutputSchema.safeParse(output).success, false);
});
