import assert from 'node:assert/strict';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  canonicalPayload,
  REMOTE_RUN_OPERATIONS,
  REMOTE_RUN_PERMIT_HEADER,
  remoteDeviceSigningInput,
  remoteRunRequestSchema,
} from '@zhuma/agent-core';
import { MemberLocalExecutionProtocol } from '../dist/member-local-execution-protocol.js';
import { MemberLocalExecutionSecrets } from '../dist/member-local-execution-secrets.js';
import { freezeExecutionRunComposition } from '../dist/execution-run-composition.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';

// Actual outgoing HTTP, Ed25519 and original composition decoder. Member/device
// authorization and backend Run state remain a contract, not two product Hosts.
async function fixture(t, options = {}) {
  const facts = { ...compositionFacts(), resultIntentTool: describeNativeResultTool() },
    composition = freezeExecutionRunComposition(facts),
    backendId = randomUUID(),
    driveEpoch = randomUUID(),
    cleanupEpoch = randomUUID(),
    rows = new Map(),
    seen = [];
  let key,
    value,
    acceptCalls = 0,
    lost = options.loseAccept === true,
    failStore = false,
    changeScope = false;
  const store = {
    async read(slot) {
      return structuredClone(rows.get(slot));
    },
    async modify(slot, update) {
      if (failStore) throw Error('PRIVATE_PROVIDER_ERROR');
      const next = update(structuredClone(rows.get(slot)));
      rows.set(slot, structuredClone(next));
      return structuredClone(next);
    },
  };
  const methods = Object.fromEntries(
    REMOTE_RUN_OPERATIONS.map((operation) => [operation, `zhuma-proof/${operation}`]),
  );
  const server = createServer(async (req, res) => {
    try {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      const envelope = JSON.parse(bytes),
        request = remoteRunRequestSchema.parse(envelope.payload);
      assert.equal(req.url, `/api/${methods[request.operation]}`);
      assert.equal(req.headers.cookie, 'synthetic-original-member');
      const respond = (response) =>
        res.end(
          JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: response }),
        );
      seen.push({ request, permit: req.headers[REMOTE_RUN_PERMIT_HEADER] });
      if (request.operation === 'info') {
        respond({
          ok: true,
          value: {
            protocolVersion: 1,
            backendId,
            actorId: options.actorId ?? 'chen',
            serverTime: Date.now(),
            operations: REMOTE_RUN_OPERATIONS,
            purposes: ['work'],
          },
        });
        return;
      }
      if (request.operation === 'register-device') {
        key = createPublicKey({
          key: Buffer.from(request.payload.publicKey, 'base64url'),
          type: 'spki',
          format: 'der',
        });
      }
      assert.equal(
        verify(
          null,
          Buffer.from(canonicalPayload(remoteDeviceSigningInput(request))),
          key,
          Buffer.from(request.proof.signature, 'base64url'),
        ),
        true,
      );
      if (request.operation === 'register-device') {
        respond(
          options.registerError
            ? { ok: false, error: { code: 'remote-device-unavailable' } }
            : {
                ok: true,
                value: {
                  deviceId: request.deviceId,
                  actorId: 'chen',
                  keyEpoch: 1,
                  disposition: 'enrolled',
                  serverTime: Date.now(),
                },
              },
        );
      } else if (request.operation === 'accept') {
        acceptCalls++;
        assert.equal(rows.size, 2, 'private device and intent were durable before accept');
        assert.equal(req.headers[REMOTE_RUN_PERMIT_HEADER], undefined);
        const intent = [...rows.values()].find((row) => row.requestId === request.requestId);
        assert(!bytes.includes(intent.drive.secret));
        assert(!bytes.includes(intent.cleanup.secret));
        value ??= {
          scope: { backendId, ...facts.scope },
          deviceId: request.deviceId,
          serverTime: Date.now(),
          authority: 'drive',
          permit: {
            id: request.payload.credentials.drive.id,
            epoch: driveEpoch,
            expiresAt: Date.now() + 60_000,
          },
          cleanup: {
            id: request.payload.credentials.cleanup.id,
            epoch: cleanupEpoch,
            expiresAt: Date.now() + 43_200_000,
          },
          nodeVersion: 1,
          runVersion: 1,
          nextSequence: 1,
          stopRequested: false,
          resources: 'held',
          runStatus: 'requested',
          disposition: 'accepted',
          selection: { ...facts.model, configurationId: composition.configurationId },
          shared: {
            configurationId: composition.configurationId,
            composition,
            context: composition.payload.context,
            handoff: composition.payload.handoff,
            inputs: [],
          },
        };
        if (lost) {
          lost = false;
          res.destroy();
          return;
        }
        const reply = structuredClone(value);
        options.mutate?.(reply);
        respond({ ok: true, value: reply });
      } else if (request.operation === 'status' || request.operation === 'cleanup') {
        const intent = [...rows.values()].find((row) => row.requestId),
          cleanup = request.operation === 'cleanup';
        assert.equal(
          req.headers[REMOTE_RUN_PERMIT_HEADER],
          cleanup ? intent.cleanup.secret : intent.drive.secret,
        );
        assert.equal(request.payload.permit.id, cleanup ? intent.cleanup.id : intent.drive.id);
        const {
          disposition: _disposition,
          selection: _selection,
          shared: _shared,
          ...view
        } = value;
        if (changeScope) view.scope = { ...view.scope, runId: 'other-run' };
        respond({
          ok: true,
          value: cleanup ? { ...view, disposition: 'applied' } : view,
        });
      } else throw Error('Unexpected contract operation');
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const protocolOptions = {
    origin: `http://127.0.0.1:${server.address().port}`,
    methods,
    expectedActorId: 'chen',
    authentication: () => ({ cookie: 'synthetic-original-member' }),
    secrets: new MemberLocalExecutionSecrets(store),
  };
  const input = {
    target: {
      spaceId: facts.scope.spaceId,
      taskId: facts.scope.taskId,
      planId: facts.scope.planId,
      revision: facts.scope.revision,
      nodeId: facts.scope.nodeId,
    },
    expectedNodeVersion: 1,
    expectedRunVersion: 0,
    purpose: 'work',
    mode: 'begin',
    model: facts.model,
    workspace: { kind: 'text-only' },
    executor: facts.executor,
    capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
  };
  return {
    rows,
    store,
    seen,
    composition,
    protocolOptions,
    input,
    acceptCalls: () => acceptCalls,
    failStore: () => {
      failStore = true;
    },
    changeScope: () => {
      changeScope = true;
    },
    open: () => MemberLocalExecutionProtocol.open(protocolOptions),
  };
}
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
  assert.deepEqual([...h.rows.values()], durable);
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
