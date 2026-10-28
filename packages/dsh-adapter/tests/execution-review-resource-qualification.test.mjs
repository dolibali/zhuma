/** Passive original preparation/resource qualification contracts; no native/model proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewCompositionFacts } from './execution-review-composition-fixture.mjs';
import {
  withExecutionReviewResourceQualification,
  ExecutionRunResourceQualificationCloseError,
} from '../dist/execution-run-resource-qualification.js';
import { EXECUTION_RESOURCE_SOURCE_VERSION } from '../dist/execution-run-resource-snapshot.js';

function setup() {
  const f = reviewCompositionFacts(),
    life = new AbortController(),
    owner = new AbortController();
  const query = {
    requestId: 'passive-review',
    expectedReviewVersion: 0,
    target: f.scope.review.target,
    reviewerRef: { id: 'qa', version: f.scope.planId },
  };
  const preparation = { scope: f.scope, applied: f.applied, node: f.node };
  let released = 0,
    assertions = 0;
  const q = {
    preparation,
    catalog: { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, mcp: [] },
    signal: life.signal,
    assertCurrent() {
      assertions++;
      return undefined;
    },
    release() {
      released++;
      return undefined;
    },
  };
  const originalRequest = { headers: {} };
  const host = {
    signal: life.signal,
    async prepareReviewResourceCatalog(request, incoming, wait) {
      assert.equal(this, host);
      assert.equal(request, originalRequest);
      assert.equal(incoming, query);
      assert.equal(wait.aborted, false);
      return q;
    },
  };
  return {
    f,
    host,
    q,
    owner,
    query,
    input: { host, ownerSignal: owner.signal, originalRequest, query },
    released: () => released,
    assertions: () => assertions,
  };
}

test('review qualification: exact original getter receives request/query and returns copied frozen current metadata, released once', async () => {
  const h = setup();
  const result = await withExecutionReviewResourceQualification(h.input, async (verified) => {
    assert.notEqual(verified.preparation, h.q.preparation);
    assert.deepEqual(verified.preparation, h.q.preparation);
    assert(Object.isFrozen(verified.preparation.node));
    assert(Object.isFrozen(verified.catalog));
    assert.equal(verified.assertCurrent(), undefined);
    return 'metadata-only';
  });
  assert.equal(result, 'metadata-only');
  assert.equal(h.released(), 1);
  assert(h.assertions() >= 3);
});

for (const mutation of ['scope', 'preparation', 'catalog', 'getter', 'signal'])
  test(`review qualification: ${mutation} change fails closed and releases original metadata`, async () => {
    const h = setup();
    await assert.rejects(
      withExecutionReviewResourceQualification(h.input, async (verified) => {
        if (mutation === 'scope') h.q.preparation.scope.segmentId = 'changed';
        if (mutation === 'preparation') h.q.preparation = structuredClone(h.q.preparation);
        if (mutation === 'catalog') h.q.catalog.mcp.push({});
        if (mutation === 'getter') h.host.prepareReviewResourceCatalog = async () => h.q;
        if (mutation === 'signal') h.owner.abort();
        verified.assertCurrent();
      }),
    );
    assert.equal(h.released(), 1);
  });

test('review qualification: a late actual provider after cancellation is still released before the operation ends', async () => {
  const h = setup(),
    pending = Promise.withResolvers(),
    entered = Promise.withResolvers();
  h.host.prepareReviewResourceCatalog = async () => {
    entered.resolve();
    return pending.promise;
  };
  let ended = false;
  const operation = assert
    .rejects(
      withExecutionReviewResourceQualification(h.input, async () =>
        assert.fail('no authority after abort'),
      ),
    )
    .then(() => {
      ended = true;
    });
  await entered.promise;
  h.owner.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  assert.equal(h.released(), 0);
  pending.resolve(h.q);
  await operation;
  assert.equal(h.released(), 1);
});

test('review qualification: unsupported metadata is released and async assertion is joined before releasing', async () => {
  const h = setup(),
    pending = Promise.withResolvers(),
    entered = Promise.withResolvers();
  h.q.assertCurrent = () => {
    entered.resolve();
    return pending.promise;
  };
  const operation = assert.rejects(
    withExecutionReviewResourceQualification(h.input, async () =>
      assert.fail('async assertion is not authority'),
    ),
  );
  await entered.promise;
  assert.equal(h.released(), 0);
  pending.resolve();
  await operation;
  assert.equal(h.released(), 1);
  const invalid = setup();
  invalid.q.catalog = { sourceVersion: 'unsupported', mcp: [] };
  await assert.rejects(
    withExecutionReviewResourceQualification(invalid.input, async () => assert.fail()),
  );
  assert.equal(invalid.released(), 1);
});

test('review qualification: invalid release is retained as cleanup failure, even after successful work', async () => {
  const h = setup();
  h.q.release = () => Promise.resolve();
  await assert.rejects(
    withExecutionReviewResourceQualification(h.input, async () => 'data'),
    ExecutionRunResourceQualificationCloseError,
  );
});
