/** Actual SDK Node HTTP/cookies + original attachment verifier. Signed Run
 * admission/active owner and asset-row authority are explicit contracts here;
 * the actual D authority suite and normal GUI/model are separate evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import {
  canonicalPayload,
  REMOTE_RUN_PERMIT_HEADER,
  REMOTE_TEAM_ASSET_FILE_PATH as TEAM_ASSET_RUN_FILE_HTTP_PATH,
  REMOTE_TEAM_ASSET_FILE_METHOD as TEAM_ASSET_RUN_FILE_HTTP_METHOD,
} from '@zhuma/agent-core';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { enableMemberWeb } from '../dist/member-web-transport.js';
import { resolveMember } from '../dist/member-session.js';
import { TeamAssetFileBytes } from '../dist/team-asset-file.js';
import { TeamAssetFileService } from '../dist/team-asset-file-service.js';
import { openTeamAssetRunFileHttp } from '../dist/team-asset-run-file-http.js';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const active = () => new AbortController().signal;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const denial = (code) => Object.assign(Error('PRIVATE_RUN_DETAIL'), { code });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-team-run-http-'));
  let host, attachment, files, http;
  const cleanup = [];
  t.after(async () => {
    for (const stop of cleanup.reverse()) await stop();
    await http?.close();
    await files?.close();
    await attachment?.dispose();
    await host?.close();
    await rm(root, { recursive: true, force: true });
  });
  host = await startMemberWorkbenchHost(root);
  attachment = host.ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'file-bytes') });
  await attachment;
  const data = options.data ?? Buffer.concat([Buffer.alloc(150000, 65), Buffer.from('汉😀')]);
  const file = {
    name: 'Fixed guide.txt',
    mediaType: 'text/plain',
    byteSize: data.length,
    sha256: hash(data),
  };
  const reference = {
    spaceId: 'north',
    assetId: 'guide',
    kind: 'file',
    versionId: randomUUID(),
    sha256: 'b'.repeat(64),
  };
  const scope = {
    backendId: randomUUID(),
    actorId: 'ann',
    spaceId: 'north',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
  };
  const run = new AbortController();
  const calls = { admit: 0, attachment: 0, fileRelease: 0, runRelease: 0, checks: 0 };
  let blocked = false,
    admission,
    afterGrant,
    grantFile,
    ownerAvailable = true;
  const carrier = new TeamAssetFileBytes({
    saveFileStream: (request) => host.ctx.attachments.saveFileStream(request),
    async *readFileStream(request) {
      calls.attachment++;
      if (blocked) await options.block();
      yield* host.ctx.attachments.readFileStream(request);
    },
  });
  const blob = await carrier.save(
    file,
    (async function* () {
      yield data;
    })(),
    { signal: active(), assertCurrent() {} },
  );
  // The original save verifies its persisted readback. Count only subsequent
  // request reads, rather than treating fixture preparation as endpoint I/O.
  calls.attachment = 0;
  files = new TeamAssetFileService(carrier, {
    reserveFile() {
      throw Error('no upload');
    },
    commitFile() {
      throw Error('no commit');
    },
    abortFile() {
      throw Error('no write');
    },
    async readFile(request, target, signal) {
      const member = await resolveMember(host.ctx, request);
      if (
        !member.ok ||
        member.memberId !== 'ann' ||
        !host.directory.isMember('north', 'ann') ||
        canonicalPayload(target) !==
          canonicalPayload({
            spaceId: reference.spaceId,
            assetId: reference.assetId,
            versionId: reference.versionId,
          })
      )
        throw denial('asset-reference-denied');
      return {
        blob: structuredClone(blob),
        grant: {
          signal,
          assertCurrent() {
            signal.throwIfAborted();
            if (!host.directory.isMember('north', 'ann')) throw denial('asset-reference-denied');
          },
        },
        release() {
          calls.fileRelease++;
        },
      };
    },
  });
  const execution = {
    async openRemoteTeamAssetFile(request, body, permit, signal) {
      calls.admit++;
      if (
        permit !== 'synthetic-private-permit' ||
        canonicalPayload(body.payload.scope) !== canonicalPayload(scope) ||
        canonicalPayload(body.payload.reference) !== canonicalPayload(reference)
      )
        throw denial('remote-scope-mismatch');
      if (admission) await admission();
      let released;
      const retirement = new AbortController();
      const grant = {
        scope: structuredClone(scope),
        reference: structuredClone(reference),
        file: structuredClone(grantFile ?? file),
        request,
        signal: AbortSignal.any([signal, run.signal, retirement.signal]),
        check() {
          calls.checks++;
          this.signal.throwIfAborted();
          if (!host.directory.isMember('north', 'ann')) throw denial('remote-forbidden');
        },
        releaseAfter(drain) {
          return (released ??= (async () => {
            // Match the original D grant: cleanup requests cancellation first,
            // but holds its actual reservation until the producer terminates.
            retirement.abort();
            try {
              await drain;
            } finally {
              calls.runRelease++;
            }
          })());
        },
      };
      afterGrant?.();
      return grant;
    },
  };
  enableMemberWeb(host.ctx);
  http = openTeamAssetRunFileHttp(host.ctx, () =>
    ownerAvailable ? { execution, files } : undefined,
  );
  const origin = `http://127.0.0.1:${host.ctx.webServer.port}`,
    cookie = await host.login('ann');
  const envelope = (mode = 'read', patch = {}) => ({
    type: 'client-request',
    rpcId: randomUUID(),
    method: TEAM_ASSET_RUN_FILE_HTTP_METHOD,
    payload: {
      protocolVersion: 1,
      operation: 'team-asset-file',
      requestId: randomUUID(),
      backendId: scope.backendId,
      deviceId: randomUUID(),
      proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'a'.repeat(86) },
      payload: { scope, permit: { id: randomUUID(), sha256: 'c'.repeat(64) }, mode, reference },
      ...patch,
    },
  });
  const headers = {
    'content-type': 'application/json',
    origin,
    cookie,
    [REMOTE_RUN_PERMIT_HEADER]: 'synthetic-private-permit',
  };
  return {
    host,
    http,
    files,
    execution,
    data,
    file,
    reference,
    scope,
    calls,
    origin,
    cookie,
    headers,
    envelope,
    source: () => (ownerAvailable ? { execution, files } : undefined),
    beforeClose(fn) {
      cleanup.push(fn);
    },
    post(mode = 'read', patch = {}) {
      return fetch(origin + TEAM_ASSET_RUN_FILE_HTTP_PATH, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope(mode, patch)),
      });
    },
    block() {
      blocked = true;
    },
    stop() {
      run.abort();
    },
    unavailable() {
      ownerAvailable = false;
    },
    mismatchFile() {
      grantFile = { ...file, name: 'wrong.txt' };
    },
    delayAdmission(fn) {
      admission = fn;
    },
    afterGrant(fn) {
      afterGrant = fn;
    },
  };
}

test('Run file HTTP: member and same-origin admission precede incomplete request bytes and all Run/attachment I/O', async (t) => {
  const h = await fixture(t);
  for (const headers of [
    { 'content-type': 'application/json', 'content-length': '999999' },
    { ...h.headers, origin: 'https://foreign.invalid', 'content-length': '999999' },
  ]) {
    const req = httpRequest(h.origin + TEAM_ASSET_RUN_FILE_HTTP_PATH, { method: 'POST', headers });
    const done = once(req, 'response');
    req.flushHeaders();
    const [response] = await done;
    response.resume();
    await once(response, 'end');
    assert.ok([401, 403].includes(response.statusCode));
    req.destroy();
  }
  assert.equal(h.calls.admit, 0);
  assert.equal(h.calls.attachment, 0);
});

test('Run file HTTP: signed metadata check has zero attachment I/O and retains exact full metadata/secret-header separation', async (t) => {
  const h = await fixture(t),
    e = h.envelope('check');
  const r = await fetch(h.origin + TEAM_ASSET_RUN_FILE_HTTP_PATH, {
    method: 'POST',
    headers: h.headers,
    body: JSON.stringify(e),
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.rpcId, e.rpcId);
  assert.equal(body.result.ok, true);
  assert.deepEqual(body.result.value, { scope: h.scope, reference: h.reference, file: h.file });
  assert.doesNotMatch(JSON.stringify(body), /synthetic-private-permit|attachmentId|PRIVATE/);
  assert.equal(h.calls.attachment, 0);
  await tick();
  assert.equal(h.calls.runRelease, 1);
});

test('Run file HTTP: actual original attachment streams once into raw binary HTTP with exact length/digests/full fixed metadata', async (t) => {
  const h = await fixture(t),
    e = h.envelope();
  const r = await fetch(h.origin + TEAM_ASSET_RUN_FILE_HTTP_PATH, {
    method: 'POST',
    headers: h.headers,
    body: JSON.stringify(e),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('content-length'), String(h.data.length));
  assert.equal(r.headers.get('x-zhuma-rpc-id'), e.rpcId);
  assert.equal(r.headers.get('x-zhuma-run-scope-sha256'), hash(canonicalPayload(h.scope)));
  assert.deepEqual(
    JSON.parse(decodeURIComponent(r.headers.get('x-zhuma-team-asset-reference'))),
    h.reference,
  );
  assert.deepEqual(
    JSON.parse(decodeURIComponent(r.headers.get('x-zhuma-team-asset-file'))),
    h.file,
  );
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const actual = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(actual, h.data);
  assert.equal(hash(actual), h.file.sha256);
  assert.equal(h.calls.attachment, 1);
  assert.ok(h.calls.checks >= 4);
  await tick();
  assert.equal(h.calls.fileRelease, 1);
  assert.equal(h.calls.runRelease, 1);
});

test('Run file HTTP: malformed method/body/scope and changed grant-file metadata fail before binary success without private error leakage', async (t) => {
  const h = await fixture(t);
  for (const patch of [
    { method: 'zhuma-remote-run/info' },
    { payload: { operation: 'team-asset-file' } },
    {
      payload: {
        ...h.envelope().payload,
        payload: { ...h.envelope().payload.payload, scope: { ...h.scope, spaceId: 'south' } },
      },
    },
  ]) {
    const r = await h.post('read', patch);
    const text = await r.text();
    assert.equal(JSON.parse(text).result.ok, false);
    assert.doesNotMatch(text, /PRIVATE_RUN_DETAIL|attachmentId/);
  }
  assert.equal(h.calls.attachment, 0);
  h.mismatchFile();
  const r = await h.post();
  assert.equal(r.status, 409);
  assert.equal((await r.json()).result.error.code, 'remote-input-stale');
  await tick();
  assert.equal(h.calls.fileRelease, 1);
});

class ControlledResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  closed = false;
  chunks = [];
  status = 0;
  headers = {};
  setHeader(key, value) {
    this.headers[key] = value;
  }
  writeHead(status, headers) {
    this.status = status;
    Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }
  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    this.emit('written');
    return false;
  }
  end(chunk) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
    this.emit('ended');
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroy-requested');
    return this;
  }
  finish() {
    this.writableFinished = true;
    this.emit('finish');
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
}
function incoming(h, mode = 'read') {
  const req = Readable.from([Buffer.from(JSON.stringify(h.envelope(mode)))]);
  req.method = 'POST';
  req.headers = { ...h.headers, host: new URL(h.origin).host };
  return req;
}
async function controlled(t, options = {}) {
  const h = await fixture(t, options),
    routes = [];
  const ctx = {
    root: h.host.ctx.root,
    connection: h.host.ctx.connection,
    effect: () => {},
    inject(_names, apply) {
      apply({
        effect: () => {},
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
      });
    },
  };
  const http = openTeamAssetRunFileHttp(ctx, h.source);
  const responses = new Set();
  h.beforeClose(async () => {
    for (const res of responses) res.close();
    await http.close();
  });
  const original = routes[0].handler;
  routes[0].handler = (req, res) => {
    responses.add(res);
    return original(req, res);
  };
  return { ...h, controlledHttp: http, route: routes[0] };
}

test('Run file output drain contract: backpressure holds original leases and close waits actual close event, not destroy() flag', async (t) => {
  const h = await controlled(t),
    res = new ControlledResponse();
  const written = once(res, 'written');
  const handling = h.route.handler(incoming(h), res);
  await written;
  let closed = false;
  const closing = h.controlledHttp.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(res.destroyed, true);
  assert.equal(res.closed, false);
  assert.equal(closed, false);
  assert.equal(h.calls.runRelease, 0);
  assert.equal(h.calls.fileRelease, 0);
  res.close();
  await handling;
  await closing;
  assert.equal(closed, true);
  assert.equal(h.calls.runRelease, 1);
  assert.equal(h.calls.fileRelease, 1);
  assert.equal(res.chunks.length, 1);
});

test('Run file drain contract: cancelled uncooperative attachment retains original Run/file reservations until actual producer ends', async (t) => {
  const entered = deferred(),
    physical = deferred();
  const h = await controlled(t, {
    block() {
      entered.resolve();
      return physical.promise;
    },
  });
  h.block();
  const res = new ControlledResponse();
  const handling = h.route.handler(incoming(h), res);
  await entered.promise;
  let closed = false;
  const closing = h.controlledHttp.close().then(() => {
    closed = true;
  });
  await tick();
  res.close();
  await tick();
  assert.equal(closed, false);
  assert.equal(h.calls.runRelease, 0);
  assert.equal(h.calls.fileRelease, 0);
  physical.resolve();
  await handling;
  await closing;
  assert.equal(h.calls.runRelease, 1);
  assert.equal(h.calls.fileRelease, 1);
  assert.equal(res.chunks.length, 0);
});

test('Run file drain contract: cancelled admission waits late actual grant and releases it without touching attachments', async (t) => {
  const h = await controlled(t),
    entered = deferred(),
    admission = deferred();
  h.delayAdmission(() => {
    entered.resolve();
    return admission.promise;
  });
  const res = new ControlledResponse(),
    handling = h.route.handler(incoming(h), res);
  await entered.promise;
  let closed = false;
  const closing = h.controlledHttp.close().then(() => {
    closed = true;
  });
  res.close();
  await tick();
  assert.equal(closed, false);
  admission.resolve();
  await handling;
  await closing;
  assert.equal(h.calls.runRelease, 1);
  assert.equal(h.calls.attachment, 0);
});

test('Run file HTTP: original small JSON budget rejects before signed Run or attachment admission', async (t) => {
  const h = await fixture(t),
    e = { ...h.envelope(), padding: 'q'.repeat(16 * 1024) };
  const r = await fetch(h.origin + TEAM_ASSET_RUN_FILE_HTTP_PATH, {
    method: 'POST',
    headers: h.headers,
    body: JSON.stringify(e),
  });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).result.error.code, 'remote-quota');
  assert.equal(h.calls.admit, 0);
  assert.equal(h.calls.attachment, 0);
});

test('Run file output contract: replacing the actual owner or stopping a Run cuts binary bytes after backpressure without appending JSON', async (t) => {
  for (const mutate of ['owner', 'stop']) {
    const h = await controlled(t),
      res = new ControlledResponse(),
      written = once(res, 'written');
    const handling = h.route.handler(incoming(h), res);
    await written;
    if (mutate === 'owner') {
      h.unavailable();
      res.emit('drain');
    } else h.stop();
    await tick();
    assert.equal(res.destroyed, true);
    assert.equal(res.chunks.length, 1);
    assert.equal(h.calls.fileRelease, 0);
    assert.equal(h.calls.runRelease, 0);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    res.close();
    await handling;
    assert.equal(h.calls.runRelease, 1);
    assert.equal(h.calls.fileRelease, 1);
  }
});

test('Run file output contract: successful metadata end waits actual finish before original releaseAfter cancellation', async (t) => {
  const h = await controlled(t),
    res = new ControlledResponse(),
    ended = once(res, 'ended');
  const handling = h.route.handler(incoming(h, 'check'), res);
  await ended;
  await tick();
  assert.equal(res.destroyed, false);
  assert.equal(h.calls.runRelease, 0);
  assert.equal(h.calls.attachment, 0);
  assert.equal(JSON.parse(Buffer.concat(res.chunks).toString()).result.ok, true);
  res.finish();
  await handling;
  assert.equal(res.destroyed, false);
  assert.equal(h.calls.runRelease, 1);
});
