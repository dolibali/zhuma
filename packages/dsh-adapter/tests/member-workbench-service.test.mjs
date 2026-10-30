import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { emptyWorkbench } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import {
  setup,
  request,
  signal,
  projectCommand,
  taskInput,
  node,
  rejected,
  deferred,
} from './member-workbench-fixture.mjs';

async function seeded(options) {
  const f = setup(options);
  await f.service().command(request(0, projectCommand()), signal());
  await f.service().command(request(1, { type: 'create-task', task: taskInput() }), signal());
  return f;
}

test('member snapshot contract: asset authority leaf never leaks same-team/private/foreign drafts or attachment handles', async () => {
  const state = emptyWorkbench();
  state.memberAssets = ['north', 'south', 'personal-ann'].map((spaceId) => ({
    schemaVersion: 1,
    spaceId,
    assetId: randomUUID(),
    kind: 'file',
    ownerId: 'ann',
    maintainerIds: ['ann'],
    version: 1,
    draft: {
      definition: {
        kind: 'file',
        name: 'PRIVATE-ASSET-CANARY',
        description: 'PRIVATE-CONTENT-CANARY',
      },
      dependencies: [],
      blob: {
        attachmentId: 'PRIVATE-ATTACHMENT-CANARY',
        name: 'private.txt',
        mediaType: 'text/plain',
        byteSize: 1,
        sha256: 'a'.repeat(64),
      },
    },
    published: [],
    uploads: [],
    receipts: [
      {
        idempotencyKey: randomUUID(),
        fingerprint: 'b'.repeat(64),
        operation: 'create-draft',
        resultVersion: 1,
      },
    ],
  }));
  const f = setup({ state });
  for (const [actor, spaceId] of [
    ['ann', 'north'],
    ['cy', 'south'],
    ['ann', 'personal-ann'],
  ]) {
    const view = await f.service(actor).snapshot({ spaceId });
    assert.equal(Object.hasOwn(view.state, 'memberAssets'), false);
    assert(!JSON.stringify(view).includes('PRIVATE-'));
  }
  await f.service().command(request(0, projectCommand()), signal());
  assert.deepEqual(f.storage.read().memberAssets, state.memberAssets);
  assert.equal(f.writes, 1);
});

test('member directory contract: four accounts, two teams, cross-team actor and genuine empty personal space', async () => {
  const f = await seeded();
  await f.service('dana').command(request(2, projectCommand('south-project'), 'south'), signal());
  await f.service('dana').command(
    request(
      3,
      {
        type: 'create-task',
        task: taskInput({
          id: 'south-task',
          projectId: 'south-project',
          ownerId: 'dana',
          participantIds: ['dana'],
          workflows: [
            {
              id: 'root',
              name: '南区',
              parentNodeId: null,
              nodes: [node('south-node', { assigneeId: 'dana' })],
            },
          ],
        }),
      },
      'south',
    ),
    signal(),
  );
  for (const [actor, space, tasks, members] of [
    ['ann', 'north', ['task-one'], ['ann', 'bob', 'cy']],
    ['bob', 'north', ['task-one'], ['ann', 'bob', 'cy']],
    ['cy', 'north', [], ['ann', 'bob', 'cy']],
    ['cy', 'south', [], ['cy', 'dana']],
    ['dana', 'south', ['south-task'], ['cy', 'dana']],
    ['ann', 'personal-ann', [], ['ann']],
  ]) {
    const view = await f.service(actor).snapshot({ spaceId: space });
    assert.equal(view.actorId, actor);
    assert.equal(view.spaceId, space);
    assert.deepEqual(
      view.state.tasks.map((t) => t.id),
      tasks,
    );
    assert.deepEqual(
      view.state.participants.map((p) => p.id),
      members,
    );
    assert.equal(view.state.participants[0].name, members[0]);
    assert.deepEqual(view.state.receipts, []);
    assert.equal(view.capabilities.resources, 'not-connected');
    assert.deepEqual(view.state.assets, []);
  }
  const empty = await f.service().snapshot({ spaceId: 'personal-ann' });
  assert.deepEqual(empty.state.projects, []);
  assert.equal(empty.capabilities.createTask, false);
});

