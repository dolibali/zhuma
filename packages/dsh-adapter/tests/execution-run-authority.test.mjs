import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionRunAuthorities } from '../dist/execution-run-authority.js';
import { executionRunScope, requestExecutionRunStop } from '../dist/execution-run-state.js';
import {
  begin,
  accepted,
  applyEvent,
  stable,
  stopCommand,
  locator,
  localWorkspace,
} from './execution-run-fixture.mjs';

// Contract source only. These strings are not real cookies and this does not certify B's issuer.
const request = { headers: { cookie: 'synthetic-member-chen' } };
const outside = { headers: { cookie: 'synthetic-member-outside' } };
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup({ row = accepted(), leaseGate, onRelease } = {}) {
  const lifetime = new AbortController();
  const leases = [];
  const listeners = new Set();
  let currentRow = row,
    current = true,
    member = true,
    workspace = true,
    releases = 0,
    expiresAt = Date.now() + 60_000;
  const source = {
    writerState: () => ({ schemaVersion: 1, nativeExecutionWriter: 1 }),
    signal: lifetime.signal,
    async memberLease(req) {
      await leaseGate?.promise;
      const memberId =
        req.headers.cookie === request.headers.cookie
          ? 'chen'
          : req.headers.cookie === outside.headers.cookie
            ? 'outside'
            : undefined;
      if (!memberId) throw Error('PRIVATE_COOKIE_FAILURE');
      const controller = new AbortController();
      leases.push(controller);
      return {
        memberId,
        expiresAt,
        signal: controller.signal,
        assertCurrent(spaceId) {
          if (!current || !member || spaceId !== 'north') throw Error('PRIVATE_SESSION_DATA');
        },
        release() {
          releases++;
          onRelease?.();
        },
      };
    },
    readNode() {
      return currentRow;
    },
    assertNodeAccess(memberId, spaceId, node, action) {
      if (!current || !member || spaceId !== 'north') throw Error('PRIVATE_TASK_DATA');
      if (['send', 'queue', 'stop'].includes(action) && memberId !== node.handoff.assignee.id)
        throw Error('PRIVATE_CONTROLLER_DATA');
    },
    assertWorkspace(_memberId, _spaceId, _selection, _access, configurationId) {
      if (!workspace || configurationId !== 'configuration-1') throw Error('PRIVATE_ROOT_PATH');
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const manager = new ExecutionRunAuthorities(source);
  return {
    manager,
    source,
    leases,
    lifetime,
    get row() {
      return currentRow;
    },
    set row(value) {
      currentRow = value;
    },
    get releases() {
      return releases;
    },
    get listeners() {
      return listeners.size;
    },
    setExpires(value) {
      expiresAt = value;
    },
    invalidate() {
      current = false;
      for (const fn of listeners) fn();
    },
    revokeMembership() {
      member = false;
      for (const fn of listeners) fn();
    },
    revokeWorkspace() {
      workspace = false;
      for (const fn of listeners) fn();
    },
    emit() {
      for (const fn of listeners) fn();
    },
  };
}

test('contract: authority requires all live source ports; snapshots and serialized grants do not authorize', async (t) => {
  assert.throws(() => new ExecutionRunAuthorities({ memberId: 'chen', spaceIds: ['north'] }), {
    code: 'run-authority-unavailable',
  });
  const h = setup();
  t.after(() => h.manager.close());
  await assert.rejects(h.manager.open({ headers: {} }, locator(h.row), 'drive'), {
    code: 'run-authority-denied',
    message: '本地运行操作未完成。',
  });
  const owned = await h.manager.open(request, locator(h.row), 'drive');
  h.manager.assertGrant(owned.grant, 'send');
  assert.throws(() => h.manager.assertGrant(JSON.parse(JSON.stringify(owned.grant)), 'send'), {
    code: 'run-authority-denied',
  });
  assert.throws(() => {
    owned.grant.scope.actorId = 'outside';
  }, TypeError);
  assert.equal(owned.grant.scope.actorId, 'chen');
});
test('contract: controller identity is live; another task member may only get a read capability', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  await assert.rejects(h.manager.open(outside, locator(h.row), 'drive'), {
    code: 'run-authority-denied',
  });
  const read = await h.manager.open(outside, locator(h.row), 'read');
  // Scope identifies the recorded Run owner; it does not impersonate the authenticated reader.
  assert.equal(read.grant.scope.actorId, 'chen');
  read.grant.assertCurrent('history');
  assert.throws(() => read.grant.assertCurrent('send'), { code: 'run-authority-denied' });
  assert.equal(read.grant.signal.aborted, false);
  read.grant.assertCurrent('history');
});
for (const [name, revoke] of [
  ['logout/session/source replacement', (h) => h.invalidate()],
  ['membership removal', (h) => h.revokeMembership()],
  ['workspace revocation', (h) => h.revokeWorkspace()],
  ['member lease abort', (h) => h.leases[0].abort()],
  ['Host lifetime', (h) => h.lifetime.abort()],
])
  test(`contract: ${name} aborts existing native authority and releases subscriptions`, async (t) => {
    const h = setup({ row: accepted(begin(undefined, { workspace: localWorkspace }).record) });
    t.after(() => h.manager.close());
    const owned = await h.manager.open(request, locator(h.row), 'drive');
    revoke(h);
    assert.equal(owned.grant.signal.aborted, true);
    assert.throws(() => owned.grant.assertCurrent('send'), { code: 'run-authority-denied' });
    owned.dispose();
    assert.equal(h.releases, 1);
  });
test('contract: synchronous pre-tool gates reject a changed workspace/configuration even without a change hint', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  const owned = await h.manager.open(request, locator(h.row), 'drive');
  h.row = structuredClone(h.row);
  h.row.nativeExecution.runs[0].selection.configurationId = 'configuration-replaced';
  h.row.nativeExecution.runs[0].attempt.configSnapshotId = 'configuration-replaced';
  assert.throws(() => owned.grant.assertCurrent('send'), { code: 'run-authority-denied' });
  assert.equal(owned.grant.signal.aborted, true);
});
test('contract: stopping denies new driving while preserving the stop wait and independent cleanup', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  const owned = await h.manager.open(request, locator(h.row), 'drive');
  h.row = requestExecutionRunStop(h.row, stopCommand(h.row)).record;
  h.emit();
  assert.throws(() => owned.grant.assertCurrent('send'), { code: 'run-authority-denied' });
  assert.equal(owned.grant.signal.aborted, false);
  owned.grant.assertCurrent('stop');
  h.manager.assertCleanup(owned.cleanup, 'stopped');
  h.row = applyEvent(h.row, 'stopped', stable).record;
  h.emit();
  assert.equal(owned.grant.signal.aborted, true);
});
test('contract: an expired member interrupts native authority without waiting for the next request', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  h.setExpires(Date.now() + 60);
  const owned = await h.manager.open(request, locator(h.row), 'drive');
  const aborted = new Promise((resolve) =>
    owned.grant.signal.addEventListener('abort', resolve, { once: true }),
  );
  await Promise.race([
    aborted,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('expiry not observed')), 1000);
      timer.unref();
    }),
  ]);
  assert.equal(owned.grant.signal.aborted, true);
  assert.equal(h.releases, 1);
});
test('contract: revoked driving cannot finalize products, but its internal cleanup can settle the exact old Run', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  const owned = await h.manager.open(request, locator(h.row), 'drive');
  h.invalidate();
  h.manager.assertCleanup(owned.cleanup, 'failed');
  assert.throws(() => owned.cleanup.assertCurrent('completed'), { code: 'run-authority-denied' });
  assert.throws(() => h.manager.assertCleanup({ ...owned.cleanup }, 'cleanup'), {
    code: 'run-authority-denied',
  });
  h.row = applyEvent(h.row, 'failed', { resourcesSettled: false }).record;
  h.manager.assertCleanup(owned.cleanup, 'cleanup');
  h.row = applyEvent(h.row, 'cleanup', stable).record;
  await h.manager.close();
  assert.throws(() => h.manager.assertCleanup(owned.cleanup, 'cleanup'), {
    code: 'run-authority-denied',
  });
});
test('contract: terminal history can be authorized afresh without keeping old driving authority alive', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  const owned = await h.manager.open(request, locator(h.row), 'drive');
  h.row = applyEvent(h.row, 'completed', stable).record;
  h.emit();
  assert.equal(owned.grant.signal.aborted, true);
  const read = await h.manager.open(outside, locator(h.row), 'read');
  read.grant.assertCurrent('history');
  assert.equal(read.grant.scope.runId, 'run-1');
  await assert.rejects(h.manager.open(request, locator(h.row), 'drive'), {
    code: 'run-authority-denied',
  });
});
test('contract: close fences immediately and drains an admitted delayed resolver, releasing its late lease', async () => {
  const gate = deferred();
  const h = setup({ leaseGate: gate });
  const opening = h.manager.open(request, locator(h.row), 'drive');
  const rejection = assert.rejects(opening, { code: 'run-authority-denied' });
  await Promise.resolve();
  let closed = false;
  const closing = h.manager.close();
  closing.then(() => {
    closed = true;
  });
  assert.equal(h.manager.close(), closing);
  await Promise.resolve();
  assert.equal(closed, false);
  await assert.rejects(h.manager.open(request, locator(h.row), 'drive'), {
    code: 'run-authority-denied',
  });
  gate.resolve();
  await rejection;
  await closing;
  assert.equal(h.releases, 1);
  assert.equal(h.listeners, 0);
});
test('contract: reentrant close from lease release returns the same closing promise', async () => {
  let h, reentrant;
  h = setup({
    onRelease: () => {
      reentrant = h.manager.close();
    },
  });
  await h.manager.open(request, locator(h.row), 'drive');
  const closing = h.manager.close();
  assert.equal(reentrant, closing);
  await closing;
});

