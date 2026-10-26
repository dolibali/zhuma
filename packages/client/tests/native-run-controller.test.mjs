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

function runningOptions(current = summary) {
  return {
    ...options(),
    currentRunId: current.runId,
    selection,
    start: { kind: 'unavailable', message: 'Held' },
  };
}
test('Run view contract: a deferred send cannot block independent Stop or clear its busy/identity on late success', async () => {
  const sent = Promise.withResolvers(),
    stopped = Promise.withResolvers();
  let read = summary,
    stops = 0,
    sendSignal,
    stopRun;
  const h = setup({
    options: async () => runningOptions(read),
    read: async () => read,
    send: async (_run, _text, _mode, _key, signal) => {
      sendSignal = signal;
      await sent.promise;
    },
    stop: async (run) => {
      stops++;
      stopRun = run;
      await stopped.promise;
    },
  });
  await h.controller.refresh();
  const sending = h.controller
    .send('Keep this unconfirmed input', 'followup')
    .catch((error) => error);
  assert.equal(h.controller.getSnapshot().busy, 'send');
  const stopping = h.controller.stop();
  assert.equal(stops, 1);
  assert.equal(sendSignal.aborted, true, 'only the client send wait is cancelled');
  assert.equal(stopRun.generation, summary.generation);
  assert.equal(stopRun.segmentId, summary.segmentId);
  assert.equal(stopRun.nodeVersion, summary.nodeVersion);
  assert.equal(stopRun.runVersion, summary.runVersion);
  await assert.rejects(h.controller.stop());
  await assert.rejects(h.controller.start(selection));
  await assert.rejects(h.controller.send('No second concurrent send', 'followup'));
  sent.resolve();
  assert.equal(
    (await sending).name,
    'AbortError',
    'late accepted send must not clear the UI draft',
  );
  assert.equal(h.controller.getSnapshot().busy, 'stop');
  assert.equal(h.controller.getSnapshot().view.actions.send.followup.kind, 'unavailable');
  read = { ...summary, stopPhase: 'requested' };
  stopped.resolve();
  await stopping;
  assert.equal(h.controller.getSnapshot().view.run.stopPhase, 'requested');
  assert.equal(
    h.controller.getSnapshot().view.run.resources,
    'held',
    'no fabricated stop settlement',
  );
  assert.equal(h.controller.getSnapshot().view.actions.send.followup.kind, 'unavailable');
  h.controller.dispose();
});

test('Run view contract: late failed send cannot clear uncertain Stop retry key or restore sending', async () => {
  const sent = Promise.withResolvers(),
    stopped = Promise.withResolvers();
  const keys = [];
  const h = setup({
    options: async () => runningOptions(),
    send: async () => sent.promise,
    stop: async (_run, key) => {
      keys.push(key);
      if (keys.length === 1) await stopped.promise;
      else throw Error('Unknown stop again');
    },
  });
  await h.controller.refresh();
  const sending = h.controller.send('Unconfirmed', 'queue').catch((error) => error);
  const stopping = h.controller.stop().catch((error) => error);
  stopped.reject(Error('Lost stop response'));
  await stopping;
  const before = h.controller.getSnapshot();
  sent.reject(Error('Late send response'));
  await sending;
  assert.equal(h.controller.getSnapshot().error, before.error);
  await h.controller.refresh();
  assert.equal(
    h.controller.getSnapshot().view.actions.send.queue.kind,
    'unavailable',
    'running read does not revoke an uncertain stop',
  );
  await assert.rejects(h.controller.send('Must wait', 'followup'));
  await assert.rejects(h.controller.stop());
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'send and stop retain separate idempotency slots');
  h.controller.dispose();
});

test('Run view contract: a fresh replacement Run survives late send and stop completions without another stale read', async () => {
  const sent = Promise.withResolvers(),
    stopped = Promise.withResolvers(),
    nextStopped = Promise.withResolvers();
  let read = summary,
    reads = 0,
    stops = 0;
  const h = setup({
    options: async () => runningOptions(read),
    read: async () => {
      reads++;
      return read;
    },
    send: async () => sent.promise,
    stop: async () => {
      stops++;
      await (stops === 1 ? stopped.promise : nextStopped.promise);
    },
  });
  await h.controller.refresh();
  const sending = h.controller.send('Old Run', 'followup').catch((error) => error);
  const stopping = h.controller.stop().catch((error) => error);
  read = { ...summary, runId: 'new-run', generation: 2, segmentId: 'new-segment' };
  await h.controller.refresh();
  assert.equal(
    h.controller.getSnapshot().busy,
    undefined,
    'old Stop does not block a verified replacement Run',
  );
  const nextStopping = h.controller.stop();
  assert.equal(stops, 2);
  const before = reads;
  sent.reject(Error('Old send'));
  await sending;
  assert.equal(h.controller.getSnapshot().busy, 'stop');
  stopped.resolve();
  assert.equal((await stopping).name, 'AbortError');
  assert.equal(h.controller.getSnapshot().view.run.runId, 'new-run');
  assert.equal(
    h.controller.getSnapshot().busy,
    'stop',
    'old Stop finally cannot remove a new Stop ticket',
  );
  assert.equal(h.controller.getSnapshot().error, undefined);
  assert.equal(reads, before, 'superseded command completions must not refresh over the new Run');
  nextStopped.resolve();
  await nextStopping;
  h.controller.dispose();
});

