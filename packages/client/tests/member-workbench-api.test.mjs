import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkbench, WorkbenchError } from '@zhuma/agent-core';
import { createMemberWorkbenchApi } from '../dist/index.js';

const space = { id: 'team-a', kind: 'team', name: '测试团队' };
const identity = (overrides = {}) => ({
  ok: true,
  accountId: 'chen',
  principal: { kind: 'zhuma-member', memberId: 'chen' },
  peerId: 'test-peer',
  spaces: [space],
  ...overrides,
});
function snapshot(overrides = {}) {
  return {
    actorId: 'chen',
    spaceId: space.id,
    space,
    state: emptyWorkbench(),
    model: null,
    capabilities: {
      createProject: false,
      createTask: false,
      planning: false,
      resources: 'not-connected',
      tasks: [],
    },
    ...overrides,
  };
}
function harness(handler, session = () => identity()) {
  const calls = [];
  const changes = { login: 0, space: 0, current: true };
  const scope = {
    actorId: 'chen',
    spaceId: space.id,
    isCurrent: () => changes.current,
    onUnauthenticated: () => ++changes.login,
    onUnavailable: () => ++changes.space,
  };
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === '/zhuma-id/session') return Response.json(await session());
    const envelope = JSON.parse(init.body);
    const result = await handler(envelope, init);
    return result instanceof Response
      ? result
      : Response.json({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: result },
        });
  };
  return { api: createMemberWorkbenchApi(scope, fetcher), scope, changes, calls };
}
const businessCalls = (h) => h.calls.filter(({ url }) => url.startsWith('/api/zhuma-member/'));

test('member template wire contract preserves exact bindings, source and retries without browser definitions', async () => {
  const bodies = [];
  const h = harness(({ payload }) => {
    bodies.push(payload);
    return snapshot();
  });
  const task = {
    id: crypto.randomUUID(),
    projectId: 'project-a',
    title: '方案',
    goal: '形成实施方案',
    participantIds: ['chen'],
    ownerId: 'chen',
  };
  const create = {
    requestId: crypto.randomUUID(),
    expectedRevision: 2,
    command: {
      type: 'instantiate-template',
      input: {
        templateId: 'zhuma-eng-design-to-plan',
        sourceSpaceId: 'personal-a',
        task,
        roleBindings: { designer: 'chen', reviewer: null },
        resourceBindings: { method: null },
      },
    },
  };
  await h.api.command(create);
  await h.api.command(create);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[0].command, create.command);
  const save = {
    type: 'save-template',
    input: {
      templateId: crypto.randomUUID(),
      sourceTaskId: task.id,
      name: '方案工作流',
      description: '',
    },
  };
  await h.api.command({ requestId: crypto.randomUUID(), expectedRevision: 3, command: save });
  assert.deepEqual(bodies[2].command, save);
  assert.equal('sourceSpaceId' in bodies[2].command.input, false);
  assert.equal('actorId' in bodies[2], false);
});

test('member template wire contract rejects owner payloads and unsaved definitions before transport', async () => {
  const h = harness(() => snapshot());
  const input = {
    templateId: crypto.randomUUID(),
    sourceTaskId: 'task-a',
    name: '模板',
    description: '',
  };
  const base = { requestId: crypto.randomUUID(), expectedRevision: 0 };
  for (const injected of [
    { content: '{}' },
    { actorId: 'other' },
    { memberTemplate: {} },
    { status: 'ready' },
    { sourceSpaceId: '' },
    { templateId: 'not-a-uuid' },
    { name: ' ' },
    { description: 'x'.repeat(8001) },
  ])
    await assert.rejects(
      h.api.command({
        ...base,
        command: { type: 'save-template', input: { ...input, ...injected } },
      }),
      { code: 'validation' },
    );
  const task = {
    id: crypto.randomUUID(),
    projectId: 'project-a',
    title: '方案',
    goal: '目标',
    participantIds: [],
    ownerId: null,
  };
  for (const injected of [
    { updatedAt: new Date().toISOString() },
    { workflows: [] },
    { templateSource: {} },
    { status: 'draft' },
  ])
    await assert.rejects(
      h.api.command({
        ...base,
        command: {
          type: 'instantiate-template',
          input: {
            templateId: 'template-a',
            task: { ...task, ...injected },
            roleBindings: {},
            resourceBindings: {},
          },
        },
      }),
      { code: 'validation' },
    );
  assert.equal(h.calls.length, 0);
});

