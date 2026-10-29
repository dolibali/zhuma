/** Exact private-owner route contracts; synthetic sources are not SDK/Run proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openHostMemberNativeHttp } from '../dist/host-member-native-http.js';
import { publicMemberNativeHistory } from '../dist/host-member-native-owner.js';

test('member history retains the original safe turn boundary without provider or hook details', () => {
  const value = publicMemberNativeHistory({
    seq: 10,
    time: 20,
    type: 'turn/end',
    data: {
      turn: 2,
      reason: { kind: 'max-tokens', provider: 'private', error: 'private' },
      internal: 'private',
    },
  });
  assert.deepEqual(value, {
    seq: 10,
    time: 20,
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'max-tokens' } },
  });
  assert.equal(JSON.stringify(value).includes('private'), false);
});
function setup() {
  const routes = new Map();
  let principal = 'owner',
    calls = 0;
  const source = {
    connectionId: randomUUID(),
    actorId: 'member',
    async handle(endpoint, payload) {
      calls++;
      return { endpoint, payload };
    },
  };
  let current = source;
  const ctx = {
    connection: {
      requestRejection: () => undefined,
      admit: () => ({ peer: { principal: { kind: principal } } }),
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
    effect(fn) {
      fn();
    },
  };
  const opened = openHostMemberNativeHttp(ctx, () => current);
  const request = (endpoint, query = {}, extra = {}) =>
    new Request(`http://local/api/zhuma-member-native/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: `zhuma-member-native/${endpoint}`,
        payload: {
          connectionId: source.connectionId,
          actorId: 'member',
          spaceId: 'space',
          query,
          ...extra,
        },
      }),
    });
  return {
    routes,
    source,
    request,
    opened,
    setPrincipal: (value) => {
      principal = value;
    },
    replace: () => {
      current = { ...source };
    },
    calls: () => calls,
  };
}
test('member native private HTTP: original SDK owner required before any body read or source call', async () => {
  const h = setup();
  h.setPrincipal('zhuma-member');
  const request = h.request('begin');
  request.json = () => assert.fail('must not read body');
  const reply = await h.routes.get('/api/zhuma-member-native/begin').fetch(request);
  assert.equal(reply.status, 403);
  assert.equal(h.calls(), 0);
  assert.equal(h.routes.size, 21);
  for (const endpoint of [
    'review-options',
    'review-start',
    'review-read',
    'review-stop',
    'review-session',
    'review-recover',
    'review-session-stop',
    'workflow-options',
    'workflow-read',
    'workflow-start',
    'workflow-resume',
    'workflow-stop',
  ]) {
    const response = await h.routes
      .get(`/api/zhuma-member-native/${endpoint}`)
      .fetch(h.request(endpoint));
    assert.equal(response.status, 403);
  }
  assert.equal(h.calls(), 0);
  await h.opened.close();
});
test('member native private HTTP: connection/actor and exact space envelope are checked before dispatch', async () => {
  const h = setup();
  const route = h.routes.get('/api/zhuma-member-native/read');
  for (const request of [
    h.request('read', {}, { connectionId: randomUUID() }),
    h.request('read', {}, { actorId: 'foreign' }),
    h.request('read', { spaceId: 'foreign' }),
  ]) {
    const response = await route.fetch(request);
    assert(response.status >= 400);
  }
  assert.equal(h.calls(), 0);
  const value = await (await route.fetch(h.request('read', { taskId: 'task' }))).json();
  assert.deepEqual(value.result.value.payload, { taskId: 'task', spaceId: 'space' });
  assert.equal(h.calls(), 1);
  await h.opened.close();
});
test('member native history projection excludes injected context, arguments and unknown private fields', () => {
  const secret = 'SYNTHETIC_PRIVATE_CONTEXT';
  const hidden = publicMemberNativeHistory({
    seq: 1,
    time: 0,
    type: 'user/message',
    data: { role: 'user', source: { kind: 'context' }, content: [{ type: 'text', text: secret }] },
  });
  assert.equal(JSON.stringify(hidden).includes(secret), false);
  assert.equal(hidden.seq, 1);
  const tool = publicMemberNativeHistory({
    seq: 2,
    time: 1,
    type: 'tool/call',
    data: { name: 'read', arguments: secret },
  });
  assert.deepEqual(tool.data, { name: 'read' });
  const model = publicMemberNativeHistory({
    seq: 3,
    time: 2,
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        source: { kind: 'model', private: secret },
        content: [
          { type: 'text', text: 'Public reply' },
          { type: 'reasoning', text: secret },
        ],
      },
      extra: secret,
    },
  });
  assert.equal(JSON.stringify(model).includes(secret), false);
  assert.equal(model.data.message.content[0].text, 'Public reply');
});
