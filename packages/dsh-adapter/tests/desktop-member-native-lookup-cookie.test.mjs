/** Real Connection/identity/private HTTP route over Node HTTP. Lookup/Run facts
 * are explicit ports; this does not certify an Agent, SDK history or model. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDesktopMemberCookieBridge } from '../dist/desktop-member-cookie.js';
import { openHostMemberNativeHttp } from '../dist/host-member-native-http.js';
import { resolveMember } from '../dist/member-session.js';
import { hashPassword } from '../dist/identity-session.js';
import { bootIdentity } from './member-host.mjs';

test('desktop lookup HTTP: original member credentials reach local task reads while owner-only ordinary navigation remains available', async () => {
  const password = randomBytes(24).toString('hex');
  const host = await bootIdentity(
    { accounts: [{ id: 'chen', passwordHash: hashPassword(password) }], notes: [] },
    'multi-member',
    {
      spaces: [{ id: 'space', kind: 'team', name: 'Team' }],
      memberships: [{ spaceId: 'space', accountId: 'chen' }],
    },
    { publish() {} },
  );
  const sessionId = 'contract-native-session';
  const scope = {
    actorId: 'chen',
    spaceId: 'space',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
  };
  let reads = 0;
  const sdkFrame = {
    type: 'snapshot',
    header: { id: sessionId },
    cursor: -1,
    records: [],
    hasMore: false,
    assistantStream: { revision: 0 },
  };
  const authorizeConversation = async (request, data) => {
    const member = await resolveMember(host.ctx, request);
    if (!member.ok || member.memberId !== scope.actorId || !member.spaceIds.includes(scope.spaceId))
      throw Error('member required');
    assert.equal(data.actorId, scope.actorId);
    assert.equal(data.spaceId, scope.spaceId);
  };
  const source = {
    conversation: {
      async available(request, data) {
        await authorizeConversation(request, data);
        return true;
      },
      async page(request, data) {
        await authorizeConversation(request, data);
        return { records: sdkFrame.records, hasMore: false };
      },
      async follow(request, data, sink, signal) {
        await authorizeConversation(request, data);
        await sink(sdkFrame, signal);
      },
    },
    lookupNativeSession(id) {
      return id === sessionId ? { role: 'work', binding: { scope } } : null;
    },
    operations: {
      async read(request, locator) {
        reads++;
        const member = await resolveMember(host.ctx, request);
        if (
          !member.ok ||
          member.memberId !== scope.actorId ||
          !member.spaceIds.includes(scope.spaceId)
        )
          return { ok: false };
        assert.deepEqual(locator, {
          taskId: 'task',
          planId: 'plan',
          revision: 1,
          nodeId: 'node',
          runId: 'run',
        });
        return { ok: true, value: { native: { sessionId } } };
      },
    },
  };
  const transport = openHostMemberNativeHttp(host.ctx, () => undefined, {
    source: () => source,
    backend: () => ({ status: async () => ({ origin: null, connectionId: null }) }),
  });
  const server = http.createServer((request, response) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname === '/') {
      host.ctx.connection.authorizeIndex(request, response);
      if (!response.writableEnded) response.end();
    } else
      void host.web.dispatch(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const owned = await fetch(host.ctx.connection.authenticatedUrl(`${origin}/`), {
      redirect: 'manual',
    });
    assert.equal(owned.status, 303);
    const owner = owned.headers.get('set-cookie').split(';', 1)[0];
    await owned.body?.cancel();
    const bridge = createDesktopMemberCookieBridge();
    async function call(path, body, headers = {}, streaming = false) {
      const input = new Request(`dsh-app://app${path}`, {
        method: 'POST',
        headers: { origin: 'dsh-app://app', ...headers },
        body: JSON.stringify(body),
      });
      const response = await bridge.forward(input, origin, owner, (cookie) =>
        fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { host: new URL(origin).host, cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: input.signal,
        }),
      );
      assert.equal(response.headers.get('set-cookie'), null);
      return {
        status: response.status,
        body: streaming ? await response.text() : await response.json(),
      };
    }
    const lookup = (id = sessionId, actorId = 'chen') =>
      call(
        '/api/zhuma-member-native/lookup',
        {
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'zhuma-member-native/lookup',
          payload: { connectionId: null, actorId, spaceId: 'space', query: { sessionId: id } },
        },
        { cookie: 'zhuma-member=renderer-forgery' },
      );
    const originalHistory = (endpoint) =>
      call(
        `/api/zhuma-member-native/${endpoint}`,
        {
          type: 'client-request',
          rpcId: randomUUID(),
          method: `zhuma-member-native/${endpoint}`,
          payload: {
            connectionId: null,
            actorId: 'chen',
            spaceId: 'space',
            query: {
              sessionId,
              target: scope,
              request: { address: { kind: 'session', sessionId } },
            },
          },
        },
        { cookie: 'zhuma-member=renderer-forgery' },
        endpoint === 'session-follow',
      );
    assert.equal((await originalHistory('session-page')).body.result.ok, false);
    assert.equal((await lookup()).status, 403, 'An SDK owner alone is not a product member');
    const ordinary = await lookup('ordinary');
    assert.equal(ordinary.status, 200);
    assert.deepEqual(ordinary.body.result, { ok: true, value: { kind: 'ordinary' } });
    assert.equal((await call('/zhuma-id/login', { accountId: 'chen', password })).status, 200);
    assert.deepEqual((await originalHistory('session-page')).body.result, {
      ok: true,
      value: { records: [], hasMore: false },
    });
    const followed = await originalHistory('session-follow');
    assert.equal(followed.status, 200);
    assert.deepEqual(JSON.parse(followed.body.trim()).frame, sdkFrame);
    const opened = await lookup();
    assert.equal(opened.status, 200);
    assert.deepEqual(opened.body.result, {
      ok: true,
      value: {
        kind: 'task',
        presentation: 'sdk-native',
        target: {
          spaceId: 'space',
          taskId: 'task',
          planId: 'plan',
          revision: 1,
          nodeId: 'node',
          runId: 'run',
          generation: 1,
          segmentId: 'segment',
        },
        sessionId,
      },
    });
    assert.equal((await lookup(sessionId, 'foreign')).status, 403);
    assert.equal((await call('/zhuma-id/logout', {})).status, 200);
    assert.equal((await originalHistory('session-page')).body.result.ok, false);
    assert.equal((await lookup()).status, 403);
    assert.equal(reads, 3);
  } finally {
    await transport.close();
    await new Promise((resolve) => server.close(resolve));
    await host.dispose();
  }
});