test('member validation contract: explicit scope, actor injection and complete objects fail before writes', async () => {
  const f = setup();
  for (const bad of [
    {},
    { spaceId: 'north', actorId: 'dana' },
    { spaceId: 'unknown' },
    { spaceId: 'south' },
  ])
    await assert.rejects(f.service().snapshot(bad));
  for (const patch of [
    { actorId: 'dana' },
    { command: { ...projectCommand(), actorId: 'dana' } },
    { command: { type: 'save-participant', participant: {} } },
    { command: { type: 'create-project', project: { id: 'x', name: 'x' } } },
  ])
    await assert.rejects(
      f.service().command({ ...request(0, projectCommand()), ...patch }, signal()),
    );
  assert.equal(f.writes, 0);
  assert.equal(f.links.size, 0);
});

test('member scope contract: even a cross-team member cannot use a north task/project under south', async () => {
  const f = await seeded();
  await assert.rejects(
    f.service('cy').command(
      request(
        2,
        {
          type: 'update-project',
          project: { id: 'project-one', name: '错空间', description: '' },
        },
        'south',
      ),
      signal(),
    ),
    rejected('not-found'),
  );
  await assert.rejects(
    f.service('cy').command(
      request(
        2,
        {
          type: 'create-task',
          task: taskInput({ id: 'wrong', ownerId: 'cy', participantIds: ['cy'] }),
        },
        'south',
      ),
      signal(),
    ),
    rejected('not-found'),
  );
  const before = f.writes;
  await assert.rejects(
    f.service('cy').command(request(2, { type: 'confirm-task', taskId: 'task-one' }), signal()),
    rejected('not-found'),
  );
  await assert.rejects(
    f.service('bob').command(request(2, { type: 'update-task', task: taskInput() }), signal()),
    rejected('forbidden'),
  );
  assert.equal(f.writes, before);
});

test('member resources contract: legacy global expert, asset and human instructions do not become authorized', async () => {
  const state = emptyWorkbench();
  state.participants = [
    {
      id: 'legacy-expert',
      name: '旧专家',
      kind: 'expert',
      role: 'old',
      capabilities: [],
      instructions: 'PRIVATE_EXPERT',
      available: true,
    },
    {
      id: 'ann',
      name: 'legacy name',
      kind: 'human',
      role: 'PRIVATE_ROLE',
      capabilities: [],
      instructions: 'PRIVATE_INSTRUCTIONS',
      available: true,
    },
  ];
  state.assets = [
    {
      id: 'legacy-skill',
      name: '旧技能',
      kind: 'skill',
      description: '',
      content: 'PRIVATE_ASSET',
      available: true,
    },
  ];
  const f = await seeded({ state });
  const view = await f.service().snapshot({ spaceId: 'north' });
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|legacy-expert|legacy-skill/);
  for (const task of [
    taskInput({ id: 'bad-person', participantIds: ['ann', 'legacy-expert'] }),
    taskInput({
      id: 'bad-tool',
      workflows: [
        {
          id: 'root',
          name: '流程',
          parentNodeId: null,
          nodes: [node('bad', { skillIds: ['legacy-skill'] })],
        },
      ],
    }),
  ])
    await assert.rejects(
      f.service().command(request(2, { type: 'create-task', task }), signal()),
      rejected('resource-unavailable'),
    );
  assert.equal(f.writes, 2);
});

