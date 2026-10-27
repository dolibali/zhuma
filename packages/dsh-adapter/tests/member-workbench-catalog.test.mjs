import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  createNodeHandoffs,
  emptyWorkbench,
  parseWorkflowTemplate,
  previewResourcePackage,
} from '@zhuma/agent-core';
import { publicTeamStarterPackages } from '../../../scripts/lib/team-starter-packages.mjs';
import {
  setup,
  request,
  signal,
  projectCommand,
  taskInput,
  node,
  rejected,
} from './member-workbench-fixture.mjs';

import {
  catalogFixture,
  catalogTask,
  changedCatalog,
} from './member-workbench-catalog-fixture.mjs';

for (const kind of ['expert', 'skill', 'mcp']) {
  test(`member catalog pin contract: same-ID ${kind} content replacement during intent persistence rejects confirmation`, async () => {
    let catalog = catalogFixture();
    const f = setup({ service: { catalog: async () => catalog } });
    await f.service().command(request(0, projectCommand()), signal());
    await f.service().command(request(1, { type: 'create-task', task: catalogTask() }), signal());
    const begin = f.operations.begin.bind(f.operations);
    f.operations.begin = async (intent) => {
      await begin(intent);
      if (intent.commandType === 'confirm-task') {
        catalog = structuredClone(catalog);
        if (kind === 'expert') catalog.experts[0].instructions = 'NEW_AUTHORIZED_EXPERT';
        else catalog.assets.find((a) => a.kind === kind).content = `NEW_AUTHORIZED_${kind}`;
      }
    };
    await assert.rejects(
      f.service().command(request(2, { type: 'confirm-task', taskId: 'task-one' }), signal()),
      rejected('context-changed'),
    );
    assert.equal(f.workbench.snapshot().revision, 2);
    assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
    assert.equal(f.workbench.snapshot().tasks[0].status, 'draft');
    assert.equal(f.writes, 2);
  });
}

for (const kind of ['expert', 'skill', 'mcp']) {
  for (const change of ['revoke', 'disable', ...(kind === 'mcp' ? [] : ['version'])]) {
    test(`member catalog pin contract: ${kind} ${change} after intent rejects without a new task/plan and exact restoration can retry`, async () => {
      const original = catalogFixture();
      let catalog = original;
      const f = setup({ service: { catalog: async () => catalog } });
      await f.service().command(request(0, projectCommand()), signal());
      await f.service().command(request(1, { type: 'create-task', task: catalogTask() }), signal());
      const input = request(2, { type: 'confirm-task', taskId: 'task-one' });
      const begin = f.operations.begin.bind(f.operations);
      f.operations.begin = async (intent) => {
        await begin(intent);
        if (intent.commandType === 'confirm-task') catalog = changedCatalog(original, kind, change);
      };
      await assert.rejects(f.service().command(input, signal()), rejected('context-changed'));
      const pin = structuredClone([...f.intents.values()].at(-1));
      assert.match(pin.contextFingerprint, /^[a-f0-9]{64}$/);
      assert.equal(pin.state, 'pending');
      assert.equal(f.workbench.snapshot().revision, 2);
      assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
      assert.equal(f.workbench.snapshot().tasks.length, 1);
      f.reopen();
      f.operations.begin = begin;
      // A retry cannot silently re-pin the original request to a newly granted same-ID definition.
      catalog = changedCatalog(original, kind);
      await assert.rejects(f.service().command(input, signal()), rejected('context-changed'));
      assert.deepEqual([...f.intents.values()].at(-1), pin);
      catalog = structuredClone(original);
      await f.service().command(input, signal());
      await f.service().command(input, signal());
      assert.equal(f.workbench.snapshot().revision, 3);
      assert.equal(f.workbench.snapshot().appliedPlans.length, 1);
      assert.equal(f.workbench.snapshot().tasks.length, 1);
      assert.deepEqual(
        f.workbench.snapshot().appliedPlans[0].participants.find((p) => p.kind === 'expert'),
        original.experts[0],
      );
      assert.deepEqual(f.workbench.snapshot().appliedPlans[0].assets, original.assets);
    });
  }
}

test('member catalog pin contract: definition changes during async catalog/directory reads reject before an intent is written', async () => {
  for (const boundary of ['catalog', 'directory']) {
    let catalog = catalogFixture();
    let active = false;
    let reads = 0;
    const f = setup({
      service: {
        catalog: async () => {
          if (active && boundary === 'catalog' && ++reads === 2)
            catalog = changedCatalog(catalog, 'expert');
          return catalog;
        },
      },
    });
    await f.service().command(request(0, projectCommand()), signal());
    await f.service().command(request(1, { type: 'create-task', task: catalogTask() }), signal());
    if (boundary === 'directory') {
      const lookup = f.directory.spaceForProject;
      f.directory.spaceForProject = async (id) => {
        const found = await lookup(id);
        catalog = changedCatalog(catalog, 'skill');
        return found;
      };
    }
    active = true;
    await assert.rejects(
      f.service().command(request(2, { type: 'confirm-task', taskId: 'task-one' }), signal()),
      rejected('context-changed'),
    );
    assert.equal(f.intents.size, 2);
    assert.equal(f.workbench.snapshot().revision, 2);
    assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
  }
});

