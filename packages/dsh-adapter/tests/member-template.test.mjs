import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AssetSchema, emptyWorkbench, resolveTemplateBindings } from '@zhuma/agent-core';
import {
  defaultMemberTemplates,
  ENGINEERING_WORKFLOW_SOURCE,
} from '../dist/member-template-catalog.js';
import { MemberWorkbenchCommandSchema } from '../dist/member-workbench-dto.js';
import {
  request,
  signal,
  taskInput,
  projectCommand,
  rejected,
} from './member-workbench-fixture.mjs';
import { catalog, definition, instance, fixture } from './member-template-fixture.mjs';

const saveTemplate = (revision, patch = {}, spaceId = 'north') =>
  request(
    revision,
    {
      type: 'save-template',
      input: {
        templateId: randomUUID(),
        sourceTaskId: 'task-one',
        name: '保存的工作流',
        description: '显式保存',
        ...patch,
      },
    },
    spaceId,
  );
async function sourceTask(f) {
  await f.service().command(request(0, { type: 'create-task', task: taskInput() }), signal());
}

test('member template contract: combined owned/default catalog cannot exceed the original Workbench asset bound', async () => {
  const state = emptyWorkbench();
  state.assets = Array.from({ length: 99 }, (_, index) => ({
    ...catalog().assets[0],
    id: `owned-${index}`,
    memberTemplate: {
      schemaVersion: 1,
      spaceId: 'north',
      ownerId: 'ann',
      sourceTaskId: 'source-task',
      sourceWorkbenchRevision: 0,
    },
  }));
  const f = fixture({ state });
  await assert.rejects(f.service().snapshot({ spaceId: 'north' }), rejected('unavailable'));
  assert.equal(f.writes, 0);
  assert.equal(f.intents.size, 0);
});

test('member template contract: ownership metadata is template-only and cannot be submitted as a member definition', () => {
  const asset = {
    ...catalog().assets[0],
    memberTemplate: {
      schemaVersion: 1,
      spaceId: 'north',
      ownerId: 'ann',
      sourceTaskId: 'task-one',
      sourceWorkbenchRevision: 1,
    },
  };
  assert.equal(AssetSchema.safeParse(asset).success, true);
  assert.equal(
    AssetSchema.safeParse({ ...asset, kind: 'skill', content: 'method' }).success,
    false,
  );
  for (const key of ['actorId', 'memberTemplate', 'content', 'asset']) {
    const input = saveTemplate(0);
    input.command.input[key] = key === 'content' ? 'fake-body' : {};
    assert.equal(MemberWorkbenchCommandSchema.safeParse(input).success, false);
  }
});

