/** Real HTTP transport contracts over a synthetic upstream; no SDK identity or deployment claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import {
  createMemberGateway,
  memberRequestAllowed,
} from '../../../scripts/server/member-gateway.mjs';
import { MEMBER_ROUTE_TUPLES } from '../../../scripts/server/member-routes.mjs';

const authority = 'members.example:3080';
function send(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'GET', headers: options.headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode,
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    req.once('error', reject);
    req.end(options.body);
  });
}
async function fixture(t, handler) {
  const upstream = createServer(handler);
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = createMemberGateway({
    host: '127.0.0.1',
    port: 0,
    operatorPort: upstream.address().port,
    authorities: [authority],
  });
  const address = await gateway.listen();
  t.after(async () => {
    await gateway.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return `http://127.0.0.1:${address.port}`;
}
test('member gate admits only exact existing method/path tuples and rejects target ambiguities/owner capabilities', () => {
  assert.equal(
    new Set(MEMBER_ROUTE_TUPLES.map((tuple) => tuple.join(' '))).size,
    MEMBER_ROUTE_TUPLES.length,
  );
  for (const [method, path] of MEMBER_ROUTE_TUPLES)
    assert.equal(memberRequestAllowed(method, path), true);
  for (const path of [
    '/',
    '/api',
    '/api/session/prompt',
    '/api/zhuma-member/unknown',
    '/connect',
    '/workbench/../',
    '/%77orkbench',
    '/workbench%2f',
    '//workbench',
    'http://example/workbench',
    '/workbench#fragment',
    '/workbench?token=synthetic-owner',
    '/workbench\\app.js',
  ])
    assert.equal(memberRequestAllowed('GET', path), false, path);
  assert.equal(memberRequestAllowed('DELETE', '/workbench'), false);
  assert.equal(memberRequestAllowed('GET', '/api/zhuma-exec/file?fileId=public-fixture'), true);
});
test('public carrier preserves original Host/Origin/member cookie and strips forwarding/SDK owner capabilities', async (t) => {
  let calls = 0;
  const url = await fixture(t, (req, res) => {
    calls++;
    res.end(JSON.stringify(req.headers));
  });
  const response = await send(`${url}/workbench`, {
    headers: {
      host: authority,
      origin: `https://${authority}`,
      cookie: 'zhuma-member=member-fixture; dsh-auth-fixture=owner-fixture',
      authorization: 'Bearer owner-fixture',
      forwarded: 'host=attacker.example',
      'x-forwarded-host': 'attacker.example',
    },
  });
  assert.equal(response.status, 200);
  const headers = await response.json();
  assert.equal(headers.host, authority);
  assert.equal(headers.origin, `https://${authority}`);
  assert.equal(headers.cookie.trim(), 'zhuma-member=member-fixture');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.forwarded, undefined);
  assert.equal(headers['x-forwarded-host'], undefined);
  assert.equal((await send(`${url}/`, { headers: { host: authority } })).status, 404);
  assert.equal(
    (await send(`${url}/workbench`, { headers: { host: 'other.example' } })).status,
    403,
  );
  assert.equal(
    (await send(`${url}/workbench`, { headers: { host: authority, connection: 'origin' } })).status,
    400,
  );
  assert.equal(calls, 1, 'rejected paths/authorities never reach the owner listener');
});
test(
  'file body streams intact and SSE first bytes arrive before completion; disconnect closes the upstream carrier',
  { timeout: 10_000 },
  async (t) => {
    const released = Promise.withResolvers(),
      closed = Promise.withResolvers();
    let received = 0;
    const url = await fixture(t, async (req, res) => {
      if (req.url.endsWith('/upload-file')) {
        const hash = createHash('sha256');
        for await (const chunk of req) {
          received += chunk.length;
          hash.update(chunk);
        }
        res.end(hash.digest('hex'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      res.once('close', () => closed.resolve());
      await released.promise;
      if (!res.destroyed) res.end('data: last\n\n');
    });
    t.after(() => released.resolve());
    const body = Buffer.alloc(2 * 1024 * 1024, 37);
    const upload = await send(`${url}/api/zhuma-exec/upload-file`, {
      method: 'POST',
      headers: { host: authority },
      body,
    });
    assert.equal(await upload.text(), createHash('sha256').update(body).digest('hex'));
    assert.equal(received, body.length);
    const connection = request(`${url}/api/zhuma-exec/events`, {
      method: 'POST',
      headers: { host: authority },
    });
    const response = await new Promise((resolve, reject) => {
      connection.once('response', resolve);
      connection.once('error', reject);
      connection.end('{}');
    });
    const first = await new Promise((resolve) => response.once('data', resolve));
    assert.match(first.toString(), /data: first/u);
    response.destroy();
    connection.destroy();
    await closed.promise;
    released.resolve();
  },
);
test(
  'an early full 413 survives while a client is still uploading',
  { timeout: 5_000 },
  async (t) => {
    const url = await fixture(t, (req, res) => {
      req.resume();
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('fixture payload too large');
    });
    const reply = await new Promise((resolve, reject) => {
      const req = request(`${url}/api/zhuma-exec/upload-file`, {
        method: 'POST',
        headers: { host: authority },
      });
      let timer;
      req.once('error', reject);
      req.once('response', (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.once('end', () => {
          clearInterval(timer);
          req.destroy();
          resolve({ status: res.statusCode, body });
        });
      });
      timer = setInterval(() => {
        if (!req.destroyed) req.write(Buffer.alloc(64 * 1024));
      }, 1);
    });
    assert.deepEqual(reply, { status: 413, body: 'fixture payload too large' });
  },
);

test(
  'aborting a partial upload closes its upstream carrier without crashing later requests',
  { timeout: 5_000 },
  async (t) => {
    const received = Promise.withResolvers();
    const url = await fixture(t, (req, res) => {
      req.on('error', () => undefined);
      if (req.url.endsWith('/upload-file')) req.once('data', () => received.resolve());
      else res.end('still serving');
    });
    const uploading = request(`${url}/api/zhuma-exec/upload-file`, {
      method: 'POST',
      headers: { host: authority },
    });
    uploading.on('error', () => undefined);
    uploading.write('partial body');
    await received.promise;
    uploading.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await send(`${url}/workbench`, { headers: { host: authority } })).status, 200);
  },
);

test(
  'headers alone reach the original authentication immediately without waiting for a body',
  { timeout: 5_000 },
  async (t) => {
    let reached = 0,
      bytes = 0;
    const url = await fixture(t, (req, res) => {
      reached++;
      req.on('data', (chunk) => {
        bytes += chunk.length;
      });
      req.on('error', () => undefined);
      res.writeHead(401);
      res.end('original authentication refused');
    });
    const reply = await new Promise((resolve, reject) => {
      const req = request(`${url}/api/zhuma-exec/upload-file`, {
        method: 'POST',
        headers: { host: authority, 'content-length': '32' },
      });
      t.after(() => req.destroy());
      req.on('error', reject);
      req.once('response', (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.once('end', () => resolve({ status: res.statusCode, body }));
      });
      req.flushHeaders(); // Deliberately never write/end the declared body.
    });
    assert.deepEqual(reply, { status: 401, body: 'original authentication refused' });
    assert.equal(reached, 1);
    assert.equal(bytes, 0);
  },
);