test('member contract reads only its bound scope, with fresh identity and no model command', async () => {
  const h = harness((request) => {
    assert.equal(request.type, 'client-request');
    assert.equal(request.method, 'zhuma-member/snapshot');
    assert.deepEqual(request.payload, { spaceId: space.id });
    return snapshot();
  });
  const value = await h.api.snapshot();
  assert.equal(value.model, null);
  assert.equal(value.capabilities.resources, 'not-connected');
  await h.api.snapshot();
  assert.equal(h.calls.filter(({ url }) => url === '/zhuma-id/session').length, 2);
  assert.equal(businessCalls(h).length, 2);
  assert.equal(businessCalls(h)[0].init.credentials, 'same-origin');
  assert.equal(businessCalls(h)[0].init.cache, 'no-store');
  assert.equal(businessCalls(h)[0].init.redirect, 'error');
});

test('member contract preserves explicit create/confirm wire intent and the caller idempotency key', async () => {
  const bodies = [];
  const h = harness(({ method, payload }) => {
    assert.equal(method, 'zhuma-member/command');
    bodies.push(payload);
    return snapshot();
  });
  const requestId = crypto.randomUUID();
  const input = {
    requestId,
    expectedRevision: 3,
    command: {
      type: 'create-project',
      project: { id: 'project-a', name: '订单中心', description: '' },
    },
  };
  await h.api.command(input);
  await h.api.command(input);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].requestId, requestId);
  assert.equal(bodies[0].spaceId, space.id);
  assert.equal('actorId' in bodies[0], false);
  await h.api.command({
    requestId: crypto.randomUUID(),
    expectedRevision: 4,
    command: { type: 'confirm-task', taskId: 'task-a' },
  });
  assert.deepEqual(bodies[2].command, { type: 'confirm-task', taskId: 'task-a' });
});

test('member contract rejects injected actor/scope, old owner commands and ready task payloads before transport', async () => {
  const h = harness(() => snapshot());
  const base = {
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    command: { type: 'confirm-task', taskId: 'task-a' },
  };
  for (const input of [
    { ...base, actorId: 'other' },
    { ...base, spaceId: 'team-b' },
    { ...base, command: { type: 'save-task', task: {} } },
    { ...base, command: { type: 'create-task', task: { status: 'ready' } } },
    { ...base, command: { type: 'confirm-task', taskId: 'task-a', actorId: 'other' } },
  ])
    await assert.rejects(
      h.api.command(input),
      (error) => error instanceof WorkbenchError && error.code === 'validation',
    );
  assert.equal(h.calls.length, 0);
});

test('member contract closes a revoked space before sending a business request', async () => {
  const h = harness(
    () => snapshot(),
    () => identity({ spaces: [] }),
  );
  await assert.rejects(h.api.snapshot(), (error) => error.code === 'space-unavailable');
  assert.equal(businessCalls(h).length, 0);
  assert.equal(h.changes.space, 1);
});

test('member contract does not send a command under a different account', async () => {
  const h = harness(
    () => snapshot(),
    () => identity({ accountId: 'lin', principal: { kind: 'zhuma-member', memberId: 'lin' } }),
  );
  await assert.rejects(h.api.snapshot(), (error) => error.code === 'unauthenticated');
  assert.equal(businessCalls(h).length, 0);
  assert.equal(h.changes.login, 1);
});

