import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { revisionQuery, revisionView } from './revision-fixture.mjs';

// Client response replay only; these controls do not establish server authorization.
const session = (accountId = 'chen', spaces = ['team-orders']) =>
  Response.json({
    ok: true,
    accountId,
    principal: { kind: 'zhuma-member', memberId: accountId },
    peerId: 'replay-peer',
    spaces: spaces.map((id) => ({ id, kind: 'team', name: id })),
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
};
const reply = (request, result = { ok: true, value: { view: revisionView() } }) =>
  Response.json({ type: 'server-response', rpcId: request.rpcId, result });
function scoped({ identity = session, service = reply, isCurrent = () => true } = {}) {
  const requests = [],
    inspections = [];
  const failures = { member: 0, space: 0 };
  const api = createExecutionHttpApi(
    async (url, options) => {
      if (url === '/zhuma-id/session') {
        inspections.push(options);
        return identity();
      }
      const request = JSON.parse(options.body);
      requests.push({ url, request, options });
      return service(request);
    },
    () => failures.member++,
    'chen',
    { spaceId: 'team-orders', isCurrent, onUnavailable: () => failures.space++ },
  );
  return { api, requests, inspections, failures };
}

test('revision HTTP: each read freshly prechecks the bound member/space and sends only the strict four fields', async () => {
  const held = deferred();
  const control = scoped({ identity: async () => (await held.promise).clone() });
  const pending = control.api.revision({ ...revisionQuery, spaceId: 'injected', actorId: 'lin' });
  assert.equal(control.requests.length, 0);
  held.resolve(session());
  assert.deepEqual(await pending, revisionView());
  assert.deepEqual(control.requests[0].request.payload, revisionQuery);
  assert.equal(control.requests[0].url, '/api/zhuma-exec/revision');
  assert.equal(control.requests[0].options.credentials, 'same-origin');
  assert.equal(control.requests[0].options.cache, 'no-store');
  await control.api.revision(revisionQuery);
  assert.equal(control.inspections.length, 2);
  assert.equal(control.requests.length, 2);
});

for (const [name, identity, expected] of [
  ['revoked space', () => session('chen', []), { member: 0, space: 1 }],
  ['changed account', () => session('lin'), { member: 1, space: 0 }],
  ['expired login', () => Response.json({}, { status: 401 }), { member: 1, space: 0 }],
]) {
  test(`revision HTTP: ${name} prevents dispatch`, async () => {
    const control = scoped({ identity });
    await assert.rejects(control.api.revision(revisionQuery));
    assert.equal(control.requests.length, 0);
    assert.deepEqual(control.failures, expected);
  });
}

test('revision HTTP: changing view while precheck is held prevents dispatch without invalidating the new context', async () => {
  const held = deferred();
  let current = true;
  const control = scoped({ identity: () => held.promise, isCurrent: () => current });
  const pending = control.api.revision(revisionQuery);
  current = false;
  held.resolve(session());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(control.requests.length, 0);
  assert.deepEqual(control.failures, { member: 0, space: 0 });
});

for (const outcome of ['success', '401', 'denial']) {
  test(`revision HTTP: late ${outcome} cannot affect a replacement view`, async () => {
    const entered = deferred(),
      held = deferred();
    let current = true,
      request;
    const control = scoped({
      isCurrent: () => current,
      service: (next) => {
        request = next;
        entered.resolve();
        return held.promise;
      },
    });
    const pending = control.api.revision(revisionQuery);
    await entered.promise;
    current = false;
    held.resolve(
      outcome === '401'
        ? Response.json({}, { status: 401 })
        : reply(
            request,
            outcome === 'denial'
              ? {
                  ok: false,
                  error: { code: 'not-participant', message: 'old denial', details: {} },
                }
              : undefined,
          ),
    );
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(control.failures, { member: 0, space: 0 });
  });
}

for (const code of ['not-found', 'not-returned', 'not-participant']) {
  test(`revision HTTP: ${code} stays a local typed error, without retry or whole-space teardown`, async () => {
    const control = scoped({
      service: (request) =>
        reply(request, {
          ok: false,
          error: { code, message: '请刷新待办后重试。', details: {} },
        }),
    });
    await assert.rejects(control.api.revision(revisionQuery), (error) => error.code === code);
    assert.equal(control.requests.length, 1);
    assert.deepEqual(control.failures, { member: 0, space: 0 });
  });
}

test('revision HTTP: current endpoint401 invalidates the member; aborted reads do not dispatch', async () => {
  const control = scoped({ service: () => Response.json({}, { status: 401 }) });
  await assert.rejects(
    control.api.revision(revisionQuery),
    (error) => error.code === 'unauthenticated',
  );
  assert.deepEqual(control.failures, { member: 1, space: 0 });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(control.api.revision(revisionQuery, abort.signal), { name: 'AbortError' });
  assert.equal(control.requests.length, 1);
});
