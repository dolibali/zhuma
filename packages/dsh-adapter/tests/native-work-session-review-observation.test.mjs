// Event-correlation contracts only; these synthetic emitters are not SDK proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNativeReview } from '../dist/native-work-session-review-observation.js';

function fixture() {
  const handlers = new Map(),
    registry = new Map(),
    effects = [],
    claims = [],
    faults = [];
  let idles = 0;
  const ctx = {
    agents: { get: (id) => registry.get(id) },
    on(name, callback) {
      const listeners = handlers.get(name) ?? new Set();
      handlers.set(name, listeners);
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    effect(callback) {
      effects.push(callback());
    },
  };
  const emit = (name, ...args) => {
    for (const callback of [...(handlers.get(name) ?? [])]) callback(...args);
  };
  const scope = {
    actorId: 'chen',
    spaceId: 'north',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
  };
  const abort = new AbortController(),
    grant = { scope, signal: abort.signal, assertCurrent() {} };
  const binding = {
    scope,
    nativeSessionId: 'native',
    nativeAgentId: 'native',
    selection: {
      provider: 'contract',
      model: 'contract',
      maxTokens: 1000,
      configurationId: 'config',
    },
    receipts: [],
  };
  const session = { id: 'native' },
    agent = { id: 'native', session };
  const observed = observeNativeReview(ctx, binding, grant, {
    claim: (value) => claims.push(value),
    idle: () => idles++,
    fault: (value) => faults.push(value),
  });
  return {
    observed,
    handlers,
    registry,
    agent,
    session,
    emit,
    claims,
    faults,
    abort,
    effects,
    idles: () => idles,
  };
}
test('review observation contract: only the published original Agent and exact Session can correlate adoption', () => {
  const h = fixture();
  h.emit('agent/created', { agent: h.agent });
  h.emit('session/event', h.session, { type: 'user/message', seq: 1, data: { id: 'unpublished' } });
  assert.equal(h.claims.length, 0);
  h.registry.set('native', h.agent);
  h.emit('agent/created', { agent: h.agent });
  h.emit(
    'session/event',
    { id: 'native' },
    { type: 'user/message', seq: 2, data: { id: 'copied-session' } },
  );
  h.emit('agent/status', { agent: { ...h.agent }, status: 'idle' });
  assert.equal(h.idles(), 0);
  assert.equal(h.claims.length, 0);
  h.emit('session/event', h.session, { type: 'user/message', seq: 3, data: { id: 'real' } });
  h.emit('session/event', h.session, { type: 'user/message', seq: 3, data: { id: 'real' } });
  assert.equal(h.claims.length, 1);
  assert.equal(h.observed.claimFor('real').sequence, 3);
  h.emit('agent/status', { agent: h.agent, status: 'idle' });
  assert.equal(h.idles(), 1);
  h.observed.close();
  assert.equal(h.observed.claimFor('real'), undefined);
});
test('review observation contract: actual disposal and scope teardown retain early adoption until receipt correlation, without observing new events', () => {
  const h = fixture();
  h.registry.set('native', h.agent);
  h.emit('agent/created', { agent: h.agent });
  h.emit('session/event', h.session, { type: 'user/message', seq: 4, data: { id: 'early' } });
  h.emit('agent/disposed', { agent: h.agent });
  for (const effect of h.effects) effect();
  assert.deepEqual(h.faults, ['disposed']);
  assert.equal(h.observed.claimFor('early').sequence, 4);
  h.emit('session/event', h.session, { type: 'user/message', seq: 5, data: { id: 'late' } });
  assert.equal(h.observed.claimFor('late'), undefined);
  assert.ok([...h.handlers.values()].every((set) => set.size === 0));
  h.abort.abort();
  assert.equal(h.observed.claimFor('early'), undefined);
});
test('review observation contract: revoked grant drops correlations and stale SDK callbacks cannot revive them', () => {
  const h = fixture();
  h.registry.set('native', h.agent);
  h.emit('agent/created', { agent: h.agent });
  h.emit('session/event', h.session, { type: 'user/message', seq: 1, data: { id: 'before' } });
  const stale = [...h.handlers.get('session/event')][0];
  h.abort.abort();
  stale(h.session, { type: 'user/message', seq: 2, data: { id: 'after' } });
  assert.equal(h.observed.claimFor('before'), undefined);
  assert.equal(h.observed.claimFor('after'), undefined);
  assert.equal(h.claims.length, 1);
  assert.ok(h.observed.signal.aborted);
});