test('contract: a post-commit expired member cannot strand the reserved Run; cleanup never creates a missing Run', async (t) => {
  const h = setup({ row: begin().record });
  t.after(() => h.manager.close());
  const cleanup = h.manager.cleanupAfterCommit(locator(h.row));
  h.setExpires(Date.now() - 1);
  await assert.rejects(h.manager.open(request, locator(h.row), 'drive'), {
    code: 'run-authority-denied',
  });
  h.manager.assertCleanup(cleanup, 'failed');
  assert.throws(() => h.manager.cleanupAfterCommit({ ...locator(h.row), runId: 'missing' }), {
    code: 'run-authority-denied',
  });
  assert.throws(() => cleanup.assertCurrent('completed'), { code: 'run-authority-denied' });
});

test('contract: a fresh owner may only recheck cleanup for the exact settled terminal Run', async (t) => {
  const row = applyEvent(accepted(), 'completed', stable).record;
  const h = setup({ row });
  const other = setup({ row: structuredClone(row) });
  t.after(() => Promise.all([h.manager.close(), other.manager.close()]));
  const before = JSON.stringify(h.row);
  // The existing post-commit capability is still restricted to held Runs.
  assert.throws(() => h.manager.cleanupAfterCommit(locator(h.row)), {
    code: 'run-authority-denied',
  });
  const cleanup = h.manager.cleanupAfterSettlement(locator(h.row));
  h.manager.assertCleanup(cleanup, 'cleanup');
  assert.equal(Object.isFrozen(cleanup.scope), true);
  for (const action of ['failed', 'stop-pending', 'stopped', 'completed'])
    assert.throws(() => cleanup.assertCurrent(action), { code: 'run-authority-denied' });
  for (const action of ['send', 'queue', 'history', 'open'])
    assert.throws(() => h.manager.assertGrant(cleanup, action), {
      code: 'run-authority-denied',
    });
  for (const copied of [{ ...cleanup }, JSON.parse(JSON.stringify(cleanup))])
    assert.throws(() => h.manager.assertCleanup(copied, 'cleanup'), {
      code: 'run-authority-denied',
    });
  assert.throws(() => other.manager.assertCleanup(cleanup, 'cleanup'), {
    code: 'run-authority-denied',
  });
  assert.equal(h.leases.length, 0, 'internal cleanup must not issue a drive/member grant');
  assert.equal(JSON.stringify(h.row), before, 'qualification must not change persisted facts');
});

