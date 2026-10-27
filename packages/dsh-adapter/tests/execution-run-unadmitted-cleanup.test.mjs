/** Contract sources only. The actual member/Host/C two-process proof is separate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionRunAuthorities } from '../dist/execution-run-authority.js';
import { executionRunScope } from '../dist/execution-run-state.js';
import { begin, accepted, applyEvent, locator, localWorkspace } from './execution-run-fixture.mjs';

const request = { headers: { cookie: 'synthetic-controller' } };
function failed(row = begin().record) {
  return applyEvent(row, 'failed', { resourcesSettled: true }).record;
}
function next(row) {
  const n = row.nativeExecution.runs.length + 1;
  return begin(row, {
    requestId: `begin-${n}`,
    mode: 'retry',
    newRunId: `run-${n}`,
    newSegmentId: `segment-${n}`,
  }).record;
}
async function setup(
  t,
  { row = next(failed()), memberId = 'chen', expiresAt = Date.now() + 60_000 } = {},
) {
  const flags = { member: true, workspace: true, role: true, async: '', writer: true, expiresAt };
  const lifetime = new AbortController(),
    member = new AbortController();
  const listeners = new Set();
  let current = row,
    leases = 0,
    releases = 0;
  const source = {
    signal: lifetime.signal,
    writerState() {
      return flags.async === 'writer'
        ? Promise.reject(Error('PRIVATE_WRITER'))
        : { schemaVersion: 1, ...(flags.writer ? { nativeExecutionWriter: 1 } : {}) };
    },
    async memberLease(original) {
      assert.equal(original, request);
      leases++;
      return {
        memberId,
        get expiresAt() {
          return flags.expiresAt;
        },
        signal: member.signal,
        assertCurrent(spaceId) {
          if (flags.async === 'lease') return Promise.reject(Error('PRIVATE_LEASE'));
          if (!flags.member || spaceId !== 'north') throw Error('PRIVATE_MEMBER');
        },
        release() {
          releases++;
        },
      };
    },
    readNode() {
      return flags.async === 'node' ? Promise.reject(Error('PRIVATE_NODE')) : current;
    },
    assertNodeAccess(actor, spaceId, node, action) {
      if (flags.async === 'role') return Promise.reject(Error('PRIVATE_ROLE'));
      if (
        !flags.role ||
        actor !== 'chen' ||
        spaceId !== 'north' ||
        (['send', 'queue', 'stop'].includes(action) && node.handoff.assignee.id !== actor)
      )
        throw Error('PRIVATE_ROLE');
    },
    assertWorkspace(actor, spaceId, workspace, access, configurationId) {
      if (flags.async === 'workspace') return Promise.reject(Error('PRIVATE_WORKSPACE'));
      if (
        !flags.workspace ||
        actor !== 'chen' ||
        spaceId !== 'north' ||
        configurationId !== 'configuration-1' ||
        (workspace.kind === 'local' && access !== workspace.access)
      )
        throw Error('PRIVATE_WORKSPACE');
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const manager = new ExecutionRunAuthorities(source);
  t.after(() => manager.close());
  return {
    manager,
    source,
    flags,
    lifetime,
    member,
    get row() {
      return current;
    },
    set row(value) {
      current = value;
    },
    get leases() {
      return leases;
    },
    get releases() {
      return releases;
    },
    emit() {
      for (const listener of listeners) listener();
    },
    open(purpose = 'drive') {
      return manager.open(request, locator(current), purpose);
    },
  };
}

test('unadmitted cleanup contract: a true current drive grant derives only the exact previous cleanup scope', async (t) => {
  const h = await setup(t),
    opened = await h.open();
  const before = JSON.stringify(h.row);
  const cleanup = h.manager.unadmittedCleanup(opened.grant);
  assert.deepEqual(cleanup.scope, executionRunScope(h.row, h.row.nativeExecution.runs[0]));
  assert.equal(cleanup.signal, opened.grant.signal);
  assert.equal(cleanup.assertCurrent(), undefined);
  assert.equal(h.leases, 1, 'the borrowed capability must not open another lease');
  assert.equal(cleanup.drain, undefined, 'node eligibility is not physical absence');
  assert.throws(() => h.manager.assertGrant(cleanup, 'send'), { code: 'run-authority-denied' });
  assert.throws(() => h.manager.assertCleanup(cleanup, 'cleanup'), {
    code: 'run-authority-denied',
  });
  assert.throws(() => h.manager.assertMigration(cleanup, 'prepare'), {
    code: 'run-authority-denied',
  });
  assert.throws(() => {
    cleanup.scope.runId = 'forged';
  }, TypeError);
  const repeated = h.manager.unadmittedCleanup(opened.grant);
  assert.deepEqual(repeated.scope, cleanup.scope);
  assert.equal(repeated.assertCurrent(), undefined);
  assert.equal(h.leases, 1);
  assert.equal(JSON.stringify(h.row), before);
  opened.dispose();
  assert.throws(() => cleanup.assertCurrent(), { code: 'run-authority-denied' });
  assert.equal(h.releases, 1);
});

test('unadmitted cleanup contract: serialized, copied, foreign-manager and read grants do not qualify', async (t) => {
  const h = await setup(t),
    opened = await h.open(),
    other = await setup(t);
  const read = await h.open('read');
  for (const grant of [JSON.parse(JSON.stringify(opened.grant)), { ...opened.grant }, read.grant])
    assert.throws(() => h.manager.unadmittedCleanup(grant), { code: 'run-authority-denied' });
  assert.throws(() => other.manager.unadmittedCleanup(opened.grant), {
    code: 'run-authority-denied',
  });
});

test('unadmitted cleanup contract: terminal drive and existing event cleanup eligibility remain unchanged', async (t) => {
  const h = await setup(t, { row: failed() });
  await assert.rejects(h.open(), { code: 'run-authority-denied' });
  assert.throws(() => h.manager.cleanupAfterCommit(locator(h.row)), {
    code: 'run-authority-denied',
  });
  const read = await h.open('read');
  assert.throws(() => h.manager.unadmittedCleanup(read.grant), { code: 'run-authority-denied' });
});

for (const evidence of [
  'unknown',
  'received',
  'acknowledged',
  'discarded',
  'unsettled',
  'different-actor',
  'label',
])
  test(`unadmitted cleanup contract: old ${evidence} evidence cannot become first-binding recovery`, async (t) => {
    let old = begin().record;
    if (evidence === 'unknown') old = applyEvent(old, 'dispatch-unknown').record;
    if (evidence === 'received')
      old = applyEvent(old, 'received', { nativeSessionId: 'received-native' }).record;
    if (evidence === 'acknowledged') old = accepted(old);
    const row = next(failed(old)),
      previous = row.nativeExecution.runs[0];
    if (evidence === 'discarded') previous.attempt.sessionDiscarded = true;
    if (evidence === 'different-actor') previous.actorId = 'outside';
    if (evidence === 'label') previous.attempt.modelLabel = 'old-model';
    const h = await setup(t, { row }),
      opened = await h.open();
    if (evidence === 'unsettled') previous.resources = 'held';
    assert.throws(() => h.manager.unadmittedCleanup(opened.grant), {
      code: 'run-authority-denied',
    });
  });

test('unadmitted cleanup contract: any older admitted/unknown history blocks recovery, not just the immediate prior row', async (t) => {
  const row = next(failed(next(failed(applyEvent(begin().record, 'dispatch-unknown').record))));
  const h = await setup(t, { row }),
    opened = await h.open();
  assert.throws(() => h.manager.unadmittedCleanup(opened.grant), { code: 'run-authority-denied' });
});

for (const evidence of ['accepted', 'unknown'])
  test(`unadmitted cleanup contract: current ${evidence} admission evidence refuses`, async (t) => {
    const row = next(failed());
    const h = await setup(t, {
      row: evidence === 'accepted' ? accepted(row) : applyEvent(row, 'dispatch-unknown').record,
    });
    const opened = await h.open();
    assert.throws(() => h.manager.unadmittedCleanup(opened.grant), {
      code: 'run-authority-denied',
    });
  });

for (const mutation of ['node', 'old-run', 'new-run', 'receipt', 'owner'])
  test(`unadmitted cleanup contract: ${mutation} mutation invalidates the pinned complete snapshot`, async (t) => {
    const h = await setup(t),
      opened = await h.open(),
      cleanup = h.manager.unadmittedCleanup(opened.grant);
    const originalSignal = h.source.signal;
    if (mutation === 'node') h.row.command.version++;
    if (mutation === 'old-run') h.row.nativeExecution.runs[0].attempt.payloadHash = 'f'.repeat(64);
    if (mutation === 'new-run') h.row = next(failed(h.row));
    if (mutation === 'receipt') h.row.nativeExecution.receipts[0].actorId = 'outside';
    if (mutation === 'owner') h.source.signal = new AbortController().signal;
    try {
      assert.throws(() => cleanup.assertCurrent(), { code: 'run-authority-denied' });
    } finally {
      h.source.signal = originalSignal;
    }
  });

for (const revoke of ['member', 'workspace', 'role', 'writer', 'expiry', 'lease-abort', 'lifetime'])
  test(`unadmitted cleanup contract: ${revoke} revocation refuses before physical cleanup`, async (t) => {
    const h = await setup(t),
      opened = await h.open(),
      cleanup = h.manager.unadmittedCleanup(opened.grant);
    if (['member', 'workspace', 'role', 'writer'].includes(revoke)) h.flags[revoke] = false;
    if (revoke === 'expiry') h.flags.expiresAt = Date.now() - 1;
    if (revoke === 'lease-abort') h.member.abort();
    if (revoke === 'lifetime') h.lifetime.abort();
    h.emit();
    assert.throws(() => cleanup.assertCurrent(), { code: 'run-authority-denied' });
    assert.equal(cleanup.signal.aborted, true);
  });

for (const async of ['writer', 'node', 'lease', 'role', 'workspace'])
  test(`unadmitted cleanup contract: asynchronous ${async} facts are unavailable, never approval`, async (t) => {
    const h = await setup(t),
      opened = await h.open(),
      cleanup = h.manager.unadmittedCleanup(opened.grant);
    h.flags.async = async;
    assert.throws(() => cleanup.assertCurrent(), { code: 'run-authority-denied' });
  });

test('unadmitted cleanup contract: original local workspace write access is rechecked', async (t) => {
  const old = failed(begin(undefined, { workspace: localWorkspace }).record);
  const row = begin(old, {
    mode: 'retry',
    requestId: 'begin-2',
    newRunId: 'run-2',
    newSegmentId: 'segment-2',
    workspace: localWorkspace,
  }).record;
  const h = await setup(t, { row }),
    opened = await h.open();
  const cleanup = h.manager.unadmittedCleanup(opened.grant);
  cleanup.assertCurrent();
  h.flags.workspace = false;
  assert.throws(() => cleanup.assertCurrent(), { code: 'run-authority-denied' });
});
