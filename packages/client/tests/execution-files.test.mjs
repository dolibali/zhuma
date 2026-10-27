import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createExecutionFilesApi } from '../dist/execution/files.js';

// Wire, hashing and lifetime contracts. Member/object authorization is not simulated as proof.
const target = { taskId: 'task', planId: 'plan', revision: 1, nodeId: 'node' };
const bytes = new TextEncoder().encode('真实文件正文\n');
const checksum = createHash('sha256').update(bytes).digest('hex');
const reference = {
  id: 'upload',
  mediaType: 'text/plain',
  byteSize: bytes.length,
  checksum,
  accessPolicyId: 'space:north',
  uploadComplete: true,
};
const file = () => new File([bytes], '说明.txt', { type: 'text/plain' });
const receipt = () => ({
  uploadId: 'upload',
  attachmentId: `sha256:${checksum}`,
  name: '说明.txt',
  mediaType: 'text/plain',
  bytes: bytes.length,
  sha256: checksum,
  reference: { ...reference },
});
function setup(handler, state = {}) {
  const calls = [];
  let checks = 0;
  function current(signal) {
    signal.throwIfAborted();
    if (state.current === false) throw new DOMException('Scope changed', 'AbortError');
  }
  const api = createExecutionFilesApi(
    async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.redirect, 'error');
      return handler(url, init);
    },
    'north',
    {
      current,
      async authorize(signal) {
        current(signal);
        checks++;
      },
      observed: async (promise) => promise,
    },
  );
  return {
    api,
    calls,
    get checks() {
      return checks;
    },
  };
}
const query = (purpose = 'draft') => ({
  ...target,
  uploadId: 'upload',
  purpose,
  ...(purpose === 'draft' ? {} : { artifactVersionId: 'artifact' }),
  ...(purpose === 'review' ? { roundId: 'round' } : {}),
  ...(purpose === 'upstream' ? { sourceNodeId: 'source' } : {}),
  ...(purpose === 'accepted' ? { projectId: 'project' } : {}),
});
function responseInfo(request) {
  return {
    request,
    uploadId: 'upload',
    name: '说明.txt',
    mediaType: 'text/plain',
    bytes: bytes.length,
    sha256: checksum,
    reference: { ...reference },
  };
}

const binary = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);
const binaryHash = createHash('sha256').update(binary).digest('hex');
function decodedFile({ encoding, length, body = binary }) {
  return setup((url) => {
    const request = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
    request.revision = Number(request.revision);
    if (request.mode === 'metadata')
      return Response.json({
        ok: true,
        value: {
          ...responseInfo(request),
          name: 'data.bin',
          mediaType: 'application/octet-stream',
          bytes: binary.length,
          sha256: binaryHash,
          reference: {
            ...reference,
            mediaType: 'application/octet-stream',
            byteSize: binary.length,
            checksum: binaryHash,
          },
        },
      });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      {
        headers: {
          'content-type': 'application/octet-stream',
          'x-zhuma-file-context': encodeURIComponent(JSON.stringify(request)),
          'x-zhuma-file-upload-id': 'upload',
          'x-zhuma-file-sha256': binaryHash,
          ...(encoding === undefined ? {} : { 'content-encoding': encoding }),
          ...(length === undefined ? {} : { 'content-length': String(length) }),
        },
      },
    );
  });
}

for (const [name, framing] of [
  ['gzip with wire length', { encoding: 'gzip', length: 315 }],
  ['gzip without wire length', { encoding: 'gzip' }],
  ['chunked identity', { encoding: 'identity' }],
  ['native unframed response', {}],
  ['identity with exact length', { encoding: 'identity', length: binary.length }],
])
  test(`decoded file contract: ${name} validates canonical binary bytes`, async () => {
    // Response bodies model Fetch-decoded bytes here. Real gzip/native forwarding
    // is verified separately against the official HTTP/desktop implementations.
    const h = decodedFile(framing);
    const value = await h.api.read(query('review'), 'download', new AbortController().signal);
    assert.deepEqual(value.bytes, binary);
    assert.equal(value.info.sha256, binaryHash);
    assert.equal(h.checks, 2);
  });

for (const [name, framing, code] of [
  ['wrong identity length', { encoding: 'identity', length: 12 }, 'validation'],
  ['wrong unencoded length', { length: 12 }, 'validation'],
  ['oversized decoded gzip', { encoding: 'gzip', body: new Uint8Array(4097) }, 'validation'],
  ['truncated decoded gzip', { encoding: 'gzip', body: binary.slice(0, -1) }, 'digest-mismatch'],
  ['wrong decoded hash', { encoding: 'gzip', body: new Uint8Array(4096) }, 'digest-mismatch'],
])
  test(`decoded file contract: ${name} is rejected`, async () => {
    const h = decodedFile(framing);
    await assert.rejects(h.api.read(query('review'), 'download', new AbortController().signal), {
      code,
    });
  });

