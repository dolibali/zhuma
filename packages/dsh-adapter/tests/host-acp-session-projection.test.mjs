/** Fixed-plugin result projection contracts. No real ACP, subprocess or GUI. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareHostAcpSessionProjection } from '../dist/host-acp-session-projection.js';

const provider = {
  id: 'codearts',
  name: 'CodeArts',
  command: '/configured/tool',
  args: ['serve'],
  loginHint: null,
  executable: true,
  version: null,
  state: 'saved-unverified',
  probe: { status: 'never', at: null },
};
const row = (sessionId) => ({
  sessionId,
  continuity: { status: 'blocked', cause: `cause-${sessionId}`, detail: `detail-${sessionId}` },
});
const view = () => ({
  providers: [structuredClone(provider)],
  liveSessions: [row('ordinary'), row('private-task')],
});
const prepare = (method, lookup, current = () => {}, signal = new AbortController().signal) =>
  prepareHostAcpSessionProjection(method, { lookupNativeSession: lookup }, current, signal);

test('ACP health preserves configuration while removing the entire protected session record', async () => {
  const input = view(),
    before = JSON.stringify(input),
    looked = [];
  const result = await prepare('health', (id) => {
    looked.push(id);
    return id === 'ordinary' ? null : { role: 'work' };
  }).project(input);
  assert.deepEqual(result, { providers: [provider], liveSessions: [row('ordinary')] });
  assert.deepEqual(looked, ['ordinary', 'private-task']);
  assert.ok(!JSON.stringify(result).includes('private-task'));
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(result, input);
  assert.notEqual(result.providers, input.providers);
  assert.notEqual(result.providers[0], input.providers[0]);
  assert.deepEqual(
    await prepare('health', () => assert.fail('null has no sessions')).project({
      providers: [provider],
      liveSessions: null,
    }),
    { providers: [provider], liveSessions: null },
  );
});

test('ACP projected descendants use the same original lookup and never mutate the source', async () => {
  const input = { sessionIds: ['ordinary', 'private-task', 'private-review'] };
  const result = await prepare('projectedSubagentIds', (id) =>
    id === 'ordinary' ? null : {},
  ).project(input);
  assert.deepEqual(result, { sessionIds: ['ordinary'] });
  assert.deepEqual(input.sessionIds, ['ordinary', 'private-task', 'private-review']);
  assert.notEqual(result.sessionIds, input.sessionIds);
});

test('ACP catalog unknown fields, associated counts, invalid values and duplicate identities fail closed', async () => {
  for (const input of [
    { ...view(), count: 2 },
    { ...view(), providers: [{ ...provider, privateWorkspace: '/private/path' }] },
    { ...view(), providers: [{ ...provider, probe: { status: 'never', at: null, count: 2 } }] },
    { ...view(), providers: [provider, provider] },
    { ...view(), liveSessions: [row('ordinary'), row('ordinary')] },
    { ...view(), liveSessions: [{ ...row('ordinary'), workspace: '/private/path' }] },
    {
      ...view(),
      liveSessions: [{ sessionId: 'ordinary', continuity: { status: 'ok', cause: null } }],
    },
    { ...view(), liveSessions: [{ sessionId: 42, continuity: {} }] },
    { providers: [], liveSessions: [], unknown: 'private-task' },
    undefined,
  ]) {
    let lookups = 0;
    await assert.rejects(
      prepare('health', () => {
        lookups++;
        return null;
      }).project(input),
      /unavailable/,
    );
    // Duplicates may be found after the first bounded original lookup.
    assert.ok(lookups <= 1);
  }
  for (const input of [
    { sessionIds: ['ordinary'], count: 2 },
    { sessionIds: ['ordinary', 'ordinary'] },
    { sessionIds: [42] },
  ])
    await assert.rejects(prepare('projectedSubagentIds', () => null).project(input), /unavailable/);
});

test('ACP source failure, malformed lookup, scope replacement and cancellation never publish a false empty success', async () => {
  for (const lookup of [
    () => {
      throw Error('/private/provider/error');
    },
    () => undefined,
    () => [],
  ])
    await assert.rejects(
      prepare('health', lookup).project(view()),
      (error) => /unavailable/.test(error.message) && !error.message.includes('/private'),
    );
  const pending = Promise.withResolvers();
  let current = true;
  const assertCurrent = () => {
    if (!current) throw Error('owner unavailable');
  };
  const old = prepare('projectedSubagentIds', () => pending.promise, assertCurrent);
  const response = old.project({ sessionIds: ['ordinary'] });
  current = false;
  pending.resolve(null);
  await assert.rejects(response, /owner unavailable/);
  assert.throws(() => old.assertCurrent(), /owner unavailable/);
  const cancelled = Promise.withResolvers(),
    controller = new AbortController();
  const reading = prepare(
    'projectedSubagentIds',
    () => cancelled.promise,
    () => {},
    controller.signal,
  ).project({ sessionIds: ['ordinary'] });
  controller.abort();
  cancelled.resolve(null);
  await assert.rejects(reading, { name: 'AbortError' });
});

test('ACP successful and failed explicit probe metadata keep their original typed semantics', async () => {
  const success = {
    status: 'ok',
    at: 1,
    modelCount: 2,
    authMethods: [{ id: 'login', name: 'CLI login', description: null }],
    agentInfo: { name: 'Agent', version: '1' },
    capabilities: Object.fromEntries(
      [
        'loadSession',
        'sessionList',
        'sessionClose',
        'sessionDelete',
        'promptImage',
        'promptAudio',
        'promptEmbeddedContext',
        'mcpHttp',
        'mcpSse',
      ].map((key) => [key, false]),
    ),
    cleanup: { close: 'done', delete: 'not-advertised', message: null },
    capabilityHash: 'hash',
    protocolVersion: 1,
    versionCompatibility: 'unknown',
    matrix: [
      {
        id: 'resume',
        advertised: null,
        adapterPath: 'original',
        hostSeam: null,
        status: 'degraded',
      },
    ],
  };
  for (const probe of [
    success,
    {
      status: 'error',
      at: 2,
      failureKind: 'auth_required',
      message: 'Sign in',
      phase: 'initialize',
    },
  ]) {
    const input = { providers: [{ ...provider, probe }], liveSessions: [] };
    assert.deepEqual(
      await prepare('health', () => assert.fail('no session')).project(input),
      input,
    );
  }
  assert.throws(() => prepare('futureCatalog', () => null), /unavailable/);
});
