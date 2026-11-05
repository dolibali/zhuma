import assert from 'node:assert/strict';
import test from 'node:test';
import { openWorkbench } from '../dist/workbench-plugin.js';
import { createPlanningModels } from '../dist/planning-model.js';
import { configureDeploymentMode } from '../dist/member-session.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import {
  setup,
  request,
  projectCommand,
  taskInput,
  signal,
  rejected,
  deferred,
} from './member-workbench-fixture.mjs';

function catalogHost(options = {}) {
  let selection = {
    provider: 'fixture-provider',
    model: 'fixture-current',
    ...(options.effort ? { reasoningEffort: options.effort } : {}),
  };
  let listed = [
    { provider: 'fixture-provider', id: 'fixture-current', name: 'Current' },
    { provider: 'fixture-provider', id: 'fixture-alternate', name: 'Alternate' },
  ];
  let listError;
  const prepared = [];
  const saves = [];
  const planText = options.planText ?? 'planned';
  const llm =
    options.llm === null
      ? undefined
      : {
          listProviders() {
            if (listError) throw listError;
            return [...new Set(listed.map((item) => item.provider))].map((id) => ({ id }));
          },
          async listModels(provider) {
            if (listError) throw listError;
            return listed.filter((item) => item.provider === provider);
          },
          async prepareCall(route) {
            prepared.push(structuredClone(route));
            return {
              config: { route },
              async *stream() {
                yield { type: 'text-delta', text: planText };
                yield { type: 'finish', reason: { kind: 'stop' } };
              },
            };
          },
        };
  const ctx = {
    llm,
    get(name) {
      return this[name];
    },
    agentDefaultModel: options.noDefault
      ? undefined
      : {
          currentSelection() {
            if (options.selectionError) throw new Error('selection-secret');
            return { ...selection };
          },
          async saveSelection(next) {
            saves.push(structuredClone(next));
            if (options.saveError) throw new Error('profile-secret');
            if (options.persist) {
              selection = {
                provider: next.provider,
                model: next.model,
                ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
              };
            }
          },
        },
  };
  return {
    ctx,
    prepared,
    saves,
    selection: () => ({ ...selection }),
    setListed(next) {
      listed = next;
    },
    failList(error) {
      listError = error;
    },
  };
}

const alternate = { provider: 'fixture-provider', model: 'fixture-alternate' };

test('planning catalog lists Host routes and the next plan uses the selected one', async () => {
  const host = catalogHost({ persist: true, effort: 'medium' });
  const models = createPlanningModels(host.ctx);
  const first = await models.catalog(signal());
  assert.equal(first.kind, 'ready');
  assert.equal(first.label, 'fixture-provider / fixture-current');
  assert.equal(first.items.length, 2);
  assert.equal(first.selectedId, first.items[0].id);
  host.setListed([
    { provider: 'fixture-provider', id: 'fixture-current', name: 'Current' },
    { provider: 'fixture-provider', id: 'fixture-alternate', name: 'Alternate' },
    { provider: 'fixture-provider', id: 'fixture-added', name: 'Added' },
  ]);
  const refreshed = await models.catalog(signal());
  assert.deepEqual(
    refreshed.items.map((item) => item.model),
    ['fixture-current', 'fixture-alternate', 'fixture-added'],
  );
  const selected = await models.select(alternate, signal());
  assert.equal(selected.label, 'fixture-provider / fixture-alternate');
  assert.equal(
    selected.selectedId,
    selected.items.find((item) => item.model === 'fixture-alternate').id,
  );
  assert.deepEqual(host.saves[0], alternate);
  assert.equal(host.selection().model, 'fixture-alternate');
  assert.equal(models.planningModel().name, 'fixture-provider / fixture-alternate');
  assert.equal(await models.planningModel().generate('system', 'input', signal()), 'planned');
  assert.equal(host.prepared[0].provider, 'fixture-provider');
  assert.equal(host.prepared[0].model, 'fixture-alternate');
  assert.equal(host.prepared[0].maxTokens, 12000);
  assert.equal('reasoningEffort' in host.prepared[0], false);
  assert.ok(!JSON.stringify(selected).includes('profile-secret'));
  assert.ok(!JSON.stringify(selected).includes('selection-secret'));
});

