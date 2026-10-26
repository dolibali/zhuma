import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHostAbsentRetry, retireHostUnadmittedScope } from '../dist/host-run-recovery.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';
import { executionRunScope } from '../dist/execution-run-state.js';
import { applyEvent, begin } from './execution-run-fixture.mjs';

// Qualification contracts only. Grants/drains/owners below are stand-ins,
// not actual native absence or member authorization evidence.
function fixture() {
  const node = applyEvent(begin().record, 'failed', { resourcesSettled: true }).record;
  const scope = executionRunScope(node, node.nativeExecution.runs[0]);
  const owner = {};
  const lifetime = new AbortController();
  const permission = new AbortController();
  const physical = new AbortController();
  const proof = {
    owner,
    scope,
    result: {
      status: 'retired',
      binding: undefined,
      drain: {
        basis: 'absent-unadmitted',
        signal: physical.signal,
        assertCurrent() {
          physical.signal.throwIfAborted();
        },
      },
    },
  };
  const grant = {
    scope: { ...scope, runId: 'run-2', segmentId: 'segment-2', generation: 2 },
    signal: permission.signal,
    assertCurrent(action) {
      assert.equal(action, 'send');
      permission.signal.throwIfAborted();
    },
  };
  let connects = 0;
  const connect = () => {
    assertHostAbsentRetry(proof, owner, lifetime.signal, scope, node, grant);
    connects++;
  };
  return {
    node,
    scope,
    owner,
    lifetime,
    permission,
    physical,
    proof,
    grant,
    connect,
    connects: () => connects,
  };
}

test('Host recovery contract: exact same-owner absence observation and a new current grant qualify canonical send only', () => {
  const h = fixture();
  h.connect();
  assert.equal(h.connects(), 1);
});
test('Host recovery contract: a binding is never first-binding evidence, even with an absent basis', () => {
  const h = fixture();
  h.proof.result.binding = { nativeSessionId: 'existing-native' };
  assert.throws(h.connect, { code: 'run-recovery-unavailable' });
  assert.equal(h.connects(), 0);
});
test('Host recovery contract: replaced or closed owners and stale physical observations never connect', () => {
  for (const kind of ['replaced', 'closed', 'stale']) {
    const h = fixture();
    if (kind === 'replaced') h.proof.owner = {};
    if (kind === 'closed') h.lifetime.abort();
    if (kind === 'stale') h.physical.abort();
    assert.throws(h.connect, { code: 'run-recovery-unavailable' });
    assert.equal(h.connects(), 0);
  }
});
test('Host recovery contract: a different prior scope or new scope cannot borrow the observation', () => {
  for (const kind of ['old', 'new']) {
    const h = fixture();
    if (kind === 'old') h.proof.scope = { ...h.scope, runId: 'different' };
    else h.grant.scope.nodeId = 'different';
    assert.throws(h.connect, { code: 'run-recovery-unavailable' });
    assert.equal(h.connects(), 0);
  }
});
test('Host recovery contract: revoked driving authority cannot use a cleanup observation', () => {
  const h = fixture();
  h.permission.abort();
  assert.throws(h.connect, { code: 'run-recovery-unavailable' });
  assert.equal(h.connects(), 0);
});
test('Host recovery contract: acknowledged native identity or unsettled prior resources refuse', () => {
  for (const kind of ['native-id', 'resources']) {
    const h = fixture();
    if (kind === 'native-id') h.node.nativeExecution.runs[0].attempt.sessionId = 'old-native';
    else h.node.nativeExecution.runs[0].resources = 'held';
    assert.throws(h.connect, { code: 'run-recovery-unavailable' });
    assert.equal(h.connects(), 0);
  }
});

function coldFixture(overrides = {}) {
  const h = fixture();
  const calls = [];
  const cleanup = {
    scope: h.scope,
    signal: h.grant.signal,
    assertCurrent() {
      h.grant.assertCurrent('send');
    },
  };
  const owner = {
    migrationOrigin() {
      calls.push('origin');
      throw new NativeWorkError('not-started');
    },
    async retireForCleanup(value, signal) {
      calls.push('retire');
      assert.equal(value, cleanup);
      assert.equal(signal, h.grant.signal);
      return h.proof.result;
    },
    ...overrides,
  };
  const authorities = {
    assertGrant(value, action) {
      assert.equal(value, h.grant);
      value.assertCurrent(action);
    },
    unadmittedCleanup(value) {
      assert.equal(value, h.grant);
      calls.push('derive');
      return cleanup;
    },
  };
  const query = {
    scope: h.grant.scope,
    requestId: 'retry',
    inputFingerprint: 'hash',
    selection: {},
  };
  return {
    ...h,
    calls,
    cleanup,
    owner,
    query,
    authorities,
    recover: () =>
      retireHostUnadmittedScope(owner, authorities, h.lifetime.signal, h.grant, h.scope, query),
  };
}
test('Host cold retry contract: only actual not-started permits deriving and consuming a same-owner drain', async () => {
  const h = coldFixture();
  const result = await h.recover();
  assert.equal(result.owner, h.owner);
  assert.equal(result.result, h.proof.result);
  assert.deepEqual(result.scope, h.scope);
  assert.deepEqual(h.calls, ['origin', 'derive', 'retire']);
  assertHostAbsentRetry(result, h.owner, h.lifetime.signal, h.scope, h.node, h.grant);
});
test('Host cold retry contract: an existing locator keeps normal migration; other failures cannot claim absence', async () => {
  const existing = coldFixture({ migrationOrigin: () => ({ scope: 'existing' }) });
  assert.equal(await existing.recover(), undefined);
  assert.deepEqual(existing.calls, []);
  for (const error of [
    new NativeWorkError('binding-state-invalid'),
    new NativeWorkError('migration-unknown'),
    { code: 'not-started' },
    Error('not-started'),
  ]) {
    const h = coldFixture({
      migrationOrigin() {
        throw error;
      },
    });
    await assert.rejects(h.recover());
    assert.deepEqual(h.calls, []);
  }
});
test('Host cold retry contract: pending, existing binding, wrong basis and stale drain never permit a send', async () => {
  for (const variant of ['pending', 'binding', 'basis', 'stale']) {
    const h = coldFixture();
    if (variant === 'pending') h.owner.retireForCleanup = async () => ({ status: 'pending' });
    if (variant === 'binding') h.proof.result.binding = {};
    if (variant === 'basis') h.proof.result.drain.basis = 'flushed-and-closed';
    if (variant === 'stale') h.physical.abort();
    await assert.rejects(h.recover());
    assert.equal(h.connects(), 0);
  }
});
test('Host cold retry contract: a crossed cleanup scope or query is rejected', async () => {
  for (const variant of ['cleanup', 'query']) {
    const h = coldFixture();
    if (variant === 'cleanup') h.cleanup.scope = { ...h.scope, runId: 'another' };
    else h.query.scope = { ...h.grant.scope, nodeId: 'another' };
    await assert.rejects(h.recover());
    assert.equal(h.calls.includes('retire'), false);
  }
});
test('Host cold retry contract: revocation or owner closure during actual cleanup await cannot publish a proof', async () => {
  for (const variant of ['member', 'owner']) {
    const h = coldFixture(),
      release = Promise.withResolvers();
    h.owner.retireForCleanup = async () => release.promise;
    const operation = h.recover();
    if (variant === 'member') h.permission.abort();
    else h.lifetime.abort();
    release.resolve(h.proof.result);
    await assert.rejects(operation);
  }
});
