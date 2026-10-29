import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  nodeRecordKey,
  startAppliedPlan,
  submitDelivery,
} from '@zhuma/agent-core';
import { EXECUTION_BODY_BYTE_LIMIT, apply, executionEndpoints } from '../dist/execution-plugin.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import {
  MEMBER_COOKIE_NAME,
  installMemberResolver,
  memberCredential,
} from '../dist/member-session.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function workflowNode(partial) {
  return {
    description: '',
    assigneeId: 'chen',
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
    input: '',
    output: '交付说明',
    rationale: '',
    position: { x: 0, y: 0 },
    ...partial,
  };
}

function confirmed() {
  const { state, task } = fixture();
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'qa', 'outside'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            workflowNode({ id: 'design', title: '设计' }),
            workflowNode({
              id: 'publish',
              title: '发布',
              assigneeId: 'outside',
              dependsOn: ['design'],
            }),
          ],
        },
      ],
      status: 'ready',
    },
  });
  return { state: ready, applied: ready.appliedPlans.at(-1) };
}

function signedChen(ctx) {
  const secret = randomBytes(32);
  const expiresAt = Date.now() + 60_000;
  const sessionId = randomUUID();
  installMemberResolver(ctx, {
    secret,
    requestRejection: () => undefined,
    findSession: (id) => (id === sessionId ? { accountId: 'chen', expiresAt } : undefined),
    spaceIdsFor: () => ['project'],
    singleUserAccountId: () => undefined,
    admitOwner: () => false,
  });
  return `${MEMBER_COOKIE_NAME}=${memberCredential(secret, sessionId, expiresAt)}`;
}

async function mount(options = {}) {
  const routes = [];
  const effects = [];
  const nodes = new Map(options.nodes ?? []);
  const plans = new Map(options.plans ?? []);
  const workspaceApprovals = new Map();
  let explode = '';
  let secret = false;
  const ctx = {
    fiber: { assertActive() {} },
    effect(callback) {
      effects.push(callback());
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route);
          return async () => {};
        },
      },
    },
    storageDomain: {
      async open(spec) {
        const files = new Map();
        const idempotency = new Map();
        if (spec.name === 'zhuma_files') {
          assert.equal(spec.version, 1);
          assert.deepEqual(Object.keys(spec.tables), ['files']);
          return {
            close() {},
            global: { get: () => spec.global.initial, set: async () => {} },
            table(name) {
              const table = name === 'files' ? files : idempotency;
              const schema = spec.tables[name].valueSchema;
              return {
                get: (key) => table.get(key),
                entries: () => table.entries(),
                size: table.size,
                async put(key, value) {
                  schema.parse(value);
                  table.set(key, structuredClone(value));
                },
                async delete(key) {
                  table.delete(key);
                },
              };
            },
          };
        }
        assert.equal(spec.name, 'zhuma_execution');
        assert.equal(spec.version, 1);
        assert.deepEqual(Object.keys(spec.tables), ['nodes', 'plans', 'workspace_approvals']);
        spec.global.schema.parse(spec.global.initial);
        return {
          close() {},
          global: { get: () => spec.global.initial, set: async () => {} },
          table(name) {
            const table = { nodes, plans, workspace_approvals: workspaceApprovals }[name];
            assert.ok(table, 'execution fixture must not alias unrelated tables');
            const schema = spec.tables[name].valueSchema;
            return {
              get: (key) => table.get(key),
              entries: () => {
                if (explode) throw new Error(explode);
                return table.entries();
              },
              async put(key, value) {
                schema.parse(value);
                table.set(key, structuredClone(value));
              },
            };
          },
        };
      },
    },
  };
  const cookie = signedChen(ctx);
  await apply(ctx, {
    publishRunService: options.publishRunService,
    readWorkbench() {
      if (secret) throw new Error('secret-provider-path');
      return options.workbench;
    },
    projectSpaces:
      options.projectSpaces ?? boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]),
  });
  return {
    routes,
    nodes,
    plans,
    effects,
    cookie,
    arm(message) {
      explode = message;
    },
    leak() {
      secret = true;
    },
    async call(endpoint, payload, extra = {}) {
      const route = routes.find((item) => item.path === `/api/zhuma-exec/${endpoint}`);
      assert.ok(route);
      const headers = { 'content-type': extra.type ?? 'application/json' };
      if (extra.cookie !== undefined) headers.cookie = extra.cookie;
      const body =
        extra.raw ??
        JSON.stringify({
          type: 'client-request',
          rpcId: 'plugin',
          method: extra.method ?? `zhuma-exec/${endpoint}`,
          payload,
        });
      const response = await route.fetch(
        new Request(`http://127.0.0.1:3080/api/zhuma-exec/${endpoint}`, {
          method: 'POST',
          headers,
          body,
        }),
      );
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? undefined : JSON.parse(text),
      };
    },
  };
}

