import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { z } from 'zod';
import { MemberLocalExecutionClient } from '../dist/member-local-execution-client.js';

// Real outbound HTTP; server identity/device/Run authorization are contracts.
// This is transport evidence, not two product Hosts or a native execution PoC.
async function server(t, handle) {
  const s = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      await handle(req, res, body ? JSON.parse(body) : undefined);
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        s.closeAllConnections();
        s.close(resolve);
      }),
  );
  return `http://127.0.0.1:${s.address().port}`;
}
const decode = (raw) => z.strictObject({ ok: z.literal(true), value: z.string() }).parse(raw).value;
test('member-local HTTP: authentication receives only the actual allowlisted method so cleanup can use its separately retained credential', async (t) => {
  let current = true;
  const calls = [],
    requests = [];
  const origin = await server(t, (req, res, body) => {
    requests.push({
      method: body.method,
      cookie: req.headers.cookie,
      permit: req.headers['x-private-test-permit'],
    });
    res.end(
      JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: 'confirmed' },
      }),
    );
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: ['zhuma-proof/status', 'zhuma-proof/cleanup'],
    privateHeaderNames: ['x-private-test-permit'],
    authentication: (_signal, context) => {
      assert(Object.isFrozen(context));
      assert.deepEqual(Object.keys(context), ['method']);
      calls.push(context.method);
      if (context.method === 'zhuma-proof/cleanup')
        return { cookie: 'synthetic-retained-cleanup-member' };
      if (!current) throw Error('CURRENT_AUTH_REVOKED');
      return { cookie: 'synthetic-current-member' };
    },
  });
  t.after(() => client.close());
  await client.invoke('zhuma-proof/status', {}, decode);
  current = false;
  await assert.rejects(client.invoke('zhuma-proof/status', {}, decode));
  await client.invoke('zhuma-proof/cleanup', {}, decode, undefined, {
    'x-private-test-permit': 'synthetic-independent-cleanup',
  });
  await assert.rejects(client.invoke('zhuma-owner/cleanup', {}, decode), { code: 'invalid' });
  assert.deepEqual(calls, ['zhuma-proof/status', 'zhuma-proof/status', 'zhuma-proof/cleanup']);
  assert.deepEqual(requests, [
    { method: 'zhuma-proof/status', cookie: 'synthetic-current-member', permit: undefined },
    {
      method: 'zhuma-proof/cleanup',
      cookie: 'synthetic-retained-cleanup-member',
      permit: 'synthetic-independent-cleanup',
    },
  ]);
});
test('member-local HTTP: per-scope private headers do not replace the original member authentication', async (t) => {
  const seen = [];
  let authCalls = 0;
  const origin = await server(t, (req, res, body) => {
    assert.equal(req.headers.cookie, 'synthetic-member-session');
    seen.push(req.headers['x-private-test-permit']);
    res.end(
      JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: 'confirmed' },
      }),
    );
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: ['zhuma-proof/status'],
    privateHeaderNames: ['x-private-test-permit'],
    authentication: () => {
      authCalls++;
      return { cookie: 'synthetic-member-session' };
    },
  });
  t.after(() => client.close());
  await client.invoke('zhuma-proof/status', {}, decode, undefined, {
    'x-private-test-permit': 'drive-token',
  });
  await client.invoke('zhuma-proof/status', {}, decode, undefined, {
    'x-private-test-permit': 'cleanup-token',
  });
  await assert.rejects(
    client.invoke('zhuma-proof/status', {}, decode, undefined, {
      cookie: 'must-not-replace-member',
    }),
    { code: 'invalid' },
  );
  assert.deepEqual(seen, ['drive-token', 'cleanup-token']);
  assert.equal(authCalls, 2);
});
test('member-local HTTP: only fixed methods leave the process and actual RPC replies are correlated', async (t) => {
  let calls = 0,
    authCalls = 0;
  const origin = await server(t, (req, res, body) => {
    calls++;
    assert.equal(req.url, '/api/zhuma-proof/status');
    assert.equal(req.headers.authorization, 'synthetic-device-secret');
    assert.equal(body.type, 'client-request');
    assert.deepEqual(body.payload, { requestId: 'same-original-intent' });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: 'confirmed' },
      }),
    );
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: ['zhuma-proof/status'],
    authentication: () => {
      authCalls++;
      return { authorization: 'synthetic-device-secret' };
    },
  });
  t.after(() => client.close());
  assert.equal(
    await client.invoke('zhuma-proof/status', { requestId: 'same-original-intent' }, decode),
    'confirmed',
  );
  await assert.rejects(client.invoke('zhuma-owner/execute-anything', {}, decode), {
    code: 'invalid',
  });
  assert.equal(calls, 1);
  assert.equal(authCalls, 1);
});