test('planning model switch stays on the catalog route when the shared default cannot be saved', async () => {
  const host = catalogHost({ saveError: true, effort: 'medium' });
  const models = createPlanningModels(host.ctx);
  const selected = await models.select(alternate, signal());
  assert.equal(selected.label, 'fixture-provider / fixture-alternate');
  assert.equal(host.selection().model, 'fixture-current');
  assert.equal(host.saves.length, 1);
  assert.equal(models.planningModel().name, selected.label);
  await models.planningModel().generate('system', 'input', signal());
  assert.equal(host.prepared[0].model, 'fixture-alternate');
  assert.equal(host.prepared[0].reasoningEffort, undefined);
});

test('planning model switch rejects routes outside the catalog and an unavailable catalog', async () => {
  const host = catalogHost();
  const models = createPlanningModels(host.ctx);
  await assert.rejects(
    models.select({ provider: 'fixture-provider', model: 'not-listed' }, signal()),
    rejected('model-unavailable'),
  );
  await assert.rejects(
    models.select(
      { provider: 'fixture-provider', model: 'fixture-alternate', extra: true },
      signal(),
    ),
    (error) => error instanceof Error && error.name === 'ZodError',
  );
  assert.equal(models.planningModel().name, 'fixture-provider / fixture-current');
  host.failList(new Error('gateway-secret'));
  const unavailable = await models.catalog(signal());
  assert.equal(unavailable.kind, 'unavailable');
  assert.equal(unavailable.items.length, 0);
  assert.equal(unavailable.label, 'fixture-provider / fixture-current');
  assert.match(unavailable.message, /刷新/);
  assert.ok(!unavailable.message.includes('gateway-secret'));
  await assert.rejects(models.select(alternate, signal()), rejected('model-unavailable'));
  assert.equal(models.planningModel().name, 'fixture-provider / fixture-current');
  host.failList(undefined);
  const restored = await models.catalog(signal());
  assert.equal(restored.kind, 'ready');
  assert.equal(restored.items.length, 2);
});

test('planning catalog without a default can still choose a listed route', async () => {
  const host = catalogHost({ noDefault: true });
  const models = createPlanningModels(host.ctx);
  assert.equal(models.planningModel(), undefined);
  const empty = await models.catalog(signal());
  assert.equal(empty.kind, 'ready');
  assert.equal(empty.label, '未配置模型');
  assert.equal(empty.selectedId, null);
  const selected = await models.select(alternate, signal());
  assert.equal(selected.label, 'fixture-provider / fixture-alternate');
  assert.equal(models.planningModel().name, selected.label);
});

test('planning catalog is empty when the Host has no configured routes', async () => {
  const host = catalogHost();
  host.setListed([]);
  const models = createPlanningModels(host.ctx);
  const catalog = await models.catalog(signal());
  assert.equal(catalog.kind, 'ready');
  assert.deepEqual(catalog.items, []);
  assert.equal(catalog.label, 'fixture-provider / fixture-current');
  await assert.rejects(models.select(alternate, signal()), rejected('model-unavailable'));
});

test('member planning switch updates snapshot readiness and the next plan route', async () => {
  const plan = JSON.stringify({
    summary: '按接口组织',
    questions: [],
    assumptions: [],
    workflows: taskInput().workflows,
  });
  const host = catalogHost({ planText: plan, persist: true });
  const models = createPlanningModels(host.ctx);
  const f = setup();
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task: taskInput() }), signal());
  const service = f.service('ann', {
    model: () => models.planningModel(),
    planningModels: models,
  });
  assert.equal(
    (await service.snapshot({ spaceId: 'north' })).model,
    'fixture-provider / fixture-current',
  );
  const listed = await service.planningModels({ spaceId: 'north' }, signal());
  assert.equal(listed.actorId, 'ann');
  assert.equal(listed.items.length, 2);
  const selected = await service.selectPlanningModel({ spaceId: 'north', ...alternate }, signal());
  assert.equal(selected.label, 'fixture-provider / fixture-alternate');
  assert.equal(host.saves.length, 0);
  assert.equal(host.selection().model, 'fixture-current');
  assert.equal(models.planningModel().name, 'fixture-provider / fixture-current');
  const after = await service.snapshot({ spaceId: 'north' });
  assert.equal(after.model, 'fixture-provider / fixture-alternate');
  assert.equal(after.capabilities.planning, true);
  assert.equal(after.capabilities.tasks.find((item) => item.taskId === 'task-one').plan, true);
  const proposal = await service.plan(
    {
      spaceId: 'north',
      requestId: crypto.randomUUID(),
      taskId: 'task-one',
      expectedRevision: 2,
      instruction: '按接口组织',
    },
    signal(),
  );
  assert.equal(proposal.proposal.taskId, 'task-one');
  assert.equal(host.prepared[0].model, 'fixture-alternate');
  assert.equal([...f.audits.values()][0].model, 'fixture-provider / fixture-alternate');
  await assert.rejects(
    f.service('dana').planningModels({ spaceId: 'north' }, signal()),
    rejected('not-found'),
  );
  await assert.rejects(
    f.service('ann', {}).selectPlanningModel({ spaceId: 'north', ...alternate }, signal()),
    rejected('model-unavailable'),
  );
});

