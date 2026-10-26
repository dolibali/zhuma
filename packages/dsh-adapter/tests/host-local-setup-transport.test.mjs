/** Published original SDK owner transport and physical JSON/credential storage.
 * The probe route has no product mutation; this is not compiled desktop/UI proof.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import {
  applyIdentity,
  hashPassword,
  hashIdentityInitializationPassword,
  identityInitializationPasswordMatches,
  identityInject,
} from '../dist/identity-session.js';
import { configureDeploymentMode } from '../dist/member-session.js';

async function open(root) {
  const ctx = new Context();
  try {
    for (const [plugin, config] of [
      [Storage],
      [JsonStorage, { root: join(root, 'domains') }],
      [Domain, { backend: 'json' }],
      [Credentials, { path: join(root, 'credentials.yml'), watch: false }],
      [WebServer, { host: '127.0.0.1', port: 0 }],
      [Connection],
      [RemoteAccess],
    ])
      await ctx.plugin(plugin, config);
    configureDeploymentMode(ctx, 'multi-member');
    let source;
    await ctx.plugin({
      inject: [...identityInject],
      apply: (owner) =>
        applyIdentity(owner, undefined, undefined, {
          publish(handle) {
            source = handle;
            return () => {};
          },
        }),
    });
    ctx.webServer.register({
      kind: 'exact',
      path: '/',
      handler(req, res) {
        if (ctx.connection.authorizeIndex(req, res)) res.writeHead(200).end('Owned test');
      },
    });
    const base = `http://127.0.0.1:${ctx.webServer.port}`;
    const handshake = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' });
    const cookie = handshake.headers.getSetCookie()[0].split(';')[0];
    await handshake.body?.cancel();
    assert.ok(source);
    return { ctx, source, cookie, base, close: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

test('original SDK setup transport: only admitted owner reaches an exact Fetch route; cookie-only members and cross-site requests cannot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-setup-transport-'));
  const h = await open(root);
  t.after(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  const path = '/api/zhuma-local-setup-probe';
  await h.ctx.connection.fetch.register({
    path,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      assert.equal(h.ctx.connection.requestRejection({ headers: request.headers }), undefined);
      const admission = h.ctx.connection.admit({ headers: request.headers });
      assert.equal(admission.peer?.principal.kind, 'owner');
      calls++;
      return Response.json({ ready: true });
    },
  });
  for (const [headers, status] of [
    [{ origin: h.base }, 401],
    [{ cookie: h.cookie, origin: 'https://outside.example' }, 403],
  ]) {
    const response = await fetch(h.base + path, { headers });
    assert.equal(response.status, status);
    await response.body?.cancel();
  }
  // Fetch owns Host; use an actual node:http request to exercise the Host fence.
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.request(
      h.base + path,
      { headers: { host: 'outside.example', cookie: h.cookie, origin: h.base } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal(calls, 0);
  const response = await fetch(h.base + path, { headers: { cookie: h.cookie, origin: h.base } });
  assert.equal(response.status, 200);
  await response.body?.cancel();
  assert.equal(calls, 1);
  const member = h.ctx.connection.createPeer({
    principal: { kind: 'zhuma-member', memberId: 'account' },
  });
  const denied = await h.ctx.connection
    .createSharedFetchHandler('/api')
    .fetch(new Request(h.base + path), member);
  assert.equal(denied.status, 403);
  assert.equal(calls, 1);
  await member.dispose();
  const password = randomBytes(24).toString('base64url');
  const passwordHash = await hashIdentityInitializationPassword(password);
  assert.equal(await identityInitializationPasswordMatches(passwordHash, password), true);
  assert.equal(
    await identityInitializationPasswordMatches(passwordHash, 'another-password'),
    false,
  );
  await h.source.initialize({
    requestId: 'local',
    imported: { accounts: [{ id: 'account', passwordHash }] },
  });
  const login = await fetch(h.base + '/zhuma-id/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base },
    body: JSON.stringify({ accountId: 'account', password }),
  });
  assert.equal(login.status, 200);
  const memberCookie = login.headers.getSetCookie()[0].split(';')[0];
  await login.body?.cancel();
  const memberOnly = await fetch(h.base + path, {
    headers: { cookie: memberCookie, origin: h.base },
  });
  assert.equal(memberOnly.status, 401);
  await memberOnly.body?.cancel();
  assert.equal(calls, 1);
});

test('original SDK identity initialization: physical JSON survives close/reopen with its same-key receipt and never resets accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-setup-json-'));
  let h;
  try {
    const input = {
      requestId: 'disk',
      imported: {
        accounts: [
          { id: 'account', passwordHash: hashPassword(randomBytes(24).toString('base64url')) },
        ],
      },
    };
    h = await open(root);
    assert.equal(h.source.status().kind, 'unconfigured');
    await h.source.initialize(input);
    await h.close();
    assert.equal(h.source.signal.aborted, true);
    h = await open(root);
    assert.equal(h.source.status().kind, 'configured');
    assert.deepEqual(await h.source.initialize(input), { kind: 'initialized', requestId: 'disk' });
    assert.deepEqual(await h.source.initialize({ ...input, requestId: 'other' }), {
      kind: 'already-configured',
    });
    assert.deepEqual(
      [...h.ctx.storageDomain.get('zhuma_identity').table('accounts').entries()],
      [['account', input.imported.accounts[0]]],
    );
  } finally {
    await h?.close();
    await rm(root, { recursive: true, force: true });
  }
});
