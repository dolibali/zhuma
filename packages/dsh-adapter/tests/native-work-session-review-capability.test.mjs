/** Original C capability/routing with explicit Host authority and runtime ports.
 * Actual SDK admission and zero-model rejection are covered separately. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NativeSessionPurpose,
  invokeNativeWorkGrantAssertion,
} from '../dist/native-work-session-purpose.js';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { context, binding } from './native-work-session-review-fixture.mjs';

function harness() {
  const original = Object.freeze({}),
    controller = new AbortController(),
    value = context();
  const purpose = new NativeSessionPurpose({
    authorize(candidate) {
      if (candidate !== original) throw Error('not the genuine Host original');
      return {
        scope: { ...value.scope, review: value.review },
        selection: binding().selection,
        signal: controller.signal,
      };
    },
    readTarget() {
      throw Error('unused');
    },
    unavailableRequired() {
      return [];
    },
  });
  const grant = purpose.reviewGrant(original),
    records = new Map(),
    calls = [];
  const runtime = {
    async connect() {
      calls.push('connect');
    },
    send() {
      calls.push('send');
    },
    async flush() {},
  };
  const storage = {
    read: (key) => records.get(key),
    async write(key, value) {
      calls.push('write');
      records.set(key, value);
    },
  };
  const service = new NativeWorkSessionService(storage, runtime);
  return { purpose, grant, controller, calls, records, service };
}

const copies = {
  shallow: (grant) => ({ ...grant }),
  'deep scope': (grant) => ({ ...grant, scope: structuredClone(grant.scope) }),
  'scope only': (grant) => ({
    scope: grant.scope,
    signal: new AbortController().signal,
    assertCurrent() {},
  }),
  'signal only': (grant) => ({
    scope: structuredClone(grant.scope),
    signal: grant.signal,
    assertCurrent() {},
  }),
  'assertion only': (grant) => ({
    scope: structuredClone(grant.scope),
    signal: new AbortController().signal,
    assertCurrent: grant.assertCurrent,
  }),
  'bound assertion': (grant) => ({
    scope: structuredClone(grant.scope),
    signal: new AbortController().signal,
    assertCurrent: grant.assertCurrent.bind(grant),
  }),
  'forwarded assertion': (grant) => ({
    scope: structuredClone(grant.scope),
    signal: new AbortController().signal,
    assertCurrent(action) {
      grant.assertCurrent(action);
    },
  }),
};
for (const [name, copy] of Object.entries(copies))
  test(`review capability contract: ${name} cannot write an author binding or invoke its factory`, async () => {
    const h = harness();
    await assert.rejects(
      async () =>
        h.service.send(copy(h.grant), {
          requestId: 'copy',
          text: 'Must not execute.',
          mode: 'followup',
          selection: binding().selection,
        }),
      { code: 'review-authority-denied' },
    );
    assert.deepEqual(h.calls, []);
    assert.equal(h.records.size, 0);
  });

test('review capability contract: assertion receiver is exact and provenance is restored after a failed nested call', () => {
  const h = harness(),
    copied = { ...h.grant };
  assert.throws(() => copied.assertCurrent('send'), { code: 'review-authority-denied' });
  assert.throws(() => invokeNativeWorkGrantAssertion(copies['bound assertion'](h.grant), 'send'), {
    code: 'review-authority-denied',
  });
  invokeNativeWorkGrantAssertion(h.grant, 'send');
  assert.equal(h.purpose.context(h.grant.scope).review.principal.reviewerRef.id, 'expert');
});

test('review capability contract: the projected signal revokes promptly without branding a shared original Host signal as review', async () => {
  const h = harness();
  assert.notEqual(h.grant.signal, h.controller.signal);
  const author = {
    scope: { ...h.grant.scope, runId: 'author-run', segmentId: 'author-segment' },
    signal: h.controller.signal,
    assertCurrent() {},
  };
  const result = await h.service.send(author, {
    requestId: 'author',
    text: 'Original author compatibility.',
    mode: 'followup',
    selection: binding().selection,
  });
  assert.equal(result.status, 'received');
  assert.ok(h.calls.includes('send'));
  h.controller.abort();
  assert.equal(h.grant.signal.aborted, true);
});