test('opened workbench snapshot names the selected planning route', async () => {
  const host = catalogHost({ persist: true });
  const routes = new Map();
  const effects = [];
  let state = fixture().state;
  const ctx = {
    ...host.ctx,
    effect(callback) {
      effects.push(callback());
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
        },
      },
    },
    storageDomain: {
      async open(spec) {
        if (spec.name === 'zhuma_asset_packages') {
          return { close() {}, table: () => ({ get() {}, async put() {} }) };
        }
        return {
          close() {},
          global: {
            get: () => state,
            set: async (value) => {
              state = value;
            },
          },
          table: () => ({
            get() {},
            async put() {},
            keys: () => [],
            delete() {},
          }),
        };
      },
    },
  };
  configureDeploymentMode(ctx, 'legacy-single-user');
  const opened = await openWorkbench(ctx);
  const snapshot = async () => {
    const response = await routes.get('/api/zhuma/snapshot').fetch(
      new Request('http://localhost/api/zhuma/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'test',
          method: 'zhuma/snapshot',
          payload: {},
        }),
      }),
    );
    return (await response.json()).result.value.model;
  };
  assert.equal(await snapshot(), 'fixture-provider / fixture-current');
  await opened.planningModels.select(alternate, signal());
  assert.equal(await snapshot(), 'fixture-provider / fixture-alternate');
  assert.equal(opened.planningModel().name, 'fixture-provider / fixture-alternate');
  for (const dispose of effects) await dispose();
  assert.equal(opened.planningModel(), undefined);
  await assert.rejects(() => opened.planningModels.catalog(signal()), rejected('unavailable'));
});

const planText = JSON.stringify({
  summary: '按接口组织',
  questions: [],
  assumptions: [],
  workflows: taskInput().workflows,
});
const added = { provider: 'fixture-provider', model: 'fixture-added' };
function memberOptions(models) {
  return { model: () => models.planningModel(), planningModels: models };
}
async function preparedMember(host, models) {
  const f = setup();
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task: taskInput() }), signal());
  const options = memberOptions(models);
  return {
    f,
    ann: f.service('ann', options),
    bob: f.service('bob', options),
    host,
  };
}

