import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { boot, grant, scope, selection } from './native-work-session-fixture.mjs';
import { nativeWorkSessionKey } from '../dist/native-work-session-record.js';
import { nativeWorkSessionStorageKey } from '../dist/native-work-session-storage.js';

// Real original DSH domain/JSON and read-only session service. Grants and
// verified backend identities are contracts; no HTTP/device/Agent proof here.
test('native backend namespace: identical remote object IDs never adopt another backend or legacy binding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-namespace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = (nativeSessionId) => ({
    schemaVersion: 1,
    scope: { ...scope },
    nativeSessionId,
    nativeAgentId: nativeSessionId,
    selection: { ...selection },
    receipts: [],
  });
  const key = nativeWorkSessionKey(scope),
    legacy = binding('legacy-native');
  let h = await boot(root);
  await h.service.storage.write(key, legacy);
  assert.equal(h.lookupNativeSession('ordinary-unbound'), null);
  assert.equal(h.lookupNativeSession('legacy-native').role, 'work');
  assert.equal(h.service.open(grant()).binding.nativeSessionId, 'legacy-native');
  await h.close();
  assert.throws(() => h.lookupNativeSession('legacy-native'), { code: 'unavailable' });
  h = await boot(root, undefined, undefined, {}, undefined, 'backend-a');
  assert.throws(() => h.lookupNativeSession('legacy-native'), { code: 'scope-mismatch' });
  assert.equal(h.service.open(grant()), undefined);
  await h.service.storage.write(key, binding('backend-a-native'));
  assert.equal(h.lookupNativeSession('backend-a-native').backendId, 'backend-a');
  assert.equal(h.service.open(grant()).binding.nativeSessionId, 'backend-a-native');
  assert.equal(h.adapter.requests.length, 0, 'navigation never starts a model');
  await h.close();
  h = await boot(root, undefined, undefined, {}, undefined, 'backend-b');
  assert.throws(() => h.lookupNativeSession('backend-a-native'), { code: 'scope-mismatch' });
  assert.equal(h.service.open(grant()), undefined);
  await h.service.storage.write(key, binding('backend-b-native'));
  await h.close();
  h = await boot(root, undefined, undefined, {}, undefined, 'backend-a');
  assert.equal(h.service.open(grant()).binding.nativeSessionId, 'backend-a-native');
  await h.close();
  h = await boot(root);
  assert.deepEqual(
    h.service.open(grant()).binding,
    legacy,
    'the default key and old record bytes remain readable',
  );
  assert.equal(h.adapter.requests.length, 0);
  await h.close();
});

test('native backend namespace: no namespace preserves exact old keys; invalid identifiers fail closed', () => {
  const key = nativeWorkSessionKey(scope);
  assert.equal(nativeWorkSessionStorageKey(key), key);
  assert.notEqual(
    nativeWorkSessionStorageKey(key, 'backend-a'),
    nativeWorkSessionStorageKey(key, 'backend-b'),
  );
  for (const backend of ['', 'https://unverified-host.test', 'bad\nidentity', '../path'])
    assert.throws(() => nativeWorkSessionStorageKey(key, backend), { code: 'invalid-request' });
});
