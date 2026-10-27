/** Fault-injected port contracts only; native writer proof has a separate SDK spec. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { migrationFingerprint } from '../dist/native-work-session-record.js';
import { grant, message, scope } from './native-work-session-fixture.mjs';

function harness() {
  const records = new Map(),
    calls = [],
    controller = new AbortController();
  let writes = 0;
  const proof = {
    signal: controller.signal,
    basis: 'flushed-and-closed',
    assertCurrent() {
      assert.equal(controller.signal.aborted, false);
    },
  };
  const runtime = {
    connect: async () => {},
    isConnected: () => true,
    status: () => 'idle',
    send() {},
    flush: async () => {},
    messageStatus: async () => 'absent',
    migrationDrain() {
      throw Error('contract: no prepared proof');
    },
    async retire(id, signal, allowAbsent) {
      calls.push({ id, signal, allowAbsent });
      return proof;
    },
  };
  const storage = {
    read: (key) => records.get(key),
    async write(key, value) {
      writes++;
      records.set(key, structuredClone(value));
    },
  };
  return {
    runtime,
    storage,
    records,
    calls,
    controller,
    writes: () => writes,
    service: new NativeWorkSessionService(storage, runtime),
  };
}
function authority(value = scope) {
  let valid = true,
    checks = 0;
  return {
    scope: structuredClone(value),
    assertCurrent() {
      checks++;
      if (!valid) throw Error('contract cleanup revoked');
    },
    revoke() {
      valid = false;
    },
    checks: () => checks,
  };
}
const wait = () => new AbortController();

test('contract: five-second pending result never cancels or forgets physical retirement', async (t) => {
  const h = harness(),
    current = grant(),
    release = Promise.withResolvers();
  await h.service.send(current, message('start', 'fixture', 'queue'));
  const retire = h.runtime.retire;
  h.runtime.retire = async (...args) => {
    await release.promise;
    return retire(...args);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retiring = h.service.retireForCleanup(authority(), wait().signal);
  t.mock.timers.tick(5000);
  assert.deepEqual(await retiring, { status: 'pending' });
  release.resolve();
  await h.service.whenRetirementsIdle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false);
});

test('contract: never-admitted absence is fenced, read-only and invalidated by whole-Host close', async () => {
  const h = harness(),
    cap = authority();
  const result = await h.service.retireForCleanup(cap, wait().signal);
  assert.equal(result.status, 'retired');
  assert.equal(result.binding, undefined);
  assert.equal(result.drain.basis, 'absent-unadmitted');
  result.drain.assertCurrent();
  assert.equal(h.writes(), 0);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.service.send(grant(), message('late', 'refuse')), {
    code: 'scope-mismatch',
  });
  await h.service.sealInputReads();
  assert.equal(result.drain.signal.aborted, true);
  assert.throws(() => result.drain.assertCurrent(), { code: 'unavailable' });
});

test('contract: cleanup assertion must be synchronous undefined, and is rechecked after waiting', async () => {
  for (const value of [
    false,
    true,
    Promise.resolve(),
    {
      then(resolve) {
        resolve();
      },
    },
  ]) {
    const h = harness();
    await assert.rejects(
      h.service.retireForCleanup({ scope, assertCurrent: () => value }, wait().signal),
      { code: 'unavailable' },
    );
    assert.equal(h.calls.length, 0);
  }
  const h = harness(),
    current = grant(),
    cap = authority(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  await h.service.send(current, message('start', 'fixture', 'queue'));
  h.runtime.retire = async () => {
    entered.resolve();
    await release.promise;
    return {
      signal: wait().signal,
      basis: 'flushed-and-closed',
      assertCurrent() {},
    };
  };
  const retiring = h.service.retireForCleanup(cap, wait().signal);
  await entered.promise;
  cap.revoke();
  release.resolve();
  await assert.rejects(retiring, { code: 'unavailable' });
  assert.ok(cap.checks() >= 2);
});

test('contract: in-flight first metadata write cannot turn into native admission after cleanup', async () => {
  const h = harness(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const write = h.storage.write;
  h.storage.write = async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  };
  h.runtime.connect = async () => assert.fail('retired scope must never connect');
  const sending = h.service.send(grant(), message('held', 'fixture', 'queue'));
  const rejected = assert.rejects(sending, { code: 'cancelled' });
  await entered.promise;
  const controller = wait(),
    retiring = h.service.retireForCleanup(authority(), controller.signal);
  controller.abort();
  assert.deepEqual(await retiring, { status: 'pending' });
  release.resolve();
  await rejected;
  await h.service.whenRetirementsIdle();
  const result = await h.service.retireForCleanup(authority(), wait().signal);
  assert.equal(result.status, 'retired');
  assert.equal(result.binding.nativeSessionId, h.calls[0].id);
  assert.equal(h.calls[0].allowAbsent, true);
  assert.equal(h.writes(), 1);
});

test('contract: caller cancellation retains owned cleanup and waits for the actual source promise', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('start', 'fixture', 'queue'));
  const reservation = await h.service.reserveInputRead(current),
    before = h.writes();
  const controller = wait();
  const retiring = h.service.retireForCleanup(authority(), controller.signal);
  controller.abort();
  assert.deepEqual(await retiring, { status: 'pending' });
  let idle = false;
  const drain = h.service.whenRetirementsIdle().then(() => {
    idle = true;
  });
  await new Promise(setImmediate);
  assert.equal(idle, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false);
  await h.service.finishInputRead(current, reservation);
  await drain;
  assert.equal(h.writes(), before);
  const result = await h.service.retireForCleanup(authority(), wait().signal);
  result.drain.assertCurrent();
  assert.equal(result.binding.scope.runId, scope.runId);
});

test('contract: failures and lost admitted metadata cannot produce an absence certificate', async () => {
  const h = harness();
  await h.service.send(grant(), message('start', 'fixture', 'queue'));
  h.runtime.retire = async () => {
    throw Error('contract writer failure');
  };
  await assert.rejects(h.service.retireForCleanup(authority(), wait().signal), /writer failure/);
  await assert.rejects(h.service.whenRetirementsIdle(), { code: 'unavailable' });
  h.records.clear();
  await assert.rejects(h.service.retireForCleanup(authority(), wait().signal), {
    code: 'unavailable',
  });
});

test('contract: cleanup fences only the exact generation, cannot retarget its authority, and observes native proof changes', async () => {
  const h = harness(),
    current = grant();
  await h.service.send(current, message('start', 'fixture', 'queue'));
  const result = await h.service.retireForCleanup(authority(), wait().signal);
  result.drain.assertCurrent();
  const next = grant({ runId: 'new-run', generation: 2, segmentId: 'new-segment' });
  // A different generation without the required lineage is still rejected by
  // the binding contract, never cancelled just because the old scope retired.
  await assert.rejects(h.service.send(next, message('new', 'fixture', 'queue')), {
    code: 'scope-mismatch',
  });
  const other = grant({ nodeId: 'other-node' });
  await h.service.send(other, message('other', 'fixture', 'queue'));
  assert.equal(h.calls.length, 1);
  h.controller.abort();
  assert.throws(() => result.drain.assertCurrent());
  const cap = authority(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  h.runtime.retire = async () => {
    entered.resolve();
    await release.promise;
    return result.drain;
  };
  const pending = h.service.retireForCleanup(cap, wait().signal);
  await entered.promise;
  cap.scope.generation = 2;
  release.resolve();
  await assert.rejects(pending, { code: 'scope-mismatch' });
});

test('contract: old-generation cleanup resolves its lineage binding while the current generation keeps running', async () => {
  const h = harness(),
    previous = grant();
  await h.service.send(previous, message('old', 'fixture', 'queue'));
  const [key, old] = [...h.records][0];
  const nextScope = { ...scope, runId: 'next-run', generation: 2, segmentId: 'next-segment' };
  const next = {
    ...structuredClone(old),
    scope: nextScope,
    receipts: [],
    nativeSessionId: 'next-native',
    nativeAgentId: 'next-native',
  };
  const inputFingerprint = 'a'.repeat(64);
  h.records.set(key, {
    schemaVersion: 2,
    version: 2,
    current: next,
    prior: [
      {
        binding: old,
        migration: {
          requestId: 'migration',
          inputFingerprint,
          fingerprint: migrationFingerprint(scope, nextScope, next.selection, inputFingerprint),
        },
      },
    ],
  });
  const result = await h.service.retireForCleanup(authority(), wait().signal);
  assert.equal(result.binding.nativeSessionId, old.nativeSessionId);
  assert.deepEqual(
    h.calls.map((call) => call.id),
    [old.nativeSessionId],
  );
  await h.service.send(grant(nextScope), message('new', 'fixture', 'queue'));
  assert.equal(h.service.open(grant(nextScope)).binding.receipts.length, 1);
  assert.deepEqual(
    h.calls.map((call) => call.id),
    [old.nativeSessionId],
  );
  result.drain.assertCurrent();
});
