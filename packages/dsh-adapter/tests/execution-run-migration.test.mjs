import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionRunAuthorities } from '../dist/execution-run-authority.js';
import { requestExecutionRunStop, executionRunScope } from '../dist/execution-run-state.js';
import { begin, accepted, applyEvent, locator, stopCommand } from './execution-run-fixture.mjs';

// Contract member issuer and native drain proof only. No real Cookie, C mapping or native driver.
const request = { headers: { cookie: 'contract-member-chen' } };
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function pendingAttempt() {
  let row = accepted();
  row = applyEvent(row, 'failed', { resourcesSettled: true }).record;
  return begin(row, {
    mode: 'retry',
    requestId: 'retry-1',
    newRunId: 'run-2',
    newSegmentId: 'segment-2',
  }).record;
}
function unboundMiddle() {
  const failed = applyEvent(pendingAttempt(), 'failed', { resourcesSettled: true }).record;
  return begin(failed, {
    mode: 'retry',
    requestId: 'retry-3',
    newRunId: 'run-3',
    newSegmentId: 'segment-3',
  }).record;
}
function origin(row) {
  const previous = row.nativeExecution.runs[0];
  return {
    scope: executionRunScope(row, previous),
    selection: structuredClone(previous.selection),
  };
}
function setup({ row = pendingAttempt(), leaseGate } = {}) {
  const sourceLifetime = new AbortController();
  const memberLifetime = new AbortController();
  const drainLifetime = new AbortController();
  const changes = new Set();
  let currentRow = row,
    member = 'chen',
    live = true,
    drained = true,
    pending = false,
    releases = 0,
    expiresAt = Date.now() + 60_000;
  const requestedDrains = [];
  const requestedOrigins = [];
  const source = {
    writerState: () => ({ schemaVersion: 1, nativeExecutionWriter: 1 }),
    signal: sourceLifetime.signal,
    async memberLease(req) {
      await leaseGate?.promise;
      if (req.headers.cookie !== request.headers.cookie) throw Error('PRIVATE_COOKIE_DATA');
      return {
        memberId: member,
        expiresAt,
        signal: memberLifetime.signal,
        assertCurrent(spaceId) {
          if (!live || spaceId !== 'north') throw Error('PRIVATE_MEMBER_DATA');
        },
        release() {
          releases++;
        },
      };
    },
    readNode() {
      return currentRow;
    },
    assertNodeAccess(actorId, spaceId) {
      if (!live || actorId !== 'chen' || spaceId !== 'north') throw Error('PRIVATE_TASK_DATA');
    },
    assertWorkspace(actorId, spaceId, _workspace, _access, configurationId) {
      if (
        !live ||
        actorId !== 'chen' ||
        spaceId !== 'north' ||
        configurationId !== 'configuration-1'
      )
        throw Error('PRIVATE_CONFIGURATION_DATA');
    },
    onChange(check) {
      changes.add(check);
      return () => changes.delete(check);
    },
    migrationOrigin(query) {
      requestedOrigins.push(structuredClone(query));
      return origin(currentRow);
    },
    migrationDrain(previousScope) {
      requestedDrains.push(structuredClone(previousScope));
      if (pending) return undefined;
      return {
        signal: drainLifetime.signal,
        assertCurrent() {
          if (!drained) throw Error('PRIVATE_NATIVE_DRAIN_DATA');
        },
      };
    },
  };
  const manager = new ExecutionRunAuthorities(source);
  return {
    manager,
    source,
    requestedDrains,
    requestedOrigins,
    sourceLifetime,
    memberLifetime,
    drainLifetime,
    get row() {
      return currentRow;
    },
    set row(value) {
      currentRow = value;
    },
    get releases() {
      return releases;
    },
    setMember(value) {
      member = value;
    },
    setExpiry(value) {
      expiresAt = value;
    },
    setPending(value) {
      pending = value;
    },
    loseDrain() {
      drained = false;
    },
    revoke() {
      live = false;
    },
    emit() {
      for (const change of changes) change();
    },
  };
}

