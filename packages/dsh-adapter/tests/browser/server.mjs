/**
 * Listening fixture for the Chromium member-session spec.
 * Connection and applyIdentity are the real packages. The web server, credential
 * store, and remote-access policy host are in-memory stand-ins, same as the
 * node:test harness, then bound to a real node:http port.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import {
  apply as applyConnection,
  inject as connectionInject,
} from '@deepseek-ai/dsh-client-connection';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { applyIdentity, hashPassword, identityInject } from '../../dist/identity-session.js';
import { configureDeploymentMode } from '../../dist/member-session.js';

function randomPassword() {
  return randomBytes(24).toString('base64url');
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('identity browser fixture did not bind a tcp port'));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startIdentitySite() {
  const passwords = { lin: randomPassword(), zhao: randomPassword(), chen: randomPassword() };
  const notes = [
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
  const credentials = memoryCredentials();
  const kv = memoryKv();
  const web = createWebServer();
  const access = createAccess();
  const ctx = new Context();
  configureDeploymentMode(ctx, 'multi-member');
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
  const connectionFiber = ctx.plugin({ inject: [...connectionInject], apply: applyConnection });
  await connectionFiber;
  const identityFiber = ctx.plugin(
    { inject: [...identityInject], apply: applyIdentity },
    {
      accounts: Object.entries(passwords).map(([id, password]) => ({
        id,
        passwordHash: hashPassword(password),
      })),
      notes,
    },
  );
  await identityFiber;
  const connection = ctx.connection;
  const page = '<!doctype html><meta charset="utf-8"><title>zhuma-id</title><p>ok</p>';
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/zhuma-id' || pathname.startsWith('/zhuma-id/')) {
      web.dispatch(req, res).catch(() => {
        if (res.headersSent !== true) {
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }
    if (
      pathname === '/api/zhuma/snapshot' ||
      pathname.startsWith('/api/zhuma-exec/') ||
      pathname === '/echo-cookie-names'
    ) {
      const names = (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim().split('=')[0])
        .filter((name) => name.length > 0);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(names));
      return;
    }
    if (pathname === '/') {
      const served = connection.authorizeIndex(req, res);
      if (served === false) return;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const other = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>other</title>');
  });
  const port = await listen(server);
  const otherPort = await listen(other);
  const authority = `127.0.0.1:${port}`;
  return {
    baseURL: `http://${authority}`,
    otherURL: `http://127.0.0.1:${otherPort}/`,
    passwords,
    authenticatedURL: connection.authenticatedUrl(`http://${authority}/`),
    async close() {
      server.close();
      other.close();
      await identityFiber.dispose();
      await connectionFiber.dispose();
    },
  };
}
