/** Actual original backend/JSON lineage; local private issuer and drain below
 * are explicit qualification contracts, not C's actual SDK migration acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalPayload, remoteRunViewSchema } from '@zhuma/agent-core';
import { fileHost, ok, no } from './remote-run-files-fixture.mjs';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { RemoteRunMigrationAuthorities } from '../dist/remote-run-migration-authority.js';

const nativeScope = ({ backendId: _backend, ...scope }) => scope;
async function lineage(t) {
  const h = await fileHost(t);
  await h.begin();
  const first = h.view;
  const stopped = ok(
    await h.send(
      h.envelope('stop', {
        scope: first.scope,
        expectedNodeVersion: first.nodeVersion,
        expectedRunVersion: first.runVersion,
      }),
    ),
  );
  ok(
    await h.send(
      h.envelope('cleanup', {
        scope: first.scope,
        permit: h.cleanup.public,
        observation: {
          sequence: stopped.nextSequence,
          kind: 'drained',
          evidence: {
            basis: 'flushed-and-closed',
            nativeSessionId: 'file-native',
            nativeAgentId: 'file-agent',
          },
        },
      }),
      { secret: h.cleanup.raw, request: { headers: {} } },
    ),
  );
  const second = ok(await h.send(h.accept({ mode: 'restart' })));
  ok(
    await h.send(
      h.envelope('cleanup', {
        scope: second.scope,
        permit: h.cleanup.public,
        observation: {
          sequence: second.nextSequence,
          kind: 'drained',
          evidence: { basis: 'absent-unadmitted' },
        },
      }),
      { secret: h.cleanup.raw, request: { headers: {} } },
    ),
  );
  const third = ok(await h.send(h.accept({ mode: 'restart' })));
  const status = ok(
    await h.send(h.envelope('status', { scope: third.scope, permit: h.drive.public })),
  );
  return { ...h, first, second, third, status };
}
function qualifier(t, h) {
  const lifetime = new AbortController(),
    drivingLife = new AbortController(),
    drainLife = new AbortController();
  const driving = Object.freeze({
    scope: nativeScope(h.third.scope),
    signal: drivingLife.signal,
    assertCurrent() {
      assert.fail('do not trust the supplied grant callback');
    },
  });
  const original = new WeakSet([driving]);
  let view = h.status,
    selection = h.third.selection,
    ready = false,
    origins = 0,
    checks = 0,
    replaced = false;
  const old = h.third.migration.predecessors[0];
  const source = {
    signal: lifetime.signal,
    assertGrant(grant) {
      if (!original.has(grant) || drivingLife.signal.aborted) throw Error('PRIVATE_ISSUER_DENIED');
      return undefined;
    },
    current() {
      return { view, selection };
    },
    migrationOrigin(query) {
      origins++;
      assert.deepEqual(query.scope, driving.scope);
      return { scope: nativeScope(old.scope), selection: old.selection };
    },
    migrationDrain(scope) {
      assert.deepEqual(scope, nativeScope(old.scope));
      return ready
        ? {
            signal: drainLife.signal,
            basis: 'flushed-and-closed',
            assertCurrent() {
              checks++;
              if (replaced || drainLife.signal.aborted) throw Error('PRIVATE_NATIVE_DRAIN_REVOKED');
            },
          }
        : undefined;
    },
  };
  const issuer = new RemoteRunMigrationAuthorities(source);
  t.after(() => issuer.close());
  return {
    source,
    issuer,
    driving,
    drivingLife,
    lifetime,
    drainLife,
    ready() {
      ready = true;
    },
    origins: () => origins,
    checks: () => checks,
    setView(value) {
      const {
        disposition: _disposition,
        shared: _shared,
        selection: _selection,
        ...status
      } = value;
      view = status;
    },
    setSelection(value) {
      selection = value;
    },
    revokeDrain() {
      replaced = true;
    },
  };
}

test('remote migration: actual durable gen1→gen2-unadmitted→gen3 projection is fixed, read only and never fabricates a missing SID', async (t) => {
  const h = await lineage(t),
    migration = h.third.migration;
  assert.equal(h.third.scope.generation, 3);
  assert.equal(migration.predecessors.length, 2);
  const runs = h.read().nativeExecution.runs;
  assert.equal(migration.requestId, runs[2].attempt.idempotencyKey);
  assert.equal(migration.inputFingerprint, runs[2].attempt.payloadHash);
  assert.deepEqual(migration.predecessors[0].scope, h.first.scope);
  assert.deepEqual(migration.predecessors[0].selection, runs[0].selection);
  assert.equal(migration.predecessors[1].nativeSessionId, undefined);
  assert.equal(migration.predecessors[1].nativeAgentId, undefined);
  assert.equal(migration.predecessors[1].dispatch, 'reserved');
  assert.equal(migration.predecessors[1].resources, 'settled');
  const before = canonicalPayload(h.read());
  h.resetCounts();
  const status = ok(
    await h.send(h.envelope('status', { scope: h.third.scope, permit: h.drive.public })),
  );
  assert.deepEqual(status.migration, migration);
  assert.equal(canonicalPayload(h.read()), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert(!JSON.stringify(migration).includes('grantId'));
  assert(!JSON.stringify(migration).includes('publicKey'));
  assert(!JSON.stringify(migration).includes('sha256'));
  const q = qualifier(t, h),
    opened = q.issuer.open(q.driving),
    grant = opened.grant;
  assert.deepEqual(grant.previousScope, nativeScope(h.first.scope));
  assert.deepEqual(grant.scope, nativeScope(h.third.scope));
  assert.equal(grant.requestId, migration.requestId);
  assert.equal(grant.inputFingerprint, migration.inputFingerprint);
  q.issuer.assertMigration(grant, 'prepare');
  assert.equal(q.origins(), 1);
  assert.equal(q.checks(), 0);
  assert.throws(() => q.issuer.assertMigration(grant, 'migrate'), {
    code: 'run-migration-pending',
  });
  q.ready();
  q.issuer.assertMigration(grant, 'migrate');
  assert(q.checks() > 0);
  assert.equal(q.origins(), 1, 'origin is not looked up inside native mapping slots');
  opened.dispose();
  assert.throws(() => q.issuer.assertMigration(grant, 'prepare'));
});

test('remote migration: a decoded read handle, copied closure and unsupported phase never become migration authority', async (t) => {
  const h = await lineage(t),
    q = qualifier(t, h);
  assert.throws(() => q.issuer.open({ ...q.driving }));
  const { grant } = q.issuer.open(q.driving);
  assert.throws(() => q.issuer.assertMigration({ ...grant }, 'prepare'));
  assert.throws(() => grant.assertCurrent.call({ ...grant }, 'prepare'));
  assert.throws(() => grant.assertCurrent('send'));
  assert.throws(() => grant.assertCurrent());
  q.issuer.assertMigration(grant, 'prepare');
});

for (const mutation of [
  'backend',
  'device',
  'actor',
  'space',
  'generation-gap',
  'held',
  'intermediate-native',
  'selection',
  'read-only',
])
  test(`remote migration: ${mutation} mismatch refuses the entire pair`, async (t) => {
    const h = await lineage(t),
      q = qualifier(t, h),
      value = structuredClone(h.third);
    if (mutation === 'backend')
      value.migration.predecessors[0].scope.backendId = '00000000-0000-4000-8000-000000000001';
    if (mutation === 'device')
      value.migration.predecessors[0].deviceId = '00000000-0000-4000-8000-000000000001';
    if (mutation === 'actor') value.migration.predecessors[0].scope.actorId = 'outside';
    if (mutation === 'space') value.migration.predecessors[0].scope.spaceId = 'south';
    if (mutation === 'generation-gap') value.migration.predecessors.pop();
    if (mutation === 'held') value.migration.predecessors[0].resources = 'held';
    if (mutation === 'intermediate-native')
      value.migration.predecessors[1].nativeSessionId = 'unproved-skipped-binding';
    if (mutation === 'selection')
      value.migration.predecessors[0].selection.model = 'borrowed-old-model';
    if (mutation === 'read-only') value.authority = 'recovery-required';
    q.setView(value);
    assert.throws(() => q.issuer.open(q.driving));
  });

for (const mutation of ['scope', 'projection', 'selection', 'revoke', 'drain'])
  test(`remote migration: ${mutation} changes invalidate an issued live qualification`, async (t) => {
    const h = await lineage(t),
      q = qualifier(t, h),
      { grant } = q.issuer.open(q.driving);
    q.ready();
    q.issuer.assertMigration(grant, 'migrate');
    if (mutation === 'scope') {
      const view = structuredClone(h.third);
      view.scope.segmentId = 'changed';
      q.setView(view);
    }
    if (mutation === 'projection') {
      const view = structuredClone(h.third);
      view.migration.inputFingerprint = '0'.repeat(64);
      q.setView(view);
    }
    if (mutation === 'selection') q.setSelection({ ...h.third.selection, model: 'changed' });
    if (mutation === 'revoke') q.drivingLife.abort();
    if (mutation === 'drain') q.revokeDrain();
    assert.throws(() => q.issuer.assertMigration(grant, 'migrate'));
    assert.equal(grant.signal.aborted, true);
  });