test('contract: migration derives immutable durable pair/input/key and initially authorizes only prepare', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  const before = structuredClone(h.row);
  const opened = await h.manager.openMigration(request, locator(h.row));
  const grant = opened.grant;
  assert.equal(grant.requestId, 'retry-1');
  assert.equal(grant.inputFingerprint, 'a'.repeat(64));
  assert.equal(grant.previousScope.runId, 'run-1');
  assert.equal(grant.previousScope.generation, 1);
  assert.equal(grant.scope.runId, 'run-2');
  assert.equal(grant.scope.generation, 2);
  for (const key of ['actorId', 'spaceId', 'taskId', 'planId', 'revision', 'nodeId'])
    assert.equal(grant.previousScope[key], grant.scope[key], key);
  assert.deepEqual(grant.selection, h.row.nativeExecution.runs[1].selection);
  assert.equal(h.requestedDrains.length, 0);
  assert.equal(h.requestedOrigins.length, 1);
  h.manager.assertMigration(grant, 'prepare');
  assert.equal(h.requestedDrains.length, 0, 'prepare never manufactures native readiness');
  h.manager.assertMigration(grant, 'migrate');
  assert.deepEqual(h.requestedDrains, [grant.previousScope]);
  assert.deepEqual(h.row, before);
  assert.equal(h.requestedOrigins.length, 1, 'phase checks must not reenter C metadata slots');
  assert.throws(() => {
    grant.scope.runId = 'injected';
  }, TypeError);
  assert.throws(() => {
    grant.selection.model = 'injected';
  }, TypeError);
  opened.dispose();
  assert.equal(h.releases, 1);
  assert.equal(grant.signal.aborted, true);
});
test('contract: drive/read/cleanup/copied/serialized capabilities cannot migrate, migration cannot satisfy any native driving gate', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  const drive = await h.manager.open(request, locator(h.row), 'drive');
  const read = await h.manager.open(request, locator(h.row), 'read');
  for (const other of [drive.grant, read.grant, drive.cleanup, { assertCurrent() {} }])
    assert.throws(() => h.manager.assertMigration(other, 'prepare'), {
      code: 'run-authority-denied',
    });
  const opened = await h.manager.openMigration(request, locator(h.row));
  for (const other of [JSON.parse(JSON.stringify(opened.grant)), { ...opened.grant }])
    assert.throws(() => h.manager.assertMigration(other, 'migrate'), {
      code: 'run-authority-denied',
    });
  const copied = { ...opened.grant, scope: { ...opened.grant.scope, runId: 'forged-run' } };
  assert.throws(() => copied.assertCurrent('prepare'), { code: 'run-authority-denied' });
  assert.throws(() => copied.assertCurrent('migrate'), { code: 'run-authority-denied' });
  const detached = opened.grant.assertCurrent;
  assert.throws(() => detached('prepare'), { code: 'run-authority-denied' });
  assert.throws(() => h.manager.assertGrant(opened.grant, 'send'), {
    code: 'run-authority-denied',
  });
  for (const action of ['open', 'send', 'queue', 'stop', undefined])
    assert.throws(
      () =>
        action === undefined ? opened.grant.assertCurrent() : opened.grant.assertCurrent(action),
      { code: 'run-authority-denied' },
    );
  assert.throws(() => opened.grant.assertCurrent('prepare', 'migrate'), {
    code: 'run-authority-denied',
  });
  opened.grant.assertCurrent('prepare');
  assert.equal(opened.grant.signal.aborted, false);
});
test('contract: absent or pending native epoch refuses only migrate; real prepare may establish the missing readiness', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  const producer = h.source.migrationDrain;
  delete h.source.migrationDrain;
  const opened = await h.manager.openMigration(request, locator(h.row));
  opened.grant.assertCurrent('prepare');
  assert.throws(() => opened.grant.assertCurrent('migrate'), { code: 'run-authority-unavailable' });
  assert.equal(opened.grant.signal.aborted, false);
  opened.grant.assertCurrent('prepare');
  h.source.migrationDrain = producer;
  h.setPending(true);
  assert.throws(() => opened.grant.assertCurrent('migrate'), { code: 'run-migration-pending' });
  assert.equal(opened.grant.signal.aborted, false);
  opened.grant.assertCurrent('prepare');
  // This is a contract stand-in for C's actual stop/flush/drain/retire completion.
  h.setPending(false);
  opened.grant.assertCurrent('migrate');
  assert.equal(opened.grant.signal.aborted, false);
});
test('contract: malformed or physically invalid native proof never qualifies as a migration epoch', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  const one = await h.manager.openMigration(request, locator(h.row));
  h.loseDrain();
  assert.throws(() => one.grant.assertCurrent('migrate'), {
    code: 'run-authority-denied',
    message: '本地运行操作未完成。',
  });
  assert.equal(one.grant.signal.aborted, true);
  h.source.migrationDrain = () => ({ resourcesSettled: true });
  const two = await h.manager.openMigration(request, locator(h.row));
  assert.throws(() => two.grant.assertCurrent('migrate'), { code: 'run-authority-denied' });
});
test('contract: callers cannot supply a replacement pair, selection, input fingerprint or migration key', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  for (const patch of [
    { requestId: 'different' },
    { previousScope: {} },
    { scope: {} },
    { selection: {} },
    { actorId: 'chen' },
    { inputFingerprint: 'b'.repeat(64) },
  ])
    await assert.rejects(h.manager.openMigration(request, { ...locator(h.row), ...patch }), {
      code: 'run-validation',
    });
});
test('contract: first attempts and already admitted new native work cannot be migrated', async (t) => {
  const h = setup({ row: begin().record });
  t.after(() => h.manager.close());
  await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
    code: 'run-authority-denied',
  });
  h.row = accepted(pendingAttempt());
  await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
    code: 'run-authority-denied',
  });
});
test('contract: unauthorized or revoked members cannot query native pending/drain state', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  h.setMember('outside');
  h.setPending(true);
  await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
    code: 'run-authority-denied',
  });
  assert.equal(h.requestedDrains.length, 0);
  assert.equal(h.requestedOrigins.length, 0);
  h.setMember('chen');
  h.revoke();
  await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
    code: 'run-authority-denied',
  });
  assert.equal(h.requestedDrains.length, 0);
  assert.equal(h.requestedOrigins.length, 0);
});