test('member catalog pin contract: project assignment cannot commit catalog definitions that changed after its durable intent', async () => {
  const original = catalogFixture();
  let catalog = original;
  const f = setup({ service: { catalog: async () => catalog } });
  const assign = f.directory.assignProjectSpace;
  f.directory.assignProjectSpace = async (id, space) => {
    await assign(id, space);
    catalog = changedCatalog(original, 'skill');
  };
  const input = request(0, projectCommand());
  await assert.rejects(f.service().command(input, signal()), rejected('context-changed'));
  assert.equal(f.links.get('project-one'), 'north');
  assert.equal(f.workbench.snapshot().revision, 0);
  assert.deepEqual(f.workbench.snapshot().projects, []);
  assert.deepEqual(f.workbench.snapshot().participants, []);
  assert.deepEqual(f.workbench.snapshot().assets, []);
  f.reopen();
  f.directory.assignProjectSpace = assign;
  await assert.rejects(f.service().command(input, signal()), rejected('context-changed'));
  catalog = original;
  await f.service().command(input, signal());
  assert.equal(f.workbench.snapshot().revision, 1);
  assert.equal(f.workbench.snapshot().projects.length, 1);
});

test('member catalog pin contract: catalog order is not a definition change, and journal stores only hashes', async () => {
  let reverse = false;
  const f = setup({
    service: {
      catalog: async () => {
        const catalog = catalogFixture();
        if ((reverse = !reverse)) {
          catalog.experts.reverse();
          catalog.assets.reverse();
        }
        return catalog;
      },
    },
  });
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task: catalogTask() }), signal());
  await f.service().command(request(2, { type: 'confirm-task', taskId: 'task-one' }), signal());
  assert.equal(f.workbench.snapshot().appliedPlans.length, 1);
  assert.doesNotMatch(
    JSON.stringify([...f.intents.values()]),
    /OLD_AUTHORIZED|NEW_AUTHORIZED|instructions|content/,
  );
});

// Original importer and member writer, with synthetic identity/storage/catalog ports.
// These contracts do not prove native Agent, real identity, model or GUI execution.
test('member required expert resources contract: the public starter cannot confirm until its Skill is explicitly selected', async () => {
  const pack = (await publicTeamStarterPackages()).find((p) => p.id === 'zhuma-work-planning');
  const preview = previewResourcePackage(pack.files, parseWorkflowTemplate);
  const imported = applyWorkbenchCommand(emptyWorkbench(), {
    type: 'import-package',
    input: {
      versionId: pack.versionId,
      files: pack.files,
      choices: preview.items.map((item) => ({
        key: item.key,
        id: item.kind === 'expert' ? pack.id : item.name,
        replace: false,
        name: item.name,
        description: item.description,
        role: item.role,
        capabilities: item.capabilities,
        available: true,
      })),
    },
  });
  const catalog = { experts: imported.participants, assets: imported.assets };
  assert.deepEqual(catalog.experts[0].resourceBindings.skillIds, ['work-planning']);
  const f = setup({ service: { catalog: async () => catalog } });
  const task = taskInput({
    participantIds: ['ann', pack.id],
    workflows: [
      {
        id: 'root',
        name: '规划',
        parentNodeId: null,
        nodes: [node('plan', { assigneeId: pack.id, reviewRequired: true, reviewerIds: ['ann'] })],
      },
    ],
  });
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task }), signal());
  const before = f.workbench.snapshot();
  const intents = structuredClone([...f.intents]);
  const writes = f.writes;
  await assert.rejects(
    f.service().command(request(2, { type: 'confirm-task', taskId: task.id }), signal()),
    (error) =>
      error.code === 'resource-unavailable' &&
      error.message.includes(task.workflows[0].nodes[0].title) &&
      error.message.includes(catalog.experts[0].name) &&
      error.message.includes('Skill') &&
      error.message.includes('work-planning'),
  );
  assert.deepEqual(f.workbench.snapshot(), before);
  assert.deepEqual([...f.intents], intents);
  assert.equal(f.writes, writes);
  task.workflows[0].nodes[0].skillIds = ['work-planning'];
  await f.service().command(request(2, { type: 'update-task', task }), signal());
  const confirmation = request(3, { type: 'confirm-task', taskId: task.id });
  await f.service().command(confirmation, signal());
  await f.service().command(confirmation, signal());
  const plan = f.workbench.snapshot().appliedPlans[0];
  assert.equal(f.workbench.snapshot().appliedPlans.length, 1);
  assert.deepEqual(
    plan.participants.find((p) => p.id === pack.id),
    catalog.experts[0],
  );
  assert.deepEqual(plan.assets, catalog.assets);
  assert.deepEqual(createNodeHandoffs(plan)[0].skillRefs, [
    { id: 'work-planning', version: plan.id },
  ]);
});