test('member command contract: same-body retry, divergent-key conflict, concurrent stale writer and cloned results', async () => {
  const f = setup();
  const input = request(0, projectCommand());
  const outcomes = await Promise.allSettled([
    f.service().command(input, signal()),
    f.service().command(request(0, projectCommand('other')), signal()),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].reason.code, 'conflict');
  const retry = await f.service().command(input, signal());
  assert.equal(retry.state.revision, 1);
  retry.state.projects[0].name = 'tampered';
  assert.notEqual(
    (await f.service().snapshot({ spaceId: 'north' })).state.projects[0].name,
    'tampered',
  );
  await assert.rejects(
    f.service().command(
      {
        ...input,
        command: { ...input.command, project: { ...input.command.project, name: 'different' } },
      },
      signal(),
    ),
    rejected('request-reused'),
  );
  assert.equal(f.writes, 1);
});

test('member create recovery contract: mapping persists first, failed Workbench is invisible, same request recovers after reopen', async () => {
  const f = setup();
  const input = request(0, projectCommand());
  f.failWrites(true);
  await assert.rejects(f.service().command(input, signal()), /disk failure/);
  assert.equal(f.links.get('project-one'), 'north');
  assert.equal(f.workbench.snapshot().revision, 0);
  assert.deepEqual((await f.service().snapshot({ spaceId: 'north' })).state.projects, []);
  f.reopen();
  f.failWrites(false);
  await f.service().command(input, signal());
  f.reopen();
  assert.equal((await f.service().command(input, signal())).state.revision, 1);
  assert.equal(f.writes, 1);
  assert.equal(f.links.size, 1);
});

test('member project recovery contract: same-space assignment conflict rereads, foreign race never overwrites', async () => {
  for (const winner of ['north', 'south']) {
    const f = setup();
    f.directory.assignProjectSpace = async (id) => {
      f.links.set(id, winner);
      throw Object.assign(Error('racing writer'), { code: 'conflict' });
    };
    if (winner === 'north') await f.service().command(request(0, projectCommand()), signal());
    else await assert.rejects(f.service().command(request(0, projectCommand()), signal()));
    assert.equal(f.links.get('project-one'), winner);
    assert.equal(f.writes, winner === 'north' ? 1 : 0);
  }
});

test('member project recovery contract: unknown/unavailable mapping after failed assign is not success', async () => {
  for (const reason of ['unknown', 'unavailable']) {
    const f = setup();
    f.directory.assignProjectSpace = async () => {
      throw Error('write failed');
    };
    let calls = 0;
    f.directory.spaceForProject = async () => ({
      ok: false,
      reason: ++calls === 1 ? 'unknown' : reason,
    });
    await assert.rejects(f.service().command(request(0, projectCommand()), signal()));
    assert.equal(f.writes, 0);
  }
});

test('member authorization contract: revoked participant, forged grant and expired session cannot write or replay', async () => {
  const f = await seeded();
  const command = request(2, { type: 'update-task', task: taskInput({ title: '更新' }) });
  await f.service().command(command, signal());
  f.grants.delete('north/ann');
  await assert.rejects(f.service().command(command, signal()), rejected('not-found'));
  await assert.rejects(
    f
      .service('ann', { resolve: async () => ({ ok: true, memberId: 'ann', spaceIds: ['north'] }) })
      .snapshot({ spaceId: 'north' }),
    rejected('not-found'),
  );
  f.sessions.delete('ann');
  await assert.rejects(f.service().command(command, signal()), rejected('unauthenticated'));
  assert.equal(f.writes, 3);
});

test('member cancellation contract: abort before queue and revocation during mapping leave no Workbench commit', async () => {
  const f = setup();
  await assert.rejects(f.service().command(request(0, projectCommand()), AbortSignal.abort()));
  assert.equal(f.links.size, 0);
  f.directory.assignProjectSpace = async (id, space) => {
    f.links.set(id, space);
    f.grants.delete('north/ann');
  };
  await assert.rejects(
    f.service().command(request(0, projectCommand()), signal()),
    rejected('not-found'),
  );
  assert.equal(f.writes, 0);
  assert.equal(f.workbench.snapshot().revision, 0);
});

