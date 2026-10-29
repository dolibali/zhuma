import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { createDesktopMemberCookieBridge } from '../dist/desktop-member-cookie.js';
import { hostWorkflowEndpoints } from '../dist/host-workflow-http.js';
import { knowledgeEndpoints } from '../dist/knowledge-http.js';
import { hashPassword } from '../dist/identity-session.js';
import {
  apply as applyExecution,
  inject as executionInject,
  executionEndpoints,
} from '../dist/execution-plugin.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { bootIdentity } from './member-host.mjs';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const HOST = 'http://127.0.0.1:3080/';
const OWNER = 'dsh-session=owner-transport-canary';
const COOKIE_A = 'member-a-canary';
const COOKIE_B = 'member-b-canary';
const cookie = (value, age = 3600) =>
  `zhuma-member=${value}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict`;
const request = (path, init = {}) => new Request(`dsh-app://app${path}`, init);
const reply = (value) => new Response('{}', { headers: { 'set-cookie': cookie(value) } });
const deferred = () => Promise.withResolvers();
// An explicit emitted desktop artifact is used only by the isolated patch verification command.
const patchedDesktop = process.env.ZHUMA_DESKTOP_FORWARD_MODULE
  ? await import(pathToFileURL(process.env.ZHUMA_DESKTOP_FORWARD_MODULE).href)
  : undefined;

async function login(bridge, value = COOKIE_A, host = HOST, owner = OWNER) {
  const result = await bridge.forward(
    request('/zhuma-id/login', { method: 'POST' }),
    host,
    owner,
    async (sent) => {
      assert.equal(sent, owner);
      return reply(value);
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('set-cookie'), null);
}

async function sentCookie(bridge, path = '/zhuma-id/session', host = HOST, owner = OWNER) {
  let sent;
  const result = await bridge.forward(request(path), host, owner, async (credential) => {
    sent = credential;
    return new Response('{}');
  });
  assert.equal(result.status, sent === undefined ? 401 : 200);
  return sent;
}

test('desktop transport contract: only exact member routes carry the private member cookie', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  for (const path of [
    '/zhuma-id/session',
    '/zhuma-id/spaces/team-empty',
    '/zhuma-id/notes/note-a',
    ...['snapshot', 'command', 'plan'].map((endpoint) => `/api/zhuma-member/${endpoint}`),
    ...executionEndpoints.map((endpoint) => `/api/zhuma-exec/${endpoint}`),
    ...knowledgeEndpoints.map((endpoint) => `/api/zhuma-knowledge/${endpoint}`),
    ...['begin', 'send', 'stop', 'read', 'history', 'options', 'inbox', 'observe'].map(
      (endpoint) => `/api/zhuma-run/${endpoint}`,
    ),
  ])
    assert.equal(await sentCookie(bridge, path), `${OWNER}; zhuma-member=${COOKIE_A}`);
  for (const path of [
    '/plugins/client.js',
    '/api/zhuma/command',
    '/zhuma-id/session/extra',
    '/zhuma-id/unknown',
    '/api/zhuma-exec/unknown',
    '/api/zhuma-exec/inbox/extra',
    '/api/zhuma-exec/project-artifacts/extra',
    '/api/zhuma-exec/review-outcome/extra',
    '/api/zhuma-run/unknown',
    '/api/zhuma-run/send/extra',
    '/api/zhuma-member/command/extra',
    '/api/zhuma-member/unknown',
    '/api/zhuma-knowledge/unknown',
    '/api/zhuma-knowledge/project-links/extra',
    '/api/zhuma-knowledge/%72ead',
    '/api/zhuma-knowledge/project-links%2Fextra',
    '/zhuma-id/spaces/%2F',
  ])
    assert.equal(await sentCookie(bridge, path), OWNER);
});

test('desktop knowledge carrier contract: signed-out and revoked members cannot dispatch exact knowledge routes as owner', async () => {
  const bridge = createDesktopMemberCookieBridge();
  for (const loggedOut of [false, true]) {
    if (loggedOut) {
      await login(bridge);
      bridge.clear();
    }
    for (const endpoint of knowledgeEndpoints) {
      const result = await bridge.forward(
        request(`/api/zhuma-knowledge/${endpoint}`, { method: 'POST' }),
        HOST,
        OWNER,
        async () => assert.fail('Knowledge cannot fall back to owner'),
      );
      assert.equal(result.status, 401);
    }
  }
});

