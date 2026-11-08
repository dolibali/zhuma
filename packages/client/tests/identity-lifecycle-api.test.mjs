import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityLifecycleApi } from '../dist/identity/lifecycle-api.js';

test('profile client rejects a late response when its transport ignores cancellation', async () => {
  const gate = Promise.withResolvers();
  const controller = new AbortController();
  const api = createIdentityLifecycleApi(() => gate.promise);
  const pending = api.profile('ann', controller.signal);
  controller.abort();
  gate.resolve(Response.json({ ok: true, value: { accountId: 'ann', displayName: '旧账号' } }));
  await assert.rejects(pending, { name: 'AbortError' });
});

test('profile client sends only self metadata and rejects wrong-account/private replies', async () => {
  const calls = [];
  let value = { accountId: 'ann', displayName: '张宁' };
  const api = createIdentityLifecycleApi(async (path, init) => {
    calls.push({ path, init });
    return Response.json({ ok: true, value });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await api.profile('ann', signal), value);
  await api.setProfile('ann', { displayName: '张宁', accountId: 'bob', actorId: 'bob' }, signal);
  assert.equal(calls[0].path, '/zhuma-id/profile');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body), { displayName: '张宁' });
  for (value of [
    { accountId: 'bob', displayName: '其他成员' },
    { accountId: 'ann', displayName: '张宁', passwordHash: 'PRIVATE' },
    { accountId: 'ann', displayName: '' },
    { accountId: 'ann', displayName: 'x'.repeat(81) },
  ])
    await assert.rejects(
      api.profile('ann', signal),
      (e) => e.code === 'unavailable' && !e.message.includes('PRIVATE'),
    );
  value = { accountId: 'ann', displayName: null };
  assert.deepEqual(await api.setProfile('ann', { displayName: '' }, signal), value);
});

test('team names are optional legacy-compatible and cannot introduce an outside account', async () => {
  let value = { spaceId: 'north', administratorId: 'ann', accountIds: ['ann'] };
  const api = createIdentityLifecycleApi(async () => Response.json({ ok: true, value }));
  const signal = new AbortController().signal;
  assert.deepEqual(await api.members('north', signal), value);
  value = { ...value, members: [{ accountId: 'ann', displayName: '张宁' }] };
  assert.deepEqual(await api.members('north', signal), value);
  value.members = [{ accountId: 'bob', displayName: 'OTHER_SPACE' }];
  await assert.rejects(api.members('north', signal), (e) => e.code === 'unavailable');
});

test('member lifecycle HTTP client projects exact input and never accepts actor overrides or private replies', async () => {
  const calls = [];
  const api = createIdentityLifecycleApi(async (path, init) => {
    calls.push({ path, ...init });
    return Response.json({
      ok: true,
      value: { accountId: 'ann', personalSpaceId: 'personal-ann', disposition: 'created' },
    });
  });
  const value = await api.register(
    { requestId: 'request', accountId: 'ann', password: 'synthetic', actorId: 'owner' },
    new AbortController().signal,
  );
  assert.equal(value.accountId, 'ann');
  assert.equal(calls[0].path, '/zhuma-id/register');
  assert.equal(calls[0].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].body), {
    requestId: 'request',
    accountId: 'ann',
    password: 'synthetic',
  });
  const mismatched = createIdentityLifecycleApi(async () =>
    Response.json({
      ok: true,
      value: { accountId: 'bob', personalSpaceId: 'personal-bob', disposition: 'created' },
    }),
  );
  await assert.rejects(
    () =>
      mismatched.register(
        { requestId: 'request', accountId: 'ann', password: 'synthetic' },
        new AbortController().signal,
      ),
    (error) => error.code === 'unavailable',
  );
  const privateReply = createIdentityLifecycleApi(async () =>
    Response.json(
      { ok: false, error: 'unavailable', passwordHash: 'private-verifier' },
      { status: 503 },
    ),
  );
  await assert.rejects(
    () => privateReply.teams(new AbortController().signal),
    (error) => !error.message.includes('private-verifier'),
  );
});

test('member lifecycle client rejects mismatched team scope and uses only fixed public failure text', async () => {
  const api = createIdentityLifecycleApi(async () =>
    Response.json({
      ok: true,
      value: { spaceId: 'foreign', administratorId: 'ann', accountIds: ['ann'] },
    }),
  );
  await assert.rejects(
    () => api.members('north', new AbortController().signal),
    (error) => error.code === 'unavailable',
  );
  const denied = createIdentityLifecycleApi(async () =>
    Response.json({ ok: false, error: 'forbidden' }, { status: 403 }),
  );
  await assert.rejects(
    () =>
      denied.setMember(
        { requestId: 'request', spaceId: 'north', accountId: 'bob', action: 'remove' },
        new AbortController().signal,
      ),
    (error) => error.code === 'forbidden' && error.message === '没有权限执行此操作。',
  );
});
