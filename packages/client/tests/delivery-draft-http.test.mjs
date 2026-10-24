import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { revisionQuery } from './revision-fixture.mjs';

const session = (spaces = ['team']) =>
  Response.json({
    ok: true,
    accountId: 'chen',
    principal: { kind: 'zhuma-member', memberId: 'chen' },
    peerId: 'replay',
    spaces: spaces.map((id) => ({ id, name: id, kind: 'team' })),
  });
const requestFor = (method) =>
  method === 'readDeliveryDraft'
    ? revisionQuery
    : {
        ...revisionQuery,
        expectedVersion: 8,
        idempotencyKey: 'save-once',
        text: 'current',
        links: [],
        files: [],
      };
function control({ identity = session, result, current = () => true } = {}) {
  const calls = [],
    failure = { member: 0, space: 0 };
  const api = createExecutionHttpApi(
    async (url, options) => {
      if (url === '/zhuma-id/session') return identity();
      const request = JSON.parse(options.body);
      calls.push({ url, request, options });
      if (result) return result(request);
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            version: 'idempotencyKey' in request.payload ? 9 : 8,
            text: '',
            links: [],
            files: [],
          },
        },
      });
    },
    () => failure.member++,
    'chen',
    { spaceId: 'team', isCurrent: current, onUnavailable: () => failure.space++ },
  );
  return { api, calls, failure };
}

for (const method of ['readDeliveryDraft', 'saveDeliveryDraft']) {
  test(`draft HTTP ${method}: uses bound precheck, strict payload and same-origin endpoint`, async () => {
    let inspections = 0;
    const c = control({
      identity: () => {
        inspections++;
        return session();
      },
    });
    const payload = requestFor(method);
    await c.api[method]({ ...payload, actorId: 'ignored', spaceId: 'ignored' });
    await c.api[method](payload);
    assert.equal(inspections, 2);
    assert.deepEqual(c.calls[0].request.payload, payload);
    assert.equal(c.calls[0].url, '/api/zhuma-exec/draft');
    assert.equal(c.calls[0].options.credentials, 'same-origin');
    assert.equal(c.calls[0].options.cache, 'no-store');
  });
  test(`draft HTTP ${method}: revoked membership prevents the request`, async () => {
    const c = control({ identity: () => session([]) });
    await assert.rejects(
      c.api[method](requestFor(method)),
      (error) => error.code === 'space-unavailable',
    );
    assert.equal(c.calls.length, 0);
    assert.deepEqual(c.failure, { member: 0, space: 1 });
  });
  test(`draft HTTP ${method}: late401 after a context replacement cannot invalidate the new member`, async () => {
    let release,
      entered,
      active = true;
    const started = new Promise((yes) => {
      entered = yes;
    });
    const held = new Promise((yes) => {
      release = yes;
    });
    const c = control({
      current: () => active,
      result: () => {
        entered();
        return held;
      },
    });
    const pending = c.api[method](requestFor(method));
    await started;
    active = false;
    release(Response.json({}, { status: 401 }));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(c.failure, { member: 0, space: 0 });
  });
  test(`draft HTTP ${method}: typed rejection stays local and preserves version details`, async () => {
    const c = control({
      result: (request) =>
        Response.json({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: false,
            error: { code: 'conflict', message: '草稿版本冲突。', details: { currentVersion: 10 } },
          },
        }),
    });
    await assert.rejects(
      c.api[method](requestFor(method)),
      (error) => error.code === 'conflict' && error.details.currentVersion === 10,
    );
    assert.equal(c.calls.length, 1);
    assert.deepEqual(c.failure, { member: 0, space: 0 });
  });
}
