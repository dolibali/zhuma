/** Emitted Host + patched official SDK + real member cookies and JSON/JSONL.
 * Model output is a local scripted contract; no remote model or user profile is used.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import * as Host from './zhuma-host-run-plugin.js';
import { applyWorkbenchCommand, hashPassword, fixture } from './zhuma-host-run-test-data.js';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';

const deferred = () => Promise.withResolvers();
function checked(response) {
  assert.equal(response.result.ok, true, response.result.ok ? '' : response.result.error.code);
  return response.result.value;
}
function waitFor(ctx, predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stop = ctx.on(
      'domain/changed',
      () => {
        if (!predicate()) return;
        clearTimeout(timer);
        stop();
        resolve();
      },
      { global: true },
    );
    const timer = setTimeout(() => {
      stop();
      reject(Error('Actual Host state did not reach the expected condition'));
    }, 5000);
    if (predicate()) {
      clearTimeout(timer);
      stop();
      resolve();
    }
  });
}
async function boot(
  t,
  { expert = false, adapter = new ScriptedAdapter(['FIRST', 'SECOND']) } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-host-run-'));
  const ctx = new Context();
  const password = randomBytes(24).toString('base64url');
  const counts = { executionOpened: 0, nativeOpened: 0, executionClosed: 0, nativeClosed: 0 };
  let host;
  t.onTestFinished(async () => {
    await host?.dispose();
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  for (const [plugin, config] of [
    [LlmRuntime],
    [Sessions],
    [Projections],
    [Prompt],
    [Tools],
    [Agents],
    [Persistence, { root: join(root, 'sessions'), compression: 'none' }],
    [Loop, { agents: [] }],
    [Storage],
    [JsonStorage, { root: join(root, 'domains') }],
    [Domain, { backend: 'json' }],
    [Credentials, { path: join(root, 'credentials.yaml'), watch: false }],
    [WebServer, { host: '127.0.0.1', port: 0 }],
    [Connection],
    [RemoteAccess],
  ])
    await ctx.plugin(plugin, config);
  adapter.listModels = async (provider) => [
    { provider, id: 'contract-model', name: 'Contract model' },
  ];
  ctx.llm.registerAdapter(['contract'], adapter);
  const originalOpen = ctx.storageDomain.open.bind(ctx.storageDomain);
  ctx.storageDomain.open = async (spec) => {
    const domain = await originalOpen(spec);
    const key =
      spec.name === 'zhuma_execution'
        ? 'execution'
        : spec.name === 'zhuma_native_work_sessions'
          ? 'native'
          : undefined;
    if (key) {
      counts[`${key}Opened`]++;
      const close = domain.close.bind(domain);
      domain.close = async () => {
        counts[`${key}Closed`]++;
        await close();
      };
    }
    return domain;
  };
  await ctx.credentials.modifyRecord(credentialKey('zhuma-identity', 'bootstrap'), async () => ({
    kind: 'grant',
    payload: {
      accounts: ['chen', 'outside'].map((id) => ({ id, passwordHash: hashPassword(password) })),
    },
  }));
  await ctx.credentials.modifyRecord(credentialKey('zhuma-spaces', 'bootstrap'), async () => ({
    kind: 'grant',
    payload: {
      spaces: [{ id: 'north', name: 'Contract team', kind: 'team' }],
      memberships: ['chen', 'outside'].map((accountId) => ({ spaceId: 'north', accountId })),
      projectSpaces: [{ projectId: 'project', spaceId: 'north' }],
    },
  }));
  const data = fixture();
  data.state.participants.find((item) => item.id === 'qa').instructions =
    'EXACT_PLAN_EXPERT_METHOD';
  const state = applyWorkbenchCommand(data.state, {
    type: 'save-task',
    task: {
      ...data.task,
      status: 'ready',
      workflows: [
        {
          ...data.task.workflows[0],
          nodes: [
            {
              ...data.node,
              assigneeId: expert ? 'qa' : 'chen',
              reviewerIds: [],
              reviewRequired: false,
              skillIds: [],
              mcpIds: [],
            },
          ],
        },
      ],
    },
  });
  const plan = state.appliedPlans.at(-1);
  const seed = await ctx.storageDomain.open(Host.workbenchDomainSpec);
  await seed.global.set(state);
  await seed.close();
  ctx.webServer.register({
    kind: 'exact',
    path: '/',
    handler(req, res) {
      if (ctx.connection.authorizeIndex(req, res)) res.writeHead(200).end('Host test');
    },
  });
  const base = `http://127.0.0.1:${ctx.webServer.port}`;
  const handshake = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' });
  const owner = handshake.headers.getSetCookie()[0].split(';')[0];
  host = ctx.plugin(Host, {
    deploymentMode: 'multi-member',
    identityBootstrapKey: 'zhuma-identity/bootstrap',
    spaceDirectoryBootstrapKey: 'zhuma-spaces/bootstrap',
  });
  await host;
  const nativeFibers = [...(ctx.registry.get(Host.nativeRunPlugin)?.fibers ?? [])];
  assert.equal(nativeFibers.length, 1);
  await Promise.all(nativeFibers.map((fiber) => fiber.await()));
  async function login(accountId = 'chen') {
    const response = await fetch(base + '/zhuma-id/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner },
      body: JSON.stringify({ accountId, password }),
    });
    assert.equal(response.status, 200);
    return `${owner}; ${response.headers.getSetCookie()[0].split(';')[0]}`;
  }
  const cookie = await login();
  async function rpc(group, endpoint, payload, credential = cookie) {
    const response = await fetch(`${base}/api/zhuma-${group}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: credential },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: `zhuma-${group}/${endpoint}`,
        payload,
      }),
    });
    return { status: response.status, ...(await response.json()) };
  }
  checked(
    await rpc('exec', 'start-plan', {
      taskId: 'task',
      planId: plan.id,
      revision: plan.revision,
      idempotencyKey: 'start-plan',
      spaceId: 'north',
    }),
  );
  const locator = { taskId: 'task', planId: plan.id, revision: plan.revision, nodeId: 'node-1' };
  const table = ctx.storageDomain.get('zhuma_execution').table('nodes');
  const row = () => [...table.entries()][0][1];
  const run = () => row().nativeExecution?.runs.at(-1);
  const begin = {
    ...locator,
    requestId: 'first-run',
    spaceId: 'north',
    expectedNodeVersion: row().command.version,
    expectedRunVersion: 0,
    mode: 'begin',
    newRunId: 'run-1',
    newSegmentId: 'segment-1',
    model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
    executor: expert
      ? { kind: 'plan-expert', ref: { id: 'qa', version: plan.id } }
      : { kind: 'builtin' },
    tools: 'text-only',
    workspace: { kind: 'text-only' },
  };
  return {
    ctx,
    host,
    root,
    base,
    owner,
    cookie,
    counts,
    adapter,
    rpc,
    login,
    row,
    run,
    table,
    locator,
    begin,
  };
}

test(
  'actual emitted Host: durable first start, early message adoption and multi-turn use one native Run; replay/read do not run it again',
  { timeout: 20000 },
  async (t) => {
    const h = await boot(t);
    assert.deepEqual(h.ctx.storageDomain.get('zhuma_execution').global.get(), { schemaVersion: 1 });
    assert.equal(h.ctx.agents.list().length, 0);
    const beforeOptions = JSON.stringify(h.row());
    const choices = checked(await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }));
    assert.equal(choices.currentRunId, null);
    assert.equal(choices.selection, null);
    assert.equal(choices.models.items[0].value.model, 'contract-model');
    assert.equal(choices.start.mode, 'begin');
    assert.equal(JSON.stringify(h.row()), beforeOptions);
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(h.ctx.agents.list().length, 0);
    assert.deepEqual(h.ctx.storageDomain.get('zhuma_execution').global.get(), { schemaVersion: 1 });
    const first = checked(await h.rpc('run', 'begin', h.begin));
    assert.equal(first.dispatch, 'received');
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    const target = { ...h.locator, runId: 'run-1' };
    const view = checked(await h.rpc('run', 'read', target));
    const agent = h.ctx.agents.get(view.native.sessionId);
    await agent.whenIdle();
    assert.equal(h.adapter.requests.length, 1);
    const savedChoices = checked(await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }));
    assert.equal(savedChoices.currentRunId, 'run-1');
    assert.deepEqual(savedChoices.selection, { model: h.begin.model, executor: h.begin.executor });
    assert.equal(savedChoices.start.kind, 'unavailable');
    assert.equal(h.adapter.requests.length, 1);
    assert.equal(view.status, 'running');
    assert.equal(h.run().attempt.status, 'running', 'native idle is not product completion');
    assert.equal(h.run().composition.configurationId, h.run().selection.configurationId);
    assert.ok(
      JSON.stringify(h.adapter.requests[0]).includes(
        JSON.stringify(h.run().composition.payload.context).slice(1, -1),
      ),
    );
    checked(await h.rpc('run', 'begin', h.begin));
    checked(await h.rpc('run', 'history', target));
    checked(await h.rpc('run', 'read', target));
    assert.equal(h.adapter.requests.length, 1);
    const sent = checked(
      await h.rpc('run', 'send', {
        ...target,
        generation: 1,
        segmentId: 'segment-1',
        requestId: 'followup-1',
        text: 'Continue with the same frozen context.',
        mode: 'followup',
      }),
    );
    assert.equal(sent.status, 'received');
    await agent.whenIdle();
    assert.equal(h.adapter.requests.length, 2);
    assert.equal(
      checked(await h.rpc('run', 'read', target)).native.sessionId,
      view.native.sessionId,
    );
    const stopping = checked(await h.rpc('run', 'read', target));
    const stopped = checked(
      await h.rpc('run', 'stop', {
        ...target,
        spaceId: 'north',
        generation: 1,
        segmentId: 'segment-1',
        requestId: 'stop-1',
        expectedNodeVersion: stopping.nodeVersion,
        expectedRunVersion: stopping.runVersion,
      }),
    );
    assert.equal(stopped.status, 'stopped');
    assert.equal(h.run().resources, 'settled');
    assert.equal(h.run().attempt.status, 'cancelled');
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(h.counts.executionOpened, 1);
    assert.equal(h.counts.nativeOpened, 1);
  },
);

test(
  'actual emitted Host: an expert-ready node absent from human inbox uses its exact frozen plan expert',
  { timeout: 15000 },
  async (t) => {
    const h = await boot(t, { expert: true });
    const inbox = checked(await h.rpc('exec', 'inbox', { spaceId: 'north' }));
    assert.equal(
      inbox.nodes.some((node) => node.nodeId === h.locator.nodeId),
      false,
    );
    const denied = await h.rpc('run', 'begin', { ...h.begin, executor: { kind: 'builtin' } });
    assert.equal(denied.result.ok, false);
    assert.equal(h.run(), undefined);
    assert.deepEqual(h.ctx.storageDomain.get('zhuma_execution').global.get(), { schemaVersion: 1 });
    const choices = checked(await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }));
    assert.deepEqual(
      choices.experts.map((expert) => expert.value),
      [h.begin.executor],
    );
    checked(await h.rpc('run', 'begin', h.begin));
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    const agent = h.ctx.agents.get(h.run().attempt.sessionId);
    await agent.whenIdle();
    assert.equal(h.adapter.requests.length, 1);
    assert.ok(JSON.stringify(h.adapter.requests[0]).includes('EXACT_PLAN_EXPERT_METHOD'));
    assert.equal(h.run().composition.payload.executor.ref.id, 'qa');
  },
);

test(
  'actual emitted Host: unauthenticated/foreign member and invalid configuration never enable the writer or create native sessions',
  { timeout: 15000 },
  async (t) => {
    const h = await boot(t);
    const ownerOnly = await h.rpc('run', 'begin', h.begin, h.owner);
    assert.equal(ownerOnly.status, 401);
    assert.equal(
      (await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }, h.owner)).status,
      401,
    );
    assert.equal(
      (await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }, await h.login('outside')))
        .result.ok,
      false,
    );
    const foreign = await h.rpc('run', 'begin', h.begin, await h.login('outside'));
    assert.equal(foreign.result.ok, false);
    for (const patch of [
      { actorId: 'chen' },
      { workspace: { kind: 'local', cwd: '/untrusted' } },
      { model: { ...h.begin.model, provider: 'unregistered' } },
    ])
      assert.equal((await h.rpc('run', 'begin', { ...h.begin, ...patch })).result.ok, false);
    const oversized = await fetch(h.base + '/api/zhuma-run/begin', {
      method: 'POST',
      headers: { cookie: h.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...h.begin, extra: 'x'.repeat(128 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(h.run(), undefined);
    assert.deepEqual(h.ctx.storageDomain.get('zhuma_execution').global.get(), { schemaVersion: 1 });
    assert.equal(
      [...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries()].length,
      0,
    );
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(h.adapter.requests.length, 0);
  },
);

test(
  'actual emitted Host: post-commit logout cleans up without native admission; same-owner absence evidence permits an explicit retry',
  { timeout: 15000 },
  async (t) => {
    const h = await boot(t);
    const entered = deferred(),
      release = deferred();
    const put = h.table.put.bind(h.table);
    let held = false;
    h.table.put = async (key, value) => {
      await put(key, value);
      if (value.nativeExecution && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
    const begin = h.rpc('run', 'begin', h.begin);
    try {
      await entered.promise;
      assert.equal(h.run().resources, 'held');
      const loggedOut = await fetch(h.base + '/zhuma-id/logout', {
        method: 'POST',
        headers: { cookie: h.cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(loggedOut.status, 200);
    } finally {
      release.resolve();
    }
    const result = checked(await begin);
    assert.equal(result.dispatch, 'unknown');
    await waitFor(h.ctx, () => h.run()?.resources === 'settled');
    assert.equal(h.run().attempt.status, 'failed');
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(
      [...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries()].length,
      0,
    );
    const retry = {
      ...h.begin,
      requestId: 'retry-after-unadmitted',
      mode: 'retry',
      newRunId: 'run-2',
      newSegmentId: 'segment-2',
      expectedNodeVersion: h.row().command.version,
      expectedRunVersion: h.row().nativeExecution.version,
    };
    const retried = checked(await h.rpc('run', 'begin', retry, await h.login()));
    assert.equal(retried.dispatch, 'received');
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    await h.ctx.agents.get(h.run().attempt.sessionId).whenIdle();
    assert.equal(h.adapter.requests.length, 1);
    assert.equal(h.run().attempt.generation, 2);
    const bindings = [
      ...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries(),
    ];
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0][1].schemaVersion, 1, 'No fabricated old binding/lineage is written');
    assert.equal(bindings[0][1].scope.runId, 'run-2');
  },
);

test(
  'actual emitted Host: one native close waits for the real held stream before D cleanup and domain shutdown',
  { timeout: 20000 },
  async (t) => {
    const entered = deferred(),
      cancelled = deferred(),
      release = deferred();
    const adapter = new ScriptedAdapter([
      async function* (options) {
        entered.resolve();
        if (!options.signal.aborted)
          await new Promise((resolve) =>
            options.signal.addEventListener('abort', resolve, { once: true }),
          );
        cancelled.resolve();
        await release.promise;
        options.signal.throwIfAborted();
      },
    ]);
    const h = await boot(t, { adapter });
    checked(await h.rpc('run', 'begin', h.begin));
    await entered.promise;
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    let completed = false;
    const closing = h.host.dispose().then(() => {
      completed = true;
    });
    try {
      await cancelled.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(completed, false);
      assert.equal(h.counts.executionClosed, 0);
      assert.equal(h.run().resources, 'held');
    } finally {
      release.resolve();
    }
    await closing;
    assert.equal(h.counts.nativeClosed, 1);
    assert.equal(h.counts.executionClosed, 1);
    const disk = await readFile(join(h.root, 'domains/zhuma_execution.json'), 'utf8');
    assert.ok(disk.includes('"resources":"settled"') || /"resources"\s*:\s*"settled"/u.test(disk));
    assert.equal(h.ctx.agents.list().length, 0);
  },
);
