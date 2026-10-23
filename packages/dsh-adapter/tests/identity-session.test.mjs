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
import {
  authorizeLegacyOwnerRoutes,
  configureDeploymentMode,
  deploymentMode,
  identityAccessMode,
  installMemberResolver,
  LEGACY_OWNER_PACKAGE_COMMANDS,
  LEGACY_OWNER_ROUTES,
  resolveMember,
} from '../dist/member-session.js';

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

function memoryKv(media = new Map(), faults = {}) {
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
          if (typeof faults.load === 'function') {
            const error = await faults.load();
            if (error !== undefined) throw error;
          }
          const tables = {};
          for (const table of descriptor.tables) {
            tables[table] = Object.fromEntries(medium.tables.get(table) ?? []);
          }
          return { tables, global: medium.global };
        },
        async putRecord(table, key, value) {
          if (closed) throw new Error('closed');
          if (typeof faults.put === 'function') {
            const error = await faults.put(table, key);
            if (error !== undefined) throw error;
          }
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
          if (typeof faults.global === 'function') {
            const error = await faults.global(value);
            if (error !== undefined) throw error;
          }
          medium.global = structuredClone(value);
        },
        async close() {
          closed = true;
          if (typeof faults.close === 'function') {
            const error = await faults.close();
            if (error !== undefined) throw error;
          }
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
  const kv = memoryKv(shared.media, shared.faults);
  const web = createWebServer();
  const access = createAccess();
  const ctx = shared.ctx ?? new Context();
  if (shared.deploymentMode !== null) {
    configureDeploymentMode(ctx, shared.deploymentMode ?? 'multi-member');
  }
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
    identityFiber,
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
  const flood = Array.from({ length: 40 }, (_, index) =>
    call(host.web, {
      method: 'POST',
      path: '/zhuma-id/login',
      remoteAddress: '203.0.113.80',
      body: { accountId: `missing-${index}`, password: wrong },
    }),
  );
  try {
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
    const responses = await Promise.all(flood);
    assert.equal(
      responses.some((response) => response.status === 429),
      true,
    );
    assert.equal(
      responses.every((response) => response.status === 401 || response.status === 429),
      true,
    );
  } finally {
    // A failed assertion must still wait. These logins hold the process-wide
    // hash slots, and the next test counts those slots.
    await Promise.allSettled(flood);
    await host.dispose();
  }
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

test('one account stays limited after another account clears the address', async () => {
  const host = await mount();
  const address = '203.0.113.55';
  const wrong = randomBytes(18).toString('base64url');
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const refused = await call(host.web, {
      method: 'POST',
      path: '/zhuma-id/login',
      remoteAddress: address,
      body: { accountId: 'chen', password: wrong },
    });
    assert.equal(refused.status, 401);
  }
  const zhao = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: address,
    body: { accountId: 'zhao', password: passwords.zhao },
  });
  assert.equal(zhao.status, 200);
  const eighth = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: address,
    body: { accountId: 'chen', password: wrong },
  });
  assert.equal(eighth.status, 401);
  const limited = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: address,
    body: { accountId: 'chen', password: passwords.chen },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'login-rate-limited');
  const lin = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: address,
    body: { accountId: 'lin', password: passwords.lin },
  });
  assert.equal(lin.status, 200);
  assert.equal(lin.json.accountId, 'lin');
  await host.dispose();
});

