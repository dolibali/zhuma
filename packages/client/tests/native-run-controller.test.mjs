import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeRunController } from '../dist/run/controller.js';
import { createNativeRunApi, projectNativeRunMessages } from '../dist/run/api.js';

// Pure view/transport contracts: these fixtures do not establish Host authorization.
const target = {
  spaceId: 'north',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  title: 'Implement filtering',
};
const selection = {
  model: { provider: 'contract', model: 'configured', maxTokens: 4096 },
  executor: { kind: 'builtin' },
};
const available = { kind: 'available' };
const summary = {
  ...target,
  runId: 'run',
  generation: 1,
  segmentId: 'segment',
  nodeVersion: 2,
  runVersion: 1,
  status: 'running',
  dispatch: 'received',
  resources: 'held',
  acknowledged: false,
  stopPhase: 'none',
  native: { sessionId: 'native', agentId: 'native', status: 'idle' },
  sendCapabilities: { followup: available, steer: { kind: 'unavailable' }, queue: available },
};
const options = () => ({
  target,
  nodeVersion: 1,
  runVersion: 0,
  currentRunId: null,
  selection: null,
  models: {
    kind: 'ready',
    items: [{ id: 'configured', label: 'Configured', value: selection.model }],
  },
  experts: [
    { id: 'builtin', label: 'Builtin', description: 'Current task', value: selection.executor },
  ],
  resources: [],
  start: { kind: 'available', mode: 'begin' },
  tools: 'text-only',
});
function setup(overrides = {}) {
  const calls = [];
  const api = {
    async options() {
      calls.push('options');
      return options();
    },
    async read() {
      calls.push('read');
      return summary;
    },
    async history() {
      calls.push('history');
      return { messages: [], nextAfter: -1 };
    },
    async begin(input) {
      calls.push(['begin', input]);
    },
    async send(...args) {
      calls.push(['send', ...args]);
    },
    async stop(...args) {
      calls.push(['stop', ...args]);
    },
    ...overrides,
  };
  return { calls, api, controller: createNativeRunController(api, target) };
}

test('Run view contract: initial mount and repeated refresh only read, never select or begin implicitly', async () => {
  const h = setup();
  await h.controller.refresh();
  await h.controller.refresh();
  assert.deepEqual(h.calls, ['options', 'options']);
  assert.equal(h.controller.getSnapshot().view.selection, null);
  h.controller.select(selection);
  assert.deepEqual(h.controller.getSnapshot().view.selection, selection);
  await h.controller.start(selection);
  const input = h.calls.find((call) => Array.isArray(call))[1];
  assert.equal(input.spaceId, target.spaceId);
  assert.equal('actorId' in input, false);
  assert.equal(input.expectedNodeVersion, 1);
  assert.equal(input.expectedRunVersion, 0);
  assert.equal(input.mode, 'begin');
  h.controller.dispose();
});

test('Run view contract: uncertain same start retries identical durable IDs; no automatic second begin', async () => {
  let first;
  const h = setup({
    async begin(input) {
      if (!first) first = input;
      else assert.deepEqual(input, first);
      throw Error('Lost reply');
    },
  });
  await h.controller.refresh();
  await assert.rejects(h.controller.start(selection));
  await assert.rejects(h.controller.start(selection));
  assert.ok(first.requestId);
  assert.ok(first.newRunId);
  assert.ok(first.newSegmentId);
  assert.equal(h.calls.filter((call) => call === 'options').length, 1);
  h.controller.dispose();
});

test('Run view contract: saved selection and mode capabilities stay frozen; progress reads do not rediscover models', async () => {
  const h = setup({
    async options() {
      return {
        ...options(),
        currentRunId: 'run',
        selection,
        start: { kind: 'unavailable', message: 'Held' },
      };
    },
  });
  await h.controller.refresh();
  h.controller.select({
    ...selection,
    executor: { kind: 'plan-expert', ref: { id: 'other', version: 'plan' } },
  });
  assert.deepEqual(h.controller.getSnapshot().view.selection, selection);
  await assert.rejects(h.controller.send('test', 'steer'));
  await h.controller.refresh(false);
  assert.deepEqual(h.calls, ['read', 'history', 'read', 'history']);
  await h.controller.send('test', 'queue');
  assert.equal(h.calls.find((call) => Array.isArray(call))[3], 'queue');
  h.controller.dispose();
});