for (const kind of ['skill', 'mcp']) {
  test(`member required expert resources contract: ${kind} on another node cannot satisfy this executor`, async () => {
    const catalog = catalogFixture();
    catalog.experts[0].resourceBindings = {
      skillIds: ['authorized-skill'],
      mcpIds: ['authorized-mcp'],
    };
    const f = setup({ service: { catalog: async () => catalog } });
    const task = catalogTask();
    const key = kind === 'skill' ? 'skillIds' : 'mcpIds';
    task.workflows[0].nodes[0][key] = [];
    task.workflows[0].nodes.push(node('other', { [key]: [`authorized-${kind}`] }));
    await f.service().command(request(0, projectCommand()), signal());
    await f.service().command(request(1, { type: 'create-task', task }), signal());
    const before = f.workbench.snapshot();
    const intents = structuredClone([...f.intents]);
    const writes = f.writes;
    await assert.rejects(
      f.service().command(request(2, { type: 'confirm-task', taskId: task.id }), signal()),
      (error) =>
        error.code === 'resource-unavailable' && error.message.includes(`authorized-${kind}`),
    );
    assert.deepEqual(f.workbench.snapshot(), before);
    assert.deepEqual([...f.intents], intents);
    assert.equal(f.writes, writes);
  });
}

test('member required expert resources contract: invalid source retains the original fail-closed catalog gate', async () => {
  let catalog = catalogFixture();
  catalog.experts[0].resourceBindings = { skillIds: ['authorized-skill'], mcpIds: [] };
  const f = setup({ service: { catalog: async () => catalog } });
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task: catalogTask() }), signal());
  catalog = changedCatalog(catalog, 'skill', 'version');
  catalog.assets.find((a) => a.kind === 'skill').origin.missing = ['missing-source.md'];
  const before = f.workbench.snapshot();
  const intents = structuredClone([...f.intents]);
  const writes = f.writes;
  await assert.rejects(
    f.service().command(request(2, { type: 'confirm-task', taskId: 'task-one' }), signal()),
    rejected('unavailable'),
  );
  assert.deepEqual(f.workbench.snapshot(), before);
  assert.deepEqual([...f.intents], intents);
  assert.equal(f.writes, writes);
});

test('member required expert resources contract: human execution keeps reviewer dependencies separate and explicit extra resources unchanged', async () => {
  const catalog = catalogFixture();
  catalog.experts[0].resourceBindings = { skillIds: ['authorized-skill'], mcpIds: [] };
  const f = setup({ service: { catalog: async () => catalog } });
  const task = catalogTask();
  task.workflows[0].nodes = [
    node('human', { reviewRequired: true, reviewerIds: ['authorized-agent'] }),
    node('expert', {
      assigneeId: 'authorized-agent',
      skillIds: ['authorized-skill'],
      mcpIds: ['authorized-mcp'],
    }),
  ];
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task }), signal());
  await f.service().command(request(2, { type: 'confirm-task', taskId: task.id }), signal());
  const plan = f.workbench.snapshot().appliedPlans[0];
  const handoffs = createNodeHandoffs(plan);
  assert.deepEqual(handoffs[0].skillRefs, []);
  assert.deepEqual(handoffs[0].mcpRefs, []);
  assert.deepEqual(handoffs[1].skillRefs, [{ id: 'authorized-skill', version: plan.id }]);
  assert.deepEqual(handoffs[1].mcpRefs, [{ id: 'authorized-mcp', version: plan.id }]);
});

test('member required expert resources contract: legacy confirmed plans stay readable and cannot be rewritten', async () => {
  const catalog = catalogFixture();
  catalog.experts[0].resourceBindings = { skillIds: ['authorized-skill'], mcpIds: [] };
  const f = setup({ service: { catalog: async () => catalog } });
  const task = catalogTask();
  task.workflows[0].nodes[0].skillIds = [];
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task }), signal());
  // Existing legacy owner semantics are deliberately unchanged; this produces
  // the old confirmed definition without bypassing the member confirmation gate.
  await f.workbench.command(
    {
      requestId: 'legacy-confirm',
      expectedRevision: 2,
      command: {
        type: 'save-task',
        task: { ...f.workbench.snapshot().tasks[0], status: 'ready' },
      },
    },
    signal(),
  );
  const before = f.workbench.snapshot();
  const writes = f.writes;
  const view = await f.service().snapshot({ spaceId: 'north' });
  assert.deepEqual(view.state.appliedPlans[0], before.appliedPlans[0]);
  assert.deepEqual(view.state.appliedPlans[0].task.workflows[0].nodes[0].skillIds, []);
  await assert.rejects(
    f.service().command(request(3, { type: 'confirm-task', taskId: task.id }), signal()),
    rejected('confirmed-plan'),
  );
  assert.deepEqual(f.workbench.snapshot(), before);
  assert.equal(f.writes, writes);
});