// node:test --test-timeout does not run finally. A deadline has to reject in
// the test so the held hashes are released and the setImmediate poll stops.
function withDeadline(ms, label, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitUntil(predicate, ms, label) {
  return new Promise((resolve, reject) => {
    let pending = true;
    const timer = setTimeout(() => {
      pending = false;
      reject(new Error(`${label} exceeded ${ms}ms`));
    }, ms);
    const watch = () => {
      if (!pending) return;
      if (predicate()) {
        pending = false;
        clearTimeout(timer);
        resolve();
        return;
      }
      setImmediate(watch);
    };
    watch();
  });
}

test('at most four password hashes run at once', async () => {
  let active = 0;
  let max = 0;
  let block = true;
  const held = [];
  const host = await mount({
    hashProbe: {
      note() {
        active += 1;
        if (active > max) max = active;
      },
      hold() {
        if (!block) return undefined;
        return new Promise((resolve) => {
          held.push(resolve);
        });
      },
      done() {
        active -= 1;
      },
    },
  });
  const wrong = randomBytes(18).toString('base64url');
  const pending = [];
  const start = (accountId, address, password = wrong) => {
    const task = call(host.web, {
      method: 'POST',
      path: '/zhuma-id/login',
      remoteAddress: address,
      body: { accountId, password },
    });
    pending.push(task);
    return task;
  };
  try {
    for (let index = 0; index < 4; index += 1) start('chen', `203.0.113.${index}`);
    await waitUntil(() => held.length >= 4, 5_000, 'four password-hash slots');
    for (let index = 0; index < 32; index += 1) start('ghost', `198.51.100.${index}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(active, 4);
    assert.equal(max, 4);
    assert.equal(held.length, 4);
    const known = await withDeadline(
      5_000,
      'known-account login while hashes are held',
      start('chen', '203.0.113.200', passwords.chen),
    );
    const unknown = await withDeadline(
      5_000,
      'unknown-account login while hashes are held',
      start('ghost', '203.0.113.201'),
    );
    assert.equal(known.status, 503);
    assert.equal(unknown.status, 503);
    assert.deepEqual(known.json, unknown.json);
    assert.equal(known.json.error.code, 'login-unavailable');
    assert.equal(active, 4);
    assert.equal(max, 4);
    block = false;
    for (const release of held.splice(0)) release();
    const settled = await withDeadline(30_000, 'password-hash logins', Promise.all(pending));
    assert.equal(max, 4);
    assert.equal(
      settled.every((response) => response.status === 401 || response.status === 503),
      true,
    );
  } finally {
    block = false;
    for (const release of held.splice(0)) release();
    await withDeadline(30_000, 'password-hash logins settling', Promise.allSettled(pending)).catch(
      () => {},
    );
    await host.dispose();
  }
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
  try {
    const responses = await withDeadline(30_000, 'in-flight password checks', pending);
    stop = true;
    assert.equal(
      responses.every((response) => response.status === 401),
      true,
    );
    assert.equal(yields > 0, true);
  } finally {
    stop = true;
    await withDeadline(30_000, 'in-flight password checks settling', pending).catch(() => {});
    await host.dispose();
  }
});

function postHttp(port, body, chunked = false) {
  return postUpload(port, Buffer.from(body), { chunked });
}

function postUpload(port, payload, { chunked = false, paceMs = 0 } = {}) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return new Promise((resolve) => {
    let settled = false;
    let responseSeen = false;
    let writeDone = false;
    let responseStatus;
    let responseBody = '';
    let contentLength;
    let timer;
    const finish = (status, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, body: text, responseSeen, contentLength });
    };
    const tryFinish = () => {
      if (writeDone && responseStatus !== undefined) finish(responseStatus, responseBody);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/zhuma-id/login',
        headers: {
          'content-type': 'application/json',
          host: AUTHORITY,
          ...(chunked ? {} : { 'content-length': String(buffer.length) }),
        },
      },
      (res) => {
        responseSeen = true;
        const rawLength = res.headers['content-length'];
        contentLength = Array.isArray(rawLength) ? rawLength[0] : rawLength;
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          responseStatus = res.statusCode ?? 0;
          responseBody = Buffer.concat(chunks).toString('utf8');
          tryFinish();
        });
        res.on('error', (error) => finish(0, error.code ?? error.message));
      },
    );
    req.on('error', (error) => finish(0, error.code ?? error.message));
    timer = setTimeout(() => {
      finish(0, 'upload-timeout');
      req.destroy();
    }, 20_000);
    let offset = 0;
    const step = paceMs > 0 ? 1024 : 16 * 1024;
    const tick = () => {
      if (settled) return;
      if (offset >= buffer.length) {
        writeDone = true;
        req.end();
        tryFinish();
        return;
      }
      const ok = req.write(buffer.subarray(offset, offset + step));
      offset += step;
      const again = () => {
        if (settled) return;
        if (paceMs > 0) setTimeout(tick, paceMs);
        else setImmediate(tick);
      };
      if (ok) again();
      else req.once('drain', again);
    };
    tick();
  });
}

function assertTooLarge(result) {
  const failure = result.body === 'upload-timeout' ? 'upload-timeout' : result.body;
  assert.equal(result.responseSeen, true, failure);
  assert.equal(result.status, 413, failure);
  assert.equal(JSON.parse(result.body).error.code, 'body-too-large');
  assert.equal(typeof result.contentLength, 'string');
  assert.equal(result.contentLength, String(Buffer.byteLength(result.body)));
}

async function listenForHost(host) {
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
  return {
    port: address.port,
    close: () => server.close(),
  };
}

test('a real http client receives 413 before the socket closes', async () => {
  const host = await mount();
  const server = await listenForHost(host);
  try {
    const ok = await postHttp(
      server.port,
      JSON.stringify({ accountId: 'chen', password: passwords.chen }),
    );
    assert.equal(ok.status, 200);
    const bulky = JSON.stringify({
      accountId: 'a',
      password: randomBytes(70_000).toString('base64url').slice(0, 70_000),
    });
    const declared = await postHttp(server.port, bulky);
    assertTooLarge(declared);
    const chunked = await postHttp(server.port, bulky, true);
    assertTooLarge(chunked);
    const again = await postHttp(
      server.port,
      JSON.stringify({ accountId: 'zhao', password: passwords.zhao }),
    );
    assert.equal(again.status, 200);
  } finally {
    server.close();
    await host.dispose();
  }
});

// Mutation: socket.end() inside the res.end callback fails this loop on the
// client. The peer is still uploading, the reset arrives as EPIPE, and there
// is no 'response' event, so status stays 0. Pass only when each attempt
// observes that event with status 413. No retry and no skipped attempt.
test('over-limit bodies get 413 on every attempt, then a normal login works', async () => {
  const host = await mount();
  const server = await listenForHost(host);
  const bulky = JSON.stringify({
    accountId: 'a',
    password: randomBytes(70_000).toString('base64url').slice(0, 70_000),
  });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const declared = await postHttp(server.port, bulky);
      assertTooLarge(declared);
      const chunked = await postHttp(server.port, bulky, true);
      assertTooLarge(chunked);
    }
    const again = await postHttp(
      server.port,
      JSON.stringify({ accountId: 'chen', password: passwords.chen }),
    );
    assert.equal(again.responseSeen, true);
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(again.body).accountId, 'chen');
  } finally {
    server.close();
    await host.dispose();
  }
});

test('a client that keeps uploading after the 413 still reads the full body', async () => {
  const host = await mount();
  const server = await listenForHost(host);
  const payload = Buffer.alloc(128 * 1024, 0x61);
  try {
    const declared = await postUpload(server.port, payload, { paceMs: 5 });
    assertTooLarge(declared);
    const chunked = await postUpload(server.port, payload, { chunked: true, paceMs: 5 });
    assertTooLarge(chunked);
  } finally {
    server.close();
    await host.dispose();
  }
});

function busyWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* block the event loop the way a loaded client does */
  }
}

function postLoaded(
  port,
  { chunked, runs = 1, chunkBytes = 256 * 1024, timerMs = 5, busyMs = 30 },
) {
  const once = () =>
    new Promise((resolve) => {
      let done = false;
      const fin = (outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(iv);
        resolve(outcome);
      };
      const timer = setTimeout(
        () => fin({ status: 0, err: 'timeout', responseSeen: false }),
        15_000,
      );
      const headers = { host: AUTHORITY, 'content-type': 'application/json' };
      const bodyBytes = 4 * 1024 * 1024;
      if (!chunked) headers['content-length'] = String(bodyBytes);
      let responseSeen = false;
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/zhuma-id/login', headers },
        (res) => {
          responseSeen = true;
          const rawLength = res.headers['content-length'];
          const contentLength = Array.isArray(rawLength) ? rawLength[0] : rawLength;
          res.resume();
          res.on('end', () =>
            fin({ status: res.statusCode ?? 0, responseSeen: true, contentLength }),
          );
          res.on('error', () =>
            fin({
              status: res.statusCode ?? 0,
              err: 'res-error',
              responseSeen: true,
              contentLength,
            }),
          );
        },
      );
      req.on('error', (error) => fin({ status: 0, err: error.code, responseSeen }));
      const piece = Buffer.alloc(chunkBytes, 120);
      const iv = setInterval(() => {
        if (done || req.destroyed) {
          clearInterval(iv);
          return;
        }
        req.write(piece);
        if (busyMs > 0) busyWait(busyMs);
      }, timerMs);
    });
  return (async () => {
    const results = [];
    for (let run = 0; run < runs; run += 1) results.push(await once());
    return results;
  })();
}

test('a loaded client still receives 413 while it keeps writing', async () => {
  const host = await mount();
  const server = await listenForHost(host);
  try {
    const declared = await postLoaded(server.port, { chunked: false, runs: 10 });
    const chunked = await postLoaded(server.port, { chunked: true, runs: 10 });
    const expectedLength = String(
      Buffer.byteLength(JSON.stringify({ ok: false, error: { code: 'body-too-large' } })),
    );
    for (const result of [...declared, ...chunked]) {
      assert.equal(result.responseSeen, true);
      assert.equal(result.status, 413);
      assert.equal(result.contentLength, expectedLength);
    }
  } finally {
    server.close();
    await host.dispose();
  }
});

test('a multi-megabyte upload still receives the full 413 while the client writes', async () => {
  const host = await mount();
  const server = await listenForHost(host);
  const payload = Buffer.alloc(5 * 1024 * 1024, 0x62);
  try {
    const declared = await postUpload(server.port, payload);
    assertTooLarge(declared);
    const chunked = await postUpload(server.port, payload, { chunked: true });
    assertTooLarge(chunked);
    const again = await postHttp(
      server.port,
      JSON.stringify({ accountId: 'lin', password: passwords.lin }),
    );
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(again.body).accountId, 'lin');
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
      headers: captured.state.headers,
      body: captured.state.body,
      json: JSON.parse(captured.state.body),
    };
  }
  const declared = await post({ 'content-length': String(payload.length) });
  assert.equal(declared.status, 413);
  assert.equal(declared.json.error.code, 'body-too-large');
  assert.equal(declared.headers['content-length'], String(Buffer.byteLength(declared.body)));
  const streamed = await post({});
  assert.equal(streamed.status, 413);
  assert.equal(streamed.json.error.code, 'body-too-large');
  assert.equal(streamed.headers['content-length'], String(Buffer.byteLength(streamed.body)));
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
    deploymentMode: 'legacy-single-user',
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

function closedLegacy(status, code) {
  return { ok: false, status, code };
}

test('legacy owner routes include the asset import reads and the import-package write', () => {
  assert.deepEqual(
    [...LEGACY_OWNER_ROUTES],
    ['snapshot', 'command', 'plan', 'preview-import', 'resource-files'],
  );
  assert.deepEqual([...LEGACY_OWNER_PACKAGE_COMMANDS], ['import-package']);
});

test('a deployment mode that was never configured refuses startup and legacy owner routes', async () => {
  const ctx = new Context();
  assert.equal(deploymentMode(ctx), undefined);
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(401, 'deployment-mode-unset'));
  assert.throws(
    () => identityAccessMode(ctx),
    /identity startup refused: deployment mode is not configured/,
  );
  await assert.rejects(
    () => mount({ ctx, deploymentMode: null }),
    /identity startup refused: deployment mode is not configured/,
  );
  assert.equal(deploymentMode(ctx), undefined);
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(401, 'deployment-mode-unset'));
});

test('an unset deployment mode refuses identity startup and legacy owner routes', async () => {
  const ctx = new Context();
  assert.equal(deploymentMode(ctx), undefined);
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(401, 'deployment-mode-unset'));
  assert.throws(
    () => identityAccessMode(ctx),
    /identity startup refused: deployment mode is not configured/,
  );
  assert.throws(
    () => configureDeploymentMode(ctx, 'single-user'),
    /identity startup refused: deployment mode is not configured/,
  );
  assert.equal(deploymentMode(ctx), undefined);
  await assert.rejects(
    () => mount({ ctx, deploymentMode: null }),
    /identity startup refused: deployment mode is not configured/,
  );
  assert.equal(deploymentMode(ctx), undefined);
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(401, 'deployment-mode-unset'));
});

test('a registered resolver does not select the deployment mode', () => {
  const ctx = new Context();
  installMemberResolver(ctx, {
    secret: randomBytes(32),
    requestRejection: () => undefined,
    findSession: () => undefined,
    spaceIdsFor: () => [],
    singleUserAccountId: () => 'lin',
    admitOwner: () => true,
  });
  assert.throws(
    () => identityAccessMode(ctx),
    /identity startup refused: deployment mode is not configured/,
  );
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(401, 'deployment-mode-unset'));
  configureDeploymentMode(ctx, 'multi-member');
  assert.equal(identityAccessMode(ctx), 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
});

test('multi-member denies legacy owner routes while identity is not mounted', () => {
  const ctx = new Context();
  configureDeploymentMode(ctx, 'multi-member');
  assert.equal(identityAccessMode(ctx), 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
});

test('a failed identity mount keeps legacy owner routes denied', async () => {
  const ctx = new Context();
  configureDeploymentMode(ctx, 'multi-member');
  await assert.rejects(
    () => mount({ ctx, deploymentMode: null, imported: { accounts: [] } }),
    /identity import was rejected: accounts is empty/,
  );
  assert.equal(identityAccessMode(ctx), 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
  const member = await resolveMember(ctx, { headers: { host: AUTHORITY } });
  assert.deepEqual(member, { ok: false, status: 401, code: 'unauthenticated' });
});

test('legacy owner routes stay denied while multi-member identity disposes and remounts', async () => {
  const ctx = new Context();
  configureDeploymentMode(ctx, 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
  let closeCount = 0;
  let releaseClose;
  let closeEntered;
  const closeReady = new Promise((resolve) => {
    closeEntered = resolve;
  });
  let opens = 0;
  let releaseLoad;
  let loadEntered;
  const loadReady = new Promise((resolve) => {
    loadEntered = resolve;
  });
  const host = await mount({
    ctx,
    deploymentMode: null,
    faults: {
      close: () => {
        closeCount += 1;
        if (closeCount > 1) return undefined;
        return new Promise((resolve) => {
          closeEntered();
          releaseClose = () => resolve(undefined);
        });
      },
      load: () => {
        opens += 1;
        if (opens === 1) return undefined;
        return new Promise((resolve) => {
          loadEntered();
          releaseLoad = () => resolve(undefined);
        });
      },
    },
  });
  assert.equal(identityAccessMode(ctx), 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
  const closing = host.identityFiber.dispose();
  await closeReady;
  assert.equal(identityAccessMode(ctx), 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
  const duringDispose = await resolveMember(ctx, { headers: { host: AUTHORITY } });
  assert.deepEqual(duringDispose, { ok: false, status: 401, code: 'unauthenticated' });
  releaseClose();
  await closing;
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
  const remounting = ctx.plugin(
    { inject: [...identityInject], apply: applyIdentity },
    fixtureImport(),
  );
  await loadReady;
  assert.equal(identityAccessMode(ctx), 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
  const duringRemount = await resolveMember(ctx, { headers: { host: AUTHORITY } });
  assert.deepEqual(duringRemount, { ok: false, status: 401, code: 'unauthenticated' });
  releaseLoad();
  await remounting;
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
  await remounting.dispose();
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
  await host.dispose();
  assert.equal(deploymentMode(ctx), 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), closedLegacy(404, 'not-found'));
});

test('multi-member does not map an owner cookie onto its one named account', async () => {
  const password = randomBytes(18).toString('base64url');
  const host = await mount({
    deploymentMode: 'multi-member',
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
  const session = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: ownerCookie(host.connection),
  });
  assert.equal(session.status, 401);
  assert.equal(session.json.error.code, 'unauthenticated');
  const loggedIn = await call(host.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: randomBytes(8).toString('hex'),
    body: { accountId: 'lin', password },
  });
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(authorizeLegacyOwnerRoutes(host.ctx), closedLegacy(404, 'not-found'));
  await host.dispose();
});

test('legacy-single-user keeps owner routes open across mount and dispose', async () => {
  const ctx = new Context();
  configureDeploymentMode(ctx, 'legacy-single-user');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), { ok: true });
  assert.equal(identityAccessMode(ctx), 'single-user');
  const password = randomBytes(18).toString('base64url');
  const host = await mount({
    ctx,
    deploymentMode: null,
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
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), { ok: true });
  const session = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/session',
    cookie: ownerCookie(host.connection),
  });
  assert.equal(session.status, 200);
  assert.equal(session.json.accountId, 'lin');
  await host.dispose();
  assert.equal(deploymentMode(ctx), 'legacy-single-user');
  assert.deepEqual(authorizeLegacyOwnerRoutes(ctx), { ok: true });
});

test('deployment mode is stored on the host root', async () => {
  const root = new Context();
  configureDeploymentMode(root, 'multi-member');
  let child;
  const fiber = root.plugin({
    apply(pluginCtx) {
      child = pluginCtx;
    },
  });
  await fiber;
  assert.notEqual(child, root);
  assert.equal(deploymentMode(child), 'multi-member');
  assert.equal(identityAccessMode(child), 'multi-member');
  assert.deepEqual(authorizeLegacyOwnerRoutes(child), closedLegacy(404, 'not-found'));
  configureDeploymentMode(child, 'multi-member');
  assert.throws(
    () => configureDeploymentMode(child, 'legacy-single-user'),
    /identity startup refused: deployment mode is already configured/,
  );
  assert.equal(deploymentMode(root), 'multi-member');
  await fiber.dispose();
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

test('legacy-single-user refuses the owner cookie unless the stored import has exactly one account', async () => {
  const hash = hashPassword(randomBytes(18).toString('base64url'));
  const account = (id) => [id, { id, passwordHash: hash }];
  const stored = (accounts, ownerAccountId) =>
    new Map([
      [
        'zhuma_identity',
        {
          tables: new Map([
            ['accounts', new Map(accounts)],
            ['sessions', new Map()],
            ['notes', new Map()],
          ]),
          global: { ownerAccountId },
        },
      ],
    ]);

  async function refuse(media) {
    const host = await mount({
      deploymentMode: 'legacy-single-user',
      imported: null,
      media,
    });
    const before = identityRows(media);
    const session = await call(host.web, {
      method: 'GET',
      path: '/zhuma-id/session',
      cookie: ownerCookie(host.connection),
    });
    assert.equal(session.status, 401);
    assert.equal(session.json.error.code, 'unauthenticated');
    const resolved = await resolveMember(host.ctx, {
      headers: { host: AUTHORITY, cookie: ownerCookie(host.connection) },
    });
    assert.deepEqual(resolved, { ok: false, status: 401, code: 'unauthenticated' });
    assert.deepEqual(identityRows(media), before);
    await host.dispose();
    assert.deepEqual(identityRows(media), before);
  }

  await refuse(stored([], ''));
  await refuse(stored([account('lin'), account('zhao')], 'lin'));
});

function failNthPut(tableName, nth) {
  let seen = 0;
  return {
    put(table) {
      if (table !== tableName) return undefined;
      seen += 1;
      if (seen === nth) return new Error('injected identity write failure');
      return undefined;
    },
  };
}

function identityRows(media) {
  const medium = media.get('zhuma_identity');
  const accounts = medium?.tables.get('accounts') ?? new Map();
  const notes = medium?.tables.get('notes') ?? new Map();
  const sorted = (table) =>
    Object.fromEntries([...table.entries()].sort(([left], [right]) => left.localeCompare(right)));
  return {
    accounts: sorted(accounts),
    notes: sorted(notes),
    global: medium?.global ?? null,
  };
}

async function expectFixtureMembers(host) {
  const lin = await login(host.web, 'lin');
  const zhao = await login(host.web, 'zhao');
  const chen = await login(host.web, 'chen');
  const north = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: lin,
  });
  assert.equal(north.status, 200);
  assert.equal(north.json.note.text, 'north-initial');
  const zhaoNorth = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: zhao,
  });
  assert.equal(zhaoNorth.status, 200);
  const south = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/south-note',
    cookie: chen,
  });
  assert.equal(south.status, 200);
  assert.equal(south.json.note.text, 'south-initial');
  const chenNorth = await call(host.web, {
    method: 'GET',
    path: '/zhuma-id/notes/north-note',
    cookie: chen,
  });
  assert.equal(chenNorth.status, 404);
}

async function resumeSameImport(faults, assertPartial) {
  const media = new Map();
  const credentials = memoryCredentials();
  const imported = fixtureImport();
  await assert.rejects(
    () => mount({ media, credentials, imported, faults }),
    /injected identity write failure/,
  );
  assertPartial(media);
  const recovered = await mount({ media, credentials, imported });
  const saved = identityRows(recovered.media);
  assert.equal(saved.global.importComplete, true);
  assert.deepEqual(Object.keys(saved.accounts), ['chen', 'lin', 'zhao']);
  assert.deepEqual(Object.keys(saved.notes), ['north-note', 'south-note']);
  await expectFixtureMembers(recovered);
  await recovered.dispose();
  const retried = await mount({ media, credentials, imported });
  assert.deepEqual(identityRows(retried.media), saved);
  await expectFixtureMembers(retried);
  await retried.dispose();
}

test('an accounts put failure resumes the same import', async () => {
  await resumeSameImport(failNthPut('accounts', 2), (media) => {
    assert.deepEqual([...media.get('zhuma_identity').tables.get('accounts').keys()], ['lin']);
  });
});

test('a notes put failure resumes the same import', async () => {
  await resumeSameImport(failNthPut('notes', 1), (media) => {
    const medium = media.get('zhuma_identity');
    assert.deepEqual([...medium.tables.get('accounts').keys()].sort(), ['chen', 'lin', 'zhao']);
    assert.equal(medium.tables.get('notes')?.size ?? 0, 0);
  });
});

test('a completion marker failure resumes the same import', async () => {
  await resumeSameImport(
    {
      global() {
        return new Error('injected identity write failure');
      },
    },
    (media) => {
      const medium = media.get('zhuma_identity');
      assert.equal(medium.global, null);
      assert.deepEqual([...medium.tables.get('notes').keys()].sort(), ['north-note', 'south-note']);
    },
  );
});

test('a completed import is left untouched by a different import', async () => {
  const media = new Map();
  const credentials = memoryCredentials();
  const imported = fixtureImport();
  const first = await mount({ media, credentials, imported });
  const saved = identityRows(first.media);
  await first.dispose();
  const otherPassword = randomPassword();
  const other = {
    accounts: [{ id: 'other', passwordHash: hashPassword(otherPassword) }],
    notes: [
      {
        id: 'north-note',
        spaceId: 'team-north',
        ownerId: 'other',
        teamMemberIds: ['other'],
        text: 'replaced',
      },
    ],
  };
  const second = await mount({ media, credentials, imported: other });
  assert.deepEqual(identityRows(second.media), saved);
  await expectFixtureMembers(second);
  const refused = await call(second.web, {
    method: 'POST',
    path: '/zhuma-id/login',
    remoteAddress: '203.0.113.88',
    body: { accountId: 'other', password: otherPassword },
  });
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error.code, 'invalid-login');
  await second.dispose();
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
