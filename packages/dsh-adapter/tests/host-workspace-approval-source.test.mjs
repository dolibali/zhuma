/** Actual SDK Registry/Sandbox, directories, original D queue/domain and JSON.
 * SDK owner transport and member identity are explicit contracts here; this
 * does not prove normal member GUI or native file execution authorization. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import Registry from '@deepseek-ai/dsh-workspace';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Sandbox from '@deepseek-ai/dsh-sandbox-policy';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import { open } from './execution-service-run-fixture.mjs';
import { createHostWorkspaceApprovalSource } from '../dist/host-workspace-approval-source.js';
import { openHostWorkspaceApprovals } from '../dist/host-workspace-approvals.js';
import { createHostRunWorkspaces } from '../dist/host-run-workspaces.js';

async function setup(t, { mode = 'workspace-write', direct = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-host-workspace-source-'));
  const dir = join(root, 'project');
  await mkdir(dir);
  const sdk = new Context();
  const closes = [() => sdk.fiber.dispose()];
  t.after(async () => {
    for (const close of closes.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  for (const [plugin, config] of [
    [Storage],
    [JsonStorage, { root: join(root, 'sdk') }],
    [Domain, { backend: 'json' }],
    [Sessions],
    [Projections],
    [Persistence, { root: join(root, 'sessions'), compression: 'none' }],
    [Registry],
    [Sandbox, { workspaceRoot: dir, mode }],
  ])
    await sdk.plugin(plugin, config);
  const registered = await sdk.workspaceRegistry.create(dir, 'Isolated project');
  const d = await open(join(root, 'business'), { seed: false });
  closes.push(() => d.close());
  const request = Object.freeze({ headers: { cookie: 'EXPLICIT_OWNER_TRANSPORT_CONTRACT' } });
  d.members.set(request, 'chen');
  const control = { owner: true };
  const connection = {
    requestRejection: () => undefined,
    admit: () => ({
      peer: { principal: { kind: control.owner ? 'owner' : 'contract-non-owner' } },
    }),
  };
  const ctx = { get: (name) => (name === 'connection' ? connection : sdk.get(name)) };
  const lifetime = new AbortController();
  const source = direct
    ? createHostWorkspaceApprovalSource(ctx, { signal: lifetime.signal })
    : undefined;
  const api = direct
    ? undefined
    : openHostWorkspaceApprovals(ctx, { execution: d.service, signal: lifetime.signal });
  const owner = direct ? d.service.openWorkspaceApprovalOwner(source.source) : api.owner;
  closes.push(() => {
    lifetime.abort();
  });
  closes.push(() => source?.close());
  closes.push(() => api?.close());
  const command = (patch = {}) => ({
    requestId: randomUUID(),
    spaceId: 'north',
    projectId: 'project',
    workspaceId: registered.id,
    expectedGeneration: 0,
    access: 'write',
    publish: [],
    ...patch,
  });
  return {
    root,
    dir,
    sdk,
    registered,
    d,
    control,
    ctx,
    lifetime,
    source,
    api,
    owner,
    command,
    request,
  };
}
const bytesIfPresent = (path) =>
  readFile(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
const checked = (result) => {
  assert.equal(result.ok, true, result.ok ? '' : result.error.code);
  return result.value;
};

test('Host workspace source: original dynamic approval feeds actual tool choices, revocation aborts IO and never restores the static binding', async (t) => {
  const h = await setup(t);
  for (const [plugin, config] of [
    [SystemPrompt],
    [Tools],
    [FsLocal, { cwd: h.dir }],
    [WorkingDirectory, { defaultDirectory: h.dir }],
  ])
    await h.sdk.plugin(plugin, config);
  const staticConfig = {
    deviceId: 'contract-legacy-device',
    bindings: [
      {
        id: 'legacy-binding',
        generation: 1,
        actorId: 'chen',
        spaceId: 'north',
        projectId: 'project',
        workspaceId: h.registered.id,
        access: 'write',
        publish: [],
      },
    ],
  };
  const source = createHostRunWorkspaces(h.sdk, {
    config: staticConfig,
    approvals: h.owner,
    execution: h.d.service,
    signal: h.lifetime.signal,
    readWorkbench: h.d.readWorkbench,
  });
  t.after(() => source.close());
  await source.ready;
  const args = ['chen', 'north', 'project'];
  const legacy = source.select(...args, 'legacy-binding');
  assert.equal(legacy.signal.aborted, false);
  const first = checked(
    await h.api.operations.approve(
      h.request,
      h.command({
        publish: [{ kind: 'directory', path: 'deliverables' }],
      }),
    ),
  );
  assert.equal(legacy.signal.aborted, true, 'a dynamic row shadows the static source');
  const choices = source.choices(...args);
  assert.deepEqual(
    choices.map((row) => row.id),
    [first.current.id],
  );
  assert.equal(choices[0].publish, true);
  const selected = source.select(...args, first.current.id);
  assert.notEqual(selected.workspace.deviceId, staticConfig.deviceId);
  assert.equal(selected.workspace.generation, 1);
  assert.deepEqual(
    selected.tools.describe(['read', 'write', 'edit']).map((tool) => tool.name),
    ['read', 'write', 'edit'],
  );
  assert.throws(() => source.select('another-member', ...args.slice(1), first.current.id));
  const revoked = checked(
    await h.api.operations.revoke(h.request, {
      requestId: randomUUID(),
      spaceId: 'north',
      projectId: 'project',
      approvalId: first.current.id,
      expectedGeneration: 1,
    }),
  );
  assert.equal(revoked.current.status, 'revoked');
  assert.equal(selected.signal.aborted, true);
  assert.deepEqual(source.choices(...args), []);
  assert.throws(() => source.select(...args, 'legacy-binding'));
  assert.throws(() => source.select(...args, first.current.id));
  checked(
    await h.api.operations.approve(h.request, h.command({ expectedGeneration: 2, access: 'read' })),
  );
  const renewed = source.select(...args, first.current.id);
  assert.equal(renewed.workspace.generation, 3);
  assert.equal(renewed.workspace.access, 'read');
  assert.equal(renewed.signal.aborted, false);
  assert.notEqual(renewed.workspace.grantId, selected.workspace.grantId);
  assert.equal(selected.signal.aborted, true);
});

test('Host workspace source: listing an actual registered directory is passive; explicit original D approval persists no path and exact retry does not rewrite', async (t) => {
  const h = await setup(t);
  const before = await bytesIfPresent(join(h.root, 'business/zhuma_execution.json'));
  const view = checked(
    await h.api.operations.options(h.request, { spaceId: 'north', projectId: 'project' }),
  );
  assert.equal(view.available, true);
  assert.equal(view.directories[0].id, h.registered.id);
  assert.equal(view.directories[0].path, h.registered.path);
  assert.deepEqual(view.approvals, []);
  assert.deepEqual(await bytesIfPresent(join(h.root, 'business/zhuma_execution.json')), before);
  const command = h.command({ publish: [{ kind: 'directory', path: 'deliverables' }] });
  const first = checked(await h.api.operations.approve(h.request, command));
  assert.equal(first.current.generation, 1);
  const stored = h.owner.snapshot().state.approvals[0];
  assert.equal(stored.actorId, 'chen');
  assert.equal(stored.identity.createdAt, h.registered.createdAt);
  assert.equal(stored.identity.pathFingerprint.length, 64);
  const bytes = await readFile(join(h.root, 'business/zhuma_execution.json'));
  assert.equal(bytes.includes(Buffer.from(h.dir)), false);
  assert.equal(checked(await h.api.operations.approve(h.request, command)).disposition, 'replayed');
  assert.deepEqual(await readFile(join(h.root, 'business/zhuma_execution.json')), bytes);
  const publicView = checked(
    await h.api.operations.options(h.request, { spaceId: 'north', projectId: 'project' }),
  );
  assert.equal(JSON.stringify(publicView).includes('pathFingerprint'), false);
  assert.equal(JSON.stringify(publicView).includes('actorId'), false);
  assert.equal(JSON.stringify(publicView).includes('runs'), false);
});

test('Host workspace source: a registration, copied original request or client confirmed/path/actor flags never substitute for the explicit owner action', async (t) => {
  const h = await setup(t, { direct: true });
  const command = h.command();
  assert.equal(
    (await h.owner.approve(h.request, command)).ok,
    false,
    'no private owner-action permit',
  );
  const raw = { operation: 'approve', ...command };
  const input = {
    actorId: 'chen',
    command: raw,
    existing: undefined,
    snapshot: undefined,
    runs: [],
    commandFingerprint: 'a'.repeat(64),
  };
  await h.source.confirmed(h.request, raw, async () => {
    await assert.rejects(h.source.source.prepare({ ...h.request }, input, h.lifetime.signal));
    const qualified = await h.source.source.prepare(h.request, input, h.lifetime.signal);
    qualified.assertCurrent();
    qualified.release();
    assert.throws(() => qualified.assertCurrent());
  });
  h.control.owner = false;
  assert.throws(() => h.source.confirmed(h.request, raw, async () => {}), {
    code: 'workspace-owner-required',
  });
  assert.equal(h.owner.snapshot().state, undefined);
});

test('Host workspace source: SDK read-only mode cannot be elevated; publish remains an independent explicit range', async (t) => {
  const h = await setup(t, { mode: 'read-only' });
  const view = checked(
    await h.api.operations.options(h.request, { spaceId: 'north', projectId: 'project' }),
  );
  assert.equal(view.directories[0].access, 'read');
  assert.equal((await h.api.operations.approve(h.request, h.command())).ok, false);
  const granted = checked(
    await h.api.operations.approve(h.request, h.command({ access: 'read', publish: [] })),
  );
  assert.equal(granted.current.access, 'read');
  assert.deepEqual(granted.current.publish, []);
  assert.equal(
    (await h.api.operations.approve(h.request, h.command({ actorId: 'outside' }))).ok,
    false,
  );
  assert.equal((await h.api.operations.approve(h.request, h.command({ path: h.dir }))).ok, false);
  assert.equal(
    (await h.api.operations.approve(h.request, h.command({ confirmed: true }))).ok,
    false,
  );
  assert.equal(
    (await h.api.operations.approve(h.request, h.command({ operation: 'revoke' }))).ok,
    false,
  );
});

test('Host workspace source: an actual missing directory is unavailable but can still be explicitly revoked; old replay stays a tombstone', async (t) => {
  const h = await setup(t),
    command = h.command();
  const first = checked(await h.api.operations.approve(h.request, command));
  await rename(h.dir, h.dir + '-moved');
  const view = checked(
    await h.api.operations.options(h.request, { spaceId: 'north', projectId: 'project' }),
  );
  assert.deepEqual(view.directories, []);
  const revoked = checked(
    await h.api.operations.revoke(h.request, {
      requestId: randomUUID(),
      spaceId: 'north',
      projectId: 'project',
      approvalId: first.current.id,
      expectedGeneration: 1,
    }),
  );
  assert.equal(revoked.current.status, 'revoked');
  assert.equal(
    checked(await h.api.operations.approve(h.request, command)).current.status,
    'revoked',
  );
});

test('Host workspace source: canonical nested roots conflict, a sibling does not, and a retargeted symlink invalidates the qualification', async (t) => {
  const h = await setup(t, { direct: true });
  const child = join(h.dir, 'nested'),
    sibling = h.dir + '-sibling';
  await mkdir(child);
  await mkdir(sibling);
  const nested = await h.sdk.workspaceRegistry.create(child, 'Nested'),
    separate = await h.sdk.workspaceRegistry.create(sibling, 'Sibling');
  const scope = (id) => ({
    actorId: 'chen',
    spaceId: 'north',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: id,
    runId: id,
    generation: 1,
    segmentId: id,
  });
  const run = (id, rootId) => ({
    scope: scope(id),
    workspace: {
      kind: 'local',
      deviceId: 'isolated-device',
      rootId,
      grantId: id,
      generation: 1,
      access: 'read',
    },
    resources: 'held',
  });
  const command = { operation: 'approve', ...h.command() };
  await h.source.confirmed(h.request, command, async () => {
    const input = {
      actorId: 'chen',
      command,
      existing: undefined,
      snapshot: undefined,
      runs: [run('nested', nested.id), run('sibling', separate.id)],
      commandFingerprint: 'a'.repeat(64),
    };
    const qualified = await h.source.source.prepare(h.request, input, h.lifetime.signal);
    assert.deepEqual(qualified.conflictingRunScopes, [scope('nested')]);
    qualified.assertCurrent();
    await rename(h.dir, h.dir + '-moved');
    await symlink(sibling, h.dir);
    assert.throws(() => qualified.assertCurrent());
    qualified.release();
  });
});
