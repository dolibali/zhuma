/**
 * Minimal reproduction of the DSH owner-identity limit at the published
 * Connection layer (package 0.2.1-rc.2, submodule pin 687f282).
 *
 * Real: `apply` builds BrowserAuth and HostConnectionService. `authenticatedUrl`,
 * `authorizeIndex`, `authorizeConnect`, `admit`, `createPeer`, and exact Fetch
 * dispatch are that published code. Cookies are the ones it mints.
 *
 * Simulated: no listening socket and no LocalCredentialProvider. The credential
 * store is an in-memory `modifyRecord` double, the same shape Connection's own
 * host tests use. Requests are the ConnectionIndexRequest / Fetch values those
 * methods already accept. A browser-supplied actor field is only present in
 * the exact-route body; admission never reads it.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { apply, inject } from '@deepseek-ai/dsh-client-connection';

const require = createRequire(import.meta.url);
const connectionPackage = require('@deepseek-ai/dsh-client-connection/package.json');

function memoryCredentials() {
  let record;
  return {
    async modifyRecord(_key, mutate) {
      const next = await mutate(record);
      if (next !== undefined) record = next;
      return record;
    },
  };
}

function captureResponse() {
  const state = {};
  return {
    state,
    response: {
      writeHead(status, headers) {
        state.status = status;
        if (headers !== undefined) state.headers = headers;
      },
      end(body) {
        if (body !== undefined) state.body = body;
      },
    },
  };
}

function cookiePair(setCookie) {
  const pair = setCookie.split(';', 1)[0];
  assert.ok(pair.includes('='));
  return pair;
}

function cookiePayload(setCookie) {
  const value = cookiePair(setCookie).split('=').slice(1).join('=');
  const [version, body] = value.split('.');
  assert.equal(version, 'v1');
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return parsed;
}

async function mountConnection() {
  const ctx = new Context();
  ctx.provide('credentials', memoryCredentials());
  const fiber = ctx.plugin({ inject: [...inject], apply });
  await fiber;
  return {
    connection: ctx.connection,
    dispose: () => fiber.dispose(),
  };
}

test('published connection package matches the pinned DSH release', () => {
  assert.equal(connectionPackage.version, '0.2.1-rc.2');
});

test('two browser sessions both resolve to the same owner principal', async () => {
  const { connection, dispose } = await mountConnection();
  const authority = '127.0.0.1:3080';
  const issued = [];
  for (const label of ['browser-a', 'browser-b']) {
    const target = new URL(connection.authenticatedUrl(`http://${authority}/`));
    const captured = captureResponse();
    const served = connection.authorizeIndex(
      {
        method: 'GET',
        url: `${target.pathname}${target.search}`,
        headers: { host: authority },
      },
      captured.response,
    );
    assert.equal(served, false, label);
    assert.equal(captured.state.status, 303);
    const setCookie = captured.state.headers?.['set-cookie'];
    assert.equal(typeof setCookie, 'string');
    const payload = cookiePayload(setCookie);
    assert.deepEqual(Object.keys(payload).sort(), [
      'authority',
      'expiresAt',
      'issuedAt',
      'version',
    ]);
    assert.equal(payload.version, 1);
    assert.equal(payload.authority, authority);
    assert.equal('id' in payload, false);
    assert.equal('user' in payload, false);
    assert.equal('memberId' in payload, false);
    issued.push({ label, payload, cookie: cookiePair(setCookie) });
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.notEqual(issued[0].cookie, issued[1].cookie);
  assert.notEqual(issued[0].payload.issuedAt, issued[1].payload.issuedAt);

  const admissions = issued.map((session) =>
    connection.admit({ headers: { host: authority, cookie: session.cookie } }),
  );
  assert.equal('peer' in admissions[0], true);
  assert.equal(admissions[0].peer, admissions[1].peer);
  assert.equal(admissions[0].peer, connection.browserPeer);
  assert.deepEqual(admissions[0].peer.principal, { kind: 'owner' });
  assert.deepEqual(admissions[1].peer.principal, { kind: 'owner' });
  assert.equal(admissions[0].peer.id, connection.browserPeer.id);

  const anonymous = connection.admit({
    headers: { host: authority, cookie: issued[0].cookie, 'x-actor-id': 'chen' },
  });
  assert.equal(anonymous.peer, connection.browserPeer);

  const calls = [];
  connection.fetch.register({
    path: '/api/zhuma/who',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request, peer) => {
      calls.push({
        actorId: (await request.json()).actorId,
        peerKind: peer?.principal?.kind,
      });
      return Response.json({ ok: true });
    },
  });
  const shared = connection.createSharedFetchHandler('/api');
  for (const actorId of ['lin', 'chen']) {
    const response = await shared.fetch(
      new Request('http://127.0.0.1:3080/api/zhuma/who', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorId }),
      }),
      admissions[0].peer,
    );
    assert.equal(response.status, 200);
  }
  assert.deepEqual(
    calls.map((call) => call.peerKind),
    [undefined, undefined],
  );
  assert.deepEqual(
    calls.map((call) => call.actorId),
    ['lin', 'chen'],
  );

  const member = connection.createPeer({
    principal: { kind: 'zhuma-member', memberId: 'chen' },
  });
  assert.notEqual(member.id, connection.browserPeer.id);
  assert.deepEqual(member.principal, { kind: 'zhuma-member', memberId: 'chen' });
  const refused = await shared.fetch(
    new Request('http://127.0.0.1:3080/api/zhuma/who', { method: 'POST' }),
    member,
  );
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 2);
  await member.dispose();

  const missing = connection.admit({ headers: { host: authority } });
  assert.deepEqual(missing, { rejection: 401 });
  await dispose();
});

test('API connect cookies carry a peer id and still mint owner principals', async () => {
  const { connection, dispose } = await mountConnection();
  const authority = '127.0.0.1:3080';
  const token = new URL(connection.authenticatedUrl(`http://${authority}/`)).searchParams.get(
    'token',
  );
  const peers = [];
  for (let index = 0; index < 2; index += 1) {
    const captured = captureResponse();
    connection.authorizeConnect(
      {
        method: 'GET',
        url: `/connect?token=${token}`,
        headers: { host: authority },
      },
      captured.response,
    );
    assert.equal(captured.state.status, 302);
    const setCookie = captured.state.headers?.['set-cookie'];
    const value = cookiePair(setCookie).split('=').slice(1).join('=');
    const [version, body] = value.split('.');
    assert.equal(version, 'v2');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    assert.equal(typeof payload.id, 'string');
    assert.equal('memberId' in payload, false);
    assert.equal('user' in payload, false);
    const admission = connection.admit({
      headers: { host: authority, cookie: cookiePair(setCookie) },
    });
    assert.equal(admission.peer.principal.kind, 'owner');
    assert.deepEqual(admission.peer.principal, { kind: 'owner' });
    peers.push(admission.peer);
  }
  assert.notEqual(peers[0].id, peers[1].id);
  assert.notEqual(peers[0].id, connection.browserPeer.id);
  await dispose();
});
