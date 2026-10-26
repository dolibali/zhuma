import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostRunReader } from '../dist/host-run-reader.js';
import { available, command, records } from './execution-run-fixture.mjs';
import { beginExecutionRun } from '../dist/execution-run-state.js';

// Reader contracts only. The authority and native ports are explicit fixtures;
// these cases do not certify member authorization, a native session or a model.
function fixture() {
  const first = records()[0];
  const decision = beginExecutionRun(first, command(first), [first], available);
  const node = decision.record;
  const run = decision.run;
  const scope = decision.effect.scope;
  const locator = Object.fromEntries(
    ['taskId', 'planId', 'revision', 'nodeId', 'runId'].map((key) => [key, scope[key]]),
  );
  const counters = { opened: 0, disposed: 0, history: 0, nativeOpen: 0 };
  const checks = [];
  const request = { headers: {} };
  const revoked = new AbortController();
  const grant = {
    scope,
    signal: revoked.signal,
    assertCurrent(action) {
      checks.push(action);
      revoked.signal.throwIfAborted();
    },
  };
  const execution = {
    readRunNode(actual) {
      assert.deepEqual(actual, scope);
      return node;
    },
  };
  const authorities = {
    async open(original, actual, purpose) {
      assert.equal(original, request);
      assert.deepEqual(actual, locator);
      assert.equal(purpose, 'read');
      counters.opened++;
      return { grant, dispose: () => counters.disposed++ };
    },
  };
  const native = {
    open(actual) {
      assert.equal(actual, grant);
      counters.nativeOpen++;
      return undefined;
    },
    async history(actual, after, limit, wait) {
      assert.equal(actual, grant);
      assert.equal(after, -1);
      assert.equal(limit, undefined);
      wait?.throwIfAborted();
      counters.history++;
      return {
        binding: { nativeSessionId: 'native-session', privateCanary: 'not-public' },
        events: [1, 4, 8].map((seq) => ({ seq, type: 'contract', data: {} })),
      };
    },
  };
  const reader = createHostRunReader(execution, authorities, native);
  return {
    reader,
    node,
    run,
    request,
    locator,
    counters,
    authorities,
    native,
    checks,
    revoked,
    grant,
    scope,
  };
}

test('Host Run reader contract: every read opens and releases fresh authority and never creates native work', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await f.reader.read(f.request, f.locator);
    assert.equal(result.ok, true);
    assert.equal(result.value.runId, f.run.attempt.id);
    assert.equal(result.value.nodeVersion, f.node.command.version);
    assert.equal(result.value.native, null);
    assert.equal(result.value.status, 'requested');
    assert.equal('composition' in result.value, false);
    assert.equal('grant' in result.value, false);
    assert.equal('headers' in result.value, false);
  }
  assert.deepEqual(f.counters, { opened: 2, disposed: 2, history: 0, nativeOpen: 2 });
  assert.deepEqual(f.checks, ['open', 'open']);
});

test('Host Run reader contract: rejected authority does not reach native history or metadata', async () => {
  const f = fixture();
  f.authorities.open = async () => {
    throw Object.assign(Error('denied'), { code: 'run-authority-denied' });
  };
  for (const method of ['read', 'history'])
    await assert.rejects(f.reader[method](f.request, f.locator), {
      code: 'run-authority-denied',
    });
  assert.equal(f.counters.nativeOpen, 0);
  assert.equal(f.counters.history, 0);
});

