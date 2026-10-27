/** Emitted Host + patched official SDK + real member cookies and JSON/JSONL.
 * Model output is a local scripted contract; no remote model or user profile is used.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
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
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';

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
  {
    expert = false,
    workflow = false,
    adapter = new ScriptedAdapter(['LOCAL_ONLY']),
    sharedRoot,
    seed = false,
  } = {},
) {
  const root = sharedRoot;
  assert(root, 'Explicit isolated test directory required');
  const ctx = new Context();
  const password = 'synthetic-test-credential-only';
  const counts = { executionOpened: 0, nativeOpened: 0, executionClosed: 0, nativeClosed: 0 };
  let host;
  const nativeReads = {
    migrationOrigin: 0,
    migrationOriginMissing: 0,
    retirement: 0,
    retirementMissing: 0,
  };
  let nativeTable;
  t.onTestFinished(async () => {
    await host?.dispose();
    await ctx.fiber.dispose();
  });
  for (const [plugin, config] of [
    [LlmRuntime],
    [Sessions],
    [Projections],
    [Prompt],
    [Tools],
    [FsLocal, { cwd: root }],
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
  // The new Host compatibility phase reopens an existing V1 business receipt
  // under the real dual-protocol owner. The writer remains the legacy Host.
  if (
    process.env.ZHUMA_HOST_COLD_ATTACHMENTS === 'reader' &&
    process.env.ZHUMA_HOST_COLD_MODE === 'read'
  )
    await ctx.plugin(LocalAttachmentStore, { dshHome: root });
  if (workflow)
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
    if (key === 'native') {
      nativeTable = domain.table('bindings');
      const actualGet = nativeTable.get.bind(nativeTable);
      nativeTable.get = (address) => {
        const value = actualGet(address);
        const trace = new Error().stack ?? '';
        if (trace.includes('migrationOrigin')) {
          nativeReads.migrationOrigin++;
          if (value === undefined) nativeReads.migrationOriginMissing++;
        }
        if (trace.includes('retireScope')) {
          nativeReads.retirement++;
          if (value === undefined) nativeReads.retirementMissing++;
        }
        return value;
      };
    }
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
  if (seed) {
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
  }
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
          nodes: workflow
            ? [
                {
                  ...data.node,
                  id: 'reviewed',
                  assigneeId: 'qa',
                  reviewerIds: ['chen'],
                  reviewRequired: true,
                  dependsOn: [],
                  skillIds: [],
                  mcpIds: [],
                },
                {
                  ...data.node,
                  id: 'accepted',
                  assigneeId: 'qa',
                  reviewerIds: [],
                  reviewRequired: false,
                  dependsOn: [],
                  skillIds: [],
                  mcpIds: [],
                },
                {
                  ...data.node,
                  id: 'join',
                  assigneeId: 'qa',
                  reviewerIds: [],
                  reviewRequired: false,
                  dependsOn: ['reviewed', 'accepted'],
                  skillIds: [],
                  mcpIds: [],
                },
                {
                  ...data.node,
                  id: 'human',
                  assigneeId: 'chen',
                  reviewerIds: [],
                  reviewRequired: false,
                  dependsOn: ['join'],
                  skillIds: [],
                  mcpIds: [],
                },
              ]
            : [
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
  if (seed) {
    const workbenchSeed = await ctx.storageDomain.open(Host.workbenchDomainSpec);
    await workbenchSeed.global.set(state);
    await workbenchSeed.close();
  }
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
  if (seed) {
    checked(
      await rpc('exec', 'start-plan', {
        taskId: 'task',
        planId: plan.id,
        revision: plan.revision,
        idempotencyKey: 'start-plan',
        spaceId: 'north',
      }),
    );
  }
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
    nativeReads,
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
    workflowLocation: {
      spaceId: 'north',
      taskId: 'task',
      planId: plan.id,
      revision: plan.revision,
    },
  };
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const fixedText = '冷'.repeat(100000);
function* fixedResponse() {
  const args = JSON.stringify({ text: fixedText, links: [] });
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield {
    type: 'tool-call-delta',
    index: 0,
    id: 'cold-result',
    name: 'complete_work',
    argumentsDelta: args,
  };
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'cold-result', name: 'complete_work', arguments: args },
  };
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
const optionalBytes = (path) =>
  readFile(path).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
async function businessBytes(root) {
  const files = await Promise.all(
    ['zhuma_execution', 'zhuma_native_work_sessions'].map((name) =>
      optionalBytes(join(root, 'domains', `${name}.json`)),
    ),
  );
  return files.map((bytes) => (bytes === undefined ? null : digest(bytes)));
}
function unadmitted(h) {
  assert.equal(h.run().attempt.status, 'failed');
  assert.equal(h.run().resources, 'settled');
  assert.equal(h.run().attempt.acknowledged, false);
  assert.equal(h.run().attempt.sessionId, undefined);
  assert.equal(h.run().attempt.executorRunId, undefined);
  assert.equal(
    [...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries()].length,
    0,
  );
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.adapter.requests.length, 0);
}

const workflowNode = (h, id) =>
  [...h.table.entries()].map(([, row]) => row).find((row) => row.nodeId === id);
const workflowRows = (h) => [...h.table.entries()];
function* workflowResponse() {
  const args = JSON.stringify({ text: 'Fixed cold workflow result', links: [] });
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield {
    type: 'tool-call-delta',
    index: 0,
    id: 'finish',
    name: 'complete_work',
    argumentsDelta: args,
  };
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'finish', name: 'complete_work', arguments: args },
  };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
test(
  'formal Host workflow: explicit new-process resume cleans only original bound scopes and never reruns completed branches',
  { timeout: 20000 },
  async (t) => {
    const mode = process.env.ZHUMA_HOST_COLD_MODE;
    const root = process.env.ZHUMA_HOST_COLD_ROOT;
    assert(root && ['write', 'read'].includes(mode));
    const h = await boot(t, {
      sharedRoot: root,
      seed: mode === 'write',
      workflow: true,
      adapter: new ScriptedAdapter(
        mode === 'write' ? [workflowResponse, workflowResponse] : [workflowResponse],
      ),
    });
    if (mode === 'write') {
      const started = checked(
        await h.rpc('workflow', 'start', {
          ...h.workflowLocation,
          requestId: 'workflow-start',
          model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
          workspace: { kind: 'text-only' },
          concurrent: 2,
        }),
      );
      await waitFor(
        h.ctx,
        () =>
          workflowNode(h, 'reviewed').command.status === 'in-review' &&
          workflowNode(h, 'accepted').command.status === 'completed',
      );
      assert.equal(h.adapter.requests.length, 2);
      const rows = workflowRows(h);
      assert.equal(workflowNode(h, 'join').command.status, 'blocked');
      assert.equal(workflowNode(h, 'human').nativeExecution, undefined);
      await h.host.dispose();
      assert.equal(h.ctx.agents.list().length, 0);
      await writeFile(
        join(root, 'expected-workflow.json'),
        JSON.stringify({
          pid: process.pid,
          cookieDigest: digest(h.cookie),
          rows,
          view: started,
          businessDigests: await businessBytes(root),
        }),
      );
      await writeFile(
        join(root, 'write-report.json'),
        JSON.stringify({
          pid: process.pid,
          variant: 'workflow',
          modelRequests: 2,
          originalHostClosed: true,
          completedRuns: 2,
        }),
      );
      return;
    }
    const expected = JSON.parse(await readFile(join(root, 'expected-workflow.json'), 'utf8'));
    assert.notEqual(process.pid, expected.pid);
    assert.notEqual(digest(h.cookie), expected.cookieDigest);
    assert.deepEqual(workflowRows(h), expected.rows);
    const before = await businessBytes(root);
    let view;
    for (let i = 0; i < 2; i++) {
      view = checked(await h.rpc('workflow', 'read', h.workflowLocation));
      assert.equal(view.requiresResume, true);
      assert.equal(view.activeRunCount, 0);
    }
    assert.deepEqual(
      await businessBytes(root),
      before,
      'Passive reads must not perform cleanup or change business facts',
    );
    assert.equal(h.nativeReads.retirement, 0);
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(h.adapter.requests.length, 0);
    const control = {
      ...h.workflowLocation,
      requestId: 'workflow-resume',
      intentId: view.intent.intentId,
      generation: view.intent.generation,
      expectedVersion: view.intent.version,
    };
    assert.equal(
      (await h.rpc('workflow', 'resume', control, await h.login('outside'))).result.ok,
      false,
    );
    for (const invalid of [
      { ...control, spaceId: 'foreign' },
      { ...control, generation: control.generation + 1 },
      { ...control, expectedVersion: control.expectedVersion + 1 },
    ])
      assert.equal((await h.rpc('workflow', 'resume', invalid)).result.ok, false);
    const revoked = await h.login();
    assert.equal(
      (
        await fetch(h.base + '/zhuma-id/logout', {
          method: 'POST',
          headers: { cookie: revoked, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      200,
    );
    assert.equal((await h.rpc('workflow', 'resume', control, revoked)).result.ok, false);
    assert.equal(h.nativeReads.retirement, 0, 'An unrelated member must not initiate cleanup');
    const resumed = checked(await h.rpc('workflow', 'resume', control));
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.requiresResume, false);
    const cleanupReads = h.nativeReads.retirement;
    assert.equal(
      checked(await h.rpc('workflow', 'resume', control)).intent.generation,
      resumed.intent.generation,
    );
    assert.equal(
      h.nativeReads.retirement,
      cleanupReads,
      'A replay must retain the original resume receipt',
    );
    assert.equal(
      h.adapter.requests.length,
      0,
      'Resume must not rerun submitted or accepted branches',
    );
    for (const id of ['reviewed', 'accepted'])
      assert.deepEqual(
        workflowNode(h, id),
        expected.rows.map(([, row]) => row).find((row) => row.nodeId === id),
      );
    const reviewed = workflowNode(h, 'reviewed'),
      round = reviewed.rounds.at(-1);
    checked(
      await h.rpc('exec', 'ballot', {
        ...h.locator,
        nodeId: 'reviewed',
        expectedVersion: reviewed.command.version,
        idempotencyKey: 'review-after-cold',
        roundId: round.id,
        artifactVersionId: round.artifactVersionId,
        action: 'approve',
      }),
    );
    await waitFor(
      h.ctx,
      () =>
        workflowNode(h, 'join').command.status === 'completed' &&
        workflowNode(h, 'human').command.status === 'ready',
    );
    assert.equal(h.adapter.requests.length, 1);
    assert.equal(workflowNode(h, 'join').handoff.inputRefs.length, 2);
    assert.equal(workflowNode(h, 'human').command.status, 'ready');
    for (const id of ['reviewed', 'accepted', 'join'])
      assert.equal(workflowNode(h, id).nativeExecution.runs.length, 1);
    checked(
      await h.rpc('exec', 'submit', {
        ...h.locator,
        nodeId: 'human',
        expectedVersion: workflowNode(h, 'human').command.version,
        idempotencyKey: 'human-after-cold',
        text: 'Final manual delivery',
        links: [],
      }),
    );
    assert.equal(checked(await h.rpc('workflow', 'read', h.workflowLocation)).state, 'completed');
    await writeFile(
      join(root, 'read-report.json'),
      JSON.stringify({
        pid: process.pid,
        variant: 'workflow',
        distinctProcess: true,
        freshMemberCookie: true,
        noImplicitCleanup: true,
        completedBranchesNotRerun: true,
        modelRequests: 1,
        workflowCompleted: true,
      }),
    );
  },
);

// The two invocations run in distinct OS processes with the same explicit
// synthetic home. No emitted Host callback or production source is patched.
test(
  'formal Host: explicit cold retry preserves old facts, authority and canonical dispatch',
  { timeout: 20000 },
  async (t) => {
    const mode = process.env.ZHUMA_HOST_COLD_MODE;
    const variant = process.env.ZHUMA_HOST_COLD_VARIANT;
    const root = process.env.ZHUMA_HOST_COLD_ROOT;
    assert(root && ['write', 'read'].includes(mode));
    assert(['unadmitted', 'unknown', 'bound', 'revoked', 'result'].includes(variant));
    const replies =
      variant === 'result' && mode === 'write'
        ? [fixedResponse]
        : variant === 'bound' || (variant === 'unadmitted' && mode === 'read')
          ? ['LOCAL_SCRIPTED_ONLY']
          : [];
    const h = await boot(t, {
      sharedRoot: root,
      seed: mode === 'write',
      expert: variant === 'result',
      adapter: new ScriptedAdapter(replies),
    });
    if (variant === 'result') {
      const target = { ...h.locator, runId: 'run-1' };
      if (mode === 'write') {
        const put = h.table.put.bind(h.table);
        let lostReply = false;
        h.table.put = async (key, value) => {
          await put(key, value);
          if (!lostReply && value.nativeExecution?.runs.at(-1)?.resultDelivery) {
            lostReply = true;
            throw Error('Injected lost durable delivery response');
          }
        };
        try {
          checked(await h.rpc('run', 'begin', h.begin));
          await waitFor(h.ctx, () => h.row().artifactVersions.length === 1);
          assert.equal(
            checked(await h.rpc('run', 'read', target)).resultDelivery.kind,
            'delivered',
          );
          assert.equal(lostReply, true);
        } finally {
          h.table.put = put;
        }
        assert.equal(h.row().artifactVersions[0].text, fixedText);
        assert.equal(h.ctx.agents.list().length, 0);
        await writeFile(
          join(root, 'expected.json'),
          JSON.stringify({
            pid: process.pid,
            cookieDigest: digest(h.cookie),
            row: h.row(),
            businessDigests: await businessBytes(root),
          }),
        );
        await writeFile(
          join(root, 'write-report.json'),
          JSON.stringify({
            pid: process.pid,
            variant,
            lostReply,
            modelRequests: h.adapter.requests.length,
            artifacts: h.row().artifactVersions.length,
          }),
        );
      } else {
        const expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8'));
        assert.notEqual(process.pid, expected.pid);
        assert.notEqual(digest(h.cookie), expected.cookieDigest);
        for (let i = 0; i < 2; i++) {
          const view = checked(await h.rpc('run', 'read', target));
          assert.equal(view.resultDelivery.kind, 'delivered');
          assert.equal(view.resultDelivery.artifactVersionId, expected.row.artifactVersions[0].id);
          assert.ok(Buffer.byteLength(JSON.stringify(view)) < 8192);
          const page = checked(await h.rpc('run', 'history', target));
          assert.equal(JSON.stringify(page).includes('冷'.repeat(100)), false);
        }
        assert.equal(
          (await h.rpc('run', 'read', target, await h.login('outside'))).result.ok,
          false,
        );
        assert.deepEqual(h.row(), expected.row);
        assert.deepEqual(await businessBytes(root), expected.businessDigests);
        assert.equal(h.adapter.requests.length, 0);
        assert.equal(h.ctx.agents.list().length, 0);
        assert.equal(h.nativeReads.migrationOrigin, 0);
        await writeFile(
          join(root, 'read-report.json'),
          JSON.stringify({
            pid: process.pid,
            variant,
            distinctProcess: true,
            freshMemberCookie: true,
            oldRunUnchanged: true,
            modelRequests: 0,
            artifacts: 1,
            bytesUnchanged: true,
          }),
        );
      }
      return;
    }
    if (mode === 'write') {
      if (variant === 'unknown') {
        const table = h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings');
        const put = table.put.bind(table);
        let attempts = 0;
        table.put = async (key, value) => {
          if (++attempts === 1) throw Error('Injected binding persistence failure');
          return put(key, value);
        };
        assert.equal(checked(await h.rpc('run', 'begin', h.begin)).dispatch, 'unknown');
        await waitFor(h.ctx, () => h.run()?.resources === 'settled');
        table.put = put;
        unadmitted(h);
        assert.equal(h.run().dispatch, 'unknown');
        assert.equal(attempts, 1);
      } else if (variant === 'bound') {
        assert.equal(checked(await h.rpc('run', 'begin', h.begin)).dispatch, 'received');
        await waitFor(h.ctx, () => h.run().attempt.acknowledged);
        const logout = await fetch(h.base + '/zhuma-id/logout', {
          method: 'POST',
          headers: { cookie: h.cookie, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(logout.status, 200);
        await waitFor(h.ctx, () => h.run()?.resources === 'settled');
        assert.equal(h.run().attempt.status, 'failed');
        assert.equal(h.run().attempt.acknowledged, true);
        assert.equal(h.run().dispatch, 'received');
        assert.equal(
          [...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries()]
            .length,
          1,
        );
      } else {
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
        const starting = h.rpc('run', 'begin', h.begin);
        try {
          await entered.promise;
          const logout = await fetch(h.base + '/zhuma-id/logout', {
            method: 'POST',
            headers: { cookie: h.cookie, 'content-type': 'application/json' },
            body: '{}',
          });
          assert.equal(logout.status, 200);
        } finally {
          release.resolve();
        }
        assert.equal(checked(await starting).dispatch, 'unknown');
        await waitFor(h.ctx, () => h.run()?.resources === 'settled');
        unadmitted(h);
        assert.equal(h.run().dispatch, 'reserved');
        assert(h.nativeReads.retirementMissing > 0);
      }
      await writeFile(
        join(root, 'expected.json'),
        JSON.stringify({
          pid: process.pid,
          cookieDigest: digest(h.cookie),
          row: h.row(),
          begin: h.begin,
          businessDigests: await businessBytes(root),
        }),
      );
      await writeFile(
        join(root, 'write-report.json'),
        JSON.stringify({
          pid: process.pid,
          variant,
          dispatch: h.run().dispatch,
          acknowledged: h.run().attempt.acknowledged,
          bindings: [
            ...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries(),
          ].length,
          modelRequests: h.adapter.requests.length,
        }),
      );
      return;
    }
    const expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8'));
    assert.notEqual(process.pid, expected.pid);
    assert.notEqual(digest(h.cookie), expected.cookieDigest);
    assert.deepEqual(h.row(), expected.row);
    assert.deepEqual(await businessBytes(root), expected.businessDigests);
    const beforeRead = await businessBytes(root);
    assert.equal((await h.rpc('run', 'read', { ...h.locator, runId: 'run-1' })).status, 200);
    assert.deepEqual(await businessBytes(root), beforeRead);
    assert.equal(h.nativeReads.migrationOrigin, 0);
    const replay = checked(await h.rpc('run', 'begin', expected.begin));
    assert.equal(replay.dispatch, expected.row.nativeExecution.runs.at(-1).dispatch);
    assert.equal(h.nativeReads.migrationOrigin, 0, 'same-key replay is not recovery');
    assert.deepEqual(await businessBytes(root), beforeRead);
    const retry = {
      ...expected.begin,
      requestId: 'explicit-cold-retry',
      mode: 'retry',
      newRunId: 'run-2',
      newSegmentId: 'segment-2',
      expectedNodeVersion: h.row().command.version,
      expectedRunVersion: h.row().nativeExecution.version,
    };
    let outcome;
    if (variant === 'revoked') {
      // Hold the real second-generation durable put, revoke the original cookie,
      // then let normal dispatch open its real grant. No fake authority/drain.
      const put = h.table.put.bind(h.table),
        entered = deferred(),
        release = deferred();
      let held = false;
      h.table.put = async (key, value) => {
        await put(key, value);
        if (!held && value.nativeExecution?.runs.at(-1)?.attempt.generation === 2) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      };
      const starting = h.rpc('run', 'begin', retry);
      try {
        await entered.promise;
        const logout = await fetch(h.base + '/zhuma-id/logout', {
          method: 'POST',
          headers: { cookie: h.cookie, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(logout.status, 200);
      } finally {
        release.resolve();
      }
      outcome = checked(await starting);
    } else outcome = checked(await h.rpc('run', 'begin', retry));
    if (variant === 'bound' || variant === 'unadmitted') {
      assert.equal(outcome.dispatch, 'received');
      await waitFor(h.ctx, () => h.run().attempt.acknowledged);
      assert.equal(h.run().dispatch, 'received');
      assert.equal(h.adapter.requests.length, 1);
      const bindings = [
        ...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries(),
      ];
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0][1].schemaVersion, variant === 'bound' ? 2 : 1);
      if (variant === 'unadmitted') {
        assert(h.nativeReads.migrationOriginMissing > 0);
        assert(h.nativeReads.retirementMissing > 0, 'same owner observed physical absence');
        assert.equal(bindings[0][1].scope.runId, 'run-2');
      }
    } else {
      assert.equal(outcome.dispatch, 'unknown');
      await waitFor(h.ctx, () => h.run()?.resources === 'settled');
      assert.equal(h.adapter.requests.length, 0);
      assert.equal(
        [...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries()]
          .length,
        0,
      );
      if (variant === 'unknown') assert(h.nativeReads.migrationOriginMissing > 0);
    }
    assert.deepEqual(h.row().nativeExecution.runs[0], expected.row.nativeExecution.runs[0]);
    assert.equal(h.row().nativeExecution.runs.length, 2);
    const requests = h.adapter.requests.length,
      originReads = h.nativeReads.migrationOrigin;
    const repeated = await h.rpc('run', 'begin', retry);
    if (variant === 'revoked') assert.equal(repeated.result.ok, false);
    else checked(repeated);
    assert.equal(h.adapter.requests.length, requests);
    assert.equal(h.nativeReads.migrationOrigin, originReads);
    await writeFile(
      join(root, 'read-report.json'),
      JSON.stringify({
        pid: process.pid,
        variant,
        distinctProcess: true,
        freshMemberCookie: true,
        oldRunUnchanged: true,
        ordinaryReadAndReplayDidNotDispatch: true,
        dispatch: outcome.dispatch,
        acknowledged: h.run().attempt.acknowledged,
        bindingCount: [
          ...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries(),
        ].length,
        modelRequests: requests,
        scriptedModelOnly: true,
        noAutomaticSecondDispatch: true,
      }),
    );
  },
);