test('the execution channel is an exact fetch route and hides storage failures', async () => {
  const { state, applied } = confirmed();
  const host = await mount({ workbench: state });
  assert.deepEqual(
    host.routes.map((route) => route.path),
    [
      ...executionEndpoints.map((endpoint) => `/api/zhuma-exec/${endpoint}`),
      '/api/zhuma-exec/upload-file',
      '/api/zhuma-exec/file',
    ],
  );
  assert.equal(executionEndpoints.includes('bind-owner'), false);
  assert.equal(
    host.routes.every((route) =>
      route.path.endsWith('/file')
        ? route.requestBody === 'buffered' && route.methods[0] === 'GET'
        : route.requestBody === 'streaming',
    ),
    true,
  );
  const anonymous = await host.call('inbox', {}, { cookie: undefined });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, 'unauthenticated');
  const malformed = await host.call('inbox', {}, { raw: '{', cookie: host.cookie });
  assert.equal(malformed.status, 400);
  const wrongMethod = await host.call('inbox', {}, { method: 'zhuma/inbox', cookie: host.cookie });
  assert.equal(wrongMethod.status, 400);
  const text = await host.call('inbox', {}, { type: 'text/plain', raw: '{}', cookie: host.cookie });
  assert.equal(text.status, 415);

  const started = await host.call(
    'start-plan',
    {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: 'start-1',
    },
    { cookie: host.cookie },
  );
  assert.equal(started.body.result.ok, true, JSON.stringify(started.body));
  assert.equal(
    started.body.result.value.reports.find((item) => item.nodeId === 'publish').status,
    'blocked',
  );
  host.arm('secret-disk-path');
  const failed = await host.call('inbox', {}, { cookie: host.cookie });
  assert.equal(failed.body.result.error.code, 'unavailable');
  assert.equal(JSON.stringify(failed).includes('secret-disk-path'), false);
  host.arm('');
  host.leak();
  const leaked = await host.call(
    'report',
    { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    { cookie: host.cookie },
  );
  assert.equal(leaked.body.result.error.code, 'unavailable');
  assert.equal(JSON.stringify(leaked).includes('secret-provider-path'), false);
  for (const dispose of host.effects) await dispose();
  const stopped = await host.call('inbox', {}, { cookie: host.cookie });
  assert.equal(stopped.body.result.error.code, 'cancelled');
});

