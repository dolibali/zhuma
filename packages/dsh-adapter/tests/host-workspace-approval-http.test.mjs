/** Transport-only contracts: no product member issuer, filesystem or grant doubles. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { configureDeploymentMode } from '../dist/member-session.js';
import { openHostWorkspaceApprovalHttp } from '../dist/host-workspace-approval-http.js';

function mount() {
  const ctx = new Context(),
    routes = new Map(),
    owner = { value: true };
  ctx.provide('connection', {
    requestRejection: () => undefined,
    admit: () => ({ peer: { principal: { kind: owner.value ? 'owner' : 'untrusted-contract' } } }),
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  });
  configureDeploymentMode(ctx, 'multi-member');
  const http = openHostWorkspaceApprovalHttp(ctx, {
    limits: { bodyBytes: 32768, bodyTimeoutMs: 1000 },
    current() {
      throw Error('A non-member must not select a workspace owner');
    },
  });
  return { ctx, routes, owner, http };
}
test('workspace transport: owner, exact same origin and original member are all checked before any body read', async () => {
  const h = mount();
  try {
    assert.equal(h.routes.size, 3);
    for (const route of h.routes.values()) {
      assert.deepEqual(route.methods, ['POST']);
      assert.equal(route.requestBody, 'streaming');
      for (const [owner, origin, expected] of [
        [false, 'http://localhost', 403],
        [true, undefined, 403],
        [true, 'https://outside.example', 403],
        [true, 'http://localhost/', 403],
        [true, 'http://localhost', 401],
      ]) {
        h.owner.value = owner;
        let reads = 0;
        const request = new Request(`http://localhost${route.path}`, {
          method: 'POST',
          headers: { host: 'localhost', ...(origin ? { origin } : {}) },
        });
        Object.defineProperty(request, 'body', {
          get() {
            reads++;
            throw Error('Body must stay unread');
          },
        });
        const response = await route.fetch(request);
        assert.equal(response.status, expected);
        assert.equal(reads, 0);
      }
    }
  } finally {
    await h.http.close();
    await h.ctx.fiber.dispose();
  }
});
test('workspace transport: close unregisters all endpoints and rejects a retained carrier before body consumption', async () => {
  const h = mount(),
    route = h.routes.values().next().value;
  try {
    const closed = h.http.close();
    assert.equal(h.http.close(), closed);
    await closed;
    assert.equal(h.routes.size, 0);
    const response = await route.fetch(
      new Request('http://localhost' + route.path, { method: 'POST' }),
    );
    assert.equal(response.status, 503);
  } finally {
    await h.http.close();
    await h.ctx.fiber.dispose();
  }
});
