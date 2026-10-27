/** Published original SDK owner transport and physical JSON/credential storage.
 * The probe route has no product mutation; this is not compiled desktop/UI proof.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
import { applySpaceDirectory, spaceDirectoryFor } from '../dist/space-directory.js';

async function open(root, options = {}) {
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
    if (options.directory)
      await ctx.plugin({
        inject: ['storageDomain'],
        apply: (owner) =>
          applySpaceDirectory(owner, undefined, {
            allowPendingInitialization: options.allowPending === true,
          }),
      });
    let source;
    await ctx.plugin({
      inject: [...identityInject],
      apply: (owner) =>
        applyIdentity(owner, undefined, undefined, {
          beforeComplete: options.beforeComplete,
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

const setupPhase = process.env.ZHUMA_IDENTITY_SETUP_PHASE;
const accountSetup = () => ({
  requestId: 'isolated-first-setup',
  accountId: 'first-member',
  password: 'only-a-fake-first-configuration-password',
  setupFingerprint: 'c'.repeat(64),
  setupContext: {
    schemaVersion: 1,
    teamCatalog: [
      { spaceId: 'team-first', packs: [{ id: 'zhuma-work-planning', version: '1.0.0' }] },
    ],
  },
  directory: {
    spaces: [
      { id: 'personal-first', kind: 'personal', name: 'Personal' },
      { id: 'team-first', kind: 'team', name: 'Team' },
    ],
    memberships: [
      { spaceId: 'personal-first', accountId: 'first-member' },
      { spaceId: 'team-first', accountId: 'first-member' },
    ],
  },
});
if (setupPhase) {
  test('original SDK first setup phase: physical partial initialization is recovered only by its exact original plan', async () => {
    const root = process.env.ZHUMA_IDENTITY_SETUP_HOME,
      fault = process.env.ZHUMA_IDENTITY_SETUP_FAULT;
    assert.ok(root);
    const input = accountSetup();
    let catalogCalls = 0;
    const h = await open(root, {
      directory: true,
      allowPending: true,
      beforeComplete(value) {
        catalogCalls++;
        assert.equal(value.setupFingerprint, input.setupFingerprint);
        assert.deepEqual(value.setupContext, input.setupContext);
        assert.equal(spaceDirectoryFor(h.ctx).isMember('team-first', input.accountId), true);
        assert.equal(h.ctx.storageDomain.get('zhuma_identity').global.get().importComplete, false);
        return undefined; // Explicit approved catalog-source contract, not production catalog proof.
      },
    });
    try {
      const identity = h.ctx.storageDomain.get('zhuma_identity');
      if (setupPhase === 'producer') {
        const target =
          fault === 'account'
            ? identity.table('accounts')
            : h.ctx.storageDomain.get('zhuma_spaces').table('memberships');
        const put = target.put;
        target.put = async () => {
          throw Error('isolated first-configuration durability failure');
        };
        await assert.rejects(h.source.initializeAccount(input), { code: 'unavailable' });
        target.put = put;
        const marker = identity.global.get();
        assert.equal(marker.importComplete, false);
        assert.equal(marker.initialization.phase, 'writing');
        const verifier = marker.initialization.setup.passwordHash;
        assert.match(verifier, /^scrypt\$/u);
        if (fault === 'account') assert.equal(identity.table('accounts').size, 0);
        else {
          assert.equal(identity.table('accounts').get(input.accountId).passwordHash, verifier);
          assert.equal(spaceDirectoryFor(h.ctx).initializationStatus().kind, 'pending');
          assert.throws(() => spaceDirectoryFor(h.ctx).spacesForMember(input.accountId), {
            code: 'unavailable',
          });
        }
        assert.equal(catalogCalls, 0);
        await writeFile(
          join(root, 'setup-producer.json'),
          JSON.stringify({ pid: process.pid, fault, verifier }),
        );
        return;
      }
      assert.equal(setupPhase, 'consumer');
      const producer = JSON.parse(await readFile(join(root, 'setup-producer.json'), 'utf8'));
      assert.notEqual(producer.pid, process.pid);
      const login = (password) =>
        fetch(h.base + '/zhuma-id/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: h.base },
          body: JSON.stringify({ accountId: input.accountId, password }),
        });
      const blocked = await login(input.password);
      assert.equal(blocked.status, 503);
      await blocked.body?.cancel();
      const before = await readFile(join(root, 'domains', 'zhuma_identity.json'), 'utf8');
      await assert.rejects(
        h.source.initializeAccount({ ...input, password: 'incorrect-resume-password' }),
        { code: 'conflict' },
      );
      await assert.rejects(
        h.source.initializeAccount({ ...input, setupFingerprint: 'd'.repeat(64) }),
        { code: 'conflict' },
      );
      assert.equal(await readFile(join(root, 'domains', 'zhuma_identity.json'), 'utf8'), before);
      const result = await h.source.initializeAccount(input);
      assert.deepEqual(result, { kind: 'initialized', requestId: input.requestId });
      assert.equal(identity.table('accounts').get(input.accountId).passwordHash, producer.verifier);
      assert.equal(identity.global.get().initialization.setup.passwordHash, undefined);
      assert.deepEqual(h.source.readSetup(), {
        requestId: input.requestId,
        setupFingerprint: input.setupFingerprint,
        setupContext: input.setupContext,
      });
      assert.equal(spaceDirectoryFor(h.ctx).isMember('team-first', input.accountId), true);
      assert.equal(catalogCalls, 1);
      const admitted = await login(input.password);
      assert.equal(admitted.status, 200);
      const body = await admitted.text();
      assert.equal(body.includes(input.password), false);
      assert.equal(body.includes('scrypt$'), false);
      assert.equal(body.includes('setupContext'), false);
      assert.equal(body.includes('teamCatalog'), false);
      const owner = await fetch(h.base + '/zhuma-id/session', {
        headers: { cookie: h.cookie, origin: h.base },
      });
      assert.equal(owner.status, 401);
      await owner.body?.cancel();
      await writeFile(
        join(root, 'setup-consumer.json'),
        JSON.stringify({
          producerPid: producer.pid,
          consumerPid: process.pid,
          fault,
          catalogCalls,
          stableVerifier: true,
          normalLogin: 200,
          ownerProductSession: 401,
        }),
      );
    } finally {
      await h.close();
    }
  });
} else {
  test('original SDK first setup: two new OS processes resume marker-only and directory-partial JSON with the same private verifier', async () => {
    for (const fault of ['account', 'directory']) {
      const root = await mkdtemp(join(tmpdir(), 'zhuma-first-setup-process-'));
      try {
        for (const phase of ['producer', 'consumer']) {
          // A nested Node test process must be a new runner, not inherit the
          // parent's internal worker protocol and silently discover zero cases.
          const environment = { ...process.env };
          delete environment.NODE_TEST_CONTEXT;
          const child = spawnSync(
            process.execPath,
            [
              '--test',
              '--test-name-pattern=^original SDK first setup phase:',
              import.meta.filename,
            ],
            {
              env: {
                ...environment,
                ZHUMA_IDENTITY_SETUP_PHASE: phase,
                ZHUMA_IDENTITY_SETUP_HOME: root,
                ZHUMA_IDENTITY_SETUP_FAULT: fault,
              },
              encoding: 'utf8',
              timeout: 30000,
              maxBuffer: 1024 * 1024,
            },
          );
          assert.equal(child.status, 0, `${fault}/${phase}: ${child.stdout}\n${child.stderr}`);
        }
        const proof = JSON.parse(await readFile(join(root, 'setup-consumer.json'), 'utf8'));
        assert.notEqual(proof.producerPid, proof.consumerPid);
        assert.equal(proof.stableVerifier, true);
        assert.equal(proof.catalogCalls, 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
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
