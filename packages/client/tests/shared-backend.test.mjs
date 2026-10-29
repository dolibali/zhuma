/** Renderer transport contracts with the real product API codecs. No Host/GUI authority proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkbench } from '@zhuma/agent-core';
import { createSharedBackendClient } from '../dist/identity/shared-backend.js';
import { createIdentityApi } from '../dist/identity/api.js';
import { createMemberWorkbenchApi } from '../dist/workbench/member-api.js';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { createProjectKnowledgeApi } from '../dist/knowledge/project-knowledge-api.js';
import { reviewNode } from './browser/execution-fixture.mjs';
const remote = () => ({
  origin: 'http://backend.example:3080',
  connectionId: crypto.randomUUID(),
  backendId: crypto.randomUUID(),
  actorId: 'ann',
});

test('shared renderer carries exact project knowledge operations and preserves the original write intent', async () => {
  const selection = remote(),
    calls = [];
  const client = createSharedBackendClient(
    {
      async call(_channel, method, request) {
        if (method === 'zhuma-backend/status') return { ok: true, value: selection };
        calls.push(request);
        assert.equal(request.operation, 'knowledge.save-project-links');
        return {
          ok: true,
          value: {
            connectionId: selection.connectionId,
            status: 200,
            body: {
              type: 'server-response',
              rpcId: request.rpcId,
              result: {
                ok: true,
                value: {
                  actorId: 'ann',
                  spaceId: 'north',
                  projectId: 'project',
                  relationshipVersion: 1,
                  disposition: 'saved',
                },
              },
            },
          },
        };
      },
    },
    () => {},
  );
  await client.refresh();
  const input = {
    spaceId: 'north',
    projectId: 'project',
    expectedVersion: 0,
    idempotencyKey: 'same-intent',
    links: [],
  };
  const api = createProjectKnowledgeApi(
    { actorId: 'ann', spaceId: 'north', isCurrent: () => true, onUnauthenticated() {} },
    client.fetcher,
  );
  assert.equal(
    (await api.saveProjectLinks(input, new AbortController().signal)).relationshipVersion,
    1,
  );
  assert.deepEqual(calls[0].payload, input);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['connectionId', 'operation', 'payload', 'rpcId']);
  client.close();
});

test('shared file transport keeps raw bytes and exact file routes on the local owner carrier', async () => {
  const selection = remote(),
    calls = [],
    bytes = new Uint8Array([0, 1, 127, 255]);
  const client = createSharedBackendClient(
    {
      async call(_channel, method) {
        assert.equal(method, 'zhuma-backend/status');
        return { ok: true, value: selection };
      },
    },
    () => {},
    async (input, init) => {
      calls.push({ input, init });
      return new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'x-zhuma-backend-connection': selection.connectionId,
        },
      });
    },
  );
  await client.refresh();
  const response = await client.fetcher(
    '/api/zhuma-exec/file?spaceId=north&purpose=accepted&mode=download',
    { headers: { authorization: 'must-not-forward' } },
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const url = new URL(calls[0].input, 'http://local.invalid');
  assert.equal(url.pathname, '/api/zhuma-backend/file');
  assert.equal(url.searchParams.get('connectionId'), selection.connectionId);
  assert.equal(calls[0].init.headers.has('authorization'), false);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(
    calls[0].init.method,
    'POST',
    'browser supplies the original owner Origin on this local carrier',
  );
  const blob = new Blob([bytes]);
  const upload = await client.fetcher('/api/zhuma-exec/upload-file', {
    method: 'POST',
    body: blob,
    headers: {
      'content-type': 'application/octet-stream',
      'x-zhuma-file-size': '4',
      cookie: 'must-not-forward',
    },
  });
  await upload.arrayBuffer();
  assert.equal(calls[1].input, '/api/zhuma-backend/upload-file');
  assert.equal(calls[1].init.body, blob);
  assert.equal(calls[1].init.headers.get('x-zhuma-backend-connection'), selection.connectionId);
  assert.equal(calls[1].init.headers.has('cookie'), false);
  await assert.rejects(client.fetcher('/api/zhuma-exec/file?connectionId=forged'));
  await assert.rejects(
    client.fetcher('/api/zhuma-exec/upload-file?url=http://elsewhere.invalid', {
      method: 'POST',
      body: blob,
    }),
  );
  client.close();
});

test('shared backend busy refusal keeps the original ready connection so the user can still stop current work', async () => {
  const selected = remote();
  let changes = 0;
  const client = createSharedBackendClient(
    {
      async call(_channel, endpoint) {
        return endpoint === 'zhuma-backend/status'
          ? { ok: true, value: selected }
          : { ok: false, error: { code: 'backend-native-busy' } };
      },
    },
    () => {
      changes++;
    },
  );
  await client.refresh();
  await assert.rejects(client.select('http://other.invalid', AbortSignal.timeout(1000)), {
    name: 'SharedBackendNativeBusy',
  });
  assert.equal(client.getSnapshot().phase, 'ready');
  assert.equal(client.getSnapshot().selection.connectionId, selected.connectionId);
  assert.equal(changes, 0);
  client.close();
});
function fixture(selection = remote()) {
  const calls = [];
  let changes = 0,
    local = 0;
  const rpc = {
    async call(channel, endpoint, payload, signal) {
      calls.push({ channel, endpoint, payload, signal });
      if (endpoint === 'zhuma-backend/status') return { ok: true, value: selection };
      if (endpoint === 'zhuma-backend/select') {
        selection = { ...remote(), origin: payload.origin, actorId: null, backendId: null };
        return { ok: true, value: selection };
      }
      const body =
        payload.operation === 'identity.session'
          ? {
              ok: true,
              accountId: 'ann',
              principal: { kind: 'zhuma-member', memberId: 'ann' },
              peerId: 'synthetic',
              spaces: [{ id: 'north', kind: 'team', name: '研发' }],
            }
          : payload.operation === 'identity.login'
            ? { ok: true, accountId: 'ann' }
            : {
                type: 'server-response',
                rpcId: payload.rpcId,
                result: {
                  ok: true,
                  value: {
                    actorId: 'ann',
                    spaceId: 'north',
                    space: { id: 'north', kind: 'team', name: '研发' },
                    state: emptyWorkbench(),
                    model: null,
                    capabilities: {
                      createProject: true,
                      createTask: true,
                      planning: false,
                      resources: 'authorized',
                      tasks: [],
                    },
                  },
                },
              };
      return { ok: true, value: { connectionId: selection.connectionId, status: 200, body } };
    },
  };
  const client = createSharedBackendClient(
    rpc,
    () => changes++,
    async () => {
      local++;
      return Response.json({ local: true });
    },
  );
  return { client, rpc, calls, selection, changes: () => changes, local: () => local };
}

test('shared renderer carries original manual editor, ballot and fixed-content APIs through exact product operations', async () => {
  const selection = remote(),
    calls = [];
  const client = createSharedBackendClient(
    {
      async call(_channel, endpoint, request) {
        if (endpoint === 'zhuma-backend/status') return { ok: true, value: selection };
        calls.push(request);
        if (request.operation === 'identity.session')
          return {
            ok: true,
            value: {
              connectionId: selection.connectionId,
              status: 200,
              body: {
                ok: true,
                accountId: 'ann',
                principal: { kind: 'zhuma-member', memberId: 'ann' },
                peerId: 'synthetic',
                spaces: [{ id: 'north', kind: 'team', name: '研发' }],
              },
            },
          };
        const payload = request.payload;
        let value;
        if (request.operation === 'execution.draft')
          value = {
            version: payload.expectedVersion === undefined ? 0 : payload.expectedVersion + 1,
            text: payload.text ?? '',
            links: [],
            files: [],
          };
        else if (request.operation === 'execution.revision') value = { view: { notes: [] } };
        else if (request.operation === 'execution.upstream-content')
          value = {
            actorId: 'ann',
            spaceId: 'north',
            downstream: {
              taskId: payload.taskId,
              planId: payload.planId,
              revision: payload.revision,
              nodeId: payload.nodeId,
            },
            source: {
              taskId: payload.taskId,
              planId: payload.planId,
              revision: payload.revision,
              nodeId: payload.sourceNodeId,
            },
            version: { id: payload.artifactVersionId, version: 1 },
            content: { text: 'accepted body', links: [], files: [] },
          };
        else if (request.operation === 'execution.start-plan')
          value = { disposition: 'applied', reports: [] };
        else value = { node: reviewNode };
        return {
          ok: true,
          value: {
            connectionId: selection.connectionId,
            status: 200,
            body: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } },
          },
        };
      },
    },
    () => {},
  );
  await client.refresh();
  // Scope authorization is separately covered by the real HTTP API contracts;
  // this contract exercises its original encoders/decoders over the proxy.
  const api = createExecutionHttpApi(client.fetcher);
  const target = {
    taskId: reviewNode.taskId,
    planId: reviewNode.planId,
    revision: reviewNode.revision,
    nodeId: reviewNode.nodeId,
  };
  const command = {
    ...target,
    expectedVersion: 2,
    idempotencyKey: 'same-intent',
    text: 'edited text',
  };
  assert.equal(
    (await api.startPlan({ ...target, idempotencyKey: 'start' })).disposition,
    'applied',
  );
  assert.equal((await api.readDeliveryDraft(target)).version, 0);
  assert.equal((await api.saveDeliveryDraft(command)).text, 'edited text');
  assert.equal((await api.submit(command)).nodeId, target.nodeId);
  assert.equal(
    (
      await api.ballot({
        ...command,
        roundId: 'round-1',
        artifactVersionId: 'artifact-1',
        action: 'request-changes',
        comment: 'edit this section',
      })
    ).nodeId,
    target.nodeId,
  );
  assert.deepEqual((await api.revision(target)).notes, []);
  const scoped = createExecutionHttpApi(client.fetcher, () => {}, 'ann', {
    spaceId: 'north',
    onUnavailable() {},
    isCurrent: () => true,
  });
  const upstream = await scoped.upstreamContent({
    ...target,
    sourceNodeId: 'source',
    artifactVersionId: 'accepted-v1',
    expectedArtifactVersion: 1,
  });
  assert.equal(upstream.content.text, 'accepted body');
  assert.equal(upstream.version.id, 'accepted-v1');
  assert.deepEqual(
    calls.filter((item) => item.operation.startsWith('execution.')).map((item) => item.operation),
    [
      'execution.start-plan',
      'execution.draft',
      'execution.draft',
      'execution.submit',
      'execution.ballot',
      'execution.revision',
      'execution.upstream-content',
    ],
  );
  for (const request of calls) {
    assert.equal('actorId' in request.payload, false);
    assert.equal('reviewerId' in request.payload, false);
    assert.equal('headers' in request, false);
    assert.equal('route' in request, false);
  }
  client.close();
});
test('shared renderer uses fixed operations and original member codecs without Cookie/header/route exposure', async () => {
  const f = fixture();
  await f.client.refresh();
  assert.equal(
    (
      await createIdentityApi(f.client.fetcher).login({
        accountId: 'ann',
        password: 'synthetic-only',
      })
    ).accountId,
    'ann',
  );
  const api = createMemberWorkbenchApi(
    {
      actorId: 'ann',
      spaceId: 'north',
      isCurrent: () => true,
      onUnauthenticated() {},
      onUnavailable() {},
    },
    f.client.fetcher,
  );
  assert.equal((await api.snapshot()).actorId, 'ann');
  assert.equal(f.local(), 0);
  for (const call of f.calls.filter((item) => item.endpoint === 'zhuma-backend/request')) {
    assert.equal('headers' in call.payload, false);
    assert.equal('route' in call.payload, false);
    assert.equal('actorId' in call.payload, false);
    assert.ok(
      ['identity.login', 'identity.session', 'member.snapshot'].includes(call.payload.operation),
    );
  }
  f.client.close();
});
test('shared renderer rejects generic RPC paths, absolute URLs and forged envelope methods before owner proxy', async () => {
  const f = fixture();
  await f.client.refresh();
  const before = f.calls.length;
  for (const input of [
    '/api/session/send',
    'http://other.example/api/zhuma-member/snapshot',
    '//other.example/zhuma-id/session',
    '/api/zhuma-member/snapshot?route=other',
  ])
    await assert.rejects(f.client.fetcher(input, { method: 'GET' }));
  await assert.rejects(
    f.client.fetcher('/api/zhuma-member/snapshot', {
      method: 'POST',
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'session/send',
        payload: {},
      }),
    }),
  );
  assert.equal(f.calls.length, before);
  f.client.close();
});
test('shared renderer fences late old-service 401 after selecting another backend and preserves local mode explicitly', async () => {
  const f = fixture();
  await f.client.refresh();
  const pending = Promise.withResolvers(),
    entered = Promise.withResolvers(),
    normal = f.rpc.call;
  f.rpc.call = async (...args) => {
    if (args[1] === 'zhuma-backend/request') {
      entered.resolve();
      return pending.promise;
    }
    return normal(...args);
  };
  const old = f.client.fetcher('/zhuma-id/session', { method: 'GET' });
  await entered.promise;
  await f.client.select(null, new AbortController().signal);
  pending.resolve({
    ok: true,
    value: { connectionId: f.selection.connectionId, status: 401, body: {} },
  });
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(f.changes(), 1);
  assert.equal((await (await f.client.fetcher('/zhuma-id/session')).json()).local, true);
  assert.equal(f.local(), 1);
  f.client.close();
});
test('shared renderer uncertain selection keeps original retry key and never silently falls back locally', async () => {
  const f = fixture();
  await f.client.refresh();
  let attempts = 0;
  const normal = f.rpc.call,
    selected = [];
  f.rpc.call = async (...args) => {
    if (args[1] === 'zhuma-backend/select') {
      selected.push(args[2]);
      if (!attempts++) throw new TypeError('synthetic lost reply');
    }
    return normal(...args);
  };
  await assert.rejects(f.client.select('http://new.example', new AbortController().signal));
  assert.equal(f.client.getSnapshot().phase, 'error');
  await assert.rejects(f.client.fetcher('/zhuma-id/session'));
  assert.equal(f.local(), 0);
  await f.client.select('http://new.example', new AbortController().signal);
  assert.deepEqual(selected[0], selected[1]);
  assert.equal(f.client.getSnapshot().phase, 'ready');
  f.client.close();
});