test('Run view contract: disposed account/controller cannot publish late reads or call a new API through stale handlers', async () => {
  const pending = Promise.withResolvers();
  const old = setup({ options: () => pending.promise });
  const read = old.controller.refresh();
  old.controller.dispose();
  const next = setup();
  await next.controller.refresh();
  pending.resolve(options());
  await read;
  assert.equal(old.controller.getSnapshot().view.kind, 'loading');
  await assert.rejects(old.controller.start(selection), { name: 'AbortError' });
  assert.deepEqual(next.calls, ['options']);
  next.controller.dispose();
});

test('Run transcript contract: known text/tool names only; no hidden system, unknown payload, path/argument dumps', () => {
  const messages = projectNativeRunMessages([
    { seq: 0, type: 'system/message', data: { private: 'SYSTEM_SECRET' } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Do work' }] } },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'PRIVATE_REASONING' },
            { type: 'text', text: 'Result' },
          ],
        },
      },
    },
    { seq: 3, type: 'tool/call', data: { name: 'read', arguments: 'PRIVATE_ARGUMENTS' } },
    { seq: 4, type: 'future/type', data: { secret: 'UNKNOWN_SECRET' } },
  ]);
  assert.deepEqual(
    messages.map((message) => message.text),
    ['Do work', 'Result', 'read'],
  );
  assert.equal(JSON.stringify(messages).includes('PRIVATE'), false);
});

const session = (accountId = 'chen') => ({
  ok: true,
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: 'peer',
  spaces: [{ id: 'north', kind: 'team', name: 'Team' }],
});
function transport(handler, hooks = {}) {
  const calls = [];
  const api = createNativeRunApi(
    async (url, init) => {
      calls.push(url);
      if (url === '/zhuma-id/session') return Response.json(session(hooks.accountId));
      const request = JSON.parse(init.body);
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.redirect, 'error');
      assert.equal(request.method, `zhuma-run/${url.split('/').at(-1)}`);
      assert.equal('actorId' in request.payload, false);
      return handler(request, init);
    },
    'chen',
    { spaceId: 'north', isCurrent: () => hooks.current !== false, onUnavailable: () => {} },
    () => (hooks.invalidated = true),
  );
  return { api, calls };
}
const reply = (request, value) =>
  Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } });
test('Run transport contract: options is the only initial endpoint and rejects crossed locator projections', async () => {
  const h = transport((request) => reply(request, options()));
  const read = await h.api.options(target, new AbortController().signal);
  assert.equal(read.selection, null);
  assert.deepEqual(h.calls, ['/zhuma-id/session', '/api/zhuma-run/options']);
  const crossed = transport((request) =>
    reply(request, { ...options(), target: { ...target, nodeId: 'other' } }),
  );
  await assert.rejects(crossed.api.options(target, new AbortController().signal), {
    code: 'validation',
  });
});

test('Run transport contract: account replacement blocks before operation, late401 cannot invalidate new view', async () => {
  const changed = transport(
    () => {
      throw Error('Must not dispatch');
    },
    { accountId: 'other' },
  );
  await assert.rejects(changed.api.options(target, new AbortController().signal), {
    code: 'unauthenticated',
  });
  assert.deepEqual(changed.calls, ['/zhuma-id/session']);
  const hooks = {};
  const late = transport(() => {
    hooks.current = false;
    return Response.json({}, { status: 401 });
  }, hooks);
  await assert.rejects(late.api.options(target, new AbortController().signal), {
    name: 'AbortError',
  });
  assert.equal(hooks.invalidated, undefined);
});

test('Run transport contract: stop carries actual generation/segment/versions and explicit space', async () => {
  const h = transport((request) => {
    assert.deepEqual(request.payload, {
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      runId: 'run',
      spaceId: 'north',
      generation: 1,
      segmentId: 'segment',
      requestId: 'stop-key',
      expectedNodeVersion: 2,
      expectedRunVersion: 1,
    });
    return reply(request, { ...target, runId: 'run', status: 'pending' });
  });
  await h.api.stop(summary, 'stop-key', new AbortController().signal);
});