test('one corrupt stored record does not stop the channel', async () => {
  const { state, applied } = confirmed();
  const started = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(started.ok, true);
  const records = started.records.map((record) => [nodeRecordKey(record), structuredClone(record)]);
  const design = records.find((entry) => entry[1].nodeId === 'design')[1];
  design.command = { ...design.command, status: 'completed' };
  design.acceptedArtifactVersionId = 'artifact-1';
  records.find((entry) => entry[1].nodeId === 'publish')[1].handoff = {};
  const host = await mount({
    workbench: state,
    nodes: records,
    plans: [
      [
        `${applied.taskId}:${applied.id}:${applied.revision}`,
        { idempotencyKey: 'start-1', fingerprint: 'kept', nodeIds: ['design', 'publish'] },
      ],
    ],
  });
  const inbox = await host.call('inbox', {}, { cookie: host.cookie });
  assert.equal(inbox.body.result.ok, true);
  const report = await host.call(
    'report',
    { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    { cookie: host.cookie },
  );
  assert.equal(report.body.result.ok, true);
  assert.equal(
    report.body.result.value.reports.some((item) => item.nodeId === 'design'),
    true,
  );
});

test('opening the channel finishes an unlock that was settled before its write', async () => {
  const { state, applied } = confirmed();
  const started = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(started.ok, true);
  const design = started.records.find((record) => record.nodeId === 'design');
  const submitted = submitDelivery({
    record: design,
    actorId: 'chen',
    idempotencyKey: 'deliver-1',
    expectedVersion: design.command.version,
    draft: { text: '接口说明', files: [], links: [] },
    artifactId: 'artifact:deliver-1',
    roundId: 'round:deliver-1',
  });
  assert.equal(submitted.record.command.status, 'completed');
  const records = started.records.map((record) =>
    record.nodeId === 'design' ? submitted.record : record,
  );
  const host = await mount({
    workbench: state,
    nodes: records.map((record) => [nodeRecordKey(record), record]),
  });
  const publish = [...host.nodes.values()].find((record) => record.nodeId === 'publish');
  assert.equal(publish.command.status, 'ready');
  assert.equal(publish.handoff.inputRefs[0].sourceNodeId, 'design');
});

const hiddenMessage = '有 1 个上游来源你没有权限查看。';
const doneCommand = { status: 'completed', version: 2, upstreamAffected: false, stored: [] };

function upstreamRecord(fields) {
  return {
    ownerId: 'chen',
    rounds: [],
    receipts: [],
    artifactVersions: [],
    comments: [],
    command: {
      status: 'ready',
      version: 1,
      entryStatus: 'ready',
      upstreamAffected: false,
      stored: [],
    },
    ...fields,
    handoff: {
      assignee: { id: 'chen', kind: 'human' },
      reviewerIds: ['qa'],
      dependencyNodeIds: [],
      goal: '发布',
      expectedOutput: '说明',
      inputRefs: [],
      reviewRequired: true,
      ...fields.handoff,
    },
  };
}

function upstreamSource(nodeId, taskId, planId, revision, acceptedId, extra = {}) {
  return upstreamRecord({
    taskId,
    planId,
    revision,
    nodeId,
    ...(acceptedId ? { command: doneCommand, acceptedArtifactVersionId: acceptedId } : {}),
    handoff: { assignee: { id: 'lin', kind: 'human' }, goal: extra.goal ?? nodeId },
    ...(acceptedId
      ? {
          artifactVersions: [
            {
              id: acceptedId,
              nodeId,
              version: extra.version ?? 2,
              text: extra.text ?? '',
              files: [],
              links: [],
              submittedBy: 'lin',
            },
          ],
        }
      : {}),
  });
}

function upstreamPublish(refs) {
  return upstreamRecord({
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node-2',
    handoff: { goal: '发布登录说明', inputRefs: refs },
  });
}

function upstreamTask(id, extra = {}) {
  return {
    id,
    projectId: 'project',
    ownerId: 'chen',
    participantIds: ['chen'],
    title: id,
    goal: id,
    workflows: [],
    status: 'ready',
    updatedAt: '2026-10-22T00:00:00.000Z',
    ...extra,
  };
}

async function upstreamHttp(records, extra = {}) {
  const { state } = fixture();
  for (const item of extra.tasks ?? []) state.tasks.push(item);
  const plans = new Map();
  for (const item of records) {
    const key = `${item.taskId}:${item.planId}:${item.revision}`;
    const prior = plans.get(key);
    plans.set(key, {
      idempotencyKey: item.taskId,
      fingerprint: item.planId,
      nodeIds: [...new Set([...(prior?.nodeIds ?? []), item.nodeId])],
    });
  }
  const opened = await mount({
    workbench: state,
    nodes: records.map((item) => [nodeRecordKey(item), item]),
    plans: [...plans],
    ...(extra.spaces ? { projectSpaces: boundedProjectSpaces(extra.spaces) } : {}),
  });
  const snap = () =>
    JSON.stringify({ nodes: [...opened.nodes.entries()], plans: [...opened.plans.entries()] });
  return {
    snap,
    async call(endpoint, payload) {
      return opened.call(endpoint, payload, { cookie: opened.cookie });
    },
  };
}

function upstreamInputs(response) {
  assert.equal(response.body.result.ok, true, JSON.stringify(response.body));
  return response.body.result.value.nodes.find((item) => item.nodeId === 'node-2').inputs;
}

async function upstreamBlocked(opened) {
  const before = opened.snap();
  const result = await opened.call('submit', {
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node-2',
    expectedVersion: 1,
    idempotencyKey: 'block-submit',
    text: '交付说明',
  });
  assert.equal(opened.snap(), before);
  assert.deepEqual(result.body.result.error, {
    code: 'upstream-blocked',
    message: hiddenMessage,
    details: {},
  });
  return result;
}

async function upstreamWrote(opened, key) {
  const before = opened.snap();
  const result = await opened.call('submit', {
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node-2',
    expectedVersion: 1,
    idempotencyKey: key,
    text: '交付说明',
  });
  assert.equal(result.body.result.ok, true, JSON.stringify(result.body));
  assert.notEqual(opened.snap(), before);
}

test('http inbox uses this plan when another task reuses the node id', async () => {
  const cited = 'artifact:idem-key-4e1';
  const opened = await upstreamHttp(
    [
      upstreamSource('node-1', 'task-peer-4e1', 'plan', 1, cited, {
        goal: '别的任务目标',
        version: 9,
        text: '别的正文',
      }),
      upstreamSource('node-1', 'task', 'plan', 2, cited, { goal: '另一版本目标', version: 8 }),
      upstreamSource('node-1', 'task', 'plan-other-4e1', 1, cited, {
        goal: '另一计划目标',
        version: 7,
      }),
      upstreamSource('node-1', 'task', 'plan', 1, cited, {
        goal: '本计划目标',
        text: '错误码说明',
      }),
      upstreamPublish([{ sourceNodeId: 'node-1', artifactVersionId: cited }]),
    ],
    { tasks: [upstreamTask('task-peer-4e1', { participantIds: ['chen', 'lin'] })] },
  );
  const inbox = await opened.call('inbox', {});
  assert.deepEqual(upstreamInputs(inbox), [
    {
      access: 'visible',
      blocking: false,
      sourceNodeId: 'node-1',
      artifactVersionId: cited,
      sourceGoal: '本计划目标',
      version: 2,
      name: '第 2 版',
    },
  ]);
  // The visible row carries its real pinned version id (artifact:idem-key-4e1)
  // so clients can read content; hidden/pending rows and other spaces never carry one.
  const nonVisible = JSON.stringify(
    upstreamInputs(inbox).filter((input) => input.access !== 'visible'),
  );
  assert.equal(nonVisible.includes('idem-key-4e1'), false);
  for (const secret of [
    '别的任务目标',
    '另一版本目标',
    '另一计划目标',
    'task-peer-4e1',
    'plan-other-4e1',
    '错误码说明',
  ]) {
    assert.equal(JSON.stringify(inbox.body).includes(secret), false, secret);
  }
  await upstreamWrote(opened, 'deliver-ok');
});

test('http counts a source in another task the caller belongs to and blocks the write', async () => {
  const opened = await upstreamHttp(
    [
      upstreamSource('node-1', 'task-peer-4e1', 'plan', 1, 'artifact:peer-key-4e1', {
        goal: 'peer-goal-4e1',
        text: 'peer-body-4e1',
      }),
      upstreamPublish([{ sourceNodeId: 'node-1', artifactVersionId: 'artifact:peer-key-4e1' }]),
    ],
    { tasks: [upstreamTask('task-peer-4e1', { participantIds: ['chen', 'lin'] })] },
  );
  const inbox = await opened.call('inbox', {});
  assert.deepEqual(upstreamInputs(inbox), [
    { access: 'hidden', blocking: true, count: 1, message: hiddenMessage },
  ]);
  assert.equal(JSON.stringify(inbox.body).includes('peer-key-4e1'), false);
  assert.equal(JSON.stringify(inbox.body).includes('task-peer-4e1'), false);
  const refused = await upstreamBlocked(opened);
  assert.equal(JSON.stringify(refused.body).includes('task'), false);
});

test('http missing and unreadable upstream bodies match byte for byte', async () => {
  const secrets = [
    'node-absent-4e1',
    'ver-absent-4e1',
    'node-sealed-4e1',
    'task-sealed-4e1',
    'space-sealed-4e1',
    'sealed-key-4e1',
  ];
  async function scenario(ref, extra) {
    const records = [upstreamPublish([ref])];
    if (extra) records.unshift(extra);
    const opened = await upstreamHttp(
      records,
      extra
        ? {
            tasks: [
              upstreamTask('task-sealed-4e1', {
                projectId: 'project-sealed-4e1',
                participantIds: ['lin'],
                ownerId: 'lin',
              }),
            ],
            spaces: [
              { projectId: 'project', spaceId: 'project' },
              { projectId: 'project-sealed-4e1', spaceId: 'space-sealed-4e1' },
            ],
          }
        : {},
    );
    const inbox = await opened.call('inbox', {});
    const refused = await upstreamBlocked(opened);
    for (const secret of secrets) {
      assert.equal(JSON.stringify(inbox.body).includes(secret), false, secret);
      assert.equal(JSON.stringify(refused.body).includes(secret), false, secret);
    }
    return {
      inbox: Buffer.from(JSON.stringify(inbox.body)),
      refused: Buffer.from(JSON.stringify(refused.body)),
    };
  }
  const missing = await scenario({
    sourceNodeId: 'node-absent-4e1',
    artifactVersionId: 'ver-absent-4e1',
  });
  const unreadable = await scenario(
    { sourceNodeId: 'node-sealed-4e1', artifactVersionId: 'artifact:sealed-key-4e1' },
    upstreamSource('node-sealed-4e1', 'task-sealed-4e1', 'plan', 1, 'artifact:sealed-key-4e1', {
      text: 'sealed-body-4e1',
    }),
  );
  assert.equal(Buffer.compare(missing.inbox, unreadable.inbox), 0);
  assert.equal(Buffer.compare(missing.refused, unreadable.refused), 0);
});

test('http names a source with no accepted version and still writes', async () => {
  const opened = await upstreamHttp([
    upstreamSource('node-3', 'task', 'plan', 1),
    upstreamPublish([{ sourceNodeId: 'node-3', artifactVersionId: 'artifact:old-key-4e1' }]),
  ]);
  const inbox = await opened.call('inbox', {});
  assert.deepEqual(upstreamInputs(inbox), [
    {
      access: 'pending',
      pending: 'none',
      blocking: false,
      sourceNodeId: 'node-3',
      message: '上游节点 node-3 尚无已接受版本。',
    },
  ]);
  assert.equal(JSON.stringify(inbox.body).includes('old-key-4e1'), false);
  await upstreamWrote(opened, 'deliver-none');
});

test('http names a replaced accepted version and still writes', async () => {
  const opened = await upstreamHttp([
    upstreamSource('node-4', 'task', 'plan', 1, 'artifact:new-key-4e1', { text: '新正文' }),
    upstreamPublish([{ sourceNodeId: 'node-4', artifactVersionId: 'artifact:old-key-4e1' }]),
  ]);
  const inbox = await opened.call('inbox', {});
  assert.deepEqual(upstreamInputs(inbox), [
    {
      access: 'pending',
      pending: 'replaced',
      blocking: false,
      sourceNodeId: 'node-4',
      message: '上游节点 node-4 已有新的已接受版本，当前引用的版本已被取代。',
    },
  ]);
  assert.equal(JSON.stringify(inbox.body).includes('new-key-4e1'), false);
  assert.equal(JSON.stringify(inbox.body).includes('新正文'), false);
  await upstreamWrote(opened, 'deliver-replaced');
});

test('http counts a corrupt record and does not leak its id', async () => {
  const opened = await upstreamHttp([
    {
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node-corrupt-4e1',
      ownerId: 'chen',
      command: { status: 'completed', version: 2 },
      rounds: [],
      acceptedArtifactVersionId: 'artifact:corrupt-key-4e1',
      handoff: { goal: 'corrupt-goal-4e1', assignee: { id: 'lin', kind: 'human' } },
      artifactVersions: [{ id: 'artifact:corrupt-key-4e1', version: 2, text: 'corrupt-body-4e1' }],
    },
    upstreamPublish([
      { sourceNodeId: 'node-corrupt-4e1', artifactVersionId: 'artifact:corrupt-key-4e1' },
    ]),
  ]);
  const inbox = await opened.call('inbox', {});
  assert.deepEqual(upstreamInputs(inbox), [
    { access: 'hidden', blocking: true, count: 1, message: hiddenMessage },
  ]);
  for (const secret of ['node-corrupt-4e1', 'corrupt-key-4e1', 'corrupt-body-4e1']) {
    assert.equal(JSON.stringify(inbox.body).includes(secret), false, secret);
  }
  await upstreamBlocked(opened);
});

function postStream(host, endpoint, { cookie, stream, headers = {}, signal } = {}) {
  const route = host.routes.find((item) => item.path === `/api/zhuma-exec/${endpoint}`);
  return route.fetch(
    new Request(`http://127.0.0.1:3080/api/zhuma-exec/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        ...headers,
      },
      body: stream,
      duplex: 'half',
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}

async function primedRequest(host, endpoint, { cookie, stream, headers = {}, signal } = {}) {
  const route = host.routes.find((item) => item.path === `/api/zhuma-exec/${endpoint}`);
  const request = new Request(`http://127.0.0.1:3080/api/zhuma-exec/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
    body: stream,
    duplex: 'half',
    ...(signal === undefined ? {} : { signal }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { request, fetch: () => route.fetch(request) };
}

test('an invalid session does not read the execution body', async () => {
  const host = await mount({ workbench: confirmed().state });
  let pulls = 0;
  const stream = new ReadableStream({
    pull() {
      pulls += 1;
      if (pulls > 1) throw new Error('handler read the body');
    },
  });
  const opened = await primedRequest(host, 'inbox', {
    cookie: 'zhuma-member=forged',
    stream,
  });
  const primed = pulls;
  const response = await opened.fetch();
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'unauthenticated' } });
  assert.equal(pulls, primed);
  assert.ok(primed >= 1);
});

test('a declared execution body over the transport cap is refused before it is read', async () => {
  const host = await mount({ workbench: confirmed().state });
  let pulls = 0;
  const stream = new ReadableStream({
    pull() {
      pulls += 1;
      if (pulls > 1) throw new Error('handler read the body');
    },
  });
  const opened = await primedRequest(host, 'inbox', {
    cookie: host.cookie,
    stream,
    headers: { 'content-length': String(EXECUTION_BODY_BYTE_LIMIT + 1) },
  });
  const primed = pulls;
  const response = await opened.fetch();
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'body-too-large' } });
  assert.equal(pulls, primed);
});