test('Run view contract: a deferred begin replaced by a fresh admitted Run cannot block its actual Stop', async () => {
  const begun = Promise.withResolvers(),
    stopped = Promise.withResolvers();
  let admitted = false,
    stops = 0,
    stoppedRun;
  const h = setup({
    options: async () => (admitted ? runningOptions() : options()),
    read: async () => ({ ...summary, acknowledged: true }),
    begin: async () => begun.promise,
    stop: async (run) => {
      stops++;
      stoppedRun = run;
      await stopped.promise;
    },
  });
  await h.controller.refresh();
  const starting = h.controller.start(selection).catch((error) => error);
  assert.equal(h.controller.getSnapshot().busy, 'start');
  await assert.rejects(
    h.controller.stop(),
    /Run view is not ready|Stop unavailable/,
    'without a verified current Run Stop remains refused',
  );
  admitted = true;
  await h.controller.refresh();
  assert.equal(h.controller.getSnapshot().view.run.runId, summary.runId);
  const stopping = h.controller.stop();
  assert.equal(stops, 1, 'old begin response wait must not block a fresh actual Run Stop');
  assert.equal(stoppedRun.generation, summary.generation);
  assert.equal(stoppedRun.segmentId, summary.segmentId);
  await assert.rejects(h.controller.stop());
  begun.resolve();
  assert.equal((await starting).name, 'AbortError');
  assert.equal(h.controller.getSnapshot().busy, 'stop');
  stopped.resolve();
  await stopping;
  h.controller.dispose();
});

test('Run view contract: stale same-kind send cannot block new Run sending or clear the new ticket/key', async () => {
  const oldReply = Promise.withResolvers(),
    nextReply = Promise.withResolvers();
  let read = summary;
  const requests = [];
  const h = setup({
    options: async () => runningOptions(read),
    read: async () => read,
    send: async (run, text, mode, key) => {
      requests.push({ runId: run.runId, text, mode, key });
      if (requests.length === 1) await oldReply.promise;
      else if (requests.length === 2) await nextReply.promise;
    },
  });
  await h.controller.refresh();
  const oldSend = h.controller.send('Old input', 'followup').catch((error) => error);
  read = { ...summary, runId: 'new-run', generation: 2, segmentId: 'new-segment' };
  await h.controller.refresh();
  const nextSend = h.controller.send('New input', 'followup').catch((error) => error);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].runId, 'new-run');
  await assert.rejects(h.controller.send('Duplicate current send', 'followup'));
  oldReply.resolve();
  assert.equal((await oldSend).name, 'AbortError');
  assert.equal(
    h.controller.getSnapshot().busy,
    'send',
    'old finally must not clear the current same-kind ticket',
  );
  nextReply.reject(Error('Unknown new send response'));
  await nextSend;
  await h.controller.send('New input', 'followup');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].key, requests[2].key);
  assert.notEqual(requests[0].key, requests[1].key);
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
    {
      seq: 1,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Do work' }],
      },
    },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'contract', model: 'model' },
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

test('Run transcript contract: SDK source provenance hides injected user-role context without filtering human wording', () => {
  const text = 'Current runtime context: explain how this setting works.';
  const user = (seq, source, role = 'user') => ({
    seq,
    type: 'user/message',
    surfaceOp: 'append',
    data: { role, source, content: [{ type: 'text', text }] },
  });
  const events = [
    user(0, {
      kind: 'runtime-context',
      form: 'snapshot',
      sections: [{ name: 'execution', text: 'PRIVATE_EXECUTION_CONFIGURATION' }],
    }),
    user(1, { kind: 'runtime-context' }),
    user(2, { kind: 'instructions', form: 'instructions' }),
    user(3, { kind: 'catalog', form: 'catalog' }),
    user(4, { kind: 'future-producer' }),
    user(5, undefined),
    user(6, { kind: 'user' }, 'developer'),
    user(7, { kind: 'model' }),
    user(8, { kind: 'user' }),
    {
      seq: 9,
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'contract', model: 'model' },
          content: [{ type: 'text', text }],
        },
        replayState: { internal: 'PRIVATE_REPLAY_STATE' },
      },
    },
    {
      seq: 10,
      type: 'tool/result',
      data: { content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }] },
    },
    {
      seq: 11,
      type: 'tool/call',
      data: { name: 'read_file', arguments: { path: 'PRIVATE_TOOL_PATH' } },
    },
    { ...user(12, { kind: 'user' }), surfaceOp: 'replace' },
  ];
  assert.deepEqual(projectNativeRunMessages(events), [
    { id: 'event-8', sequence: 8, role: 'user', text },
    { id: 'event-9', sequence: 9, role: 'assistant', text },
    { id: 'event-11', sequence: 11, role: 'tool', label: '工具调用', text: 'read_file' },
  ]);
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
