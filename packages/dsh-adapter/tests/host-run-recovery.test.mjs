import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHostAbsentRetry,
  retireHostUnadmittedScope,
  retireHostSettledScope,
  hostWorkflowRecoveryBinding,
} from '../dist/host-run-recovery.js';
import { createHostRunRetirements } from '../dist/host-run-sources.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';
import { executionRunScope, readExecutionRunState } from '../dist/execution-run-state.js';
import { accepted, applyEvent, begin } from './execution-run-fixture.mjs';

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

function workflowHistory() {
  let node = applyEvent(accepted(), 'failed', { resourcesSettled: true }).record;
  for (const generation of [2, 3]) {
    const started = begin(node, {
      mode: 'retry',
      requestId: `retry-${generation}`,
      newRunId: `run-${generation}`,
      newSegmentId: `segment-${generation}`,
    });
    node = applyEvent(accepted(started.record), 'failed', { resourcesSettled: true }).record;
  }
  // Metadata-only completed history, not native/model or artifact-delivery proof.
  for (const run of node.nativeExecution.runs) run.attempt.status = 'completed';
  const state = readExecutionRunState(node);
  const old = state.runs[0];
  const scope = executionRunScope(node, old);
  const { actorId, runId: _run, generation: _generation, segmentId: _segment, ...location } = scope;
  delete location.nodeId;
  const reservation = {
    nodeId: node.nodeId,
    requestId: state.receipts[0].requestId,
    newRunId: old.attempt.id,
    newSegmentId: old.segmentId,
  };
  return { node, scope, actorId, location, reservation };
}

test('Host workflow recovery metadata: original receipt keeps g1 scope when the settled current Run is g3', () => {
  const h = workflowHistory();
  const before = JSON.stringify(h.node);
  const bound = hostWorkflowRecoveryBinding(h.node, h.reservation, h.location, h.actorId);
  assert.deepEqual(bound.scope, h.scope);
  assert.equal(bound.scope.generation, 1);
  assert.equal(bound.currentRunId, 'run-3');
  const state = readExecutionRunState(h.node);
  const current = state.runs.at(-1);
  const own = hostWorkflowRecoveryBinding(
    h.node,
    {
      ...h.reservation,
      requestId: state.receipts.at(-1).requestId,
      newRunId: current.attempt.id,
      newSegmentId: current.segmentId,
    },
    h.location,
    h.actorId,
  );
  assert.equal(own.scope.runId, own.currentRunId);
  assert.equal(JSON.stringify(h.node), before);
});

test('Host workflow recovery metadata: active or held current work, wrong receipts and foreign full scopes refuse', () => {
  for (const mutate of [
    (h) => (h.reservation.requestId = 'unknown-receipt'),
    (h) => (h.reservation.newRunId = 'wrong-old-run'),
    (h) => (h.reservation.newSegmentId = 'wrong-old-segment'),
    (h) => (h.reservation.nodeId = 'other-node'),
    (h) => (h.location.taskId = 'other-task'),
    (h) => (h.location.planId = 'other-plan'),
    (h) => h.location.revision++,
    (h) => (h.location.spaceId = 'other-space'),
    (h) => (h.actorId = 'other-member'),
    (h) => (h.node.nativeExecution.runs[0].resources = 'held'),
    (h) => (h.node.nativeExecution.runs.at(-1).resources = 'held'),
    (h) => (h.node.nativeExecution.runs.at(-1).attempt.status = 'running'),
  ]) {
    const h = workflowHistory();
    mutate(h);
    assert.throws(() => hostWorkflowRecoveryBinding(h.node, h.reservation, h.location, h.actorId));
  }
});

test('Host workflow recovery metadata: a changed current Run or control version cannot match a pinned recovery', () => {
  const h = workflowHistory();
  const original = hostWorkflowRecoveryBinding(h.node, h.reservation, h.location, h.actorId);
  h.node.nativeExecution.runs.at(-1).attempt.status = 'failed';
  const changed = hostWorkflowRecoveryBinding(h.node, h.reservation, h.location, h.actorId);
  assert.notEqual(changed.control, original.control);
  h.node.command.version++;
  const newer = hostWorkflowRecoveryBinding(h.node, h.reservation, h.location, h.actorId);
  assert.notEqual(newer.control, changed.control);
});

