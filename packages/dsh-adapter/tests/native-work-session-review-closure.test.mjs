import assert from 'node:assert/strict';
import test from 'node:test';
import { retainNativeReviewResources } from '../dist/native-work-session-review-closure.js';
import { reviewCompositionFacts } from './execution-review-composition-fixture.mjs';

// Explicit Host port contracts only; these are not real SDK/resource proofs.
function fixture(overrides = {}) {
  const authority = new AbortController(),
    local = new AbortController(),
    scope = reviewCompositionFacts().scope;
  let disposals = 0,
    drains = 0;
  const adopted = {
    scope,
    configurationId: 'same-original-configuration',
    signal: authority.signal,
    ready: Promise.resolve(),
    assertCurrent() {
      local.signal.throwIfAborted();
      return undefined;
    },
    async dispose() {
      disposals++;
      local.abort();
    },
    async drain() {
      drains++;
    },
    ...overrides,
  };
  return {
    authority,
    adopted,
    close: retainNativeReviewResources(adopted, scope, adopted.configurationId),
    counts: () => ({ disposals, drains }),
  };
}

test('review closure contract: local disposal differs from continuing authority and close joins the actual drain once', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const h = fixture({
    async drain() {
      entered.resolve();
      await release.promise;
    },
  });
  h.close.assertLive();
  const closing = h.close.close();
  assert.equal(h.close.close(), closing);
  await entered.promise;
  assert.throws(() => h.close.assertClosed());
  assert.throws(() => h.close.assertLive());
  h.close.assertAuthority();
  release.resolve();
  await closing;
  h.close.assertClosed();
  assert.equal(h.counts().disposals, 1);
});

test('review closure contract: an original failed disposal is sticky and still attempts the captured drain', async () => {
  let disposals = 0;
  const h = fixture({
    async dispose() {
      disposals++;
      throw Error('SYNTHETIC_CLOSE_REJECTED');
    },
  });
  const closing = h.close.close();
  await assert.rejects(closing);
  assert.equal(h.close.close(), closing);
  await assert.rejects(h.close.close());
  assert.equal(disposals, 1);
  assert.equal(h.counts().drains, 1);
  assert.throws(() => h.close.assertClosed());
});

for (const missing of ['dispose', 'drain'])
  test(`review closure contract: a malformed handle missing ${missing} never certifies empty resources`, async () => {
    const h = fixture({ [missing]: undefined });
    assert.throws(() => h.close.assertLive());
    await assert.rejects(h.close.close());
    assert.equal(h.counts()[missing === 'dispose' ? 'drains' : 'disposals'], 1);
    await assert.rejects(h.close.close());
    assert.equal(h.counts()[missing === 'dispose' ? 'drains' : 'disposals'], 1);
    assert.throws(() => h.close.assertClosed());
  });

test('review closure contract: failed shape access retains both available physical finalizers', async () => {
  const h = fixture();
  Object.defineProperty(h.adopted, 'ready', {
    get() {
      throw Error('SYNTHETIC_MALFORMED_READY');
    },
  });
  await assert.rejects(h.close.close());
  assert.deepEqual(h.counts(), { disposals: 1, drains: 1 });
});

test('review closure contract: revoked authority forbids a result but permits physical cleanup', async () => {
  const h = fixture();
  h.authority.abort();
  assert.throws(() => h.close.assertLive());
  assert.throws(() => h.close.assertAuthority());
  await h.close.close();
  h.close.assertClosed();
  h.adopted.drain = async () => {};
  assert.throws(() => h.close.assertClosed());
});
