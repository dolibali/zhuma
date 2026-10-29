/** Original SDK Registry/Session/FS/ToolFs; accepted Run and Agent caller are
 * explicit contracts. No login, native Agent factory, model or desktop proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import { createScope } from '@deepseek-ai/dsh-scope';
import {
  createHostMemberNativeWorkspaces,
  memberNativeWorkspaceSchema,
} from '../dist/host-member-native-workspaces.js';
import { nativeWorkspaceAttachment } from '../dist/native-work-session-workspace.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { describeNativeOutputFileTool } from '../dist/native-work-session-output-file-tool.js';
import { describeNativeResultPublicationsTool } from '../dist/native-work-session-result-publications-tool.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';

async function setup(t, { readOnly = false, publish = [] } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-member-workspace-')));
  const root = join(home, 'work'),
    outside = join(home, 'private');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, 'report.txt'), 'real file result');
  await writeFile(join(outside, 'secret.txt'), 'PRIVATE_OUTSIDE_BODY');
  const ctx = new Context(),
    abort = new AbortController(),
    scopes = [];
  let helper;
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.dispose();
    await helper?.close();
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  });
  for (const [plugin, config] of [
    [Storage],
    [JsonStorage, { root: join(home, 'data') }],
    [StorageDomain, { backend: 'json' }],
    [SystemPrompt],
    [Tools, { mode: 'native' }],
    [SessionStore],
    [SessionProjections],
    [SandboxPolicy, { mode: readOnly ? 'read-only' : 'workspace-write', workspaceRoot: root }],
    [FsLocal, { cwd: root }],
    [WorkingDirectory, { defaultDirectory: root }],
  ])
    await ctx.plugin(plugin, config);
  ctx.provide('sessionPersistence', {
    list: async () => [],
    open() {
      assert.fail('unexpected history read');
    },
    stat() {
      assert.fail('unexpected history stat');
    },
  });
  await ctx.plugin(WorkspaceRegistry);
  const workspace = await ctx.workspaceRegistry.create(root, 'Actual registered workspace');
  const owner = {
    connectionId: 'connection',
    backendId: 'backend',
    deviceId: 'device',
    actorId: 'chen',
    signal: abort.signal,
  };
  helper = createHostMemberNativeWorkspaces(ctx, owner);
  await helper.ready;
  const choice = helper.choices().find((item) => item.access === (readOnly ? 'read' : 'write'));
  assert(choice);
  const facts = compositionFacts();
  const target = {
    spaceId: facts.scope.spaceId,
    taskId: facts.scope.taskId,
    planId: facts.scope.planId,
    revision: facts.scope.revision,
    nodeId: facts.scope.nodeId,
  };
  const input = { kind: 'local', id: choice.id, publish };
  const selected = helper.prepare('accept-request', target, input);
  const composition = freezeExecutionRunComposition({
    ...facts,
    tools: { kind: 'local-tools', definitions: helper.describe(selected) },
    resultIntentTool: describeNativeResultPublicationsTool(),
    outputFilePublisherTool: describeNativeOutputFileTool(),
  });
  const selection = executionRunCompositionRequest(composition).selection;
  const accepted = {
    value: { scope: { ...facts.scope, backendId: owner.backendId }, deviceId: owner.deviceId },
    composition,
  };
  helper.bind('accept-request', accepted);
  const session = ctx.sessions.create(SessionId('member-file-session'), { meta: { cwd: root } });
  const agent = { id: 'member-file-agent', session };
  const scope = createScope(ctx, agent);
  scopes.push(scope);
  await scope.ctx.fiber;
  agent.ctx = scope.ctx;
  const binding = {
    schemaVersion: 1,
    scope: facts.scope,
    nativeSessionId: session.id,
    nativeAgentId: agent.id,
    selection,
    receipts: [],
  };
  const grant = {
    scope: facts.scope,
    signal: abort.signal,
    assertCurrent(action) {
      assert.equal(action, 'send');
      abort.signal.throwIfAborted();
    },
  };
  let calls = 0;
  return {
    ctx,
    root,
    outside,
    workspace,
    helper,
    owner,
    facts,
    target,
    choice,
    selected,
    input,
    composition,
    accepted,
    agent,
    scope,
    binding,
    grant,
    abort,
    async compose() {
      return helper.native.compose(scope.ctx, binding, grant);
    },
    call(name, args) {
      return ctx.tools.execute({
        callId: `file-${++calls}`,
        name,
        arguments: args,
        signal: new AbortController().signal,
        agent,
      });
    },
  };
}

test('member Workspace contract: opaque explicit selectors bind once per request and never disclose local paths', async (t) => {
  const h = await setup(t);
  const choices = h.helper.choices();
  assert.equal(choices.length, 2);
  assert.equal(JSON.stringify(choices).includes(h.root), false);
  assert.equal(JSON.stringify(h.selected.workspace).includes(h.root), false);
  const defaults = h.helper.workflowWorkspace(h.input);
  assert.equal(defaults.workspace.rootId, h.selected.workspace.rootId);
  assert.equal(
    Object.hasOwn(defaults.workspace, 'grantId'),
    false,
    'A workflow ceiling has no per-node IO grant',
  );
  assert.equal(Object.hasOwn(defaults.workspace, 'generation'), false);
  const choice = h.helper.workflowSelection(defaults.workspace);
  assert.deepEqual(choice, { kind: 'local', id: h.choice.id });
  const next = h.helper.prepare('next-node-request', { ...h.target, nodeId: 'next-node' }, choice);
  assert.notEqual(
    next.workspace.grantId,
    h.selected.workspace.grantId,
    'Every actual node obtains its own original grant',
  );
  assert.throws(() =>
    h.helper.workflowSelection({ ...defaults.workspace, rootId: 'foreign-root' }),
  );
  assert.equal(h.helper.prepare('accept-request', h.target, h.input), h.selected);
  assert.throws(
    () =>
      h.helper.prepare('accept-request', h.target, {
        ...h.input,
        publish: [{ kind: 'file', path: 'other.txt' }],
      }),
    { code: 'run-authority-denied' },
  );
  assert.throws(() => h.helper.prepare('other', h.target, { ...h.input, id: h.workspace.id }), {
    code: 'run-authority-denied',
  });
  for (const path of [
    '../private',
    '/absolute',
    'x/../secret',
    'x\\secret',
    'https://invalid.test/file',
  ])
    assert.equal(
      memberNativeWorkspaceSchema.safeParse({ ...h.input, publish: [{ kind: 'file', path }] })
        .success,
      false,
    );
  assert.deepEqual(h.helper.selection(h.facts.scope), {
    kind: 'local',
    id: h.choice.id,
    publish: [],
  });
});

test('member Workspace contract: original same-Session attachment and real read/write tools deny root escape', async (t) => {
  const h = await setup(t);
  const directory = await h.helper.native.workingDirectory(h.binding, h.grant);
  assert.equal(directory.cwd, h.root);
  assert.equal(directory.workspaceId, h.workspace.id);
  await nativeWorkspaceAttachment(
    h.ctx,
    directory.workspaceId,
    directory.cwd,
    directory.assertCurrent,
  ).attach(h.binding.nativeSessionId);
  assert(h.workspace.sessionIds.includes(h.binding.nativeSessionId));
  assert.deepEqual((await h.compose()).toolAllowlist, ['read', 'write', 'edit']);
  const wrote = await h.call('write', { file_path: 'generated.txt', content: 'actual tool bytes' });
  assert.equal(wrote.isError, false, JSON.stringify(wrote));
  assert.equal(await readFile(join(h.root, 'generated.txt'), 'utf8'), 'actual tool bytes');
  const result = await h.call('read', { file_path: 'report.txt' });
  assert.equal(result.isError, false, JSON.stringify(result));
  await symlink(h.outside, join(h.root, 'escaped'));
  for (const file_path of ['../private/secret.txt', 'escaped/secret.txt']) {
    const denied = await h.call('read', { file_path });
    assert.equal(denied.isError, true);
    assert(!JSON.stringify(denied).includes('PRIVATE_OUTSIDE_BODY'));
  }
});

test('member Workspace contract: write access never grants publication; explicit ranges use original byte producer', async (t) => {
  const h = await setup(t);
  await h.compose();
  assert.throws(
    () =>
      h.helper
        .output(h.binding, h.grant)
        .authorize(h.grant, h.composition.configurationId, 'report.txt'),
    { code: 'publication-denied' },
  );
  const p = await setup(t, { publish: [{ kind: 'file', path: 'report.txt' }] });
  await p.compose();
  const source = p.helper.output(p.binding, p.grant);
  assert.throws(() => source.authorize(p.grant, p.composition.configurationId, 'other.txt'), {
    code: 'publication-denied',
  });
  const read = await source.inspect(
    p.grant,
    p.composition.configurationId,
    'report.txt',
    new AbortController().signal,
  );
  try {
    const result = await read.read();
    assert.equal(Buffer.from(result.bytes).toString(), 'real file result');
  } finally {
    read.close();
    await read.drain();
  }
});

test('member Workspace workflow ceiling: explicit ranges survive selection into each distinct original node grant without backfilling old grants', async (t) => {
  const h = await setup(t);
  const input = {
    kind: 'local',
    id: h.choice.id,
    publish: [{ kind: 'directory', path: 'outputs' }],
  };
  const frozen = h.helper.workflowWorkspace(input);
  input.publish[0].path = 'private';
  assert.deepEqual(frozen.workspace.publish, [{ kind: 'directory', path: 'outputs' }]);
  const selected = h.helper.workflowSelection(frozen.workspace);
  const first = h.helper.prepare('workflow-node-1', h.target, selected);
  const second = h.helper.prepare(
    'workflow-node-2',
    { ...h.target, nodeId: 'second-node' },
    selected,
  );
  assert.deepEqual(first.paths, [{ kind: 'directory', path: 'outputs' }]);
  assert.deepEqual(second.paths, first.paths);
  assert.notEqual(first.workspace.grantId, second.workspace.grantId);
  assert.deepEqual(
    h.selected.paths,
    [],
    'Existing Run IO manifest cannot gain later workflow permissions',
  );
  await h.compose();
  assert.throws(
    () =>
      h.helper
        .output(h.binding, h.grant)
        .authorize(h.grant, h.composition.configurationId, 'report.txt'),
    { code: 'publication-denied' },
  );
});

test('member Workspace contract: original read-only policy removes write; permission never survives cold reconstruction', async (t) => {
  const h = await setup(t, { readOnly: true });
  assert.deepEqual(
    h.helper.choices().map((item) => item.access),
    ['read'],
  );
  assert.deepEqual((await h.compose()).toolAllowlist, ['read']);
  assert.equal(
    (await h.call('write', { file_path: 'no-write.txt', content: 'denied' })).isError,
    true,
  );
  const cold = createHostMemberNativeWorkspaces(h.ctx, h.owner);
  await cold.ready;
  try {
    assert.throws(() => cold.bind('accept-request', h.accepted), { code: 'run-authority-denied' });
    await assert.rejects(cold.native.workingDirectory(h.binding, h.grant), {
      code: 'run-authority-denied',
    });
  } finally {
    await cold.close();
  }
});

test('member Workspace contract: owner fence and registered root replacement revoke existing IO/publication', async (t) => {
  const h = await setup(t, { publish: [{ kind: 'file', path: 'report.txt' }] });
  await h.compose();
  const source = h.helper.output(h.binding, h.grant);
  h.helper.fence();
  assert.equal((await h.call('read', { file_path: 'report.txt' })).isError, true);
  assert.throws(() => source.authorize(h.grant, h.composition.configurationId, 'report.txt'));
  const changed = await setup(t);
  await rename(changed.root, changed.root + '-old');
  await mkdir(changed.root);
  assert.throws(() => changed.helper.prepare('accept-request', changed.target, changed.input), {
    code: 'run-authority-denied',
  });
});
