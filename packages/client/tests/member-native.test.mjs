/** Private-carrier and projection contracts, not a Host/model/GUI acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMemberNativeClient } from '../dist/run/member-native.js';
import { createNativeRunApi } from '../dist/run/api.js';
function setup() {
  let snapshot = {
    phase: 'ready',
    selection: { connectionId: randomUUID(), origin: 'http://backend.invalid' },
  };
  const local = [],
    remote = [];
  const backend = {
    getSnapshot: () => snapshot,
    fetcher: async (input, init) => {
      remote.push({ input, init });
      return Response.json({});
    },
  };
  const client = createMemberNativeClient(backend, async (input, init) => {
    local.push({ input, init });
    return Response.json({});
  });
  return {
    client,
    local,
    remote,
    change: () => {
      snapshot = { ...snapshot, selection: { ...snapshot.selection, connectionId: randomUUID() } };
    },
  };
}
const request = (endpoint, payload = {}) => ({
  method: 'POST',
  body: JSON.stringify({
    type: 'client-request',
    rpcId: randomUUID(),
    method: `zhuma-run/${endpoint}`,
    payload,
  }),
});
test('member native: native stays local, business stays on the fixed member proxy and the carrier contains no remote credential', async () => {
  const h = setup();
  const client = h.client.scoped('member', 'team');
  await client.fetcher('/api/zhuma-run/options', request('options', { nodeId: 'node' }));
  assert.equal(h.remote.length, 0);
  assert.equal(h.local[0].input, '/api/zhuma-member-native/options');
  const wire = JSON.parse(h.local[0].init.body);
  assert.deepEqual(wire.payload.query, { nodeId: 'node' });
  assert.equal(wire.payload.actorId, 'member');
  assert.equal(wire.payload.spaceId, 'team');
  assert.equal(h.local[0].init.credentials, 'same-origin');
  assert.equal(Object.hasOwn(wire.payload, 'cookie'), false);
  assert.equal(Object.hasOwn(wire.payload, 'origin'), false);
  await client.fetcher('/zhuma-id/session');
  assert.equal(h.remote.length, 1);
  h.change();
  await assert.rejects(client.fetcher('/api/zhuma-run/read', request('read')), {
    name: 'AbortError',
  });
  assert.equal(h.local.length, 1);
});
test('member native: only exact operations and the original envelope are accepted', async () => {
  const h = setup();
  const client = h.client.scoped('member', 'team');
  await assert.rejects(client.fetcher('/api/zhuma-run/arbitrary', request('arbitrary')));
  await assert.rejects(client.fetcher('/api/zhuma-run/send', request('read')));
  await assert.rejects(client.fetcher('/api/zhuma-run/stop', { method: 'GET' }));
  assert.equal(h.local.length, 0);
});

test('member workflow: all five operations stay on the local owner and cannot use a forged method or old connection', async () => {
  const h = setup(),
    client = h.client.scoped('member', 'team');
  const input = (endpoint) => ({
    method: 'POST',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: `zhuma-workflow/${endpoint}`,
      payload: { spaceId: 'team', taskId: 'task', planId: 'plan', revision: 1 },
    }),
  });
  for (const endpoint of ['options', 'read', 'start', 'resume', 'stop']) {
    await client.fetcher(`/api/zhuma-workflow/${endpoint}`, input(endpoint));
    assert.equal(h.local.at(-1).input, `/api/zhuma-member-native/workflow-${endpoint}`);
    assert.equal(JSON.parse(h.local.at(-1).init.body).payload.spaceId, 'team');
  }
  assert.equal(h.remote.length, 0, 'No automatic command reaches a remote backend as renderer RPC');
  await assert.rejects(client.fetcher('/api/zhuma-workflow/start', input('read')));
  await assert.rejects(client.fetcher('/api/zhuma-workflow/unknown', input('unknown')));
  h.change();
  await assert.rejects(client.fetcher('/api/zhuma-workflow/start', input('start')), {
    name: 'AbortError',
  });
  assert.equal(h.local.length, 5);
});
test('member native: history navigation selects only the requested original Run for a metadata read', async () => {
  const h = setup();
  const client = h.client.scoped('member', 'team', 'original-run');
  await client.fetcher('/api/zhuma-run/options', request('options', { nodeId: 'node' }));
  assert.equal(JSON.parse(h.local[0].init.body).payload.query.runId, 'original-run');
  assert.equal(h.local.length, 1);
  assert.equal(h.local[0].input.endsWith('/options'), true);
});

test('member native: only explicit server-allocation mode accepts the genuine returned Run IDs', async () => {
  for (const server of [false, true]) {
    const api = createNativeRunApi(
      async (url, init) => {
        if (url === '/zhuma-id/session')
          return Response.json({
            ok: true,
            accountId: 'member',
            principal: { kind: 'zhuma-member', memberId: 'member' },
            peerId: 'peer',
            spaces: [{ id: 'space', kind: 'team', name: 'Team' }],
          });
        const wire = JSON.parse(init.body);
        return Response.json({
          type: 'server-response',
          rpcId: wire.rpcId,
          result: {
            ok: true,
            value: {
              taskId: 'task',
              planId: 'plan',
              revision: 1,
              nodeId: 'node',
              runId: 'actual-server-run',
              segmentId: 'actual-server-segment',
            },
          },
        });
      },
      'member',
      { spaceId: 'space', isCurrent: () => true, onUnavailable() {} },
      () => {},
      undefined,
      undefined,
      undefined,
      server,
    );
    const begin = api.begin(
      {
        spaceId: 'space',
        taskId: 'task',
        planId: 'plan',
        revision: 1,
        nodeId: 'node',
        requestId: 'request',
        newRunId: 'local-intent-run',
        newSegmentId: 'local-intent-segment',
        expectedNodeVersion: 1,
        expectedRunVersion: 0,
        mode: 'begin',
        model: { provider: 'provider', model: 'model', maxTokens: 4096 },
        executor: { kind: 'builtin' },
        tools: 'text-only',
        workspace: { kind: 'text-only' },
      },
      AbortSignal.timeout(1000),
    );
    if (server) await begin;
    else await assert.rejects(begin);
  }
});
