import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { configureDeploymentMode } from '../dist/member-session.js';
import { hostRunEndpoints, openHostRunHttp } from '../dist/host-run-http.js';

// Transport registration contracts. The real member issuer is deliberately
// absent; no fixture owner is installed as a member or native executor.
function mount() {
  const ctx = new Context();
  const routes = new Map();
  ctx.provide('connection', {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  });
  configureDeploymentMode(ctx, 'multi-member');
  const http = openHostRunHttp(ctx, {
    limits: { bodyBytes: 1024, bodyTimeoutMs: 1000 },
    current() {
      throw Error('An unauthenticated request must not select a runtime');
    },
  });
  return { ctx, routes, http };
}

test('Host Run transport contract: each exact route rejects an owner-only or unmounted member before reading its body', async () => {
  const { ctx, routes, http } = mount();
  try {
    assert.deepEqual(
      [...routes.keys()],
      hostRunEndpoints.map((name) => `/api/zhuma-run/${name}`),
    );
    for (const [path, route] of routes) {
      assert.equal(route.requestBody, 'streaming');
      assert.deepEqual(route.methods, ['POST']);
      let reads = 0;
      const request = new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { cookie: 'fixture-owner=transport-only' },
        body: 'unfinished',
      });
      Object.defineProperty(request, 'body', {
        get() {
          reads++;
          throw Error('Unauthenticated body must remain unread');
        },
      });
      const response = await route.fetch(request);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).result.error.code, 'unauthenticated');
      assert.equal(reads, 0);
    }
  } finally {
    await http.close();
    await ctx.fiber.dispose();
  }
});

test('Host Run transport contract: shutdown unpublishes all routes and rejects a retained carrier without selecting the old runtime', async () => {
  const { ctx, routes, http } = mount();
  const oldRoute = routes.get('/api/zhuma-run/begin');
  try {
    const closed = http.close();
    assert.equal(http.close(), closed);
    await closed;
    assert.equal(routes.size, 0);
    const response = await oldRoute.fetch(
      new Request('http://localhost/api/zhuma-run/begin', { method: 'POST' }),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).result.error.code, 'cancelled');
  } finally {
    await http.close();
    await ctx.fiber.dispose();
  }
});
