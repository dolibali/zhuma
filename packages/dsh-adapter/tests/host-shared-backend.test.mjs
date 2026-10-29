/** Original Credentials persistence + bounded remote HTTP fixtures. No existing profile/model/GUI. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { HostSharedBackend, SharedBackendError } from '../dist/host-shared-backend.js';
import { mountHostSharedBackend } from '../dist/host-shared-backend-http.js';

const fileQuery = {
  spaceId: 'north',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  uploadId: 'upload',
  purpose: 'accepted',
  projectId: 'project',
  artifactVersionId: 'artifact',
  mode: 'download',
};
const fileRequest = (selection, query = fileQuery) =>
  new Request(
    `http://local.invalid/api/zhuma-backend/file?${new URLSearchParams({ connectionId: selection.connectionId, ...query })}`,
    { method: 'POST' },
  );
const fileHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('shared file carrier: private original member identity, exact query and unchanged bounded bytes', async (t) => {
  const data = Buffer.alloc(256 * 1024, 'native file data');
  let fileCalls = 0;
  const h = await fixture(t, async (url, init) => {
    fileCalls++;
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('x-injected'), null);
    assert.equal(url.searchParams.get('projectId'), 'project');
    assert.equal(url.searchParams.has('connectionId'), false);
    if (url.searchParams.get('mode') === 'metadata')
      return Response.json({ ok: true, value: { contract: true } });
    return new Response(data, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
        'content-disposition': 'attachment; filename="file"',
        'x-zhuma-file-sha256': fileHash(data),
        'x-zhuma-file-upload-id': 'upload',
        'set-cookie': 'must-never-leave-host=private',
      },
    });
  });
  const selected = await h.selected();
  await h.request(selected, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const metadata = await h.owner.file(
    'file',
    fileRequest(selected, { ...fileQuery, mode: 'metadata' }),
  );
  assert.deepEqual(await metadata.json(), { ok: true, value: { contract: true } });
  for (const mode of ['preview', 'download']) {
    const response = await h.owner.file('file', fileRequest(selected, { ...fileQuery, mode }));
    assert.equal(response.headers.get('x-zhuma-backend-connection'), selected.connectionId);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="file"');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  }
  const before = fileCalls;
  await assert.rejects(
    h.owner.file('file', fileRequest(selected, { ...fileQuery, url: 'http://elsewhere.invalid' })),
  );
  await assert.rejects(
    h.owner.file('file', fileRequest({ ...selected, connectionId: randomUUID() })),
  );
  assert.equal(
    fileCalls,
    before,
    'strict original query and connection reject before file dispatch',
  );
  assert.equal(JSON.stringify(await h.owner.status()).includes('synthetic-'), false);
});

test('shared file carrier: member upload stays an original raw stream and rejects an incomplete or wrong digest', async (t) => {
  const bytes = Buffer.from('manual delivery text');
  let publications = 0;
  const h = await fixture(t, async (url, init) => {
    assert.equal(url.pathname, '/api/zhuma-exec/upload-file');
    assert.equal(init.duplex, 'half');
    assert.equal(init.headers.get('x-zhuma-backend-connection'), null);
    assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), bytes);
    publications++;
    return Response.json({ ok: true, value: { originalReceipt: publications } });
  });
  const selected = await h.selected();
  await h.request(selected, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const upload = (sha256 = fileHash(bytes), size = bytes.length) =>
    new Request('http://local.invalid/api/zhuma-backend/upload-file', {
      method: 'POST',
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'x-zhuma-backend-connection': selected.connectionId,
        'x-zhuma-file-name': encodeURIComponent('交付.txt'),
        'x-zhuma-file-type': 'text/plain',
        'x-zhuma-file-size': String(size),
        'x-zhuma-file-sha256': sha256,
        'x-zhuma-space': 'north',
        'x-zhuma-task': 'task',
        'x-zhuma-plan': 'plan',
        'x-zhuma-revision': '1',
        'x-zhuma-node': 'node',
        'x-zhuma-idempotency-key': 'manual-upload',
      },
    });
  assert.deepEqual(await (await h.owner.file('upload-file', upload())).json(), {
    ok: true,
    value: { originalReceipt: 1 },
  });
  await assert.rejects(h.owner.file('upload-file', upload('a'.repeat(64))));
  await assert.rejects(h.owner.file('upload-file', upload(fileHash(bytes), bytes.length + 1)));
  assert.equal(publications, 1);
});

test('shared file carrier: logout cancels a live reader; corrupt bytes cannot finish successfully', async (t) => {
  let cancelled = 0,
    corrupt = false;
  const bytes = Buffer.from('first chunk');
  const h = await fixture(
    t,
    async () =>
      new Response(
        corrupt
          ? bytes
          : new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
              },
              cancel() {
                cancelled++;
              },
            }),
        {
          headers: {
            'content-type': 'application/octet-stream',
            'x-zhuma-file-sha256': 'a'.repeat(64),
          },
        },
      ),
  );
  const selected = await h.selected();
  await h.request(selected, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const response = await h.owner.file('file', fileRequest(selected));
  const reader = response.body.getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value), bytes);
  await h.request(selected, 'identity.session');
  assert.equal(cancelled, 0, 'A verified member session must not revoke a live file reader');
  const pending = reader.read();
  const rejected = assert.rejects(pending);
  await h.request(selected, 'identity.logout');
  await rejected;
  assert.equal(cancelled, 1);
  corrupt = true;
  await h.request(selected, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  await assert.rejects((await h.owner.file('file', fileRequest(selected))).arrayBuffer());
});

test('shared backend reconnect signal: only an originally verified member session publishes verification', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const events = [];
  const off = h.owner.onNativeAuthenticationChanged((kind) => events.push(kind));
  await h.request(selection, 'member.snapshot', { spaceId: 'north' }, { rpcId: randomUUID() });
  assert.deepEqual(events, []);
  await h.request(selection, 'identity.session');
  assert.deepEqual(events, ['verified']);
  h.replaceBackend();
  await assert.rejects(h.request(selection, 'identity.session'), { code: 'identity-changed' });
  assert.deepEqual(events, ['verified'], 'A different backend identity cannot restore an owner');
  off();
});

async function fixture(t, fileHandler, businessHandler) {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-backend-private-'));
  const filename = join(directory, 'synthetic.yaml'),
    calls = [];
  let backendId = randomUUID(),
    expired = false,
    businessExpired = false,
    pending;
  const cookies = new Map();
  const remote = async (input, init) => {
    const url = new URL(input),
      headers = new Headers(init.headers),
      body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.href, headers, init, body });
    assert.equal(init.redirect, 'error');
    assert.equal(headers.get('origin'), url.origin);
    assert.equal(headers.has('authorization'), false);
    assert.notEqual(headers.get('cookie')?.includes('dsh-'), true);
    if (url.pathname === '/zhuma-id/login') {
      const cookie = `zhuma-member=synthetic-${randomUUID()}`;
      cookies.set(cookie, body.accountId);
      if (pending) return pending.promise;
      return Response.json(
        { ok: true, accountId: body.accountId },
        { headers: { 'set-cookie': `${cookie}; HttpOnly; SameSite=Strict; Path=/` } },
      );
    }
    if (url.pathname === '/zhuma-id/register')
      return Response.json(
        {
          ok: true,
          value: {
            accountId: body.accountId,
            personalSpaceId: `personal-${body.accountId}`,
            disposition: 'created',
          },
        },
        { status: 201 },
      );
    const actorId = expired ? undefined : cookies.get(headers.get('cookie'));
    if (!actorId) return Response.json({ ok: false }, { status: 401 });
    if (url.pathname === '/api/zhuma-remote-run/info')
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            protocolVersion: 1,
            backendId,
            actorId,
            serverTime: Date.now(),
            purposes: ['work'],
            operations: ['info'],
          },
        },
      });
    if (
      fileHandler &&
      ['/api/zhuma-exec/file', '/api/zhuma-exec/upload-file'].includes(url.pathname)
    )
      return fileHandler(url, init);
    if (url.pathname === '/zhuma-id/session')
      return Response.json({
        ok: true,
        accountId: actorId,
        principal: { kind: 'zhuma-member', memberId: actorId },
        peerId: 'synthetic-member',
        spaces: [],
      });
    if (url.pathname === '/zhuma-id/logout')
      return Response.json(
        { ok: true, accountId: actorId },
        { headers: { 'set-cookie': 'zhuma-member=; Max-Age=0; Path=/' } },
      );
    if (url.pathname === '/zhuma-id/password')
      return Response.json({ ok: false, error: 'invalid-login' }, { status: 401 });
    if (businessExpired && url.pathname.startsWith('/api/zhuma-member/'))
      return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    if (businessHandler) return businessHandler(url, init);
    return Response.json({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { actorId, echo: body.payload } },
    });
  };
  const contexts = [],
    owners = [];
  async function open() {
    const ctx = new Context(),
      provider = ctx.plugin(Credentials, { path: filename, watch: false });
    await provider;
    contexts.push(provider);
    const owner = new HostSharedBackend(ctx, remote);
    owners.push(owner);
    return { ctx, owner, provider };
  }
  const initial = await open();
  t.after(async () => {
    for (const owner of owners) await owner.close();
    for (const provider of contexts.toReversed()) await provider.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  async function selected() {
    return initial.owner.select({
      requestId: randomUUID(),
      expectedConnectionId: null,
      origin: 'http://backend.example:3080',
    });
  }
  const request = (selection, operation, payload = {}, extra = {}) =>
    initial.owner.request(
      { connectionId: selection.connectionId, operation, payload, ...extra },
      new AbortController().signal,
    );
  return {
    ...initial,
    calls,
    cookies,
    filename,
    open,
    selected,
    request,
    expire: () => {
      expired = true;
    },
    expireBusiness: () => {
      businessExpired = true;
    },
    replaceBackend: () => {
      backendId = randomUUID();
    },
    delay: () => (pending = Promise.withResolvers()),
  };
}

test('shared backend planning deadline: only planning survives 20 seconds; default timeout and caller/lifetime cancellation remain bounded', async (t) => {
  let entered, held;
  const h = await fixture(t, undefined, async (url, init) => {
    assert.ok(['/api/zhuma-member/plan', '/api/zhuma-member/snapshot'].includes(url.pathname));
    const wire = JSON.parse(init.body);
    return new Promise((resolve, reject) => {
      const aborted = () => reject(init.signal.reason);
      init.signal.addEventListener('abort', aborted, { once: true });
      held = {
        signal: init.signal,
        finish() {
          init.signal.removeEventListener('abort', aborted);
          resolve(
            Response.json({
              type: 'server-response',
              rpcId: wire.rpcId,
              result: { ok: true, value: { actorId: 'ann', echo: wire.payload } },
            }),
          );
        },
      };
      entered();
    });
  });
  const selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    deadlines.push(milliseconds);
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Synthetic deadline', 'TimeoutError')),
      milliseconds,
    );
    return controller.signal;
  });
  async function begin(operation = 'member.plan') {
    const ready = Promise.withResolvers();
    entered = ready.resolve;
    const caller = new AbortController();
    const work = h.owner.request(
      {
        connectionId: selection.connectionId,
        operation,
        rpcId: randomUUID(),
        payload:
          operation === 'member.plan'
            ? {
                spaceId: 'north',
                requestId: randomUUID(),
                taskId: 'task',
                expectedRevision: 0,
                instruction: 'Plan the assigned work',
              }
            : { spaceId: 'north' },
      },
      caller.signal,
    );
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await ready.promise;
    return { work, caller, held, settled: () => settled };
  }
  const completed = await begin();
  t.mock.timers.tick(20_000);
  assert.equal(
    completed.held.signal.aborted,
    false,
    'Planning is not cut by the old proxy deadline',
  );
  assert.equal(completed.settled(), false);
  completed.held.finish();
  assert.equal((await completed.work).status, 200);

  const bounded = await begin();
  const timedOut = assert.rejects(bounded.work, { name: 'TimeoutError' });
  t.mock.timers.tick(129_999);
  assert.equal(bounded.held.signal.aborted, false);
  t.mock.timers.tick(1);
  await timedOut;

  const ordinary = await begin('member.snapshot');
  const ordinaryTimeout = assert.rejects(ordinary.work, { name: 'TimeoutError' });
  t.mock.timers.tick(19_999);
  assert.equal(ordinary.held.signal.aborted, false);
  t.mock.timers.tick(1);
  await ordinaryTimeout;

  const cancelled = await begin();
  const callerCancelled = assert.rejects(cancelled.work, { name: 'AbortError' });
  cancelled.caller.abort();
  assert.equal(cancelled.held.signal.aborted, true);
  await callerCancelled;

  const closing = await begin();
  const lifetimeCancelled = assert.rejects(closing.work, { name: 'AbortError' });
  const closed = h.owner.close();
  assert.equal(closing.held.signal.aborted, true);
  await Promise.all([closed, lifetimeCancelled]);
  assert.deepEqual(deadlines, [130_000, 130_000, 20_000, 130_000, 130_000]);
});

test('shared backend actual Credentials: a precommit native refusal preserves the old durable selection and retry identity', async (t) => {
  const h = await fixture(t),
    selected = await h.selected();
  const input = {
    requestId: randomUUID(),
    expectedConnectionId: selected.connectionId,
    origin: 'http://next.example',
  };
  let calls = 0;
  await assert.rejects(
    h.owner.select(input, {
      async prepare() {
        calls++;
        throw new SharedBackendError('native-busy');
      },
    }),
    { code: 'native-busy' },
  );
  assert.equal((await h.owner.status()).connectionId, selected.connectionId);
  const trace = [];
  const next = await h.owner.select(input, {
    async prepare() {
      trace.push('closed-original-child');
      return {
        async committed() {
          trace.push('opened-selected-child');
        },
        failed() {
          assert.fail();
        },
      };
    },
  });
  assert.equal(next.origin, input.origin);
  assert.notEqual(next.connectionId, selected.connectionId);
  const retry = await h.owner.select(input, {
    async prepare() {
      assert.fail('A durable replay must not stop or reopen current work');
    },
  });
  assert.equal(retry.connectionId, next.connectionId);
  assert.equal(calls, 1);
  assert.deepEqual(trace, ['closed-original-child', 'opened-selected-child']);
});

test('shared backend confines fixed methods, persists only original member Cookie privately and cold reads exact origin/identity', async (t) => {
  const h = await fixture(t);
  assert.deepEqual(await h.owner.status(), {
    origin: null,
    connectionId: null,
    backendId: null,
    actorId: null,
  });
  const selection = await h.selected();
  assert.equal(h.calls.length, 0, 'select does not perform login/owner exchange');
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const status = await h.owner.status();
  assert.equal(status.actorId, 'ann');
  assert.ok(status.backendId);
  assert.equal('cookie' in status, false);
  const read = await h.request(
    selection,
    'member.snapshot',
    { spaceId: 'north' },
    { rpcId: randomUUID() },
  );
  assert.equal(read.body.result.value.actorId, 'ann');
  assert.equal(JSON.stringify(read).includes('synthetic-'), false);
  assert.ok(h.calls.every((call) => call.url.startsWith('http://backend.example:3080/')));
  assert.ok(
    h.calls.every(
      (call) =>
        call.url.includes('/zhuma-id/') ||
        call.url.includes('/api/zhuma-member/') ||
        call.url.includes('/api/zhuma-remote-run/info'),
    ),
  );
  assert.equal((await stat(h.filename)).mode & 0o077, 0);
  await h.owner.close();
  await h.provider.dispose();
  const cold = await h.open();
  assert.deepEqual(await cold.owner.status(), status);
  const connection = await cold.owner.nativeConnection(new AbortController().signal);
  const headers = new Headers(await connection.authentication(new AbortController().signal));
  assert.ok(h.cookies.has(headers.get('cookie')));
  await h
    .request(selection, 'identity.session')
    .catch((error) => assert.equal(error.name, 'AbortError'));
});

test('shared backend rejects arbitrary routes, actor injection and malformed origin before network or unrelated credential reads', async (t) => {
  const h = await fixture(t);
  for (const origin of [
    'file:///etc/passwd',
    'http://a.example/path',
    'http://user:password@a.example',
    'http://a.example/?x=1',
  ])
    await assert.rejects(
      h.owner.select({ requestId: randomUUID(), expectedConnectionId: null, origin }),
    );
  const selection = await h.selected();
  for (const change of [
    { operation: 'session/send' },
    { operation: 'member.snapshot', payload: { spaceId: 'north', actorId: 'other' } },
    { operation: 'identity.session', route: '/api/session/send' },
    { operation: 'identity.session', headers: { cookie: 'injected' } },
  ])
    await assert.rejects(
      h.owner.request(
        {
          connectionId: selection.connectionId,
          operation: 'identity.session',
          payload: {},
          ...change,
        },
        new AbortController().signal,
      ),
    );
  assert.equal(h.calls.length, 0);
});

test('shared backend carries original manual submission, draft, review and accepted-input requests without authority overrides', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const target = { taskId: 'task', planId: 'plan', revision: 1, nodeId: 'write' };
  const command = { ...target, expectedVersion: 0, idempotencyKey: 'same-intent' };
  const cases = [
    [
      'start-plan',
      { taskId: 'task', planId: 'plan', revision: 1, idempotencyKey: 'start', spaceId: 'north' },
    ],
    ['submit', { ...command, text: 'fixed text', links: [], files: [] }],
    [
      'ballot',
      {
        ...command,
        roundId: 'round',
        artifactVersionId: 'artifact',
        action: 'request-changes',
        comment: 'revise this section',
      },
    ],
    ['revision', target],
    [
      'review-outcome',
      { ...target, spaceId: 'north', roundId: 'round', artifactVersionId: 'artifact' },
    ],
    [
      'upstream-content',
      { ...target, spaceId: 'north', sourceNodeId: 'source', artifactVersionId: 'accepted-v1' },
    ],
    ['draft', target],
    ['draft', { ...command, text: 'retained draft', links: [], files: [] }],
  ];
  for (const [endpoint, payload] of cases) {
    const rpcId = randomUUID();
    const result = await h.request(selection, `execution.${endpoint}`, payload, { rpcId });
    assert.deepEqual(result.body.result.value.echo, payload);
    assert.equal(result.body.rpcId, rpcId);
    const call = h.calls.at(-1);
    assert.equal(call.url, `http://backend.example:3080/api/zhuma-exec/${endpoint}`);
    assert.equal(call.body.method, `zhuma-exec/${endpoint}`);
    for (const field of ['actorId', 'memberId', 'reviewerId', 'route', 'headers']) {
      const before = h.calls.length;
      await assert.rejects(
        h.request(selection, `execution.${endpoint}`, { ...payload, [field]: 'forged' }, { rpcId }),
      );
      assert.equal(h.calls.length, before, 'original strict schema rejects before remote dispatch');
    }
  }
});

test('shared manual draft carrier retains the original encoded text budget without a one-mebibyte response truncation', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  // Original strict-schema envelope budget only. The actual backend still owns
  // file existence, metadata and draft-total semantic checks.
  const payload = {
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'write',
    expectedVersion: 0,
    idempotencyKey: 'retained-encoded-draft',
    text: '\u0001'.repeat(100_000),
    links: [],
    files: Array.from({ length: 20 }, (_, index) => ({
      id: String(index) + '\u0001'.repeat(1500),
      mediaType: '\u0001'.repeat(1500),
      byteSize: 0,
      checksum: '\u0001'.repeat(1500),
      accessPolicyId: '\u0001'.repeat(1500),
      uploadComplete: false,
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024);
  const value = await h.request(selection, 'execution.draft', payload, { rpcId: randomUUID() });
  assert.deepEqual(value.body.result.value.echo, payload);
});

test('shared backend registration preserves the original separate registration then login flow without requiring Set-Cookie', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  const registered = await h.request(selection, 'identity.register', {
    requestId: randomUUID(),
    accountId: 'ann',
    password: 'synthetic-only',
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.value.accountId, 'ann');
  assert.equal((await h.owner.status()).actorId, null);
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  assert.equal((await h.owner.status()).actorId, 'ann');
});

test('shared backend fences late login after connection replacement and never stores its Cookie', async (t) => {
  const h = await fixture(t),
    selection = await h.selected(),
    pending = h.delay();
  const login = h.request(selection, 'identity.login', {
    accountId: 'ann',
    password: 'synthetic-only',
  });
  while (!h.calls.length) await new Promise(setImmediate);
  const next = await h.owner.select({
    requestId: randomUUID(),
    expectedConnectionId: selection.connectionId,
    origin: 'http://other.example',
  });
  pending.resolve(
    Response.json(
      { ok: true, accountId: 'ann' },
      { headers: { 'set-cookie': 'zhuma-member=late-private; HttpOnly' } },
    ),
  );
  await assert.rejects(login, { code: 'changed' });
  assert.deepEqual(await h.owner.status(), next);
  assert.equal(h.calls.length, 1);
});

test('shared backend binds current remote backend identity and preserves expired-member 401 without a business request', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  h.replaceBackend();
  const before = h.calls.length;
  await assert.rejects(
    h.request(selection, 'member.snapshot', { spaceId: 'north' }, { rpcId: randomUUID() }),
    { code: 'identity-changed' },
  );
  assert.equal(h.calls.length, before + 1);
  h.expire();
  assert.equal(
    (await h.request(selection, 'member.snapshot', { spaceId: 'north' }, { rpcId: randomUUID() }))
      .status,
    401,
  );
});

test('shared backend selection same request survives a lost reply but rejects a changed retry', async (t) => {
  const h = await fixture(t),
    input = {
      requestId: randomUUID(),
      expectedConnectionId: null,
      origin: 'http://backend.example:3080',
    };
  const first = await h.owner.select(input);
  assert.deepEqual(await h.owner.select(input), first);
  await assert.rejects(h.owner.select({ ...input, origin: 'http://other.example' }), {
    code: 'changed',
  });
  assert.deepEqual(await h.owner.status(), first);
});

test('shared backend wrong password does not invalidate an existing private native connection', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const native = await h.owner.nativeConnection(new AbortController().signal);
  const before = await native.authentication(new AbortController().signal);
  const reply = await h.request(selection, 'identity.password', {
    oldPassword: 'wrong-synthetic',
    newPassword: 'new-synthetic-password',
  });
  assert.equal(reply.status, 401);
  assert.deepEqual(await native.authentication(new AbortController().signal), before);
  assert.equal((await h.owner.status()).actorId, 'ann');
});

test('shared backend exact HTTP routes retain actual SDK local owner admission and never publish a member Web endpoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-backend-owner-http-'));
  const ctx = new Context(),
    fibers = [];
  const load = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  };
  t.after(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await load(Credentials, { path: join(directory, 'synthetic.yaml'), watch: false });
  await load(WebServer, { host: '127.0.0.1', port: 0 });
  await load(Connection);
  await load(RemoteAccess);
  const source = ctx.plugin({ inject: ['connection'], apply: mountHostSharedBackend });
  fibers.push(source);
  await source;
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const removeIndex = ctx.webServer.register({
    kind: 'exact',
    path: '/',
    handler(req, res) {
      if (ctx.connection.authorizeIndex(req, res))
        res.writeHead(200).end('Synthetic local owner entry');
    },
  });
  t.after(removeIndex);
  const call = (cookie, endpoint, payload) =>
    fetch(`${origin}/api/zhuma-backend/${endpoint}`, {
      method: 'POST',
      headers: { origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: `zhuma-backend/${endpoint}`,
        payload,
      }),
      redirect: 'error',
    });
  assert.equal((await call(undefined, 'status', {})).status, 401);
  assert.equal((await fetch(`${origin}/api/zhuma-backend/file`, { method: 'POST' })).status, 401);
  assert.equal(
    (await fetch(`${origin}/api/zhuma-backend/upload-file`, { method: 'POST' })).status,
    401,
  );
  assert.equal((await call('zhuma-member=synthetic-not-owner', 'status', {})).status, 401);
  // Local owner bootstrap only; there is no remote owner exchange in this path.
  const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = exchange.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
  await exchange.body?.cancel();
  assert.ok(cookie);
  const reply = await call(cookie, 'status', {});
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('set-cookie'), null);
  const data = await reply.json();
  assert.equal(data.result.ok, true);
  assert.equal(data.result.value.origin, null);
  const selected = await call(cookie, 'select', {
    requestId: randomUUID(),
    expectedConnectionId: null,
    origin: 'http://backend.example:3080',
  });
  const value = await selected.json();
  assert.equal(value.result.ok, true);
  assert.deepEqual(Object.keys(value.result.value).sort(), [
    'actorId',
    'backendId',
    'connectionId',
    'origin',
  ]);
});

test('shared backend: member expiry between successful probe and business reply immediately fences native admission', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const changed = [];
  const off = h.owner.onNativeAuthenticationChanged((kind) => changed.push(kind));
  h.expireBusiness();
  const reply = await h.request(
    selection,
    'member.snapshot',
    { spaceId: 'north' },
    { rpcId: randomUUID() },
  );
  assert.equal(reply.status, 401);
  assert.deepEqual(changed, ['revoking']);
  off();
});

test('shared backend: Agent proposal forwards the original draft schema to one fixed member endpoint', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  const input = {
    spaceId: 'north',
    libraryId: 'library',
    pageId: 'page',
    expectedVersion: 0,
    idempotencyKey: 'proposal-1',
    content: { title: 'Proposed note', format: 'markdown', text: 'Draft only', sources: [] },
  };
  const before = h.calls.length;
  await h.request(selection, 'knowledge.propose-draft', input, { rpcId: randomUUID() });
  assert.equal(h.calls.at(-1).url, 'http://backend.example:3080/api/zhuma-knowledge/propose-draft');
  assert.deepEqual(h.calls.at(-1).body.payload, input);
  assert.equal(
    h.calls.length,
    before + 2,
    'One original identity probe plus the fixed draft operation',
  );
  const valid = h.calls.length;
  await assert.rejects(
    h.request(
      selection,
      'knowledge.propose-draft',
      { ...input, actorId: 'other' },
      { rpcId: randomUUID() },
    ),
  );
  assert.equal(h.calls.length, valid);
});

test('shared backend: project knowledge uses exact original schemas and never accepts renderer authority or URLs', async (t) => {
  const h = await fixture(t),
    selection = await h.selected();
  await h.request(selection, 'identity.login', { accountId: 'ann', password: 'synthetic-only' });
  for (const [endpoint, input] of [
    ['project-links', { spaceId: 'north', projectId: 'project' }],
    [
      'save-project-links',
      {
        spaceId: 'north',
        projectId: 'project',
        expectedVersion: 0,
        idempotencyKey: 'same-intent',
        links: [
          {
            required: true,
            reference: {
              spaceId: 'north',
              libraryId: 'north',
              pageId: 'guide',
              version: 1,
              checksum: 'a'.repeat(64),
            },
          },
        ],
      },
    ],
  ]) {
    const before = h.calls.length;
    await h.request(selection, `knowledge.${endpoint}`, input, { rpcId: randomUUID() });
    assert.equal(h.calls.at(-1).url, `http://backend.example:3080/api/zhuma-knowledge/${endpoint}`);
    assert.deepEqual(h.calls.at(-1).body.payload, input);
    assert.equal(
      h.calls.length,
      before + 2,
      'Original identity probe plus original member operation',
    );
    for (const patch of [{ actorId: 'other' }, { url: 'http://elsewhere.invalid' }]) {
      const count = h.calls.length;
      await assert.rejects(
        h.request(
          selection,
          `knowledge.${endpoint}`,
          { ...input, ...patch },
          { rpcId: randomUUID() },
        ),
      );
      assert.equal(h.calls.length, count);
    }
  }
});