test('member manual workflow contract: nested edits and confirmation preserve the existing child-task execution boundary', async () => {
  const f = await seeded();
  const edited = taskInput({
    workflows: [
      { id: 'root', name: '接口', parentNodeId: null, nodes: [node('parent')] },
      {
        id: 'child',
        name: '分解',
        parentNodeId: 'parent',
        nodes: [node('child-write', { assigneeId: 'bob' })],
      },
    ],
  });
  await f.service().command(request(2, { type: 'update-task', task: edited }), signal());
  assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
  const confirmation = request(3, { type: 'confirm-task', taskId: 'task-one' });
  const confirmed = await f.service().command(confirmation, signal());
  const applied = confirmed.state.appliedPlans[0];
  assert.equal(applied.task.status, 'ready');
  assert.equal(applied.sourceWorkbenchRevision, 3);
  assert.deepEqual(applied.task.workflows, edited.workflows);
  const nodes = new Map();
  const plans = new Map();
  const execution = new ExecutionService(
    {
      readNode: (key) => nodes.get(key),
      writeNode: async (key, value) => {
        nodes.set(key, structuredClone(value));
      },
      listNodes: () => [...nodes.values()],
      readPlan: (key) => plans.get(key),
      writePlan: async (key, value) => {
        plans.set(key, structuredClone(value));
      },
      listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
    },
    { readWorkbench: () => f.workbench.snapshot() },
    f.directory,
  );
  const caller = { member: { ok: true, memberId: 'ann', spaceIds: ['north'] } };
  const startable = await execution.startable(caller, { spaceId: 'north' });
  assert.equal(startable.ok, true);
  assert.deepEqual(
    startable.value.plans.map((p) => [p.planId, p.revision]),
    [[applied.id, applied.revision]],
  );
  assert.equal(nodes.size, 0);
  const started = await execution.startPlan(caller, {
    spaceId: 'north',
    taskId: 'task-one',
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: randomUUID(),
  });
  assert.equal(started.ok, false);
  assert.equal(started.error.code, 'child-task-required');
  assert.equal(nodes.size, 0);
  await f.service().command(confirmation, signal());
  await assert.rejects(
    f.service().command(request(4, { type: 'update-task', task: taskInput() }), signal()),
    rejected('confirmed-plan'),
  );
  assert.deepEqual(f.workbench.snapshot().appliedPlans[0], applied);
});

test('member manual workflow contract: required reviewer, self-review, missing delivery and incomplete owner reject confirmation', async () => {
  for (const patch of [
    { reviewRequired: true },
    { reviewRequired: true, reviewerIds: ['ann'] },
    { output: '' },
    { assigneeId: null },
  ]) {
    const f = await seeded();
    const edit = taskInput({
      workflows: [{ id: 'root', name: '流程', parentNodeId: null, nodes: [node('write', patch)] }],
    });
    if (patch.reviewerIds)
      await assert.rejects(
        f.service().command(request(2, { type: 'update-task', task: edit }), signal()),
      );
    else {
      await f.service().command(request(2, { type: 'update-task', task: edit }), signal());
      await assert.rejects(
        f.service().command(request(3, { type: 'confirm-task', taskId: edit.id }), signal()),
        rejected('validation'),
      );
    }
    assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
  }
});

test('member planning contract: no model is explicit and reads/commands never call generate', async () => {
  const f = await seeded();
  await assert.rejects(
    f.service().plan(
      {
        spaceId: 'north',
        requestId: randomUUID(),
        taskId: 'task-one',
        expectedRevision: 2,
        instruction: '',
      },
      signal(),
    ),
    rejected('model-unavailable'),
  );
  assert.equal(f.audits.size, 0);
  assert.equal(f.writes, 2);
});

const result = (task = taskInput()) =>
  JSON.stringify({
    summary: '按接口组织',
    questions: [],
    assumptions: [],
    workflows: task.workflows,
  });
