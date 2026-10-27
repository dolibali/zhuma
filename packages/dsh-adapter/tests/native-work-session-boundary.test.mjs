/** Contract fault injection only; real DSH lifecycle coverage is in native-work-session.test. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { grant, message } from './native-work-session-fixture.mjs';

function harness() {
  const records = new Map();
  let sends = 0;
  const runtime = {
    connect: async () => {},
    isConnected: () => true,
    status: () => 'idle',
    pending: () => [],
    messageStatus: async () => 'absent',
    send() {
      sends++;
    },
    flush: async () => {},
    stop: async () => 'stopped',
  };
  const storage = {
    read: (key) => records.get(key),
    write: async (key, value) => {
      records.set(key, structuredClone(value));
    },
  };
  return {
    storage,
    runtime,
    records,
    sends: () => sends,
    service: new NativeWorkSessionService(storage, runtime),
  };
}

test('contract: stop fences an older send paused during receipt persistence', async () => {
  const h = harness(),
    current = grant();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const write = h.storage.write;
  h.storage.write = async (key, binding) => {
    if (binding.receipts.length > 0) {
      entered.resolve();
      await release.promise;
    }
    await write(key, binding);
  };
  const sending = h.service.send(current, message('paused', 'must not send after stop'));
  await entered.promise;
  assert.deepEqual(await h.service.stop(current), { status: 'stopped' });
  release.resolve();
  await assert.rejects(sending, { code: 'cancelled' });
  assert.equal(h.sends(), 0);
  await h.service.send(current, message('new', 'explicit new turn'));
  assert.equal(h.sends(), 1);
});

test('contract: no replay when native admission was acknowledged but metadata receipt failed', async () => {
  const h = harness(),
    current = grant();
  const write = h.storage.write;
  let failed = false;
  h.storage.write = async (key, binding) => {
    if (!failed && binding.receipts.at(-1)?.status === 'received') {
      failed = true;
      throw Error('contract disk failure');
    }
    await write(key, binding);
  };
  await assert.rejects(h.service.send(current, message('ambiguous', 'one admission')));
  assert.equal(h.sends(), 1);
  const receipt = await h.service.send(current, message('ambiguous', 'one admission'));
  assert.equal(receipt.status, 'unknown');
  assert.equal(h.sends(), 1);
  await assert.rejects(h.service.send(current, message('ambiguous', 'changed request')), {
    code: 'idempotency-mismatch',
  });
});

test('contract: changing the grant locator across an await cannot retarget the reserved operation', async () => {
  const h = harness(),
    current = grant();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  h.runtime.connect = async () => {
    entered.resolve();
    await release.promise;
  };
  const sending = h.service.send(current, message('one', 'original node'));
  await entered.promise;
  current.scope.nodeId = 'other-node';
  release.resolve();
  await assert.rejects(sending, { code: 'scope-mismatch' });
  assert.equal(h.sends(), 0);
});

test('contract: equivalent model selection key order is stable; a changed configuration is rejected', async () => {
  const h = harness(),
    current = grant();
  const a = message('one', 'one');
  await h.service.send(current, a);
  await h.service.send(current, {
    ...message('two', 'two'),
    selection: {
      configurationId: a.selection.configurationId,
      maxTokens: a.selection.maxTokens,
      model: a.selection.model,
      provider: a.selection.provider,
    },
  });
  await assert.rejects(
    h.service.send(current, {
      ...message('three', 'three'),
      selection: { ...a.selection, model: 'different' },
    }),
    { code: 'configuration-mismatch' },
  );
  assert.equal(h.sends(), 2);
});

test('contract: stale authorization is checked after a delayed source and before each delivered frame', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'one'));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  h.runtime.follow = async function* () {
    entered.resolve();
    await release.promise;
    yield { type: 'status', status: 'running' };
  };
  const next = h.service.follow(current).next();
  await entered.promise;
  current.deny();
  release.resolve();
  await assert.rejects(next, /currentness-rejected/);
});

test('contract: an opening snapshot cannot use a native mapping replaced during its read', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('one', 'original session'));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  h.runtime.follow = async function* () {
    entered.resolve();
    await release.promise;
    yield { type: 'assistant-stream', frame: { type: 'snapshot', revision: 0 } };
  };
  const observing = h.service.observe(current).next();
  await entered.promise;
  const [key, original] = [...h.records][0];
  const replaced = structuredClone(original);
  if (replaced.schemaVersion === 2) replaced.current.nativeSessionId = 'replacement';
  else replaced.nativeSessionId = 'replacement';
  h.records.set(key, replaced);
  release.resolve();
  await assert.rejects(observing, { code: 'scope-mismatch' });
});

test('contract: UI history cancellation does not revoke the Run grant', async () => {
  const h = harness(),
    current = grant(),
    ui = new AbortController();
  await h.service.send(current, message('one', 'one'));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  h.runtime.history = async () => {
    entered.resolve();
    await release.promise;
    return [];
  };
  const reading = h.service.history(current, -1, 10, ui.signal);
  await entered.promise;
  ui.abort();
  release.resolve();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(current.signal.aborted, false);
  assert.ok(h.service.open(current));
});