test('contract: actual origin may precede zero-native attempts; the full B lineage is retained and pinned', async (t) => {
  const h = setup({ row: unboundMiddle() });
  t.after(() => h.manager.close());
  const before = structuredClone(h.row);
  const opened = await h.manager.openMigration(request, locator(h.row));
  assert.equal(opened.grant.previousScope.runId, 'run-1');
  assert.equal(opened.grant.scope.runId, 'run-3');
  assert.deepEqual(h.requestedOrigins[0], {
    requestId: 'retry-3',
    inputFingerprint: 'a'.repeat(64),
    scope: opened.grant.scope,
    selection: opened.grant.selection,
  });
  opened.grant.assertCurrent('prepare');
  opened.grant.assertCurrent('migrate');
  opened.grant.assertCurrent('prepare');
  assert.equal(h.requestedOrigins.length, 1);
  assert.deepEqual(h.row, before);
  h.row = structuredClone(h.row);
  h.row.nativeExecution.runs[1].attempt.payloadHash = 'c'.repeat(64);
  assert.throws(() => opened.grant.assertCurrent('prepare'), { code: 'run-authority-denied' });
  assert.equal(opened.grant.signal.aborted, true);
});

for (const [label, mutate] of [
  [
    'acknowledged',
    (run) => {
      run.attempt.acknowledged = true;
      run.attempt.executorRunId = 'native-middle';
    },
  ],
  [
    'session',
    (run) => {
      run.attempt.sessionId = 'native-middle';
    },
  ],
  [
    'executor',
    (run) => {
      run.attempt.executorRunId = 'native-middle';
    },
  ],
  [
    'discarded session',
    (run) => {
      run.attempt.sessionDiscarded = true;
    },
  ],
  [
    'received',
    (run) => {
      run.dispatch = 'received';
    },
  ],
  [
    'unknown',
    (run) => {
      run.dispatch = 'unknown';
    },
  ],
  [
    'resource held',
    (run) => {
      run.resources = 'held';
    },
  ],
  [
    'nonterminal',
    (run) => {
      run.attempt.status = 'requested';
    },
  ],
  [
    'other actor',
    (run) => {
      run.actorId = 'outside';
    },
  ],
  [
    'other space',
    (run) => {
      run.spaceId = 'south';
    },
  ],
])
  test(`contract: an intermediate attempt with ${label} cannot be skipped`, async (t) => {
    const row = unboundMiddle();
    const target = locator(row);
    mutate(row.nativeExecution.runs[1]);
    const h = setup({ row });
    t.after(() => h.manager.close());
    await assert.rejects(h.manager.openMigration(request, target));
  });