for (const endpoint of hostWorkflowEndpoints)
  test(`desktop workflow carrier contract: exact ${endpoint} POST carries the member and preserves the explicit request`, async () => {
    const bridge = createDesktopMemberCookieBridge();
    await login(bridge);
    const location = { spaceId: 'north', taskId: 'task', planId: 'plan', revision: 1 };
    const payload =
      endpoint === 'start'
        ? {
            ...location,
            requestId: randomUUID(),
            model: { provider: 'contract', model: 'not-called', maxTokens: 4096 },
            workspace: { kind: 'text-only' },
            concurrent: 1,
          }
        : endpoint === 'resume' || endpoint === 'stop'
          ? {
              ...location,
              requestId: randomUUID(),
              intentId: 'intent',
              generation: 1,
              ...(endpoint === 'resume' ? { expectedVersion: 1 } : {}),
            }
          : location;
    const body = {
      type: 'client-request',
      rpcId: randomUUID(),
      method: `zhuma-workflow/${endpoint}`,
      payload,
    };
    const original = request(`/api/zhuma-workflow/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'zhuma-member=forged-renderer' },
      body: JSON.stringify(body),
    });
    const response = await bridge.forward(original, HOST, OWNER, async (sent) => {
      assert.equal(sent, `${OWNER}; zhuma-member=${COOKIE_A}`);
      assert.equal(original.method, 'POST');
      assert.deepEqual(await original.clone().json(), body);
      return reply(COOKIE_B); // A workflow response cannot replace the login carrier.
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(original.bodyUsed, false);
    assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_A}`);
    await response.body?.cancel();
    await original.body?.cancel();
  });

test('desktop workflow carrier contract: unknown or near-prefix paths and original owner controls never gain the member cookie', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  for (const path of [
    '/api/zhuma-workflow',
    '/api/zhuma-workflow/',
    '/api/zhuma-workflow/unknown',
    '/api/zhuma-workflow/reader',
    '/api/zhuma-workflow/READ',
    '/api/zhuma-workflow/read/extra',
    '/api/zhuma-workflow/read%2Fextra',
    '/api/zhuma-workflow/%72ead',
    '/api/zhuma-workflows/read',
    '/api/zhuma-local-setup/initialize',
    '/api/zhuma-workspaces/options',
    '/api/zhuma-workspaces/approve',
    '/api/zhuma-workspaces/revoke',
  ])
    assert.equal(await sentCookie(bridge, path), OWNER, path);
});

test('desktop workflow carrier contract: missing member and pending/completed logout deny all five routes without owner fallback', async () => {
  const bridge = createDesktopMemberCookieBridge();
  async function denied() {
    for (const endpoint of hostWorkflowEndpoints) {
      const result = await bridge.forward(
        request(`/api/zhuma-workflow/${endpoint}`, { method: 'POST' }),
        HOST,
        OWNER,
        async () => assert.fail('A workflow request without a member cannot dispatch as owner'),
      );
      assert.equal(result.status, 401);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
  }
  await denied();
  await login(bridge);
  const pending = deferred();
  const logout = bridge.forward(
    request('/zhuma-id/logout', { method: 'POST' }),
    HOST,
    OWNER,
    async (sent) => {
      assert.equal(sent, `${OWNER}; zhuma-member=${COOKIE_A}`);
      return pending.promise;
    },
  );
  await denied();
  pending.resolve(new Response('{}'));
  assert.equal((await logout).status, 200);
  await denied();
});

test('desktop workflow carrier contract: a space denial preserves login while a workflow member-401 revokes all five routes', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  const path = '/api/zhuma-workflow/read';
  const denied = await bridge.forward(
    request(path, { method: 'POST' }),
    HOST,
    OWNER,
    async (sent) => {
      assert.equal(sent, `${OWNER}; zhuma-member=${COOKIE_A}`);
      return new Response(null, { status: 403 });
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_A}`);
  const revoked = await bridge.forward(
    request(path, { method: 'POST' }),
    HOST,
    OWNER,
    async () => new Response(null, { status: 401 }),
  );
  assert.equal(revoked.status, 401);
  for (const endpoint of hostWorkflowEndpoints) {
    const result = await bridge.forward(
      request(`/api/zhuma-workflow/${endpoint}`, { method: 'POST' }),
      HOST,
      OWNER,
      async () => assert.fail('A revoked member cannot fall back to the owner'),
    );
    assert.equal(result.status, 401);
  }
});

test('desktop transport contract: renderer cookies and all response cookies stay outside the carrier', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  const result = await bridge.forward(
    request('/zhuma-id/session', {
      headers: { cookie: 'dsh-session=forged-owner; zhuma-member=forged-member; extra=unrelated' },
    }),
    HOST,
    OWNER,
    async (sent) => {
      assert.equal(sent, `${OWNER}; zhuma-member=${COOKIE_A}`);
      const headers = new Headers();
      headers.append('set-cookie', 'dsh-session=owner-response-canary; HttpOnly');
      headers.append('set-cookie', cookie(COOKIE_B));
      headers.append('set-cookie', 'other=unrelated-response-canary');
      return new Response('public-result', { headers });
    },
  );
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(await result.text(), 'public-result');
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_A}`);
});

