import assert from 'node:assert/strict';
import test from 'node:test';
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
