import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { enableMemberWeb, registerProductFetch } from '../dist/member-web-transport.js';
import { installMemberResolver, memberCredential } from '../dist/member-session.js';

// Transport contract only. Official CLI/credentials/storage proof is scripts/server/verify-local.mjs.
async function host(route) {
  const routes = new Map();
  const effects = [];
  let ownerRegistrations = 0;
  const effect = (start) => {
    const stop = start();
    if (typeof stop === 'function') effects.push(stop);
    return stop;
  };
  const ctx = {
    root: {},
    effect,
    connection: {
      fetch: {
        register: () => {
          ownerRegistrations++;
          return async () => {};
        },
      },
      requestRejection: ({ headers }) => (headers.origin === 'https://other.invalid' ? 403 : 401),
    },
    inject: (_services, apply) =>
      apply({
        effect,
        webServer: {
          register: (row) => {
            routes.set(row.path, row);
            return () => routes.delete(row.path);
          },
        },
      }),
  };
  enableMemberWeb(ctx);
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
  const close = registerProductFetch(ctx, route);
  const server = createServer((req, res) => {
    const row = routes.get(new URL(req.url, 'http://test').pathname);
    if (row) void row.handler(req, res);
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    ctx,
    base: `http://127.0.0.1:${server.address().port}`,
    routes,
    close,
    cookie: `zhuma-member=${memberCredential(secret, sessionId, expiresAt)}`,
    ownerRegistrations: () => ownerRegistrations,
    async stop() {
      unpublish();
      await close();
      for (const stop of effects.reverse()) await stop();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('public product transport requires a member before consuming a body; no RPC fallback', async () => {
  let calls = 0;
  const h = await host({
    path: '/api/zhuma-exec/submit',
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async (req) => {
      calls++;
      return Response.json({ text: await req.text() });
    },
  });
  try {
    assert.equal(h.ownerRegistrations(), 1);
    assert.equal(
      (await fetch(h.base + '/api/zhuma-exec/submit', { method: 'POST', body: 'x' })).status,
      401,
    );
    assert.equal(
      (await fetch(h.base + '/api/zhuma-exec/submit', { headers: { cookie: h.cookie } })).status,
      405,
    );
    assert.equal(
      (
        await fetch(h.base + '/api/zhuma-exec/submit', {
          method: 'POST',
          headers: { cookie: h.cookie, origin: 'https://other.invalid' },
          body: 'x',
        })
      ).status,
      403,
    );
    assert.equal(calls, 0);
    assert.equal((await fetch(h.base + '/api')).status, 404);
    const response = await fetch(h.base + '/api/zhuma-exec/submit', {
      method: 'POST',
      headers: { cookie: h.cookie },
      body: 'submitted text',
    });
    assert.deepEqual(await response.json(), { text: 'submitted text' });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls, 1);
    assert.throws(() =>
      registerProductFetch(h.ctx, {
        path: '/api/zhuma-run/begin',
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: async () => new Response(),
      }),
    );
  } finally {
    await h.stop();
  }
});

test('transport disconnect cancels an open stream; close drains and removes the exact route', async () => {
  let requestAborted;
  const aborted = new Promise((done) => {
    requestAborted = done;
  });
  const h = await host({
    path: '/api/zhuma-exec/events',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(req) {
      req.signal.addEventListener('abort', requestAborted, { once: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
          },
        }),
      );
    },
  });
  try {
    const client = httpRequest(h.base + '/api/zhuma-exec/events', {
      headers: { cookie: h.cookie },
    });
    client.end();
    const [response] = await once(client, 'response');
    await once(response, 'data');
    client.destroy();
    await Promise.race([
      aborted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('disconnect did not abort')), 2000).unref(),
      ),
    ]);
    await h.close();
    assert.equal(h.routes.size, 0);
  } finally {
    await h.stop();
  }
});
