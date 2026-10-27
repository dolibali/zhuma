/** Workspace authorization contracts with real Cordis, SDK workspace registry,
 * local filesystem, file tools and private JSON storage in an owned temp dir.
 * Member/controller and Run facts are explicit doubles, not real login/Host proof.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context, symbols } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import FsSandbox from '@deepseek-ai/dsh-fs-sandbox';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import { createHostRunWorkspaces, hostLocalExecutionSchema } from '../dist/host-run-workspaces.js';
import {
  executionRunCompositionRequest,
  freezeExecutionRunComposition,
} from '../dist/execution-run-composition.js';
import { createHostRunConfiguration } from '../dist/host-run-configuration.js';
import { createHostRunOptions } from '../dist/host-run-options.js';
import { begin } from './execution-run-fixture.mjs';
import { describeNativeOutputFileTool } from '../dist/native-work-session-output-file-tool.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import {
  NativeRunLocalToolProducer,
  NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
} from '../dist/native-run-local-tools.js';

async function setup(
  t,
  { publish = [], access = 'write', mode = 'workspace-write', sandboxed = false } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-workspace-contract-'));
  const root = join(home, 'project');
  await mkdir(root);
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  });
  for (const [plugin, config] of [
    [Storage],
    [JsonStorage, { root: join(home, 'storage') }],
    [StorageDomain, { backend: 'json' }],
    [SystemPrompt],
    [Tools],
    [SessionStore],
    [SessionProjections],
    [SandboxPolicy, { mode, workspaceRoot: root }],
    [sandboxed ? FsSandbox : FsLocal, { cwd: root }],
    [WorkingDirectory, { defaultDirectory: root }],
    [ToolFs, { readImage: false }],
  ])
    await ctx.plugin(plugin, config);
  // The registry needs only an empty persisted header catalog here.
  ctx.provide('sessionPersistence', {
    list: async () => [],
    open() {
      throw Error('unexpected body read');
    },
    stat() {
      throw Error('unexpected stat');
    },
  });
  const registryFiber = await ctx.plugin(WorkspaceRegistry);
  const workspace = await ctx.workspaceRegistry.create(root, 'Contract project');
  const facts = compositionFacts();
  const config = hostLocalExecutionSchema.parse({
    deviceId: 'contract-device',
    bindings: [
      {
        id: 'project-files',
        generation: 1,
        actorId: facts.scope.actorId,
        spaceId: facts.scope.spaceId,
        projectId: facts.workbench.appliedPlans[0].task.projectId,
        workspaceId: workspace.id,
        access,
        publish,
      },
    ],
  });
  const lifetime = new AbortController();
  let currentRecord, currentSnapshot;
  const execution = {
    readRunNode() {
      return currentRecord;
    },
    readRunComposition() {
      if (currentSnapshot) return currentSnapshot;
      throw Error('unexpected composition read');
    },
  };
  const options = {
    config,
    execution,
    signal: lifetime.signal,
    readWorkbench: () => facts.workbench,
  };
  const globalRead = ctx.tools.get('read');
  const source = createHostRunWorkspaces(ctx, options);
  await source.ready;
  const args = [facts.scope.actorId, facts.scope.spaceId, config.bindings[0].projectId];
  const selected = source.select(...args, 'project-files');
  assert.equal(ctx.tools.get('read'), globalRead);
  const declared = selected.tools.describe(['read'])[0];
  assert.notDeepEqual(
    {
      description: declared.description,
      parameters: declared.parameters,
      outputSchema: declared.outputSchema,
    },
    {
      description: globalRead.description,
      parameters: globalRead.parameters,
      outputSchema: globalRead.output.schema,
    },
  );
  const snapshot = freezeExecutionRunComposition({
    ...facts,
    tools: {
      kind: 'local-tools',
      definitions: selected.tools.describe(
        selected.workspace.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
      ),
    },
    ...(publish.length ? { outputFilePublisherTool: describeNativeOutputFileTool() } : {}),
  });
  source.remember(snapshot, selected.workspace);
  const check = (needed = access) =>
    source.assertWorkspace(args[0], args[1], selected.workspace, needed, snapshot.configurationId);
  return {
    ctx,
    root,
    config,
    options,
    source,
    facts,
    snapshot,
    selected,
    args,
    check,
    lifetime,
    registryFiber,
    execution,
    setRun(record, snapshot) {
      currentRecord = record;
      currentSnapshot = snapshot;
    },
  };
}

test('workspace contract: metadata lists only exact subject/project IDs and no disk paths or granted descriptor', async (t) => {
  const h = await setup(t);
  const choices = h.source.choices(...h.args);
  assert.deepEqual(choices, [
    { id: 'project-files', label: 'Contract project', access: 'write', publish: false },
  ]);
  assert.equal(JSON.stringify(choices).includes(h.root), false);
  assert.equal('rootId' in choices[0], false);
  assert.equal('grantId' in choices[0], false);
  for (let i = 0; i < h.args.length; i++) {
    const foreign = [...h.args];
    foreign[i] = 'foreign';
    assert.deepEqual(h.source.choices(...foreign), []);
    assert.throws(() => h.source.select(...foreign, 'project-files'), {
      code: 'run-authority-denied',
    });
  }
  assert.equal(h.check(), undefined);
  assert.equal(h.source.assertComposition(h.snapshot), undefined);
});

test('workspace contract: read-only authority rejects write and forged device/root/grant/generation', async (t) => {
  const h = await setup(t, { access: 'read' });
  assert.equal(h.check('read'), undefined);
  assert.throws(() => h.check('write'), { code: 'run-authority-denied' });
  for (const change of [
    { deviceId: 'other' },
    { rootId: 'other' },
    { grantId: 'other' },
    { generation: 2 },
    { access: 'write' },
  ])
    assert.throws(
      () =>
        h.source.assertWorkspace(
          h.args[0],
          h.args[1],
          { ...h.selected.workspace, ...change },
          'read',
          h.snapshot.configurationId,
        ),
      { code: 'run-authority-denied' },
    );
  assert.throws(
    () =>
      h.source.assertWorkspace(
        'foreign',
        h.args[1],
        h.selected.workspace,
        'read',
        h.snapshot.configurationId,
      ),
    { code: 'run-authority-denied' },
  );
});

test('workspace contract: empty Host configuration grants no workspace even when the SDK catalog has it', async (t) => {
  const h = await setup(t);
  const source = createHostRunWorkspaces(h.ctx, { ...h.options, config: undefined });
  assert.deepEqual(source.choices(...h.args), []);
  assert.throws(() => source.select(...h.args, 'project-files'), { code: 'run-authority-denied' });
  assert.equal(
    source.assertWorkspace(h.args[0], h.args[1], { kind: 'text-only' }, 'read', 'text-contract'),
    undefined,
  );
});

test('workspace contract: publication ranges are independent and part of the frozen grant identity', async (t) => {
  const h = await setup(t);
  const nextConfig = structuredClone(h.config);
  nextConfig.bindings[0].publish = [{ kind: 'directory', path: 'deliverables' }];
  const next = createHostRunWorkspaces(h.ctx, { ...h.options, config: nextConfig });
  await next.ready;
  const selected = next.select(...h.args, 'project-files');
  assert.notEqual(selected.workspace.grantId, h.selected.workspace.grantId);
  assert.equal(next.choices(...h.args)[0].publish, true);
  next.remember(h.snapshot, h.selected.workspace);
  assert.throws(
    () =>
      next.assertWorkspace(
        h.args[0],
        h.args[1],
        h.selected.workspace,
        'read',
        h.snapshot.configurationId,
      ),
    { code: 'run-authority-denied' },
  );
  for (const path of [
    '/absolute',
    '../outside',
    'dir/../outside',
    'dir\\outside',
    'https://example.org/file',
  ])
    assert.equal(
      hostLocalExecutionSchema.safeParse({
        ...h.config,
        bindings: [{ ...h.config.bindings[0], publish: [{ kind: 'file', path }] }],
      }).success,
      false,
    );
});

test('workspace contract: revoking a separate binding cannot shadow a still-valid workspace grant', async (t) => {
  const h = await setup(t);
  const config = structuredClone(h.config);
  config.bindings.unshift({ ...config.bindings[0], id: 'separate-binding' });
  const source = createHostRunWorkspaces(h.ctx, { ...h.options, config });
  await source.ready;
  const revoked = source.select(...h.args, 'separate-binding');
  const valid = source.select(...h.args, 'project-files');
  source.remember(h.snapshot, valid.workspace);
  config.bindings[0].generation++;
  assert.equal(
    source.assertWorkspace(
      h.args[0],
      h.args[1],
      valid.workspace,
      'write',
      h.snapshot.configurationId,
    ),
    undefined,
  );
  assert.equal(revoked.signal.aborted, true);
  assert.equal(valid.signal.aborted, false);
});

test('workspace contract: revocation, Host unload and registry replacement invalidate existing grants', async (t) => {
  const h = await setup(t);
  h.config.bindings[0].access = 'read';
  assert.throws(() => h.check(), { code: 'run-authority-denied' });
  h.config.bindings[0].access = 'write';
  assert.throws(() => h.check(), { code: 'run-authority-denied' });
  const fresh = createHostRunWorkspaces(h.ctx, h.options);
  await fresh.ready;
  const freshScopeSignal = fresh.select(...h.args, 'project-files').signal;
  fresh.remember(h.snapshot, h.selected.workspace);
  assert.equal(
    fresh.assertWorkspace(
      h.args[0],
      h.args[1],
      h.selected.workspace,
      'write',
      h.snapshot.configurationId,
    ),
    undefined,
  );
  await h.registryFiber.dispose();
  assert.equal(freshScopeSignal.aborted, true);
  assert.throws(() => h.check(), { code: 'run-authority-denied' });
  await h.ctx.plugin(WorkspaceRegistry);
  assert.throws(
    () =>
      fresh.assertWorkspace(
        h.args[0],
        h.args[1],
        h.selected.workspace,
        'read',
        h.snapshot.configurationId,
      ),
    { code: 'run-authority-denied' },
  );
  h.lifetime.abort();
  assert.throws(() => h.source.choices(...h.args), { code: 'run-authority-denied' });
});

test('workspace contract: explicit owner close disposes private SDK tool/prompt registrations before reopening in the same context', async (t) => {
  const h = await setup(t);
  const modules = [Tools, SystemPrompt, ToolFs, FsLocal];
  const counts = () =>
    modules.map((plugin) => [...(h.ctx.registry.get(plugin)?.fibers ?? [])].length);
  const opened = counts();
  assert.ok(opened.every((value) => value >= 2));
  const baseline = opened.map((value) => value - 1);
  const globalRead = h.ctx.tools.get('read');
  const closing = h.source.close();
  assert.equal(h.source.close(), closing);
  assert.equal(h.selected.signal.aborted, true);
  await closing;
  assert.deepEqual(counts(), baseline);
  assert.throws(() => h.selected.tools.describe(['read']));
  for (let index = 0; index < 3; index++) {
    const source = createHostRunWorkspaces(h.ctx, h.options);
    await source.ready;
    assert.deepEqual(counts(), opened);
    assert.equal(source.choices(...h.args).length, 1);
    await source.close();
    assert.deepEqual(counts(), baseline);
    assert.equal(h.ctx.tools.get('read'), globalRead);
  }
});

test('policy contract: the real sandbox backend is rejected by the original producer; private metadata never changes the global backend', async (t) => {
  const h = await setup(t, { sandboxed: true });
  assert.equal(h.ctx.fs.sandboxMode, 'workspace-write');
  assert.throws(
    () =>
      new NativeRunLocalToolProducer(h.ctx, {
        sourceVersion: NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
        signal: new AbortController().signal,
        assertCurrent() {
          return undefined;
        },
      }),
    { code: 'local-tools-unavailable' },
  );
  assert.notEqual(h.selected.tools.filesystem, h.ctx.fs);
  assert.equal(h.selected.tools.filesystem.sandboxMode, undefined);
  assert.equal(h.ctx.fs.sandboxMode, 'workspace-write');
});

test('policy contract: an operator write binding starts read-only under the real SDK deployment default', async (t) => {
  const h = await setup(t, { sandboxed: true, mode: 'read-only' });
  assert.equal(h.ctx.sandboxPolicy.resolve().mode, 'read-only');
  assert.equal(h.selected.workspace.access, 'read');
  assert.equal(h.source.choices(...h.args)[0].access, 'read');
  assert.deepEqual(
    h.snapshot.payload.tools.definitions.map((tool) => tool.name),
    ['read'],
  );
  assert.equal(h.source.assertComposition(h.snapshot), undefined);
  assert.equal(h.check('read'), undefined);
  assert.throws(() => h.check('write'), { code: 'run-authority-denied' });
});

test('policy contract: a frozen read grant remains recognizable when the current upper bound allows write, without upgrading the frozen tools', async (t) => {
  const h = await setup(t, { sandboxed: true });
  const workspace = { ...h.selected.workspace, access: 'read' };
  const snapshot = freezeExecutionRunComposition({
    ...h.facts,
    tools: { kind: 'local-tools', definitions: h.selected.tools.describe(['read']) },
  });
  h.source.remember(snapshot, workspace);
  assert.equal(
    h.source.assertWorkspace(h.args[0], h.args[1], workspace, 'read', snapshot.configurationId),
    undefined,
  );
  assert.equal(h.source.assertComposition(snapshot), undefined);
  assert.throws(
    () =>
      h.source.assertWorkspace(h.args[0], h.args[1], workspace, 'write', snapshot.configurationId),
    { code: 'run-authority-denied' },
  );
});

test('policy contract: options and an idempotent begin retain a saved read workspace under a wider current upper bound', async (t) => {
  const h = await setup(t, { sandboxed: true });
  const workspace = { ...h.selected.workspace, access: 'read' };
  const snapshot = freezeExecutionRunComposition({
    ...h.facts,
    tools: { kind: 'local-tools', definitions: h.selected.tools.describe(['read']) },
  });
  const { firstMessage: _message, ...projection } = executionRunCompositionRequest(snapshot);
  const begun = begin(h.facts.node, { ...projection, requestId: 'first', workspace });
  h.setRun(begun.record, snapshot);
  h.execution.readRunCompositionInputs = async () => ({ ok: true, value: h.facts.inputs });
  h.ctx.provide('llm', {
    listProviders: () => [{ id: 'contract' }],
    listModels: async () => [{ provider: 'contract', id: h.facts.model.model }],
  });
  const ports = {
    execution: h.execution,
    readWorkbench: () => h.facts.workbench,
    signal: h.lifetime.signal,
    workspaces: h.source,
  };
  const { actorId: _actor, runId, generation: _generation, segmentId, ...target } = h.facts.scope;
  const request = { headers: {} };
  const options = await createHostRunOptions(h.ctx, ports)(request, target);
  assert.deepEqual(options.value.selection.workspace, { kind: 'local', id: 'project-files' });
  assert.equal(options.value.workspaces[0].access, 'write');
  const prepared = await createHostRunConfiguration(h.ctx, ports).prepare(request, {
    ...target,
    requestId: 'first',
    expectedNodeVersion: h.facts.node.command.version,
    expectedRunVersion: 0,
    mode: 'begin',
    newRunId: runId,
    newSegmentId: segmentId,
    model: h.facts.model,
    executor: h.facts.executor,
    tools: 'local-tools',
    workspace: { kind: 'local', id: 'project-files' },
  });
  assert.deepEqual(prepared.workspace, workspace);
  assert.deepEqual(prepared.composition, snapshot);
  assert.equal(h.source.assertComposition(prepared.composition), undefined);
  assert.throws(
    () =>
      h.source.assertWorkspace(h.args[0], h.args[1], workspace, 'write', snapshot.configurationId),
    { code: 'run-authority-denied' },
  );
});

test('policy contract: unloading or replacing the real SDK policy invalidates prior capabilities', async (t) => {
  const h = await setup(t, { sandboxed: true });
  await [...h.ctx.registry.get(SandboxPolicy).fibers][0].dispose();
  assert.equal(h.selected.signal.aborted, true);
  assert.throws(() => h.check('read'), { code: 'run-authority-denied' });
  await h.ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: h.root });
  assert.throws(() => h.check('read'), { code: 'run-authority-denied' });
});

test('policy contract: replacing the real policy method cannot mint a wider grant or revive a prior capability', async (t) => {
  const h = await setup(t, { sandboxed: true });
  const policy = Reflect.get(h.ctx.sandboxPolicy, symbols.original) ?? h.ctx.sandboxPolicy;
  const resolve = policy.resolve;
  try {
    policy.resolve = () => ({ mode: 'danger-full-access', workspaceRoot: h.root });
    assert.throws(() => h.check('read'), { code: 'run-authority-denied' });
    assert.equal(h.selected.signal.aborted, true);
  } finally {
    policy.resolve = resolve;
  }
  assert.throws(() => h.check('read'), { code: 'run-authority-denied' });
});