test('desktop transport contract: malformed, duplicated, oversized or unbounded login cookies fail closed', async () => {
  for (const values of [
    [],
    [cookie('')],
    [cookie('x'.repeat(4097))],
    [cookie(COOKIE_A, 0)],
    [cookie(COOKIE_A, -1)],
    [cookie(COOKIE_A, 43201)],
    [cookie(COOKIE_A), cookie(COOKIE_B)],
    [cookie(COOKIE_A).replace('; HttpOnly', '')],
    [cookie(COOKIE_A).replace('Strict', 'Lax')],
    [cookie(COOKIE_A).replace('Path=/', 'Path=/zhuma-id')],
    [cookie(COOKIE_A) + '; Domain=localhost'],
    [cookie(COOKIE_A) + '; Path=/'],
    ['other=unrelated'],
  ]) {
    const bridge = createDesktopMemberCookieBridge();
    await login(bridge);
    const result = await bridge.forward(
      request('/zhuma-id/login', { method: 'POST' }),
      HOST,
      OWNER,
      async () => {
        const headers = new Headers();
        for (const value of values) headers.append('set-cookie', value);
        return new Response('{}', { headers });
      },
    );
    assert.equal(result.status, 502);
    assert.equal(result.headers.get('set-cookie'), null);
    assert.equal(await sentCookie(bridge), undefined);
  }
});

test('desktop transport contract: rejected origins cannot dispatch or change the current carrier', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  const blocked = [
    new Request('https://untrusted.invalid/zhuma-id/logout', { method: 'POST' }),
    new Request('dsh-app://shell/zhuma-id/logout', { method: 'POST' }),
    request('/zhuma-id/login', { method: 'POST', headers: { origin: 'null' } }),
    request('/zhuma-id/logout', {
      method: 'POST',
      headers: { origin: 'https://untrusted.invalid' },
    }),
    request('/zhuma-id/session', { headers: { 'sec-fetch-site': 'cross-site' } }),
  ];
  for (const input of blocked) {
    const result = await bridge.forward(
      input,
      'http://127.0.0.1:4090/',
      'other-owner=canary',
      () => {
        throw Error('untrusted request must not dispatch');
      },
    );
    assert.equal(result.status, 403);
  }
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_A}`);
});

test('desktop transport contract: expiry and member 401 clear; a space 403 preserves the member', async () => {
  let time = 0;
  const bridge = createDesktopMemberCookieBridge(() => time);
  await login(bridge);
  const denied = await bridge.forward(
    request('/zhuma-id/spaces/denied'),
    HOST,
    OWNER,
    async () => new Response(null, { status: 403 }),
  );
  assert.equal(denied.status, 403);
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_A}`);
  time = 3600 * 1000;
  assert.equal(await sentCookie(bridge), undefined);
  await login(bridge);
  await bridge.forward(
    request('/api/zhuma-exec/inbox'),
    HOST,
    OWNER,
    async () => new Response(null, { status: 401 }),
  );
  assert.equal(await sentCookie(bridge), undefined);
});

test('desktop transport contract: logout carries the old cookie to revoke it, but clears locally before awaiting', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  const pending = deferred();
  const logout = bridge.forward(
    request('/zhuma-id/logout', { method: 'POST' }),
    HOST,
    OWNER,
    (sent) => {
      assert.equal(sent, `${OWNER}; zhuma-member=${COOKIE_A}`);
      return pending.promise;
    },
  );
  assert.equal(await sentCookie(bridge), undefined);
  pending.reject(Error('network unavailable'));
  await assert.rejects(logout, /network unavailable/);
  assert.equal(await sentCookie(bridge), undefined);
});

