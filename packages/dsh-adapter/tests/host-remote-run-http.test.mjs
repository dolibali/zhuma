/** Node HTTP/identity-port contracts. Domain outcomes here are explicit stubs,
 * not an execution, persistence, two-Host or model acceptance claim. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { REMOTE_RUN_OPERATIONS, REMOTE_RUN_PERMIT_HEADER } from '@zhuma/agent-core';
import {
  openHostRemoteRunHttp,
  MEMBER_LOCAL_REMOTE_METHODS,
} from '../dist/host-remote-run-http.js';
import { installMemberResolver, memberCredential } from '../dist/member-session.js';
async function host() {
  const routes = new Map(),
    effects = [],
    calls = [];
  const effect = (start) => {
    const stop = start();
    if (typeof stop === 'function') effects.push(stop);
    return stop;
  };
  const ctx = {
    root: {},
    effect,
    connection: {
      requestRejection: ({ headers }) => (headers.origin === 'https://foreign.invalid' ? 403 : 401),
    },
    inject: (_, apply) =>
      apply({
        effect,
        webServer: {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
      }),
  };
  const secret = randomBytes(32),
    sessionId = randomUUID(),
    expiresAt = Date.now() + 60_000;
  const unpublish = installMemberResolver(ctx, {
    secret,
    requestRejection: (headers) => ctx.connection.requestRejection({ headers }),
    findSession: (id) => (id === sessionId ? { accountId: 'member', expiresAt } : undefined),
    spaceIdsFor: () => ['space'],
    singleUserAccountId: () => undefined,
    admitOwner: () => false,
  });
  let available = true;
  const service = {
    async remoteRun(request, body, permit) {
      calls.push({ request, body, permit });
      return { ok: false, error: { code: 'remote-protocol-unsupported' } };
    },
  };
  const handle = openHostRemoteRunHttp(ctx, () => (available ? service : undefined));
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://test').pathname);
    if (route) void route.handler(req, res);
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `zhuma-member=${memberCredential(secret, sessionId, expiresAt)}`;
  return {
    routes,
    calls,
    cookie,
    base,
    handle,
    unavailable: () => {
      available = false;
    },
    async post(operation, payload, options = {}) {
      const envelope = {
        type: 'client-request',
        method: MEMBER_LOCAL_REMOTE_METHODS[operation],
        rpcId: randomUUID(),
        payload,
      };
      return fetch(`${base}/api/${MEMBER_LOCAL_REMOTE_METHODS[operation]}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.member ? { cookie } : {}),
          ...options.headers,
        },
        body: JSON.stringify(envelope),
      });
    },
    async close() {
      unpublish();
      await handle.close();
      for (const dispose of effects.reverse()) await dispose();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}
const info = () => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  operation: 'info',
  payload: {},
});
const cleanup = () => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  operation: 'cleanup',
  backendId: randomUUID(),
  deviceId: randomUUID(),
  proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'a'.repeat(86) },
  payload: {
    scope: {
      backendId: randomUUID(),
      actorId: 'member',
      spaceId: 'space',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      runId: 'run',
      generation: 1,
      segmentId: 'segment',
    },
    permit: { id: randomUUID(), sha256: 'b'.repeat(64) },
    observation: { kind: 'stop-received', sequence: 1 },
  },
});
test('remote HTTP mounts all actual operation paths and requires a member before ordinary bodies', async () => {
  const h = await host();
  try {
    assert.equal(h.routes.size, REMOTE_RUN_OPERATIONS.length);
    assert.equal((await h.post('info', info())).status, 401);
    assert.equal(
      (
        await h.post('info', info(), {
          member: true,
          headers: { origin: 'https://foreign.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${h.base}/api/${MEMBER_LOCAL_REMOTE_METHODS.info}`, {
          headers: { cookie: h.cookie },
        })
      ).status,
      405,
    );
    assert.equal(h.calls.length, 0);
    const result = await h.post('info', info(), { member: true });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('set-cookie'), null);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).result.error.code, 'remote-protocol-unsupported');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].request.headers.cookie, h.cookie);
    assert.equal((await fetch(`${h.base}/api`)).status, 404);
  } finally {
    await h.close();
  }
});
test('cleanup is the sole no-cookie path, cannot smuggle an ordinary operation and still invokes domain proof validation', async () => {
  const h = await host();
  try {
    assert.equal((await h.post('cleanup', info())).status, 400);
    assert.equal(h.calls.length, 0);
    // Malformed cleanup is never delegated, even though it is the sole auth exception.
    assert.equal((await h.post('cleanup', { operation: 'cleanup' })).status, 400);
    assert.equal(h.calls.length, 0);
    const body = cleanup();
    const response = await h.post('cleanup', body, {
      headers: { [REMOTE_RUN_PERMIT_HEADER]: 'synthetic-private-proof' },
    });
    // The actual contract is validated before delegation; if this fixture is
    // invalid the test must fail rather than invent an accepted cleanup DTO.
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.error.code, 'remote-protocol-unsupported');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].permit, 'synthetic-private-proof');
    assert.equal(h.calls[0].request.headers.cookie, undefined);
    h.unavailable();
    assert.equal((await h.post('info', info(), { member: true })).status, 503);
    assert.equal(h.calls.length, 1);
  } finally {
    await h.close();
  }
});
