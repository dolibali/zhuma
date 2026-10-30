/** Host admission-port contracts, not an actual SDK dispatch/model proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nativeSessionCommandIds,
  openHostSessionAdmission,
} from '../dist/host-session-admission.js';
function fixture() {
  let admission,
    projection,
    disposed = false,
    source;
  const effects = [];
  const gateway = {
    registerSessionAdmission(fn) {
      admission = fn;
      return () => {
        disposed = true;
      };
    },
    registerSessionResultProjection(fn) {
      projection = fn;
      return () => {
        projection = undefined;
      };
    },
  };
  const owner = {
    get: (name) => {
      assert.equal(name, 'typertGateway');
      return gateway;
    },
    effect: (start) => effects.push(start()),
  };
  const ctx = { inject: (_, apply) => apply(owner), effect: (start) => effects.push(start()) };
  const gate = openHostSessionAdmission(ctx, () => source);
  return {
    gate,
    setSource: (next) => {
      source = next;
    },
    call: (method, args, signal = new AbortController().signal) => admission(method, args, signal),
    project: (method, signal = new AbortController().signal) => projection(method, {}, signal),
    disposed: () => disposed,
  };
}
test('actual Session argument shapes cover create/reuse, live mutations and cold parent/child addresses without scanning prompts', () => {
  assert.deepEqual(nativeSessionCommandIds({ request: { sessionId: 'task' } }), ['task']);
  assert.deepEqual(
    nativeSessionCommandIds({
      request: {
        address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child' },
      },
    }),
    ['parent', 'child'],
  );
  assert.deepEqual(
    nativeSessionCommandIds({
      request: { content: [{ text: 'task', sessionId: 'untrusted-text' }] },
    }),
    [],
  );
});

test('ACP exact session parameters and explicit globals cannot bypass task or parent ownership', async () => {
  const h = fixture();
  const seen = [];
  h.setSource({
    lookupNativeSession(id) {
      seen.push(id);
      return id === 'ordinary' ? null : {};
    },
  });
  for (const [method, args] of [
    ['activitySnapshot', { sessionId: 'task' }],
    ['teamMemberModels', { lead: 'task', sessionId: 'ordinary' }],
    ['approvalChildren', { parent: 'task' }],
    ['activityDetail', { sessionId: 'ordinary', request: { ownerDshSessionId: 'task' } }],
    ['activityPage', { sessionId: 'ordinary', request: { filter: { ownerDshSessionId: 'task' } } }],
  ])
    assert.equal(await h.call(`dshAcp/${method}`, args), false);
  assert.equal(await h.call('dshAcp/activitySnapshot', { sessionId: 'ordinary' }), true);
  assert.equal(await h.call('dshAcp/activitySnapshot', {}), false);
  assert.equal(await h.call('dshAcp/futureUncheckedVerb', {}), false);
  assert.equal(await h.call('dshAcp/boundSessions', { agentId: 'configured' }), false);
  for (const method of ['health', 'projectedSubagentIds', 'ownedProviderRoutes'])
    assert.equal(await h.call(`dshAcp/${method}`, {}), true);
  assert.ok(seen.includes('task'));
});

test('ACP projection captures one source before invocation and rejects a later member owner', async () => {
  const h = fixture();
  h.setSource({ lookupNativeSession: () => null });
  const projection = h.project('projectedSubagentIds');
  h.setSource({ lookupNativeSession: () => null });
  assert.throws(() => projection.assertCurrent(), /unavailable/);
  await assert.rejects(projection.project({ sessionIds: ['ordinary'] }), /unavailable/);
});
test('work/review task hits reject ordinary live prompt, queue, cancel and cold read/reuse; only actual null admits ordinary behavior', async () => {
  const h = fixture();
  const looked = [];
  h.setSource({
    lookupNativeSession(id) {
      looked.push(id);
      return id === 'ordinary' ? null : { role: id === 'review' ? 'review' : 'work' };
    },
  });
  for (const method of [
    'create',
    'prompt',
    'updateQueue',
    'cancel',
    'rename',
    'fork',
    'selectModel',
    'attachment',
    'projections',
    'archiveSession',
  ]) {
    assert.equal(await h.call(method, { request: { sessionId: 'task' } }), false);
    assert.equal(await h.call(method, { request: { sessionId: 'ordinary' } }), true);
  }
  for (const method of ['page', 'follow']) {
    assert.equal(
      await h.call(method, { request: { address: { kind: 'session', sessionId: 'review' } } }),
      false,
    );
    assert.equal(
      await h.call(method, {
        request: {
          address: { kind: 'subagent', parentSessionId: 'task', childSessionId: 'ordinary' },
        },
      }),
      false,
    );
  }
  assert.equal(await h.call('create', { request: { cwd: '/ordinary' } }), true);
  assert.ok(looked.includes('review'));
});
test('initialization, unload, late lookup, damaged/foreign records and cancellation never become an ordinary fallback', async () => {
  const h = fixture();
  assert.equal(await h.call('prompt', { request: { sessionId: 'task' } }), false);
  for (const code of ['scope-mismatch', 'binding-state-invalid', 'unavailable']) {
    h.setSource({
      lookupNativeSession() {
        throw new Error(code);
      },
    });
    await assert.rejects(h.call('prompt', { request: { sessionId: 'task' } }));
  }
  const pending = Promise.withResolvers();
  h.setSource({ lookupNativeSession: () => pending.promise });
  const late = h.call('prompt', { request: { sessionId: 'ordinary' } });
  h.setSource({ lookupNativeSession: () => null });
  pending.resolve(null);
  assert.equal(await late, false);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(h.call('page', { request: {} }, abort.signal), { name: 'AbortError' });
  h.gate.close();
  assert.equal(h.disposed(), true);
  assert.equal(await h.call('prompt', { request: { sessionId: 'ordinary' } }), false);
});