test('contract: settled recovery refuses unknown, active, changed, fenced and closed scopes', async (t) => {
  const h = setup();
  t.after(() => h.manager.close());
  assert.throws(() => h.manager.cleanupAfterSettlement(locator(h.row)), {
    code: 'run-authority-denied',
  });
  h.row = applyEvent(h.row, 'completed', stable).record;
  assert.throws(() => h.manager.cleanupAfterSettlement({ ...locator(h.row), runId: 'missing' }), {
    code: 'run-authority-denied',
  });
  const cleanup = h.manager.cleanupAfterSettlement(locator(h.row));
  const frozen = structuredClone(h.row);
  h.row = structuredClone(frozen);
  h.row.nativeExecution.runs[0].selection.model = 'changed-model';
  assert.throws(() => h.manager.assertCleanup(cleanup, 'cleanup'), {
    code: 'run-authority-denied',
  });
  h.row = frozen;
  h.manager.assertCleanup(cleanup, 'cleanup');
  h.manager.fence();
  assert.throws(() => h.manager.cleanupAfterSettlement(locator(h.row)), {
    code: 'run-authority-denied',
  });
  // Existing cleanup still drains during close, exactly like the old hook.
  h.manager.assertCleanup(cleanup, 'cleanup');
  await h.manager.close();
  assert.throws(() => h.manager.assertCleanup(cleanup, 'cleanup'), {
    code: 'run-authority-denied',
  });
  assert.throws(() => h.manager.cleanupAfterSettlement(locator(h.row)), {
    code: 'run-authority-denied',
  });
});

function historicalPair({ active = false } = {}) {
  const previous = applyEvent(accepted(), 'completed', stable).record;
  const oldLocator = locator(previous);
  let row = accepted(
    begin(previous, {
      requestId: 'revision-run',
      newRunId: 'run-2',
      newSegmentId: 'segment-2',
    }).record,
  );
  if (!active) row = applyEvent(row, 'completed', stable).record;
  return { row, oldLocator };
}

