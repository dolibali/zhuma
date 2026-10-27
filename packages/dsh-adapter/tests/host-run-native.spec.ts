/** Emitted Host + patched official SDK + real member cookies and JSON/JSONL.
 * Model output is a local scripted contract; no remote model or user profile is used.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import FsSandbox from '@deepseek-ai/dsh-fs-sandbox';
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
import {
  applyWorkbenchCommand,
  hashPassword,
  fixture,
  importedSkillSeed,
} from './zhuma-host-run-test-data.js';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';

const deferred = () => Promise.withResolvers();
export function checked(response) {
  assert.equal(response.result.ok, true, response.result.ok ? '' : response.result.error.code);
  return response.result.value;
}
export function waitFor(ctx, predicate) {
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
export async function boot(
  t,
  {
    expert = false,
    skill = false,
    userOnly = false,
    parentSkill = false,
    reviewerExpert = false,
    reviewerSkill = false,
    review = false,
    localWorkspace = undefined,
    failFileLedger = false,
    attachmentInitialization = undefined,
    allowNativeUnavailable = false,
    startPlan = true,
    workflowNodes = undefined,
    adapter = new ScriptedAdapter(['FIRST', 'SECOND']),
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-host-run-'));
  const ctx = new Context();
  const password = randomBytes(24).toString('base64url');
  const counts = { executionOpened: 0, nativeOpened: 0, executionClosed: 0, nativeClosed: 0 };
  let host;
  t.onTestFinished(async () => {
    attachmentInitialization?.resolve();
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
    ...(localWorkspace
      ? [
          [
            SandboxPolicy,
            {
              workspaceRoot: join(root, 'project-files'),
              ...(localWorkspace.policyMode ? { mode: localWorkspace.policyMode } : {}),
            },
          ],
        ]
      : []),
    [localWorkspace?.sandboxed ? FsSandbox : FsLocal, { cwd: root }],
    [WorkingDirectory, { defaultDirectory: root }],
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
  let workspace, workspaceFiber, attachmentFiber;
  const workspaceRoot = join(root, 'project-files');
  if (localWorkspace) {
    await mkdir(workspaceRoot);
    workspaceFiber = await ctx.plugin(WorkspaceRegistry);
    workspace = await ctx.workspaceRegistry.create(workspaceRoot, 'Local contract project');
    await ctx.plugin(ToolFs, { readImage: false });
    if (!attachmentInitialization) await ctx.plugin(LocalAttachmentStore, { dshHome: root });
  }
  if (attachmentInitialization) {
    const registered = deferred();
    attachmentFiber = ctx.plugin({
      name: 'delayed-original-attachment-provider',
      async apply(provider) {
        new LocalAttachmentStore(provider, { dshHome: root });
        registered.resolve();
        await attachmentInitialization.promise;
      },
    });
    await registered.promise;
  }
  if (parentSkill) {
    await ctx.plugin(SkillRegistry);
    ctx.get('skills').register({
      name: 'parent-private-skill',
      description: 'Private parent definition',
      content: 'PARENT_PRIVATE_BODY',
      source: 'contract-seed',
      provider: 'contract-seed',
      resourceBase: { kind: 'opaque', description: 'No filesystem authority' },
      invocation: { modelInvocable: true, userInvocable: true },
    });
    await ctx.plugin(ToolSkill);
  }
  adapter.listModels = async (provider) => [
    { provider, id: 'contract-model', name: 'Contract model' },
  ];
  ctx.llm.registerAdapter(['contract'], adapter);
  const originalOpen = ctx.storageDomain.open.bind(ctx.storageDomain);
  ctx.storageDomain.open = async (spec) => {
    if (failFileLedger && spec.name === 'zhuma_files')
      throw Error('Injected original file ledger initialization failure');
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
  const imported =
    skill || reviewerSkill ? await importedSkillSeed(data.state, userOnly) : undefined;
  const planning = imported?.state ?? data.state;
  if (reviewerExpert) {
    planning.participants.push({
      ...planning.participants.find((item) => item.id === 'qa'),
      id: 'qa-review',
      name: 'Independent review expert',
      instructions:
        'Independently read the Host-bound fixed artifact and use the selected review method.',
      resourceBindings: { skillIds: reviewerSkill ? ['api-skill'] : [], mcpIds: [] },
    });
  }
  planning.participants.find((item) => item.id === 'qa').instructions = 'EXACT_PLAN_EXPERT_METHOD';
  const state = applyWorkbenchCommand(planning, {
    type: 'save-task',
    task: {
      ...data.task,
      ...(reviewerExpert ? { participantIds: [...data.task.participantIds, 'qa-review'] } : {}),
      status: 'ready',
      workflows: [
        {
          ...data.task.workflows[0],
          nodes: workflowNodes
            ? workflowNodes(data.node)
            : [
                {
                  ...data.node,
                  assigneeId: expert ? 'qa' : 'chen',
                  reviewerIds: review ? ['chen'] : [],
                  reviewRequired: review,
                  skillIds: skill ? ['api-skill'] : [],
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
    ...(workspace && localWorkspace.configured !== false
      ? {
          localExecution: {
            deviceId: 'local-contract-device',
            bindings: [
              {
                id: 'project-files',
                generation: 1,
                actorId: 'chen',
                spaceId: 'north',
                projectId: 'project',
                workspaceId: workspace.id,
                access: localWorkspace.access ?? 'write',
                publish: localWorkspace.publish ?? [],
              },
            ],
          },
        }
      : {}),
  });
  await host;
  if (imported)
    await ctx.storageDomain
      .get('zhuma_asset_packages')
      .table('versions')
      .put(imported.record.versionId, imported.record);
  const nativeFibers = [...(ctx.registry.get(Host.nativeRunPlugin)?.fibers ?? [])];
  assert.equal(nativeFibers.length, 1);
  const nativeReadiness = await Promise.allSettled(nativeFibers.map((fiber) => fiber.await()));
  if (!allowNativeUnavailable) {
    const failed = nativeReadiness.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
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
      headers: {
        'content-type': 'application/json',
        cookie: credential,
        ...(group === 'workspaces' ? { origin: base } : {}),
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: `zhuma-${group}/${endpoint}`,
        payload,
      }),
    });
    return { status: response.status, ...(await response.json()) };
  }
  if (startPlan)
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
  const row = () => [...table.entries()][0]?.[1];
  const run = () => row().nativeExecution?.runs.at(-1);
  const begin = {
    ...locator,
    requestId: 'first-run',
    spaceId: 'north',
    expectedNodeVersion: row()?.command.version ?? 0,
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
    workspaceRoot,
    workspaceFiber,
    attachmentFiber,
    nativeReadiness,
    workflowLocation: {
      spaceId: 'north',
      taskId: 'task',
      planId: plan.id,
      revision: plan.revision,
    },
    async remountHost() {
      await host.restart();
      const fibers = [...(ctx.registry.get(Host.nativeRunPlugin)?.fibers ?? [])];
      assert.equal(fibers.length, 1);
      await Promise.all(fibers.map((fiber) => fiber.await()));
    },
  };
}

for (const selected of [false, true])
  test(
    `actual emitted Host resources: ${selected ? 'selected original user-only Skill' : 'empty domain'} uses original member and Run without parent private reads`,
    { timeout: 20000 },
    async (t) => {
      const h = await boot(t, { skill: selected, userOnly: true, parentSkill: true });
      const parent = h.ctx.get('skills');
      const get = parent.get;
      let parentReads = 0;
      parent.get = function (...args) {
        parentReads++;
        return get.apply(this, args);
      };
      t.onTestFinished(() => {
        parent.get = get;
      });
      const first = checked(await h.rpc('run', 'begin', h.begin));
      assert.equal(first.dispatch, 'received');
      await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
      const target = { ...h.locator, runId: 'run-1' };
      const view = checked(await h.rpc('run', 'read', target));
      const agent = h.ctx.agents.get(view.native.sessionId);
      await agent.whenIdle();
      const frozen = JSON.stringify(h.run().composition);
      const expected = selected ? ['skill'] : [];
      assert.deepEqual(h.run().composition.payload.toolAllowlist, expected);
      assert.deepEqual(
        (h.adapter.requests[0].tools ?? []).map((tool) => tool.name),
        expected,
      );
      assert.equal(
        JSON.stringify(h.adapter.requests[0]).includes('SELECTED_ORIGINAL_SKILL_BODY'),
        false,
      );
      assert.equal(h.adapter.requests.length, 1);
      const outside = await h.login('outside');
      const rejected = await h.rpc(
        'run',
        'send',
        {
          ...target,
          generation: 1,
          segmentId: 'segment-1',
          requestId: 'outsider',
          text: '/demo',
          mode: 'followup',
        },
        outside,
      );
      assert.equal(rejected.result.ok, false);
      assert.equal(h.adapter.requests.length, 1);
      checked(
        await h.rpc('run', 'send', {
          ...target,
          generation: 1,
          segmentId: 'segment-1',
          requestId: 'explicit',
          text: selected
            ? `/${h.run().composition.payload.resources.skills[0].name}`
            : '/parent-private-skill',
          mode: 'followup',
        }),
      );
      await agent.whenIdle();
      assert.equal(h.adapter.requests.length, 2);
      assert.equal(parentReads, 0);
      assert.equal(JSON.stringify(h.adapter.requests[1]).includes('PARENT_PRIVATE_BODY'), false);
      assert.equal(
        JSON.stringify(h.adapter.requests[1]).includes('SELECTED_ORIGINAL_SKILL_BODY'),
        selected,
      );
      assert.deepEqual(
        (h.adapter.requests[1].tools ?? []).map((tool) => tool.name),
        expected,
      );
      assert.equal(JSON.stringify(h.run().composition), frozen);
    },
  );

function completionResponse(text, links) {
  return function* () {
    const args = JSON.stringify({ text, links });
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: 'explicit-host-result',
      name: 'complete_work',
      argumentsDelta: args,
    };
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'explicit-host-result',
        name: 'complete_work',
        arguments: args,
      },
    };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}

for (const text of ['Original Host fixed result.', '中'.repeat(100000)])
  test(
    `actual emitted Host fixed result: explicit expert result saves the exact reviewed artifact (${text.length} characters)`,
    { timeout: 20000 },
    async (t) => {
      const links = ['https://example.com/host-result'];
      const h = await boot(t, {
        expert: true,
        review: true,
        adapter: new ScriptedAdapter([completionResponse(text, links)]),
      });
      const first = checked(await h.rpc('run', 'begin', h.begin));
      assert.equal(first.dispatch, 'received');
      await waitFor(h.ctx, () => h.row().artifactVersions.length === 1);
      const run = h.run();
      assert.equal(run.attempt.status, 'completed');
      assert.equal(run.resources, 'settled');
      assert.equal(h.ctx.agents.list().length, 0);
      assert.equal(h.row().command.status, 'in-review');
      assert.equal(h.row().rounds.length, 1);
      const artifact = h.row().artifactVersions[0];
      assert.equal(artifact.text, text);
      assert.deepEqual(artifact.links, links);
      assert.equal(artifact.producerRunId, 'run-1');
      assert.equal(artifact.submittedBy, 'qa');
      assert.equal(run.resultDelivery.artifactVersionId, artifact.id);
      assert.equal(run.resultDelivery.roundId, h.row().rounds[0].id);
      assert.deepEqual(
        h.adapter.requests[0].tools.map((tool) => tool.name),
        ['complete_work'],
      );
      const target = { ...h.locator, runId: 'run-1' };
      const saved = JSON.stringify(h.row());
      for (let i = 0; i < 2; i++) {
        const view = checked(await h.rpc('run', 'read', target));
        assert.equal(view.status, 'completed');
        assert.equal(view.resultDelivery.kind, 'delivered');
        assert.equal(view.resultDelivery.artifactVersionId, artifact.id);
        assert.equal(view.resultDelivery.roundId, h.row().rounds[0].id);
        assert.ok(Buffer.byteLength(JSON.stringify(view)) < 8192);
        const page = checked(await h.rpc('run', 'history', target));
        assert.ok(Buffer.byteLength(JSON.stringify(page)) < 262144);
        assert.equal(JSON.stringify(page).includes(text), false);
      }
      assert.equal(JSON.stringify(h.row()), saved);
      assert.equal(h.adapter.requests.length, 1);
    },
  );

test(
  'actual emitted Host fixed result: a human assignee using a plan expert keeps manual submission',
  { timeout: 15000 },
  async (t) => {
    const h = await boot(t);
    checked(
      await h.rpc('run', 'begin', {
        ...h.begin,
        executor: { kind: 'plan-expert', ref: { id: 'qa', version: h.begin.planId } },
      }),
    );
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    await h.ctx.agents.get(h.run().attempt.sessionId).whenIdle();
    assert.equal(h.run().composition.payload.resultIntentTool, undefined);
    assert.deepEqual(h.adapter.requests[0].tools ?? [], []);
    assert.equal(h.run().attempt.status, 'running', 'native idle never submits a result');
    assert.equal(h.row().artifactVersions.length, 0);
    assert.equal(h.row().rounds.length, 0);
    assert.equal(
      checked(await h.rpc('run', 'read', { ...h.locator, runId: 'run-1' })).resultDelivery,
      undefined,
    );
  },
);

test(
  'actual emitted Host fixed result: stopping the expert before declaration cannot produce an artifact',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred();
    const h = await boot(t, {
      expert: true,
      adapter: new ScriptedAdapter([
        async function* (options) {
          entered.resolve();
          if (!options.signal.aborted)
            await new Promise((resolve) =>
              options.signal.addEventListener('abort', resolve, { once: true }),
            );
          options.signal.throwIfAborted();
          yield* completionResponse('Must not be delivered.', [])();
        },
      ]),
    });
    checked(await h.rpc('run', 'begin', h.begin));
    await entered.promise;
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    const target = { ...h.locator, runId: 'run-1' };
    const view = checked(await h.rpc('run', 'read', target));
    checked(
      await h.rpc('run', 'stop', {
        ...target,
        spaceId: 'north',
        generation: 1,
        segmentId: 'segment-1',
        requestId: 'stop-before-result',
        expectedNodeVersion: view.nodeVersion,
        expectedRunVersion: view.runVersion,
      }),
    );
    assert.equal(h.run().attempt.status, 'cancelled');
    assert.equal(h.run().resources, 'settled');
    assert.equal(h.row().artifactVersions.length, 0);
    assert.equal(h.row().rounds.length, 0);
    assert.equal(h.run().resultDelivery, undefined);
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(h.adapter.requests.length, 1);
  },
);

test(
  'actual emitted Host fixed result: the real HTTP observer stays bounded during a 100000-character completion',
  { timeout: 20000 },
  async (t) => {
    const text = '中'.repeat(100000);
    const release = deferred();
    t.onTestFinished(() => release.resolve());
    const h = await boot(t, {
      expert: true,
      adapter: new ScriptedAdapter([
        'Earlier ordinary turn.',
        async function* () {
          await release.promise;
          yield* completionResponse(text, [])();
        },
      ]),
    });
    checked(await h.rpc('run', 'begin', h.begin));
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    const agent = h.ctx.agents.get(h.run().attempt.sessionId);
    await agent.whenIdle();
    const target = { ...h.locator, runId: 'run-1' };
    const history = checked(await h.rpc('run', 'history', target));
    const ui = new AbortController(),
      subscribed = deferred();
    const response = await fetch(h.base + '/api/zhuma-run/observe', {
      method: 'POST',
      headers: { cookie: h.cookie, 'content-type': 'application/json' },
      signal: ui.signal,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'result-stream',
        method: 'zhuma-run/observe',
        payload: { ...target, after: history.nextAfter },
      }),
    });
    assert.equal(response.status, 200);
    const frames = [];
    const reading = (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          buffer += decoder.decode(item.value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const envelope = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            assert.equal(envelope.type, 'server-frame');
            assert.equal(envelope.rpcId, 'result-stream');
            assert.ok(Buffer.byteLength(JSON.stringify(envelope.frame)) < 262144);
            frames.push(envelope.frame);
            if (envelope.frame.type === 'ready') subscribed.resolve();
            if (envelope.frame.type === 'assistant-stream' && envelope.frame.frame.type === 'end')
              return;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    })();
    void reading.catch(() => undefined);
    try {
      await subscribed.promise;
      checked(
        await h.rpc('run', 'send', {
          ...target,
          generation: 1,
          segmentId: 'segment-1',
          requestId: 'finish-with-large-result',
          mode: 'followup',
          text: 'Submit the finished work.',
        }),
      );
      release.resolve();
      await reading;
      await waitFor(h.ctx, () => h.row().artifactVersions.length === 1);
      assert.ok(
        frames.some(
          (frame) => frame.type === 'assistant-stream' && frame.frame.toolName === 'complete_work',
        ),
      );
      assert.equal(JSON.stringify(frames).includes('中'.repeat(100)), false);
      assert.equal(h.row().artifactVersions[0].text, text);
      assert.equal(h.run().attempt.status, 'completed');
      assert.equal(h.adapter.requests.length, 2);
    } finally {
      ui.abort();
      release.resolve();
      await reading.catch(() => undefined);
    }
  },
);

test(
  'actual emitted Host fixed result: unexpected native provider disposal without intent fails instead of submitting',
  { timeout: 15000 },
  async (t) => {
    const h = await boot(t, { expert: true });
    checked(await h.rpc('run', 'begin', h.begin));
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    const agent = h.ctx.agents.get(h.run().attempt.sessionId);
    await agent.whenIdle();
    assert.equal(h.run().attempt.status, 'running');
    let disposed = 0;
    const stopDisposed = h.ctx.on(
      'agent/disposed',
      ({ agent: actual }) => {
        if (actual === agent) disposed++;
      },
      { global: true },
    );
    const loopFibers = [...(h.ctx.registry.get(Loop)?.fibers ?? [])];
    assert.equal(loopFibers.length, 1);
    try {
      await loopFibers[0].dispose();
      await waitFor(h.ctx, () => h.run()?.resources === 'settled').catch(() => {
        assert.fail(
          JSON.stringify({
            status: h.run().attempt.status,
            resources: h.run().resources,
            stopPhase: h.run().attempt.stopPhase,
            agents: h.ctx.agents.list().length,
            disposed,
          }),
        );
      });
    } finally {
      stopDisposed();
    }
    assert.equal(disposed, 1, 'The original SDK emitted the actual Agent disposal');
    assert.equal(h.run().attempt.status, 'failed');
    assert.equal(h.row().artifactVersions.length, 0);
    assert.equal(h.row().rounds.length, 0);
    assert.equal(h.run().resultDelivery, undefined);
    assert.equal(h.ctx.agents.list().length, 0);
  },
);

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

test(
  'actual emitted Host: normal member HTTP streams partial text, preserves a single final key and exposes queued inbox without another model call',
  { timeout: 20000 },
  async (t) => {
    const release = deferred(),
      entered = deferred();
    t.onTestFinished(() => release.resolve());
    const h = await boot(t, {
      adapter: new ScriptedAdapter([
        'seed',
        async function* () {
          yield { type: 'block-start', index: 0, blockType: 'reasoning' };
          yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE_STREAM_REASONING' };
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'reasoning', text: 'PRIVATE_STREAM_REASONING' },
          };
          yield { type: 'block-start', index: 1, blockType: 'text' };
          yield { type: 'text-delta', index: 1, text: 'early body' };
          entered.resolve();
          await release.promise;
          yield { type: 'text-delta', index: 1, text: ' complete' };
          yield {
            type: 'block-end',
            index: 1,
            block: { type: 'text', text: 'early body complete' },
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      ]),
    });
    checked(await h.rpc('run', 'begin', h.begin));
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    const target = { ...h.locator, runId: 'run-1' };
    const agent = h.ctx.agents.get(h.run().attempt.sessionId);
    await agent.whenIdle();
    const history = checked(await h.rpc('run', 'history', target));
    const ui = new AbortController(),
      partial = deferred(),
      subscribed = deferred();
    t.onTestFinished(() => ui.abort());
    const response = await fetch(h.base + '/api/zhuma-run/observe', {
      method: 'POST',
      headers: { cookie: h.cookie, 'content-type': 'application/json' },
      signal: ui.signal,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'stream',
        method: 'zhuma-run/observe',
        payload: { ...target, after: history.nextAfter },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    const frames = [];
    const reading = (async () => {
      const reader = response.body.getReader();
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const envelope = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            assert.equal(envelope.rpcId, 'stream');
            assert.equal(envelope.type, 'server-frame');
            const frame = envelope.frame;
            frames.push(frame);
            if (frame.type === 'ready') subscribed.resolve();
            if (frame.type === 'assistant-stream' && frame.frame.text === 'early body')
              partial.resolve();
            if (frame.type === 'assistant-stream' && frame.frame.type === 'end') return;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    })();
    try {
      await subscribed.promise;
      checked(
        await h.rpc('run', 'send', {
          ...target,
          generation: 1,
          segmentId: 'segment-1',
          requestId: 'live',
          text: 'explicit followup',
          mode: 'followup',
        }),
      );
      await entered.promise;
      await partial.promise;
      assert.equal(agent.status, 'running');
      assert.equal(
        frames.some((frame) => frame.type === 'message' && frame.role === 'assistant'),
        false,
      );
      release.resolve();
      await agent.whenIdle();
      await reading;
      const saved = frames.filter(
        (frame) => frame.type === 'message' && frame.role === 'assistant',
      );
      const end = frames.find(
        (frame) => frame.type === 'assistant-stream' && frame.frame.type === 'end',
      );
      assert.equal(saved.length, 1);
      assert.equal(saved[0].text, 'early body complete');
      assert.equal(saved[0].messageKey, end.frame.outcome.messageKey);
      assert.equal(JSON.stringify(frames).includes('PRIVATE_STREAM_REASONING'), false);
      assert.equal(JSON.stringify(frames).includes('configurationId'), false);
      assert.equal(h.adapter.requests.length, 2);
      checked(
        await h.rpc('run', 'send', {
          ...target,
          generation: 1,
          segmentId: 'segment-1',
          requestId: 'park',
          text: 'parked input',
          mode: 'queue',
        }),
      );
      const inbox = checked(await h.rpc('run', 'inbox', target));
      assert.equal(inbox.items[0].text, 'parked input');
      assert.equal(inbox.items[0].status, 'received');
      assert.equal(h.adapter.requests.length, 2, 'read and queue never wake an idle Agent');
      const denied = await h.rpc('run', 'inbox', target, await h.login('outside'));
      assert.equal(denied.result.ok, false);
    } finally {
      release.resolve();
      ui.abort();
      await reading.catch(() => undefined);
    }
  },
);