test('desktop transport contract: old login success and old 401 cannot replace or clear a newer login', async () => {
  const bridge = createDesktopMemberCookieBridge();
  const oldLoginReply = deferred();
  const oldLogin = bridge.forward(
    request('/zhuma-id/login', { method: 'POST' }),
    HOST,
    OWNER,
    () => oldLoginReply.promise,
  );
  await login(bridge, COOKIE_B);
  oldLoginReply.resolve(reply(COOKIE_A));
  assert.equal((await oldLogin).status, 401);
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_B}`);
  const oldReadReply = deferred();
  const oldRead = bridge.forward(
    request('/zhuma-id/session'),
    HOST,
    OWNER,
    () => oldReadReply.promise,
  );
  await login(bridge, COOKIE_A);
  oldReadReply.resolve(new Response(null, { status: 401 }));
  assert.equal((await oldRead).status, 401);
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_A}`);
});

test('desktop transport contract: Host origin, owner generation, explicit clear and process reopen isolate sessions', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_A}`); // Window reload.
  assert.equal(await sentCookie(createDesktopMemberCookieBridge()), undefined); // Whole-process reopen.
  assert.equal(await sentCookie(bridge, '/zhuma-id/session', 'http://127.0.0.1:4090/'), undefined);
  await login(bridge);
  assert.equal(
    await sentCookie(bridge, '/zhuma-id/session', HOST, 'dsh-session=next-owner'),
    undefined,
  );
  const pending = deferred();
  const oldLogin = bridge.forward(
    request('/zhuma-id/login', { method: 'POST' }),
    HOST,
    OWNER,
    () => pending.promise,
  );
  bridge.clear(); // Host authentication/restart begins.
  await login(bridge, COOKIE_B);
  pending.resolve(reply(COOKIE_A));
  assert.equal((await oldLogin).status, 401);
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_B}`);
});

test('desktop transport contract: abort cannot resurrect login; successful non-login and redirected responses cannot set it', async () => {
  const bridge = createDesktopMemberCookieBridge();
  const controller = new AbortController();
  const pending = deferred();
  const aborted = bridge.forward(
    request('/zhuma-id/login', { method: 'POST', signal: controller.signal }),
    HOST,
    OWNER,
    () => pending.promise,
  );
  controller.abort();
  pending.resolve(reply(COOKIE_A));
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal(await sentCookie(bridge), undefined);
  await bridge.forward(request('/plugins/asset'), HOST, OWNER, async () => reply(COOKIE_A));
  assert.equal(await sentCookie(bridge), undefined);
  const redirected = await bridge.forward(
    request('/zhuma-id/login', { method: 'POST' }),
    HOST,
    OWNER,
    async () =>
      new Response(null, {
        status: 303,
        headers: { 'set-cookie': cookie(COOKIE_A), location: '/other' },
      }),
  );
  assert.equal(redirected.status, 303);
  assert.equal(redirected.headers.get('set-cookie'), null);
  assert.equal(await sentCookie(bridge), undefined);
});

test('desktop transport contract: replies from a previous URL or owner generation cannot restore or clear the new carrier', async () => {
  for (const [host, owner] of [
    ['http://127.0.0.1:4090/', OWNER],
    [HOST, 'dsh-session=next-owner'],
  ]) {
    const bridge = createDesktopMemberCookieBridge();
    const delayedLogin = deferred();
    const oldLogin = bridge.forward(
      request('/zhuma-id/login', { method: 'POST' }),
      HOST,
      OWNER,
      () => delayedLogin.promise,
    );
    await login(bridge, COOKIE_B, host, owner);
    delayedLogin.resolve(reply(COOKIE_A));
    assert.equal((await oldLogin).status, 401);
    assert.equal(
      await sentCookie(bridge, '/zhuma-id/session', host, owner),
      `${owner}; zhuma-member=${COOKIE_B}`,
    );
    const delayedRead = deferred();
    const oldRead = bridge.forward(
      request('/zhuma-id/session'),
      host,
      owner,
      () => delayedRead.promise,
    );
    await login(bridge, COOKIE_A, HOST, 'dsh-session=third-owner');
    delayedRead.resolve(new Response(null, { status: 401 }));
    assert.equal((await oldRead).status, 401);
    assert.equal(
      await sentCookie(bridge, '/zhuma-id/session', HOST, 'dsh-session=third-owner'),
      `dsh-session=third-owner; zhuma-member=${COOKIE_A}`,
    );
  }
});

