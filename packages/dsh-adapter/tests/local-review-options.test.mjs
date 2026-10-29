/** Actual original Service/JSON/fixed submit/review metadata. Member, model and
 * native ports remain contracts; these reads do not certify local SDK or HTTP UI. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalPayload,
  localReviewOptionsQuerySchema,
  localReviewOptionsSchema,
} from '@zhuma/agent-core';
import { host } from './execution-review-service-fixture.mjs';
import { reviewHost, ok, no } from './remote-review-fixture.mjs';
import { caller, open } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import {
  executionReviewArtifactFingerprint,
  readExecutionReviewState,
} from '../dist/execution-review-state.js';

const query = (h) => {
  const node = h.read(),
    round = node.rounds.find((item) => item.id === node.currentRoundId);
  return {
    spaceId: 'north',
    ...h.locate(),
    roundId: round.id,
    artifactVersionId: round.artifactVersionId,
  };
};
const options = async (h, body = query(h), request = h.request) =>
  h.service.readLocalReviewOptions(request, body);
const facts = (h) =>
  canonicalPayload({
    global: h.domain.global.get(),
    nodes: [...h.domain.table('nodes').entries()],
  });
const noWrites = (h, before) => {
  assert.equal(facts(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
};
const prepared = async (h, reviewer = 'qa') => {
  const value = ok(await options(h));
  const reviewerRef = value.reviewers.find((item) => item.reviewerRef.id === reviewer).reviewerRef;
  return ok(
    await h.service.prepareExpertReview(h.request, {
      target: value.target,
      reviewerRef: { id: reviewerRef.id, version: reviewerRef.version },
      expectedReviewVersion: value.expectedReviewVersion,
      configurationId: 'original-review-config',
      requestId: 'prepare-original-review',
    }),
  );
};

test('local review options: exact fixed fingerprint, assigned expert refs and original pure preparation agree without marker, reservation, model or content IO', async (t) => {
  const h = await host(t, {
    file: { name: 'fixed.txt', mediaType: 'text/plain', text: 'Original file bytes.' },
  });
  const before = facts(h),
    disk = await businessHashes(h.root),
    node = h.read();
  let modelCalls = 0;
  h.service.runHost.assertReviewConfiguration = () => {
    modelCalls++;
    throw Error('NO_MODEL_LOOKUP');
  };
  const value = ok(await options(h));
  localReviewOptionsSchema.parse(value);
  assert.deepEqual(
    value.target,
    ok(await h.service.readExpertReviewTarget(h.request, { spaceId: 'north', ...h.locate() })),
  );
  assert.equal(
    value.target.artifactFingerprint,
    executionReviewArtifactFingerprint(node.artifactVersions[0]),
  );
  assert.equal(value.controllerMemberId, 'chen');
  assert.equal(value.expectedReviewVersion, 0);
  assert.deepEqual(
    value.reviewers.map((item) => item.reviewerRef.id),
    ['qa', 'qa-two'],
  );
  assert.equal(
    value.reviewers.every((item) => item.canStart && !item.unavailableReason),
    true,
  );
  assert.deepEqual(value.attempts, []);
  for (const reviewer of value.reviewers) {
    const preparation = ok(
      await h.service.readExpertReviewPreparation(h.request, {
        requestId: `inspect-${reviewer.reviewerRef.id}`,
        expectedReviewVersion: 0,
        target: value.target,
        reviewerRef: { id: reviewer.reviewerRef.id, version: reviewer.reviewerRef.version },
      }),
    );
    assert.deepEqual(reviewer.reviewerRef, preparation.scope.review.principal.reviewerRef);
  }
  assert.equal(readExecutionReviewState(h.read()), undefined);
  assert.equal(h.domain.global.get().nativeReviewWriter, undefined);
  assert.equal(modelCalls, 0);
  assert(!JSON.stringify(value).includes(node.artifactVersions[0].text));
  assert(!JSON.stringify(value).includes('instructions'));
  noWrites(h, before);
  assert.deepEqual(await businessHashes(h.root), disk);
  value.target.artifactFingerprint = '0'.repeat(64);
  value.reviewers[0].reviewerRef.digest = '0'.repeat(64);
  const fresh = ok(await options(h));
  assert.notEqual(fresh.target.artifactFingerprint, value.target.artifactFingerprint);
  assert.notEqual(fresh.reviewers[0].reviewerRef.digest, value.reviewers[0].reviewerRef.digest);
  noWrites(h, before);
});

test('local review options: strict fixed target query rejects old round, old artifact, wrong scope and identity injection with zero writes', async (t) => {
  const h = await host(t),
    target = query(h),
    before = facts(h);
  for (const body of [
    { ...target, roundId: 'old-round' },
    { ...target, artifactVersionId: 'old-artifact' },
    { ...target, spaceId: 'wrong-space' },
    { ...target, taskId: 'another-task' },
    { ...target, planId: 'another-plan' },
    { ...target, revision: target.revision + 1 },
    { ...target, nodeId: 'parallel' },
    { ...target, actorId: 'chen' },
    { ...target, target: {} },
    { ...target, reviewerRef: { id: 'qa', version: target.planId } },
  ])
    no(await options(h, body));
  for (const key of [
    'spaceId',
    'taskId',
    'planId',
    'revision',
    'nodeId',
    'roundId',
    'artifactVersionId',
  ]) {
    const omitted = { ...target };
    delete omitted[key];
    assert.equal(localReviewOptionsQuerySchema.safeParse(omitted).success, false);
    no(await options(h, omitted));
  }
  noWrites(h, before);
});

test('local review options: fresh member/controller/project-space/task authority is mandatory, even with a known exact target', async (t) => {
  const h = await host(t),
    target = query(h),
    before = facts(h),
    original = h.readWorkbench();
  const wrong = { headers: {} };
  h.members.set(wrong, 'outside');
  no(await options(h, target, wrong), 'review-not-controller');
  no(await options(h, target, { headers: {} }));
  h.setWorkbench((state) => ({
    ...state,
    participants: state.participants.map((item) =>
      item.id === 'chen' ? { ...item, available: false } : item,
    ),
  }));
  no(await options(h, target));
  h.setWorkbench(() => original);
  h.assertionResults.project = () => {
    throw Error('CURRENT_SPACE_REVOKED');
  };
  no(await options(h, target));
  delete h.assertionResults.project;
  h.setWorkbench((state) => ({
    ...state,
    tasks: state.tasks.map((task) => ({ ...task, ownerId: 'outside' })),
  }));
  no(await options(h, target));
  h.setWorkbench(() => original);
  h.member.abort();
  no(await options(h, target));
  noWrites(h, before);
});

test('local review options: unavailable assigned expert keeps its actual frozen ref, while unrelated experts never become options', async (t) => {
  const h = await host(t),
    initial = ok(await options(h)),
    before = facts(h);
  h.setWorkbench((state) => ({
    ...state,
    participants: [
      ...state.participants.map((item) =>
        item.id === 'qa'
          ? { ...item, available: false, instructions: 'Changed live instructions.' }
          : item,
      ),
      {
        ...state.participants.find((item) => item.id === 'qa'),
        id: 'unassigned-expert',
        name: 'Unassigned',
      },
    ],
  }));
  const value = ok(await options(h)),
    qa = value.reviewers.find((item) => item.reviewerRef.id === 'qa');
  assert.equal(qa.canStart, false);
  assert.equal(qa.unavailableReason, 'review-expert-unavailable');
  assert.deepEqual(qa.reviewerRef, initial.reviewers[0].reviewerRef);
  assert.equal(
    value.reviewers.some((item) => item.reviewerRef.id === 'unassigned-expert'),
    false,
  );
  assert.equal(value.reviewers.find((item) => item.reviewerRef.id === 'qa-two').canStart, true);
  noWrites(h, before);
});

test('local review options: existing original prepared attempt supplies actual version and scope without permitting another reservation', async (t) => {
  const h = await host(t),
    original = await prepared(h);
  const before = facts(h);
  h.resetCounts();
  const value = ok(await options(h));
  assert.equal(value.expectedReviewVersion, readExecutionReviewState(h.read()).version);
  assert.equal(value.attempts.length, 1);
  assert.deepEqual(value.attempts[0], {
    scope: original.attempt.scope,
    version: original.attempt.version,
    status: 'prepared',
    resources: 'held',
    dispatch: 'reserved',
  });
  const qa = value.reviewers.find((item) => item.reviewerRef.id === 'qa');
  assert.equal(qa.canStart, false);
  assert.equal(qa.unavailableReason, 'review-attempt-budget');
  assert.equal(value.reviewers.find((item) => item.reviewerRef.id === 'qa-two').canStart, true);
  noWrites(h, before);
});

test('local review options: real remote attempt is projected only as original scope facts, without private permits or model qualification', async (t) => {
  const h = await reviewHost(t, { reviewers: ['qa', 'qa-two'] });
  await h.begin('qa');
  const before = facts(h),
    calls = structuredClone(h.calls);
  h.resetCounts();
  const value = ok(await options(h)),
    attempt = readExecutionReviewState(h.read()).attempts[0];
  assert.equal(value.expectedReviewVersion, readExecutionReviewState(h.read()).version);
  assert.deepEqual(value.attempts[0].scope, attempt.scope);
  assert.deepEqual(value.attempts[0].remoteScope, h.reviewView.scope);
  assert.equal(value.attempts[0].status, attempt.status);
  assert.equal(
    value.reviewers.find((item) => item.reviewerRef.id === 'qa').unavailableReason,
    'review-attempt-budget',
  );
  assert.equal(value.reviewers.find((item) => item.reviewerRef.id === 'qa-two').canStart, true);
  for (const field of [
    'publicKey',
    'memberSessionHash',
    'drive',
    'cleanup',
    'credentials',
    'configurationId',
  ])
    assert.equal(JSON.stringify(value).includes(`"${field}"`), false);
  assert.deepEqual(h.calls, calls);
  noWrites(h, before);
});

test('local review options: original completed reviewer is already-voted while another assigned reviewer remains eligible', async (t) => {
  const h = await reviewHost(t, { reviewers: ['qa', 'qa-two'] });
  await h.begin('qa');
  const fixed = h.fixed();
  await h.seal(fixed);
  ok(await h.submit(fixed));
  ok(await h.cleanup());
  const before = facts(h);
  h.resetCounts();
  const value = ok(await options(h));
  assert.equal(
    value.reviewers.find((item) => item.reviewerRef.id === 'qa').unavailableReason,
    'review-already-voted',
  );
  assert.equal(value.reviewers.find((item) => item.reviewerRef.id === 'qa-two').canStart, true);
  assert.equal(value.attempts[0].status, 'completed');
  assert.equal(value.attempts[0].resources, 'settled');
  noWrites(h, before);
});

test('local review options: original return and resubmit invalidates the old round, and current confirmed plan remains required', async (t) => {
  const h = await reviewHost(t, { reviewers: ['qa', 'qa-two', 'outside'] });
  await h.begin('qa');
  const fixed = h.fixed();
  await h.seal(fixed);
  ok(await h.submit(fixed));
  ok(await h.cleanup());
  const old = query(h);
  ok(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'return'),
      roundId: old.roundId,
      artifactVersionId: old.artifactVersionId,
      action: 'request-changes',
      comment: 'Revise the fixed artifact.',
    }),
  );
  no(await options(h, old), 'review-target-stale');
  ok(
    await h.service.submit(caller(), {
      ...h.human('produce', 'resubmit'),
      text: 'Revised fixed artifact.',
    }),
  );
  const before = facts(h);
  h.resetCounts();
  no(await options(h, old), 'review-target-stale');
  const current = ok(await options(h));
  assert.notEqual(current.target.artifactVersionId, old.artifactVersionId);
  assert.deepEqual(current.attempts, []);
  assert.equal(current.expectedReviewVersion, readExecutionReviewState(h.read()).version);
  assert(current.expectedReviewVersion > 0);
  assert.equal(
    current.reviewers.every((item) => item.canStart),
    true,
  );
  h.setWorkbench((state) => ({
    ...state,
    appliedPlans: [
      ...state.appliedPlans,
      { ...state.appliedPlans[0], id: 'newer-plan', revision: state.appliedPlans[0].revision + 1 },
    ],
  }));
  no(await options(h), 'review-target-stale');
  noWrites(h, before);
});

test('local review options: cold reopen preserves original target/attempt metadata and durable bytes exactly', async (t) => {
  const h = await host(t);
  await prepared(h);
  const target = query(h),
    initial = ok(await options(h));
  await h.close();
  const disk = await businessHashes(h.root),
    reopened = await open(h.root, { seed: false, workbench: h.snapshot });
  try {
    reopened.resetCounts();
    const before = facts(reopened);
    assert.deepEqual(ok(await options(reopened, target)), initial);
    noWrites(reopened, before);
  } finally {
    await reopened.close();
  }
  assert.deepEqual(await businessHashes(h.root), disk);
});

test('local review options DTO: startability and exact scope bindings cannot acquire extra authority fields', async (t) => {
  const h = await host(t),
    value = ok(await options(h));
  assert.equal(
    localReviewOptionsSchema.safeParse({ ...value, drive: { id: 'not-a-grant' } }).success,
    false,
  );
  const inconsistent = structuredClone(value);
  inconsistent.reviewers[0].canStart = false;
  assert.equal(localReviewOptionsSchema.safeParse(inconsistent).success, false);
  const reason = structuredClone(value);
  reason.reviewers[0].unavailableReason = 'arbitrary-model-error';
  assert.equal(localReviewOptionsSchema.safeParse(reason).success, false);
  const duplicate = structuredClone(value);
  duplicate.reviewers.push(duplicate.reviewers[0]);
  assert.equal(localReviewOptionsSchema.safeParse(duplicate).success, false);
});
