/** Cleanup authority and runtime are explicit port contracts. Real SDK and
 * new-process writer proof live in the separate review runtime spec. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeSessionPurpose } from '../dist/native-work-session-purpose.js';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import {
  nativeReviewSessionKey,
  nativeReviewScopeKey,
  nativeReviewRecordSchema,
} from '../dist/native-work-session-review-contract.js';
import { binding, context } from './native-work-session-review-fixture.mjs';

function harness(options = {}) {
  const value = context(),
    full = { ...value.scope, review: value.review },
    records = new Map(),
    originals = new WeakMap(),
    calls = [],
    forbidden = [];
  const purposes = [];
  const row = nativeReviewRecordSchema.parse({
    schemaVersion: 3,
    role: 'review',
    context: value,
    binding: binding(),
    readBudget: { attempts: 1, chargedBytes: 10 },
  });
  const key = nativeReviewSessionKey(value);
  records.set(key, row);
  const no = (name) => () => {
    forbidden.push(name);
    throw Error(`cleanup attempted ${name}`);
  };
  const ports = {
    authorize: no('drive'),
    readTarget: no('read'),
    unavailableRequired: no('catalog'),
    authorizeCleanup(original) {
      const issued = originals.get(original);
      if (!issued?.valid) throw Error('not the original cleanup capability');
      return structuredClone(issued.scope);
    },
    ...options.ports,
  };
  const runtime = {
    connect: no('factory'),
    migrationDrain() {
      throw Error('no contract cached drain');
    },
    async retire(id, signal, allowAbsent) {
      calls.push({ id, signal, allowAbsent });
      await options.beforeRetire?.();
      return { signal, basis: 'flushed-and-closed', assertCurrent() {} };
    },
  };
  const make = () => {
    const purpose = new NativeSessionPurpose(ports);
    purposes.push(purpose);
    return new NativeWorkSessionService(
      { read: no('author storage'), write: no('author write') },
      runtime,
      {
        purpose,
        read: (key) => structuredClone(records.get(key)),
        write: no('review write'),
        enable: no('marker write'),
      },
    );
  };
  const original = Object.freeze({});
  originals.set(original, { valid: true, scope: full });
  return {
    service: make(),
    make,
    original,
    ports,
    full,
    row,
    key,
    records,
    originals,
    calls,
    forbidden,
    purposes,
  };
}
const wait = () => new AbortController().signal;

test('review cleanup contract: a fresh owner reads the exact v3 row without drive/read/model qualification or writes', async () => {
  const h = harness(),
    before = JSON.stringify([...h.records]);
  const result = await h.service.retireReviewForCleanup(h.original, wait());
  assert.equal(result.status, 'retired');
  assert.equal(result.binding.nativeSessionId, h.row.binding.nativeSessionId);
  assert.equal(result.drain.basis, 'flushed-and-closed');
  result.drain.assertCurrent();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.forbidden, []);
  assert.equal(JSON.stringify([...h.records]), before);
});

test('review cleanup contract: generic cleanup cannot move a routed scope into another native owner', async () => {
  const h = harness(),
    cleanup = h.purposes[0].cleanupAuthority(h.original);
  await assert.rejects(h.make().retireForCleanup(cleanup, wait()), {
    code: 'review-authority-denied',
  });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.forbidden, []);
});

test('review cleanup contract: copied, missing and foreign-owner capabilities are rejected before native work', async () => {
  const h = harness();
  for (const value of [undefined, null, {}, { ...h.original }, { scope: h.full }])
    await assert.rejects(h.service.retireReviewForCleanup(value, wait()), {
      code: 'review-authority-denied',
    });
  assert.equal(h.calls.length, 0);
  await h.service.retireReviewForCleanup(h.original, wait());
  await assert.rejects(h.make().retireReviewForCleanup(h.original, wait()), {
    code: 'review-authority-denied',
  });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.forbidden, []);
});

for (const [name, method] of [
  ['missing', undefined],
  ['false', () => false],
  ['async', async () => ({})],
  ['async rejected', () => Promise.reject(Error('contract refusal'))],
  ['partial scope', () => ({ actorId: 'controller' })],
])
  test(`review cleanup contract: ${name} cleanup producer fails closed without other capabilities`, async () => {
    const h = harness({ ports: { authorizeCleanup: method } });
    await assert.rejects(h.service.retireReviewForCleanup(h.original, wait()), {
      code: 'review-authority-denied',
    });
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.forbidden, []);
  });

test('review cleanup contract: persisted target mismatch cannot become an absence proof or retire another binding', async () => {
  const h = harness(),
    wrong = structuredClone(h.row);
  wrong.context.review.target.artifactFingerprint = 'b'.repeat(64);
  h.records.set(h.key, wrong);
  await assert.rejects(h.service.retireReviewForCleanup(h.original, wait()), {
    code: 'scope-mismatch',
  });
  h.records.set(h.key, h.row);
  const scoped = nativeReviewScopeKey(h.row.context);
  h.records.set(scoped, wrong);
  await assert.rejects(h.service.retireReviewForCleanup(h.original, wait()), {
    code: 'scope-mismatch',
  });
  h.records.set(scoped, { schemaVersion: 3 });
  await assert.rejects(h.service.retireReviewForCleanup(h.original, wait()));
  assert.deepEqual(
    h.records.get(h.key),
    h.row,
    'an invalid scoped row cannot use or change legacy',
  );
  assert.deepEqual(h.calls, []);
});

test('review cleanup contract: authority/target changes during physical work reject the caller while owned drain still completes', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const h = harness({
    beforeRetire: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const retiring = h.service.retireReviewForCleanup(h.original, wait());
  await entered.promise;
  h.originals.get(h.original).scope.review.target.roundId = 'another-round';
  release.resolve();
  await assert.rejects(retiring, { code: 'unavailable' });
  await h.service.whenRetirementsIdle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false);
});

test('review cleanup contract: caller cancellation retains actual I/O ownership and method replacement cannot retarget a retry', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const h = harness({
    beforeRetire: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const waiting = new AbortController(),
    retiring = h.service.retireReviewForCleanup(h.original, waiting.signal);
  await entered.promise;
  waiting.abort();
  assert.deepEqual(await retiring, { status: 'pending' });
  assert.equal(h.calls[0].signal.aborted, false);
  let done = false;
  const drain = h.service.whenRetirementsIdle().then(() => (done = true));
  await new Promise(setImmediate);
  assert.equal(done, false);
  release.resolve();
  await drain;
  h.ports.authorizeCleanup = () => structuredClone(h.full);
  await assert.rejects(h.service.retireReviewForCleanup(h.original, wait()), {
    code: 'review-authority-denied',
  });
  assert.equal(h.calls.length, 1);
});
