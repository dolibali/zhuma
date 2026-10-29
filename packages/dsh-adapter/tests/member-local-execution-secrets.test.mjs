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
        // Original SDK modifyRecord(undefined) preserves the current record.
        const current = structuredClone(rows.get(key));
        const next = update(current) ?? current;
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
test('member-local pointer contract: fixed per-scope CAS survives reopen and history performs two exact reads with no write', async () => {
  const h = fixture(),
    owner = new MemberLocalExecutionSecrets(h.store),
    backendId = '00000000-0000-4000-8000-000000000001',
    device = await owner.device(backendId, 'ann'),
    intent = await owner.accept(device, '00000000-0000-4000-8000-000000000003', 'a'.repeat(64));
  const scope = {
    backendId,
    actorId: 'ann',
    spaceId: 'space',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
  };
  await Promise.all(
    Array.from({ length: 8 }, () =>
      owner.rememberRun(device, intent, scope, 'config', 'b'.repeat(64)),
    ),
  );
  const pointers = [...h.rows].filter(([key]) => key.includes('.run-pointer.'));
  assert.equal(pointers.length, 1);
  assert(Buffer.byteLength(JSON.stringify(pointers[0][1])) <= 1024);
  assert(!JSON.stringify(pointers[0][1]).includes(intent.withDriveSecret((value) => value)));
  const cold = new MemberLocalExecutionSecrets(h.store),
    coldDevice = await cold.device(backendId, 'ann');
  const rows = structuredClone([...h.rows]),
    read = h.store.read,
    modify = h.store.modify,
    keys = [];
  h.store.read = (key) => {
    keys.push(key);
    return read(key);
  };
  h.store.modify = () => assert.fail('history pointer cannot write');
  const recovered = await cold.historyIntent(coldDevice, scope);
  assert.equal(recovered.intent.requestId, intent.requestId);
  assert.equal(recovered.configurationId, 'config');
  assert.equal(keys.length, 2);
  assert(keys[0].includes('.run-pointer.'));
  assert(keys[1].includes('.accept.'));
  assert.equal(await cold.historyIntent(coldDevice, { ...scope, runId: 'missing' }), undefined);
  assert.deepEqual([...h.rows], rows);
  h.store.modify = modify;
  await assert.rejects(
    cold.rememberRun(coldDevice, recovered.intent, scope, 'changed-config', 'b'.repeat(64)),
    { code: 'conflict' },
  );
  assert.deepEqual([...h.rows], rows);
});
test('member-local pointer contract: a copied secret handle or invalid pointer cannot acquire a locator', async () => {
  const h = fixture(),
    owner = new MemberLocalExecutionSecrets(h.store),
    backendId = '00000000-0000-4000-8000-000000000001',
    device = await owner.device(backendId, 'ann'),
    intent = await owner.accept(device, '00000000-0000-4000-8000-000000000003', 'a'.repeat(64));
  const scope = {
    backendId,
    actorId: 'ann',
    spaceId: 'space',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
  };
  await assert.rejects(owner.rememberRun(device, { ...intent }, scope, 'config', 'b'.repeat(64)), {
    code: 'invalid',
  });
  await assert.rejects(owner.rememberRun(device, intent, scope, 'x'.repeat(201), 'b'.repeat(64)), {
    code: 'unavailable',
  });
  assert.equal(h.rows.size, 2);
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

for (const kind of ['work', 'review'])
  test(`member-local pending workflow locator contract: ${kind} survives lost ACK, never overwrites unknown, and clears only after original scope pointer`, async () => {
    const h = fixture(),
      owner = new MemberLocalExecutionSecrets(h.store),
      backendId = '00000000-0000-4000-8000-000000000001',
      device = await owner.device(backendId, 'ann'),
      requestId = '00000000-0000-4000-8000-000000000003',
      target = { spaceId: 'team', taskId: 'task', planId: 'plan', revision: 1, nodeId: 'node' },
      workflow = { intentId: '00000000-0000-4000-8000-000000000004', generation: 1 },
      reviewerRef = { id: 'expert', version: 'plan', digest: 'b'.repeat(64) },
      candidate =
        kind === 'work'
          ? {
              kind,
              target,
              workflow,
              expectedNodeVersion: 1,
              expectedRunVersion: 0,
              executor: { kind: 'builtin' },
              mode: 'begin',
              repairIndex: 0,
            }
          : {
              kind,
              target: {
                ...target,
                roundId: 'round',
                artifactVersionId: 'artifact',
                artifactFingerprint: 'c'.repeat(64),
              },
              workflow,
              expectedReviewVersion: 1,
              reviewerRef,
            };
    const intent = await owner.accept(device, requestId, 'a'.repeat(64));
    await owner.rememberWorkflowAccept(device, requestId, candidate);
    const coldOwner = new MemberLocalExecutionSecrets(h.store),
      cold = await coldOwner.device(backendId, 'ann');
    const pointer = await coldOwner.pendingWorkflowAccept(cold, target, workflow);
    assert.equal(pointer.requestId, requestId);
    assert.equal(pointer.intentFingerprint, intent.intentFingerprint);
    assert.deepEqual(pointer.candidate, candidate);
    assert(!JSON.stringify(pointer).includes(intent.withDriveSecret((s) => s)));
    const scope =
      kind === 'work'
        ? {
            ...target,
            backendId,
            actorId: 'ann',
            runId: 'run',
            generation: 1,
            segmentId: 'segment',
          }
        : {
            ...target,
            backendId,
            actorId: 'ann',
            runId: 'review-run',
            generation: 1,
            segmentId: 'segment',
            review: {
              target: candidate.target,
              principal: { kind: 'expert', controllerMemberId: 'ann', reviewerRef },
            },
          };
    await assert.rejects(coldOwner.forgetWorkflowAccept(cold, candidate, scope), {
      code: 'conflict',
    });
    await assert.rejects(
      coldOwner.pendingWorkflowAccept(cold, target, { ...workflow, generation: 2 }),
      { code: 'conflict' },
    );
    const nextId = '00000000-0000-4000-8000-000000000005';
    await coldOwner.accept(cold, nextId, 'd'.repeat(64));
    await assert.rejects(coldOwner.rememberWorkflowAccept(cold, nextId, candidate), {
      code: 'conflict',
    });
    assert.equal(
      (await coldOwner.pendingWorkflowAccept(cold, target, workflow)).requestId,
      requestId,
    );
    const oldIntent = await coldOwner.recoverAccept(cold, requestId);
    if (kind === 'work')
      await coldOwner.rememberRun(cold, oldIntent, scope, 'config', 'e'.repeat(64));
    else await coldOwner.rememberReviewRun(cold, oldIntent, scope, 'config', 'e'.repeat(64));
    await coldOwner.forgetWorkflowAccept(cold, candidate, scope);
    assert.equal(await coldOwner.pendingWorkflowAccept(cold, target, workflow), undefined);
    const reopened = new MemberLocalExecutionSecrets(h.store),
      reopenedDevice = await reopened.device(backendId, 'ann');
    assert.equal(await reopened.pendingWorkflowAcceptForDevice(reopenedDevice), undefined);
    await reopened.rememberWorkflowAccept(reopenedDevice, nextId, candidate);
    assert.equal((await reopened.pendingWorkflowAcceptForDevice(reopenedDevice)).requestId, nextId);
    assert(
      await coldOwner.recoverAccept(cold, requestId),
      'Original permit record is never deleted',
    );
  });
