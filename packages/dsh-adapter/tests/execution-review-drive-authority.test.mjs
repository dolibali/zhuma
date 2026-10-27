import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionReviewDriveAuthorities } from '../dist/execution-review-drive-authority.js';
import { reviewCompositionFacts } from './execution-review-composition-fixture.mjs';

// Explicit member/configuration contracts only, never real login/SDK/model proof.
function owner() {
  const { scope } = reviewCompositionFacts();
  const original = {},
    member = new AbortController(),
    lifetime = new AbortController();
  const selection = {
    provider: 'contract',
    model: 'review',
    maxTokens: 1000,
    configurationId: 'frozen-review',
  };
  const {
    actorId: _actor,
    generation: _generation,
    segmentId: _segment,
    review: _review,
    ...locator
  } = scope;
  const listeners = new Set();
  const state = { phase: 'running', version: 1, opens: 0, releases: 0, releaseFault: false };
  const source = {
    signal: lifetime.signal,
    async memberLease(request) {
      state.opens++;
      if (request !== original) throw Error('CONTRACT_MEMBER_REFUSAL');
      return {
        memberId: 'chen',
        expiresAt: Date.now() + 60_000,
        signal: member.signal,
        assertCurrent(spaceId) {
          assert.equal(spaceId, 'north');
          assert.equal(member.signal.aborted, false);
        },
        release() {
          state.releases++;
          if (state.releaseFault) throw Error('CONTRACT_RELEASE_FAILURE');
        },
      };
    },
    resolve() {
      return { scope, selection };
    },
    assertCurrent(current, selected) {
      assert.deepEqual(current, scope);
      assert.deepEqual(selected, selection);
      assert.equal(state.phase, 'running');
      return undefined;
    },
    assertCleanup(current, selected) {
      assert.deepEqual(current, scope);
      assert.deepEqual(selected, selection);
      return undefined;
    },
    assertCleanupAfterCommit() {
      assert(['completed', 'failed', 'cancelled', 'stopping'].includes(state.phase));
      return undefined;
    },
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  return {
    manager: new ExecutionReviewDriveAuthorities(source),
    source,
    original,
    member,
    lifetime,
    scope,
    selection,
    locator,
    state,
    changed() {
      for (const callback of listeners) callback();
    },
  };
}

test('review drive issuer: only a new genuine member request produces a fixed drive object; clone/JSON/self-check/read shapes do not authorize', async () => {
  const f = owner(),
    live = await f.manager.open(f.original, f.locator);
  try {
    assert.equal(live.grant.purpose, 'independent-review-drive');
    assert.equal(live.grant.assertCurrent('send'), undefined);
    assert(Object.isFrozen(live.grant.scope.review));
    for (const forged of [
      JSON.parse(JSON.stringify(live.grant)),
      { ...live.grant },
      {
        purpose: 'review-target',
        scope: f.scope,
        signal: new AbortController().signal,
        assertCurrent() {},
      },
    ])
      assert.throws(() => f.manager.assertGrant(forged, 'send'), {
        code: 'review-authority-denied',
      });
    await assert.rejects(() => f.manager.open(live.grant, f.locator), {
      code: 'review-authority-denied',
    });
    assert.throws(() => live.grant.assertCurrent('cleanup'), { code: 'review-authority-denied' });
    assert.throws(() => live.grant.assertCurrent.call({ ...live.grant }, 'send'), {
      code: 'review-authority-denied',
    });
  } finally {
    live.dispose();
  }
});

test('review drive issuer: another manager cannot accept the original drive or cleanup object', async () => {
  const a = owner(),
    b = owner(),
    live = await a.manager.open(a.original, a.locator);
  try {
    assert.throws(() => b.manager.assertGrant(live.grant, 'send'), {
      code: 'review-authority-denied',
    });
    assert.throws(() => b.manager.assertCleanup(live.cleanup), { code: 'review-authority-denied' });
    assert.throws(() => a.manager.assertCleanup({ ...live.cleanup }), {
      code: 'review-authority-denied',
    });
  } finally {
    live.dispose();
  }
});

test('review drive issuer: ordinary event versions do not revoke fixed binding; a changed selection aborts immediately', async () => {
  const f = owner(),
    live = await f.manager.open(f.original, f.locator);
  f.state.version++;
  f.changed();
  assert.equal(live.grant.signal.aborted, false);
  assert.equal(live.grant.assertCurrent('follow'), undefined);
  f.selection.model = 'different-current-model';
  f.changed();
  assert.equal(live.grant.signal.aborted, true);
  assert.throws(() => f.manager.assertGrant(live.grant, 'send'), {
    code: 'review-authority-denied',
  });
  assert.equal(f.state.releases, 1);
});

test('review drive issuer: member revocation closes driving but genuine exact-scope cleanup remains cleanup-only', async () => {
  const f = owner(),
    live = await f.manager.open(f.original, f.locator);
  f.member.abort();
  assert.equal(live.grant.signal.aborted, true);
  assert.throws(() => live.grant.assertCurrent('send'), { code: 'review-authority-denied' });
  assert.equal(f.manager.assertCleanup(live.cleanup), undefined);
  assert.equal(live.cleanup.assertCurrent('cleanup'), undefined);
  assert.throws(() => live.cleanup.assertCurrent('failed'), { code: 'review-authority-denied' });
  f.scope.segmentId = 'replaced-segment';
  assert.throws(() => f.manager.assertCleanup(live.cleanup), { code: 'review-authority-denied' });
});

test('review drive issuer: inherited release poisoning immediately aborts peer drives and refuses new issuance', async () => {
  const f = owner(),
    first = await f.manager.open(f.original, f.locator),
    second = await f.manager.open(f.original, f.locator);
  f.state.releaseFault = true;
  first.dispose();
  assert.equal(first.grant.signal.aborted, true);
  assert.equal(second.grant.signal.aborted, true);
  f.state.releaseFault = false;
  await assert.rejects(() => f.manager.open(f.original, f.locator), {
    code: 'review-authority-denied',
  });
});

test('review cleanup issuer: a fresh original manager reconstructs terminal-only cleanup without an old drive or member session', async () => {
  const f = owner();
  assert.throws(() => f.manager.cleanupAfterCommit(f.scope), { code: 'review-authority-denied' });
  f.state.phase = 'completed';
  f.member.abort();
  const fresh = new ExecutionReviewDriveAuthorities(f.source);
  const authority = fresh.cleanupAfterCommit(f.scope);
  assert.equal(f.state.opens, 0, 'cleanup does not reopen a model or reuse a revoked cookie');
  assert.equal(fresh.assertCleanup(authority), undefined);
  assert(Object.isFrozen(authority.scope.review.target));
  assert.throws(() => f.manager.assertCleanup(authority), { code: 'review-authority-denied' });
  assert.throws(() => fresh.assertCleanup(JSON.parse(JSON.stringify(authority))), {
    code: 'review-authority-denied',
  });
  assert.throws(() => authority.assertCurrent('send'), { code: 'review-authority-denied' });
  assert.throws(() => fresh.assertGrant(authority, 'send'), { code: 'review-authority-denied' });
});
