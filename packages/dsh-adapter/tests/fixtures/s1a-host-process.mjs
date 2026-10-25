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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

let ctx, host, hostPlugin, home, pendingIdentity, releaseIdentity;
let originalModify, remoteAccessFiber, releaseProjectLookup;
let workbenchWriteGate, releaseWorkbenchWrite;
let directoryCloseGate, releaseDirectoryClose, directoryClosing;
let executionLease, executionLeaseSpace;
let closeWorkbench, workbenchClosing;
const domainCloseOrder = [];
let modelCalls = 0;
const forks = [];
const opened = [];
const notify = (phase, value = {}) => process.send?.({ phase, ...value });

async function boot(options) {
  home = options.directory;
  await mkdir(join(home, 'storages'), { recursive: true });
  ctx = new Context();
  if (!options.noModels)
    ctx.provide('llm', {
      prepareCall() {
        modelCalls++;
        throw Error('No models are enabled in S1a tests');
      },
    });
  if (!options.noModels)
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
    const domain = await originalOpen(spec);
    const close = domain.close.bind(domain);
    domain.close = async () => {
      domainCloseOrder.push(spec.name);
      if (spec.name === 'zhuma_spaces' && directoryCloseGate) {
        notify('directory-close-pending');
        await directoryCloseGate;
      }
      await close();
    };
    if (spec.name === 'zhuma_workbench') {
      const set = domain.global.set.bind(domain.global);
      domain.global.set = async (value) => {
        if (workbenchWriteGate) {
          notify('workbench-write-pending');
          await workbenchWriteGate;
        }
        await set(value);
      };
    }
    return domain;
  };
  await load(Credentials, { path: join(home, '.credentials.yaml'), watch: false });
  originalModify = ctx.credentials.modifyRecord.bind(ctx.credentials);
  if (options.identityImport !== undefined) {
    await ctx.credentials.modifyRecord(credentialKey('zhuma-identity', 'bootstrap'), async () => ({
      kind: 'grant',
      payload: options.identityImport,
    }));
  }
  if (options.spaceDirectoryImport !== undefined) {
    await ctx.credentials.modifyRecord(credentialKey('zhuma-spaces', 'bootstrap'), async () => ({
      kind: 'grant',
      payload: options.spaceDirectoryImport,
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
  // One import of the Host entry. A seeded plan is written through the domain
  // spec that same module exports, then the module is mounted. The path is
  // the one the caller passed; nothing renames host to workbench or substitutes
  // another file when that path is set.
  if (options.workbenchSeed !== undefined && options.modulePath === undefined) {
    throw Error('Host module path is required to seed the workbench');
  }
  const modulePath =
    options.modulePath ?? fileURLToPath(new URL('../../dist/host-plugin.js', import.meta.url));
  hostPlugin = await import(pathToFileURL(modulePath).href);
  const contentDigest = createHash('sha256')
    .update(await readFile(modulePath))
    .digest('hex');
  notify('bound-module', { modulePath, contentDigest });
  if (options.workbenchSeed !== undefined) {
    const spec = hostPlugin.workbenchDomainSpec;
    if (spec === undefined || spec === null || typeof spec !== 'object') {
      throw Error('Host entry does not export workbenchDomainSpec');
    }
    const core = await import('@zhuma/agent-core');
    const domain = await ctx.storageDomain.open(spec);
    let state = core.emptyWorkbench();
    for (const command of options.workbenchSeed) {
      state = core.applyWorkbenchCommand(state, command);
    }
    await domain.global.set(state);
    await domain.close();
    notify('workbench-seeded', { domain: spec.name });
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
  // Capture the SDK's original, labeled disposer. Calling it alone exercises
  // Host beforeClose while identity/directory fibers remain active, so their
  // own teardown cannot mask a delayed publication revocation.
  const stopObserving = ctx.on('internal/plugin', (fiber) => {
    if (fiber.runtime.callback !== hostPlugin.apply) return;
    const effect = fiber.effect.bind(fiber);
    fiber.effect = (callback, label) => {
      const dispose = effect(callback, label);
      if (label === 'zhuma-workbench.close') closeWorkbench = dispose;
      return dispose;
    };
  });
  try {
    host = ctx.plugin(hostPlugin, options.config);
    forks.push(host);
    await host;
  } finally {
    stopObserving();
  }
  // Test-only carrier. The signer comes from the exact mounted Host artifact,
  // never a second dist module with an unrelated private installed-source map.
  ctx.connection.fetch.register({
    path: '/api/zhuma-test/execution-member-lease',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      executionLease?.release();
      executionLease = undefined;
      try {
        const { spaceId } = await request.json();
        const lease = await hostPlugin.openExecutionMemberLease(ctx, {
          headers: Object.fromEntries(request.headers),
        });
        try {
          lease.assertCurrent(spaceId);
        } catch {
          lease.release();
          throw Error('lease space refused');
        }
        executionLease = lease;
        executionLeaseSpace = spaceId;
        return Response.json({ ok: true, memberId: lease.memberId, expiresAt: lease.expiresAt });
      } catch {
        return Response.json({ ok: false });
      }
    },
  });
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
    domainCloseOrder,
    credentialMode: (await stat(join(home, '.credentials.yaml'))).mode & 0o777,
    directoryStates: [...(ctx.registry.get(hostPlugin.spaceDirectoryPlugin)?.fibers ?? [])].map(
      (fiber) => fiber.state,
    ),
    directoryRegistered: hostPlugin.spaceDirectoryFor(ctx) !== undefined,
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
  if (action === 'beginWorkbenchClose') {
    if (!closeWorkbench) throw Error('Workbench close effect is unavailable');
    workbenchClosing = Promise.resolve(closeWorkbench());
    void workbenchClosing.catch(() => {});
    return {
      rawAborted: hostPlugin.spaceDirectoryFor(ctx)?.signal.aborted,
      identityActive: [...(ctx.registry.get(hostPlugin.identityPlugin)?.fibers ?? [])].some(
        (fiber) => fiber.state === 2,
      ),
      leaseAborted: executionLease?.signal.aborted,
    };
  }
  if (action === 'finishWorkbenchClose') {
    await workbenchClosing;
    return {};
  }
  if (action === 'executionLeaseStatus') {
    let allowed = false;
    try {
      executionLease?.assertCurrent(executionLeaseSpace);
      allowed = executionLease !== undefined;
    } catch {
      /* Only the bounded status is projected; no source error or request. */
    }
    return {
      exists: executionLease !== undefined,
      aborted: executionLease?.signal.aborted,
      allowed,
    };
  }
  if (action === 'holdDirectoryClose') {
    directoryCloseGate = new Promise((resolve) => {
      releaseDirectoryClose = resolve;
    });
    return {};
  }
  if (action === 'beginDirectoryClose') {
    const directory = hostPlugin.spaceDirectoryFor(ctx);
    directoryClosing = directory.close();
    // Observe a possible rejection now; callers still await it on release.
    void directoryClosing.catch(() => {});
    return {
      rawAborted: directory.signal.aborted,
      leaseAborted: executionLease?.signal.aborted,
    };
  }
  if (action === 'releaseDirectoryClose') {
    releaseDirectoryClose?.();
    directoryCloseGate = undefined;
    await directoryClosing;
    return {};
  }
  if (action === 'holdWorkbenchWrite') {
    workbenchWriteGate = new Promise((resolve) => {
      releaseWorkbenchWrite = resolve;
    });
    return {};
  }
  if (action === 'releaseWorkbenchWrite') {
    releaseWorkbenchWrite?.();
    workbenchWriteGate = undefined;
    return {};
  }
  if (action === 'clientBoot')
    return ctx.webServer
      .collectIndexInjections()
      .filter((row) => row.kind === 'global' && row.name === '__ZHUMA_WORKBENCH_BOOT__');
  if (action === 'unmountWorkbench') {
    await host.dispose();
    return {};
  }
  if (action === 'revokeTestMemberships' || action === 'grantTestMemberships') {
    const directory = hostPlugin.spaceDirectoryFor(ctx);
    for (const spaceId of ['personal-a', 'space-collaboration']) {
      if (action === 'revokeTestMemberships') await directory.revokeMembership(spaceId, 'member-a');
      else await directory.grantMembership(spaceId, 'member-a');
    }
    return {};
  }
  if (action === 'holdProjectLookup') {
    const directory = hostPlugin.spaceDirectoryFor(ctx);
    const original = directory.spaceForProject.bind(directory);
    const gate = new Promise((resolve) => {
      releaseProjectLookup = resolve;
    });
    directory.spaceForProject = async (projectId) => {
      const result = await original(projectId);
      notify('lookup-pending');
      await gate;
      return result;
    };
    return {};
  }
  if (action === 'releaseProjectLookup') {
    releaseProjectLookup?.();
    return {};
  }
  if (action === 'unmountDirectoryWithCloseFailure') {
    const directory = hostPlugin.spaceDirectoryFor(ctx);
    const close = directory.close.bind(directory);
    directory.close = async () => {
      throw Error('Synthetic directory close failure');
    };
    const fibers = [...(ctx.registry.get(hostPlugin.spaceDirectoryPlugin)?.fibers ?? [])];
    try {
      for (const fiber of fibers) await fiber.dispose();
    } catch {
      /* Disposer errors are expected. */
    } finally {
      directory.close = close;
      await close();
    }
    return { registered: hostPlugin.spaceDirectoryFor(ctx) !== undefined };
  }
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
    executionLease?.release();
    releaseDirectoryClose?.();
    releaseWorkbenchWrite?.();
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
