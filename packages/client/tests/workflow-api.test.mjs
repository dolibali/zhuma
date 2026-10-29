import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRunApi } from '../dist/run/api.js';

const target = { taskId: 'task', planId: 'plan', revision: 1 };
const initial = () => ({
  target: { ...target, spaceId: 'north' },
  title: 'Scoped workflow',
  state: 'inactive',
  planStarted: false,
  requiresResume: false,
  activeRunCount: 0,
  expertNodeCount: 2,
  intent: null,
  selection: null,
});
const started = () => ({
  ...initial(),
  planStarted: true,
  state: 'running',
  intent: { intentId: 'intent', generation: 1, version: 1, concurrent: 2 },
  selection: {
    model: { provider: 'provider', model: 'model', maxTokens: 4096 },
    workspace: { kind: 'text-only' },
  },
});
const session = (accountId = 'chen') => ({
  ok: true,
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: 'peer',
  spaces: [{ id: 'north', kind: 'team', name: 'Team' }],
});
function transport(value = initial(), hooks = {}) {
  const calls = [];
  const api = createNativeRunApi(
    async (url, init) => {
      calls.push(url);
      if (url === '/zhuma-id/session') return Response.json(session(hooks.accountId));
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      const body = JSON.parse(init.body);
      assert.equal(body.method, `zhuma-workflow/${url.split('/').at(-1)}`);
      assert.equal(body.payload.spaceId, 'north');
      assert.equal('actorId' in body.payload, false);
      hooks.payload = body.payload;
      await hooks.hold?.();
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value },
      });
    },
    'chen',
    { spaceId: 'north', isCurrent: () => hooks.current !== false, onUnavailable() {} },
    () => {
      hooks.invalidated = true;
    },
  ).workflow;
  return { api, calls };
}
const signal = () => new AbortController().signal;
test('workflow publication wire: explicit start and Resume carry only selected relative ranges; ordinary Continue does not change defaults', async () => {
  const workspace = {
    kind: 'local',
    id: 'local-root',
    publish: [{ kind: 'directory', path: 'outputs' }],
  };
  const state = started();
  state.selection.workspace = workspace;
  const hooks = {},
    h = transport(state, hooks);
  const start = {
    ...target,
    requestId: 'start',
    model: state.selection.model,
    workspace,
    concurrent: 1,
  };
  assert.deepEqual((await h.api.start(start, signal())).selection.workspace, workspace);
  assert.deepEqual(hooks.payload.workspace, workspace);
  state.intent.generation = 2;
  const resume = {
    ...target,
    requestId: 'resume',
    intentId: 'intent',
    generation: 1,
    expectedVersion: 1,
  };
  await h.api.resume({ ...resume, workspace }, signal());
  assert.deepEqual(hooks.payload.workspace, workspace);
  assert.equal(
    'defaults' in hooks.payload,
    false,
    'Renderer never supplies remote capabilities or root grants',
  );
  state.intent.generation = 3;
  await h.api.resume({ ...resume, generation: 2 }, signal());
  assert.equal('workspace' in hooks.payload, false);
});

test('workflow publication wire: invalid relative paths and oversized scopes are rejected before transport', async () => {
  for (const publish of [
    [{ kind: 'directory', path: '../private' }],
    [{ kind: 'file', path: '/absolute' }],
    [{ kind: 'directory', path: '.' }],
    Array.from({ length: 16 }, (_, i) => ({ kind: 'file', path: `${i}${'x'.repeat(300)}` })),
  ]) {
    const h = transport(started());
    await assert.rejects(
      h.api.resume(
        {
          ...target,
          requestId: 'scope',
          intentId: 'intent',
          generation: 1,
          expectedVersion: 1,
          workspace: { kind: 'local', id: 'local-root', publish },
        },
        signal(),
      ),
    );
    assert.deepEqual(h.calls, []);
  }
});

test('workflow Client contract: passive read shares member Run fences and never starts a plan', async () => {
  const h = transport();
  assert.deepEqual(
    await h.api.read({ ...target, actorId: 'foreign', spaceId: 'foreign' }, signal()),
    initial(),
  );
  assert.deepEqual(h.calls, ['/zhuma-id/session', '/api/zhuma-workflow/read']);
});

test('workflow Client contract: member waiting facts preserve real control count, review availability and concurrency', async () => {
  const h = transport({
    ...started(),
    state: 'waiting',
    controlledNodeCount: 1,
    automaticReview: false,
    attention: '等待上游工作完成。',
    maxConcurrent: 1,
    models: { kind: 'ready', items: [] },
    workspaces: [],
  });
  const view = await h.api.options(target, signal());
  assert.equal(view.state, 'waiting');
  assert.equal(view.controlledNodeCount, 1);
  assert.equal(view.automaticReview, false);
  assert.equal(view.maxConcurrent, 1);
  assert.equal(view.attention, '等待上游工作完成。');
});
test('workflow Client contract: a changed account cannot send a workflow command', async () => {
  const hooks = { accountId: 'outside' },
    h = transport(initial(), hooks);
  await assert.rejects(h.api.read(target, signal()), (error) => error.code === 'unauthenticated');
  assert.equal(hooks.invalidated, true);
  assert.deepEqual(h.calls, ['/zhuma-id/session']);
});

