/** Original Service/DSH JSON, fixed delivery and persisted ballots. Member,
 * native producer and review-cut ports are contracts; no model or GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPayload, reviewOutcomeQuerySchema, reviewOutcomeSchema } from '@zhuma/agent-core';
import { host } from './execution-review-service-fixture.mjs';
import { reviewHost, ok, no } from './remote-review-fixture.mjs';
import { caller, open } from './execution-service-run-fixture.mjs';
import { openResultContract, businessHashes } from './execution-native-result-service-fixture.mjs';
import { executionReviewArtifactFingerprint } from '../dist/execution-review-state.js';

const query = (h, round = h.read().rounds.at(-1)) => ({
  spaceId: 'north',
  ...h.locate(),
  roundId: round.id,
  artifactVersionId: round.artifactVersionId,
});
const read = (h, body = query(h), request = h.request) =>
  h.service.readReviewOutcome(request, body);
const facts = (h) =>
  canonicalPayload({
    global: h.domain.global.get(),
    nodes: [...h.domain.table('nodes').entries()],
  });
const noWrites = (h, before) => {
  assert.equal(facts(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
};
const vote = (h, action, comment) =>
  h.service.ballot(caller('outside'), {
    ...h.human('produce', `vote-${action}`),
    roundId: query(h).roundId,
    artifactVersionId: query(h).artifactVersionId,
    action,
    comment,
  });

for (const conclusion of ['approve', 'request-changes']) {
  test(`review outcome: actual persisted expert ${conclusion}, frozen name, full fixed content/comments and zero writes`, async (t) => {
    const h = await reviewHost(t);
    await h.begin();
    const fixed = h.fixed({ conclusion });
    await h.seal(fixed);
    ok(await h.submit(fixed));
    const row = h.read(),
      round = row.rounds[0],
      target = query(h);
    h.setWorkbench((state) => ({
      ...state,
      participants: state.participants.map((p) =>
        p.id === 'qa' ? { ...p, name: 'New live name', available: false } : p,
      ),
    }));
    h.resetCounts();
    const before = facts(h),
      disk = await businessHashes(h.root),
      calls = structuredClone(h.calls);
    const value = ok(await read(h, target));
    reviewOutcomeSchema.parse(value);
    assert.equal(value.controllerMemberId, 'chen');
    assert.deepEqual(value.target, {
      ...target,
      artifactFingerprint: executionReviewArtifactFingerprint(row.artifactVersions[0]),
    });
    assert.equal(value.round.status, conclusion === 'approve' ? 'approved' : 'changes-requested');
    assert.equal(value.nodeStatus, conclusion === 'approve' ? 'completed' : 'needs-revision');
    const { reviewerName, ...ballot } = value.round.ballots[0];
    assert.equal(
      reviewerName,
      h.readWorkbench().appliedPlans[0].participants.find((p) => p.id === 'qa').name,
    );
    assert.notEqual(reviewerName, 'New live name');
    assert.deepEqual(ballot, round.ballots[0]);
    assert.equal(value.artifact.text, row.artifactVersions[0].text);
    assert.deepEqual(value.comments, row.comments);
    assert(value.round.ballots[0].comment.includes(fixed.facts.content.rationale));
    no(await h.service.readLocalReviewOptions(h.request, target), 'review-target-stale');
    value.round.ballots[0].comment = 'caller mutation';
    value.artifact.text = 'caller mutation';
    value.comments.length = 0;
    assert.notEqual(ok(await read(h, target)).round.ballots[0].comment, 'caller mutation');
    assert.deepEqual(h.calls, calls);
    noWrites(h, before);
    assert.deepEqual(await businessHashes(h.root), disk);
  });
}

test('review outcome: expert assignee controller can read closed review without pretending to be the expert', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-review-outcome-expert-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await openResultContract(root);
  t.after(() => h.close());
  ok(await h.service.submitNativeFixedResult(h.request, h.submission(), h.opened.grant, h.ref));
  assert.equal(h.read().handoff.assignee.kind, 'expert');
  ok(await vote(h, 'request-changes', '请补充失败重试策略。'));
  h.resetCounts();
  const before = facts(h),
    value = ok(await read(h));
  assert.equal(value.controllerMemberId, 'chen');
  assert.equal(value.round.status, 'changes-requested');
  assert.equal(value.round.ballots[0].reviewerId, 'outside');
  assert.equal(value.round.ballots[0].comment, '请补充失败重试策略。');
  no(await h.service.revision(caller(), h.locate()), 'not-found');
  noWrites(h, before);
});

test('review outcome: old closed round and its real artifact stay readable after resubmission; mixed round/artifact is rejected', async (t) => {
  const h = await host(t, { reviewerIds: ['outside'] });
  const old = query(h);
  ok(await vote(h, 'request-changes', '补充旧版本说明。'));
  ok(
    await h.service.submit(caller(), {
      ...h.human('produce', 'revised'),
      text: 'Second fixed version.',
    }),
  );
  const current = query(h);
  assert.notEqual(current.roundId, old.roundId);
  h.resetCounts();
  const before = facts(h);
  const previous = ok(await read(h, old)),
    fresh = ok(await read(h, current));
  assert.equal(previous.artifact.version, 1);
  assert.equal(previous.round.status, 'changes-requested');
  assert.equal(previous.round.ballots[0].comment, '补充旧版本说明。');
  assert.equal(fresh.artifact.version, 2);
  assert.equal(fresh.artifact.text, 'Second fixed version.');
  assert.deepEqual(fresh.round.ballots, []);
  no(
    await read(h, { ...old, artifactVersionId: current.artifactVersionId }),
    'review-target-stale',
  );
  no(
    await read(h, { ...current, artifactVersionId: old.artifactVersionId }),
    'review-target-stale',
  );
  noWrites(h, before);
});

test('review outcome: fixed file metadata and links are copied, with no bytes, upload secrets or extra IO', async (t) => {
  const h = await host(t, {
    file: { name: 'review.txt', mediaType: 'text/plain', text: 'Private fixed bytes.' },
    links: ['https://example.com/fixed'],
  });
  const before = facts(h),
    disk = await businessHashes(h.root),
    value = ok(await read(h));
  assert.deepEqual(value.artifact.links, ['https://example.com/fixed']);
  assert.deepEqual(
    value.artifact.files,
    h.read().artifactVersions[0].files.map(({ id, mediaType, byteSize }) => ({
      id,
      mediaType,
      byteSize,
    })),
  );
  for (const field of [
    'checksum',
    'accessPolicyId',
    'uploadId',
    'nativeExecution',
    'nativeReview',
    'instructions',
    'configurationId',
    'drive',
    'cleanup',
  ])
    assert(!JSON.stringify(value).includes(`"${field}"`));
  assert(!JSON.stringify(value).includes('Private fixed bytes.'));
  noWrites(h, before);
  assert.deepEqual(await businessHashes(h.root), disk);
});

test('review outcome: exact strict scope rejects wrong target, missing keys and browser actor injection, with zero writes', async (t) => {
  const h = await host(t),
    target = query(h),
    before = facts(h);
  for (const patch of [
    { roundId: 'wrong' },
    { artifactVersionId: 'wrong' },
    { nodeId: 'parallel' },
    { taskId: 'wrong' },
    { planId: 'wrong' },
    { revision: 100 },
    { spaceId: 'wrong' },
    { actorId: 'chen' },
    { reviewerId: 'qa' },
    { artifactFingerprint: '0'.repeat(64) },
  ])
    no(await read(h, { ...target, ...patch }));
  for (const field of Object.keys(target)) {
    const incomplete = { ...target };
    delete incomplete[field];
    assert.equal(reviewOutcomeQuerySchema.safeParse(incomplete).success, false);
    no(await read(h, incomplete));
  }
  noWrites(h, before);
});

test('review outcome: current member, original controller, project-space, current plan and withdrawal remain required', async (t) => {
  const h = await host(t),
    target = query(h),
    before = facts(h),
    state = h.readWorkbench();
  const outsider = { headers: {} };
  h.members.set(outsider, 'outside');
  no(await read(h, target, outsider), 'review-not-controller');
  no(await read(h, target, { headers: {} }));
  h.setWorkbench((s) => ({
    ...s,
    participants: s.participants.map((p) => (p.id === 'chen' ? { ...p, available: false } : p)),
  }));
  no(await read(h));
  h.setWorkbench(() => state);
  h.setWorkbench((s) => ({
    ...s,
    tasks: s.tasks.map((task) => ({ ...task, ownerId: 'outside' })),
  }));
  no(await read(h));
  h.setWorkbench(() => state);
  h.setWorkbench((s) => ({
    ...s,
    appliedPlans: [...s.appliedPlans, { ...s.appliedPlans[0], id: 'new-plan', revision: 2 }],
  }));
  no(await read(h));
  h.setWorkbench(() => state);
  h.setWorkbench((s) => ({ ...s, appliedPlans: [] }));
  no(await read(h));
  h.setWorkbench(() => state);
  h.assertionResults.project = () => {
    throw Error('SPACE_WITHDRAWN');
  };
  no(await read(h));
  delete h.assertionResults.project;
  h.member.abort();
  no(await read(h));
  noWrites(h, before);
});

test('review outcome: a member revoked during the final host assertion receives no projected content', async (t) => {
  const h = await host(t),
    before = facts(h);
  let checks = 0;
  h.assertionResults.project = () => {
    if (++checks === 2) h.member.abort();
  };
  no(await read(h));
  assert.equal(checks, 2);
  noWrites(h, before);
});

test('review outcome: cold read has no repair or metadata write; DTO rejects mismatched fixed facts and authority fields', async (t) => {
  const h = await host(t, { reviewerIds: ['outside'] });
  ok(await vote(h, 'approve', '通过。'));
  const target = query(h),
    workbench = h.readWorkbench();
  await h.close();
  const cold = await open(h.root, { seed: false, workbench });
  t.after(() => cold.close());
  cold.resetCounts();
  const before = facts(cold),
    disk = await businessHashes(h.root),
    value = ok(await read(cold, target));
  for (const mutate of [
    (v) => {
      v.drive = {};
    },
    (v) => {
      v.artifact.id = 'different';
    },
    (v) => {
      v.round.id = 'different';
    },
    (v) => {
      v.round.ballots[0].roundId = 'different';
    },
    (v) => {
      v.round.ballots[0].artifactVersionId = 'different';
    },
    (v) => {
      v.round.ballots[0].reviewerId = 'unassigned';
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.equal(reviewOutcomeSchema.safeParse(invalid).success, false);
  }
  noWrites(cold, before);
  assert.deepEqual(await businessHashes(h.root), disk);
});