function settledRetirement() {
  const { scope } = fixture();
  const lifetime = new AbortController();
  const permission = new AbortController();
  const physical = new AbortController();
  const expected = { nativeSessionId: 'original-session', nativeAgentId: 'original-agent' };
  const result = {
    status: 'retired',
    binding: { scope: { ...scope }, ...expected },
    drain: {
      basis: 'flushed-and-closed',
      signal: physical.signal,
      assertCurrent() {
        physical.signal.throwIfAborted();
      },
    },
  };
  const counts = { retired: 0, fresh: 0, resources: 0 };
  const cleanup = {
    scope,
    assertCurrent() {
      permission.signal.throwIfAborted();
    },
  };
  const owner = {
    async retireForCleanup(original, signal) {
      assert.equal(original, cleanup);
      assert.equal(signal, lifetime.signal);
      counts.retired++;
      return result;
    },
  };
  const fresh = async () => {
    counts.fresh++;
    permission.signal.throwIfAborted();
  };
  const resources = async () => {
    counts.resources++;
  };
  return {
    scope,
    lifetime,
    permission,
    physical,
    result,
    counts,
    owner,
    cleanup,
    fresh,
    resources,
    recover: () =>
      retireHostSettledScope(owner, cleanup, expected, lifetime.signal, fresh, resources),
  };
}

test('Host settled retirement contract: one exact old scope rebuilds an ephemeral certificate only after physical and resource drains', async () => {
  const h = settledRetirement();
  const cache = createHostRunRetirements(h.owner, h.lifetime.signal);
  assert.equal(cache.read(h.scope), undefined);
  const result = await h.recover();
  assert.deepEqual(h.counts, { retired: 1, fresh: 3, resources: 1 });
  assert.equal(cache.read(h.scope), undefined, 'no proof is published inside physical cleanup');
  cache.remember(h.scope, result);
  assert.equal(cache.read(h.scope), h.result.drain);
  assert.equal(cache.read({ ...h.scope, nodeId: 'another-active-node' }), undefined);
});

test('Host settled retirement contract: pending, missing, mismatched or unflushed physical results never qualify', async () => {
  for (const fault of [
    'pending',
    'missing-binding',
    'session',
    'agent',
    'unflushed',
    ...Object.keys(settledRetirement().scope),
  ]) {
    const h = settledRetirement();
    if (fault === 'pending') h.result.status = 'pending';
    else if (fault === 'missing-binding') h.result.binding = undefined;
    else if (fault === 'session') h.result.binding.nativeSessionId = 'other-session';
    else if (fault === 'agent') h.result.binding.nativeAgentId = 'other-agent';
    else if (fault === 'unflushed') h.result.drain.basis = 'absent-unadmitted';
    else {
      const value = h.result.binding.scope[fault];
      h.result.binding.scope[fault] = typeof value === 'number' ? value + 1 : `${value}-other`;
    }
    await assert.rejects(h.recover(), { code: 'run-migration-pending' }, fault);
    assert.equal(h.counts.resources, 0, fault);
  }
});

test('Host settled retirement contract: authorization, cancellation and physical invalidation cannot publish a late certificate', async () => {
  for (const phase of ['before', 'during-native', 'during-resources', 'cancelled', 'physical']) {
    const h = settledRetirement();
    if (phase === 'before') h.permission.abort();
    if (phase === 'cancelled') h.lifetime.abort();
    if (phase === 'physical') h.physical.abort();
    if (phase === 'during-native') {
      const original = h.owner.retireForCleanup;
      h.owner.retireForCleanup = async (...args) => {
        const result = await original(...args);
        h.permission.abort();
        return result;
      };
    }
    if (phase === 'during-resources') {
      const original = h.resources;
      h.resources = async () => {
        await original();
        h.permission.abort();
      };
      h.recover = () =>
        retireHostSettledScope(
          h.owner,
          h.cleanup,
          { nativeSessionId: 'original-session', nativeAgentId: 'original-agent' },
          h.lifetime.signal,
          h.fresh,
          h.resources,
        );
    }
    await assert.rejects(h.recover(), { name: 'AbortError' }, phase);
    assert.equal(h.counts.retired, ['before', 'cancelled'].includes(phase) ? 0 : 1);
  }
});

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
