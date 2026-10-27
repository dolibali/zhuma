import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import {
  apply as applyConnection,
  inject as connectionInject,
} from '@deepseek-ai/dsh-client-connection';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { applyIdentity, identityInject } from '../dist/identity-session.js';
import { configureDeploymentMode, resolveMember } from '../dist/member-session.js';
import { applySpaceDirectory } from '../dist/space-directory.js';

export const AUTHORITY = '127.0.0.1:3080';

function memoryCredentials() {
  const records = new Map();
  return {
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    },
  };
}

function memoryKv() {
  const media = new Map();
  return {
    async open(descriptor) {
      let medium = media.get(descriptor.name);
      if (medium === undefined) {
        medium = { tables: new Map(), global: null };
        media.set(descriptor.name, medium);
      }
      return {
        async loadAll() {
          const tables = {};
          for (const table of descriptor.tables) {
            tables[table] = Object.fromEntries(medium.tables.get(table) ?? []);
          }
          return { tables, global: medium.global };
        },
        async putRecord(table, key, value) {
          const records = medium.tables.get(table) ?? new Map();
          medium.tables.set(table, records);
          records.set(key, structuredClone(value));
        },
        async deleteRecord(table, key) {
          medium.tables.get(table)?.delete(key);
        },
        async setGlobal(value) {
          medium.global = structuredClone(value);
        },
        async close() {},
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
      policies.set(kind, policy);
      return () => policies.delete(kind);
    },
    decide(request) {
      if (request.principal.kind === 'owner') return { kind: 'allow' };
      const policy = policies.get(request.principal.kind);
      if (policy === undefined) return { kind: 'deny', reason: 'no-allow' };
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

async function callWeb(web, { method, path, cookie, body, remoteAddress }) {
  const headers = { host: AUTHORITY };
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

/**
 * Real Connection plus `applyIdentity`.
 * `mode` is `legacy-single-user` or `multi-member` and is selected before identity starts.
 * Callers pass scrypt hashes, never passwords in storage.
 * `spaces` mounts the trusted space directory before identity; omitted means no directory.
 */
export async function bootIdentity(imported, mode, spaces) {
  const ctx = new Context();
  const web = createWebServer();
  ctx.provide('credentials', memoryCredentials());
  ctx.provide('webServer', web);
  ctx.provide('remoteAccess', createAccess());
  ctx.provide('storage', {
    backend: { get: () => ({ kv: memoryKv(), close: async () => {} }) },
  });
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'memory', routes: {} }));
  configureDeploymentMode(ctx, mode);
  let connectionFiber;
  let spaceFiber;
  let identityFiber;
  let connectionStarted = false;
  let spaceStarted = false;
  let identityStarted = false;
  try {
    connectionFiber = ctx.plugin({ inject: [...connectionInject], apply: applyConnection });
    await connectionFiber;
    connectionStarted = true;
    if (spaces !== undefined) {
      spaceFiber = ctx.plugin({ inject: ['storageDomain'], apply: applySpaceDirectory }, spaces);
      await spaceFiber;
      spaceStarted = true;
    }
    identityFiber = ctx.plugin({ inject: [...identityInject], apply: applyIdentity }, imported);
    await identityFiber;
    identityStarted = true;
  } catch (error) {
    if (identityStarted) await identityFiber.dispose().catch(() => {});
    if (spaceStarted) await spaceFiber.dispose().catch(() => {});
    if (connectionStarted) await connectionFiber.dispose();
    throw error;
  }
  return {
    ctx,
    web,
    async login(accountId, password) {
      const response = await callWeb(web, {
        method: 'POST',
        path: '/zhuma-id/login',
        // One source address allows 8 login attempts. The next returns 429, and a success clears it.
        remoteAddress: randomBytes(8).toString('hex'),
        body: { accountId, password },
      });
      if (response.status !== 200) {
        throw new Error(`login ${accountId} ${response.status} ${JSON.stringify(response.json)}`);
      }
      return response.headers['set-cookie'].split(';', 1)[0];
    },
    ownerCookie() {
      const target = new URL(ctx.connection.authenticatedUrl(`http://${AUTHORITY}/`));
      const captured = captureResponse();
      ctx.connection.authorizeIndex(
        { method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: AUTHORITY } },
        captured.response,
      );
      return captured.state.headers['set-cookie'].split(';', 1)[0];
    },
    async member(cookie) {
      const headers = { host: AUTHORITY };
      if (cookie !== undefined) headers.cookie = cookie;
      return resolveMember(ctx, { headers });
    },
    async dispose() {
      if (identityStarted) await identityFiber.dispose();
      if (spaceStarted) await spaceFiber.dispose();
      if (connectionStarted) await connectionFiber.dispose();
    },
  };
}

/** Dispose a host that finished starting. An unstarted host is left alone. */
export async function disposeHost(host) {
  if (host === undefined) return;
  await host.dispose();
}
