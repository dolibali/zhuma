import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import { MemberLocalExecutionSecrets } from '../dist/member-local-execution-secrets.js';

// Synthetic private credentials owner. No actual user keys or session store
// is read; this does not prove A's private credential adapter or device login.
function fixture() {
  const rows = new Map();
  let queue = Promise.resolve(),
    fail = false;
  const store = {
    read: async (key) => structuredClone(rows.get(key)),
    modify(key, update) {
      const work = queue.then(() => {
        const next = update(structuredClone(rows.get(key)));
        rows.set(key, structuredClone(next));
        if (fail) throw Error('/private/KEY_CANARY');
        return structuredClone(next);
      });
      queue = work.catch(() => undefined);
      return work;
    },
  };
  return {
    rows,
    store,
    setFail: (value) => {
      fail = value;
    },
  };
}
test('member-local secrets: device keys persist privately and the signer uses actual Ed25519', async () => {
  const h = fixture(),
    owner = new MemberLocalExecutionSecrets(h.store),
    device = await owner.device('00000000-0000-4000-8000-000000000001', 'ann');
  const bytes = Buffer.from('exact canonical protocol bytes'),
    signature = device.sign(bytes);
  const publicKey = createPublicKey({
    key: Buffer.from(device.publicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(verify(null, bytes, publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(
    verify(null, Buffer.from('changed'), publicKey, Buffer.from(signature, 'base64url')),
    false,
  );
  const cold = await new MemberLocalExecutionSecrets(h.store).device(
    '00000000-0000-4000-8000-000000000001',
    'ann',
  );
  assert.equal(cold.deviceId, device.deviceId);
  assert.equal(cold.publicKey, device.publicKey);
  const raw = [...h.rows.values()][0];
  assert.equal(JSON.stringify(device).includes(raw.privateKey), false);
});
test('member-local secrets: accept secrets are durably fixed before use and replay after reopen without rotation', async () => {
  const h = fixture(),
    owner = new MemberLocalExecutionSecrets(h.store),
    device = await owner.device('00000000-0000-4000-8000-000000000001', 'ann');
  const original = await owner.accept(
    device,
    '00000000-0000-4000-8000-000000000003',
    'a'.repeat(64),
  );
  const bytes = original.withDriveSecret((secret) => Buffer.from(secret, 'base64url'));
  assert.equal(bytes.length, 32);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), original.drive.sha256);
  assert.notEqual(original.drive.sha256, original.cleanup.sha256);
  const coldOwner = new MemberLocalExecutionSecrets(h.store),
    cold = await coldOwner.device('00000000-0000-4000-8000-000000000001', 'ann');
  const replay = await coldOwner.accept(
    cold,
    '00000000-0000-4000-8000-000000000003',
    'a'.repeat(64),
  );
  assert.deepEqual(replay.drive, original.drive);
  assert.deepEqual(replay.cleanup, original.cleanup);
  assert.equal(
    replay.withDriveSecret((s) => s),
    original.withDriveSecret((s) => s),
  );
  assert.equal(JSON.stringify(original).includes(original.withDriveSecret((s) => s)), false);
  await assert.rejects(
    coldOwner.accept(cold, '00000000-0000-4000-8000-000000000003', 'b'.repeat(64)),
    { code: 'conflict' },
  );
});
test('member-local secrets: concurrent private owners retain one device and one intent', async () => {
  const h = fixture(),
    one = new MemberLocalExecutionSecrets(h.store),
    two = new MemberLocalExecutionSecrets(h.store);
  const [a, b] = await Promise.all([
    one.device('00000000-0000-4000-8000-000000000001', 'ann'),
    two.device('00000000-0000-4000-8000-000000000001', 'ann'),
  ]);
  assert.equal(a.deviceId, b.deviceId);
  const [x, y] = await Promise.all([
    one.accept(a, '00000000-0000-4000-8000-000000000003', 'a'.repeat(64)),
    two.accept(b, '00000000-0000-4000-8000-000000000003', 'a'.repeat(64)),
  ]);
  assert.deepEqual(x.drive, y.drive);
  assert.deepEqual(x.cleanup, y.cleanup);
  assert.equal(h.rows.size, 2);
  await assert.rejects(
    one.accept({ ...a }, '00000000-0000-4000-8000-000000000004', 'a'.repeat(64)),
    { code: 'invalid' },
  );
});
test('member-local secrets: backend/account switches cannot reuse a private device slot', async () => {
  const h = fixture(),
    owner = new MemberLocalExecutionSecrets(h.store);
  const a = await owner.device('00000000-0000-4000-8000-000000000001', 'ann'),
    b = await owner.device('00000000-0000-4000-8000-000000000002', 'ann'),
    c = await owner.device('00000000-0000-4000-8000-000000000001', 'bob');
  assert.notEqual(a.deviceId, b.deviceId);
  assert.notEqual(a.deviceId, c.deviceId);
});
test('member-local secrets: cold exact lookup never creates or rotates an accept intent', async () => {
  const h = fixture(),
    owner = new MemberLocalExecutionSecrets(h.store),
    backend = '00000000-0000-4000-8000-000000000001',
    request = '00000000-0000-4000-8000-000000000003',
    device = await owner.device(backend, 'ann');
  assert.equal(await owner.recoverAccept(device, request), undefined);
  assert.equal(h.rows.size, 1);
  const first = await owner.accept(device, request, 'a'.repeat(64)),
    before = structuredClone([...h.rows.values()]),
    cold = new MemberLocalExecutionSecrets(h.store),
    identity = await cold.device(backend, 'ann'),
    recovered = await cold.recoverAccept(identity, request);
  assert.deepEqual(recovered.drive, first.drive);
  assert.deepEqual(recovered.cleanup, first.cleanup);
  assert.equal(recovered.intentFingerprint, first.intentFingerprint);
  assert.deepEqual([...h.rows.values()], before);
  await assert.rejects(cold.recoverAccept({ ...identity }, request), { code: 'invalid' });
  await assert.rejects(cold.recoverAccept(identity, request, AbortSignal.abort()), {
    code: 'cancelled',
  });
  assert.deepEqual([...h.rows.values()], before);
});
test('member-local secrets: a failed durable reply does not leak a handle and reopening recovers the stored intent', async () => {
  const h = fixture(),
    owner = new MemberLocalExecutionSecrets(h.store),
    device = await owner.device('00000000-0000-4000-8000-000000000001', 'ann');
  h.setFail(true);
  await assert.rejects(
    owner.accept(device, '00000000-0000-4000-8000-000000000003', 'a'.repeat(64)),
    (error) => error.code === 'unavailable' && !String(error).includes('CANARY'),
  );
  const before = structuredClone([...h.rows.values()]);
  h.setFail(false);
  const coldOwner = new MemberLocalExecutionSecrets(h.store),
    cold = await coldOwner.device('00000000-0000-4000-8000-000000000001', 'ann');
  await coldOwner.accept(cold, '00000000-0000-4000-8000-000000000003', 'a'.repeat(64));
  assert.deepEqual([...h.rows.values()], before);
});
test('member-local secrets: cancellation after durable private storage never exposes a usable handle', async () => {
  const h = fixture(),
    controller = new AbortController();
  const store = {
    ...h.store,
    async modify(key, update) {
      const value = await h.store.modify(key, update);
      controller.abort();
      return value;
    },
  };
  const owner = new MemberLocalExecutionSecrets(store);
  await assert.rejects(
    owner.device('00000000-0000-4000-8000-000000000001', 'ann', controller.signal),
    { code: 'cancelled' },
  );
  assert.equal(h.rows.size, 1, 'the private durable record is retained for explicit recovery');
});
