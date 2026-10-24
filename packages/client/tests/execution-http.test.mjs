import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { ExecutionError } from '../dist/execution/ExecutionApi.js';
import { inbox, reviewNode } from './browser/execution-fixture.mjs';

function transport(handler, invalidate = () => {}, expectedActorId) {
  const calls = [];
  return {
    calls,
    api: createExecutionHttpApi(
      async (url, options) => {
        const request = JSON.parse(options.body);
        calls.push({ url, options, request });
        return handler(request, options);
      },
      invalidate,
      expectedActorId,
    ),
  };
}
const reply = (request, value) =>
  Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } });

test('member execution uses same-origin Fetch and the exact RPC envelope without an actor override', async () => {
  const { api, calls } = transport((request) => reply(request, inbox([reviewNode])));
  assert.equal((await api.inbox()).actorId, 'chen');
  const { url, options, request } = calls[0];
  assert.equal(url, '/api/zhuma-exec/inbox');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.equal(request.type, 'client-request');
  assert.deepEqual(request.payload, {});
});

test('HTTP401 invalidates only the current member session and preserves a fixed public error', async () => {
  let invalidations = 0;
  const { api } = transport(
    () => Response.json({ private: 'never show raw transport body' }, { status: 401 }),
    () => invalidations++,
  );
  await assert.rejects(
    api.inbox(),
    (error) =>
      error instanceof ExecutionError &&
      error.code === 'unauthenticated' &&
      error.details.status === 401 &&
      !error.message.includes('private'),
  );
  assert.equal(invalidations, 1);
});

test('aborted or late401 requests cannot invalidate a newer session', async () => {
  let invalidations = 0;
  const controller = new AbortController();
  const { api, calls } = transport(
    () => {
      controller.abort();
      return Response.json({}, { status: 401 });
    },
    () => invalidations++,
  );
  await assert.rejects(api.inbox(controller.signal), (error) => error.name === 'AbortError');
  assert.equal(invalidations, 0);
  assert.equal(calls[0].options.signal.aborted, true);
  await assert.rejects(api.inbox(controller.signal), (error) => error.name === 'AbortError');
  assert.equal(calls.length, 1);
});

for (const status of [403, 404, 413, 500]) {
  test(`HTTP${status} is closed without invalidating the member or echoing diagnostics`, async () => {
    let invalidations = 0;
    const { api } = transport(
      () => Response.json({ detail: 'private diagnostic' }, { status }),
      () => invalidations++,
    );
    await assert.rejects(
      api.inbox(),
      (error) => error.details.status === status && !error.message.includes('private'),
    );
    assert.equal(invalidations, 0);
  });
}

test('wrong RPC ids, malformed results and directory rejection never turn into a usable inbox', async () => {
  for (const result of [
    Response.json({ type: 'server-response', rpcId: 'wrong', result: {} }),
    Response.json({}),
  ]) {
    const { api } = transport(() => result);
    await assert.rejects(api.inbox(), (error) => error.code === 'validation');
  }
  let invalidations = 0;
  const { api } = transport(
    (request) =>
      Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: false,
          error: { code: 'not-in-directory', message: '当前账号尚未加入团队。', details: {} },
        },
      }),
    () => invalidations++,
  );
  await assert.rejects(api.inbox(), (error) => error.code === 'not-in-directory');
  assert.equal(invalidations, 0);
});

for (const method of ['inbox', 'startable']) {
  test(`${method} from a different member never reaches the current session view`, async () => {
    let invalidations = 0;
    const value =
      method === 'inbox' ? { actorId: 'lin', nodes: [], items: [] } : { actorId: 'lin', plans: [] };
    const { api } = transport(
      (request) => reply(request, value),
      () => invalidations++,
      'chen',
    );
    await assert.rejects(api[method](), (error) => error.code === 'unauthenticated');
    assert.equal(invalidations, 1);
  });
}

test('startable uses the member HTTP route and aborted reads cannot invalidate another session', async () => {
  let invalidations = 0;
  const controller = new AbortController();
  const { api, calls } = transport(
    (request) => {
      controller.abort();
      return reply(request, { actorId: 'lin', plans: [] });
    },
    () => invalidations++,
    'chen',
  );
  await assert.rejects(api.startable(controller.signal), (error) => error.name === 'AbortError');
  assert.equal(calls[0].url, '/api/zhuma-exec/startable');
  assert.deepEqual(calls[0].request.payload, {});
  assert.equal(invalidations, 0);
});
