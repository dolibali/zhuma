/** Renderer transport contracts with the real product API codecs. No Host/GUI authority proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkbench } from '@zhuma/agent-core';
import { createSharedBackendClient } from '../dist/identity/shared-backend.js';
import { createIdentityApi } from '../dist/identity/api.js';
import { createMemberWorkbenchApi } from '../dist/workbench/member-api.js';
const remote = () => ({
  origin: 'http://backend.example:3080',
  connectionId: crypto.randomUUID(),
  backendId: crypto.randomUUID(),
  actorId: 'ann',
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