test('Host Run reader contract: history validates its cursor and limit before opening authority and pages without exposing the binding', async () => {
  const f = fixture();
  for (const payload of [
    { ...f.locator, after: -2 },
    { ...f.locator, limit: 0 },
    { ...f.locator, limit: 101 },
    { ...f.locator, actorId: 'another-member' },
  ])
    await assert.rejects(f.reader.history(f.request, payload), { code: 'run-validation' });
  assert.equal(f.counters.opened, 0);
  const result = await f.reader.history(f.request, { ...f.locator, limit: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.events.map((event) => event.seq),
    [1, 4],
  );
  assert.equal(result.value.nextAfter, 4);
  assert.equal(result.value.sessionId, 'native-session');
  assert.equal('binding' in result.value, false);
  assert.equal(JSON.stringify(result).includes('privateCanary'), false);
  assert.equal(f.counters.disposed, 1);
});

test('Host Run reader contract: a missing or different native mapping cannot replace the recorded session', async () => {
  const f = fixture();
  f.run.attempt.sessionId = 'recorded-session';
  // The decision keeps the exact run in its node state.
  f.node.nativeExecution.runs[0].attempt.sessionId = 'recorded-session';
  for (const value of [
    undefined,
    { binding: { nativeSessionId: 'other-session' }, status: 'detached' },
  ]) {
    f.native.open = () => value;
    await assert.rejects(f.reader.read(f.request, f.locator), { code: 'binding-state-invalid' });
  }
  assert.equal(f.counters.disposed, 2);
});

test('Host Run reader contract: cancellation and late authorization failure release the read lease', async () => {
  const f = fixture();
  const wait = new AbortController();
  const originalOpen = f.authorities.open;
  f.authorities.open = async (...args) => {
    const opened = await originalOpen(...args);
    wait.abort();
    return opened;
  };
  await assert.rejects(f.reader.read(f.request, f.locator, wait.signal), {
    name: 'AbortError',
  });
  assert.equal(f.counters.nativeOpen, 0);
  assert.equal(f.counters.disposed, 1);
  f.authorities.open = originalOpen;
  f.native.history = async () => {
    f.revoked.abort();
    return { binding: { nativeSessionId: 'native' }, events: [] };
  };
  await assert.rejects(f.reader.history(f.request, f.locator), { name: 'AbortError' });
  assert.equal(f.counters.disposed, 2);
});

test('Host Run conversation contract: inbox and frames expose only the exact granted scope and known presentation fields', async () => {
  const f = fixture();
  const binding = { scope: f.scope, nativeSessionId: 'native', privateCanary: 'PRIVATE' };
  f.native.readInbox = async (grant) => {
    assert.equal(grant, f.grant);
    return {
      binding,
      asOfSeq: 9,
      receipts: [
        {
          requestId: 'request',
          messageId: 'message',
          mode: 'queue',
          status: 'received',
          privateCanary: 'PRIVATE',
        },
      ],
      items: [
        {
          id: 'message',
          text: 'pending',
          target: 'next-turn',
          requestId: 'request',
          mode: 'queue',
          status: 'received',
          privateCanary: 'PRIVATE',
        },
      ],
    };
  };
  f.native.open = () => ({ binding });
  f.native.observe = async function* (grant, after) {
    assert.equal(grant, f.grant);
    assert.equal(after, 4);
    yield {
      scope: f.scope,
      nativeSessionId: 'native',
      type: 'message',
      seq: 5,
      time: 1,
      messageKey: 'native:seq:5',
      role: 'user',
      id: 'message',
      text: 'body',
      reasoning: 'PRIVATE',
    };
  };
  const inbox = await f.reader.inbox(f.request, f.locator);
  const frames = [];
  await f.reader.observe(f.request, { ...f.locator, after: 4 }, async (frame) =>
    frames.push(frame),
  );
  assert.equal(inbox.value.items[0].status, 'received');
  assert.equal(frames[0].type, 'ready');
  assert.equal(frames[1].target.runId, f.locator.runId);
  assert.equal('actorId' in frames[0].target, false);
  assert.equal(JSON.stringify([inbox, frames]).includes('PRIVATE'), false);
  assert.equal(f.counters.disposed, 2);
});

test('Host Run conversation contract: wrong scope or revocation rejects frames and releases the read lease', async () => {
  const f = fixture();
  f.native.open = () => ({ binding: { nativeSessionId: 'native' } });
  f.native.observe = async function* () {
    yield {
      scope: { ...f.scope, generation: 99 },
      nativeSessionId: 'native',
      type: 'status',
      status: 'idle',
    };
  };
  let emitted = 0;
  await assert.rejects(
    f.reader.observe(f.request, f.locator, async (frame) => {
      if (frame.type !== 'ready') emitted++;
    }),
    { code: 'scope-mismatch' },
  );
  f.native.observe = async function* () {
    f.revoked.abort();
    yield { scope: f.scope, nativeSessionId: 'native', type: 'status', status: 'idle' };
  };
  await assert.rejects(
    f.reader.observe(f.request, f.locator, async (frame) => {
      if (frame.type !== 'ready') emitted++;
    }),
    { name: 'AbortError' },
  );
  assert.equal(emitted, 0);
  assert.equal(f.counters.disposed, 2);
});
