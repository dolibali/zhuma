import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { AssetSchema, canonicalPayload } from '@zhuma/agent-core';
import { publicMemberEngineeringSkills } from '../../../scripts/lib/member-engineering-skills.mjs';
import { defaultMemberEngineeringSkills } from '../dist/member-engineering-skill-catalog.js';
import { canUpgradeBuiltinAsset } from '../dist/member-builtin-asset-upgrade.js';
import { apply as applyExecution, inject as executionInject } from '../dist/execution-plugin.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import {
  setup,
  request,
  signal,
  taskInput,
  projectCommand,
  rejected,
} from './member-workbench-fixture.mjs';

const legacy = JSON.parse(
  await readFile(new URL('./fixtures/member-builtin-skills-v14.json', import.meta.url), 'utf8'),
);
const current = defaultMemberEngineeringSkills((await publicMemberEngineeringSkills()).bundle);
const changed = legacy.assets.filter((old) => {
  const next = current.find((asset) => asset.id === old.id);
  return next && canonicalPayload(old) !== canonicalPayload(next);
});
const old = changed[0];
const latest = current.find((asset) => asset.id === old?.id);
const importedOrigin = {
  versionId: '00000000-0000-4000-8000-000000000002',
  format: 'agent-skill',
  entryPath: 'SKILL.md',
  filePaths: ['SKILL.md'],
  totalBytes: 30,
  missing: [],
  sourceVersion: 'private',
};

test('builtin upgrade: exact historical full definitions match only the verified current catalog', () => {
  assert.equal(legacy.sourceCommit, '133276e2014bf1bcbd8410bab7bb339c929de46d');
  assert.equal(legacy.assets.length, 10);
  assert(changed.length > 0, 'upgrade test must compare a genuinely changed catalog');
  for (const prior of legacy.assets) {
    const next = current.find((asset) => asset.id === prior.id);
    assert.ok(next);
    assert.equal(canUpgradeBuiltinAsset(prior, next), true, prior.id);
  }
  assert.equal(canUpgradeBuiltinAsset(latest, old), false, 'no downgrade allowlist');
});

test('builtin upgrade: matching ID/body or a claimed builtin cannot substitute a full old or new definition', () => {
  for (const [field, value] of [
    ['name', 'Private name'],
    ['description', 'Private metadata'],
    ['content', 'Private body'],
    ['available', false],
  ]) {
    assert.equal(canUpgradeBuiltinAsset({ ...old, [field]: value }, latest), false, `old ${field}`);
    assert.equal(canUpgradeBuiltinAsset(old, { ...latest, [field]: value }), false, `new ${field}`);
  }
  assert.equal(
    canUpgradeBuiltinAsset(
      { ...old, id: 'zhuma-eng-fake-builtin' },
      { ...latest, id: 'zhuma-eng-fake-builtin' },
    ),
    false,
  );
  assert.equal(canUpgradeBuiltinAsset({ ...old, origin: importedOrigin }, latest), false);
  assert.equal(canUpgradeBuiltinAsset(old, { ...latest, origin: importedOrigin }), false);
  assert.equal(
    canUpgradeBuiltinAsset(
      {
        ...old,
        memberTemplate: {
          schemaVersion: 1,
          spaceId: 'north',
          ownerId: 'ann',
          sourceTaskId: 'task-one',
          sourceWorkbenchRevision: 1,
        },
      },
      latest,
    ),
    false,
  );
  const publication = {
    spaceId: 'north',
    kind: 'skill',
    assetId: 'private',
    versionId: '00000000-0000-4000-8000-000000000003',
    digest: 'a'.repeat(64),
  };
  assert.equal(canUpgradeBuiltinAsset({ ...old, memberAsset: publication }, latest), false);
  assert.equal(canUpgradeBuiltinAsset(old, { ...latest, memberAsset: publication }), false);
  // The public schema also refuses a member publication masquerading as an old builtin ID.
  assert.equal(AssetSchema.safeParse({ ...old, memberAsset: publication }).success, false);
});

async function seeded(options = {}) {
  let catalog = { experts: [], assets: structuredClone(legacy.assets) };
  const f = setup({ ...options, service: { catalog: async () => catalog, ...options.service } });
  await f.service().command(request(0, projectCommand()), signal());
  const task = taskInput();
  task.workflows[0].nodes[0].skillIds = [legacy.assets[0].id];
  const oldCreate = request(1, { type: 'create-task', task });
  await f.service().command(oldCreate, signal());
  await f.service().command(request(2, { type: 'confirm-task', taskId: task.id }), signal());
  return {
    f,
    oldCreate,
    setCatalog: (assets) => {
      catalog = { experts: [], assets };
    },
  };
}

