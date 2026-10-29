/** Provider-port contracts only; no existing profile or real credential is read. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemberLocalPrivateStore } from '../dist/host-member-local-credentials.js';
import {
  MemberLocalExecutionSecrets,
  MemberLocalSecretError,
} from '../dist/member-local-execution-secrets.js';
const slot = `zhuma.member-local.device.${'a'.repeat(64)}`;
function fixture() {
  const rows = new Map(),
    calls = [],
    chains = new Map();
  let provider = {
    async readRecord(key) {
      calls.push(['read', key]);
      return structuredClone(rows.get(key));
    },
    modifyRecord(key, mutate) {
      calls.push(['modify', key]);
      const next = (chains.get(key) ?? Promise.resolve()).then(async () => {
        const value = await mutate(structuredClone(rows.get(key)));
        if (value !== undefined) rows.set(key, structuredClone(value));
        return structuredClone(rows.get(key));
      });
      chains.set(
        key,
        next.catch(() => undefined),
      );
      return next;
    },
  };
  const lifetime = new AbortController();
  const ctx = {
    fiber: { assertActive() {} },
    get(name) {
      assert.equal(name, 'credentials');
      return provider;
    },
  };
  return {
    rows,
    calls,
    lifetime,
    ctx,
    replace: () => {
      provider = { ...provider };
    },
    store: createMemberLocalPrivateStore(ctx, lifetime.signal),
  };
}
test('private adapter confines keys to original credential records and uses its atomic update', async () => {
  const h = fixture();
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.store.read('provider/model-key'), { code: 'invalid' });
  assert.equal(h.calls.length, 0);
  const stored = await h.store.modify(slot, () => ({ version: 1 }));
  assert.deepEqual(stored, { version: 1 });
  assert.deepEqual(h.calls, [['modify', `zhuma-workbench/member-local-device-${'a'.repeat(64)}`]]);
  assert.deepEqual(await h.store.read(slot), stored);
  h.rows.set(h.calls[0][1], { kind: 'api-key', key: 'synthetic-unrelated' });
  await assert.rejects(h.store.read(slot), { code: 'unavailable' });
  await assert.rejects(
    h.store.modify(slot, () => assert.fail()),
    { code: 'unavailable' },
  );
});
test('two actual secret owners preserve one device/accept intent through the original atomic provider seam', async () => {
  const h = fixture();
  const one = new MemberLocalExecutionSecrets(h.store);
  const two = new MemberLocalExecutionSecrets(
    createMemberLocalPrivateStore(h.ctx, h.lifetime.signal),
  );
  const backend = '00000000-0000-4000-8000-000000000001';
  const devices = await Promise.all([one.device(backend, 'chen'), two.device(backend, 'chen')]);
  assert.equal(devices[0].deviceId, devices[1].deviceId);
  const request = '00000000-0000-4000-8000-000000000002';
  const intents = await Promise.all([
    one.accept(devices[0], request, 'b'.repeat(64)),
    two.accept(devices[1], request, 'b'.repeat(64)),
  ]);
  assert.deepEqual(intents[0].drive, intents[1].drive);
  assert.deepEqual(intents[0].cleanup, intents[1].cleanup);
  assert.equal(h.rows.size, 2);
});

test('private pointer adapter contract maps only the exact new slot and preserves provider CAS', async () => {
  const h = fixture();
  const digest = 'b'.repeat(64);
  const slot = `zhuma.member-local.run-pointer.${digest}`;
  for (const invalid of [
    `zhuma.member-local.pointer.${digest}`,
    `zhuma.member-local.run-pointer.${'B'.repeat(64)}`,
    `${slot}/child`,
    `${slot}\n`,
    `zhuma.member-local.run-pointer.${digest.slice(1)}`,
  ])
    await assert.rejects(h.store.read(invalid), { code: 'invalid' });
  assert.equal(h.calls.length, 0);
  const value = {
    version: 1,
    scopeFingerprint: 'c'.repeat(64),
    requestId: crypto.randomUUID(),
    configurationId: 'synthetic-local',
    selectionFingerprint: 'd'.repeat(64),
  };
  const persist = (candidate) => (current) => {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(candidate))
      throw new MemberLocalSecretError('conflict');
    return current ?? candidate;
  };
  assert.deepEqual(await h.store.modify(slot, persist(value)), value);
  assert.deepEqual(await h.store.modify(slot, persist(value)), value);
  await assert.rejects(
    h.store.modify(slot, persist({ ...value, requestId: crypto.randomUUID() })),
    { code: 'conflict' },
  );
  assert.deepEqual(await h.store.read(slot), value);
  assert.ok(
    h.calls.every(([, key]) => key === `zhuma-workbench/member-local-run-pointer-${digest}`),
  );
  assert.equal(h.rows.size, 1);
});
test('provider replacement and disposal reject even a late provider read', async () => {
  for (const mode of ['replace', 'close']) {
    const pending = Promise.withResolvers();
    let provider = { readRecord: () => pending.promise };
    const lifetime = new AbortController();
    const store = createMemberLocalPrivateStore(
      { fiber: { assertActive() {} }, get: () => provider },
      lifetime.signal,
    );
    const read = store.read(slot);
    if (mode === 'replace') provider = { ...provider };
    else lifetime.abort();
    pending.resolve({ kind: 'grant', payload: { version: 1 } });
    await assert.rejects(read, { code: mode === 'close' ? 'cancelled' : 'unavailable' });
  }
});

test('scope proxy views of the same original SDK provider do not count as replacement', async () => {
  const { symbols } = await import('@deepseek-ai/cordis');
  const rows = new Map();
  const original = {
    async readRecord(key) {
      return rows.get(key);
    },
    async modifyRecord(key, update) {
      const next = await update(rows.get(key));
      if (next !== undefined) rows.set(key, next);
      return rows.get(key);
    },
  };
  const ctx = {
    fiber: { assertActive() {} },
    get() {
      return new Proxy(original, {
        get(target, key) {
          return key === symbols.original ? target : Reflect.get(target, key);
        },
      });
    },
  };
  assert.notEqual(ctx.get(), ctx.get());
  const store = createMemberLocalPrivateStore(ctx, new AbortController().signal);
  assert.deepEqual(await store.modify(slot, () => ({ synthetic: true })), { synthetic: true });
  assert.deepEqual(await store.read(slot), { synthetic: true });
});
