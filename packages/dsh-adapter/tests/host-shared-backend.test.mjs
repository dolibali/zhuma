/** Original Credentials persistence + bounded remote HTTP fixtures. No existing profile/model/GUI. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { HostSharedBackend } from '../dist/host-shared-backend.js';
import { mountHostSharedBackend } from '../dist/host-shared-backend-http.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-backend-private-'));
  const filename = join(directory, 'synthetic.yaml'),
    calls = [];
  let backendId = randomUUID(),
    expired = false,
    pending;
  const cookies = new Map();
  const remote = async (input, init) => {
    const url = new URL(input),
      headers = new Headers(init.headers),
      body = init.body && JSON.parse(init.body);
    calls.push({ url: url.href, headers, init, body });
    assert.equal(init.redirect, 'error');
    assert.equal(headers.get('origin'), url.origin);
    assert.equal(headers.has('authorization'), false);
    assert.notEqual(headers.get('cookie')?.includes('dsh-'), true);
    if (url.pathname === '/zhuma-id/login') {
      const cookie = `zhuma-member=synthetic-${randomUUID()}`;
      cookies.set(cookie, body.accountId);
      if (pending) return pending.promise;
      return Response.json(
        { ok: true, accountId: body.accountId },
        { headers: { 'set-cookie': `${cookie}; HttpOnly; SameSite=Strict; Path=/` } },
      );
    }
    if (url.pathname === '/zhuma-id/register')
      return Response.json(
        {
          ok: true,
          value: {
            accountId: body.accountId,
            personalSpaceId: `personal-${body.accountId}`,
            disposition: 'created',
          },
        },
        { status: 201 },
      );
    const actorId = expired ? undefined : cookies.get(headers.get('cookie'));
    if (!actorId) return Response.json({ ok: false }, { status: 401 });
    if (url.pathname === '/api/zhuma-remote-run/info')
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            protocolVersion: 1,
            backendId,
            actorId,
            serverTime: Date.now(),
            purposes: ['work'],
            operations: ['info'],
          },
        },
      });
    if (url.pathname === '/zhuma-id/session')
      return Response.json({
        ok: true,
        accountId: actorId,
        principal: { kind: 'zhuma-member', memberId: actorId },
        peerId: 'synthetic-member',
        spaces: [],
      });
    if (url.pathname === '/zhuma-id/logout')
      return Response.json(
        { ok: true, accountId: actorId },
        { headers: { 'set-cookie': 'zhuma-member=; Max-Age=0; Path=/' } },
      );
    if (url.pathname === '/zhuma-id/password')
      return Response.json({ ok: false, error: 'invalid-login' }, { status: 401 });
    return Response.json({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { actorId, echo: body.payload } },
    });
  };
  const contexts = [],
    owners = [];
  async function open() {
    const ctx = new Context(),
      provider = ctx.plugin(Credentials, { path: filename, watch: false });
    await provider;
    contexts.push(provider);
    const owner = new HostSharedBackend(ctx, remote);
    owners.push(owner);
    return { ctx, owner, provider };
  }
  const initial = await open();
  t.after(async () => {
    for (const owner of owners) await owner.close();
    for (const provider of contexts.toReversed()) await provider.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  async function selected() {
    return initial.owner.select({
      requestId: randomUUID(),
      expectedConnectionId: null,
      origin: 'http://backend.example:3080',
    });
  }
  const request = (selection, operation, payload = {}, extra = {}) =>
    initial.owner.request(
      { connectionId: selection.connectionId, operation, payload, ...extra },
      new AbortController().signal,
    );
  return {
    ...initial,
    calls,
    cookies,
    filename,
    open,
    selected,
    request,
    expire: () => {
      expired = true;
    },
    replaceBackend: () => {
      backendId = randomUUID();
    },
    delay: () => (pending = Promise.withResolvers()),
  };
}

test('shared backend confines fixed methods, persists only original member Cookie privately and cold reads exact origin/identity', async (t) => {
  const h = await fixture(t);
  assert.deepEqual(await h.owner.status(), {
    origin: null,
    connectionId: null,
    backendId: null,
    actorId: null,
  });
  const selection = await h.selected();
  assert.equal(h.calls.length, 0, 'select does not perform login/owner exchange');
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const status = await h.owner.status();
  assert.equal(status.actorId, 'ann');
  assert.ok(status.backendId);
  assert.equal('cookie' in status, false);
  const read = await h.request(
    selection,
    'member.snapshot',
    { spaceId: 'north' },
    { rpcId: randomUUID() },
  );
  assert.equal(read.body.result.value.actorId, 'ann');
  assert.equal(JSON.stringify(read).includes('synthetic-'), false);
  assert.ok(h.calls.every((call) => call.url.startsWith('http://backend.example:3080/')));
  assert.ok(
    h.calls.every(
      (call) =>
        call.url.includes('/zhuma-id/') ||
        call.url.includes('/api/zhuma-member/') ||
        call.url.includes('/api/zhuma-remote-run/info'),
    ),
  );
  assert.equal((await stat(h.filename)).mode & 0o077, 0);
  await h.owner.close();
  await h.provider.dispose();
  const cold = await h.open();
  assert.deepEqual(await cold.owner.status(), status);
  const connection = await cold.owner.nativeConnection(new AbortController().signal);
  const headers = new Headers(await connection.authentication(new AbortController().signal));
  assert.ok(h.cookies.has(headers.get('cookie')));
  await h
    .request(selection, 'identity.session')
    .catch((error) => assert.equal(error.name, 'AbortError'));
});

test('shared backend rejects arbitrary routes, actor injection and malformed origin before network or unrelated credential reads', async (t) => {
  const h = await fixture(t);
  for (const origin of [
    'file:///etc/passwd',
    'http://a.example/path',
    'http://user:password@a.example',
    'http://a.example/?x=1',
  ])
    await assert.rejects(
      h.owner.select({ requestId: randomUUID(), expectedConnectionId: null, origin }),
    );
  const selection = await h.selected();
  for (const change of [
    { operation: 'session/send' },
    { operation: 'member.snapshot', payload: { spaceId: 'north', actorId: 'other' } },
    { operation: 'identity.session', route: '/api/session/send' },
    { operation: 'identity.session', headers: { cookie: 'injected' } },
  ])
    await assert.rejects(
      h.owner.request(
        {
          connectionId: selection.connectionId,
          operation: 'identity.session',
          payload: {},
          ...change,
        },
        new AbortController().signal,
      ),
    );
  assert.equal(h.calls.length, 0);
});

test('shared backend carries original manual submission, draft, review and accepted-input requests without authority overrides', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const target = { taskId: 'task', planId: 'plan', revision: 1, nodeId: 'write' };
  const command = { ...target, expectedVersion: 0, idempotencyKey: 'same-intent' };
  const cases = [
    [
      'start-plan',
      { taskId: 'task', planId: 'plan', revision: 1, idempotencyKey: 'start', spaceId: 'north' },
    ],
    ['submit', { ...command, text: 'fixed text', links: [], files: [] }],
    [
      'ballot',
      {
        ...command,
        roundId: 'round',
        artifactVersionId: 'artifact',
        action: 'request-changes',
        comment: 'revise this section',
      },
    ],
    ['revision', target],
    [
      'upstream-content',
      { ...target, spaceId: 'north', sourceNodeId: 'source', artifactVersionId: 'accepted-v1' },
    ],
    ['draft', target],
    ['draft', { ...command, text: 'retained draft', links: [], files: [] }],
  ];
  for (const [endpoint, payload] of cases) {
    const rpcId = randomUUID();
    const result = await h.request(selection, `execution.${endpoint}`, payload, { rpcId });
    assert.deepEqual(result.body.result.value.echo, payload);
    assert.equal(result.body.rpcId, rpcId);
    const call = h.calls.at(-1);
    assert.equal(call.url, `http://backend.example:3080/api/zhuma-exec/${endpoint}`);
    assert.equal(call.body.method, `zhuma-exec/${endpoint}`);
    for (const field of ['actorId', 'memberId', 'reviewerId', 'route', 'headers']) {
      const before = h.calls.length;
      await assert.rejects(
        h.request(selection, `execution.${endpoint}`, { ...payload, [field]: 'forged' }, { rpcId }),
      );
      assert.equal(h.calls.length, before, 'original strict schema rejects before remote dispatch');
    }
  }
});

test('shared manual draft carrier retains the original encoded text budget without a one-mebibyte response truncation', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  // Original strict-schema envelope budget only. The actual backend still owns
  // file existence, metadata and draft-total semantic checks.
  const payload = {
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'write',
    expectedVersion: 0,
    idempotencyKey: 'retained-encoded-draft',
    text: '\u0001'.repeat(100_000),
    links: [],
    files: Array.from({ length: 20 }, (_, index) => ({
      id: String(index) + '\u0001'.repeat(1500),
      mediaType: '\u0001'.repeat(1500),
      byteSize: 0,
      checksum: '\u0001'.repeat(1500),
      accessPolicyId: '\u0001'.repeat(1500),
      uploadComplete: false,
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024);
  const value = await h.request(selection, 'execution.draft', payload, { rpcId: randomUUID() });
  assert.deepEqual(value.body.result.value.echo, payload);
});

test('shared backend registration preserves the original separate registration then login flow without requiring Set-Cookie', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  const registered = await h.request(selection, 'identity.register', {
    requestId: randomUUID(),
    accountId: 'ann',
    password: 'synthetic-only',
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.value.accountId, 'ann');
  assert.equal((await h.owner.status()).actorId, null);
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  assert.equal((await h.owner.status()).actorId, 'ann');
});

test('shared backend fences late login after connection replacement and never stores its Cookie', async (t) => {
  const h = await fixture(t),
    selection = await h.selected(),
    pending = h.delay();
  const login = h.request(selection, 'identity.login', {
    accountId: 'ann',
    password: 'synthetic-only',
  });
  while (!h.calls.length) await new Promise(setImmediate);
  const next = await h.owner.select({
    requestId: randomUUID(),
    expectedConnectionId: selection.connectionId,
    origin: 'http://other.example',
  });
  pending.resolve(
    Response.json(
      { ok: true, accountId: 'ann' },
      { headers: { 'set-cookie': 'zhuma-member=late-private; HttpOnly' } },
    ),
  );
  await assert.rejects(login, { code: 'changed' });
  assert.deepEqual(await h.owner.status(), next);
  assert.equal(h.calls.length, 1);
});

test('shared backend binds current remote backend identity and preserves expired-member 401 without a business request', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  h.replaceBackend();
  const before = h.calls.length;
  await assert.rejects(
    h.request(selection, 'member.snapshot', { spaceId: 'north' }, { rpcId: randomUUID() }),
    { code: 'identity-changed' },
  );
  assert.equal(h.calls.length, before + 1);
  h.expire();
  assert.equal(
    (await h.request(selection, 'member.snapshot', { spaceId: 'north' }, { rpcId: randomUUID() }))
      .status,
    401,
  );
});

test('shared backend selection same request survives a lost reply but rejects a changed retry', async (t) => {
  const h = await fixture(t),
    input = {
      requestId: randomUUID(),
      expectedConnectionId: null,
      origin: 'http://backend.example:3080',
    };
  const first = await h.owner.select(input);
  assert.deepEqual(await h.owner.select(input), first);
  await assert.rejects(h.owner.select({ ...input, origin: 'http://other.example' }), {
    code: 'changed',
  });
  assert.deepEqual(await h.owner.status(), first);
});

test('shared backend wrong password does not invalidate an existing private native connection', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const native = await h.owner.nativeConnection(new AbortController().signal);
  const before = await native.authentication(new AbortController().signal);
  const reply = await h.request(selection, 'identity.password', {
    oldPassword: 'wrong-synthetic',
    newPassword: 'new-synthetic-password',
  });
  assert.equal(reply.status, 401);
  assert.deepEqual(await native.authentication(new AbortController().signal), before);
  assert.equal((await h.owner.status()).actorId, 'ann');
});

test('shared backend exact HTTP routes retain actual SDK local owner admission and never publish a member Web endpoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-backend-owner-http-'));
  const ctx = new Context(),
    fibers = [];
  const load = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  };
  t.after(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await load(Credentials, { path: join(directory, 'synthetic.yaml'), watch: false });
  await load(WebServer, { host: '127.0.0.1', port: 0 });
  await load(Connection);
  await load(RemoteAccess);
  const source = ctx.plugin({ inject: ['connection'], apply: mountHostSharedBackend });
  fibers.push(source);
  await source;
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const removeIndex = ctx.webServer.register({
    kind: 'exact',
    path: '/',
    handler(req, res) {
      if (ctx.connection.authorizeIndex(req, res))
        res.writeHead(200).end('Synthetic local owner entry');
    },
  });
  t.after(removeIndex);
  const call = (cookie, endpoint, payload) =>
    fetch(`${origin}/api/zhuma-backend/${endpoint}`, {
      method: 'POST',
      headers: { origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: `zhuma-backend/${endpoint}`,
        payload,
      }),
      redirect: 'error',
    });
  assert.equal((await call(undefined, 'status', {})).status, 401);
  assert.equal((await call('zhuma-member=synthetic-not-owner', 'status', {})).status, 401);
  // Local owner bootstrap only; there is no remote owner exchange in this path.
  const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = exchange.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
  await exchange.body?.cancel();
  assert.ok(cookie);
  const reply = await call(cookie, 'status', {});
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('set-cookie'), null);
  const data = await reply.json();
  assert.equal(data.result.ok, true);
  assert.equal(data.result.value.origin, null);
  const selected = await call(cookie, 'select', {
    requestId: randomUUID(),
    expectedConnectionId: null,
    origin: 'http://backend.example:3080',
  });
  const value = await selected.json();
  assert.equal(value.result.ok, true);
  assert.deepEqual(Object.keys(value.result.value).sort(), [
    'actorId',
    'backendId',
    'connectionId',
    'origin',
  ]);
});
