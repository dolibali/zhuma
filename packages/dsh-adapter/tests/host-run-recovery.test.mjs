import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHostAbsentRetry } from '../dist/host-run-recovery.js';
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
