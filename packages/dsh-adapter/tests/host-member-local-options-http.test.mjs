/** Owner-route/member-port transport contracts, not real domain or GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { openHostMemberLocalOptionsHttp } from '../dist/host-member-local-options-http.js';
import { installMemberResolver, memberCredential } from '../dist/member-session.js';
function host(endpoint = 'local-run-options') {
  const routes = new Map(),
    effects = [],
    secret = randomBytes(32),
    sessionId = randomUUID(),
    expiresAt = Date.now() + 60_000;
  let source,
    calls = 0;
  const ctx = {
    root: {},
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return async () => routes.delete(route.path);
        },
      },
    },
    effect(start) {
      const stop = start();
      if (stop) effects.push(stop);
    },
  };
  const unpublish = installMemberResolver(ctx, {
    secret,
    requestRejection: () => 401,
    findSession: (id) => (id === sessionId ? { accountId: 'member', expiresAt } : undefined),
    spaceIdsFor: () => ['space'],
    singleUserAccountId: () => undefined,
    admitOwner: () => false,
  });
  const owner = openHostMemberLocalOptionsHttp(ctx, () => source, endpoint);
  const cookie = `zhuma-member=${memberCredential(secret, sessionId, expiresAt)}`;
  const input = {
    type: 'client-request',
    rpcId: randomUUID(),
    method: `zhuma-member/${endpoint}`,
    payload: {
      spaceId: 'space',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      ...(endpoint === 'local-review-options'
        ? { roundId: 'round', artifactVersionId: 'artifact' }
        : {}),
    },
  };
  return {
    input,
    cookie,
    calls: () => calls,
    setSource(read) {
      source = (...args) => {
        calls++;
        return read(...args);
      };
    },
    async request(body = input, authenticated = true) {
      return routes.get(`/api/zhuma-member/${endpoint}`).fetch(
        new Request(`http://localhost/api/zhuma-member/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
          body: JSON.stringify(body),
        }),
      );
    },
    async close() {
      unpublish();
      await owner.close();
      for (const stop of effects.reverse()) await stop();
    },
  };
}
test('member local metadata route never substitutes an owner principal and forwards only its exact method', async () => {
  const h = host();
  try {
    h.setSource(async (request, query, signal) => {
      assert.equal(request.headers.cookie, h.cookie);
      assert.equal(signal.aborted, false);
      assert.deepEqual(query, h.input.payload);
      return { ok: true, value: { contractProjection: true } };
    });
    assert.equal((await h.request(h.input, false)).status, 401);
    assert.equal((await h.request({ ...h.input, method: 'zhuma-run/begin' })).status, 400);
    assert.equal(h.calls(), 0);
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      type: 'server-response',
      rpcId: h.input.rpcId,
      result: { ok: true, value: { contractProjection: true } },
    });
    assert.equal(h.calls(), 1);
  } finally {
    await h.close();
  }
});
test('member local metadata route suppresses a late projection from a replaced native owner', async () => {
  const h = host(),
    pending = Promise.withResolvers();
  try {
    h.setSource(() => pending.promise);
    const response = h.request();
    while (!h.calls()) await new Promise(setImmediate);
    h.setSource(async () =>
      assert.fail('The replacement owner must not be read by an old request'),
    );
    pending.resolve({ ok: true, value: { latePrivateProjection: true } });
    const value = await response;
    assert.equal(value.status, 503);
    assert.equal((await value.json()).result.ok, false);
    assert.equal(h.calls(), 1);
  } finally {
    await h.close();
  }
});

test('member local review metadata uses the exact normal member carrier and preserves the original fixed-round query', async () => {
  const h = host('local-review-options');
  try {
    h.setSource(async (original, query) => {
      assert.equal(original.headers.cookie, h.cookie);
      assert.deepEqual(query, h.input.payload);
      return { ok: true, value: { contractOnly: 'D original reader result' } };
    });
    assert.equal((await h.request(h.input, false)).status, 401);
    assert.equal(
      (await h.request({ ...h.input, method: 'zhuma-member/local-run-options' })).status,
      400,
    );
    assert.equal(h.calls(), 0);
    const reply = await h.request();
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).result.value.contractOnly, 'D original reader result');
    assert.equal(h.calls(), 1);
  } finally {
    await h.close();
  }
});
