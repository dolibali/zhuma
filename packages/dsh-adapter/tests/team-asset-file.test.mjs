import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TeamAssetFileBytes } from '../dist/team-asset-file.js';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const declaration = (data, patch = {}) => ({
  name: '资料.txt',
  mediaType: 'text/plain',
  byteSize: data.length,
  sha256: hash(data),
  ...patch,
});
const source = (data) =>
  (async function* () {
    yield data;
  })();
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function grant() {
  const controller = new AbortController();
  let current = true;
  return {
    signal: controller.signal,
    assertCurrent() {
      if (!current) throw Error('PRIVATE_AUTHORITY_DETAIL');
    },
    revoke() {
      current = false;
    },
    abort() {
      controller.abort();
    },
  };
}
function memory() {
  const objects = new Map();
  let saves = 0,
    reads = 0;
  const attachments = {
    async saveFileStream(input) {
      saves++;
      const chunks = [];
      for await (const chunk of input.data) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks),
        attachmentId = `sha256:${hash(data)}`;
      objects.set(attachmentId, data);
      return { attachmentId, bytes: data.length, name: input.name };
    },
    async *readFileStream(ref) {
      reads++;
      const data = objects.get(ref.attachmentId);
      if (!data) throw Error('PRIVATE_MISSING_BYTES');
      yield data.subarray(0, 2);
      yield data.subarray(2);
    },
  };
  return { attachments, objects, counts: () => ({ saves, reads }) };
}

test('team files: no task or storage domain, constructor has no IO; authority precedes attachment access', async () => {
  const m = memory(),
    bytes = new TeamAssetFileBytes(m.attachments),
    access = grant();
  assert.deepEqual(m.counts(), { saves: 0, reads: 0 });
  access.revoke();
  const data = Buffer.from('正文');
  await assert.rejects(bytes.save(declaration(data), source(data), access), {
    code: 'unavailable',
  });
  assert.deepEqual(m.counts(), { saves: 0, reads: 0 });
  await bytes.close();
});

test('team files: actual EOF length and SHA then complete readback precede byte receipt', async () => {
  const m = memory(),
    bytes = new TeamAssetFileBytes(m.attachments),
    access = grant();
  const data = Buffer.from('一份固定资料 A汉😀BC');
  const blob = await bytes.save(declaration(data), source(data), access);
  assert.deepEqual(blob, { ...declaration(data), attachmentId: `sha256:${hash(data)}` });
  assert.deepEqual(m.counts(), { saves: 1, reads: 1 });
  assert.deepEqual(Buffer.from(await bytes.read(blob, access)), data);
  data.fill(0);
  assert.notDeepEqual(
    Buffer.from(await bytes.read(blob, access)),
    data,
    'later source mutation cannot change stored bytes',
  );
  await bytes.close();
});

test('team files: invalid declarations/names cannot open provider; mismatch never produces a byte receipt', async () => {
  const m = memory(),
    bytes = new TeamAssetFileBytes(m.attachments),
    access = grant(),
    data = Buffer.from('abc');
  for (const patch of [
    { byteSize: -1 },
    { byteSize: 20 * 1024 * 1024 + 1 },
    { sha256: 'fake' },
    { name: '../file' },
  ])
    await assert.rejects(bytes.save(declaration(data, patch), source(data), access));
  assert.equal(m.counts().saves, 0);
  for (const patch of [{ byteSize: 2 }, { sha256: 'a'.repeat(64) }])
    await assert.rejects(bytes.save(declaration(data, patch), source(data), access), {
      code: 'digest-mismatch',
    });
  assert.equal(m.objects.size, 0);
  await bytes.close();
});

test('team files: fabricated provider success without EOF or with corrupt persisted bytes is refused', async () => {
  const data = Buffer.from('trusted'),
    declared = declaration(data);
  for (const consume of [false, true]) {
    let reads = 0;
    const bytes = new TeamAssetFileBytes({
      async saveFileStream(input) {
        if (consume)
          for await (const _chunk of input.data) {
            /* actual consumed EOF */
          }
        return {
          attachmentId: `sha256:${declared.sha256}`,
          name: declared.name,
          bytes: declared.byteSize,
        };
      },
      async *readFileStream() {
        reads++;
        yield Buffer.from('changed');
      },
    });
    await assert.rejects(bytes.save(declared, source(data), grant()), { code: 'unavailable' });
    assert.equal(reads, consume ? 1 : 0);
    await bytes.close();
  }
});

test('team files: missing/corrupt storage and revoked late reads release no partial content', async () => {
  const m = memory(),
    bytes = new TeamAssetFileBytes(m.attachments),
    access = grant(),
    data = Buffer.from('abcdef');
  const blob = await bytes.save(declaration(data), source(data), access);
  m.objects.set(blob.attachmentId, Buffer.from('abcdeg'));
  await assert.rejects(bytes.read(blob, access), { code: 'unavailable' });
  m.objects.delete(blob.attachmentId);
  await assert.rejects(bytes.read(blob, access), { code: 'unavailable' });
  const late = new TeamAssetFileBytes({
    async *readFileStream() {
      yield data.subarray(0, 2);
      access.revoke();
      yield data.subarray(2);
    },
  });
  await assert.rejects(
    late.read(blob, access),
    (error) => error.code === 'unavailable' && !error.message.includes('PRIVATE_'),
  );
  await bytes.close();
  await late.close();
});