test('member planning choices stay on that member while an in-flight plan keeps its route', async () => {
  const host = catalogHost({ planText, persist: true, effort: 'medium' });
  host.setListed([
    { provider: 'fixture-provider', id: 'fixture-current', name: 'Current' },
    { provider: 'fixture-provider', id: 'fixture-alternate', name: 'Alternate' },
    { provider: 'fixture-provider', id: 'fixture-added', name: 'Added' },
  ]);
  const started = deferred();
  const release = deferred();
  let hold = true;
  host.ctx.llm.prepareCall = async (route) => {
    host.prepared.push(structuredClone(route));
    return {
      config: { route },
      async *stream() {
        yield { type: 'text-delta', text: planText };
        if (hold) {
          hold = false;
          started.resolve();
          await release.promise;
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
  };
  const models = createPlanningModels(host.ctx);
  const { f, ann, bob } = await preparedMember(host, models);
  const pending = ann.plan(
    {
      spaceId: 'north',
      requestId: crypto.randomUUID(),
      taskId: 'task-one',
      expectedRevision: 2,
      instruction: '按接口组织',
    },
    signal(),
  );
  await started.promise;
  await ann.selectPlanningModel({ spaceId: 'north', ...alternate }, signal());
  assert.equal(host.prepared[0].model, 'fixture-current');
  assert.equal(host.prepared[0].reasoningEffort, 'medium');
  assert.equal(host.saves.length, 0);
  assert.equal(host.selection().model, 'fixture-current');
  assert.equal(models.planningModel().name, 'fixture-provider / fixture-current');
  assert.equal(
    (await bob.snapshot({ spaceId: 'north' })).model,
    'fixture-provider / fixture-current',
  );
  assert.equal(
    (await ann.snapshot({ spaceId: 'personal-ann' })).model,
    'fixture-provider / fixture-current',
  );
  assert.equal(
    (await bob.planningModels({ spaceId: 'north' }, signal())).label,
    'fixture-provider / fixture-current',
  );
  release.resolve();
  await pending;
  assert.equal([...f.audits.values()][0].model, 'fixture-provider / fixture-current');
  await ann.plan(
    {
      spaceId: 'north',
      requestId: crypto.randomUUID(),
      taskId: 'task-one',
      expectedRevision: 2,
      instruction: '按接口组织',
    },
    signal(),
  );
  assert.equal(host.prepared[1].model, 'fixture-alternate');
  assert.equal(host.prepared[1].reasoningEffort, undefined);
  assert.equal(
    (await ann.snapshot({ spaceId: 'north' })).model,
    'fixture-provider / fixture-alternate',
  );
  assert.equal(
    (await bob.snapshot({ spaceId: 'north' })).model,
    'fixture-provider / fixture-current',
  );
  await models.select(added, signal());
  assert.deepEqual(host.saves[0], added);
  assert.equal(host.selection().model, 'fixture-added');
  assert.equal(models.planningModel().name, 'fixture-provider / fixture-added');
  assert.equal(
    (await bob.snapshot({ spaceId: 'north' })).model,
    'fixture-provider / fixture-added',
  );
  assert.equal(
    (await ann.snapshot({ spaceId: 'north' })).model,
    'fixture-provider / fixture-alternate',
  );
});

test('revoked, aborted, and late member planning choices do not write', async () => {
  const host = catalogHost({ persist: true });
  host.setListed([
    { provider: 'fixture-provider', id: 'fixture-current', name: 'Current' },
    { provider: 'fixture-provider', id: 'fixture-alternate', name: 'Alternate' },
    { provider: 'fixture-provider', id: 'fixture-added', name: 'Added' },
  ]);
  const originalList = host.ctx.llm.listModels.bind(host.ctx.llm);
  const models = createPlanningModels(host.ctx);
  const { f, ann, bob } = await preparedMember(host, models);
  const scope = { actorId: 'ann', spaceId: 'north' };

  host.ctx.llm.listModels = async (provider) => {
    f.grants.delete('north/ann');
    return originalList(provider);
  };
  await assert.rejects(
    ann.selectPlanningModel({ spaceId: 'north', ...alternate }, signal()),
    rejected('not-found'),
  );
  assert.equal(host.saves.length, 0);
  assert.equal(models.modelFor(scope).name, 'fixture-provider / fixture-current');
  assert.equal(
    (await bob.snapshot({ spaceId: 'north' })).model,
    'fixture-provider / fixture-current',
  );
  f.grants.add('north/ann');
  host.ctx.llm.listModels = originalList;

  const controller = new AbortController();
  const paused = deferred();
  const entered = deferred();
  let waitForAbort = true;
  host.ctx.llm.listModels = async (provider) => {
    if (waitForAbort) {
      waitForAbort = false;
      entered.resolve();
      await paused.promise;
    }
    return originalList(provider);
  };
  const aborted = ann.selectPlanningModel({ spaceId: 'north', ...alternate }, controller.signal);
  await entered.promise;
  controller.abort();
  paused.resolve();
  await assert.rejects(aborted);
  assert.equal(host.saves.length, 0);
  assert.equal(models.modelFor(scope).name, 'fixture-provider / fixture-current');
  assert.equal(host.selection().model, 'fixture-current');

  const firstGate = deferred();
  const firstEntered = deferred();
  let pausedOnce = false;
  host.ctx.llm.listModels = async (provider) => {
    if (!pausedOnce) {
      pausedOnce = true;
      firstEntered.resolve();
      await firstGate.promise;
    }
    return originalList(provider);
  };
  const late = ann.selectPlanningModel({ spaceId: 'north', ...alternate }, signal());
  await firstEntered.promise;
  const winner = await ann.selectPlanningModel({ spaceId: 'north', ...added }, signal());
  firstGate.resolve();
  const stale = await late;
  assert.equal(winner.label, 'fixture-provider / fixture-added');
  assert.equal(stale.label, 'fixture-provider / fixture-added');
  assert.equal(host.saves.length, 0);
  assert.equal(host.selection().model, 'fixture-current');
  assert.equal(models.planningModel().name, 'fixture-provider / fixture-current');
  assert.equal(models.modelFor(scope).name, 'fixture-provider / fixture-added');
  assert.equal(
    (await bob.snapshot({ spaceId: 'north' })).model,
    'fixture-provider / fixture-current',
  );
  assert.equal(
    (await ann.snapshot({ spaceId: 'personal-ann' })).model,
    'fixture-provider / fixture-current',
  );
});