test('contract: a settled historical reservation grants only exact old-scope cleanup without broadening existing recovery', async (t) => {
  const { row, oldLocator } = historicalPair();
  const h = setup({ row });
  const other = setup({ row: structuredClone(row) });
  t.after(() => Promise.all([h.manager.close(), other.manager.close()]));
  const before = JSON.stringify(row);
  assert.throws(() => h.manager.cleanupAfterSettlement(oldLocator), {
    code: 'run-authority-denied',
  });
  const cleanup = h.manager.cleanupSettledHistoricalReservation(oldLocator, 'run-2');
  assert.deepEqual(cleanup.scope, executionRunScope(row, row.nativeExecution.runs[0]));
  assert(Object.isFrozen(cleanup.scope));
  h.manager.assertCleanup(cleanup, 'cleanup');
  for (const kind of ['failed', 'stop-pending', 'stopped', 'completed', 'send', 'history'])
    assert.throws(() => cleanup.assertCurrent(kind), { code: 'run-authority-denied' });
  for (const kind of ['open', 'send', 'queue', 'stop', 'history', 'follow'])
    assert.throws(() => h.manager.assertGrant(cleanup, kind), { code: 'run-authority-denied' });
  assert.throws(() => h.manager.assertCleanup({ ...cleanup }, 'cleanup'), {
    code: 'run-authority-denied',
  });
  assert.throws(() => ({ ...cleanup }).assertCurrent('cleanup'), { code: 'run-authority-denied' });
  assert.throws(() => other.manager.assertCleanup(cleanup, 'cleanup'), {
    code: 'run-authority-denied',
  });
  assert.equal(h.leases.length, 0);
  assert.equal(JSON.stringify(h.row), before);
  const originalCurrent = h.manager.cleanupAfterSettlement(locator(row));
  h.manager.fence();
  h.manager.assertCleanup(originalCurrent, 'cleanup');
  assert.throws(() => h.manager.assertCleanup(cleanup, 'cleanup'), {
    code: 'run-authority-denied',
  });
});

test('contract: historical cleanup refuses changed old/current Runs or a new state epoch across an awaited cleanup', async (t) => {
  for (const change of [
    (row) => {
      row.nativeExecution.runs[0].attempt.sessionId = 'changed-old-scope';
      return row;
    },
    (row) => {
      row.nativeExecution.runs[1].selection.model = 'changed-current-model';
      return row;
    },
    (row) => {
      row.nativeExecution.version++;
      return row;
    },
    (row) =>
      applyEvent(
        accepted(
          begin(row, {
            requestId: 'third',
            newRunId: 'run-3',
            newSegmentId: 'segment-3',
          }).record,
        ),
        'completed',
        stable,
      ).record,
  ]) {
    const { row, oldLocator } = historicalPair();
    const h = setup({ row });
    t.after(() => h.manager.close());
    const cleanup = h.manager.cleanupSettledHistoricalReservation(oldLocator, 'run-2');
    await Promise.resolve();
    h.row = change(structuredClone(row));
    assert.throws(() => h.manager.assertCleanup(cleanup, 'cleanup'), {
      code: 'run-authority-denied',
    });
    h.row = row;
    assert.throws(() => h.manager.assertCleanup(cleanup, 'cleanup'), {
      code: 'run-authority-denied',
    });
  }
});

test('contract: historical cleanup refuses active/current/missing targets and writer/source/fence/close loss', async (t) => {
  const { row, oldLocator } = historicalPair({ active: true });
  const active = setup({ row });
  t.after(() => active.manager.close());
  assert.throws(() => active.manager.cleanupSettledHistoricalReservation(oldLocator, 'run-2'), {
    code: 'run-authority-denied',
  });
  for (const invalidate of [
    (h) => {
      h.source.writerState = () => ({ schemaVersion: 1 });
    },
    (h) => {
      h.source.signal = new AbortController().signal;
    },
    (h) => h.manager.fence(),
    (h) => {
      void h.manager.close();
    },
  ]) {
    const pair = historicalPair();
    const h = setup({ row: pair.row });
    t.after(() => h.manager.close());
    for (const [target, expected] of [
      [pair.oldLocator, 'missing'],
      [locator(pair.row), 'run-2'],
      [{ ...pair.oldLocator, nodeId: 'other' }, 'run-2'],
    ])
      assert.throws(() => h.manager.cleanupSettledHistoricalReservation(target, expected), {
        code: 'run-authority-denied',
      });
    const cleanup = h.manager.cleanupSettledHistoricalReservation(pair.oldLocator, 'run-2');
    invalidate(h);
    assert.throws(() => h.manager.assertCleanup(cleanup, 'cleanup'), {
      code: 'run-authority-denied',
    });
    assert.throws(() => h.manager.cleanupSettledHistoricalReservation(pair.oldLocator, 'run-2'), {
      code: 'run-authority-denied',
    });
  }
});
