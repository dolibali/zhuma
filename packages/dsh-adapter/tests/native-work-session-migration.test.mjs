/** Record/authority contracts plus real published JSON storage; no native driver/member claim. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { nativeWorkSessionDomainSpec } from '../dist/native-work-session-storage.js';
import {
  nativeWorkSessionBindingSchema,
  nativeWorkSessionRecordSchema,
  nativeWorkSessionKey,
  readNativeRecord,
  currentBinding,
  NATIVE_LINEAGE_LIMITS,
} from '../dist/native-work-session-record.js';
import {
  inspectNativeMigration,
  appendNativeMigration,
} from '../dist/native-work-session-migration.js';
import { scope, selection } from './native-work-session-fixture.mjs';
import { grant, message } from './native-work-session-fixture.mjs';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';

function binding() {
  return {
    schemaVersion: 1,
    scope,
    nativeSessionId: 'old-native',
    nativeAgentId: 'old-native',
    selection,
    receipts: [
      {
        requestId: 'old-send',
        messageId: 'old-message',
        fingerprint: 'a'.repeat(64),
        mode: 'queue',
        status: 'received',
      },
    ],
    inputReadBudget: { attempts: 2, chargedBytes: 1234 },
  };
}
function command(record, count = 1) {
  const previousScope = currentBinding(record).scope;
  return {
    requestId: `migration-${count}`,
    inputFingerprint: 'b'.repeat(64),
    previousScope,
    scope: {
      ...previousScope,
      runId: `run-${count}`,
      generation: previousScope.generation + 1,
      segmentId: `segment-${count}`,
    },
    selection,
  };
}

test('contract: flat-v1 remains unchanged and one v2 write retains the complete old metadata', () => {
  const before = binding(),
    encoded = JSON.stringify(before);
  assert.equal(nativeWorkSessionRecordSchema.safeParse(before).success, true);
  const { record, result } = appendNativeMigration(before, command(before));
  assert.equal(record.version, 2);
  assert.deepEqual(record.prior[0].binding, before);
  assert.deepEqual(record.current.receipts, []);
  assert.equal(record.current.inputReadBudget, undefined);
  assert.notEqual(record.current.nativeSessionId, before.nativeSessionId);
  assert.deepEqual(result.previous.scope, before.scope);
  assert.equal(result.next.nativeSessionId, record.current.nativeSessionId);
  assert.equal(JSON.stringify(before), encoded);
  assert.equal(nativeWorkSessionBindingSchema.safeParse(record).success, false);
});

test('contract: migration retry matches exact pair/selection/input hash and never adds a segment', () => {
  const before = binding(),
    data = command(before);
  const { record, result } = appendNativeMigration(before, data);
  assert.deepEqual(inspectNativeMigration(record, structuredClone(data)), {
    ...result,
    status: 'replayed',
  });
  assert.throws(
    () => inspectNativeMigration(record, { ...data, inputFingerprint: 'c'.repeat(64) }),
    { code: 'idempotency-mismatch' },
  );
  assert.throws(
    () =>
      inspectNativeMigration(record, {
        ...data,
        selection: { ...selection, model: 'different-model' },
      }),
    { code: 'idempotency-mismatch' },
  );
  assert.throws(() => inspectNativeMigration(record, { ...data, requestId: 'other-key' }), {
    code: 'scope-mismatch',
  });
  const next = appendNativeMigration(record, command(record, 2)).record;
  assert.throws(() => inspectNativeMigration(next, data), { code: 'migration-conflict' });
});

test('contract: cross-locator, same Run/segment and non-increasing generations refuse', () => {
  const before = binding(),
    data = command(before);
  for (const patch of [
    { actorId: 'other' },
    { spaceId: 'other' },
    { taskId: 'other' },
    { planId: 'other' },
    { revision: 2 },
    { nodeId: 'other' },
    { runId: scope.runId },
    { segmentId: scope.segmentId },
    { generation: scope.generation },
  ])
    assert.throws(
      () => appendNativeMigration(before, { ...data, scope: { ...data.scope, ...patch } }),
      { code: 'scope-mismatch' },
    );
});

test('contract: unknown, incomplete, truncated, duplicated and mismatched timeline records fail closed', () => {
  let record = binding();
  for (let i = 1; i <= 3; i++) record = appendNativeMigration(record, command(record, i)).record;
  const cases = [
    (value) => {
      value.schemaVersion = 3;
    },
    (value) => {
      delete value.current;
    },
    (value) => {
      delete value.prior[0].migration;
    },
    (value) => {
      value.prior.shift();
    },
    (value) => {
      value.prior[1].binding.nativeSessionId = value.prior[0].binding.nativeSessionId;
    },
    (value) => {
      value.prior[0].binding.scope.spaceId = 'other';
    },
    (value) => {
      value.current.selection.model = 'replaced';
    },
    (value) => {
      value.prior[1].migration.requestId = value.prior[0].migration.requestId;
    },
    (value) => {
      value.prior[0].binding.scope.runId = value.current.scope.runId;
    },
  ];
  for (const mutate of cases) {
    const changed = structuredClone(record);
    mutate(changed);
    assert.throws(() => readNativeRecord(changed), { code: 'binding-state-invalid' });
  }
  assert.deepEqual(readNativeRecord(record), record);
});

test('contract: 64 is the total segment count, and capacity never evicts old references', () => {
  let record = binding();
  for (let i = 1; i < NATIVE_LINEAGE_LIMITS.segments; i++)
    record = appendNativeMigration(record, command(record, i)).record;
  assert.equal(record.version, 64);
  assert.equal(record.prior.length, 63);
  const before = JSON.stringify(record);
  assert.throws(() => appendNativeMigration(record, command(record, 65)), { code: 'capacity' });
  assert.equal(JSON.stringify(record), before);
});

test('contract: the aggregate byte cap refuses instead of pruning history', () => {
  let record = binding();
  const receipts = Array.from({ length: 256 }, (_, i) => ({
    requestId: `${i}`.padEnd(200, 'r'),
    messageId: `${i}`.padEnd(200, 'm'),
    fingerprint: 'a'.repeat(64),
    mode: 'queue',
    status: 'received',
  }));
  for (let i = 1; i < 64; i++) {
    const current = currentBinding(record);
    record =
      record.schemaVersion === 1
        ? { ...record, receipts }
        : { ...record, current: { ...current, receipts } };
    if (Buffer.byteLength(JSON.stringify(record)) >= NATIVE_LINEAGE_LIMITS.bytes) {
      assert.throws(() => readNativeRecord(record), { code: 'binding-state-invalid' });
      return;
    }
    const before = JSON.stringify(record);
    try {
      record = appendNativeMigration(record, command(record, i)).record;
    } catch (error) {
      assert.equal(error.code, 'capacity');
      assert.equal(JSON.stringify(record), before);
      return;
    }
  }
  assert.fail('byte capacity must be reached before 64 full receipt sets');
});

async function store(root, spec = nativeWorkSessionDomainSpec) {
  const ctx = new Context();
  try {
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root });
    await ctx.plugin(Domain, { backend: 'json' });
    return { ctx, domain: await ctx.storageDomain.open(spec) };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
test('actual JSON storage: v1 reads without writes, strict old schema refuses v2 without changing bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-migration-record-'));
  const key = nativeWorkSessionKey(scope),
    file = join(root, 'zhuma_native_work_sessions.json');
  const legacy = {
    ...nativeWorkSessionDomainSpec,
    tables: { bindings: { valueSchema: nativeWorkSessionBindingSchema } },
  };
  let host;
  try {
    host = await store(root, legacy);
    await host.domain.table('bindings').put(key, binding());
    await host.ctx.fiber.dispose();
    const oldBytes = await readFile(file);
    host = await store(root);
    assert.deepEqual(host.domain.table('bindings').get(key), binding());
    assert.deepEqual(await readFile(file), oldBytes);
    const record = appendNativeMigration(binding(), command(binding())).record;
    await host.domain.table('bindings').put(key, record);
    await host.ctx.fiber.dispose();
    const newBytes = await readFile(file);
    await assert.rejects(store(root, legacy), { code: 'invalid-record' });
    assert.deepEqual(await readFile(file), newBytes);
    host = await store(root);
    assert.deepEqual(host.domain.table('bindings').get(key), record);
    assert.deepEqual(await readFile(file), newBytes);
  } finally {
    await host?.ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function serviceHarness() {
  let record;
  let writes = 0,
    sends = 0,
    retires = 0;
  const controller = new AbortController();
  const lease = {
    signal: controller.signal,
    basis: 'flushed-and-closed',
    assertCurrent() {
      assert.equal(controller.signal.aborted, false);
    },
  };
  const storage = {
    read: () => record,
    write: async (_key, value) => {
      writes++;
      record = structuredClone(value);
    },
  };
  const runtime = {
    connect: async () => {},
    isConnected: () => false,
    status: () => 'idle',
    send() {
      sends++;
    },
    flush: async () => {},
    stop: async () => 'stopped',
    retire: async () => {
      retires++;
      return lease;
    },
    migrationDrain: () => lease,
    history: async () => [],
    follow: async function* () {},
  };
  const service = new NativeWorkSessionService(storage, runtime);
  return {
    service,
    storage,
    runtime,
    value: () => record,
    writes: () => writes,
    sends: () => sends,
    retires: () => retires,
  };
}
function capability(service, record, count = 1) {
  const data = command(record, count),
    abort = new AbortController(),
    phases = [];
  let boundSignal;
  const cap = {
    ...data,
    signal: abort.signal,
    abort,
    phases,
    assertCurrent(phase) {
      assert.equal(this, cap, 'must retain original authority receiver');
      phases.push(phase);
      assert.equal(abort.signal.aborted, false);
      if (phase === 'migrate') {
        const proof = service.migrationDrain(data.previousScope);
        if (boundSignal)
          assert.equal(
            proof.signal,
            boundSignal,
            'one ready epoch must have stable signal identity',
          );
        boundSignal = proof.signal;
        proof.assertCurrent();
      }
    },
  };
  return cap;
}

function originQuery(record, count = 1) {
  const { previousScope: _previous, ...query } = command(record, count);
  return query;
}

test('contract: origin returns only the actual old scope/selection across skipped unbound Runs, without writes', async () => {
  const h = serviceHarness(),
    old = grant();
  await h.service.send(old, message('old', 'private old input', 'queue'));
  const before = structuredClone(h.value()),
    writes = h.writes(),
    retires = h.retires();
  const query = originQuery(before, 3);
  query.scope.generation = old.scope.generation + 2;
  query.selection = { ...selection, model: 'new-model', configurationId: 'new-config' };
  const result = h.service.migrationOrigin(query);
  assert.deepEqual(result, { scope: before.scope, selection: before.selection });
  assert.deepEqual(Object.keys(result).sort(), ['scope', 'selection']);
  result.scope.runId = 'mutated-copy';
  result.selection.model = 'mutated-copy';
  assert.deepEqual(h.service.migrationOrigin(query), {
    scope: before.scope,
    selection: before.selection,
  });
  assert.deepEqual(h.value(), before);
  assert.equal(h.writes(), writes);
  assert.equal(h.retires(), retires);
  assert.equal(h.sends(), 1);
});

test('contract: committed same-key origin comes from its original receipt; changed hash/key/selection and later current refuse', async () => {
  const h = serviceHarness(),
    old = grant();
  await h.service.send(old, message('old', 'old input', 'queue'));
  const before = structuredClone(h.value()),
    cap = capability(h.service, before);
  await h.service.migrate(cap);
  const query = originQuery(before),
    saved = structuredClone(h.value()),
    writes = h.writes();
  // New service lifetime, but exactly the same persisted row and native runtime.
  const fresh = new NativeWorkSessionService(h.storage, h.runtime);
  assert.deepEqual(fresh.migrationOrigin(query), {
    scope: before.scope,
    selection: before.selection,
  });
  for (const patch of [
    { inputFingerprint: 'f'.repeat(64) },
    { selection: { ...selection, model: 'changed' } },
  ])
    assert.throws(() => fresh.migrationOrigin({ ...query, ...patch }), {
      code: 'idempotency-mismatch',
    });
  assert.throws(() => fresh.migrationOrigin({ ...query, requestId: 'other-key' }), {
    code: 'scope-mismatch',
  });
  assert.deepEqual(h.value(), saved);
  assert.equal(h.writes(), writes);
  await h.service.migrate(capability(h.service, h.value(), 2));
  assert.throws(() => h.service.migrationOrigin(query), { code: 'migration-conflict' });
});

test('contract: origin rejects missing/malformed records, unexpected fields and known native failures instead of soft pending', async () => {
  const h = serviceHarness(),
    query = originQuery(binding());
  assert.throws(() => h.service.migrationOrigin(query), { code: 'not-started' });
  assert.throws(() => h.service.migrationOrigin({ ...query, previousScope: scope }), {
    code: 'invalid-request',
  });
  assert.throws(() => h.service.migrationOrigin({ ...query, requestId: 'x'.repeat(201) }), {
    code: 'invalid-request',
  });
  await h.service.send(grant(), message('old', 'old', 'queue'));
  const before = structuredClone(h.value()),
    writes = h.writes();
  h.runtime.migrationDrain = () => {
    throw new NativeWorkError('unavailable');
  };
  assert.throws(() => h.service.migrationOrigin(query), { code: 'unavailable' });
  assert.equal(h.writes(), writes);
  assert.deepEqual(h.value(), before);
  await h.storage.write('test-only', { ...before, schemaVersion: 99 });
  assert.throws(() => h.service.migrationOrigin(query), { code: 'binding-state-invalid' });
  await h.service.sealInputReads();
  assert.throws(() => h.service.migrationOrigin(query), { code: 'unavailable' });
});

test('contract: origin rejects admitted mutation and source reservations while preserving bytes and counters', async () => {
  const h = serviceHarness(),
    old = grant();
  await h.service.send(old, message('old', 'old', 'queue'));
  const query = originQuery(h.value()),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const write = h.storage.write;
  h.storage.write = async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  };
  const pending = h.service.send(old, message('pending', 'pending', 'queue'));
  try {
    await entered.promise;
    const before = structuredClone(h.value()),
      writes = h.writes();
    assert.throws(() => h.service.migrationOrigin(query), { code: 'unavailable' });
    assert.deepEqual(h.value(), before);
    assert.equal(h.writes(), writes);
  } finally {
    release.resolve();
  }
  await pending;
  h.storage.write = write;
  const ticket = await h.service.reserveInputRead(old),
    before = structuredClone(h.value()),
    writes = h.writes();
  assert.throws(() => h.service.migrationOrigin(query), { code: 'unavailable' });
  assert.deepEqual(h.value(), before);
  assert.equal(h.writes(), writes);
  await h.service.finishInputRead(old, ticket, 0);
  assert.deepEqual(h.service.migrationOrigin(query).scope, old.scope);
});

test('contract: phased migration does not self-deadlock in its metadata slot and same-key concurrency coalesces', async () => {
  const h = serviceHarness(),
    old = grant();
  await h.service.send(old, message('old', 'old input', 'queue'));
  const ticket = await h.service.reserveInputRead(old);
  await h.service.finishInputRead(old, ticket, 700);
  const before = structuredClone(h.value()),
    cap = capability(h.service, before),
    writes = h.writes();
  const results = await Promise.all(Array.from({ length: 5 }, () => h.service.migrate(cap)));
  assert.ok(
    results.every((result) => result.next.nativeSessionId === results[0].next.nativeSessionId),
  );
  assert.equal(h.writes(), writes + 1);
  assert.equal(h.retires(), 1);
  assert.equal(h.sends(), 1);
  assert.deepEqual(h.value().prior[0].binding, before);
  assert.deepEqual(h.service.open(grant(cap.scope)).binding.receipts, []);
  await assert.rejects(h.service.send(old, message('late', 'old drive')), {
    code: 'scope-mismatch',
  });
  const read = grant();
  read.assertCurrent = (action) => {
    assert.ok(['open', 'history', 'follow'].includes(action));
  };
  assert.deepEqual((await h.service.history(read)).binding, before);
  const replay = await h.service.migrate(capability(h.service, before));
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.next.nativeSessionId, results[0].next.nativeSessionId);
  assert.equal(h.writes(), writes + 1);
  assert.ok(cap.phases.includes('prepare') && cap.phases.includes('migrate'));
});

test('contract: prepare authority cannot replace migrate authority, and readiness changes refuse commit', async () => {
  const h = serviceHarness(),
    old = grant();
  await h.service.send(old, message('old', 'old input', 'queue'));
  const cap = capability(h.service, h.value());
  cap.assertCurrent = (phase) => {
    if (phase === 'migrate') throw Error('no-migrate-authority');
  };
  const before = JSON.stringify(h.value()),
    writes = h.writes();
  await assert.rejects(h.service.migrate(cap), /no-migrate-authority/);
  assert.equal(h.retires(), 1);
  assert.equal(h.writes(), writes);
  assert.equal(JSON.stringify(h.value()), before);
  const lease = h.service.migrationDrain(old.scope);
  await assert.rejects(h.service.send(old, message('rejected-old', 'cannot drive retired scope')), {
    code: 'scope-mismatch',
  });
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertCurrent(), { code: 'unavailable' });
});

test('contract: a changed paired grant after awaited cleanup cannot retarget the final mapping', async () => {
  const h = serviceHarness(),
    old = grant();
  await h.service.send(old, message('old', 'old input', 'queue'));
  const cap = capability(h.service, h.value()),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const retire = h.runtime.retire;
  h.runtime.retire = async (...args) => {
    entered.resolve();
    await release.promise;
    return retire(...args);
  };
  const migrating = h.service.migrate(cap);
  await entered.promise;
  cap.scope.nodeId = 'different';
  release.resolve();
  await assert.rejects(migrating, { code: 'scope-mismatch' });
  assert.equal(h.value().schemaVersion, 1);
});

test('contract: ambiguous mapping put fences replay/drive until a new storage lifetime reconciles the same pair', async () => {
  for (const committed of [false, true]) {
    const h = serviceHarness(),
      old = grant();
    await h.service.send(old, message('old', 'old input', 'queue'));
    const cap = capability(h.service, h.value()),
      write = h.storage.write;
    h.storage.write = async (key, value) => {
      if (committed) await write(key, value);
      throw Error('ambiguous-put');
    };
    await assert.rejects(h.service.migrate(cap), { code: 'migration-unknown' });
    const saved = structuredClone(h.value());
    assert.throws(() => h.service.migrationOrigin(originQuery(binding())), {
      code: 'migration-unknown',
    });
    await assert.rejects(async () => h.service.migrate(cap), { code: 'migration-unknown' });
    await assert.rejects(h.service.send(grant(cap.scope), message('blocked', 'do not admit')), {
      code: 'migration-unknown',
    });
    assert.deepEqual(h.value(), saved);
    h.storage.write = write;
    const fresh = new NativeWorkSessionService(h.storage, h.runtime);
    const recovery = {
      ...cap,
      assertCurrent(phase) {
        if (phase === 'migrate') fresh.migrationDrain(cap.previousScope).assertCurrent();
      },
    };
    const result = await fresh.migrate(recovery);
    assert.equal(result.status, committed ? 'replayed' : 'migrated');
    if (committed) assert.equal(result.next.nativeSessionId, saved.current.nativeSessionId);
    assert.equal(h.sends(), 1);
  }
});

test('contract: ordinary new-turn receipt and budget writes preserve every archived segment', async () => {
  const h = serviceHarness(),
    old = grant();
  await h.service.send(old, message('old', 'old input', 'queue'));
  const cap = capability(h.service, h.value());
  await h.service.migrate(cap);
  const archived = structuredClone(h.value().prior),
    next = grant(cap.scope);
  await h.service.send(next, message('new', 'new input', 'queue'));
  const read = await h.service.reserveInputRead(next);
  await h.service.finishInputRead(next, read, 200);
  assert.deepEqual(h.value().prior, archived);
  assert.equal(h.value().current.receipts[0].requestId, 'new');
  assert.deepEqual(h.value().current.inputReadBudget, { attempts: 1, chargedBytes: 200 });
  assert.equal(h.value().prior[0].binding.receipts[0].requestId, 'old');
});

test(
  'contract: migration waits for old send/queue persistence outside its own slot and never changes pointer late',
  { timeout: 10000 },
  async () => {
    const h = serviceHarness(),
      old = grant();
    await h.service.send(old, message('old', 'old input', 'queue'));
    const cap = capability(h.service, h.value()),
      entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const write = h.storage.write;
    let hold = true;
    h.storage.write = async (key, value) => {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
      await write(key, value);
    };
    const sending = h.service.send(old, message('inflight', 'must not drive late', 'queue'));
    // Observe a rejection immediately, even though it is intentionally triggered later.
    const rejected = assert.rejects(sending, { code: 'cancelled' });
    await entered.promise;
    assert.deepEqual(await h.service.migrate(cap), { status: 'pending' });
    assert.throws(() => h.service.migrationOrigin(originQuery(binding())), { code: 'unavailable' });
    assert.equal(h.value().schemaVersion, 1);
    hold = false;
    release.resolve();
    await rejected;
    assert.equal(h.value().schemaVersion, 1);
    assert.equal(h.sends(), 1);
    const moved = await h.service.migrate(cap);
    assert.equal(moved.status, 'migrated');
    assert.equal(h.value().prior[0].binding.receipts.length, 2);
  },
);