test('an execution body that grows past the transport cap is refused without waiting for the rest', async () => {
  const host = await mount({ workbench: confirmed().state });
  host.arm('should-not-run');
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 1) return new Promise(() => {});
      controller.enqueue(new Uint8Array(EXECUTION_BODY_BYTE_LIMIT + 1));
    },
  });
  const started = Date.now();
  const response = await postStream(host, 'inbox', { cookie: host.cookie, stream });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'body-too-large' } });
  assert.ok(Date.now() - started < 1000);
});

test(
  'an unfinished execution body stops at 5 seconds and does not run',
  { timeout: 15_000 },
  async () => {
    const { state } = confirmed();
    const host = await mount({ workbench: state });
    host.arm('should-not-run');
    const stream = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
    });
    const started = Date.now();
    const response = await postStream(host, 'inbox', { cookie: host.cookie, stream });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 408);
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'body-timeout' } });
    assert.ok(elapsed >= 4_500 && elapsed < 8_000, String(elapsed));
  },
);

function draftFile(partial) {
  return {
    id: 'file',
    mediaType: 'text/plain',
    byteSize: 1,
    checksum: 'sum',
    accessPolicyId: 'policy',
    uploadComplete: false,
    ...partial,
  };
}

async function readyDesign(key) {
  const { state, applied } = confirmed();
  const host = await mount({ workbench: state });
  const started = await host.call(
    'start-plan',
    {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: key,
    },
    { cookie: host.cookie },
  );
  assert.equal(started.status, 200);
  assert.equal(started.body.result.ok, true, JSON.stringify(started.body));
  const design = [...host.nodes.values()].find((record) => record.nodeId === 'design');
  return { host, applied, version: design.command.version };
}