test('member template contract: default catalog accepts only four exact public source bodies and returns a copy', async () => {
  const base = new URL('../../../resources/workflows/engineering-starter/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('catalog.json', base), 'utf8'));
  const assets = await Promise.all(
    manifest.workflows.map(async (entry) => ({
      id: entry.id,
      name: entry.name,
      kind: 'template',
      description: entry.description,
      available: true,
      content: await readFile(new URL(entry.file, base), 'utf8'),
    })),
  );
  const bundle = { sourceCommit: ENGINEERING_WORKFLOW_SOURCE, assets };
  const verified = defaultMemberTemplates(bundle);
  assert.deepEqual(verified, assets);
  assert.notEqual(verified[0], assets[0]);
  for (const change of ['source', 'bytes', 'duplicate', 'owner']) {
    const bad = structuredClone(bundle);
    if (change === 'source') bad.sourceCommit = '0'.repeat(40);
    if (change === 'bytes') bad.assets[0].content += '\n';
    if (change === 'duplicate') bad.assets[1] = bad.assets[0];
    if (change === 'owner')
      bad.assets[0].memberTemplate = {
        schemaVersion: 1,
        spaceId: 'north',
        ownerId: 'ann',
        sourceTaskId: 'task-one',
        sourceWorkbenchRevision: 0,
      };
    assert.throws(() => defaultMemberTemplates(bad), rejected('unavailable'));
  }
});

test('member template contract: save uses the real owner task and one original asset row; team read is not edit authority', async () => {
  const f = fixture();
  await sourceTask(f);
  const input = saveTemplate(1),
    source = f.workbench.snapshot().tasks[0];
  const value = await f.service().command(input, signal());
  const asset = value.state.assets.find((item) => item.id === input.command.input.templateId);
  assert.deepEqual(asset.memberTemplate, {
    schemaVersion: 1,
    spaceId: 'north',
    ownerId: 'ann',
    sourceTaskId: 'task-one',
    sourceWorkbenchRevision: 1,
  });
  assert.equal(
    JSON.parse(asset.content).roles.some((role) => role.id === 'ann' || role.name === 'ann'),
    false,
  );
  assert.deepEqual(f.workbench.snapshot().tasks[0], source);
  assert.equal(f.workbench.snapshot().assets.filter((item) => item.id === asset.id).length, 1);
  assert.ok(
    (await f.service('bob').snapshot({ spaceId: 'north' })).state.assets.some(
      (item) => item.id === asset.id,
    ),
  );
  await assert.rejects(
    f.service('bob').command(saveTemplate(2, { templateId: asset.id }), signal()),
    rejected('forbidden'),
  );
  const legacy = structuredClone(input);
  legacy.requestId = randomUUID();
  legacy.expectedRevision = 2;
  legacy.command.input.templateId = randomUUID();
  await assert.rejects(f.service('bob').command(legacy, signal()), rejected('forbidden'));
  assert.equal(f.writes, 2);
  assert.equal(f.audits.size, 0);
});

test('member template contract: create/update same-key acknowledgement recovery uses exact original before/result pins', async () => {
  const f = fixture();
  await sourceTask(f);
  const first = saveTemplate(1);
  await f.service().command(first, signal());
  await f.service().command(first, signal());
  assert.equal(f.writes, 2);
  const update = saveTemplate(2, {
    templateId: first.command.input.templateId,
    name: '第二次保存',
  });
  const complete = f.operations.complete.bind(f.operations);
  f.operations.complete = async () => {
    throw Error('synthetic asset acknowledgement failure');
  };
  await assert.rejects(f.service().command(update, signal()), /acknowledgement/u);
  assert.equal(f.writes, 3);
  f.reopen();
  f.operations.complete = complete;
  await f.service().command(update, signal());
  await f.service().command(update, signal());
  assert.equal(f.writes, 3);
  assert.equal(
    f.workbench.snapshot().assets.find((asset) => asset.id === first.command.input.templateId).name,
    '第二次保存',
  );
  assert.ok(
    [...f.intents.values()]
      .filter((intent) => intent.commandType === 'save-template')
      .every(
        (intent) =>
          intent.templateResultFingerprint && intent.templatePriorFingerprint !== undefined,
      ),
  );
  const wrong = structuredClone(update);
  wrong.command.input.name = '不同内容';
  await assert.rejects(f.service().command(wrong, signal()), rejected('request-reused'));
});

test('member template contract: overwritten/deleted/foreign-owned saved results cannot authenticate an old receipt', async () => {
  for (const mode of ['body', 'delete', 'owner']) {
    const f = fixture();
    await sourceTask(f);
    const input = saveTemplate(1);
    await f.service().command(input, signal());
    const stored = f.storage.read(),
      asset = stored.assets.find((item) => item.id === input.command.input.templateId);
    if (mode === 'body') asset.content = asset.content.replace('接口', '变更接口');
    if (mode === 'delete') stored.assets = stored.assets.filter((item) => item.id !== asset.id);
    if (mode === 'owner') asset.memberTemplate.ownerId = 'bob';
    const before = JSON.stringify(stored),
      intents = JSON.stringify([...f.intents.values()]);
    await assert.rejects(f.service().command(input, signal()));
    assert.equal(JSON.stringify(f.storage.read()), before);
    assert.equal(JSON.stringify([...f.intents.values()]), intents);
    assert.equal(f.writes, 2);
  }
});

test('member template contract: personal ownership is a real directory fact and explicit cross-space copy grants no private tools', async () => {
  const state = emptyWorkbench();
  state.projects = [
    { id: 'project-one', name: '团队项目', description: '' },
    { id: 'personal-project', name: '个人项目', description: '' },
  ];
  const privateSkill = {
    id: 'private-method',
    name: '私有方法',
    kind: 'skill',
    description: '',
    available: true,
    content: 'PRIVATE_SKILL_BODY_CANARY',
  };
  let owner = 'ann';
  const f = fixture({
    state,
    projectSpaces: [
      ['project-one', 'north'],
      ['personal-project', 'personal-ann'],
    ],
    service: {
      catalog: async (spaceId) =>
        spaceId === 'north' ? catalog() : { experts: [], assets: [privateSkill] },
    },
  });
  f.directory.administratorForSpace = () => owner;
  const personal = taskInput({
    projectId: 'personal-project',
    participantIds: ['ann'],
    workflows: [
      {
        id: 'personal-flow',
        name: '个人流程',
        parentNodeId: null,
        nodes: [
          {
            ...definition.workflows[0].nodes[1],
            id: 'private-work',
            assigneeId: 'ann',
            dependsOn: [],
            skillIds: ['private-method'],
          },
        ],
      },
    ],
  });
  await f
    .service()
    .command(request(0, { type: 'create-task', task: personal }, 'personal-ann'), signal());
  owner = undefined;
  await assert.rejects(
    f.service().command(saveTemplate(1, {}, 'personal-ann'), signal()),
    rejected('unavailable'),
  );
  owner = 'bob';
  await assert.rejects(
    f.service().command(saveTemplate(1, {}, 'personal-ann'), signal()),
    rejected('not-found'),
  );
  owner = 'ann';
  const save = saveTemplate(1, {}, 'personal-ann');
  await f.service().command(save, signal());
  const id = save.command.input.templateId;
  assert.equal(
    (await f.service('bob').snapshot({ spaceId: 'north' })).state.assets.some(
      (asset) => asset.id === id,
    ),
    false,
  );
  const wrong = instance(2, { templateId: id, roleBindings: {}, resourceBindings: {} });
  await assert.rejects(f.service().command(wrong, signal()), rejected('template-unavailable'));
  const copy = instance(2, {
    templateId: id,
    sourceSpaceId: 'personal-ann',
    roleBindings: {},
    resourceBindings: {},
  });
  const result = await f.service().command(copy, signal());
  const task = result.state.tasks[0];
  assert.equal(task.templateSource.pendingAssets.length, 1);
  assert.equal(
    result.state.assets.some((asset) => asset.id === 'private-method' || asset.id === id),
    false,
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SKILL_BODY_CANARY/u);
  assert.equal(
    f.workbench.snapshot().assets.find((asset) => asset.id === id).memberTemplate.spaceId,
    'personal-ann',
  );
  assert.equal(
    f.workbench.snapshot().tasks.find((task) => task.projectId === 'personal-project').workflows[0]
      .nodes[0].skillIds[0],
    'private-method',
  );
  const badBinding = instance(3, {
    templateId: id,
    sourceSpaceId: 'personal-ann',
    roleBindings: {},
    resourceBindings: { 'resource-1': 'private-method' },
  });
  await assert.rejects(f.service().command(badBinding, signal()), rejected('template-binding'));
  const publishCopy = saveTemplate(3, { sourceSpaceId: 'personal-ann' });
  const shared = await f.service().command(publishCopy, signal());
  const sharedAsset = shared.state.assets.find(
    (asset) => asset.id === publishCopy.command.input.templateId,
  );
  assert.equal(sharedAsset.memberTemplate.spaceId, 'north');
  assert.equal(sharedAsset.memberTemplate.ownerId, 'ann');
  assert.doesNotMatch(sharedAsset.content, /PRIVATE_SKILL_BODY_CANARY/u);
  assert.ok(
    (await f.service('bob').snapshot({ spaceId: 'north' })).state.assets.some(
      (asset) => asset.id === sharedAsset.id,
    ),
  );
  assert.equal(
    f.workbench.snapshot().assets.find((asset) => asset.id === id).memberTemplate.spaceId,
    'personal-ann',
  );
  owner = undefined;
  await assert.rejects(f.service().snapshot({ spaceId: 'personal-ann' }), rejected('unavailable'));
});

test('member template contract: source/target revocation and source edits after a save intent cannot publish', async () => {
  for (const change of ['source', 'target', 'owner', 'body']) {
    const f = fixture();
    await sourceTask(f);
    let owner = 'ann';
    f.directory.administratorForSpace = () => owner;
    const input = saveTemplate(1, { sourceSpaceId: 'north' }, 'personal-ann');
    const begin = f.operations.begin.bind(f.operations);
    f.operations.begin = async (intent) => {
      await begin(intent);
      if (change === 'source') f.grants.delete('north/ann');
      if (change === 'target') f.grants.delete('personal-ann/ann');
      if (change === 'owner') owner = 'bob';
      if (change === 'body')
        f.storage.read().tasks[0].workflows[0].nodes[0].description = 'CHANGED_SOURCE';
    };
    await assert.rejects(f.service().command(input, signal()));
    assert.equal(f.writes, 1);
    assert.equal(
      f.workbench.snapshot().assets.some((asset) => asset.id === input.command.input.templateId),
      false,
    );
    assert.equal(
      [...f.intents.values()].find((intent) => intent.commandType === 'save-template').state,
      'pending',
    );
  }
});

test('member template contract: strict command accepts only mapping input and server-owned provenance', () => {
  const original = instance();
  assert.deepEqual(MemberWorkbenchCommandSchema.parse(original), original);
  for (const patch of [
    { actorId: 'bob' },
    { status: 'ready' },
    { updatedAt: new Date().toISOString() },
    { workflows: [] },
    { templateSource: {} },
  ]) {
    const raw = structuredClone(original);
    Object.assign(raw.command.input.task, patch);
    assert.equal(MemberWorkbenchCommandSchema.safeParse(raw).success, false);
  }
  const bad = structuredClone(original);
  bad.command.input.task.id = 'not-a-uuid';
  assert.equal(MemberWorkbenchCommandSchema.safeParse(bad).success, false);
});

test('member template contract: original atomic command freezes source and remaps every graph reference', async () => {
  const f = fixture(),
    input = instance();
  const view = await f.service().command(input, signal());
  const task = view.state.tasks[0],
    id = input.command.input.task.id;
  assert.equal(task.status, 'draft');
  assert.equal(task.ownerId, 'ann');
  assert.deepEqual(task.templateSource.definition, definition);
  assert.equal(task.templateSource.sourceWorkbenchRevision, 0);
  assert.equal(task.templateSource.assetId, 'authorized-template');
  assert.deepEqual(
    task.workflows.map((w) => w.id),
    [`${id}-f-0`, `${id}-f-1`],
  );
  assert.equal(task.workflows[1].parentNodeId, `${id}-n-0`);
  assert.deepEqual(task.workflows[0].nodes[1].dependsOn, [`${id}-n-0`]);
  assert.deepEqual(task.workflows[0].nodes[0].reviewerIds, ['bob']);
  assert.deepEqual(task.workflows[0].nodes[0].skillIds, ['authorized-skill']);
  assert.equal(
    f.workbench.snapshot().assets.find((a) => a.id === 'authorized-template').content,
    JSON.stringify(definition),
  );
  assert.equal(
    view.state.assets.some((a) => a.id === 'legacy-private'),
    false,
  );
  const second = instance(1);
  const next = await f.service().command(second, signal());
  assert.equal(next.state.tasks.length, 2);
  assert.notEqual(
    next.state.tasks[0].workflows[0].nodes[0].id,
    next.state.tasks[1].workflows[0].nodes[0].id,
  );
  assert.equal(f.audits.size, 0);
  assert.equal(next.state.appliedPlans.length, 0);
});

test('member template contract: four actual starter files instantiate as missing-binding drafts without running a model', async () => {
  const base = new URL('../../../resources/workflows/engineering-starter/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('catalog.json', base), 'utf8'));
  assert.equal(manifest.workflows.length, 4);
  for (const entry of manifest.workflows) {
    const content = await readFile(new URL(entry.file, base), 'utf8');
    const assets = [
      {
        id: entry.id,
        name: entry.name,
        kind: 'template',
        description: entry.description,
        available: true,
        content,
      },
    ];
    const f = fixture({ service: { catalog: async () => ({ experts: [], assets }) } });
    const value = await f
      .service()
      .command(
        instance(0, { templateId: entry.id, roleBindings: {}, resourceBindings: {} }),
        signal(),
      );
    const task = value.state.tasks[0];
    assert.equal(task.status, 'draft');
    assert.deepEqual(task.templateSource.definition, JSON.parse(content));
    assert.ok(task.templateSource.pendingParticipants.length);
    assert.ok(
      task.workflows.some((w) => w.nodes.some((n) => n.reviewRequired && n.reviewerIds.length)),
    );
    await assert.rejects(
      f.service().command(request(1, { type: 'confirm-task', taskId: task.id }), signal()),
    );
    assert.equal(f.workbench.snapshot().revision, 1);
    assert.equal(f.audits.size, 0);
  }
});

test('member template contract: missing roles/resources stay draft; only real scoped bindings permit confirmation', async () => {
  const f = fixture();
  const value = await f
    .service()
    .command(instance(0, { roleBindings: {}, resourceBindings: {} }), signal());
  const task = value.state.tasks[0];
  assert.equal(task.templateSource.pendingParticipants.length, 2);
  assert.equal(task.templateSource.pendingAssets.length, 1);
  assert.equal(
    value.state.participants.some((p) => p.id === task.workflows[0].nodes[0].assigneeId),
    false,
  );
  assert.equal(
    value.state.assets.some((a) => a.id === task.workflows[0].nodes[0].skillIds[0]),
    false,
  );
  await assert.rejects(
    f.service().command(request(1, { type: 'confirm-task', taskId: task.id }), signal()),
    rejected('resource-unavailable'),
  );
  const roleBindings = Object.fromEntries(
    task.templateSource.pendingParticipants.map((p, i) => [p.id, i ? 'bob' : 'ann']),
  );
  const resourceBindings = { [task.templateSource.pendingAssets[0].id]: 'authorized-skill' };
  const mapped = resolveTemplateBindings(task, value.state, roleBindings, resourceBindings);
  const { status, updatedAt, templateSource, ...editable } = mapped;
  const saved = await f
    .service()
    .command(request(1, { type: 'update-task', task: editable }), signal());
  assert.deepEqual(saved.state.tasks[0].templateSource, templateSource);
  const confirmed = await f
    .service()
    .command(request(2, { type: 'confirm-task', taskId: task.id }), signal());
  assert.equal(confirmed.state.tasks[0].status, 'ready');
  assert.equal(confirmed.state.appliedPlans.length, 1);
  await assert.rejects(
    f.service('bob').command(request(3, { type: 'update-task', task: editable }), signal()),
    rejected('forbidden'),
  );
});

for (const [label, patch] of [
  ['legacy global source', { templateId: 'legacy-private' }],
  ['unknown role', { roleBindings: { unknown: 'ann' } }],
  ['foreign member', { roleBindings: { author: 'dana', reviewer: 'bob' } }],
  ['self review', { roleBindings: { author: 'ann', reviewer: 'ann' } }],
  ['wrong resource kind', { resourceBindings: { method: 'authorized-template' } }],
  ['unknown resource', { resourceBindings: { method: 'not-authorized' } }],
])
  test(`member template contract: ${label} rejects before any intent or business write`, async () => {
    const f = fixture();
    await assert.rejects(f.service().command(instance(0, patch), signal()));
    assert.equal(f.writes, 0);
    assert.equal(f.intents.size, 0);
    assert.equal(f.workbench.snapshot().tasks.length, 0);
  });

test('member template contract: wrong scope, revoked cookie and unavailable directory fail closed without writes', async () => {
  const f = fixture();
  await assert.rejects(
    f.service('cy').command(instance(0, {}, 'south'), signal()),
    rejected('not-found'),
  );
  f.sessions.delete('ann');
  await assert.rejects(f.service().command(instance(), signal()), rejected('unauthenticated'));
  await assert.rejects(
    f.service('bob', { directory: () => undefined }).command(instance(), signal()),
    rejected('unavailable'),
  );
  assert.equal(f.writes, 0);
  assert.equal(f.intents.size, 0);
});

test('member template contract: same-key concurrency and acknowledgement recovery never create another instance', async () => {
  const f = fixture(),
    input = instance();
  const replies = await Promise.all([
    f.service().command(input, signal()),
    f.service().command(input, signal()),
  ]);
  assert.equal(
    replies.every((v) => v.state.tasks.length === 1),
    true,
  );
  assert.equal(f.writes, 1);
  const reordered = structuredClone(input);
  reordered.command.input.roleBindings = Object.fromEntries(
    Object.entries(reordered.command.input.roleBindings).reverse(),
  );
  await f.service().command(reordered, signal());
  assert.equal(f.writes, 1);
  const changed = structuredClone(input);
  changed.command.input.task.title = '异体请求';
  await assert.rejects(f.service().command(changed, signal()), rejected('request-reused'));
  const next = instance(1),
    complete = f.operations.complete.bind(f.operations);
  f.operations.complete = async () => {
    throw Error('synthetic acknowledgement failure');
  };
  await assert.rejects(f.service().command(next, signal()), /acknowledgement/u);
  assert.equal(f.writes, 2);
  f.reopen();
  f.operations.complete = complete;
  await f.service().command(next, signal());
  await f.service().command(next, signal());
  assert.equal(f.writes, 2);
  assert.equal(f.workbench.snapshot().tasks.length, 2);
});

test('member template contract: pending task IDs are shared by manual and template creates across actors', async () => {
  const f = fixture(),
    input = instance();
  f.failWrites(true);
  await assert.rejects(f.service().command(input, signal()));
  f.failWrites(false);
  const before = structuredClone([...f.intents.values()]);
  const task = taskInput({ id: input.command.input.task.id });
  await assert.rejects(
    f.service().command(request(0, { type: 'create-task', task }), signal()),
    rejected('conflict'),
  );
  const other = structuredClone(input);
  other.requestId = randomUUID();
  other.command.input.task.ownerId = 'bob';
  await assert.rejects(f.service('bob').command(other, signal()), rejected('conflict'));
  assert.deepEqual([...f.intents.values()], before);
  assert.equal(f.writes, 0);
  await f.service().command(input, signal());
  assert.equal(f.writes, 1);
});

test('member template contract: a pending template ID cannot be claimed by a member in another actual project space', async () => {
  const state = emptyWorkbench();
  state.projects = ['one', 'two'].map((part) => ({
    id: `project-${part}`,
    name: `项目 ${part}`,
    description: '',
  }));
  const f = fixture({
    state,
    projectSpaces: [
      ['project-one', 'north'],
      ['project-two', 'south'],
    ],
  });
  const input = instance();
  f.failWrites(true);
  await assert.rejects(f.service().command(input, signal()));
  f.failWrites(false);
  const before = structuredClone([...f.intents.values()]);
  const task = taskInput({
    id: input.command.input.task.id,
    projectId: 'project-two',
    ownerId: 'cy',
    participantIds: ['cy', 'dana'],
    workflows: [{ id: 'south-root', name: '南区工作', parentNodeId: null, nodes: [] }],
  });
  await assert.rejects(
    f.service('cy').command(request(0, { type: 'create-task', task }, 'south'), signal()),
    rejected('not-found'),
  );
  assert.equal(f.writes, 0);
  assert.deepEqual([...f.intents.values()], before);
});

test('member template contract: a new same-task request loses a concurrent race without overwriting the winner', async () => {
  const f = fixture(),
    first = instance(),
    second = structuredClone(first);
  second.requestId = randomUUID();
  second.command.input.task.title = '第二请求';
  const result = await Promise.allSettled([
    f.service().command(first, signal()),
    f.service().command(second, signal()),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(result.find((r) => r.status === 'rejected').reason.code, 'conflict');
  assert.equal(f.writes, 1);
  assert.equal(f.workbench.snapshot().tasks[0].title, first.command.input.task.title);
});

test('member template contract: catalog changes/revocation at the durability boundary preserve the original intent', async () => {
  for (const change of ['body', 'membership']) {
    let value = catalog();
    const f = fixture({ service: { catalog: async () => value } }),
      input = instance();
    const begin = f.operations.begin.bind(f.operations);
    f.operations.begin = async (intent) => {
      await begin(intent);
      if (change === 'body')
        value = {
          ...value,
          assets: value.assets.map((a) =>
            a.kind === 'template'
              ? { ...a, content: a.content.replace('主流程', '新的主流程') }
              : a,
          ),
        };
      else f.grants.delete('north/ann');
    };
    await assert.rejects(
      f.service().command(input, signal()),
      rejected(change === 'body' ? 'context-changed' : 'not-found'),
    );
    assert.equal(f.writes, 0);
    assert.equal([...f.intents.values()][0].state, 'pending');
    const stored = structuredClone([...f.intents.values()]);
    f.operations.begin = begin;
    await assert.rejects(f.service().command(input, signal()));
    assert.deepEqual([...f.intents.values()], stored);
    value = catalog();
    f.grants.add('north/ann');
    await f.service().command(input, signal());
    assert.equal(f.writes, 1);
  }
});

async function boot(input) {
  const child = fork(fileURLToPath(new URL('./member-template-process.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH },
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-1000);
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(`template child timed out: ${diagnostics}`)),
        15000,
      );
      child.once('message', (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.send(input);
    });
    assert.equal(result.ok, true, result.error);
    return result;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
}
async function businessBytes(home) {
  return Promise.all(
    ['zhuma_workbench', 'zhuma_member_operations'].map((name) =>
      readFile(join(home, 'storages', `${name}.json`)),
    ),
  );
}

test(
  'member template real JSON/HTTP/new-process: saved asset replay requires its exact durable body and ownership',
  { timeout: 45000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-template-save-recovery-'));
    try {
      await boot({
        home,
        commands: [
          request(0, projectCommand()),
          request(1, { type: 'create-task', task: taskInput() }),
        ],
      });
      const input = saveTemplate(2);
      const failed = await boot({ home, faultStage: 'before-complete', commands: [input] });
      assert.equal(failed.responses[0].ok, false);
      assert.equal(failed.state.revision, 3);
      const id = input.command.input.templateId;
      assert.equal(failed.state.assets.filter((asset) => asset.id === id).length, 1);
      const before = await businessBytes(home);
      const readOnly = await boot({ home });
      assert.deepEqual(readOnly.before, failed.state);
      assert.deepEqual(await businessBytes(home), before);
      const replaced = await boot({ home, changedCatalog: true, commands: [input] });
      assert.equal(replaced.responses[0].error.code, 'context-changed');
      assert.deepEqual(await businessBytes(home), before);
      const denied = await boot({ home, actor: 'dana', commands: [input] });
      assert.equal(denied.responses[0].error.code, 'not-found');
      assert.deepEqual(await businessBytes(home), before);
      const recovered = await boot({ home, commands: [input, input] });
      assert.equal(
        recovered.responses.every((reply) => reply.ok),
        true,
      );
      assert.equal(recovered.state.revision, 3);
      const stable = await businessBytes(home);
      const duplicate = await boot({ home, commands: [input] });
      assert.equal(duplicate.responses[0].ok, true);
      assert.deepEqual(await businessBytes(home), stable);
      const intents = JSON.parse(stable[1].toString()).tables.intents;
      const receipt = Object.values(intents).find((row) => row.commandType === 'save-template');
      assert.equal(receipt.state, 'completed');
      assert.match(receipt.templateResultFingerprint, /^[a-f0-9]{64}$/u);
      assert.doesNotMatch(JSON.stringify(intents), /workflows|接口文档/u);
      const path = join(home, 'storages', 'zhuma_workbench.json');
      for (const mode of ['body', 'delete', 'owner']) {
        const raw = JSON.parse(stable[0].toString());
        const asset = raw.global.assets.find((item) => item.id === id);
        if (mode === 'body') asset.content = asset.content.replace('接口', '篡改接口');
        if (mode === 'delete')
          raw.global.assets = raw.global.assets.filter((item) => item.id !== id);
        if (mode === 'owner') asset.memberTemplate.ownerId = 'bob';
        await writeFile(path, JSON.stringify(raw));
        const corrupted = await businessBytes(home);
        const refused = await boot({ home, commands: [input] });
        assert.equal(refused.responses[0].ok, false);
        assert.equal(
          refused.responses[0].error.code,
          mode === 'delete'
            ? 'operation-unresolved'
            : mode === 'owner'
              ? 'forbidden'
              : 'context-changed',
        );
        assert.deepEqual(await businessBytes(home), corrupted);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  'member template real JSON/HTTP/new-process: failed acknowledgement, revoked/changed retries and fixed-source recovery',
  { timeout: 45000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-template-recovery-'));
    try {
      await boot({ home, commands: [request(0, projectCommand())] });
      const input = instance(1);
      const failed = await boot({ home, faultStage: 'before-complete', commands: [input] });
      assert.equal(failed.responses[0].ok, false);
      assert.equal(failed.state.revision, 2);
      assert.equal(failed.state.tasks.length, 1);
      const before = await businessBytes(home);
      const readOnly = await boot({ home });
      assert.deepEqual(readOnly.before, failed.state);
      assert.deepEqual(await businessBytes(home), before);
      const changed = await boot({ home, changedCatalog: true, commands: [input] });
      assert.equal(changed.responses[0].error.code, 'context-changed');
      assert.deepEqual(await businessBytes(home), before);
      const denied = await boot({ home, actor: 'dana', commands: [input] });
      assert.equal(denied.responses[0].error.code, 'not-found');
      assert.deepEqual(await businessBytes(home), before);
      const recovered = await boot({ home, commands: [input, input] });
      assert.equal(
        recovered.responses.every((r) => r.ok),
        true,
      );
      assert.equal(recovered.state.revision, 2);
      assert.equal(recovered.state.tasks.length, 1);
      assert.deepEqual(recovered.state.tasks[0].templateSource.definition, definition);
      const stable = await businessBytes(home);
      const duplicate = await boot({ home, commands: [input] });
      assert.equal(duplicate.responses[0].ok, true);
      assert.deepEqual(await businessBytes(home), stable);
      const changedBody = structuredClone(input);
      changedBody.command.input.task.title = '不同内容';
      const conflict = await boot({ home, commands: [changedBody] });
      assert.equal(conflict.responses[0].error.code, 'request-reused');
      assert.deepEqual(await businessBytes(home), stable);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
