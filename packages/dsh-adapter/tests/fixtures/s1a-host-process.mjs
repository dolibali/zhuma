/** Real published DSH service composition in a separate process and private test home.
 * Only model generation is a rejecting stand-in; no credentials come from a user profile. */
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

let ctx, host, hostPlugin, home, pendingIdentity, releaseIdentity;
let originalModify, remoteAccessFiber;
let modelCalls = 0;
const forks = [];
const opened = [];
const notify = (phase, value = {}) => process.send?.({ phase, ...value });

async function boot(options) {
  home = options.directory;
  await mkdir(join(home, 'storages'), { recursive: true });
  ctx = new Context();
  ctx.provide('llm', {
    prepareCall() {
      modelCalls++;
      throw Error('No models are enabled in S1a tests');
    },
  });
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'disabled' }),
  });
  const load = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    forks.push(fiber);
    await fiber;
    return fiber;
  };
  await load(Storage);
  await load(JsonStorage, { root: join(home, 'storages') });
  await load(StorageDomain, { backend: 'json' });
  const originalOpen = ctx.storageDomain.open.bind(ctx.storageDomain);
  ctx.storageDomain.open = async (spec) => {
    opened.push(spec.name);
    return originalOpen(spec);
  };
  await load(Credentials, { path: join(home, '.credentials.yaml'), watch: false });
  originalModify = ctx.credentials.modifyRecord.bind(ctx.credentials);
  if (options.identityImport !== undefined) {
    await ctx.credentials.modifyRecord(credentialKey('zhuma-identity', 'bootstrap'), async () => ({
      kind: 'grant',
      payload: options.identityImport,
    }));
  }
  if (options.deferIdentity) {
    pendingIdentity = new Promise((resolve) => {
      releaseIdentity = resolve;
    });
    ctx.credentials.modifyRecord = async (key, mutate) => {
      if (key === 'zhuma-identity/member-session') {
        notify('identity-pending');
        await pendingIdentity;
      }
      return originalModify(key, mutate);
    };
  }
  await load(WebServer, { host: '127.0.0.1', port: 0 });
  await load(Connection);
  if (!options.skipRemoteAccess) remoteAccessFiber = await load(RemoteAccess);
  ctx.webServer.register({
    kind: 'exact',
    path: '/',
    handler: (req, res) => {
      if (ctx.connection.authorizeIndex(req, res)) res.writeHead(200).end('S1a real-service test');
    },
  });
  const baseURL = `http://127.0.0.1:${ctx.webServer.port}`;
  notify('listening', { baseURL, ownerURL: ctx.connection.authenticatedUrl(baseURL) });
  hostPlugin = await import(
    options.modulePath ? pathToFileURL(options.modulePath).href : '../../dist/host-plugin.js'
  );
  host = ctx.plugin(hostPlugin, options.config);
  forks.push(host);
  await host;
  notify('ready');
}

async function inspect() {
  const files = {};
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        name = prefix + entry.name;
      if (entry.isDirectory()) await walk(path, name + '/');
      else if (entry.isFile())
        files[name] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
    }
  }
  await walk(join(home, 'storages'));
  return {
    opened,
    files,
    modelCalls,
    credentialMode: (await stat(join(home, '.credentials.yaml'))).mode & 0o777,
    identityStates: [...(ctx.registry.get(hostPlugin.identityPlugin)?.fibers ?? [])].map(
      (fiber) => fiber.state,
    ),
  };
}

async function waitIdentityState(expected) {
  return new Promise((resolveState, reject) => {
    const current = () =>
      [...(ctx.registry.get(hostPlugin.identityPlugin)?.fibers ?? [])].some(
        (fiber) => fiber.state === expected,
      );
    const stop = ctx.on('internal/status', () => {
      if (current()) finish();
    });
    const timer = setTimeout(() => {
      stop();
      reject(Error('Identity state transition timed out'));
    }, 8000);
    function finish() {
      clearTimeout(timer);
      stop();
      resolveState({ state: expected });
    }
    if (current()) finish();
  });
}

async function act(action) {
  if (action === 'waitIdentityActive') return waitIdentityState(2);
  if (action === 'waitIdentityPending') return waitIdentityState(0);
  if (action === 'inspect') return inspect();
  if (action === 'mountRemoteAccess') {
    remoteAccessFiber = ctx.plugin(RemoteAccess);
    forks.push(remoteAccessFiber);
    await remoteAccessFiber;
    return {};
  }
  if (action === 'unmountRemoteAccess') {
    await remoteAccessFiber.dispose();
    return {};
  }

  if (action === 'releaseIdentity') {
    ctx.credentials.modifyRecord = originalModify;
    releaseIdentity();
    return {};
  }
  if (action === 'unmountIdentity') {
    const fibers = [...(ctx.registry.get(hostPlugin.identityPlugin)?.fibers ?? [])];
    for (const fiber of fibers) await fiber.dispose();
    return {};
  }
  if (action === 'remountIdentity' || action === 'failIdentity') {
    if (action === 'failIdentity')
      ctx.credentials.modifyRecord = async () => {
        throw Error('Synthetic credentials failure');
      };
    const fiber = host.ctx.plugin(hostPlugin.identityPlugin);
    try {
      await fiber;
      return { loaded: true };
    } catch {
      await fiber.dispose();
      return { loaded: false };
    } finally {
      ctx.credentials.modifyRecord = originalModify;
    }
  }
  if (action === 'stop') {
    for (const fiber of forks.reverse()) await fiber.dispose();
    return {};
  }
  throw Error('Unknown fixture action');
}

process.on('message', async (message) => {
  try {
    if (message.type === 'boot') {
      await boot(message.options);
      return;
    }
    const value = await act(message.action);
    process.send?.({ reply: message.id, value });
    if (message.action === 'stop') process.disconnect();
  } catch {
    // Provider/config errors can contain private material; IPC reports only a stable phase.
    if (message.type === 'boot') notify('failed');
    else process.send?.({ reply: message.id, error: 'fixture-action-failed' });
  }
});