test('builtin upgrade: reopened service can create and confirm while old fixed plan and receipts stay byte-identical', async () => {
  const { f, oldCreate, setCatalog } = await seeded();
  const before = f.workbench.snapshot();
  const planBytes = JSON.stringify(before.appliedPlans[0]);
  const receiptBytes = JSON.stringify(before.receipts);
  f.reopen();
  setCatalog(current);
  const task = taskInput({ id: 'after-upgrade' });
  task.workflows[0].nodes[0].skillIds = [latest.id];
  const create = request(3, { type: 'create-task', task });
  await f.service().command(create, signal());
  await f.service().command(request(4, { type: 'confirm-task', taskId: task.id }), signal());
  const after = f.workbench.snapshot();
  assert.equal(after.revision, 5);
  assert.equal(JSON.stringify(after.appliedPlans[0]), planBytes);
  assert.equal(JSON.stringify(after.receipts.slice(0, before.receipts.length)), receiptBytes);
  assert.deepEqual(after.assets, current);
  assert.deepEqual(after.appliedPlans[1].assets, [latest]);
  const fixed = JSON.stringify(after);
  await f.service().command(create, signal());
  await assert.rejects(f.service().command(oldCreate, signal()), rejected('context-changed'));
  assert.equal(
    JSON.stringify(f.workbench.snapshot()),
    fixed,
    'same request replays without a second upgrade/write',
  );
});

for (const change of ['name', 'description', 'content', 'origin']) {
  test(`builtin upgrade: existing private/imported same-ID ${change} conflict still fails without writes`, async () => {
    const { f, setCatalog } = await seeded();
    const state = f.workbench.snapshot();
    const row = state.assets.find((asset) => asset.id === latest.id);
    row[change] = change === 'origin' ? importedOrigin : `${row[change]} private`;
    await f.storage.write(state);
    f.reopen();
    setCatalog(current);
    const before = JSON.stringify(f.workbench.snapshot());
    const writes = f.writes;
    await assert.rejects(
      f
        .service()
        .command(
          request(3, { type: 'create-task', task: taskInput({ id: 'private-conflict' }) }),
          signal(),
        ),
      rejected('resource-conflict'),
    );
    assert.equal(JSON.stringify(f.workbench.snapshot()), before);
    assert.equal(f.writes, writes);
  });
}

test('builtin upgrade: current-catalog forgery, missing grant, and revoked membership cannot trigger an upgrade', async () => {
  for (const mode of ['metadata', 'body', 'missing-catalog', 'revoked']) {
    const { f, setCatalog } = await seeded();
    const assets = structuredClone(current);
    if (mode === 'metadata') assets.find((a) => a.id === latest.id).name = 'Forged current builtin';
    if (mode === 'body') assets.find((a) => a.id === latest.id).content += '\nForged';
    setCatalog(mode === 'missing-catalog' ? [] : assets);
    if (mode === 'revoked') f.grants.delete('north/ann');
    const before = JSON.stringify(f.workbench.snapshot());
    const command = request(3, { type: 'create-task', task: taskInput({ id: `blocked-${mode}` }) });
    if (mode === 'missing-catalog') {
      const projection = await f.service().command(command, signal());
      assert.deepEqual(projection.state.assets, [], 'no grant inferred from persisted builtins');
      assert.deepEqual(
        f.workbench.snapshot().assets,
        legacy.assets,
        'legacy presence creates no resource grant or update',
      );
    } else {
      await assert.rejects(
        f.service().command(command, signal()),
        rejected(mode === 'revoked' ? 'not-found' : 'resource-conflict'),
      );
      assert.equal(JSON.stringify(f.workbench.snapshot()), before);
    }
  }
});

test('builtin upgrade: an interrupted old intent cannot silently adopt a newer builtin pin', async () => {
  const { f, setCatalog } = await seeded();
  const before = JSON.stringify(f.workbench.snapshot());
  const begin = f.operations.begin.bind(f.operations);
  f.operations.begin = async (intent) => {
    await begin(intent);
    setCatalog(current);
  };
  const command = request(3, { type: 'create-task', task: taskInput({ id: 'interrupted' }) });
  await assert.rejects(f.service().command(command, signal()), rejected('context-changed'));
  const pending = structuredClone([...f.intents.values()].at(-1));
  assert.equal(pending.state, 'pending');
  assert.equal(JSON.stringify(f.workbench.snapshot()), before);
  f.reopen();
  f.operations.begin = begin;
  await assert.rejects(f.service().command(command, signal()), rejected('context-changed'));
  assert.deepEqual([...f.intents.values()].at(-1), pending);
  assert.equal(JSON.stringify(f.workbench.snapshot()), before);
});

