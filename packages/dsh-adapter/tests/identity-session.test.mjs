/**
 * Feasibility spike for member sessions on the published DSH seams.
 *
 * Real: client-connection `apply` (BrowserAuth, admit, browserPeer, createPeer)
 * and storage-domain `DomainFacility` (schema check and the write chain).
 * `applyIdentity` registers the prefix route, the credential secret, and the
 * zhuma-member policy, then serves login, session, space, and note calls.
 *
 * Simulated for most cases, because these packages are not dependencies of
 * @zhuma/dsh-adapter: `webServer.register` is an in-memory matcher with the
 * same exact-then-longest-prefix rule; one case listens with `node:http`.
 * Chromium coverage lives in `tests/browser/identity-session.spec.mjs`.
 * `credentials.modifyRecord` is a keyed memory map; the KV medium is a memory
 * map behind DomainFacility; `decide`
 * implements the owner-allow and policy-condition rules from
 * dsh-api-remote-access, and then calls the policy this module registered.
 * The published RemoteAccessService class is not loaded.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
  apply as applyConnection,
  inject as connectionInject,
} from '@deepseek-ai/dsh-client-connection';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { applyIdentity, hashPassword, identityInject } from '../dist/identity-session.js';
import { resolveMember } from '../dist/member-session.js';

const AUTHORITY = '127.0.0.1:3080';

function randomPassword() {
  return randomBytes(24).toString('base64url');
}

const passwords = {
  lin: randomPassword(),
  zhao: randomPassword(),
  chen: randomPassword(),
};

const NOTES = [
  {
    id: 'north-note',
    spaceId: 'team-north',
    ownerId: 'lin',
    teamMemberIds: ['lin', 'zhao'],
    text: 'north-initial',
  },
  {
    id: 'south-note',
    spaceId: 'team-south',
    ownerId: 'chen',
    teamMemberIds: ['chen'],
    text: 'south-initial',
  },
];

function fixtureImport() {
  return {
    accounts: Object.entries(passwords).map(([id, password]) => ({
      id,
      passwordHash: hashPassword(password),
    })),
    notes: NOTES,
  };
}

function memoryCredentials(records = new Map()) {
  return {
    records,
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    },
  };
}

function memoryKv(media = new Map()) {
  return {
    media,
    async open(descriptor) {
      let medium = media.get(descriptor.name);
      if (medium === undefined) {
        medium = { tables: new Map(), global: null };
        media.set(descriptor.name, medium);
      }
      let closed = false;
      return {
        async loadAll() {
          if (closed) throw new Error('closed');
          const tables = {};
          for (const table of descriptor.tables) {
            tables[table] = Object.fromEntries(medium.tables.get(table) ?? []);
          }
          return { tables, global: medium.global };
        },
        async putRecord(table, key, value) {
          if (closed) throw new Error('closed');
          const records = medium.tables.get(table) ?? new Map();
          medium.tables.set(table, records);
          records.set(key, structuredClone(value));
        },
        async deleteRecord(table, key) {
          if (closed) throw new Error('closed');
          medium.tables.get(table)?.delete(key);
        },
        async setGlobal(value) {
          if (closed) throw new Error('closed');
          medium.global = structuredClone(value);
        },
        async close() {
          closed = true;
        },
      };
    },
  };
}

function createWebServer() {
  const exact = new Map();
  const prefixes = new Map();
  return {
    protocol: 'http:',
    host: '127.0.0.1',
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes;
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`);
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    async dispatch(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      let route = exact.get(pathname);
      if (route === undefined) {
        for (const [prefix, candidate] of prefixes) {
          if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
          if (route === undefined || prefix.length > route.path.length) route = candidate;
        }
      }
      if (route === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      await route.handler(req, res);
    },
  };
}

function createAccess() {
  const policies = new Map();
  return {
    registerPolicy(kind, policy) {
      if (kind === 'owner') throw new Error('owner kind cannot have a policy');
      if (policies.has(kind)) throw new Error(`duplicate policy ${kind}`);
      policies.set(kind, policy);
      return () => {
        policies.delete(kind);
      };
    },
    decide(request) {
      if (request.principal.kind === 'owner') return { kind: 'allow' };
      const policy = policies.get(request.principal.kind);
      if (policy === undefined) return { kind: 'deny', reason: 'no-allow' };
      let bindings;
      try {
        bindings = policy.bindings(request.principal);
      } catch {
        return { kind: 'deny', reason: 'policy-failed' };
      }
      for (const resource of request.resources) {
        let allowed = false;
        let refusal;
        for (const binding of bindings) {
          if (binding.resource.kind !== resource.kind || binding.resource.id !== resource.id)
            continue;
          if (!binding.role.actions.includes(request.action)) continue;
          if (binding.condition === undefined) {
            allowed = true;
            break;
          }
          let decision;
          try {
            decision = binding.condition({
              action: request.action,
              resource,
              ...(request.args === undefined ? {} : { args: request.args }),
            });
          } catch {
            return { kind: 'deny', reason: 'policy-failed' };
          }
          if (decision.kind === 'allow') {
            allowed = true;
            break;
          }
          refusal ??= decision;
        }
        if (!allowed) return refusal ?? { kind: 'deny', reason: 'no-allow' };
      }
      return { kind: 'allow' };
    },
  };
}

function captureResponse() {
  const state = {};
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(status, headers) {
      state.status = status;
      if (headers !== undefined) state.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body) {
      if (body !== undefined) state.body = body;
      this.writableEnded = true;
      return this;
    },
  });
  return { state, response };
}

function cookiePair(setCookie) {
  assert.equal(typeof setCookie, 'string');
  return setCookie.split(';', 1)[0];
}

async function mount(shared = {}) {
  const credentials = shared.credentials ?? memoryCredentials();
  const kv = memoryKv(shared.media);
  const web = createWebServer();
  const access = createAccess();
  const ctx = new Context();
  ctx.provide('credentials', credentials);
  ctx.provide('webServer', web);
  ctx.provide('remoteAccess', access);
  ctx.provide('storage', {
    backend: {
      get(name) {
        if (name !== 'memory') throw new Error(`unknown backend ${name}`);
        return { kv, close: async () => {} };
      },
    },
  });
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'memory', routes: {} }));
  if (shared.hashProbe !== undefined) ctx.provide('zhumaIdentityHashProbe', shared.hashProbe);
  const connectionFiber = ctx.plugin({ inject: [...connectionInject], apply: applyConnection });
  await connectionFiber;
  const identityFiber = ctx.plugin(
    { inject: [...identityInject], apply: applyIdentity },
    shared.imported === undefined ? fixtureImport() : shared.imported,
  );
  try {
    await identityFiber;
  } catch (error) {
    await identityFiber.dispose().catch(() => {});
    await connectionFiber.dispose();
    throw error;
  }
  return {
    ctx,
    web,
    access,
    connection: ctx.connection,
    credentials,
    media: kv.media,
    dispose: async () => {
      await identityFiber.dispose();
      await connectionFiber.dispose();
    },
  };
}

async function call(web, { method, path, cookie, body, headers: extra, remoteAddress }) {
  const headers = { host: AUTHORITY, ...(extra ?? {}) };
  if (cookie !== undefined) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    { method, url: path, headers },
  );
  if (remoteAddress !== undefined) req.socket = { remoteAddress };
  const captured = captureResponse();
  await web.dispatch(req, captured.response);
  return {
    status: captured.state.status,
    headers: captured.state.headers,
    json: captured.state.body === undefined ? undefined : JSON.parse(captured.state.body),
  };
}

function ownerCookie(connection) {
  const target = new URL(connection.authenticatedUrl(`http://${AUTHORITY}/`));
  const captured = captureResponse();
  const served = connection.authorizeIndex(
    {
      method: 'GET',
      url: `${target.pathname}${target.search}`,
      headers: { host: AUTHORITY },
    },
    captured.response,
  );
  assert.equal(served, false);
  return cookiePair(captured.state.headers?.['set-cookie']);
}

async function login(web, accountId) {
  const password = passwords[accountId];
  assert.equal(typeof password, 'string');
  const response = await call(web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: randomBytes(8).toString('hex'),
    body: { accountId, password },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.accountId, accountId);
  return cookiePair(response.headers?.['set-cookie']);
}

test('shipping source has no built-in account or password', () => {
  const files = [
    '../src/identity-session.ts',
    '../src/member-session.ts',
    '../src/login-limiter.ts',
    '../dist/identity-session.js',
    '../dist/member-session.js',
    '../dist/login-limiter.js',
  ];
  for (const rel of files) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.equal(text.includes('PRESET_ACCOUNTS'), false);
    assert.equal(text.includes('preset' + '-'), false);
    assert.equal(text.includes('OWNER_ACCOUNT_ID'), false);
  }
});

test('applyIdentity without an import writes no account', async () => {
  const host = await mount({ imported: null });
  const accounts = host.media.get('zhuma_identity')?.tables.get('accounts');
  const notes = host.media.get('zhuma_identity')?.tables.get('notes');
  assert.equal(accounts?.size ?? 0, 0);
  assert.equal(notes?.size ?? 0, 0);
  const refused = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    body: { accountId: 'lin', password: passwords.lin },
  });
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error.code, 'invalid-login');
  const owner = ownerCookie(host.connection);
  const session = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
  });
  assert.equal(session.status, 401);
  assert.equal(session.json.accountId, undefined);
  await host.dispose();
});

test('an import without ownerAccountId does not map the DSH cookie', async () => {
  const imported = fixtureImport();
  delete imported.ownerAccountId;
  const host = await mount({ imported });
  const owner = ownerCookie(host.connection);
  const session = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
  });
  assert.equal(session.status, 401);
  const chen = await login(host.web, 'chen');
  assert.equal(typeof chen, 'string');
  await host.dispose();
});

test('a malformed identity import is rejected', async () => {
  const hash = hashPassword(randomBytes(18).toString('base64url'));
  await assert.rejects(() => mount({ imported: {} }), /accounts is required/);
  await assert.rejects(() => mount({ imported: { acounts: [] } }), /unknown key acounts/);
  await assert.rejects(() => mount({ imported: { accounts: [] } }), /accounts is empty/);
  await assert.rejects(
    () =>
      mount({
        imported: {
          accounts: [
            { id: 'a', passwordHash: hash },
            { id: 'a', passwordHash: hash },
          ],
        },
      }),
    /duplicate account a/,
  );
  await assert.rejects(
    () =>
      mount({
        imported: {
          accounts: [{ id: 'a', passwordHash: hash }],
          ownerAccountId: 'missing',
        },
      }),
    /ownerAccountId is not an imported account/,
  );
  await assert.rejects(
    () =>
      mount({
        imported: {
          accounts: [
            { id: 'a', passwordHash: hash },
            { id: 'b', passwordHash: hash },
          ],
          ownerAccountId: 'a',
        },
      }),
    /ownerAccountId requires exactly one account/,
  );
  await assert.rejects(
    () =>
      mount({
        imported: {
          accounts: [
            { id: 'a', passwordHash: hash },
            { id: 'b', passwordHash: hash },
          ],
          notes: [
            {
              id: 'n',
              spaceId: 's',
              ownerId: 'missing',
              teamMemberIds: ['a'],
              text: '',
            },
          ],
        },
      }),
    /note n owner is not an imported account/,
  );
  await assert.rejects(
    () =>
      mount({
        imported: {
          accounts: [{ id: 'a', passwordHash: hash }],
          notes: [
            {
              id: 'n',
              spaceId: 's',
              ownerId: 'a',
              teamMemberIds: ['missing'],
              text: '',
            },
          ],
        },
      }),
    /note n member is not an imported account/,
  );
});

test('an unknown account still runs scrypt', async () => {
  let hashes = 0;
  const host = await mount({
    hashProbe: {
      note() {
        hashes += 1;
      },
    },
  });
  const unknown = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: '203.0.113.90',
    body: { accountId: 'ghost', password: 'wrong-password' },
  });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error.code, 'invalid-login');
  const known = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: '203.0.113.91',
    body: { accountId: 'chen', password: 'wrong-password' },
  });
  assert.equal(known.status, 401);
  assert.equal(hashes, 2);
  await host.dispose();
});

test('repeated failed logins from one address are limited', async () => {
  const host = await mount();
  const wrong = randomBytes(18).toString('base64url');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const refused = await call(host.web, {
      method: 'POST',
      path: '/zhuma-id/login',
      remoteAddress: '203.0.113.10',
      body: { accountId: 'chen', password: wrong },
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.json.error.code, 'invalid-login');
  }
  const limited = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: '203.0.113.10',
    body: { accountId: 'chen', password: wrong },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'login-rate-limited');
  const correctWhileLimited = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: '203.0.113.10',
    body: { accountId: 'chen', password: passwords.chen },
  });
  assert.equal(correctWhileLimited.status, 429);
  const otherAddress = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: '203.0.113.11',
    body: { accountId: 'chen', password: wrong },
  });
  assert.equal(otherAddress.status, 401);
  const otherAccount = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: '203.0.113.10',
    body: { accountId: 'zhao', password: passwords.zhao },
  });
  assert.equal(otherAccount.status, 429);
  assert.equal(otherAccount.json.error.code, 'login-rate-limited');
  await host.dispose();
});

async function firstRateLimit(web, address, accountIdAt) {
  for (let attempt = 1; attempt <= 16; attempt += 1) {
    const response = await call(web, {
      method: 'POST',
      path: '/zhuma-id/login',
      remoteAddress: address,
      body: { accountId: accountIdAt(attempt), password: 'wrong-password' },
    });
    if (response.status === 429) {
      assert.equal(response.json.error.code, 'login-rate-limited');
      return attempt;
    }
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, 'invalid-login');
  }
  assert.fail('login was not rate limited');
}

test('rotating nonexistent accounts from one address are limited', async () => {
  const host = await mount();
  const limitedAt = await firstRateLimit(
    host.web,
    '203.0.113.60',
    (attempt) => `missing-${attempt}`,
  );
  assert.equal(limitedAt, 9);
  await host.dispose();
});

test('a known account and unknown accounts reach the limit on the same attempt', async () => {
  const host = await mount();
  const knownIds = ['chen', 'zhao', 'lin'];
  const oneKnown = await firstRateLimit(host.web, '203.0.113.61', () => 'chen');
  const rotatedKnown = await firstRateLimit(
    host.web,
    '203.0.113.62',
    (attempt) => knownIds[(attempt - 1) % knownIds.length],
  );
  const rotatedUnknown = await firstRateLimit(
    host.web,
    '203.0.113.63',
    (attempt) => `missing-${attempt}`,
  );
  assert.equal(oneKnown, rotatedKnown);
  assert.equal(rotatedKnown, rotatedUnknown);
  await host.dispose();
});

test('a login from another address is not starved by unknown-account attempts', async () => {
  const host = await mount();
  const wrong = randomBytes(18).toString('base64url');
  const flood = Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      call(host.web, {
        method: 'POST',
        path: '/zhuma-id/login',
        remoteAddress: '203.0.113.80',
        body: { accountId: `missing-${index}`, password: wrong },
      }),
    ),
  );
  const started = Date.now();
  const normal = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: '203.0.113.81',
    body: { accountId: 'chen', password: passwords.chen },
  });
  const elapsed = Date.now() - started;
  assert.equal(normal.status, 200);
  assert.equal(elapsed < 3_000, true);
  const responses = await flood;
  assert.equal(
    responses.some((response) => response.status === 429),
    true,
  );
  assert.equal(
    responses.every((response) => response.status === 401 || response.status === 429),
    true,
  );
  await host.dispose();
});

test('one host login limit does not lock another host', async () => {
  const first = await mount();
  const second = await mount();
  const address = '203.0.113.17';
  const wrong = randomBytes(18).toString('base64url');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const refused = await call(first.web, {
      method: 'POST',
      path: '/zhuma-id/login',
      remoteAddress: address,
      body: { accountId: 'chen', password: wrong },
    });
    assert.equal(refused.status, 401);
  }
  const limited = await call(first.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: address,
    body: { accountId: 'chen', password: passwords.chen },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'login-rate-limited');
  const otherHost = await call(second.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: address,
    body: { accountId: 'chen', password: passwords.chen },
  });
  assert.equal(otherHost.status, 200);
  assert.equal(otherHost.json.accountId, 'chen');
  await first.dispose();
  await second.dispose();
});

test('concurrent failed logins cannot all skip the limiter', async () => {
  const host = await mount();
  const wrong = randomBytes(18).toString('base64url');
  const responses = await Promise.all(
    Array.from({ length: 40 }, () =>
      call(host.web, {
        method: 'POST',
        path: '/zhuma-id/login',
        remoteAddress: '203.0.113.40',
        body: { accountId: 'chen', password: wrong },
      }),
    ),
  );
  const denied = responses.filter((response) => response.status === 401).length;
  const limited = responses.filter((response) => response.status === 429).length;
  assert.equal(denied + limited, 40);
  assert.equal(denied <= 8, true);
  assert.equal(limited >= 32, true);
  await host.dispose();
});

test('password checking yields while the hash is in flight', async () => {
  const host = await mount();
  const wrong = randomBytes(18).toString('base64url');
  let yields = 0;
  let stop = false;
  const pump = () => {
    if (stop) return;
    yields += 1;
    setImmediate(pump);
  };
  const pending = Promise.all(
    Array.from({ length: 4 }, () =>
      call(host.web, {
        method: 'POST',
        path: '/zhuma-id/login',
        remoteAddress: '203.0.113.77',
        body: { accountId: 'chen', password: wrong },
      }),
    ),
  );
  setImmediate(pump);
  const responses = await pending;
  stop = true;
  assert.equal(
    responses.every((response) => response.status === 401),
    true,
  );
  assert.equal(yields > 0, true);
  await host.dispose();
});

test('a real http client receives 413 before the socket closes', async () => {
  const host = await mount();
  const server = http.createServer((req, res) => {
    host.web.dispatch(req, res).catch(() => {
      if (res.headersSent !== true) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  const send = (body, chunked = false) =>
    new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/zhuma-id/login',
          headers: { 'content-type': 'application/json', host: AUTHORITY },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', (error) => resolve({ status: 0, body: error.code ?? error.message }));
      if (!chunked) {
        req.end(body);
        return;
      }
      const buffer = Buffer.from(body);
      let offset = 0;
      const tick = () => {
        if (offset >= buffer.length) {
          req.end();
          return;
        }
        const ok = req.write(buffer.subarray(offset, offset + 4096));
        offset += 4096;
        if (ok) setImmediate(tick);
        else req.once('drain', tick);
      };
      tick();
    });
  try {
    const ok = await send(JSON.stringify({ accountId: 'chen', password: passwords.chen }));
    assert.equal(ok.status, 200);
    const bulky = JSON.stringify({
      accountId: 'a',
      password: randomBytes(70_000).toString('base64url').slice(0, 70_000),
    });
    const declared = await send(bulky);
    assert.equal(declared.status, 413);
    assert.equal(JSON.parse(declared.body).error.code, 'body-too-large');
    const chunked = await send(bulky, true);
    assert.equal(chunked.status, 413);
    assert.equal(JSON.parse(chunked.body).error.code, 'body-too-large');
    const again = await send(JSON.stringify({ accountId: 'zhao', password: passwords.zhao }));
    assert.equal(again.status, 200);
  } finally {
    server.close();
    await host.dispose();
  }
});

test('owner and member sessions stay distinct, and space checks reject the other account', async () => {
  const host = await mount();
  const owner = ownerCookie(host.connection);
  const zhao = await login(host.web, 'zhao');
  const chen = await login(host.web, 'chen');

  const ownerSession = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
  });
  const ownerAgain = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
  });
  assert.equal(ownerSession.status, 401);
  assert.equal(ownerSession.json.error.code, 'unauthenticated');
  assert.equal(ownerAgain.status, 401);
  const ownerRead = await resolveMember(host.ctx, {
    headers: { host: AUTHORITY, cookie: owner },
  });
  assert.equal(ownerRead.ok, false);

  const zhaoSession = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: zhao,
  });
  assert.equal(zhaoSession.status, 200);
  assert.deepEqual(zhaoSession.json.principal, { kind: 'zhuma-member', memberId: 'zhao' });
  assert.equal(zhaoSession.json.accountId, 'zhao');
  assert.notEqual(zhaoSession.json.peerId, host.connection.browserPeer.id);

  const chenSession = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
  });
  assert.deepEqual(chenSession.json.principal, { kind: 'zhuma-member', memberId: 'chen' });
  assert.notEqual(chenSession.json.accountId, zhaoSession.json.accountId);

  const spoof = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    body: { accountId: 'chen', password: passwords.chen, actorId: 'lin' },
  });
  assert.equal(spoof.status, 400);
  assert.equal(spoof.json.error.code, 'actor-from-body');
  assert.equal(spoof.headers?.['set-cookie'], undefined);

  const querySpoof = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session?actorId=lin',
  });
  assert.equal(querySpoof.status, 400);
  assert.equal(querySpoof.json.error.code, 'actor-from-body');

  const override = await call(host.web, {
    method: 'PUT',
    path: '/zhuma-id/notes/north-note',
    cookie: chen,
    body: { text: 'stolen', actorId: 'lin' },
  });
  assert.equal(override.status, 400);
  assert.equal(override.json.error.code, 'actor-from-body');

  assert.deepEqual(
    host.access.decide({
      principal: { kind: 'owner' },
      action: 'zhuma-id/write-space',
      resources: [{ kind: 'global' }],
      args: { noteId: 'south-note' },
    }),
    { kind: 'allow' },
  );
  assert.deepEqual(
    host.access.decide({
      principal: { kind: 'zhuma-member', memberId: 'chen' },
      action: 'zhuma-id/read-space',
      resources: [{ kind: 'global' }],
      args: { noteId: 'north-note' },
    }),
    { kind: 'deny', reason: 'not-a-member' },
  );

  const ownerWrite = await call(host.web, {
    method: 'PUT',
    path: '/zhuma-id/notes/north-note',
    cookie: owner,
    body: { text: 'north-from-lin' },
  });
  assert.equal(ownerWrite.status, 401);
  assert.equal(ownerWrite.json.error.code, 'unauthenticated');

  const teamWrite = await call(host.web, {
    method: 'PUT',
    path: '/zhuma-id/notes/north-note',
    cookie: zhao,
    body: { text: 'north-from-zhao' },
  });
  assert.equal(teamWrite.status, 200);
  assert.equal(teamWrite.json.accountId, 'zhao');

  const teamSpace = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/spaces/team-north',
    cookie: zhao,
  });
  assert.equal(teamSpace.status, 200);
  assert.equal(teamSpace.json.notes.length, 1);
  assert.equal(teamSpace.json.notes[0].text, 'north-from-zhao');

  const rejected = await call(host.web, {
    method: 'PUT',
    path: '/zhuma-id/notes/north-note',
    cookie: chen,
    body: { text: 'chen-should-not-land' },
  });
  assert.equal(rejected.status, 404);
  assert.equal(rejected.json.error.code, 'not-found');
  const north = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: zhao,
  });
  assert.equal(north.json.note.text, 'north-from-zhao');
  const ownerNorth = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: owner,
  });
  assert.equal(ownerNorth.status, 401);
  assert.equal(ownerNorth.json.note, undefined);

  const south = await call(host.web, {
    method: 'PUT',
    path: '/zhuma-id/notes/south-note',
    cookie: chen,
    body: { text: 'south-from-chen' },
  });
  assert.equal(south.status, 200);
  assert.equal(south.json.accountId, 'chen');

  const mixed = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: `${owner}; ${chen}`,
  });
  assert.equal(mixed.json.accountId, 'chen');
  assert.equal(mixed.json.principal.kind, 'zhuma-member');
  await host.dispose();
});

test('logout invalidates a member session and reopen keeps the space resource', async () => {
  const first = await mount();
  const owner = ownerCookie(first.connection);
  const zhao = await login(first.web, 'zhao');
  const chen = await login(first.web, 'chen');
  const wrote = await call(first.web, {
    method: 'PUT',
    path: '/zhuma-id/notes/north-note',
    cookie: zhao,
    body: { text: 'kept-across-reopen' },
  });
  assert.equal(wrote.status, 200);

  const loggedOut = await call(first.web, {
    method: 'POST',
    path: '/zhuma-id/logout',
    cookie: chen,
    body: {},
  });
  assert.equal(loggedOut.status, 200);
  assert.equal(loggedOut.json.accountId, 'chen');
  const afterLogout = await call(first.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
  });
  assert.equal(afterLogout.status, 401);
  assert.equal(afterLogout.json.error.code, 'unauthenticated');
  const logoutDoesNotFallBack = await call(first.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: `${owner}; ${chen}`,
  });
  assert.equal(logoutDoesNotFallBack.status, 401);

  const ownerStill = await call(first.web, {
    method: 'POST',
    path: '/zhuma-id/logout',
    cookie: owner,
    body: {},
  });
  assert.equal(ownerStill.status, 401);
  assert.equal(ownerStill.json.error.code, 'unauthenticated');
  const ownerRemains = await call(first.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
  });
  assert.equal(ownerRemains.status, 401);
  assert.equal(ownerRemains.json.accountId, undefined);

  await first.dispose();
  const second = await mount({ credentials: first.credentials, media: first.media });
  const reopened = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: zhao,
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.accountId, 'zhao');
  assert.equal(reopened.json.note.text, 'kept-across-reopen');
  const chenStaysOut = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: chen,
  });
  assert.equal(chenStaysOut.status, 401);
  const ownerAfterReopen = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
  });
  assert.equal(ownerAfterReopen.status, 401);
  assert.equal(ownerAfterReopen.json.error.code, 'unauthenticated');

  const chenAgain = await login(second.web, 'chen');
  const stillRejected = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: chenAgain,
  });
  assert.equal(stillRejected.status, 404);
  assert.equal(stillRejected.json.error.code, 'not-found');
  const south = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/notes/south-note',
    cookie: chenAgain,
  });
  assert.equal(south.status, 200);
  assert.equal(south.json.note.text, 'south-initial');
  await second.dispose();
});

test('the member cookie is Path=/ so other product entries receive it', async () => {
  const host = await mount();
  const response = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    body: { accountId: 'zhao', password: passwords.zhao },
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers?.['set-cookie'];
  assert.match(setCookie, /(?:^|;\s*)Path=\/(?:;|$)/);
  assert.doesNotMatch(setCookie, /Path=\/zhuma-id/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /;\s*Secure(?:;|$)/);
  const loggedOut = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/logout',
    cookie: cookiePair(setCookie),
    body: {},
  });
  assert.match(loggedOut.headers?.['set-cookie'], /(?:^|;\s*)Path=\/(?:;|$)/);
  assert.match(loggedOut.headers?.['set-cookie'], /Max-Age=0/);
  await host.dispose();
});

test('member routes reject an untrusted Host or Origin', async () => {
  const host = await mount();
  const chen = await login(host.web, 'chen');
  const evilHost = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
    headers: { host: 'evil.example' },
  });
  assert.equal(evilHost.status, 403);
  assert.equal(evilHost.json.error.code, 'untrusted-request');
  const evilLogin = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    headers: { host: 'evil.example' },
    body: { accountId: 'chen', password: passwords.chen },
  });
  assert.equal(evilLogin.status, 403);
  const evilOrigin = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(evilOrigin.status, 403);
  const crossSite = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  const sameOrigin = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
    headers: { origin: `http://${AUTHORITY}` },
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.json.accountId, 'chen');
  const owner = ownerCookie(host.connection);
  const ownerEvil = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
    headers: { host: 'evil.example' },
  });
  assert.equal(ownerEvil.status, 403);
  await host.dispose();
});

test('a request body over 64KiB is refused', async () => {
  const host = await mount();
  const payload = JSON.stringify({
    accountId: 'chen',
    password: randomBytes(70_000).toString('base64url').slice(0, 70_000),
  });
  assert.equal(payload.length > 65_536, true);
  async function post(headers) {
    const req = Object.assign(Readable.from([Buffer.from(payload)]), {
      method: 'POST',
      url: '/zhuma-id/login',
      headers: { host: AUTHORITY, 'content-type': 'application/json', ...headers },
    });
    const captured = captureResponse();
    await host.web.dispatch(req, captured.response);
    return {
      status: captured.state.status,
      json: JSON.parse(captured.state.body),
    };
  }
  const declared = await post({ 'content-length': String(payload.length) });
  assert.equal(declared.status, 413);
  assert.equal(declared.json.error.code, 'body-too-large');
  const streamed = await post({});
  assert.equal(streamed.status, 413);
  assert.equal(streamed.json.error.code, 'body-too-large');
  await host.dispose();
});

test('login deletes sessions that have already expired', async () => {
  const first = await mount();
  const zhao = await login(first.web, 'zhao');
  const chenBefore = await login(first.web, 'chen');
  const sessions = first.media.get('zhuma_identity').tables.get('sessions');
  let expiredId;
  let keptId;
  for (const [id, row] of sessions.entries()) {
    if (row.accountId === 'zhao') {
      row.expiresAt = Date.now() - 1000;
      expiredId = id;
    }
    if (row.accountId === 'chen') keptId = id;
  }
  assert.equal(typeof expiredId, 'string');
  assert.equal(typeof keptId, 'string');
  await first.dispose();
  const second = await mount({ credentials: first.credentials, media: first.media });
  const reloaded = second.media.get('zhuma_identity').tables.get('sessions');
  assert.equal(reloaded.has(expiredId), true);
  assert.equal(reloaded.has(keptId), true);
  const chen = await login(second.web, 'chen');
  assert.equal(reloaded.has(expiredId), false);
  assert.equal(reloaded.has(keptId), true);
  const stale = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: zhao,
  });
  assert.equal(stale.status, 401);
  const kept = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chenBefore,
  });
  assert.equal(kept.status, 200);
  assert.equal(kept.json.accountId, 'chen');
  const fresh = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
  });
  assert.equal(fresh.status, 200);
  await second.dispose();
});

test('missing and forbidden notes return the same not-found response', async () => {
  const host = await mount();
  const chen = await login(host.web, 'chen');
  const missing = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/nope',
    cookie: chen,
  });
  const forbidden = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: chen,
  });
  const missingSpace = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/spaces/nope',
    cookie: chen,
  });
  const forbiddenSpace = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/spaces/team-north',
    cookie: chen,
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { ok: false, error: { code: 'not-found' } });
  assert.deepEqual(forbidden.json, missing.json);
  assert.deepEqual(missingSpace.json, missing.json);
  assert.deepEqual(forbiddenSpace.json, missing.json);
  assert.equal(forbidden.status, missing.status);
  assert.equal(missingSpace.status, missing.status);
  assert.equal(forbiddenSpace.status, missing.status);
  await host.dispose();
});

test('a member cookie with an extra segment is rejected', async () => {
  const host = await mount();
  const chen = await login(host.web, 'chen');
  const extra = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: `${chen}.extra`,
  });
  assert.equal(extra.status, 401);
  assert.equal(extra.json.error.code, 'unauthenticated');
  const intact = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
  });
  assert.equal(intact.status, 200);
  assert.equal(intact.json.accountId, 'chen');
  await host.dispose();
});

test('a member cookie with a replaced signature is rejected', async () => {
  const host = await mount();
  const chen = await login(host.web, 'chen');
  const value = chen.slice('zhuma-member='.length);
  const [sessionId, expiresAt, signature] = value.split('.');
  assert.equal(signature.length > 10, true);
  const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
  const forged = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: `zhuma-member=${sessionId}.${expiresAt}.${flipped}`,
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.error.code, 'unauthenticated');
  const intact = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
  });
  assert.equal(intact.status, 200);
  assert.equal(intact.json.accountId, 'chen');
  await host.dispose();
});

test('a member cookie past its expiry is rejected while the session row remains', async () => {
  const host = await mount();
  const zhao = await login(host.web, 'zhao');
  const sessions = host.media.get('zhuma_identity').tables.get('sessions');
  assert.equal(sessions.size, 1);
  const realNow = Date.now;
  Date.now = () => realNow() + 12 * 60 * 60 * 1000 + 1000;
  try {
    const expired = await call(host.web, {
      method: 'GET',
      path: '/zhuma-id/session',
      cookie: zhao,
    });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error.code, 'unauthenticated');
    assert.equal(sessions.size, 1);
  } finally {
    Date.now = realNow;
  }
  const still = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: zhao,
  });
  assert.equal(still.status, 200);
  assert.equal(still.json.accountId, 'zhao');
  await host.dispose();
});

test('a DSH cookie alone is not a product account after delete, logout, or expiry', async () => {
  const host = await mount();
  const owner = ownerCookie(host.connection);
  const chen = await login(host.web, 'chen');
  const deleted = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: owner,
  });
  assert.equal(deleted.status, 401);
  assert.equal(deleted.json.note, undefined);
  const loggedOut = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/logout',
    cookie: `${owner}; ${chen}`,
    body: {},
  });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers?.['set-cookie'], /Max-Age=0/);
  const kept = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
  });
  assert.equal(kept.status, 401);
  const zhao = await login(host.web, 'zhao');
  const realNow = Date.now;
  Date.now = () => realNow() + 12 * 60 * 60 * 1000 + 1000;
  try {
    const expired = await call(host.web, {
      method: 'GET',
      path: '/zhuma-id/notes/north-note',
      cookie: `${owner}; ${zhao}`,
    });
    assert.equal(expired.status, 401);
    const omitted = await call(host.web, {
      method: 'GET',
      path: '/zhuma-id/session',
      cookie: owner,
    });
    assert.equal(omitted.status, 401);
  } finally {
    Date.now = realNow;
  }
  await host.dispose();
});

test('resolveMember reports the member and their spaces', async () => {
  const host = await mount();
  const owner = ownerCookie(host.connection);
  const chen = await login(host.web, 'chen');
  const both = await resolveMember(host.ctx, {
    headers: { host: AUTHORITY, cookie: `${owner}; ${chen}` },
  });
  assert.equal(both.ok, true);
  if (both.ok) {
    assert.equal(both.memberId, 'chen');
    assert.deepEqual([...both.spaceIds], ['team-south']);
  }
  const zhao = await login(host.web, 'zhao');
  const north = await resolveMember(host.ctx, { headers: { host: AUTHORITY, cookie: zhao } });
  assert.equal(north.ok, true);
  if (north.ok) assert.deepEqual([...north.spaceIds], ['team-north']);
  const ownerOnly = await resolveMember(host.ctx, {
    headers: { host: AUTHORITY, cookie: owner },
  });
  assert.deepEqual(ownerOnly, { ok: false, status: 401, code: 'unauthenticated' });
  await host.dispose();
});

test('a single-user owner mapping exists only when the import names that one account', async () => {
  const password = randomBytes(18).toString('base64url');
  const named = await mount({
    imported: {
      ownerAccountId: 'lin',
      accounts: [{ id: 'lin', passwordHash: hashPassword(password) }],
      notes: [
        {
          id: 'solo-note',
          spaceId: 'solo-space',
          ownerId: 'lin',
          teamMemberIds: ['lin'],
          text: 'solo',
        },
      ],
    },
  });
  const owner = ownerCookie(named.connection);
  const session = await call(named.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: owner,
  });
  assert.equal(session.status, 200);
  assert.equal(session.json.accountId, 'lin');
  const resolved = await resolveMember(named.ctx, {
    headers: { host: AUTHORITY, cookie: owner },
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.memberId, 'lin');
    assert.deepEqual([...resolved.spaceIds], ['solo-space']);
  }
  const unnamed = await mount({
    imported: {
      accounts: [{ id: 'lin', passwordHash: hashPassword(randomBytes(18).toString('base64url')) }],
    },
  });
  const refused = await call(unnamed.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: ownerCookie(unnamed.connection),
  });
  assert.equal(refused.status, 401);
  await named.dispose();
  await unnamed.dispose();
});

test('a pre-seeded domain with several accounts does not map the owner cookie', async () => {
  const hash = hashPassword(randomBytes(18).toString('base64url'));
  const accounts = new Map(['lin', 'zhao', 'chen'].map((id) => [id, { id, passwordHash: hash }]));
  const media = new Map([
    [
      'zhuma_identity',
      {
        tables: new Map([
          ['accounts', accounts],
          ['sessions', new Map()],
          ['notes', new Map()],
        ]),
        global: { ownerAccountId: 'lin' },
      },
    ],
  ]);
  const host = await mount({ imported: null, media });
  const session = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: ownerCookie(host.connection),
  });
  assert.equal(session.status, 401);
  assert.equal(session.json.error.code, 'unauthenticated');
  await host.dispose();
});

test('a successful login clears earlier failures from that address', async () => {
  const host = await mount();
  const address = '203.0.113.70';
  const wrong = randomBytes(12).toString('base64url');
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const failed = await call(host.web, {
      method: 'POST',
      path: '/zhuma-id/login',
      remoteAddress: address,
      body: { accountId: 'chen', password: wrong },
    });
    assert.equal(failed.status, 401);
  }
  const signedIn = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: address,
    body: { accountId: 'chen', password: passwords.chen },
  });
  assert.equal(signedIn.status, 200);
  const after = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: address,
    body: { accountId: 'chen', password: wrong },
  });
  assert.equal(after.status, 401);
  await host.dispose();
});

test('a session row with a different expiresAt is rejected', async () => {
  const first = await mount();
  const chen = await login(first.web, 'chen');
  const sessions = first.media.get('zhuma_identity').tables.get('sessions');
  assert.equal(sessions.size, 1);
  const value = chen.slice('zhuma-member='.length);
  const expiresAt = Number(value.split('.')[1]);
  const row = [...sessions.values()][0];
  row.expiresAt = expiresAt + 60_000;
  await first.dispose();
  const second = await mount({ credentials: first.credentials, media: first.media });
  const session = await call(second.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: chen,
  });
  assert.equal(session.status, 401);
  assert.equal(session.json.error.code, 'unauthenticated');
  await second.dispose();
});

test('a real http client stays logged out when only the DSH cookie remains', async () => {
  // The Chromium spec mounts /zhuma-id and checks that the browser drops the
  // member cookie. This case stays on node:http for the socket path.
  const host = await mount();
  const server = http.createServer((req, res) => {
    host.web.dispatch(req, res).catch(() => {
      if (res.headersSent !== true) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  const request = (method, path, { cookie, body } = {}) =>
    new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            host: AUTHORITY,
            ...(cookie === undefined ? {} : { cookie }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode,
              setCookie: res.headers['set-cookie'],
              json: raw === '' ? undefined : JSON.parse(raw),
            });
          });
        },
      );
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    const owner = ownerCookie(host.connection);
    const logged = await request('POST', '/zhuma-id/login', {
      body: { accountId: 'chen', password: passwords.chen },
    });
    assert.equal(logged.status, 200);
    const setCookie = Array.isArray(logged.setCookie) ? logged.setCookie[0] : logged.setCookie;
    assert.match(setCookie, /(?:^|;\s*)Path=\/(?:;|$)/);
    const member = setCookie.split(';', 1)[0];
    const both = await request('GET', '/zhuma-id/session', { cookie: `${owner}; ${member}` });
    assert.equal(both.json.accountId, 'chen');
    assert.equal(both.json.principal.kind, 'zhuma-member');
    const cross = await request('GET', '/zhuma-id/notes/north-note', { cookie: member });
    assert.equal(cross.status, 404);
    assert.equal(cross.json.error.code, 'not-found');
    const out = await request('POST', '/zhuma-id/logout', {
      cookie: `${owner}; ${member}`,
      body: {},
    });
    assert.equal(out.status, 200);
    const kept = await request('GET', '/zhuma-id/session', { cookie: owner });
    assert.equal(kept.status, 401);
    const north = await request('GET', '/zhuma-id/notes/north-note', { cookie: owner });
    assert.equal(north.status, 401);
    assert.equal(north.json.note, undefined);
  } finally {
    server.close();
    await host.dispose();
  }
});
