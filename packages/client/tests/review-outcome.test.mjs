/** Read-only Client codec/fence contracts, without Host or model authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeReviewApi } from '../dist/run/review-api.js';

const query = {
  spaceId: 'north',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  roundId: 'round',
  artifactVersionId: 'artifact',
};
const outcome = () => ({
  controllerMemberId: 'ann',
  target: { ...query, artifactFingerprint: 'a'.repeat(64) },
  nodeStatus: 'needs-revision',
  artifact: { id: 'artifact', version: 1, text: 'Fixed body', links: [], files: [] },
  round: {
    id: 'round',
    artifactVersionId: 'artifact',
    status: 'changes-requested',
    reviewerIds: ['expert'],
    ballots: [
      {
        reviewerId: 'expert',
        reviewerName: 'Frozen reviewer name',
        roundId: 'round',
        artifactVersionId: 'artifact',
        action: 'request-changes',
        comment: 'Specific correction',
      },
    ],
  },
  comments: [],
});
function harness(transform = (value) => value, revokeAfterRead = false) {
  const calls = [];
  let changed = false;
  const api = createNativeReviewApi(
    async (url, init) => {
      calls.push(url);
      if (url === '/zhuma-id/session')
        return Response.json({
          ok: true,
          accountId: changed ? 'other' : 'ann',
          principal: { kind: 'zhuma-member', memberId: changed ? 'other' : 'ann' },
          peerId: 'contract',
          spaces: [{ id: 'north', kind: 'team', name: 'Team' }],
        });
      assert.equal(url, '/api/zhuma-exec/review-outcome');
      assert.equal(init.method, 'POST');
      const wire = JSON.parse(init.body);
      assert.equal(wire.method, 'zhuma-exec/review-outcome');
      assert.deepEqual(wire.payload, query);
      assert.equal(JSON.stringify(wire.payload).includes('actorId'), false);
      if (revokeAfterRead) changed = true;
      return Response.json({
        type: 'server-response',
        rpcId: wire.rpcId,
        result: { ok: true, value: transform(outcome()) },
      });
    },
    'ann',
    { spaceId: 'north', isCurrent: () => true, onUnavailable() {} },
    () => {},
  );
  return { api, calls };
}

test('review outcome: exact fixed target and named body survive a closed round; no native calls', async () => {
  const h = harness();
  const value = await h.api.outcome(query, new AbortController().signal);
  assert.equal(value.round.ballots[0].comment, 'Specific correction');
  assert.equal(value.round.ballots[0].reviewerName, 'Frozen reviewer name');
  assert.deepEqual(h.calls, [
    '/zhuma-id/session',
    '/api/zhuma-exec/review-outcome',
    '/zhuma-id/session',
  ]);
});

test('review outcome: mismatched actor/space/round/artifact/ballot and revoked identity never render as current feedback', async () => {
  for (const transform of [
    (value) => ({ ...value, controllerMemberId: 'other' }),
    (value) => ({ ...value, target: { ...value.target, spaceId: 'other' } }),
    (value) => ({ ...value, round: { ...value.round, id: 'other' } }),
    (value) => ({ ...value, artifact: { ...value.artifact, id: 'other' } }),
    (value) => ({
      ...value,
      round: {
        ...value.round,
        ballots: value.round.ballots.map((ballot) => ({ ...ballot, artifactVersionId: 'other' })),
      },
    }),
  ])
    await assert.rejects(harness(transform).api.outcome(query, new AbortController().signal));
  const revoked = harness(undefined, true);
  await assert.rejects(
    revoked.api.outcome(query, new AbortController().signal),
    (error) => error.code === 'unauthenticated',
  );
});