for (const [field, value, code, counter] of [
  ['actorId', 'other', 'unauthenticated', 'login'],
  ['spaceId', 'team-b', 'space-unavailable', 'space'],
])
  test(`member contract refuses a mismatched response ${field}`, async () => {
    const h = harness(() => snapshot({ [field]: value }));
    await assert.rejects(h.api.snapshot(), (error) => error.code === code);
    assert.equal(h.changes[counter], 1);
  });

test('member contract distinguishes an authorized empty resource catalog', async () => {
  const h = harness(() =>
    snapshot({ capabilities: { ...snapshot().capabilities, resources: 'authorized' } }),
  );
  assert.equal((await h.api.snapshot()).capabilities.resources, 'authorized');
});

test('member contract rejects private receipts and unknown capability targets', async () => {
  const bad = [
    {
      ...snapshot(),
      state: {
        ...emptyWorkbench(),
        receipts: [{ id: 'private', revision: 1, fingerprint: 'private' }],
      },
    },
    {
      ...snapshot(),
      capabilities: {
        ...snapshot().capabilities,
        tasks: [{ taskId: 'hidden-task', edit: true, confirm: true, plan: true }],
      },
    },
  ];
  for (const reply of bad) {
    const h = harness(() => reply);
    await assert.rejects(h.api.snapshot(), (error) => error.code === 'invalid-response');
  }
});

test('member contract fences a late 401 after leaving the page', async () => {
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  const h = harness(async () => {
    entered.resolve();
    return response.promise;
  });
  const result = h.api.snapshot();
  await entered.promise;
  h.changes.current = false;
  response.resolve(new Response(null, { status: 401 }));
  await assert.rejects(result, (error) => error.name === 'AbortError');
  assert.equal(h.changes.login, 0);
  assert.equal(h.changes.space, 0);
});

test('member contract honors caller cancellation even if a late fetch ignores it', async () => {
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  const h = harness(async () => {
    entered.resolve();
    return response.promise;
  });
  const controller = new AbortController();
  const result = h.api.snapshot(controller.signal);
  await entered.promise;
  controller.abort();
  response.resolve(snapshot());
  await assert.rejects(result, (error) => error.name === 'AbortError');
  assert.equal(h.changes.login, 0);
});

test('member contract binds actor/space at construction instead of following a mutated object', async () => {
  const h = harness(() => snapshot());
  h.scope.actorId = 'other';
  h.scope.spaceId = 'team-b';
  await h.api.snapshot();
  assert.deepEqual(JSON.parse(businessCalls(h)[0].init.body).payload, { spaceId: space.id });
});

test('member contract sanitizes invalid JSON and ignores private non-success HTTP bodies', async () => {
  for (const reply of [
    new Response('private-provider-secret'),
    new Response('private-provider-secret', { status: 500 }),
  ]) {
    const h = harness(() => reply);
    await assert.rejects(
      h.api.snapshot(),
      (error) => error.code === 'unavailable' && !error.message.includes('private-provider'),
    );
  }
});

test('member contract binds a planning proposal to the requested task and saved revision', async () => {
  const input = {
    requestId: crypto.randomUUID(),
    taskId: 'task-a',
    expectedRevision: 3,
    instruction: '拆分接口与界面',
  };
  const proposal = {
    id: crypto.randomUUID(),
    taskId: input.taskId,
    baseRevision: 3,
    model: 'test-only',
    result: { summary: '规划草案', questions: [], assumptions: [], workflows: [] },
  };
  const h = harness((request) => {
    assert.equal(request.method, 'zhuma-member/plan');
    assert.deepEqual(request.payload, { spaceId: space.id, ...input });
    return { actorId: 'chen', spaceId: space.id, proposal };
  });
  assert.deepEqual((await h.api.plan(input)).proposal, proposal);
  const wrong = harness(() => ({
    actorId: 'chen',
    spaceId: space.id,
    proposal: { ...proposal, baseRevision: 2 },
  }));
  await assert.rejects(wrong.api.plan(input), (error) => error.code === 'invalid-response');
});
