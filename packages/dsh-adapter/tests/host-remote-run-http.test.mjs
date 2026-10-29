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
import {
  REMOTE_RUN_UPLOAD_MEDIA_TYPE,
  encodeRemoteRunUploadPrefix,
} from '../dist/remote-run-file-transport.js';
import { publicationEnvelope } from './remote-run-file-transport-fixture.mjs';
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
  let consume;
  const service = {
    async remoteRun(request, body, permit, upload) {
      const call = { request, body, permit, upload };
      calls.push(call);
      if (consume) await consume(call);
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
    consumeUpload: (handler) => {
      consume = handler;
    },
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

test('publish HTTP delegates raw file bytes after member/framing gates and keeps early replies intact', async () => {
  const h = await host();
  try {
    const bytes = Buffer.from([0, 255, 128, 10, 13]),
      envelope = publicationEnvelope(bytes);
    const url = `${h.base}/api/${MEMBER_LOCAL_REMOTE_METHODS['publish-file']}`;
    const headers = {
      'content-type': REMOTE_RUN_UPLOAD_MEDIA_TYPE,
      [REMOTE_RUN_PERMIT_HEADER]: 'private-proof',
    };
    const framed = Buffer.concat([encodeRemoteRunUploadPrefix(envelope), bytes]);
    assert.equal((await fetch(url, { method: 'POST', headers, body: framed })).status, 401);
    assert.equal(h.calls.length, 0);
    let actual;
    h.consumeUpload(async ({ upload, body, permit }) => {
      assert.equal(body.operation, 'publish-file');
      assert.equal(body.payload.mode, 'publish');
      assert.equal(permit, 'private-proof');
      const chunks = [];
      for await (const value of upload.data) chunks.push(value);
      actual = Buffer.concat(chunks);
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, cookie: h.cookie },
      body: framed,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(actual, bytes);
    assert.equal((await response.json()).rpcId, envelope.rpcId);
    // Original domain may answer a replay/error without consuming the body.
    h.consumeUpload(() => {});
    const early = await fetch(url, {
      method: 'POST',
      headers: { ...headers, cookie: h.cookie },
      body: framed,
    });
    assert.equal(early.status, 200);
    assert.equal((await early.json()).result.error.code, 'remote-protocol-unsupported');
    // A transport interrupt while a client is still sending a large body is an
    // unknown ACK, never evidence that the domain did not receive the command.
    const bulk = await fetch(url, {
      method: 'POST',
      headers: { ...headers, cookie: h.cookie },
      body: Buffer.concat([encodeRemoteRunUploadPrefix(envelope), Buffer.alloc(2 * 1024 * 1024)]),
    }).then(
      async (response) => ({ status: response.status, result: await response.json() }),
      (error) => {
        assert.ok(error instanceof TypeError);
        return { unknown: true };
      },
    );
    if (!bulk.unknown) {
      assert.equal(bulk.status, 200);
      assert.equal(bulk.result.result.error.code, 'remote-protocol-unsupported');
    }
  } finally {
    await h.close();
  }
});

test('publish HTTP rejects malformed/wrong-operation frames before domain or file consumer', async () => {
  const h = await host();
  try {
    const envelope = publicationEnvelope();
    const url = `${h.base}/api/${MEMBER_LOCAL_REMOTE_METHODS['publish-file']}`;
    const raw = { ...envelope, method: 'zhuma-remote-run/info' },
      data = Buffer.from(JSON.stringify(raw)),
      size = Buffer.alloc(4);
    size.writeUInt32BE(data.byteLength);
    for (const body of [Buffer.alloc(4), Buffer.from([0, 0]), Buffer.concat([size, data])]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { cookie: h.cookie, 'content-type': REMOTE_RUN_UPLOAD_MEDIA_TYPE },
        body,
      });
      assert.equal(response.status, 400);
    }
    assert.equal((await h.post('publish-file', envelope.payload, { member: true })).status, 400);
    assert.equal(
      (
        await fetch(`${h.base}/api/${MEMBER_LOCAL_REMOTE_METHODS.info}`, {
          method: 'POST',
          headers: { cookie: h.cookie, 'content-type': REMOTE_RUN_UPLOAD_MEDIA_TYPE },
          body: new Uint8Array([1]),
        })
      ).status,
      415,
    );
    assert.equal(h.calls.length, 0);
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

test('remote HTTP: canonical review purpose uses the existing routes and preserves independent cleanup admission', async () => {
  const h = await host();
  try {
    const request = cleanup(),
      scope = request.payload.scope;
    const review = {
      purpose: 'review',
      ...request,
      payload: {
        ...request.payload,
        scope: {
          ...scope,
          review: {
            target: {
              spaceId: scope.spaceId,
              taskId: scope.taskId,
              planId: scope.planId,
              revision: scope.revision,
              nodeId: scope.nodeId,
              roundId: 'fixed-round',
              artifactVersionId: 'fixed-artifact',
              artifactFingerprint: 'c'.repeat(64),
            },
            principal: {
              kind: 'expert',
              controllerMemberId: scope.actorId,
              reviewerRef: { id: 'reviewer', version: scope.planId, digest: 'd'.repeat(64) },
            },
          },
        },
      },
    };
    const response = await h.post('cleanup', review);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.error.code, 'remote-protocol-unsupported');
    assert.deepEqual(h.calls[0].body, review, 'The original D decoder remains authoritative');
    const status = {
      ...review,
      operation: 'status',
      payload: { scope: review.payload.scope, permit: review.payload.permit },
    };
    assert.equal((await h.post('status', status)).status, 401);
    assert.equal(h.calls.length, 1);
    assert.equal((await h.post('status', status, { member: true })).status, 200);
    assert.equal(h.calls.length, 2);
  } finally {
    await h.close();
  }
});