test('member planning contract: authorized context only, repeat is idempotent and proposal is not applied', async () => {
  let calls = 0;
  const f = await seeded();
  const model = {
    name: 'contract-model',
    generate: async (_system, input) => {
      calls++;
      const { context } = JSON.parse(input);
      assert.deepEqual(
        context.participants.map((p) => p.id),
        ['ann', 'bob'],
      );
      assert.deepEqual(context.assets, []);
      assert.deepEqual(Object.keys(context.project).sort(), [
        'assetIds',
        'defaultParticipantIds',
        'description',
        'id',
        'name',
      ]);
      return result();
    },
  };
  const service = f.service('ann', { model: () => model });
  const input = {
    spaceId: 'north',
    requestId: randomUUID(),
    taskId: 'task-one',
    expectedRevision: 2,
    instruction: '按接口组织',
  };
  const proposal = await service.plan(input, signal());
  assert.equal(proposal.actorId, 'ann');
  assert.equal(proposal.spaceId, 'north');
  assert.deepEqual((await service.plan(input, signal())).proposal, proposal.proposal);
  assert.equal(calls, 1);
  assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
  assert.equal(f.writes, 2);
  await assert.rejects(
    service.plan({ ...input, instruction: 'changed' }, signal()),
    rejected('request-reused'),
  );
  await f
    .service()
    .command(request(2, { type: 'update-task', task: taskInput({ title: '新目标' }) }), signal());
  await assert.rejects(service.plan(input, signal()), rejected('conflict'));
});

test('member planning contract: revocation or changed revision during generation suppresses late proposals', async () => {
  for (const change of ['revoke', 'revision', 'cancel']) {
    const f = await seeded();
    const entered = deferred();
    const finish = deferred();
    const model = {
      name: 'held-model',
      generate: async () => {
        entered.resolve();
        await finish.promise;
        return result();
      },
    };
    const abort = new AbortController();
    const plan = f.service('ann', { model: () => model }).plan(
      {
        spaceId: 'north',
        requestId: randomUUID(),
        taskId: 'task-one',
        expectedRevision: 2,
        instruction: '',
      },
      abort.signal,
    );
    await entered.promise;
    if (change === 'revoke') f.grants.delete('north/ann');
    if (change === 'revision')
      await f
        .service()
        .command(
          request(2, { type: 'update-task', task: taskInput({ title: '新目标' }) }),
          signal(),
        );
    if (change === 'cancel') abort.abort();
    finish.resolve();
    await assert.rejects(plan);
    assert.equal(
      [...f.audits.values()].some((a) => a.status === 'completed'),
      false,
    );
    assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
  }
});