test('team files: logical cancellation retains all eight provider slots and close until real settlement', async () => {
  const pending = [],
    entered = deferred(),
    data = Buffer.from('bytes');
  const bytes = new TeamAssetFileBytes({
    async saveFileStream() {
      const d = deferred();
      pending.push(d);
      if (pending.length === 8) entered.resolve();
      return d.promise;
    },
  });
  const accesses = Array.from({ length: 8 }, () => grant());
  const jobs = accesses.map((access) => bytes.save(declaration(data), source(data), access));
  await entered.promise;
  accesses.forEach((access) => access.abort());
  for (const job of jobs) await assert.rejects(job, { code: 'cancelled' });
  await assert.rejects(bytes.save(declaration(data), source(data), grant()), { code: 'limit' });
  let closed = false;
  const closing = bytes.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  pending.forEach((d) => d.resolve({ attachmentId: 'late', name: 'file', bytes: 0 }));
  await closing;
  assert.equal(closed, true);
});

test('team files: text slices preserve UTF8 byte offsets, reject split characters and nontext bodies', async () => {
  const m = memory(),
    bytes = new TeamAssetFileBytes(m.attachments),
    access = grant();
  const data = Buffer.from('A汉😀BC'),
    blob = await bytes.save(declaration(data), source(data), access);
  assert.deepEqual(await bytes.text(blob, { offset: 1, length: 4 }, access), {
    text: '汉',
    offset: 1,
    length: 3,
    nextOffset: 4,
    totalBytes: 10,
    checksum: hash(data),
  });
  assert.equal((await bytes.text(blob, { offset: 4, length: 4 }, access)).text, '😀');
  for (const query of [
    { offset: 2, length: 4 },
    { offset: 4, length: 1 },
    { offset: 11, length: 4 },
    { offset: 0, length: 8193 },
  ])
    await assert.rejects(bytes.text(blob, query, access), { code: 'invalid' });
  const binary = Buffer.from([0xff, 0xfe]),
    binaryBlob = await bytes.save(declaration(binary), source(binary), access);
  await assert.rejects(bytes.text(binaryBlob, { offset: 0, length: 8 }, access), {
    code: 'unsupported',
  });
  await bytes.close();
});

test('team files: real original attachment bytes reopen in a distinct OS process without task facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-team-file-'));
  const metadata = join(root, 'fixture-metadata.json');
  const child = new URL('./fixtures/team-asset-file-child.mjs', import.meta.url);
  try {
    const invoke = async (operation) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [child.pathname, operation, root, metadata],
        {
          timeout: 10_000,
          maxBuffer: 16_384,
        },
      );
      return JSON.parse(stdout);
    };
    const saved = await invoke('save'),
      reopened = await invoke('read');
    assert.equal(saved.phase, 'saved');
    assert.equal(reopened.phase, 'reopened');
    assert.equal(reopened.sha256, saved.sha256);
    assert.equal(reopened.bytes, saved.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('team files: replay verifies actual same-body EOF without another attachment write', async () => {
  const m = memory(),
    bytes = new TeamAssetFileBytes(m.attachments),
    access = grant(),
    data = Buffer.from('same');
  const operation = bytes.verifyReplay(declaration(data), source(data), access);
  assert.deepEqual(await operation.result, declaration(data));
  await operation.drain;
  const changed = bytes.verifyReplay(declaration(data), source(Buffer.from('else')), access);
  await assert.rejects(changed.result, { code: 'digest-mismatch' });
  await changed.drain;
  assert.deepEqual(m.counts(), { saves: 0, reads: 0 });
  await bytes.close();
});

test('team files: per-operation drain is independent of another held upload', async () => {
  const entered = [],
    data = Buffer.from('same');
  const bytes = new TeamAssetFileBytes({
    async saveFileStream() {
      const d = deferred();
      entered.push(d);
      return d.promise;
    },
  });
  const a = grant(),
    b = grant();
  const first = bytes.saveTracked(declaration(data), source(data), a);
  const second = bytes.saveTracked(declaration(data), source(data), b);
  a.abort();
  b.abort();
  await assert.rejects(first.result, { code: 'cancelled' });
  await assert.rejects(second.result, { code: 'cancelled' });
  let secondDrained = false;
  void second.drain.then(() => {
    secondDrained = true;
  });
  entered[0].resolve({ attachmentId: 'late', name: 'late', bytes: 0 });
  await first.drain;
  assert.equal(secondDrained, false);
  entered[1].resolve({ attachmentId: 'late', name: 'late', bytes: 0 });
  await second.drain;
  await bytes.close();
});
