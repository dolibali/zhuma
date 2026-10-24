import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdentityApi, IdentityApiError } from '../dist/identity/api.js';

const session = {
  ok: true,
  accountId: 'member-a',
  principal: { kind: 'zhuma-member', memberId: 'member-a' },
  peerId: 'peer-a',
  spaces: [],
};

test('identity HTTP contract: same-origin exact routes, explicit credential fields and no owner RPC', async () => {
  const requests = [];
  const api = createIdentityApi(async (url, init) => {
    requests.push({ url, init });
    return Response.json(
      url.endsWith('/session')
        ? { ...session, privateExtra: 'not-exposed' }
        : { ok: true, accountId: 'member-a' },
    );
  });
  await api.login({
    accountId: 'member-a',
    password: 'fixture-only',
    actorId: 'forged',
    memberId: 'forged',
  });
  assert.deepEqual(await api.session(), {
    accountId: 'member-a',
    principal: session.principal,
    peerId: 'peer-a',
    spaces: [],
  });
  await api.logout();
  assert.deepEqual(
    requests.map(({ url }) => url),
    ['/zhuma-id/login', '/zhuma-id/session', '/zhuma-id/logout'],
  );
  for (const { init } of requests) {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.accept, 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.cookie, undefined);
  }
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    accountId: 'member-a',
    password: 'fixture-only',
  });
  assert.equal(requests[1].init.method, 'GET');
  assert.equal(requests[1].init.body, undefined);
  assert.equal(requests[2].init.method, 'POST');
  assert.equal(requests[2].init.body, '{}');
});

test('identity HTTP contract: success needs a member principal matching the account; owner is not a member login', async () => {
  for (const value of [
    null,
    [],
    { ok: true },
    { ...session, peerId: '' },
    { ...session, principal: { kind: 'zhuma-member', memberId: 'other' } },
    { ...session, ok: false },
  ]) {
    await assert.rejects(createIdentityApi(async () => Response.json(value)).session(), {
      code: 'invalid-response',
    });
  }
  await assert.rejects(
    createIdentityApi(async () =>
      Response.json({ ...session, principal: { kind: 'owner' } }),
    ).session(),
    { code: 'member-session-required' },
  );
  const invalidJson = createIdentityApi(async () => new Response('not-json'));
  await assert.rejects(invalidJson.session(), { code: 'invalid-response' });
});

test('identity HTTP contract: authoritative spaces are required, unique, narrowed and immutable; empty is valid', async () => {
  const space = { id: 'space-1', kind: 'team', name: 'Design', privateExtra: 'not-exposed' };
  const result = await createIdentityApi(async () =>
    Response.json({ ...session, spaces: [space] }),
  ).session();
  assert.deepEqual(result.spaces, [{ id: 'space-1', kind: 'team', name: 'Design' }]);
  assert.ok(Object.isFrozen(result.spaces));
  assert.ok(Object.isFrozen(result.spaces[0]));
  for (const spaces of [
    undefined,
    null,
    {},
    [null],
    [{ ...space, kind: 'project' }],
    [{ ...space, id: '' }],
    [{ ...space, name: '' }],
    [space, space],
  ]) {
    await assert.rejects(
      createIdentityApi(async () => Response.json({ ...session, spaces })).session(),
      { code: 'invalid-response' },
    );
  }
  assert.deepEqual(
    (await createIdentityApi(async () => Response.json(session)).session()).spaces,
    [],
  );
});

test('identity HTTP contract: fixed recoverable errors never echo response details', async () => {
  for (const [status, code] of [
    [401, 'unauthenticated'],
    [403, 'untrusted-request'],
    [404, 'unavailable'],
    [429, 'login-rate-limited'],
    [503, 'unavailable'],
    [400, 'request-rejected'],
  ]) {
    const api = createIdentityApi(async () =>
      Response.json(
        { ok: false, error: { code: 'private-detail', message: 'private-response-body' } },
        { status },
      ),
    );
    await assert.rejects(
      api.session(),
      (error) =>
        error instanceof IdentityApiError &&
        error.code === code &&
        !error.message.includes('private-'),
    );
  }
  await assert.rejects(
    createIdentityApi(async () => new Response('', { status: 401 })).login({
      accountId: 'member-a',
      password: 'fixture-only',
    }),
    { code: 'invalid-login' },
  );
  await assert.rejects(
    createIdentityApi(async () => {
      throw Error('private-network-detail');
    }).session(),
    { code: 'unavailable' },
  );
});

test('identity HTTP contract: cancellation avoids an already cancelled request, timeout becomes unavailable', async (t) => {
  const cancelled = new AbortController();
  cancelled.abort();
  let calls = 0;
  await assert.rejects(
    createIdentityApi(async () => {
      ++calls;
      return Response.json(session);
    }).session(cancelled.signal),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    assert.equal(ms, 10_000);
    return timeout.signal;
  });
  const api = createIdentityApi(
    async (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  );
  const request = api.session();
  timeout.abort(new DOMException('fixture timeout', 'TimeoutError'));
  await assert.rejects(request, { code: 'unavailable' });
});
