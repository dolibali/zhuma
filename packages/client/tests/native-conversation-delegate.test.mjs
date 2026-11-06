/** Scoped native transport contracts; no SDK GUI or model proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeConversationDelegate } from '../dist/run/native-conversation.js';
const target = {
  spaceId: 'space',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'old-run',
  generation: 2,
  segmentId: 'segment',
};
function fixture() {
  let run = {
    ...target,
    native: { sessionId: 'native', status: 'idle' },
    status: 'running',
    sendCapabilities: Object.fromEntries(
      ['followup', 'queue', 'steer'].map((mode) => [mode, { kind: 'available' }]),
    ),
  };
  const calls = [],
    abort = new AbortController();
  let invalidated = 0,
    current = true;
  let respond = (endpoint, query, rpcId) =>
    Response.json({
      type: 'server-response',
      rpcId,
      result: { ok: true, value: { records: [], hasMore: false } },
    });
  const bridge = createNativeConversationDelegate({
    target,
    sessionId: 'native',
    signal: abort.signal,
    assertCurrent() {
      if (!current) throw Error('stale epoch');
    },
    invalidate() {
      invalidated++;
    },
    update() {},
    api: {
      async read(locator, runId) {
        calls.push(['read', locator, runId]);
        return run;
      },
      async send(...args) {
        calls.push(['send', ...args.slice(0, 4)]);
      },
      async stop(...args) {
        calls.push(['stop', ...args.slice(0, 2)]);
      },
      async begin() {
        assert.fail('must not restart or fork');
      },
    },
    client: {
      async conversationRequest(...args) {
        calls.push(['history', args[0], args[1]]);
        return respond(...args);
      },
    },
  });
  const query = (patch = {}) => ({
    sessionId: 'native',
    requestId: 'original-request',
    mode: 'queue',
    content: [{ type: 'text', text: '继续检查' }],
    ...patch,
  });
  return {
    ...bridge,
    calls,
    abort,
    query,
    invalidated: () => invalidated,
    setRun(patch) {
      run = { ...run, ...patch };
    },
    stale() {
      current = false;
    },
    respond(fn) {
      respond = fn;
    },
  };
}
test('original input requestId reaches one original Run/send with fresh pinned historical scope', async () => {
  const h = fixture();
  assert.deepEqual(await h.delegate.prompt(h.query()), { ok: true, value: { accepted: true } });
  const sends = h.calls.filter((call) => call[0] === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1].runId, target.runId);
  assert.deepEqual(sends[0].slice(2), ['继续检查', 'followup', 'original-request']);
  h.setRun({ native: { sessionId: 'native', status: 'running' } });
  await h.delegate.prompt(h.query({ requestId: 'queued' }));
  assert.equal(h.calls.at(-1)[3], 'queue');
});
test('files, images, empty/oversized input never get flattened into a text send', async () => {
  for (const content of [
    [{ type: 'file' }],
    [{ type: 'image' }],
    [],
    [{ type: 'text', text: ' ' }],
    [{ type: 'text', text: 'x'.repeat(16385) }],
  ]) {
    const h = fixture();
    assert.equal((await h.delegate.prompt(h.query({ content }))).ok, false);
    assert.equal(h.calls.length, 0);
  }
});
test('terminal scope never uses old drive, starts a Run, forks or silently substitutes a Session', async () => {
  const h = fixture();
  h.setRun({ status: 'cancelled', sendCapabilities: { followup: { kind: 'unavailable' } } });
  assert.equal((await h.delegate.prompt(h.query())).ok, false);
  assert.deepEqual(
    h.calls.map((call) => call[0]),
    ['read'],
  );
});
test('stale epoch and tuple/session drift prevent sending and invalidate mismatched histories', async () => {
  const h = fixture();
  h.stale();
  await assert.rejects(h.delegate.prompt(h.query()), /stale/);
  assert.equal(h.calls.length, 0);
  for (const patch of [
    { generation: 3 },
    { segmentId: 'other' },
    { runId: 'new-run' },
    { native: { sessionId: 'other' } },
  ]) {
    const next = fixture();
    next.setRun(patch);
    await assert.rejects(next.delegate.prompt(next.query()));
    assert.equal(next.invalidated(), 1);
    assert.equal(
      next.calls.some((call) => call[0] === 'send'),
      false,
    );
  }
});
test('Stop uses the original pinned Run API', async () => {
  const h = fixture();
  assert.equal((await h.delegate.cancel({ sessionId: 'native' })).ok, true);
  assert.deepEqual(
    h.calls.map((call) => call[0]),
    ['read', 'stop', 'read'],
  );
  assert.equal(h.calls[1][1].runId, target.runId);
});
test('original complete frame survives private stream adapter; wrong rpc never publishes', async () => {
  const h = fixture();
  const frame = {
    type: 'snapshot',
    header: { id: 'native' },
    assistantStream: { revision: 0 },
    records: [{ originalToolCard: 'fixture' }],
  };
  h.respond((_endpoint, query, rpcId) => {
    assert.deepEqual(query.target, target);
    return new Response(JSON.stringify({ type: 'server-frame', rpcId, frame }) + '\n', {
      headers: { 'content-type': 'application/x-ndjson' },
    });
  });
  const handle = h.delegate.follow({
    address: { kind: 'session', sessionId: 'native' },
    assistantStream: true,
  });
  const iterator = handle[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, frame);
  handle.dispose();
  await iterator.return();
  assert.equal(h.invalidated(), 0);
  const invalid = fixture();
  invalid.respond(
    () =>
      new Response('{"type":"server-frame","rpcId":"other","frame":{}}\n', {
        headers: { 'content-type': 'application/x-ndjson' },
      }),
  );
  await assert.rejects(
    invalid.delegate
      .follow({ address: { kind: 'session', sessionId: 'native' } })
      [Symbol.asyncIterator]()
      .next(),
  );
  assert.equal(invalid.invalidated(), 1);
});
