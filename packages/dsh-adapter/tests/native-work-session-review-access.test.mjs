import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeSessionPurpose } from '../dist/native-work-session-purpose.js';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { context, binding } from './native-work-session-review-fixture.mjs';
import { nativeReviewSessionKey } from '../dist/native-work-session-review-contract.js';

// Original C identity/service routing; Host authorization and storage are
// explicit contracts. This is not SDK, member authentication or a ballot.
function harness() {
  const original = Object.freeze({}),
    source = new AbortController(),
    value = context(),
    actions = [],
    records = new Map();
  let request = original,
    selection = binding().selection,
    onRead = () => {};
  const ports = {
    authorize(candidate, action) {
      actions.push(action);
      assert.equal(candidate, request, 'the current original request must match');
      return { scope: { ...value.scope, review: value.review }, selection, signal: source.signal };
    },
    readTarget() {
      throw Error('Unused contract target reader.');
    },
    unavailableRequired: () => [],
  };
  const purpose = new NativeSessionPurpose(ports),
    grant = purpose.reviewGrant(original),
    storage = { read: () => undefined, async write() {} },
    runtime = {};
  const service = new NativeWorkSessionService(storage, runtime, {
    purpose,
    read(key) {
      const value = structuredClone(records.get(key));
      onRead();
      return value;
    },
    async write() {},
    async enable() {},
  });
  actions.length = 0;
  return {
    original,
    source,
    actions,
    grant,
    purpose,
    ports,
    service,
    records,
    onRead: (callback) => (onRead = callback),
    changeSelection: () => (selection = { ...selection, configurationId: 'changed-config' }),
    changeRequest: () => (request = Object.freeze({})),
  };
}

test('review access contract: one Service metadata entry keeps send and open fresh without repeating original/selection qualification', () => {
  const h = harness(),
    access = h.service.reviewAccess(h.grant);
  assert.equal(access.original, h.original);
  assert.deepEqual(access.selection, binding().selection);
  assert.equal(Object.isFrozen(access.selection), true);
  assert.deepEqual(h.actions, ['send', 'open']);
  h.actions.length = 0;
  assert.equal(h.purpose.access(h.grant).original, h.original);
  assert.deepEqual(h.actions, ['open']);
  assert.throws(() => (access.selection.model = 'must-not-mutate'));
});

test('review access contract: the same fresh metadata entry returns an isolated binding and refuses storage-side revocation', () => {
  const h = harness();
  const row = { schemaVersion: 3, role: 'review', context: context(), binding: binding() };
  h.records.set(nativeReviewSessionKey(row.context), row);
  const access = h.service.reviewAccess(h.grant);
  assert.deepEqual(access.binding, row.binding);
  access.binding.receipts.push({ mustNotReachStorage: true });
  assert.deepEqual(row.binding.receipts, []);
  h.onRead(() => h.source.abort());
  assert.throws(() => h.service.reviewAccess(h.grant));
});

test('review access contract: a selection changed by the storage callback cannot reuse the earlier send check', () => {
  const h = harness();
  h.onRead(h.changeSelection);
  assert.throws(() => h.service.reviewAccess(h.grant), { code: 'review-target-changed' });
});

test('review access contract: copies and another Service fail original ownership before any Host action or forged field getter', () => {
  const h = harness(),
    other = harness();
  for (const forged of [
    { ...h.grant },
    { ...h.grant, scope: structuredClone(h.grant.scope) },
    undefined,
    {
      get scope() {
        throw Error('A forged field must not be inspected.');
      },
    },
  ]) {
    assert.throws(() => h.purpose.access(forged), { code: 'review-authority-denied' });
    assert.throws(() => h.service.reviewAccess(forged), { code: 'review-authority-denied' });
  }
  assert.throws(() => other.service.reviewAccess(h.grant), { code: 'review-authority-denied' });
  assert.deepEqual(h.actions, []);
  assert.deepEqual(other.actions, []);
});

for (const change of ['request', 'selection', 'port', 'revocation'])
  test(`review access contract: ${change} changes cannot reuse a previous metadata check`, () => {
    const h = harness();
    h.service.reviewAccess(h.grant);
    if (change === 'request') h.changeRequest();
    else if (change === 'selection') h.changeSelection();
    else if (change === 'port')
      h.ports.authorize = () => assert.fail('Replaced port must not run.');
    else h.source.abort();
    assert.throws(() => h.purpose.access(h.grant));
    assert.throws(() => h.service.reviewAccess(h.grant));
  });