function locate(applied, payload) {
  return {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    ...payload,
  };
}

test('70000 ascii characters pass for a draft and a submit', async () => {
  const text = 'a'.repeat(70_000);
  const { host, applied, version } = await readyDesign('start-ascii');
  const draft = await host.call(
    'draft',
    locate(applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-ascii',
      text,
      files: [],
      links: [],
    }),
    { cookie: host.cookie },
  );
  assert.equal(draft.status, 200);
  assert.equal(draft.body.result.ok, true, JSON.stringify(draft.body.result.error ?? draft.body));
  assert.equal(draft.body.result.value.text.length, 70_000);
  const submitted = await host.call(
    'submit',
    locate(applied, {
      expectedVersion: version,
      idempotencyKey: 'submit-ascii',
      text,
      files: [],
      links: [],
    }),
    { cookie: host.cookie },
  );
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.result.ok, true, JSON.stringify(submitted.body.result.error ?? {}));
});

test('30000 han characters pass for a draft and a submit', async () => {
  const text = '汉'.repeat(30_000);
  const { host, applied, version } = await readyDesign('start-han');
  const draft = await host.call(
    'draft',
    locate(applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-han',
      text,
      files: [],
      links: [],
    }),
    { cookie: host.cookie },
  );
  assert.equal(draft.status, 200);
  assert.equal(draft.body.result.ok, true, JSON.stringify(draft.body.result.error ?? {}));
  assert.equal(draft.body.result.value.text.length, 30_000);
  const submitted = await host.call(
    'submit',
    locate(applied, {
      expectedVersion: version,
      idempotencyKey: 'submit-han',
      text,
      files: [],
      links: [],
    }),
    { cookie: host.cookie },
  );
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.result.ok, true, JSON.stringify(submitted.body.result.error ?? {}));
});

