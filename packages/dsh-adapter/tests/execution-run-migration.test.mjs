import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionRunAuthorities } from '../dist/execution-run-authority.js';
import { requestExecutionRunStop } from '../dist/execution-run-state.js';
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
  h.manager.assertMigration(grant, 'prepare');
  assert.equal(h.requestedDrains.length, 0, 'prepare never manufactures native readiness');
  h.manager.assertMigration(grant, 'migrate');
  assert.deepEqual(h.requestedDrains, [grant.previousScope]);
  assert.deepEqual(h.row, before);
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
  h.setMember('chen');
  h.revoke();
  await assert.rejects(h.manager.openMigration(request, locator(h.row)), {
    code: 'run-authority-denied',
  });
  assert.equal(h.requestedDrains.length, 0);
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