test('member manual workflow contract: flat confirmation is discovered and starts only through explicit existing startPlan', async () => {
  const f = await seeded();
  const confirmation = request(2, { type: 'confirm-task', taskId: 'task-one' });
  const confirmed = await f.service().command(confirmation, signal());
  const applied = confirmed.state.appliedPlans[0];
  const nodes = new Map();
  const plans = new Map();
  const execution = new ExecutionService(
    {
      readNode: (key) => nodes.get(key),
      writeNode: async (key, value) => {
        nodes.set(key, structuredClone(value));
      },
      listNodes: () => [...nodes.values()],
      readPlan: (key) => plans.get(key),
      writePlan: async (key, value) => {
        plans.set(key, structuredClone(value));
      },
      listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
    },
    { readWorkbench: () => f.workbench.snapshot() },
    f.directory,
  );
  const caller = { member: { ok: true, memberId: 'ann', spaceIds: ['north'] } };
  const available = await execution.startable(caller, { spaceId: 'north' });
  assert.equal(available.ok, true);
  assert.deepEqual(
    available.value.plans.map((p) => p.planId),
    [applied.id],
  );
  assert.equal(nodes.size, 0);
  const started = await execution.startPlan(caller, {
    spaceId: 'north',
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: randomUUID(),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(nodes.size, 1);
  assert.equal((await execution.startable(caller, { spaceId: 'north' })).value.plans.length, 0);
});

test('member confirmation contract: preserves legacy profile bytes but captures only authorized scoped participant definitions', async () => {
  const state = emptyWorkbench();
  state.participants = [
    {
      id: 'ann',
      name: 'Legacy Ann',
      kind: 'human',
      role: 'PRIVATE_ROLE',
      capabilities: [],
      instructions: 'PRIVATE_INSTRUCTIONS',
      available: true,
    },
  ];
  const f = await seeded({ state });
  const view = await f
    .service()
    .command(request(2, { type: 'confirm-task', taskId: 'task-one' }), signal());
  assert.equal(
    f.workbench.snapshot().participants.find((p) => p.id === 'ann').instructions,
    'PRIVATE_INSTRUCTIONS',
  );
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/);
  assert.equal(view.state.appliedPlans[0].participants.find((p) => p.id === 'ann').name, 'ann');
});

test('member resources contract: authorized empty catalog differs from missing; revoked frozen resource content is withheld', async () => {
  let granted = true;
  const expert = {
    id: 'authorized-agent',
    name: '接口 Agent',
    kind: 'expert',
    role: '接口分析',
    capabilities: ['API'],
    instructions: 'AUTHORIZED_EXPERT_BODY',
    available: true,
  };
  const asset = {
    id: 'authorized-skill',
    name: 'API',
    kind: 'skill',
    description: 'API 规范',
    content: 'AUTHORIZED_ASSET_BODY',
    available: true,
  };
  const f = await seeded({
    service: {
      catalog: async () =>
        granted ? { experts: [expert], assets: [asset] } : { experts: [], assets: [] },
    },
  });
  const task = taskInput({
    participantIds: ['ann', 'authorized-agent'],
    workflows: [
      {
        id: 'root',
        name: '流程',
        parentNodeId: null,
        nodes: [node('write', { assigneeId: expert.id, skillIds: [asset.id] })],
      },
    ],
  });
  await f.service().command(request(2, { type: 'update-task', task }), signal());
  const confirmed = await f
    .service()
    .command(request(3, { type: 'confirm-task', taskId: task.id }), signal());
  assert.equal(confirmed.capabilities.resources, 'authorized');
  assert.match(JSON.stringify(confirmed), /AUTHORIZED_ASSET_BODY/);
  granted = false;
  const revoked = await f.service().snapshot({ spaceId: 'north' });
  assert.equal(revoked.capabilities.resources, 'authorized');
  assert.deepEqual(revoked.state.assets, []);
  assert.doesNotMatch(JSON.stringify(revoked), /AUTHORIZED_(ASSET|EXPERT)_BODY/);
  assert.match(JSON.stringify(f.workbench.snapshot().appliedPlans), /AUTHORIZED_ASSET_BODY/);
});

test('member planning contract: cancellation frees the planning slot even if the old provider ignores abort', async () => {
  const f = await seeded();
  const entered = deferred();
  const finish = deferred();
  const model = {
    name: 'held',
    generate: async () => {
      entered.resolve();
      await finish.promise;
      return result();
    },
  };
  const service = f.service('ann', { model: () => model });
  const abort = new AbortController();
  const input = {
    spaceId: 'north',
    requestId: randomUUID(),
    taskId: 'task-one',
    expectedRevision: 2,
    instruction: '',
  };
  const pending = service.plan(input, abort.signal);
  await entered.promise;
  abort.abort();
  await assert.rejects(pending);
  const next = f.service('ann', {
    model: () => ({ name: 'ready', generate: async () => result() }),
  });
  assert.equal(
    (await next.plan({ ...input, requestId: randomUUID() }, signal())).proposal.model,
    'ready',
  );
  finish.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal([...f.audits.values()].filter((a) => a.status === 'completed').length, 1);
  assert.equal(f.workbench.snapshot().appliedPlans.length, 0);
});

test('member authorization contract: revocation during the last object lookup prevents durability and model dispatch', async () => {
  for (const action of ['command', 'plan']) {
    const f = await seeded();
    let calls = 0;
    const original = f.directory.spaceForProject;
    f.directory.spaceForProject = async (id) => {
      const lookup = await original(id);
      f.grants.delete('north/ann');
      return lookup;
    };
    if (action === 'command')
      await assert.rejects(
        f.service().command(request(2, { type: 'update-task', task: taskInput() }), signal()),
        rejected('not-found'),
      );
    else
      await assert.rejects(
        f
          .service('ann', {
            model: () => ({
              name: 'model',
              generate: async () => {
                calls++;
                return result();
              },
            }),
          })
          .plan(
            {
              spaceId: 'north',
              requestId: randomUUID(),
              taskId: 'task-one',
              expectedRevision: 2,
              instruction: '',
            },
            signal(),
          ),
        rejected('not-found'),
      );
    assert.equal(f.writes, 2);
    assert.equal(calls, 0);
  }
});

test('member snapshot contract: a membership/Workbench change during asynchronous directory scans cannot return stale task access', async () => {
  const f = await seeded();
  const entered = deferred();
  const release = deferred();
  const original = f.directory.spaceForProject;
  let first = true;
  f.directory.spaceForProject = async (id) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return original(id);
  };
  const snapshot = f.service('bob').snapshot({ spaceId: 'north' });
  await entered.promise;
  await f
    .service()
    .command(
      request(2, { type: 'update-task', task: taskInput({ participantIds: ['ann'] }) }),
      signal(),
    );
  release.resolve();
  await assert.rejects(snapshot, rejected('conflict'));
  assert.deepEqual((await f.service('bob').snapshot({ spaceId: 'north' })).state.tasks, []);
});

