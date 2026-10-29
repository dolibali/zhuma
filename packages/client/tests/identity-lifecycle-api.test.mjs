import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityLifecycleApi } from '../dist/identity/lifecycle-api.js';

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