// Actual published DSH Connection/JSON and product member HTTP; synthetic accounts.
// No model, GUI, runtime release bundle, or deployed backend claim.
test(
  'builtin upgrade HTTP components: same-disk reopen permits create/confirm without rewriting fixed history or bypassing revocation',
  { timeout: 30000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-builtin-upgrade-'));
    let host, execution;
    let catalog = { experts: [], assets: structuredClone(legacy.assets) };
    const config = { catalog: async () => catalog };
    const executionBytes = () => readFile(join(home, 'storages', 'zhuma_execution.json'), 'utf8');
    const mountExecution = async () => {
      execution = host.ctx.plugin(
        { inject: [...executionInject], apply: applyExecution },
        {
          readWorkbench: () => host.service.snapshot(),
          projectSpaces: boundedProjectSpaces([{ projectId: 'project-one', spaceId: 'north' }]),
        },
      );
      await execution;
    };
    const exec = (endpoint, payload, cookie) =>
      host.post(
        `/api/zhuma-exec/${endpoint}`,
        {
          type: 'client-request',
          rpcId: 'upgrade-proof',
          method: `zhuma-exec/${endpoint}`,
          payload,
        },
        cookie,
      );
    const workbenchBytes = () => readFile(join(home, 'storages', 'zhuma_workbench.json'), 'utf8');
    const ok = (r) => {
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.result?.ok, true, JSON.stringify(r.json));
      return r.json.result.value;
    };
    try {
      host = await startMemberWorkbenchHost(home, config);
      let ann = await host.login('ann');
      const original = taskInput();
      original.workflows[0].nodes[0].skillIds = [old.id];
      ok(await host.rpc('command', request(0, projectCommand()), ann));
      const originalCreate = request(1, { type: 'create-task', task: original });
      ok(await host.rpc('command', originalCreate, ann));
      ok(await host.rpc('command', request(2, { type: 'confirm-task', taskId: original.id }), ann));
      await mountExecution();
      const applied = host.service.snapshot().appliedPlans[0];
      const locate = {
        taskId: applied.taskId,
        planId: applied.id,
        revision: applied.revision,
        nodeId: 'write',
      };
      ok(
        await exec(
          'start-plan',
          {
            taskId: applied.taskId,
            planId: applied.id,
            revision: applied.revision,
            idempotencyKey: 'legacy-start',
          },
          ann,
        ),
      );
      const active = ok(await exec('inbox', {}, ann)).nodes.find((n) => n.nodeId === 'write');
      const accepted = ok(
        await exec(
          'submit',
          {
            ...locate,
            expectedVersion: active.version,
            idempotencyKey: 'legacy-delivery',
            text: 'Already accepted fixed v1.4 body.\nKeep these exact bytes.',
          },
          ann,
        ),
      );
      assert.equal(accepted.node.status, 'completed');
      assert.equal(accepted.node.acceptedArtifactVersionId, accepted.node.artifacts[0].id);
      const acceptedBytes = await executionBytes();
      const before = host.service.snapshot();
      const planBytes = JSON.stringify(before.appliedPlans[0]);
      const receiptBytes = JSON.stringify(before.receipts);
      await execution.dispose();
      execution = undefined;
      await host.close();
      host = undefined;
      const cold = JSON.parse(await workbenchBytes()).global;
      assert.equal(JSON.stringify(cold.appliedPlans[0]), planBytes);
      assert.equal(JSON.stringify(cold.receipts), receiptBytes);
      catalog = { experts: [], assets: current };
      host = await startMemberWorkbenchHost(home, config);
      await mountExecution();
      assert.equal(await executionBytes(), acceptedBytes, 'accepted artifact bytes survive reopen');
      ann = await host.login('ann');
      const next = taskInput({ id: 'upgrade-http' });
      next.workflows[0].nodes[0].skillIds = [latest.id];
      ok(await host.rpc('command', request(3, { type: 'create-task', task: next }), ann));
      ok(await host.rpc('command', request(4, { type: 'confirm-task', taskId: next.id }), ann));
      const after = host.service.snapshot();
      assert.equal(JSON.stringify(after.appliedPlans[0]), planBytes);
      assert.equal(JSON.stringify(after.receipts.slice(0, before.receipts.length)), receiptBytes);
      assert.deepEqual(after.assets, current);
      assert.deepEqual(after.appliedPlans[1].assets, [latest]);
      assert.equal(
        await executionBytes(),
        acceptedBytes,
        'upgrade leaves accepted bytes untouched',
      );
      const fixed = await workbenchBytes();
      const oldReplay = await host.rpc('command', originalCreate, ann);
      assert.equal(oldReplay.json.result?.ok, false);
      assert.equal(oldReplay.json.result.error.code, 'context-changed');
      assert.equal(
        await workbenchBytes(),
        fixed,
        'old-context receipt is not re-pinned or rewritten',
      );
      await host.directory.revokeMembership('north', 'ann');
      const denied = await host.rpc(
        'command',
        request(5, { type: 'create-task', task: taskInput({ id: 'after-revocation' }) }),
        ann,
      );
      assert.equal(denied.json.result?.ok, false);
      assert.equal(denied.json.result.error.code, 'not-found');
      assert.equal(await workbenchBytes(), fixed);
      assert.equal(await executionBytes(), acceptedBytes);
    } finally {
      await execution?.dispose();
      await host?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
