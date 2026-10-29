import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeRunController } from '../dist/run/controller.js';
import { createNativeRunApi, projectNativeRunMessages } from '../dist/run/api.js';
import { ExecutionError } from '../dist/execution/ExecutionApi.js';

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

test('Run knowledge selection is explicit, same-start frozen, and a foreign library cannot be sent', async () => {
  const h = setup({
    options: async () => ({
      ...options(),
      knowledgeLibraries: { kind: 'ready', items: [{ id: 'north', label: '研发知识' }] },
    }),
  });
  await h.controller.refresh();
  assert.equal(h.controller.getSnapshot().view.selection, null);
  await assert.rejects(
    h.controller.start({ ...selection, knowledge: { libraryId: 'foreign', allowDrafts: true } }),
    /library changed/,
  );
  assert.equal(h.calls.some(Array.isArray), false);
  await h.controller.start({ ...selection, knowledge: { libraryId: 'north', allowDrafts: false } });
  assert.deepEqual(h.calls.find(Array.isArray)[1].knowledge, {
    libraryId: 'north',
    allowDrafts: false,
  });
  h.controller.dispose();
});

test('Run view contract: a settled submitted read cannot reuse pre-settlement start capabilities', async () => {
  let completed = false;
  const h = setup({
    async options() {
      return {
        ...options(),
        currentRunId: summary.runId,
        selection,
        nodeVersion: summary.nodeVersion,
        runVersion: summary.runVersion,
        start: { kind: 'unavailable', message: '当前运行仍占用资源，请先停止并等待确认。' },
      };
    },
    async read() {
      return completed
        ? {
            ...summary,
            status: 'completed',
            resources: 'settled',
            nodeVersion: 4,
            runVersion: 4,
            resultDelivery: {
              kind: 'delivered',
              artifactVersionId: 'artifact',
              artifactVersion: 1,
              roundId: 'round',
              receipt: { idempotencyKey: 'delivery', version: 4 },
            },
            sendCapabilities: {
              followup: { kind: 'unavailable' },
              steer: { kind: 'unavailable' },
              queue: { kind: 'unavailable' },
            },
          }
        : summary;
    },
  });
  await h.controller.refresh();
  completed = true;
  await h.controller.refresh(false);
  const current = h.controller.getSnapshot().view;
  assert.equal(current.run.resources, 'settled');
  assert.deepEqual(current.actions.start, {
    kind: 'unavailable',
    message: '产物已提交，本轮会话只读。',
  });
  assert.equal(current.actions.stop.kind, 'unavailable');
  assert.deepEqual(h.calls, ['history', 'history']);
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

test('Run workspace contract: selection stays passive and explicit start sends only the authorized workspace ID', async () => {
  const choice = { id: 'project-files', label: 'Project', access: 'write', publish: true };
  const h = setup({
    async options() {
      return { ...options(), workspaces: [choice] };
    },
  });
  await h.controller.refresh();
  const next = { ...selection, workspace: { kind: 'local', id: choice.id } };
  h.controller.select(next);
  assert.equal(
    h.calls.some((call) => Array.isArray(call)),
    false,
  );
  assert.deepEqual(h.controller.getSnapshot().view.workspaces, [choice]);
  await h.controller.start(next);
  const input = h.calls.find((call) => Array.isArray(call))[1];
  assert.equal(input.tools, 'local-tools');
  assert.deepEqual(input.workspace, { kind: 'local', id: choice.id });
  assert.equal('path' in input.workspace, false);
  assert.equal('access' in input.workspace, false);
  h.controller.dispose();
});

test('Run workspace contract: stale or unlisted workspace IDs cannot begin and do not silently fall back', async () => {
  const h = setup({
    async options() {
      return { ...options(), workspaces: [] };
    },
  });
  await h.controller.refresh();
  await assert.rejects(
    h.controller.start({ ...selection, workspace: { kind: 'local', id: 'stale-workspace' } }),
    /Workspace changed/,
  );
  await assert.rejects(
    h.controller.start({ ...selection, workspace: { kind: 'unavailable' } }),
    /Workspace changed/,
  );
  assert.equal(
    h.calls.some((call) => Array.isArray(call)),
    false,
  );
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
function heldRead() {
  const result = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let signal;
  return {
    entered: entered.promise,
    get signal() {
      return signal;
    },
    resolve: result.resolve,
    async wait(current) {
      signal = current;
      current.throwIfAborted();
      const abort = () => result.reject(current.reason);
      current.addEventListener('abort', abort, { once: true });
      entered.resolve();
      try {
        return await result.promise;
      } finally {
        current.removeEventListener('abort', abort);
      }
    },
  };
}

test('Run refresh priority contract: a passive tick cannot abort a foreground catalog or history read or discard the current prefix', async (t) => {
  for (const stage of ['options', 'history']) {
    const held = heldRead(),
      trace = [];
    let armed = false;
    const h = setup({
      async options(_target, signal) {
        trace.push('options');
        if (armed && stage === 'options') {
          armed = false;
          return held.wait(signal);
        }
        return runningOptions();
      },
      async read() {
        trace.push('read');
        return summary;
      },
      async history(_target, _run, after, signal) {
        trace.push('history');
        if (armed && stage === 'history') {
          armed = false;
          return held.wait(signal);
        }
        return { messages: [], nextAfter: after };
      },
      async *observe(_run, _after, signal) {
        yield {
          type: 'assistant-stream',
          frame: {
            type: 'snapshot',
            revision: 1,
            activeAttempt: {
              attemptId: 'attempt',
              startedAfterSeq: -1,
              nextIndex: 1,
              text: 'current visible prefix',
              toolNames: [],
            },
          },
        };
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
      },
    });
    t.after(() => h.controller.dispose());
    await h.controller.refresh();
    await new Promise(setImmediate);
    armed = true;
    const manual = h.controller.refresh().catch((error) => error);
    await held.entered;
    const before = [...trace];
    await h.controller.refresh(false); // The original workspace timer's action, without a real timer.
    assert.equal(held.signal.aborted, false);
    assert.deepEqual(trace, before, 'passive polling does not issue a competing read');
    assert.equal(h.controller.getSnapshot().busy, 'refresh');
    held.resolve(stage === 'options' ? runningOptions() : { messages: [], nextAfter: -1 });
    assert.equal(await manual, undefined);
    assert.equal(h.controller.getSnapshot().view.kind, 'ready');
    assert.equal(h.controller.getSnapshot().view.messages[0].text, 'current visible prefix');
    assert.equal(h.controller.getSnapshot().error, undefined);
    assert.equal(h.calls.some(Array.isArray), false, 'no execution command is sent');
  }
});

test('Run refresh priority contract: passive reads do not cancel each other and an explicit refresh still replaces a pending passive read', async (t) => {
  const held = heldRead();
  let armed = false,
    optionsCalls = 0;
  const h = setup({
    async options() {
      optionsCalls++;
      return runningOptions();
    },
    async history(_target, _run, after, signal) {
      if (armed) {
        armed = false;
        return held.wait(signal);
      }
      return { messages: [], nextAfter: after };
    },
  });
  t.after(() => h.controller.dispose());
  await h.controller.refresh();
  armed = true;
  const passive = h.controller.refresh(false).catch((error) => error);
  await held.entered;
  await h.controller.refresh(false);
  assert.equal(held.signal.aborted, false);
  await h.controller.refresh();
  assert.equal((await passive).name, 'AbortError');
  assert.equal(optionsCalls, 2, 'explicit refresh still reads the catalog');
  assert.equal(h.controller.getSnapshot().view.kind, 'ready');
  assert.equal(h.calls.some(Array.isArray), false);
});

test('Run refresh priority contract: catalog failures close the view while history failures preserve fresh status', async (t) => {
  for (const stage of ['options', 'history']) {
    const failure = Object.assign(new Error('Synthetic read failure'), { code: 'unavailable' });
    let armed = false;
    const h = setup({
      async options() {
        if (armed && stage === 'options') throw failure;
        return runningOptions();
      },
      async history(_target, _run, after) {
        if (armed && stage === 'history') throw failure;
        return { messages: [], nextAfter: after };
      },
    });
    t.after(() => h.controller.dispose());
    await h.controller.refresh();
    armed = true;
    await assert.rejects(h.controller.refresh(), (error) => error === failure);
    assert.equal(
      h.controller.getSnapshot().view.kind,
      stage === 'options' ? 'unavailable' : 'ready',
    );
    if (stage === 'options') assert.match(h.controller.getSnapshot().view.message, /暂时无法读取/);
    else assert.match(h.controller.getSnapshot().error, /运行状态已更新/);
    assert.equal(h.controller.getSnapshot().busy, undefined);
    assert.equal(h.calls.some(Array.isArray), false);
  }
});

test('Run refresh contract: settled status is visible before blocked history and survives inbox failure', async (t) => {
  let completed = false;
  const held = heldRead();
  const settled = {
    ...summary,
    status: 'completed',
    resources: 'settled',
    runVersion: 4,
    nodeVersion: 4,
  };
  const h = setup({
    options: async () => runningOptions(),
    read: async () => (completed ? settled : summary),
    history: async (_target, _run, after, signal) => {
      if (completed) await held.wait(signal);
      return { messages: [], nextAfter: after };
    },
    inbox: async () => {
      if (completed) throw new ExecutionError('unavailable', 'Retired inbox reader');
      return { asOfSeq: -1, receipts: [], items: [] };
    },
  });
  t.after(() => h.controller.dispose());
  await h.controller.refresh();
  completed = true;
  const refresh = h.controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.controller.getSnapshot().view.run.resources, 'settled');
  assert.equal(h.controller.getSnapshot().view.run.status, 'completed');
  held.resolve();
  await assert.rejects(refresh, /Retired inbox reader/);
  assert.equal(h.controller.getSnapshot().view.kind, 'ready');
  assert.deepEqual(h.controller.getSnapshot().view.run, settled);
  assert.equal(h.controller.getSnapshot().view.actions.stop.kind, 'unavailable');
});

test('Run refresh contract: explicit history authority or target refusals close actions after a fresh status read', async (t) => {
  for (const code of [
    'run-authority-denied',
    'unauthenticated',
    'space-unavailable',
    'run-scope-mismatch',
    'validation',
  ]) {
    const h = setup({
      options: async () => runningOptions(),
      read: async () => ({ ...summary, status: 'completed', resources: 'settled' }),
      history: async () => {
        throw new ExecutionError(code, 'Original refusal');
      },
    });
    t.after(() => h.controller.dispose());
    await assert.rejects(h.controller.refresh(), (error) => error.code === code);
    assert.equal(h.controller.getSnapshot().view.kind, 'unavailable', code);
    await assert.rejects(h.controller.start(selection), /not ready/);
  }
});

test('Run refresh priority contract: Stop, a replacement generation and scope disposal still cancel an in-flight foreground read', async (t) => {
  for (const action of ['stop', 'generation', 'dispose']) {
    const held = heldRead();
    let armed = false,
      current = summary,
      stops = 0;
    const h = setup({
      async options(_target, signal) {
        if (armed) {
          armed = false;
          return held.wait(signal);
        }
        return runningOptions(current);
      },
      async read() {
        return current;
      },
      async stop() {
        stops++;
        current = { ...summary, status: 'cancelled', resources: 'settled', stopPhase: 'confirmed' };
      },
    });
    t.after(() => h.controller.dispose());
    await h.controller.refresh();
    armed = true;
    const old = h.controller.refresh().catch((error) => error);
    await held.entered;
    if (action === 'stop') await h.controller.stop();
    else if (action === 'generation') {
      current = {
        ...summary,
        runId: 'replacement',
        generation: 2,
        segmentId: 'replacement-segment',
      };
      await h.controller.refresh();
    } else h.controller.dispose();
    assert.equal(held.signal.aborted, true);
    assert.equal((await old).name, 'AbortError');
    const snapshot = JSON.stringify(h.controller.getSnapshot());
    held.resolve(runningOptions(summary));
    await new Promise(setImmediate);
    assert.equal(
      JSON.stringify(h.controller.getSnapshot()),
      snapshot,
      'late old catalog cannot replace the current scope/generation',
    );
    if (action === 'stop') {
      assert.equal(stops, 1);
      assert.equal(h.controller.getSnapshot().view.run.stopPhase, 'confirmed');
    } else if (action === 'generation')
      assert.equal(h.controller.getSnapshot().view.run.generation, 2);
    else await assert.rejects(h.controller.refresh(), { name: 'AbortError' });
  }
});

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
test('Run transport contract: fixed delivery reads are bounded and reject malformed or contradictory receipts', async () => {
  const delivered = {
    kind: 'delivered',
    artifactVersionId: 'artifact-1',
    artifactVersion: 1,
    roundId: 'round-1',
    receipt: { idempotencyKey: 'result-key', version: 4 },
  };
  const read = { ...summary, status: 'completed', resources: 'settled', resultDelivery: delivered };
  const h = transport((request) =>
    reply(request, {
      ...read,
      resultDelivery: { ...delivered, privateText: 'BODY_MUST_NOT_ENTER_RUN_PROJECTION' },
    }),
  );
  assert.deepEqual(
    (await h.api.read(target, 'run', new AbortController().signal)).resultDelivery,
    delivered,
  );
  assert.deepEqual(h.calls, ['/zhuma-id/session', '/api/zhuma-run/read']);
  const v2 = { ...delivered, protocolVersion: 2, manifestDigest: 'a'.repeat(64) };
  const v2Transport = transport((request) => reply(request, { ...read, resultDelivery: v2 }));
  assert.deepEqual(
    (await v2Transport.api.read(target, 'run', new AbortController().signal)).resultDelivery,
    v2,
  );
  for (const invalid of [
    { ...read, status: 'running' },
    { ...read, resources: 'held' },
    { ...read, resultDelivery: null },
    { ...read, resultDelivery: { ...delivered, artifactVersion: 0 } },
    { ...read, resultDelivery: { ...delivered, receipt: null } },
    { ...read, resultDelivery: { ...v2, protocolVersion: 1 } },
    { ...read, resultDelivery: { ...v2, manifestDigest: undefined } },
    { ...read, resultDelivery: { ...v2, protocolVersion: undefined } },
    { ...read, resultDelivery: { ...v2, manifestDigest: 'untrusted' } },
    { ...summary, resultDelivery: { kind: 'pending', phase: 'invented' } },
    { ...read, resultDelivery: { kind: 'pending', phase: 'draining' } },
  ]) {
    const crossed = transport((request) => reply(request, invalid));
    await assert.rejects(crossed.api.read(target, 'run', new AbortController().signal), {
      code: 'validation',
    });
  }
});
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

test('Run stream controller contract: partial body is visible before completion and durable history merges into one record', async () => {
  const release = Promise.withResolvers(),
    partial = Promise.withResolvers();
  let observedSignal;
  const h = setup({
    options: async () => runningOptions(),
    history: async () => ({ messages: [], nextAfter: 4 }),
    async *observe(_run, after, signal) {
      assert.equal(after, 4);
      observedSignal = signal;
      yield {
        type: 'assistant-stream',
        frame: { type: 'start', attemptId: 'attempt', revision: 0 },
      };
      yield {
        type: 'assistant-stream',
        frame: { type: 'chunk', attemptId: 'attempt', revision: 3, index: 2, text: 'early' },
      };
      partial.resolve();
      await release.promise;
      yield { type: 'message', seq: 8, id: 'message', role: 'assistant', text: 'complete' };
      yield {
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt',
          revision: 4,
          index: 3,
          outcome: {
            kind: 'committed',
            eventType: 'assistant/message',
            seq: 8,
            messageKey: 'native:seq:8',
          },
        },
      };
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  try {
    await h.controller.refresh();
    await partial.promise;
    assert.equal(h.controller.getSnapshot().view.messages[0].text, 'early');
    await h.controller.refresh(false);
    assert.equal(h.controller.getSnapshot().view.messages[0].text, 'early');
    release.resolve();
    await new Promise(setImmediate);
    const messages = h.controller.getSnapshot().view.messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'complete');
    assert.equal(
      h.calls.some((call) => Array.isArray(call) && ['begin', 'send', 'stop'].includes(call[0])),
      false,
    );
  } finally {
    release.resolve();
    h.controller.dispose();
  }
  assert.equal(observedSignal.aborted, true);
});

test('Run stream controller contract: pending inputs are visible, gap retains the actual durable cursor and disposal rejects late frames', async () => {
  const afters = [],
    gate = Promise.withResolvers(),
    ended = Promise.withResolvers();
  let reads = 0,
    signal;
  const h = setup({
    options: async () => runningOptions(),
    history: async (_target, _run, after) => {
      afters.push(after);
      return { messages: [], nextAfter: 5 };
    },
    inbox: async () => ({
      asOfSeq: 5,
      receipts: [],
      items: [
        {
          id: 'pending',
          text: 'received body',
          target: 'next-turn',
          requestId: 'request',
          mode: 'queue',
          status: 'received',
        },
      ],
    }),
    async *observe(_run, _after, current) {
      signal = current;
      if (reads++ === 0) {
        yield { type: 'gap', after: 999 };
        return;
      }
      await gate.promise;
      yield {
        type: 'message',
        seq: 1000,
        id: 'late',
        role: 'assistant',
        text: 'late private body',
      };
      ended.resolve();
    },
  });
  await h.controller.refresh();
  await new Promise(setImmediate);
  assert.equal(h.controller.getSnapshot().view.messages[0].delivery, 'received');
  await h.controller.refresh(false);
  assert.deepEqual(afters, [-1, 5]);
  const before = h.controller.getSnapshot();
  h.controller.dispose();
  gate.resolve();
  await new Promise(setImmediate);
  assert.equal(signal.aborted, true);
  assert.equal(h.controller.getSnapshot(), before);
  assert.equal(JSON.stringify(before).includes('late private body'), false);
});

test('Run stream transport contract: exact same-origin member endpoint validates RPC and Run generation and cancels crossed body', async () => {
  let cancelled = 0;
  const h = transport((request) => {
    assert.deepEqual(request.payload, {
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      runId: 'run',
      after: 4,
    });
    const frame = {
      target: { ...target, runId: 'run', generation: 2, segmentId: 'segment' },
      sessionId: 'native',
      type: 'status',
      status: 'idle',
    };
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ type: 'server-frame', rpcId: request.rpcId, frame }) + '\n',
            ),
          );
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { 'content-type': 'application/x-ndjson' } },
    );
  });
  await assert.rejects(
    async () => {
      for await (const frame of h.api.observe(summary, 4, new AbortController().signal)) void frame;
    },
    { code: 'validation' },
  );
  assert.deepEqual(h.calls, ['/zhuma-id/session', '/api/zhuma-run/observe']);
  assert.equal(cancelled, 1);
});

test('Run publication contract: only explicit per-Run ranges enter the start intent and malformed ranges never call the Host', async () => {
  const choice = {
    id: 'current-workspace',
    label: 'Workspace',
    access: 'write',
    publish: false,
    publication: 'per-run',
  };
  const h = setup({
    async options() {
      return { ...options(), workspaces: [choice] };
    },
  });
  await h.controller.refresh();
  const publish = [{ kind: 'file', path: 'deliverables/report.md' }];
  await h.controller.start({ ...selection, workspace: { kind: 'local', id: choice.id, publish } });
  const begun = h.calls.find((item) => Array.isArray(item) && item[0] === 'begin');
  assert.deepEqual(begun[1].workspace, { kind: 'local', id: choice.id, publish });
  const count = h.calls.filter((item) => Array.isArray(item) && item[0] === 'begin').length;
  await assert.rejects(
    h.controller.start({
      ...selection,
      workspace: { kind: 'local', id: choice.id, publish: [{ kind: 'file', path: '../private' }] },
    }),
  );
  assert.equal(h.calls.filter((item) => Array.isArray(item) && item[0] === 'begin').length, count);
  h.controller.dispose();
});