test('member planning authorization contract: changed catalog blocks cached/base proposals and late output without a Workbench revision change', async () => {
  for (const mode of ['cached', 'base', 'late']) {
    let assets = [
      {
        id: 'api-skill',
        name: 'API 规范',
        kind: 'skill',
        description: '',
        content: 'AUTHORIZED_V1',
        available: true,
      },
    ];
    const f = await seeded({ service: { catalog: async () => ({ experts: [], assets }) } });
    const entered = deferred();
    const finish = deferred();
    let calls = 0;
    const model = {
      name: 'model',
      generate: async () => {
        calls++;
        if (mode === 'late') {
          entered.resolve();
          await finish.promise;
        }
        return result();
      },
    };
    const service = f.service('ann', { model: () => model });
    const input = {
      spaceId: 'north',
      requestId: randomUUID(),
      taskId: 'task-one',
      expectedRevision: 2,
      instruction: 'API 规范',
    };
    if (mode === 'late') {
      const pending = service.plan(input, signal());
      await entered.promise;
      assets = [];
      finish.resolve();
      await assert.rejects(pending, rejected('context-changed'));
    } else {
      await service.plan(input, signal());
      assets = [];
      const changed =
        mode === 'cached'
          ? input
          : { ...input, requestId: randomUUID(), baseProposalId: input.requestId };
      await assert.rejects(service.plan(changed, signal()), rejected('context-changed'));
    }
    assert.equal(calls, 1);
    assert.equal(f.workbench.snapshot().revision, 2);
  }
});

test('member durability contract: cancellation after storage commits reports uncertain outcome and same ID safely recovers', async () => {
  const f = setup();
  const abort = new AbortController();
  const write = f.storage.write;
  f.storage.write = async (next) => {
    await write(next);
    abort.abort();
  };
  const input = request(0, projectCommand());
  await assert.rejects(f.service().command(input, abort.signal));
  assert.equal(f.workbench.snapshot().revision, 1);
  assert.equal((await f.service().command(input, signal())).state.revision, 1);
  assert.equal(f.writes, 1);
});
