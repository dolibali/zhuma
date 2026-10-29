/** Original importer/core/queue and public package bytes. Memory storage/directory are contracts.
 * The separate artifact case below uses actual Host/member HTTP/JSON and no plan seed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionHandoff, emptyWorkbench } from '@zhuma/agent-core';
import { WorkbenchService } from '../dist/workbench-service.js';
import {
  openHostTeamCatalog,
  hostTeamCatalogManifest,
  hostTeamCatalogPin,
} from '../dist/host-team-catalog.js';
import { publicTeamStarterPackages } from '../../../scripts/lib/team-starter-packages.mjs';

const grants = [
  {
    spaceId: 'north',
    packs: [
      { id: 'zhuma-work-planning', version: '1.0.0' },
      { id: 'zhuma-interaction-review', version: '1.0.0' },
    ],
  },
];
async function setup() {
  const h = {
    state: emptyWorkbench(),
    packages: new Map(),
    calls: 0,
    writes: 0,
    fail: false,
    spaces: new Map([['north', { id: 'north', kind: 'team', name: 'Team' }]]),
  };
  const lifetime = new AbortController();
  const service = new WorkbenchService(
    {
      read: () => h.state,
      write: async (value) => {
        if (h.fail) throw Error('Synthetic catalog write failure');
        h.state = value;
        h.writes++;
      },
    },
    { get: () => undefined, put: async () => {} },
    {
      get: (id) => h.packages.get(id),
      put: async (value) => {
        h.packages.set(value.versionId, value);
      },
    },
  );
  const directory = { space: (id) => h.spaces.get(id) };
  const options = {
    grants,
    signal: lifetime.signal,
    directory: () => directory,
    readWorkbench: () => service.snapshot(),
    readPackage: (id) => h.packages.get(id),
    importPackage: (request) => {
      h.calls++;
      return service.command(request, lifetime.signal);
    },
    packages: await publicTeamStarterPackages(),
  };
  return Object.assign(h, { options, service, lifetime });
}

test('team catalog contract: exact public originals retain dependencies/licenses, explicit space scope and zero read initialization', async () => {
  const h = await setup();
  h.state.participants.push({
    id: 'private-expert',
    kind: 'expert',
    name: 'Private',
    role: '',
    capabilities: [],
    instructions: 'PRIVATE_LEGACY_BODY',
    available: true,
  });
  const catalog = await openHostTeamCatalog(h.options);
  const before = JSON.stringify(h.state);
  const value = await catalog('north');
  assert.deepEqual(
    value.experts.map((item) => item.id),
    ['zhuma-work-planning', 'zhuma-interaction-review'],
  );
  assert.deepEqual(
    value.assets.map((item) => item.id),
    ['work-planning', 'interaction-review'],
  );
  assert.equal(JSON.stringify(value).includes('PRIVATE_LEGACY_BODY'), false);
  assert.deepEqual(value.experts[0].resourceBindings.skillIds, ['work-planning']);
  assert.equal(value.experts[0].origin.sourceVersion, '1.0.0');
  for (const expert of value.experts) {
    assert(expert.origin.filePaths.includes('LICENSE.txt'));
    assert(
      h.packages.get(expert.origin.versionId).files.some((file) => file.path === 'LICENSE.txt'),
    );
  }
  assert.deepEqual(await catalog('south'), { experts: [], assets: [] });
  assert.equal(h.calls, 2);
  assert.equal(JSON.stringify(h.state), before);
  assert.deepEqual(h.state.appliedPlans, []);
  value.experts[0].instructions = 'Modified returned clone';
  assert.notEqual((await catalog('north')).experts[0].instructions, 'Modified returned clone');
  await openHostTeamCatalog(h.options);
  assert.equal(h.calls, 2, 'Reopen verifies fixed records without another command/revision');
});

test('team catalog contract: same-ID private content and immutable package conflicts are never overwritten', async () => {
  const h = await setup();
  h.state.participants.push({
    id: 'zhuma-work-planning',
    kind: 'expert',
    name: 'Custom',
    role: '',
    capabilities: [],
    instructions: 'Keep my custom definition',
    available: true,
  });
  const before = JSON.stringify(h.state);
  await assert.rejects(openHostTeamCatalog(h.options));
  assert.equal(JSON.stringify(h.state), before);
  assert.equal(h.calls, 0);
  const fresh = await setup();
  const version = fresh.options.packages.find(
    (item) => item.id === 'zhuma-work-planning',
  ).versionId;
  fresh.packages.set(version, { versionId: version, files: [], digest: '0'.repeat(64) });
  await assert.rejects(openHostTeamCatalog(fresh.options));
  assert.equal(fresh.calls, 0);
});

test('shared team defaults: fresh real teams reuse four fixed public packs, explicit selections win and reads never import', async () => {
  const h = await setup();
  const catalog = await openHostTeamCatalog({ ...h.options, defaultForTeams: true });
  assert.equal(h.calls, 4, 'Only startup imports original immutable records');
  assert.deepEqual(
    (await catalog('north')).experts.map((expert) => expert.id),
    grants[0].packs.map((pack) => pack.id),
    'An explicit selection is never concatenated with defaults',
  );
  assert.deepEqual(await catalog('new-team'), { experts: [], assets: [] });
  h.spaces.set('new-team', { id: 'new-team', kind: 'team', name: 'New team' });
  h.spaces.set('personal', { id: 'personal', kind: 'personal', name: 'Personal' });
  const before = JSON.stringify(h.state);
  const value = await catalog('new-team');
  assert.equal(value.experts.length, 4);
  assert.equal(value.assets.length, 4);
  for (const expert of value.experts) {
    assert(h.options.packages.some((pack) => pack.versionId === expert.origin.versionId));
    assert(h.packages.has(expert.origin.versionId));
    assert(expert.origin.filePaths.includes('LICENSE.txt'));
    assert.equal(expert.resourceBindings.skillIds.length, 1);
  }
  assert.deepEqual(await catalog('personal'), { experts: [], assets: [] });
  assert.equal(JSON.stringify(h.state), before);
  assert.equal(h.calls, 4);
  await openHostTeamCatalog({ ...h.options, defaultForTeams: true });
  assert.equal(h.calls, 4, 'Cold verification reuses immutable imports');
  h.spaces.delete('new-team');
  assert.deepEqual(await catalog('new-team'), { experts: [], assets: [] });
});

test('shared team defaults: empty initial directory gains teams without read writes and replaced owner fails closed', async () => {
  const h = await setup();
  h.spaces.clear();
  const options = { ...h.options, grants: [], defaultForTeams: true };
  const catalog = await openHostTeamCatalog(options);
  assert.equal(h.calls, 4);
  h.spaces.set('registered-team', { id: 'registered-team', kind: 'team', name: 'Registered' });
  assert.equal((await catalog('registered-team')).experts.length, 4);
  options.directory = () => ({ space: () => undefined });
  await assert.rejects(catalog('registered-team'));
  assert.equal(h.calls, 4);
});

test('shared team defaults: a conflicting unselected public ID never overwrites private content', async () => {
  const h = await setup();
  h.state.participants.push({
    id: 'zhuma-engineering-docs',
    kind: 'expert',
    name: 'Private expert',
    role: '',
    capabilities: [],
    instructions: 'PRIVATE_DEFINITION',
    available: true,
  });
  await assert.rejects(openHostTeamCatalog({ ...h.options, defaultForTeams: true }));
  assert.equal(
    h.state.participants.find((item) => item.id === 'zhuma-engineering-docs').instructions,
    'PRIVATE_DEFINITION',
  );
});

test('team catalog contract: immutable files before a failed global write can be explicitly retried once', async () => {
  const h = await setup();
  h.fail = true;
  await assert.rejects(openHostTeamCatalog(h.options));
  assert.equal(h.packages.size, 1);
  assert.equal(h.state.participants.length, 0);
  h.fail = false;
  const catalog = await openHostTeamCatalog(h.options);
  assert.equal((await catalog('north')).experts.length, 2);
  assert.equal(h.writes, 2);
  assert.equal(h.state.participants.length, 2);
});

test('team catalog contract: completed first-setup verification refuses missing definitions or packages without any import/write', async () => {
  for (const missing of ['definition', 'package']) {
    const h = await setup();
    await openHostTeamCatalog(h.options);
    const calls = h.calls,
      writes = h.writes;
    if (missing === 'definition') h.state.participants.shift();
    else h.packages.delete(h.state.participants[0].origin.versionId);
    await assert.rejects(openHostTeamCatalog({ ...h.options, initialize: false }));
    assert.equal(h.calls, calls);
    assert.equal(h.writes, writes);
  }
});

test('team catalog contract: unknown/duplicate grants, personal space, changed package and owner close fail closed', async () => {
  for (const mutate of [
    (h) => {
      h.options.grants = [...grants, ...grants];
    },
    (h) => {
      h.options.grants = [{ spaceId: 'north', packs: [{ id: 'unknown', version: '1.0.0' }] }];
    },
    (h) => {
      h.spaces.set('north', { id: 'north', kind: 'personal', name: 'Personal' });
    },
    (h) => {
      h.options.packages[0].files[0].data = 'invalid';
    },
  ]) {
    const h = await setup();
    mutate(h);
    await assert.rejects(openHostTeamCatalog(h.options));
    assert.equal(h.calls, 0);
  }
  const h = await setup(),
    catalog = await openHostTeamCatalog(h.options);
  const [key, value] = h.packages.entries().next().value;
  h.packages.set(key, { ...value, digest: '0'.repeat(64) });
  await assert.rejects(catalog('north'));
  h.packages.set(key, value);
  h.lifetime.abort();
  await assert.rejects(catalog('north'));
});

test('team catalog contract: public manifest and selection pin bind bytes/version and actual team selection without file bodies', async () => {
  const packages = await publicTeamStarterPackages();
  const manifest = hostTeamCatalogManifest(packages);
  assert.equal(manifest.length, 4);
  assert.equal('files' in manifest[0], false);
  const pin = hostTeamCatalogPin(grants, packages);
  assert.equal(
    pin,
    hostTeamCatalogPin([{ ...grants[0], packs: [...grants[0].packs].reverse() }], packages),
  );
  assert.notEqual(pin, hostTeamCatalogPin([{ ...grants[0], spaceId: 'south' }], packages));
  assert.notEqual(
    pin,
    hostTeamCatalogPin([{ ...grants[0], packs: [grants[0].packs[0]] }], packages),
  );
});

test('team catalog planning contract: original member planner receives selected public experts and their default Skills, never the legacy catalog', async () => {
  const { setup: memberSetup, taskInput } = await import('./member-workbench-fixture.mjs');
  const { WorkTaskSchema } = await import('@zhuma/agent-core');
  const h = await setup();
  const catalog = await openHostTeamCatalog(h.options);
  const task = WorkTaskSchema.parse(
    taskInput({
      title: '制定交互改进工作计划',
      participantIds: ['ann', 'zhuma-work-planning', 'zhuma-interaction-review'],
      status: 'draft',
      updatedAt: '2026-10-26T00:00:00.000Z',
    }),
  );
  let calls = 0;
  const f = memberSetup({
    state: {
      ...h.service.snapshot(),
      participants: [
        ...h.service.snapshot().participants,
        {
          id: 'private-legacy-expert',
          kind: 'expert',
          name: 'Private',
          role: '',
          capabilities: [],
          instructions: 'PRIVATE_LEGACY_BODY',
          available: true,
        },
      ],
      projects: [{ id: task.projectId, name: '交互改进', description: '' }],
      tasks: [task],
    },
    projectSpaces: [[task.projectId, 'north']],
    service: {
      catalog,
      model: () => ({
        name: 'explicit-planning-contract',
        generate: async (_system, input) => {
          calls++;
          const { context } = JSON.parse(input);
          assert.deepEqual(
            context.participants.map((item) => item.id),
            task.participantIds,
          );
          assert.deepEqual(context.assets.map((item) => item.id).sort(), [
            'interaction-review',
            'work-planning',
          ]);
          assert(
            context.participants
              .find((item) => item.id === 'zhuma-work-planning')
              .instructions.includes('优先使用本次允许参与的人'),
          );
          assert(
            context.assets.every((item) => item.selection === 'bound' && item.content.length > 0),
          );
          assert.equal(context.selection.executionAuthorization, 'unknown');
          assert.equal(input.includes('zhuma-engineering-docs'), false);
          assert.equal(input.includes('PRIVATE_LEGACY_BODY'), false);
          return JSON.stringify({
            summary: '契约草案',
            questions: [],
            assumptions: [],
            workflows: task.workflows,
          });
        },
      }),
    },
  });
  const proposal = await f.service().plan(
    {
      spaceId: 'north',
      requestId: (await import('node:crypto')).randomUUID(),
      taskId: task.id,
      expectedRevision: f.workbench.snapshot().revision,
      instruction: '按选定专家分工规划',
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(proposal.proposal.model, 'explicit-planning-contract');
  assert.deepEqual(proposal.proposal.result.workflows, task.workflows);
  assert.equal(f.writes, 0, 'A proposal must not apply a plan or change the draft');
  assert.deepEqual(f.workbench.snapshot().appliedPlans, []);
});

test(
  'Host team catalog artifact: normal member creates and confirms expert work without a seeded plan; a new process preserves fixed bytes',
  { skip: !process.env.S1A_HOST_MODULE, timeout: 30000 },
  async () => {
    const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    const { hashPassword } = await import('../dist/identity-session.js');
    const { startAcceptanceHost } = await import('./fixtures/m1-acceptance-harness.mjs');
    const home = await mkdtemp(join(tmpdir(), 'zhuma-public-team-artifact-'));
    const password = 'synthetic-team-member-password';
    const identityImport = {
      accounts: ['ann', 'outside'].map((id) => ({ id, passwordHash: hashPassword(password) })),
    };
    const config = {
      deploymentMode: 'multi-member',
      identityImport,
      spaceDirectoryImport: {
        spaces: [
          { id: 'north', kind: 'team', name: 'North' },
          { id: 'south', kind: 'team', name: 'South' },
        ],
        memberships: [
          { spaceId: 'north', accountId: 'ann' },
          { spaceId: 'south', accountId: 'outside' },
        ],
        projectSpaces: [],
      },
      teamCatalog: grants,
    };
    let host;
    const checked = (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.json.result.ok, true, JSON.stringify(response.json));
      return response.json.result.value;
    };
    const rpc = (endpoint, payload, cookie) =>
      host.post(
        `/api/zhuma-member/${endpoint}`,
        {
          type: 'client-request',
          rpcId: randomUUID(),
          method: `zhuma-member/${endpoint}`,
          payload,
        },
        `${host.ownerCookie}; ${cookie}`,
      );
    const stored = () => readFile(join(home, 'storages', 'zhuma_workbench.json'));
    try {
      host = await startAcceptanceHost(home, config);
      assert.equal(host.seeded, false);
      let cookie = await host.login('ann', password);
      let view = checked(await rpc('snapshot', { spaceId: 'north' }, cookie));
      assert.deepEqual(view.state.tasks, []);
      assert.deepEqual(view.state.appliedPlans, []);
      assert(view.state.participants.some((item) => item.id === 'zhuma-work-planning'));
      const outside = await host.login('outside', password);
      assert.equal((await rpc('snapshot', { spaceId: 'north' }, outside)).json.result.ok, false);
      assert.deepEqual(
        checked(await rpc('snapshot', { spaceId: 'south' }, outside)).state.participants.filter(
          (item) => item.kind === 'expert',
        ),
        [],
      );
      const command = async (action) => {
        view = checked(
          await rpc(
            'command',
            {
              spaceId: 'north',
              requestId: randomUUID(),
              expectedRevision: view.state.revision,
              command: action,
            },
            cookie,
          ),
        );
      };
      await command({
        type: 'create-project',
        project: { id: 'public-project', name: 'Public project', description: '' },
      });
      await command({
        type: 'create-task',
        task: {
          id: 'public-task',
          projectId: 'public-project',
          title: '制定交互改进计划',
          goal: '整理清晰的工作计划并独立评审',
          ownerId: 'ann',
          participantIds: ['ann', 'zhuma-work-planning', 'zhuma-interaction-review'],
          workflows: [
            {
              id: 'root',
              name: '主工作流',
              parentNodeId: null,
              nodes: [
                {
                  id: 'plan',
                  title: '制定计划',
                  description: '',
                  assigneeId: 'zhuma-work-planning',
                  reviewRequired: true,
                  reviewerIds: ['zhuma-interaction-review'],
                  dependsOn: [],
                  skillIds: ['work-planning'],
                  mcpIds: [],
                  input: '任务目标',
                  output: '工作计划',
                  rationale: '',
                  position: { x: 0, y: 0 },
                },
              ],
            },
          ],
        },
      });
      await command({ type: 'confirm-task', taskId: 'public-task' });
      const plan = view.state.appliedPlans[0];
      assert.equal(plan.task.workflows[0].nodes[0].assigneeId, 'zhuma-work-planning');
      assert.deepEqual(plan.task.workflows[0].nodes[0].skillIds, ['work-planning']);
      const handoff = createExecutionHandoff(
        { taskId: plan.task.id, planId: plan.id, revision: plan.revision },
        view.state,
      );
      assert.deepEqual(handoff.task.workflows[0].nodes[0].skillIds, ['work-planning']);
      assert.deepEqual(plan.assets.map((item) => item.id).sort(), [
        'interaction-review',
        'work-planning',
      ]);
      assert.equal(
        plan.participants.find((item) => item.id === 'zhuma-interaction-review').origin
          .sourceVersion,
        '1.0.0',
      );
      const before = await stored();
      const originalBound = host.boundModule;
      const oldPid = host.child.pid;
      await host.close();
      host = undefined;
      host = await startAcceptanceHost(home, {
        deploymentMode: 'multi-member',
        teamCatalog: grants,
      });
      assert.notEqual(host.child.pid, oldPid);
      assert.equal(host.seeded, false);
      cookie = await host.login('ann', password);
      const reopened = checked(await rpc('snapshot', { spaceId: 'north' }, cookie));
      assert.deepEqual(reopened.state.appliedPlans[0], plan);
      assert.deepEqual(
        await stored(),
        before,
        'Startup/read must not repeat imports or rewrite business facts',
      );
      assert.equal((await host.act('inspect')).modelCalls, 0);
      if (process.env.S1A_TEAM_CATALOG_PROOF_FILE)
        await writeFile(
          process.env.S1A_TEAM_CATALOG_PROOF_FILE,
          JSON.stringify(
            {
              passed: true,
              sourceHead: originalBound.sourceSha,
              hostSha256: originalBound.contentDigest,
              sameHostBytes: host.boundModule.contentDigest === originalBound.contentDigest,
              separateProcesses: host.child.pid !== oldPid,
              seededPlan: false,
              modelCalls: 0,
              scope:
                'Real emitted Host/member HTTP/Connection/JSON and cold reopen; synthetic credential/directory bootstrap only; no native execution, successful model generation or GUI claim.',
            },
            null,
            2,
          ) + '\n',
        );
    } finally {
      await host?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