test('a contract-maximum draft and submit pass the transport cap', async () => {
  const text = 't'.repeat(100_000);
  const full = 'd'.repeat(2048);
  const files = [
    ...Array.from({ length: 19 }, () =>
      draftFile({ id: full, mediaType: full, checksum: full, accessPolicyId: full }),
    ),
    draftFile({ id: full, mediaType: full, checksum: full, accessPolicyId: 'e'.repeat(352) }),
  ];
  const drafted = await readyDesign('start-max-draft');
  const draft = await drafted.host.call(
    'draft',
    locate(drafted.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-max',
      text,
      files,
      links: [],
    }),
    { cookie: drafted.host.cookie },
  );
  assert.equal(draft.status, 200);
  assert.equal(draft.body.result.ok, true, JSON.stringify(draft.body.result.error ?? {}));
  assert.equal(draft.body.result.value.text.length, 100_000);

  const submittedHost = await readyDesign('start-max-submit');
  const submitted = await submittedHost.host.call(
    'submit',
    locate(submittedHost.applied, {
      expectedVersion: submittedHost.version,
      idempotencyKey: 'submit-max',
      text,
      files: [],
      links: [],
    }),
    { cookie: submittedHost.host.cookie },
  );
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.result.ok, true, JSON.stringify(submitted.body.result.error ?? {}));
});

