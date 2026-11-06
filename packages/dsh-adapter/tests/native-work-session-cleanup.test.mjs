/** Fault-injected port contracts only; native writer proof has a separate SDK spec. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
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

// These children exercise the real C adapter over fault-injected persistence /
// registry ports. No Agent is created/resumed and no model or profile is used.
function diagnosticChild(mode, flag) {
  const moduleUrl = (file) => new URL(`../dist/${file}`, import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { writeSync, closeSync } from 'node:fs';
    import { Service } from '@deepseek-ai/cordis';
    import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
    import { NativeWorkSessionService, traceNativeRetirementStage } from ${JSON.stringify(moduleUrl('native-work-session.js'))};
    import { DshNativeWorkRuntime } from ${JSON.stringify(moduleUrl('native-work-session-dsh.js'))};
    import { nativeWorkSessionKey } from ${JSON.stringify(moduleUrl('native-work-session-record.js'))};
    import { scope, selection } from ${JSON.stringify(new URL('./native-work-session-fixture.mjs', import.meta.url).href)};
    const mode = ${JSON.stringify(mode)};
    const original = new Error('PRIVATE_FAILURE /private/path sk-private-token');
    const calls = [], entered = Promise.withResolvers(), release = Promise.withResolvers();
    const binding = { schemaVersion: 1, scope: { ...scope }, nativeSessionId: 'private-native-session', nativeAgentId: 'private-native-agent', selection, receipts: [] };
    const before = JSON.stringify(binding);
    const agents = { get() { calls.push('registry'); return undefined; }, [Service.tracker]: {} };
    const ctx = {
      agents,
      sessionPersistence: {
        identity: Symbol('contract-persistence'),
        async open(id, access) {
          assert.equal(id, binding.nativeSessionId); assert.equal(access, 'write');
          calls.push('open'); entered.resolve();
          if (mode === 'pending') await release.promise;
          if (mode === 'missing') throw new SessionPersistenceNotFoundError(id);
          return {
            async flush() { calls.push('flush'); if (mode === 'flush-error') throw original; },
            async close() { calls.push('close'); if (mode === 'close-error') throw original; },
          };
        },
      },
    };
    const runtime = new DshNativeWorkRuntime(ctx, {
      workingDirectory() { throw Error('forbidden directory/factory'); },
      compose() { throw Error('forbidden compose/model'); },
    });
    let writes = 0;
    const service = new NativeWorkSessionService({
      read(key) {
        assert.equal(key, nativeWorkSessionKey(scope));
        if (mode === 'binding-error') throw original;
        return structuredClone(binding);
      },
      async write() { writes++; throw Error('forbidden mapping write'); },
    }, runtime);
    const cap = { scope: { ...scope }, assertCurrent() { if (mode === 'authority-error') throw original; } };
    const waiting = new AbortController();
    if (mode === 'closed-output') closeSync(1);
    let basis;
    const cleanup = service.retireForCleanup(cap, waiting.signal);
    if (mode === 'authority-error') {
      await assert.rejects(cleanup, { code: 'unavailable' }); assert.deepEqual(calls, []);
    } else if (mode === 'binding-error') {
      await assert.rejects(cleanup, error => error === original); assert.deepEqual(calls, []);
    } else if (mode === 'flush-error' || mode === 'close-error') {
      await assert.rejects(cleanup, { code: 'unavailable' });
      assert.deepEqual(calls.filter(value => value !== 'registry'), ['open', 'flush', 'close']);
      assert.throws(() => runtime.migrationDrain(binding.nativeSessionId), { code: 'unavailable' });
    } else {
      let result;
      if (mode === 'pending') {
        await entered.promise; waiting.abort();
        assert.deepEqual(await cleanup, { status: 'pending' });
        assert.equal(calls.includes('flush'), false);
        assert.throws(() => runtime.migrationDrain(binding.nativeSessionId), { code: 'migration-not-ready' });
        traceNativeRetirementStage(runtime, binding.nativeSessionId, 'PRIVATE_FORGED_STAGE', 'error', original);
        traceNativeRetirementStage({}, binding.nativeSessionId, 'runtime-barrier', 'wait');
        release.resolve(); await service.whenRetirementsIdle();
        result = await service.retireForCleanup(cap, new AbortController().signal);
      } else result = await cleanup;
      assert.equal(result.status, 'retired');
      result.drain.assertCurrent(); basis = result.drain.basis;
      assert.equal(basis, mode === 'missing' ? 'absent-unadmitted' : 'flushed-and-closed');
      // A new unused point after owned completion must find no observer.
      traceNativeRetirementStage(runtime, binding.nativeSessionId, 'runtime-barrier', 'wait');
    }
    assert.equal(JSON.stringify(binding), before); assert.equal(writes, 0);
    writeSync(2, JSON.stringify({ mode, basis, calls: calls.filter(value => value !== 'registry') }) + '\\n');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../', import.meta.url),
    env: flag === undefined ? {} : { ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT: flag },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return {
    records: result.stdout.trim()
      ? result.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [],
    summary: JSON.parse(result.stderr.trim()),
  };
}

test('private retirement diagnostics contract: default / nonexact flags are silent and closed output preserves cleanup', () => {
  for (const flag of [undefined, '0', 'true']) {
    const result = diagnosticChild('success', flag);
    assert.deepEqual(result.records, []);
    assert.equal(result.summary.basis, 'flushed-and-closed');
  }
  const closed = diagnosticChild('closed-output', '1');
  assert.deepEqual(closed.records, []);
  assert.equal(closed.summary.basis, 'flushed-and-closed');
});

test('private retirement diagnostics contract: opt-in sees actual C cold barrier phases with one opaque scope correlation', () => {
  const { records, summary } = diagnosticChild('success', '1');
  assert.equal(summary.basis, 'flushed-and-closed');
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['code', 'correlation', 'event', 'stage']);
    assert.equal(record.event, 'zhuma-native-retire-stage');
    assert.match(record.correlation, /^[a-f0-9]{16}$/u);
  }
  assert.equal(new Set(records.map((record) => record.correlation)).size, 1);
  assert.doesNotMatch(
    JSON.stringify(records),
    /private|PRIVATE|sk-|member-a|team-a|task-a|plan-a|node-a|run-a|contract-model/u,
  );
  const stages = records.map((record) => record.stage);
  for (const stage of [
    'cleanup-authority',
    'cleanup-binding',
    'runtime-registry',
    'runtime-writer-open',
    'runtime-writer-flush',
    'runtime-writer-close',
    'runtime-identity',
    'runtime-epoch',
  ]) {
    assert.ok(stages.includes(stage + '-wait'), stage);
    assert.ok(stages.includes(stage + '-done'), stage);
  }
  assert.ok(
    stages.indexOf('runtime-writer-open-done') < stages.indexOf('runtime-writer-flush-wait'),
  );
  assert.ok(
    stages.indexOf('runtime-writer-flush-done') < stages.indexOf('runtime-writer-close-wait'),
  );
  assert.equal(stages.includes('runtime-barrier-wait'), false);
});

test('private retirement diagnostics contract: a pending caller keeps observing original owned work and cannot invent proof', () => {
  const { records, summary } = diagnosticChild('pending', '1');
  assert.equal(summary.basis, 'flushed-and-closed');
  assert.deepEqual(summary.calls, ['open', 'flush', 'close']);
  const stages = records.map((record) => record.stage);
  assert.ok(stages.indexOf('cleanup-call-pending') < stages.indexOf('runtime-writer-open-done'));
  assert.ok(stages.includes('runtime-writer-close-done'));
  const runtimeStages = stages.filter((stage) => stage.startsWith('runtime-'));
  assert.equal(new Set(runtimeStages).size, runtimeStages.length);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private/u);
  assert.equal(stages.includes('runtime-barrier-wait'), false);
});

test('private retirement diagnostics contract: authority / binding / writer errors retain original rejection and precise safe phase', () => {
  for (const [mode, stage, code] of [
    ['authority-error', 'cleanup-authority-error', 'unavailable'],
    ['binding-error', 'cleanup-binding-error', 'unexpected-error'],
    ['flush-error', 'runtime-writer-flush-error', 'unexpected-error'],
    ['close-error', 'runtime-writer-close-error', 'unexpected-error'],
    ['missing', 'runtime-writer-open-error', 'persistence-not-found'],
  ]) {
    const { records } = diagnosticChild(mode, '1');
    assert.ok(
      records.some((record) => record.stage === stage && record.code === code),
      mode,
    );
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private|sk-/u);
    if (mode === 'flush-error') {
      assert.ok(records.some((record) => record.stage === 'runtime-writer-close-done'));
      assert.equal(
        records.some((record) => record.stage === 'runtime-writer-close-error'),
        false,
      );
    }
  }
});

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