test('member-local HTTP: replies cannot cross RPC IDs and error bodies never enter exceptions', async (t) => {
  let wrong = true;
  const origin = await server(t, (_req, res, body) => {
    if (wrong)
      res.end(
        JSON.stringify({
          type: 'server-response',
          rpcId: 'someone-else',
          result: { ok: true, value: 'x' },
        }),
      );
    else {
      res.statusCode = 403;
      res.end('/private/BACKEND_ERROR_CANARY synthetic-device-secret');
    }
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: ['zhuma-proof/status'],
    authentication: () => ({}),
  });
  t.after(() => client.close());
  await assert.rejects(client.invoke('zhuma-proof/status', {}, decode), { code: 'protocol' });
  wrong = false;
  await assert.rejects(
    client.invoke('zhuma-proof/status', {}, decode),
    (error) =>
      error.code === 'rejected' && !/CANARY|private|synthetic-device-secret/u.test(String(error)),
  );
});

test('member-local HTTP: redirects never send credentials to another origin', async (t) => {
  let redirected = 0;
  const target = await server(t, (_req, res) => {
    redirected++;
    res.end('unexpected');
  });
  const origin = await server(t, (_req, res) => {
    res.writeHead(307, { location: target });
    res.end();
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: ['zhuma-proof/status'],
    authentication: () => ({ authorization: 'synthetic-device-secret' }),
  });
  t.after(() => client.close());
  await assert.rejects(client.invoke('zhuma-proof/status', {}, decode));
  assert.equal(redirected, 0);
});

test('member-local HTTP: cancellation retains an unknown outcome and never retries a possibly committed command', async (t) => {
  let calls = 0,
    enteredResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const origin = await server(t, (_req, res) => {
    calls++;
    enteredResolve();
    setTimeout(() => {
      if (!res.destroyed) res.end('{}');
    }, 30).unref();
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: ['zhuma-proof/status'],
    authentication: () => ({}),
  });
  const abort = new AbortController(),
    pending = client.invoke(
      'zhuma-proof/status',
      { requestId: 'keep-this-key' },
      decode,
      abort.signal,
    );
  await entered;
  abort.abort();
  await assert.rejects(pending, { code: 'cancelled', outcome: 'unknown' });
  await client.close();
  assert.equal(calls, 1);
});

test('member-local HTTP: a late credential provider after close cannot cause a late request', async (t) => {
  let release,
    startedResolve,
    calls = 0;
  const started = new Promise((resolve) => {
      startedResolve = resolve;
    }),
    hold = new Promise((resolve) => {
      release = resolve;
    });
  const origin = await server(t, (_req, res) => {
    calls++;
    res.end('{}');
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: ['zhuma-proof/status'],
    authentication: () => {
      startedResolve();
      return hold;
    },
  });
  const pending = client.invoke('zhuma-proof/status', {}, decode);
  await started;
  const closing = client.close();
  await assert.rejects(pending, { code: 'cancelled' });
  release({ authorization: 'synthetic-device-secret' });
  await closing;
  assert.equal(calls, 0);
});

test('member-local HTTP: response budgets and explicit origins fail closed', async (t) => {
  const origin = await server(t, (_req, res) => res.end('x'.repeat(256 * 1024 + 1)));
  const client = new MemberLocalExecutionClient({
    origin,
    methods: ['zhuma-proof/status'],
    authentication: () => ({}),
  });
  t.after(() => client.close());
  await assert.rejects(client.invoke('zhuma-proof/status', {}, decode), { code: 'limit' });
  for (const bad of [
    'file:///tmp/backend',
    'http://user:secret@127.0.0.1',
    'http://127.0.0.1/private',
    'http://127.0.0.1?secret=x',
  ])
    assert.throws(
      () =>
        new MemberLocalExecutionClient({
          origin: bad,
          methods: ['zhuma-proof/status'],
          authentication: () => ({}),
        }),
      { code: 'invalid' },
    );
});