for (const field of [
  'actorId',
  'spaceId',
  'taskId',
  'planId',
  'revision',
  'nodeId',
  'runId',
  'generation',
  'segmentId',
])
  test(`contract: the C origin must match B's complete ${field}`, async (t) => {
    const h = setup({ row: unboundMiddle() });
    t.after(() => h.manager.close());
    h.source.migrationOrigin = () => {
      const value = origin(h.row);
      value.scope = {
        ...value.scope,
        [field]: typeof value.scope[field] === 'number' ? value.scope[field] + 1 : 'foreign',
      };
      return value;
    };
    await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
      code: 'run-authority-denied',
    });
  });

for (const field of ['provider', 'model', 'reasoningEffort', 'maxTokens', 'configurationId'])
  test(`contract: C's old ${field} must match B's frozen old configuration`, async (t) => {
    const h = setup();
    t.after(() => h.manager.close());
    h.source.migrationOrigin = () => {
      const value = origin(h.row);
      value.selection[field] = field === 'maxTokens' ? 123 : 'other';
      return value;
    };
    await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
      code: 'run-authority-denied',
    });
  });

test('contract: missing, malformed, busy or unknown origin never falls back to an adjacent B attempt', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  for (const producer of [
    undefined,
    () => undefined,
    () => ({}),
    () => ({ ...origin(h.row), extra: true }),
    () => {
      throw Object.assign(Error('PRIVATE_MAPPING'), { code: 'migration-unknown' });
    },
    () => {
      throw Object.assign(Error('PRIVATE_OWNER'), { code: 'unavailable' });
    },
  ]) {
    h.source.migrationOrigin = producer;
    await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
      code: 'run-authority-denied',
    });
  }
  const read = await h.manager.open(request, locator(h.row), 'read');
  read.grant.assertCurrent('history');
});

test('contract: aborted member and B access/config failures precede any C origin lookup', async (t) => {
  for (const deny of [
    (h) => h.memberLifetime.abort(),
    (h) => h.setExpiry(Date.now() - 1),
    (h) => {
      h.source.assertNodeAccess = () => {
        throw Error('PRIVATE_TASK');
      };
    },
    (h) => {
      h.source.assertWorkspace = () => {
        throw Error('PRIVATE_WORKSPACE');
      };
    },
  ]) {
    const h = setup();
    t.after(() => h.manager.close());
    deny(h);
    await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
      code: 'run-authority-denied',
    });
    assert.equal(h.requestedOrigins.length, 0);
  }
});

test('contract: origin producer replacement and changed begin receipt revoke a pinned migration', async (t) => {
  const h = setup({ row: unboundMiddle() });
  t.after(() => h.manager.close());
  const one = await h.manager.openMigration(request, locator(h.row));
  h.source.migrationOrigin = () => origin(h.row);
  assert.throws(() => one.grant.assertCurrent('prepare'), { code: 'run-authority-denied' });
  const two = await h.manager.openMigration(request, locator(h.row));
  h.row = structuredClone(h.row);
  h.row.nativeExecution.receipts.find((receipt) => receipt.requestId === 'retry-3').fingerprint =
    'c'.repeat(64);
  assert.throws(() => two.grant.assertCurrent('prepare'), { code: 'run-authority-denied' });
});