test('files wire contract: upload hashes actual immutable bytes, uses the exact byte route and validates canonical receipt', async () => {
  const phases = [];
  const h = setup(async (url, init) => {
    assert.equal(url, '/api/zhuma-exec/upload-file');
    assert.equal(init.headers['x-zhuma-space'], 'north');
    assert.equal(init.headers['x-zhuma-node'], 'node');
    assert.equal(init.headers['x-zhuma-file-name'], encodeURIComponent('说明.txt'));
    assert.equal(init.headers['x-zhuma-file-sha256'], checksum);
    assert.equal(init.headers['x-zhuma-idempotency-key'], 'original-key');
    assert.deepEqual(new Uint8Array(await init.body.arrayBuffer()), bytes);
    return Response.json({ ok: true, value: receipt() });
  });
  const result = await h.api.upload(
    { target, file: file(), requestId: 'original-key' },
    new AbortController().signal,
    (phase) => phases.push(phase),
  );
  assert.deepEqual(result, { uploadId: 'upload', name: '说明.txt', reference });
  assert.deepEqual(phases, ['preparing', 'uploading']);
  assert.equal(h.checks, 3);
});

test('files wire contract: wrong digest, scope, receipt size or incomplete reference never becomes an uploaded file', async () => {
  for (const change of [
    (v) => {
      v.sha256 = '0'.repeat(64);
    },
    (v) => {
      v.reference.accessPolicyId = 'space:other';
    },
    (v) => {
      v.bytes++;
    },
    (v) => {
      v.reference.uploadComplete = false;
    },
    (v) => {
      v.uploadId = 'different';
    },
  ]) {
    const value = receipt();
    change(value);
    const h = setup(() => Response.json({ ok: true, value }));
    await assert.rejects(
      h.api.upload({ target, file: file(), requestId: 'key' }, new AbortController().signal),
      { code: 'validation' },
    );
  }
});

for (const purpose of ['draft', 'artifact', 'review', 'upstream', 'accepted'])
  test(`files wire contract: ${purpose} uses exact purpose fields and independently verified metadata/content`, async () => {
    const h = setup((url) => {
      const request = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
      request.revision = Number(request.revision);
      assert.equal(request.purpose, purpose);
      assert.equal(request.spaceId, 'north');
      assert.equal(request.projectId, purpose === 'accepted' ? 'project' : undefined);
      if (request.mode === 'metadata')
        return Response.json({ ok: true, value: responseInfo(request) });
      return new Response(bytes, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'inline; filename="file"',
          'content-length': String(bytes.length),
          'x-zhuma-file-context': encodeURIComponent(JSON.stringify(request)),
          'x-zhuma-file-upload-id': 'upload',
          'x-zhuma-file-sha256': checksum,
        },
      });
    });
    const value = await h.api.read(query(purpose), 'preview', new AbortController().signal);
    assert.deepEqual(value.bytes, bytes);
    assert.equal(value.inline, true);
    assert.equal(h.calls.length, 2);
    assert.equal(h.checks, 2);
  });

test('files wire contract: accepted project identity is required and an altered project echo fails closed', async () => {
  const invalid = setup(() => {
    throw Error('invalid project must not reach the file route');
  });
  await assert.rejects(
    invalid.api.metadata({ ...query('accepted'), projectId: '' }, new AbortController().signal),
    { code: 'validation' },
  );
  assert.equal(invalid.calls.length, 0);
  const crossed = setup((url) => {
    const request = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
    request.revision = Number(request.revision);
    request.projectId = 'another-project';
    return Response.json({ ok: true, value: responseInfo(request) });
  });
  await assert.rejects(crossed.api.metadata(query('accepted'), new AbortController().signal), {
    code: 'validation',
  });
});

test('files wire contract: crossed version, corrupted body and oversize response fail before preview', async () => {
  for (const bad of ['scope', 'digest', 'oversize']) {
    const h = setup((url) => {
      const request = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
      request.revision = 1;
      if (request.mode === 'metadata')
        return Response.json({ ok: true, value: responseInfo(request) });
      const context = bad === 'scope' ? { ...request, artifactVersionId: 'other' } : request;
      const body =
        bad === 'oversize'
          ? new Uint8Array(bytes.length + 1)
          : new Uint8Array(bytes.length).fill(1);
      return new Response(body, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'inline;',
          'content-length': String(bytes.length),
          'x-zhuma-file-context': encodeURIComponent(JSON.stringify(context)),
          'x-zhuma-file-upload-id': 'upload',
          'x-zhuma-file-sha256': checksum,
        },
      });
    });
    await assert.rejects(h.api.read(query('artifact'), 'preview', new AbortController().signal));
  }
});

test('files wire contract: a late successful upload after scope replacement cannot publish its receipt', async () => {
  const state = { current: true },
    waiting = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const h = setup(async () => {
    entered.resolve();
    await waiting.promise;
    return Response.json({ ok: true, value: receipt() });
  }, state);
  const upload = h.api.upload(
    { target, file: file(), requestId: 'same-key' },
    new AbortController().signal,
  );
  await entered.promise;
  state.current = false;
  waiting.resolve();
  await assert.rejects(upload, { name: 'AbortError' });
});

test('files wire contract: cancel during byte consumption cancels the stream and returns no preview', async () => {
  const controller = new AbortController(),
    entered = Promise.withResolvers();
  let cancelled = false;
  const h = setup((url) => {
    const request = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
    request.revision = 1;
    if (request.mode === 'metadata')
      return Response.json({ ok: true, value: responseInfo(request) });
    entered.resolve();
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'inline;',
          'content-length': String(bytes.length),
          'x-zhuma-file-context': encodeURIComponent(JSON.stringify(request)),
          'x-zhuma-file-upload-id': 'upload',
          'x-zhuma-file-sha256': checksum,
        },
      },
    );
  });
  const reading = h.api.read(query(), 'preview', controller.signal);
  await entered.promise;
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
