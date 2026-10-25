import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { groupedInbox } from './inbox-groups-fixture.mjs';

function scoped({ result, current = () => true } = {}) {
  const calls = [],
    failures = { member: 0, space: 0 };
  const api = createExecutionHttpApi(
    async (url, options) => {
      if (url === '/zhuma-id/session')
        return Response.json({
          ok: true,
          accountId: 'chen',
          principal: { kind: 'zhuma-member', memberId: 'chen' },
          peerId: 'fixture',
          spaces: [{ id: 'team', name: '团队', kind: 'team' }],
        });
      const request = JSON.parse(options.body);
      calls.push({ url, request });
      if (result) return result(request);
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { ...groupedInbox(), spaceId: 'team' } },
      });
    },
    () => failures.member++,
    'chen',
    { spaceId: 'team', isCurrent: current, onUnavailable: () => failures.space++ },
  );
  return { api, calls, failures };
}

test('places member HTTP uses the existing scoped inbox route and preserves the approved projection', async () => {
  const c = scoped();
  const value = await c.api.inbox();
  assert.deepEqual(value.places, groupedInbox().places);
  assert.deepEqual(c.calls[0].request.payload, { spaceId: 'team' });
  assert.equal(c.calls[0].url, '/api/zhuma-exec/inbox');
  assert.deepEqual(c.failures, { member: 0, space: 0 });
});

for (const [field, value, code, expected] of [
  ['spaceId', 'other-space', 'scope-mismatch', { member: 0, space: 1 }],
  ['actorId', 'other-member', 'unauthenticated', { member: 1, space: 0 }],
])
  test(`places cannot bypass the existing ${field} reply gate`, async () => {
    const c = scoped({
      result: (request) =>
        Response.json({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              ...groupedInbox(),
              spaceId: 'team',
              [field]: value,
              places: [
                {
                  itemId: 'item-0',
                  taskPath: 'cross-scope-canary',
                  ownerName: 'cross-owner-canary',
                },
              ],
            },
          },
        }),
    });
    await assert.rejects(
      c.api.inbox(),
      (error) => error.code === code && !JSON.stringify(error).includes('canary'),
    );
    assert.deepEqual(c.failures, expected);
  });

test('places in a late response are discarded before any replacement-context callback', async () => {
  let release,
    entered,
    current = true,
    request;
  const started = new Promise((yes) => {
    entered = yes;
  });
  const held = new Promise((yes) => {
    release = yes;
  });
  const c = scoped({
    current: () => current,
    result: (value) => {
      request = value;
      entered();
      return held;
    },
  });
  const pending = c.api.inbox();
  await started;
  current = false;
  release(
    Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value: { ...groupedInbox(), spaceId: 'team' } },
    }),
  );
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(c.failures, { member: 0, space: 0 });
});