test('contract: reentrant origin lookup cannot silently switch the authorized new target', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  h.source.migrationOrigin = () => {
    const value = origin(h.row);
    h.row = structuredClone(h.row);
    h.row.nativeExecution.runs[1].attempt.payloadHash = 'c'.repeat(64);
    return value;
  };
  await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
    code: 'run-authority-denied',
  });
});
for (const [label, mutate] of [
  [
    'old actor',
    (row) => {
      row.nativeExecution.runs[0].actorId = 'outside';
    },
  ],
  [
    'old space',
    (row) => {
      row.nativeExecution.runs[0].spaceId = 'south';
    },
  ],
  [
    'new configuration',
    (row) => {
      row.nativeExecution.runs[1].selection.model = 'changed';
    },
  ],
  [
    'old immutable input',
    (row) => {
      row.nativeExecution.runs[0].attempt.payloadHash = 'b'.repeat(64);
    },
  ],
  [
    'new begin lineage',
    (row) => {
      row.nativeExecution.runs[1].attempt.idempotencyKey = 'not-stored';
    },
  ],
])
  test(`contract: both migration phases recheck ${label} from the current persistent pair`, async (t) => {
    const h = setup();
    t.after(() => h.manager.close());
    const opened = await h.manager.openMigration(request, locator(h.row));
    h.row = structuredClone(h.row);
    mutate(h.row);
    assert.throws(() => opened.grant.assertCurrent('prepare'), { code: 'run-authority-denied' });
    assert.equal(opened.grant.signal.aborted, true);
  });
for (const [label, invalidate] of [
  [
    'member removal',
    (h) => {
      h.revoke();
      h.emit();
    },
  ],
  ['member abort', (h) => h.memberLifetime.abort()],
  ['native drain abort', (h) => h.drainLifetime.abort()],
  ['native drain lost without an event', (h) => h.loseDrain()],
  [
    'native drain producer replaced',
    (h) => {
      h.source.migrationDrain = () => undefined;
    },
  ],
  [
    'new Run stop',
    (h) => {
      h.row = requestExecutionRunStop(h.row, stopCommand(h.row)).record;
      h.emit();
    },
  ],
  ['Host unmount', (h) => h.sourceLifetime.abort()],
])
  test(`contract: ${label} revokes the bound migration epoch without modifying persistent state`, async (t) => {
    const h = setup();
    t.after(() => h.manager.close());
    const opened = await h.manager.openMigration(request, locator(h.row));
    opened.grant.assertCurrent('migrate');
    invalidate(h);
    const current = structuredClone(h.row);
    assert.throws(() => opened.grant.assertCurrent('migrate'), { code: 'run-authority-denied' });
    assert.equal(opened.grant.signal.aborted, true);
    assert.deepEqual(h.row, current);
  });
test('contract: expiry revokes a preparation/migration waiting in native I/O', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  h.setExpiry(Date.now() + 60);
  const opened = await h.manager.openMigration(request, locator(h.row));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('migration expiry missing')), 1000);
    opened.grant.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
  assert.throws(() => h.manager.assertMigration(opened.grant, 'prepare'), {
    code: 'run-authority-denied',
  });
  assert.equal(h.releases, 1);
});
test('contract: close drains delayed phase-capability issuance; repeated issuance derives one stable key/pair', async () => {
  const h = setup();
  const one = await h.manager.openMigration(request, locator(h.row));
  const two = await h.manager.openMigration(request, locator(h.row));
  assert.equal(one.grant.requestId, two.grant.requestId);
  assert.deepEqual(one.grant.scope, two.grant.scope);
  await h.manager.close();
  assert.equal(one.grant.signal.aborted, true);
  assert.equal(two.grant.signal.aborted, true);
  const gate = deferred();
  const late = setup({ leaseGate: gate });
  const opening = late.manager.openMigration(request, locator(late.row));
  const rejection = assert.rejects(opening, { code: 'run-authority-denied' });
  await Promise.resolve();
  let done = false;
  const closing = late.manager.close();
  closing.then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  gate.resolve();
  await rejection;
  await closing;
  assert.equal(late.releases, 1);
});