test('workflow Client contract: rework limit is strictly decoded and only an explicit start sends the selected budget', async () => {
  const value = started();
  value.intent.automaticRevisions = 2;
  value.controlledReviewNodeCount = 1;
  value.revisions = [{ nodeId: 'node', used: 1, limit: 2 }];
  const hooks = {},
    h = transport(value, hooks);
  const input = {
    ...target,
    requestId: crypto.randomUUID(),
    model: value.selection.model,
    workspace: { kind: 'text-only' },
    concurrent: 1,
    automaticRevisions: 2,
  };
  const read = await h.api.start(input, signal());
  assert.equal(read.intent.automaticRevisions, 2);
  assert.equal(read.controlledReviewNodeCount, 1);
  assert.deepEqual(read.revisions, [{ nodeId: 'node', used: 1, limit: 2 }]);
  assert.equal(hooks.payload.automaticRevisions, 2);
  value.intent.generation = 2;
  await h.api.resume(
    {
      ...target,
      requestId: crypto.randomUUID(),
      intentId: value.intent.intentId,
      generation: 1,
      expectedVersion: 1,
    },
    signal(),
  );
  assert.equal('automaticRevisions' in hooks.payload, false);
  value.intent.automaticRevisions = 3;
  await assert.rejects(h.api.read(target, signal()), { code: 'validation' });
  value.intent.automaticRevisions = 2;
  for (const rows of [
    [{ nodeId: 'node', used: 3, limit: 2 }],
    [
      { nodeId: 'node', used: 1, limit: 2 },
      { nodeId: 'node', used: 0, limit: 2 },
    ],
    [{ nodeId: 'node', used: 0, limit: 1 }],
  ]) {
    value.revisions = rows;
    await assert.rejects(h.api.read(target, signal()), { code: 'validation' });
  }
});
test('workflow Client contract: an obsolete page cannot apply a late workflow receipt', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const hooks = {
      hold: async () => {
        entered.resolve();
        await release.promise;
      },
    },
    h = transport(initial(), hooks);
  const reading = h.api.read(target, signal());
  await entered.promise;
  hooks.current = false;
  release.resolve();
  await assert.rejects(reading, { name: 'AbortError' });
});
test('workflow Client contract: foreign plan and invalid control facts are rejected', async () => {
  for (const value of [
    { ...initial(), target: { ...initial().target, spaceId: 'foreign' } },
    { ...initial(), target: { ...initial().target, revision: 2 } },
    { ...initial(), state: 'running' },
    { ...initial(), planStarted: 'true' },
    { ...initial(), activeRunCount: -1 },
  ]) {
    await assert.rejects(
      transport(value).api.read(target, signal()),
      (error) => error.code === 'validation',
    );
  }
});
test('workflow Client contract: explicit start sends only public model/workspace choices', async () => {
  const hooks = {},
    h = transport(started(), hooks);
  const model = { provider: 'provider', model: 'model', maxTokens: 4096 };
  await h.api.start(
    {
      ...target,
      spaceId: 'foreign',
      actorId: 'foreign',
      requestId: 'start',
      model,
      workspace: { kind: 'local', id: 'project-files' },
      concurrent: 2,
      ticket: {},
      grantId: 'forged',
    },
    signal(),
  );
  assert.deepEqual(hooks.payload, {
    ...target,
    spaceId: 'north',
    requestId: 'start',
    model,
    workspace: { kind: 'local', id: 'project-files' },
    concurrent: 2,
  });
});
test('workflow Client contract: control replies cannot silently switch the intent or generation', async () => {
  const input = {
    ...target,
    requestId: 'control',
    intentId: 'intent',
    generation: 1,
    expectedVersion: 1,
  };
  for (const intent of [
    { ...started().intent, intentId: 'foreign' },
    { ...started().intent, generation: 2 },
  ]) {
    await assert.rejects(
      transport({ ...started(), intent }).api.stop(input, signal()),
      (error) => error.code === 'validation',
    );
  }
  await assert.rejects(
    transport(started()).api.resume(input, signal()),
    (error) => error.code === 'validation',
  );
  await assert.rejects(
    transport(initial()).api.start(
      {
        ...target,
        requestId: 'start',
        model: started().selection.model,
        workspace: { kind: 'text-only' },
        concurrent: 1,
      },
      signal(),
    ),
    (error) => error.code === 'validation',
  );
});
