import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MemberLocalExecutionProtocol } from '../dist/member-local-execution-protocol.js';
import { MemberLocalExecutionSecrets } from '../dist/member-local-execution-secrets.js';
import { fixture } from './member-local-execution-protocol-fixture.mjs';
import { REMOTE_RUN_OPERATIONS } from '@zhuma/agent-core';

test('member-local protocol contract: signs canonical requests; raw permits stay in exact scoped headers', async (t) => {
  const h = await fixture(t),
    owner = await h.open();
  t.after(() => owner.close());
  const prepared = await owner.prepareAccept(randomUUID(), h.input),
    run = await prepared.send();
  assert.deepEqual(run.composition, h.composition);
  assert.throws(() => {
    run.value.scope.runId = 'mutated';
  }, TypeError);
  assert.equal((await owner.status(run)).scope.runId, run.value.scope.runId);
  await owner.command(run, {
    operation: 'cleanup',
    payload: { observation: { kind: 'unknown', sequence: 1 } },
  });
  await assert.rejects(owner.status(structuredClone(run)), { code: 'local-mismatch' });
  h.changeScope();
  await assert.rejects(owner.status(run), { code: 'local-mismatch' });
  assert.equal(h.seen.filter(({ request }) => request.operation === 'status').length, 2);
});
test('member-local protocol contract: selected resources require the exact local adoption capability', async (t) => {
  const h = await fixture(t, { skill: true, omitResourceCapability: true }),
    owner = await h.open();
  t.after(() => owner.close());
  await assert.rejects((await owner.prepareAccept(randomUUID(), h.input)).send(), {
    code: 'local-mismatch',
  });
});
test('member-local history protocol: exact pointer/status reads never reconcile, generate tokens or obtain drive', async (t) => {
  const h = await fixture(t),
    owner = await h.open();
  t.after(() => owner.close());
  const run = await (await owner.prepareAccept(randomUUID(), h.input)).send();
  const durable = structuredClone([...h.rows]),
    cut = h.seen.length;
  const read = await owner.history(run.value.scope);
  assert.equal('composition' in read, false);
  assert.equal(
    read.value.authority,
    'drive',
    'backend status does not itself elevate the private read handle',
  );
  await assert.rejects(owner.command(read, { operation: 'renew', payload: {} }), {
    code: 'remote-recovery-required',
  });
  assert.throws(() => owner.assertStartHandle(read), { code: 'remote-recovery-required' });
  assert.deepEqual([...h.rows], durable);
  assert.deepEqual(
    h.seen.slice(cut).map((v) => v.request.operation),
    ['status'],
  );
  const unknown = { ...run.value.scope, runId: 'unknown-run' };
  await assert.rejects(owner.history(unknown), { code: 'remote-recovery-required' });
  assert.deepEqual([...h.rows], durable);
});
test('member-local history protocol: a failed pointer write after accept cannot yield a start handle', async (t) => {
  const h = await fixture(t),
    owner = await h.open();
  t.after(() => owner.close());
  const prepared = await owner.prepareAccept(randomUUID(), h.input);
  assert.equal(owner.canSwitchBackend(), true);
  h.failStore();
  await assert.rejects(prepared.send(), { code: 'unavailable' });
  assert.equal(owner.canSwitchBackend(), false, 'lost durable pointer is still an obligation');
  assert.equal(h.acceptCalls(), 1, 'the actual accepted Run remains an unknown obligation');
  assert.equal([...h.rows.keys()].filter((key) => key.includes('.run-pointer.')).length, 0);
  h.failStore(false);
  await prepared.send();
  assert.equal(owner.canSwitchBackend(), true, 'the same original intent is now durably qualified');
  assert.equal(h.acceptCalls(), 1, 'retrying the known pointer write does not re-accept over HTTP');
});
test('member-local protocol contract: lost accept ACK explicitly replays the same durable device and intent', async (t) => {
  const h = await fixture(t, { loseAccept: true }),
    owner = await h.open(),
    requestId = randomUUID(),
    prepared = await owner.prepareAccept(requestId, h.input);
  t.after(() => owner.close());
  await assert.rejects(prepared.send(), { code: 'unavailable' });
  const durable = structuredClone([...h.rows.values()]);
  await owner.close();
  const cold = await MemberLocalExecutionProtocol.open({
    ...h.protocolOptions,
    secrets: new MemberLocalExecutionSecrets(h.store),
  });
  t.after(() => cold.close());
  const replay = await cold.prepareAccept(requestId, h.input);
  h.input.model.model = 'changed-after-prepare';
  await replay.send();
  assert.deepEqual(
    [...h.rows.values()].filter((row) => row.privateKey || row.drive),
    durable,
  );
  assert.equal([...h.rows.keys()].filter((key) => key.includes('.run-pointer.')).length, 1);
  const requests = h.seen.filter(({ request }) => request.operation === 'accept');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].request.payload, requests[1].request.payload);
  assert.notEqual(requests[0].request.proof.nonce, requests[1].request.proof.nonce);
  assert.equal(requests[0].request.deviceId, requests[1].request.deviceId);
});
test('member-local protocol contract: actor mismatch and explicit backend errors cannot open a connection', async (t) => {
  const wrong = await fixture(t, { actorId: 'bob' });
  await assert.rejects(wrong.open(), { code: 'local-mismatch' });
  assert.equal(wrong.rows.size, 0);
  const denied = await fixture(t, { registerError: true });
  await assert.rejects(denied.open(), { code: 'remote-device-unavailable' });
  assert.equal(denied.rows.size, 1);
  assert.equal(denied.acceptCalls(), 0);
});
test('member-local protocol contract: another backend or invalid original composition never yields a local handle', async (t) => {
  for (const mutate of [
    (reply) => {
      reply.scope.backendId = randomUUID();
    },
    (reply) => {
      reply.scope.generation++;
    },
    (reply) => {
      reply.shared.composition = { payload: {} };
    },
    (reply) => {
      reply.shared.context = 'changed context';
    },
  ]) {
    const h = await fixture(t, { mutate }),
      owner = await h.open();
    t.after(() => owner.close());
    const prepared = await owner.prepareAccept(randomUUID(), h.input);
    await assert.rejects(prepared.send());
  }
});
test('member-local protocol contract: storage failure prevents accept and close fences prepared handles', async (t) => {
  const h = await fixture(t),
    owner = await h.open(),
    prepared = await owner.prepareAccept(randomUUID(), h.input);
  h.failStore();
  await assert.rejects(owner.prepareAccept(randomUUID(), h.input), { code: 'unavailable' });
  assert.equal(h.acceptCalls(), 0);
  await owner.close();
  await assert.rejects(prepared.send(), { code: 'local-closed' });
  assert.equal(h.acceptCalls(), 0);
});
test('member-local protocol contract: a backend may explicitly lack file/input operations without inventing support', async (t) => {
  const h = await fixture(t, {
      operations: REMOTE_RUN_OPERATIONS.filter(
        (op) =>
          !['input-list', 'input-read', 'publish-file', 'file-status', 'abandon-file'].includes(op),
      ),
    }),
    owner = await h.open();
  t.after(() => owner.close());
  const prepared = await owner.prepareAccept(randomUUID(), h.input),
    run = await prepared.send();
  await assert.rejects(owner.command(run, { operation: 'input-list', payload: {} }), {
    code: 'remote-protocol-unsupported',
  });
  assert.equal(
    h.seen.some(({ request }) => request.operation === 'input-list'),
    false,
  );
});
test('member-local protocol contract: exact cold reconcile is not accept or a fresh drive handle', async (t) => {
  const h = await fixture(t),
    owner = await h.open(),
    requestId = randomUUID();
  t.after(() => owner.close());
  await (await owner.prepareAccept(requestId, h.input)).send();
  const before = structuredClone([...h.rows.values()]),
    recovered = await owner.recover({
      target: h.input.target,
      acceptRequestId: requestId,
    });
  assert.equal(recovered.value.authority, 'recovery-required');
  assert.deepEqual(recovered.composition, h.composition);
  assert.throws(() => owner.assertStartHandle(recovered), { code: 'remote-recovery-required' });
  await assert.rejects(owner.command(recovered, { operation: 'renew', payload: {} }), {
    code: 'remote-recovery-required',
  });
  await assert.rejects(owner.command(recovered, { operation: 'input-list', payload: {} }), {
    code: 'remote-recovery-required',
  });
  assert.equal(h.seen.filter(({ request }) => request.operation === 'accept').length, 1);
  assert.deepEqual([...h.rows.values()], before);
});