test('desktop transport contract: invalid destinations and already-aborted callers cannot mutate or dispatch', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  for (const [host, owner] of [
    ['https://external.invalid/', OWNER],
    ['file:///private', OWNER],
    ['http://user:password@127.0.0.1/', OWNER],
    [HOST, ''],
    [HOST, OWNER + '; other=cookie'],
  ]) {
    const result = await bridge.forward(request('/zhuma-id/session'), host, owner, () => {
      throw Error('invalid destination must not dispatch');
    });
    assert.equal(result.status, 503);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    bridge.forward(
      request('/zhuma-id/logout', { method: 'POST', signal: controller.signal }),
      HOST,
      OWNER,
      () => {
        throw Error('aborted caller must not dispatch');
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_A}`);
});

test('desktop transport contract: a late logout reply cannot clear a newer member and response streaming stays intact', async () => {
  const bridge = createDesktopMemberCookieBridge();
  await login(bridge);
  const pending = deferred();
  const oldLogout = bridge.forward(
    request('/zhuma-id/logout', { method: 'POST' }),
    HOST,
    OWNER,
    () => pending.promise,
  );
  await login(bridge, COOKIE_B);
  pending.resolve(new Response(null, { status: 401 }));
  assert.equal((await oldLogout).status, 401);
  assert.equal(await sentCookie(bridge), `${OWNER}; zhuma-member=${COOKIE_B}`);
  const response = await bridge.forward(
    request('/api/zhuma-exec/report'),
    HOST,
    OWNER,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
            controller.enqueue(new TextEncoder().encode('second'));
            controller.close();
          },
        }),
        { headers: { 'set-cookie': cookie(COOKIE_A) } },
      ),
  );
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), 'firstsecond');
});

test('desktop transport HTTP contract: real identity/execution services authorize, revoke and retain business data independently of the carrier', async () => {
  // Real Connection/identity/execution and Node HTTP; memory credentials/KV/access matcher.
  // This is not an official Electron process, installed product or disk-restart proof.
  const password = randomBytes(24).toString('hex');
  const host = await bootIdentity(
    {
      accounts: [{ id: 'chen', passwordHash: hashPassword(password) }],
      notes: [
        { id: 'note', spaceId: 'project', ownerId: 'chen', teamMemberIds: [], text: 'initial' },
        {
          id: 'private-note',
          spaceId: 'denied',
          ownerId: 'chen',
          teamMemberIds: [],
          text: 'private',
        },
      ],
    },
    'multi-member',
    {
      spaces: [
        { id: 'project', kind: 'team', name: 'Project' },
        { id: 'empty', kind: 'team', name: 'Empty' },
        { id: 'denied', kind: 'team', name: 'Other team' },
      ],
      memberships: [
        { spaceId: 'project', accountId: 'chen' },
        { spaceId: 'empty', accountId: 'chen' },
      ],
    },
  );
  const { state, task } = fixture();
  const confirmed = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  const applied = confirmed.appliedPlans.at(-1);
  const execution = host.ctx.plugin(
    { inject: [...executionInject], apply: applyExecution },
    {
      readWorkbench: () => confirmed,
      projectSpaces: boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]),
    },
  );
  let lastCookie;
  const server = http.createServer((req, res) => {
    lastCookie = req.headers.cookie;
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/') {
      host.ctx.connection.authorizeIndex(req, res);
      if (!res.writableEnded) res.end();
      return;
    }
    void host.web.dispatch(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  try {
    await execution;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function authenticateOwnedHost() {
      const url = host.ctx.connection.authenticatedUrl(`${origin}/`);
      if (patchedDesktop) return patchedDesktop.authenticateWebHost(url);
      const ownerReply = await fetch(url, { redirect: 'manual' });
      assert.equal(ownerReply.status, 303);
      const value = ownerReply.headers.get('set-cookie').split(';', 1)[0];
      await ownerReply.body?.cancel();
      return value;
    }
    let owner = await authenticateOwnedHost();
    let bridge = createDesktopMemberCookieBridge();
    async function call(path, method = 'GET', body, extraHeaders = {}) {
      const input = request(path, {
        method,
        headers: {
          origin: 'dsh-app://app',
          ...extraHeaders,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const response = patchedDesktop
        ? await patchedDesktop.forwardWebRequest(input, origin, owner)
        : await bridge.forward(input, origin, owner, (credential) =>
            fetch(`${origin}${path}`, {
              method,
              headers: {
                host: new URL(origin).host,
                cookie: credential,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              },
              body: input.body,
              duplex: 'half',
              signal: input.signal,
              redirect: 'manual',
            }).catch((error) => {
              throw new Error(`HTTP contract ${method} ${path}`, { cause: error });
            }),
          );
      assert.equal(response.headers.get('set-cookie'), null);
      const text = await response.text();
      assert.equal(text.includes(owner), false);
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    }
    async function rpc(endpoint, payload) {
      return call(`/api/zhuma-exec/${endpoint}`, 'POST', {
        type: 'client-request',
        rpcId: 'desktop-contract',
        method: `zhuma-exec/${endpoint}`,
        payload,
      });
    }
    const ownerOnly = await fetch(`${origin}/zhuma-id/session`, {
      headers: { host: new URL(origin).host, cookie: owner },
    });
    assert.equal(ownerOnly.status, 401); // Real multi-member Host does not map owner to member.
    await ownerOnly.body?.cancel();
    assert.equal((await call('/zhuma-id/session')).status, 401);
    assert.equal(
      (await call('/zhuma-id/login', 'POST', { accountId: 'chen', password })).status,
      200,
    );
    const session = await call('/zhuma-id/session');
    assert.equal(session.body.accountId, 'chen');
    assert.equal(session.body.principal.kind, 'zhuma-member');
    assert.equal(
      (await call('/zhuma-id/logout', 'POST', {}, { origin: 'https://untrusted.invalid' })).status,
      403,
    );
    const forged = await call('/zhuma-id/session', 'GET', undefined, {
      cookie:
        'dsh-session=renderer-owner-forgery; zhuma-member=renderer-member-forgery; unrelated=value',
    });
    assert.equal(forged.status, 200);
    assert.equal(forged.body.accountId, 'chen');
    assert.equal(lastCookie.includes('renderer-'), false);
    assert.equal(lastCookie.includes('unrelated='), false);
    assert.equal((await call('/zhuma-id/spaces/empty')).body.notes.length, 0);
    // The fixture access port allows registered kinds; this route independently checks membership.
    assert.equal((await call('/zhuma-id/notes/private-note')).status, 404);
    assert.equal((await call('/zhuma-id/session')).status, 200);
    assert.equal((await rpc('inbox', { spaceId: 'project' })).body.result.value.items.length, 0);
    const start = await rpc('start-plan', {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: 'desktop-start',
      spaceId: 'project',
    });
    assert.equal(start.body.result.ok, true);
    assert.equal((await rpc('inbox', { spaceId: 'project' })).body.result.value.items.length, 1);
    assert.equal(
      (await call('/zhuma-id/notes/note', 'PUT', { text: 'saved-business-data' })).status,
      200,
    );
    assert.equal((await call('/zhuma-id/logout', 'POST', {})).status, 200);
    assert.equal((await call('/zhuma-id/session')).status, 401);
    assert.equal((await rpc('inbox', { spaceId: 'project' })).status, 401);
    await call('/zhuma-id/login', 'POST', { accountId: 'chen', password });
    bridge = createDesktopMemberCookieBridge(); // Recreated transport loses the token, not Host data.
    if (patchedDesktop) owner = await authenticateOwnedHost(); // The patched Host-auth seam clears its private carrier.
    assert.equal((await call('/zhuma-id/session')).status, 401);
    await call('/zhuma-id/login', 'POST', { accountId: 'chen', password });
    assert.equal((await call('/zhuma-id/notes/note')).body.note.text, 'saved-business-data');
    assert.equal((await rpc('inbox', { spaceId: 'project' })).body.result.value.items.length, 1);
    // Host-side revocation is observed even while the shell still holds the opaque token.
    const revoked = await fetch(`${origin}/zhuma-id/logout`, {
      method: 'POST',
      headers: {
        host: new URL(origin).host,
        cookie: lastCookie,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(revoked.status, 200);
    await revoked.body?.cancel();
    assert.equal((await call('/zhuma-id/session')).status, 401);
    assert.equal((await rpc('inbox', { spaceId: 'project' })).status, 401);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await execution.dispose();
    await host.dispose();
  }
});
