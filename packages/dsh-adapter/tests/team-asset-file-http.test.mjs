/** Real published SDK HTTP, original product cookies/directory and attachments.
 * D's asset row/CAS authority remains an explicit port contract in this suite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { enableMemberWeb } from '../dist/member-web-transport.js';
import { resolveMember } from '../dist/member-session.js';
import { TeamAssetFileBytes } from '../dist/team-asset-file.js';
import { TeamAssetFileService } from '../dist/team-asset-file-service.js';
import { openTeamAssetFileHttp, TEAM_ASSET_FILE_HTTP_PATHS } from '../dist/team-asset-file-http.js';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const error = (code) => Object.assign(Error('PRIVATE_ASSET_DETAIL'), { code });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-team-http-'));
  let host, attachment, service, http;
  t.after(async () => {
    await http?.close();
    await service?.close();
    await attachment?.dispose();
    await host?.close();
    await rm(root, { recursive: true, force: true });
  });
  host = await startMemberWorkbenchHost(root);
  attachment = host.ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'team-files') });
  await attachment;
  const calls = { reserve: 0, commit: 0, releaseUpload: 0, read: 0, releaseRead: 0 };
  let blob,
    receipt,
    bodyFingerprint,
    denied = false;
  const versionId = randomUUID(),
    tickets = new WeakSet();
  async function access(request, spaceId) {
    const member = await resolveMember(host.ctx, request);
    if (!member.ok || !member.spaceIds.includes(spaceId)) throw error('asset-not-found');
    return {
      signal: new AbortController().signal,
      assertCurrent() {
        if (denied || !host.directory.isMember(spaceId, member.memberId))
          throw error('asset-reference-denied');
      },
    };
  }
  const authority = {
    async reserveFile(request, input) {
      calls.reserve++;
      const grant = await access(request, input.spaceId);
      if (input.spaceId !== 'north' || input.assetId !== 'guide') throw error('asset-not-found');
      const fingerprint = JSON.stringify(input);
      if (bodyFingerprint && fingerprint !== bodyFingerprint) throw error('asset-request-reused');
      bodyFingerprint = fingerprint;
      const ticket = { kind: 'member-asset-file-ticket' };
      tickets.add(ticket);
      return receipt
        ? { kind: 'replayed', receipt, ticket, grant }
        : { kind: 'reserved', ticket, grant };
    },
    async commitFile(ticket, stored) {
      assert.equal(tickets.has(ticket), true);
      calls.commit++;
      if (denied) throw error('asset-reference-denied');
      blob = stored;
      const { attachmentId: _private, ...file } = stored;
      receipt = {
        spaceId: 'north',
        assetId: 'guide',
        idempotencyKey: JSON.parse(bodyFingerprint).idempotencyKey,
        assetVersion: 3,
        file,
      };
      return receipt;
    },
    async abortFile(ticket) {
      assert.equal(tickets.delete(ticket), true);
      calls.releaseUpload++;
    },
    async readFile(request, input) {
      calls.read++;
      const grant = await access(request, input.spaceId);
      if (!blob || input.assetId !== 'guide' || input.versionId !== versionId)
        throw error('asset-not-found');
      grant.assertCurrent();
      return {
        blob: structuredClone(blob),
        grant,
        release() {
          calls.releaseRead++;
        },
      };
    },
  };
  service = new TeamAssetFileService(new TeamAssetFileBytes(host.ctx.attachments), authority);
  enableMemberWeb(host.ctx);
  http = openTeamAssetFileHttp(host.ctx, () => service);
  // The official in-process dispatcher preserves a pull-controlled response;
  // the four network cases above separately exercise actual HTTP/Cookies.
  const shared = host.ctx.connection.createSharedFetchHandler('/api');
  const origin = `http://127.0.0.1:${host.ctx.webServer.port}`,
    cookie = await host.login('ann'),
    other = await host.login('dana');
  const input = (data, patch = {}) => ({
    spaceId: 'north',
    assetId: 'guide',
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    declare: {
      name: '团队资料.txt',
      mediaType: 'text/plain',
      byteSize: data.length,
      sha256: hash(data),
    },
    ...patch,
  });
  const headers = (value, auth = cookie) => ({
    origin,
    ...(auth ? { cookie: auth } : {}),
    'content-type': 'application/octet-stream',
    'x-zhuma-space-id': value.spaceId,
    'x-zhuma-asset-id': value.assetId,
    'x-zhuma-expected-version': String(value.expectedVersion),
    'x-zhuma-idempotency-key': value.idempotencyKey,
    'x-zhuma-file-name': encodeURIComponent(value.declare.name),
    'x-zhuma-file-type': value.declare.mediaType,
    'x-zhuma-file-size': String(value.declare.byteSize),
    'x-zhuma-file-sha256': value.declare.sha256,
  });
  const envelope = (kind, payload) => ({
    type: 'client-request',
    rpcId: randomUUID(),
    method: `zhuma-member/asset-file-${kind}`,
    payload,
  });
  const target = { spaceId: 'north', assetId: 'guide', versionId };
  return {
    root,
    host,
    service,
    http,
    calls,
    origin,
    cookie,
    other,
    input,
    headers,
    envelope,
    target,
    deny() {
      denied = true;
    },
    upload: (data, value = input(data), auth = cookie) =>
      fetch(origin + TEAM_ASSET_FILE_HTTP_PATHS.upload, {
        method: 'POST',
        headers: headers(value, auth),
        body: data,
      }),
    directUpload: (body, value, signal) =>
      shared.fetch(
        new Request(origin + TEAM_ASSET_FILE_HTTP_PATHS.upload, {
          method: 'POST',
          headers: { ...headers(value), host: new URL(origin).host },
          body,
          signal,
          duplex: 'half',
        }),
        host.ctx.connection.browserPeer,
      ),
    call: (kind, payload, auth = cookie) =>
      fetch(origin + TEAM_ASSET_FILE_HTTP_PATHS[kind], {
        method: 'POST',
        headers: { origin, cookie: auth, 'content-type': 'application/json' },
        body: JSON.stringify(envelope(kind, payload)),
      }),
    direct: (kind, payload) =>
      shared.fetch(
        new Request(origin + TEAM_ASSET_FILE_HTTP_PATHS[kind], {
          method: 'POST',
          headers: {
            origin,
            host: new URL(origin).host,
            cookie,
            'content-type': 'application/json',
          },
          body: JSON.stringify(envelope(kind, payload)),
        }),
        host.ctx.connection.browserPeer,
      ),
  };
}

test('team file HTTP: real member-cookie upload, exact original download/context and bounded text use no task/attachment handle', async (t) => {
  const h = await fixture(t),
    data = Buffer.from('A汉😀BC'),
    input = h.input(data);
  const upload = await h.upload(data, input),
    result = await upload.json();
  assert.equal(upload.status, 200);
  assert.equal(result.ok, true);
  assert.equal('attachmentId' in result.value.file, false);
  assert.equal(result.value.file.sha256, hash(data));
  const read = await h.call('read', { ...h.target, mode: 'preview' });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
  assert.match(read.headers.get('content-security-policy'), /sandbox/u);
  assert.deepEqual(JSON.parse(decodeURIComponent(read.headers.get('x-zhuma-asset-file-context'))), {
    ...h.target,
    mode: 'preview',
  });
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), data);
  const text = await h.call('text', { ...h.target, offset: 1, length: 4 }),
    page = await text.json();
  assert.equal(page.result.ok, true);
  assert.equal(page.result.value.text, '汉');
  assert.deepEqual(page.result.value.target, h.target);
  assert.equal(page.result.value.checksum, hash(data));
  await h.service.idle();
  assert.equal(h.calls.releaseRead, 2);
});

test('team file HTTP: same declaration still checks replay bytes; corrupt actual body is not another successful receipt', async (t) => {
  const h = await fixture(t),
    data = Buffer.from('same'),
    input = h.input(data);
  assert.equal((await (await h.upload(data, input)).json()).ok, true);
  assert.equal((await (await h.upload(data, input)).json()).ok, true);
  const wrong = await h.upload(Buffer.from('else'), input);
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error.code, 'asset-file-invalid');
  await h.service.idle();
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.releaseUpload, 3);
});

test('team file HTTP: absent/foreign members are refused while the actual request body is still incomplete', async (t) => {
  const h = await fixture(t),
    data = Buffer.from('pending body'),
    input = h.input(data);
  for (const cookie of ['', h.other]) {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(
        h.origin + TEAM_ASSET_FILE_HTTP_PATHS.upload,
        {
          method: 'POST',
          headers: { ...h.headers(input, cookie), 'content-length': String(data.length) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
          req.destroy();
        },
      );
      req.on('error', (error) => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      req.setTimeout(5000, () => {
        req.destroy();
        reject(Error('early rejection did not arrive'));
      });
      req.write(data.subarray(0, 1)); // Intentionally leave the remaining body unsent.
    });
    assert.ok([401, 404].includes(status));
  }
  assert.equal(h.calls.commit, 0);
});

test('team file HTTP: exact published version required; malformed/oversized JSON and header declarations never become success', async (t) => {
  const h = await fixture(t),
    data = Buffer.from('body');
  await (await h.upload(data)).body.cancel();
  const stale = await h.call('read', { ...h.target, versionId: randomUUID() });
  assert.equal(stale.status, 404);
  assert.doesNotMatch(await stale.text(), /PRIVATE_/u);
  const bad = await h.call('text', { ...h.target, offset: 0, length: 8193 });
  assert.equal(bad.status, 400);
  const oversized = await fetch(h.origin + TEAM_ASSET_FILE_HTTP_PATHS.read, {
    method: 'POST',
    headers: { origin: h.origin, cookie: h.cookie, 'content-type': 'application/json' },
    body: ' '.repeat(16385),
  });
  assert.equal(oversized.status, 413);
  const invalid = h.input(data);
  invalid.declare.name = '%'.repeat(4097);
  assert.equal((await h.upload(data, invalid)).status, 400);
});

test('team file HTTP: a live original read grant fences between output chunks and releases once', async (t) => {
  const h = await fixture(t),
    data = Buffer.alloc(100000, 65);
  await (await h.upload(data)).body.cancel();
  const response = await h.direct('read', { ...h.target, mode: 'download' });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.length, 65536);
  h.deny();
  await assert.rejects(reader.read(), /asset-file-unavailable/u);
  await h.service.idle();
  assert.equal(h.calls.releaseRead, 1);
});

test('team file HTTP: route close cancels an unread verified response and waits its release', async (t) => {
  const h = await fixture(t),
    data = Buffer.from('body');
  await (await h.upload(data)).body.cancel();
  const response = await h.direct('read', { ...h.target, mode: 'download' });
  await h.http.close();
  await assert.rejects(response.arrayBuffer());
  await h.service.idle();
  assert.equal(h.calls.releaseRead, 1);
});

test('team file HTTP: abort, iterator return and route close share the same pending physical request cancellation', async (t) => {
  const h = await fixture(t);
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const reading = deferred(),
    cancelling = deferred(),
    physical = deferred();
  let first = true,
    cancels = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new Uint8Array([65]));
        } else reading.resolve();
      },
      cancel() {
        cancels++;
        cancelling.resolve();
        return physical.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const abort = new AbortController();
  const sending = h.directUpload(body, h.input(Buffer.from('AB')), abort.signal);
  await Promise.race([
    reading.promise,
    sending.then((response) => {
      throw new Error(`Upload refused before the stream test: ${response.status}`);
    }),
  ]);
  abort.abort();
  await cancelling.promise;
  let closed = false;
  const closing = h.http.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(closed, false, 'route close cannot outrun the request reader cancellation');
    assert.equal(
      h.calls.releaseUpload,
      0,
      'original upload lease remains until physical source drain',
    );
    assert.equal(cancels, 1);
  } finally {
    physical.resolve();
  }
  const response = await sending;
  await response.body?.cancel();
  await closing;
  await h.service.idle();
  assert.equal(cancels, 1);
  assert.equal(h.calls.releaseUpload, 1);
});