test('a declared body exactly at the transport cap is not refused as too large', async () => {
  const { state } = confirmed();
  const host = await mount({ workbench: state });
  const payload = JSON.stringify({
    type: 'client-request',
    rpcId: 'plugin',
    method: 'zhuma-exec/inbox',
    payload: {},
  });
  const response = await postStream(host, 'inbox', {
    cookie: host.cookie,
    headers: { 'content-length': String(EXECUTION_BODY_BYTE_LIMIT) },
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(payload));
        controller.close();
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.ok, true);
});

test('cancelling an execution body does not run the service', async () => {
  const host = await mount({ workbench: confirmed().state });
  host.arm('should-not-run');
  const controller = new AbortController();
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  });
  const pending = postStream(host, 'inbox', {
    cookie: host.cookie,
    stream,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.error.code, 'cancelled');
});

test('cancelling an execution body clears the read timer', async () => {
  const host = await mount({ workbench: confirmed().state });
  host.arm('should-not-run');
  const timeouts = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = timeouts();
  const controller = new AbortController();
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  });
  const pending = postStream(host, 'inbox', {
    cookie: host.cookie,
    stream,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.error.code, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts(), before);
});

// Transport contract only. Domain/lease/closed-round authorization is exercised
// against the actual Service/JSON in review-outcome.test.mjs.
test('review-outcome fetch preserves original cookie headers and exact query behind the existing member/envelope gate', async () => {
  const { state } = confirmed();
  const calls = [];
  const host = await mount({
    workbench: state,
    publishRunService(service) {
      service.readReviewOutcome = async (original, query) => {
        calls.push({ original, query });
        return { ok: true, value: { routeContract: 'review-outcome' } };
      };
    },
  });
  const query = {
    spaceId: 'project',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'design',
    roundId: 'round',
    artifactVersionId: 'fixed',
  };
  const anonymous = await host.call('review-outcome', query);
  assert.equal(anonymous.status, 401);
  const wrong = await host.call('review-outcome', query, {
    cookie: host.cookie,
    method: 'zhuma-exec/revision',
  });
  assert.equal(wrong.status, 400);
  assert.equal(calls.length, 0);
  const response = await host.call('review-outcome', query, { cookie: host.cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.result, { ok: true, value: { routeContract: 'review-outcome' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].original.headers.cookie, host.cookie);
  assert.deepEqual(calls[0].query, query);
  assert.equal('member' in calls[0].original, false);
});
