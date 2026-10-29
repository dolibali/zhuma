/** Private adapter contracts with a controlled backend source. Not product
 * member HTTP/authentication, an actual Agent, model, GUI or socket-drain proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createHostMemberKnowledgePort } from '../dist/host-member-knowledge-port.js';

const scope = () => ({
  actorId: 'ann',
  spaceId: 'north',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'run',
  generation: 2,
  segmentId: 'segment',
});
const reference = () => ({
  spaceId: 'north',
  libraryId: 'north',
  pageId: 'guide',
  version: 2,
  checksum: 'a'.repeat(64),
});
const search = () => ({
  action: 'search',
  payload: { spaceId: 'north', libraryIds: ['north'], query: 'guide', limit: 5 },
});
const read = () => ({
  action: 'read',
  payload: { ...reference(), part: 'body', offset: 0, length: 100 },
});
const propose = () => ({
  action: 'propose-draft',
  payload: {
    spaceId: 'north',
    libraryId: 'north',
    pageId: 'guide',
    expectedVersion: 2,
    idempotencyKey: 'same-intent',
    content: { title: 'Guide', format: 'markdown', text: 'New draft.', sources: [reference()] },
  },
});
function valueFor(action) {
  const base = { actorId: 'ann', spaceId: 'north' };
  if (action === 'search')
    return { ...base, libraryIds: ['north'], query: 'guide', hits: [], complete: true };
  if (action === 'read') {
    const text = 'SCOPED_PRIVATE_FRAGMENT-知识';
    const length = Buffer.byteLength(text);
    return {
      ...base,
      reference: reference(),
      part: 'body',
      title: 'Guide',
      format: 'markdown',
      text,
      offset: 0,
      length,
      nextOffset: length,
      totalBytes: length,
      partChecksum: 'b'.repeat(64),
      sources: [],
    };
  }
  return {
    ...base,
    libraryId: 'north',
    pageId: 'guide',
    pageRevision: 3,
    operation: 'save-draft',
    disposition: 'saved',
  };
}
function fixture({ allowDrafts = false, gate = () => {}, source } = {}) {
  const calls = [];
  let gates = 0;
  const options = {
    connectionId: randomUUID(),
    scope: scope(),
    library: { id: 'north', spaceId: 'north', kind: 'team', name: 'North', canCreate: true },
    allowDrafts,
    assertCurrent: async (signal) => {
      gates++;
      await gate(signal);
    },
    backend: {
      async request(request, signal) {
        calls.push(structuredClone(request));
        const response = {
          connectionId: request.connectionId,
          status: 200,
          body: {
            type: 'server-response',
            rpcId: request.rpcId,
            result: { ok: true, value: valueFor(request.operation.slice('knowledge.'.length)) },
          },
        };
        return source ? source(request, signal, response) : response;
      },
    },
  };
  const port = createHostMemberKnowledgePort(options);
  return {
    port,
    options,
    calls,
    gates: () => gates,
    invoke: (input, signal = new AbortController().signal) => port.invoke(input, signal),
  };
}

test('knowledge private port: synchronous construction has no IO and freezes one actual Run/library/consent', () => {
  const h = fixture();
  assert.equal(h.gates(), 0);
  assert.equal(h.calls.length, 0);
  h.options.scope.runId = 'different';
  h.options.library.name = 'Changed';
  h.options.allowDrafts = true;
  assert.equal(h.port.catalog.scope.runId, 'run');
  assert.equal(h.port.catalog.library.name, 'North');
  assert.equal(h.port.allowDrafts, false);
  assert.throws(() => createHostMemberKnowledgePort({ ...h.options, allowDrafts: undefined }));
  assert.throws(() =>
    createHostMemberKnowledgePort({
      ...h.options,
      library: { ...h.options.library, spaceId: 'other' },
    }),
  );
});

test('knowledge private port: only the three exact original operations get scoped payloads and fresh matching RPC IDs', async () => {
  const h = fixture({ allowDrafts: true });
  for (const input of [search(), read(), propose()]) {
    const result = await h.invoke(input);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(h.gates(), 6);
  assert.deepEqual(
    h.calls.map(({ operation }) => operation),
    ['knowledge.search', 'knowledge.read', 'knowledge.propose-draft'],
  );
  assert.equal(new Set(h.calls.map(({ rpcId }) => rpcId)).size, 3);
  for (const call of h.calls) {
    assert.deepEqual(Object.keys(call).sort(), ['connectionId', 'operation', 'payload', 'rpcId']);
    assert.equal(call.connectionId, h.options.connectionId);
    assert.equal('actorId' in call.payload, false);
    assert.equal('cookie' in call.payload, false);
    assert.equal('origin' in call.payload, false);
    assert.equal('url' in call.payload, false);
  }
});

test('knowledge private port: draft consent, same scope/library and fixed read reference are required before backend IO', async () => {
  const h = fixture();
  assert.equal((await h.invoke(propose())).error.code, 'forbidden');
  for (const input of [
    { ...search(), payload: { ...search().payload, spaceId: 'other' } },
    { ...search(), payload: { ...search().payload, libraryIds: ['north', 'other'] } },
    { ...read(), payload: { ...read().payload, libraryId: 'other' } },
  ])
    assert.equal((await h.invoke(input)).error.code, 'forbidden');
  for (const input of [
    { action: 'publish', payload: propose().payload },
    { ...read(), payload: { ...read().payload, version: 0 } },
    { ...read(), payload: { ...read().payload, checksum: undefined } },
    { ...search(), payload: { ...search().payload, actorId: 'forged' } },
  ])
    assert.equal((await h.invoke(input)).error.code, 'invalid');
  assert.equal(h.calls.length, 0);
  const consented = fixture({ allowDrafts: true });
  const input = propose();
  input.payload.content.sources[0].libraryId = 'other';
  assert.equal((await consented.invoke(input)).error.code, 'forbidden');
  assert.equal(consented.calls.length, 0);
});

test('knowledge private port: wrong RPC/connection/status or foreign/changed read content never returns successful material', async () => {
  for (const contaminate of [
    (r) => (r.body.rpcId = randomUUID()),
    (r) => (r.connectionId = randomUUID()),
    (r) => (r.status = 503),
    (r) => (r.body.result.value.actorId = 'other'),
    (r) => (r.body.result.value.reference.libraryId = 'other'),
    (r) => (r.body.result.value.reference.version = 3),
    (r) => (r.body.result.value.reference.checksum = 'c'.repeat(64)),
    (r) => (r.body.result.value.length = 1),
  ]) {
    const h = fixture({
      source(_request, _signal, response) {
        contaminate(response);
        return response;
      },
    });
    const result = await h.invoke(read());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unavailable');
    assert.equal(JSON.stringify(result).includes('SCOPED_PRIVATE_FRAGMENT'), false);
  }
});

test('knowledge private port: original typed business refusal is preserved and malformed or publish receipts fail closed', async () => {
  const refusal = { ok: false, error: { code: 'conflict', message: 'Original conflict.' } };
  const h = fixture({
    allowDrafts: true,
    source(_request, _signal, response) {
      response.body.result = refusal;
      return response;
    },
  });
  assert.deepEqual(await h.invoke(propose()), refusal);
  for (const change of [
    (r) => (r.body.result.value.operation = 'publish'),
    (r) => (r.body.result.value.reference = reference()),
    (r) => (r.body.result = { ok: false, error: { code: 'made-up', message: 'Unexpected.' } }),
  ]) {
    const bad = fixture({
      allowDrafts: true,
      source(_request, _signal, response) {
        change(response);
        return response;
      },
    });
    assert.equal((await bad.invoke(propose())).error.code, 'unavailable');
  }
});

test('knowledge private port: unknown draft outcome has no automatic retry, changed key or version reset', async () => {
  let lost = true;
  const h = fixture({
    allowDrafts: true,
    source(_request, _signal, response) {
      if (lost) {
        lost = false;
        throw Error('CONTRACT_ACK_LOST_AFTER_WRITE');
      }
      response.body.result.value.disposition = 'replayed';
      return response;
    },
  });
  const input = propose();
  assert.equal((await h.invoke(input)).error.code, 'unavailable');
  assert.equal(h.calls.length, 1);
  assert.equal((await h.invoke(input)).value.disposition, 'replayed');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].payload, input.payload);
  assert.deepEqual(h.calls[1].payload, input.payload);
});

test('knowledge private port: revoked pre/post gates make no new call or expose no late material', async () => {
  const refused = fixture({
    gate() {
      throw Error('CONTRACT_REVOKED');
    },
  });
  assert.equal((await refused.invoke(read())).error.code, 'unavailable');
  assert.equal(refused.calls.length, 0);
  let revoked = false;
  const late = fixture({
    gate() {
      if (revoked) throw Error('CONTRACT_REVOKED');
    },
    source(_request, _signal, response) {
      revoked = true;
      return response;
    },
  });
  assert.equal((await late.invoke(read())).error.code, 'unavailable');
  assert.equal(late.calls.length, 1);
});

test('knowledge private port: caller abort does not settle the actual invocation until an ignored-abort source settles', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    abort = new AbortController();
  const h = fixture({
    source: async (_request, signal, response) => {
      entered.resolve(signal);
      await release.promise; // Deliberately ignores abort, as an unsettled source can.
      return response;
    },
  });
  let settled = false;
  const pending = h.invoke(read(), abort.signal).then((value) => {
    settled = true;
    return value;
  });
  try {
    const receivedSignal = await entered.promise;
    abort.abort();
    await new Promise(setImmediate);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(settled, false);
    assert.equal(h.calls.length, 1);
  } finally {
    release.resolve();
  }
  const result = await pending;
  assert.equal(result.error.code, 'cancelled');
  assert.equal(JSON.stringify(result).includes('SCOPED_PRIVATE_FRAGMENT'), false);
});
