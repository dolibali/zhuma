import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionApi } from '../dist/execution/ExecutionApi.js';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { deliveryNode, reviewNode } from './browser/execution-fixture.mjs';

const spaceId = 'team-a';
const session = (spaces = [spaceId], accountId = 'chen') => ({
  ok: true,
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: 'request-peer',
  spaces: spaces.map((id) => ({ id, kind: 'team', name: id })),
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const valueFor = (method, payload) =>
  method.endsWith('/inbox')
    ? { actorId: 'chen', spaceId: payload.spaceId, items: [], nodes: [] }
    : method.endsWith('/startable')
      ? { actorId: 'chen', spaceId: payload.spaceId, plans: [] }
      : method.endsWith('/start-plan')
        ? { disposition: 'applied', reports: [] }
        : { node: method.endsWith('/ballot') ? reviewNode : deliveryNode };
function scoped({
  identity = async () => Response.json(session()),
  service,
  binding = spaceId,
  isCurrent,
} = {}) {
  const calls = [],
    inspections = [];
  const failures = { member: 0, space: 0 };
  const api = createExecutionHttpApi(
    async (url, options) => {
      if (url === '/zhuma-id/session') {
        inspections.push(options);
        return identity(options);
      }
      const request = JSON.parse(options.body);
      calls.push({ url, request, options });
      return service
        ? service(request, options)
        : Response.json({
            type: 'server-response',
            rpcId: request.rpcId,
            result: { ok: true, value: valueFor(request.method, request.payload) },
          });
    },
    () => failures.member++,
    'chen',
    { spaceId: binding, onUnavailable: () => failures.space++, isCurrent },
  );
  return { api, calls, inspections, failures };
}
const plan = { taskId: 'task', planId: 'plan', revision: 1, idempotencyKey: 'begin-once' };

test('scoped HTTP contract: changed view generation before React cleanup prevents dispatch after a pending precheck', async () => {
  let current = true;
  const held = deferred();
  const caller = new AbortController();
  const { api, calls, failures } = scoped({
    identity: () => held.promise,
    isCurrent: () => current,
  });
  const pending = api.startPlan(plan, caller.signal);
  current = false;
  held.resolve(Response.json(session()));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(caller.signal.aborted, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(failures, { member: 0, space: 0 });
});

for (const outcome of ['success', '401', 'not-found', 'reject']) {
  test(`scoped HTTP contract: stale generation ${outcome} is ignored before its caller signal is aborted`, async () => {
    let current = true;
    const entered = deferred(),
      held = deferred();
    const caller = new AbortController();
    let request;
    const { api, failures } = scoped({
      isCurrent: () => current,
      service: (next) => {
        request = next;
        entered.resolve();
        return held.promise;
      },
    });
    const pending = api.inbox(caller.signal);
    await entered.promise;
    current = false;
    if (outcome === 'reject') held.reject(Error('old network rejection'));
    else
      held.resolve(
        outcome === '401'
          ? new Response('', { status: 401 })
          : Response.json({
              type: 'server-response',
              rpcId: request.rpcId,
              result:
                outcome === 'not-found'
                  ? { ok: false, error: { code: 'not-found', message: 'old denial', details: {} } }
                  : { ok: true, value: valueFor(request.method, request.payload) },
            }),
      );
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(caller.signal.aborted, false);
    assert.deepEqual(failures, { member: 0, space: 0 });
  });
}

test('scoped RPC contract: queries and explicit start bind the selected space, commands retain their actual DTOs', async () => {
  const calls = [];
  const api = createExecutionApi(
    {
      async call(channel, method, payload) {
        calls.push({ channel, method, payload });
        return { ok: true, value: valueFor(method, payload) };
      },
    },
    spaceId,
  );
  assert.equal((await api.inbox()).spaceId, spaceId);
  assert.equal((await api.startable()).spaceId, spaceId);
  await api.startPlan(plan);
  assert.ok(calls.every(({ payload }) => payload.spaceId === spaceId));
  assert.deepEqual(calls[2].payload, { ...plan, spaceId });
  await assert.rejects(api.startPlan({ ...plan, spaceId: 'team-b' }), { code: 'scope-mismatch' });
  assert.equal(calls.length, 3);
  assert.throws(() => createExecutionApi({}, ''), { code: 'validation' });
});

for (const method of ['inbox', 'startable']) {
  test(`scoped RPC contract: ${method} rejects wrong or missing scope, including empty projections`, async () => {
    for (const echo of [undefined, 'team-b', null, 123]) {
      const api = createExecutionApi(
        {
          async call(_, endpoint, payload) {
            return { ok: true, value: { ...valueFor(endpoint, payload), spaceId: echo } };
          },
        },
        spaceId,
      );
      await assert.rejects(api[method](), (error) =>
        ['scope-mismatch', 'validation'].includes(error.code),
      );
    }
  });
}

test('scoped HTTP contract: each sequential operation rechecks the member, with no positive authorization cache', async () => {
  const { api, calls, inspections } = scoped();
  await api.inbox();
  await api.startable();
  await api.startPlan(plan);
  await api.submit({
    ...deliveryNode,
    expectedVersion: deliveryNode.version,
    text: 'draft',
    idempotencyKey: 'submit-once',
  });
  await api.ballot({
    ...reviewNode,
    expectedVersion: reviewNode.version,
    roundId: reviewNode.currentRoundId,
    artifactVersionId: reviewNode.artifacts[0].id,
    action: 'comment',
    comment: 'review',
    idempotencyKey: 'review-once',
  });
  assert.equal(inspections.length, 5);
  assert.equal(calls.length, 5);
  for (const entry of inspections) {
    assert.equal(entry.method, 'GET');
    assert.equal(entry.credentials, 'same-origin');
    assert.equal(entry.cache, 'no-store');
  }
  for (const { request } of calls) assert.equal(request.payload.actorId, undefined);
  assert.ok(calls.slice(0, 3).every(({ request }) => request.payload.spaceId === spaceId));
  assert.ok(calls.slice(3).every(({ request }) => request.payload.spaceId === undefined));
  assert.throws(
    () => createExecutionHttpApi(fetch, undefined, undefined, { spaceId, onUnavailable() {} }),
    { code: 'validation' },
  );
});

test('scoped HTTP contract: concurrent queries share only a pending session read, and one cancellation leaves the other alive', async () => {
  const held = deferred();
  let reads = 0;
  const { api, calls, inspections, failures } = scoped({
    identity: async () => (++reads === 1 ? held.promise : Response.json(session())),
  });
  const first = new AbortController();
  const a = api.inbox(first.signal),
    b = api.startable();
  const cancelled = assert.rejects(a, { name: 'AbortError' });
  assert.equal(inspections.length, 1);
  first.abort();
  await cancelled;
  assert.equal(inspections[0].signal.aborted, false);
  held.resolve(Response.json(session()));
  await b;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.method, 'zhuma-exec/startable');
  await api.inbox();
  assert.equal(inspections.length, 2);
  assert.deepEqual(failures, { member: 0, space: 0 });
});

test('scoped HTTP contract: aborting every consumer releases the read; late old membership cannot poison its replacement', async () => {
  const held = deferred();
  let count = 0;
  const { api, inspections, calls, failures } = scoped({
    identity: async () => (++count === 1 ? held.promise : Response.json(session())),
  });
  const abort = new AbortController();
  const request = api.inbox(abort.signal);
  const cancelled = assert.rejects(request, { name: 'AbortError' });
  abort.abort();
  await cancelled;
  assert.ok(inspections[0].signal.aborted);
  await api.startable();
  held.resolve(Response.json(session([], 'other-member')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inspections.length, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(failures, { member: 0, space: 0 });
});

for (const [name, identity, expected, failure] of [
  ['revoked space', () => Response.json(session([])), 'space-unavailable', 'space'],
  ['changed account', () => Response.json(session([spaceId], 'lin')), 'unauthenticated', 'member'],
  ['expired session', () => new Response('', { status: 401 }), 'unauthenticated', 'member'],
  ['directory failure', () => new Response('', { status: 503 }), 'scope-unavailable', 'space'],
  ['malformed session', () => Response.json({ ok: true }), 'scope-unavailable', 'space'],
]) {
  test(`scoped HTTP contract: ${name} closes before any execution request`, async () => {
    const { api, calls, failures } = scoped({ identity });
    await assert.rejects(api.startPlan(plan), { code: expected });
    assert.equal(calls.length, 0);
    assert.equal(failures[failure], 1);
  });
}

for (const method of ['inbox', 'startable']) {
  test(`scoped HTTP contract: ${method} scope mismatch closes the current projection without account fallback`, async () => {
    const { api, failures } = scoped({
      service: (request) =>
        Response.json({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: { ...valueFor(request.method, request.payload), spaceId: 'team-b' },
          },
        }),
    });
    await assert.rejects(api[method](), { code: 'scope-mismatch' });
    assert.deepEqual(failures, { member: 0, space: 1 });
  });
}

for (const code of ['not-found', 'unavailable']) {
  test(`scoped HTTP contract: precheck does not turn a service ${code} denial into success or a replay`, async () => {
    const { api, calls, failures } = scoped({
      service: (request) =>
        Response.json({
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: false, error: { code, message: 'Request denied', details: {} } },
        }),
    });
    await assert.rejects(api.startPlan(plan), { code });
    assert.equal(calls.length, 1);
    assert.equal(failures.member, 0);
    await assert.rejects(api.inbox(), { code });
    assert.equal(failures.space, 1);
  });
}

test('scoped HTTP contract: a service401 after valid precheck expires the member without dispatching a replacement request', async () => {
  const { api, calls, failures } = scoped({ service: () => new Response('', { status: 401 }) });
  await assert.rejects(api.startPlan(plan), { code: 'unauthenticated' });
  assert.equal(calls.length, 1);
  assert.deepEqual(failures, { member: 1, space: 0 });
});

test('scoped HTTP contract: different space API instances never share an in-flight authorization read', async () => {
  const a = deferred(),
    b = deferred();
  let count = 0;
  const identity = async () => Response.json(await (++count === 1 ? a.promise : b.promise));
  const first = scoped({ identity }),
    second = scoped({ identity, binding: 'team-b' });
  const oldAbort = new AbortController();
  const old = first.api.inbox(oldAbort.signal),
    current = second.api.inbox();
  const rejected = assert.rejects(old, { name: 'AbortError' });
  assert.equal(count, 2);
  oldAbort.abort();
  await rejected;
  assert.equal(second.inspections[0].signal.aborted, false);
  b.resolve(session(['team-b']));
  await current;
  a.resolve(session([], 'old-member'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].request.payload.spaceId, 'team-b');
  assert.deepEqual(second.failures, { member: 0, space: 0 });
});

for (const outcome of ['success', 'wrong-scope', '401']) {
  test(`scoped HTTP contract: late service ${outcome} after abort cannot affect another context`, async () => {
    const held = deferred();
    const entered = deferred();
    let request;
    const { api, failures } = scoped({
      service: (next) => {
        request = next;
        entered.resolve();
        return held.promise;
      },
    });
    const abort = new AbortController();
    const pending = api.inbox(abort.signal);
    await entered.promise;
    abort.abort();
    held.resolve(
      outcome === '401'
        ? new Response('', { status: 401 })
        : Response.json({
            type: 'server-response',
            rpcId: request.rpcId,
            result: {
              ok: true,
              value: {
                ...valueFor(request.method, request.payload),
                spaceId: outcome === 'wrong-scope' ? 'team-b' : spaceId,
              },
            },
          }),
    );
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(failures, { member: 0, space: 0 });
  });
}
