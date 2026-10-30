import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { TeamAssetFileBytes } from '../dist/team-asset-file.js';
import { TeamAssetFileService } from '../dist/team-asset-file-service.js';

// Composition contracts only. D's member/asset ACL, JSON queue/CAS and lifecycle
// are tested by D's original service; this suite never substitutes a new store.
const hash = (data) => createHash('sha256').update(data).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const source = (data) =>
  (async function* () {
    yield data;
  })();
function fixture(options = {}) {
  const events = [],
    objects = new Map(),
    data = Buffer.from('A汉😀BC');
  const input = {
    spaceId: 'north',
    assetId: 'guide',
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    declare: {
      name: 'guide.txt',
      mediaType: 'text/plain',
      byteSize: data.length,
      sha256: hash(data),
    },
  };
  const request = { headers: {} },
    ticket = { kind: 'member-asset-file-ticket' };
  let blob,
    receipt,
    replayed = false,
    denied = false,
    commitFails = false;
  const grant = {
    signal: new AbortController().signal,
    assertCurrent() {
      if (denied) throw Error('revoked');
    },
  };
  const authority = {
    async reserveFile(actual, body) {
      events.push('reserve');
      assert.equal(actual, request);
      assert.deepEqual(body, input);
      if (denied) throw Error('denied');
      if (options.reserve) return options.reserve({ ticket, grant, receipt });
      return replayed
        ? { kind: 'replayed', receipt, ticket, grant }
        : { kind: 'reserved', ticket, grant };
    },
    async commitFile(actual, value) {
      events.push('commit');
      assert.equal(actual, ticket);
      assert.equal(
        events.includes('verify-read'),
        true,
        'byte readback precedes the business commit',
      );
      if (denied || commitFails) throw Error('commit refused');
      blob = structuredClone(value);
      receipt = {
        spaceId: input.spaceId,
        assetId: input.assetId,
        idempotencyKey: input.idempotencyKey,
        assetVersion: 3,
        file: input.declare,
      };
      replayed = true;
      return structuredClone(receipt);
    },
    async abortFile(actual) {
      assert.equal(actual, ticket);
      events.push('release-upload');
    },
    async readFile(actual, target) {
      assert.equal(actual, request);
      assert.deepEqual(target, {
        spaceId: input.spaceId,
        assetId: input.assetId,
        versionId: 'fixed-version',
      });
      if (denied) throw Error('denied');
      events.push('authorize-read');
      return {
        blob: structuredClone(blob),
        grant,
        release() {
          events.push('release-read');
        },
      };
    },
  };
  const attachments = {
    async saveFileStream(actual) {
      events.push('save');
      if (options.save) return options.save(actual);
      const chunks = [];
      for await (const chunk of actual.data) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks),
        attachmentId = `sha256:${hash(bytes)}`;
      objects.set(attachmentId, bytes);
      return { attachmentId, name: actual.name, bytes: bytes.length };
    },
    async *readFileStream(ref) {
      events.push('verify-read');
      if (options.read) {
        yield* options.read(ref, objects);
        return;
      }
      yield objects.get(ref.attachmentId);
    },
  };
  const carrier = new TeamAssetFileBytes(attachments),
    service = new TeamAssetFileService(carrier, authority);
  const upload = (bytes = data, signal = new AbortController().signal) =>
    service.upload(request, input, source(bytes), signal);
  return {
    service,
    carrier,
    authority,
    input,
    request,
    data,
    events,
    objects,
    upload,
    deny() {
      denied = true;
    },
    failCommit(value) {
      commitFails = value;
    },
  };
}

test('team file composition: authorization -> actual verified bytes -> original commit -> release', async () => {
  const h = fixture();
  const result = await h.upload();
  await h.service.idle();
  assert.deepEqual(h.events, ['reserve', 'save', 'verify-read', 'commit', 'release-upload']);
  assert.equal(result.assetVersion, 3);
  assert.equal('attachmentId' in result.file, false);
  const target = { spaceId: h.input.spaceId, assetId: h.input.assetId, versionId: 'fixed-version' };
  const read = await h.service.read(h.request, target, new AbortController().signal);
  assert.deepEqual(Buffer.from(read.bytes), h.data);
  assert.equal('attachmentId' in read.file, false);
  const part = await h.service.text(
    h.request,
    target,
    { offset: 1, length: 4 },
    new AbortController().signal,
  );
  assert.equal(part.text, '汉');
  await h.service.idle();
  assert.equal(h.events.filter((event) => event === 'release-read').length, 2);
  await h.service.close();
});

test('team file composition: denied reservation never consumes source or opens attachments', async () => {
  const h = fixture();
  h.deny();
  await assert.rejects(h.upload(), /denied/u);
  assert.deepEqual(h.events, ['reserve']);
  await h.service.close();
});

test('team file composition: replay validates actual incoming bytes and creates no new business or attachment fact', async () => {
  const h = fixture(),
    first = await h.upload();
  await h.service.idle();
  assert.deepEqual(await h.upload(), first);
  await h.service.idle();
  await assert.rejects(h.upload(Buffer.from('X汉😀BC')), { code: 'digest-mismatch' });
  await h.service.idle();
  assert.equal(h.events.filter((event) => event === 'save').length, 1);
  assert.equal(h.events.filter((event) => event === 'commit').length, 1);
  assert.equal(h.events.filter((event) => event === 'release-upload').length, 3);
  await h.service.close();
});

test('team file composition: successful bytes plus failed metadata commit never become upload success; retry reuses content-addressed bytes', async () => {
  const h = fixture();
  h.failCommit(true);
  await assert.rejects(h.upload(), /commit refused/u);
  await h.service.idle();
  assert.equal(
    h.objects.size,
    1,
    'unreferenced bytes remain with original provider; no destructive cleanup',
  );
  h.failCommit(false);
  const result = await h.upload();
  await h.service.idle();
  assert.equal(result.assetVersion, 3);
  assert.equal(h.objects.size, 1);
  await h.service.close();
});

test('team file composition: cancellation returns before provider settlement but keeps D occupancy until its actual drain', async () => {
  const pending = deferred(),
    entered = deferred(),
    abort = new AbortController();
  const h = fixture({
    save() {
      entered.resolve();
      return pending.promise;
    },
  });
  const upload = h.upload(h.data, abort.signal);
  await entered.promise;
  abort.abort();
  await assert.rejects(upload, { code: 'cancelled' });
  assert.equal(h.events.includes('release-upload'), false);
  let idle = false;
  const waiting = h.service.idle().then(() => {
    idle = true;
  });
  await tick();
  assert.equal(idle, false);
  pending.resolve({ attachmentId: 'late', name: 'late', bytes: 0 });
  await waiting;
  assert.equal(h.events.includes('release-upload'), true);
  assert.equal(h.events.includes('commit'), false);
  await h.service.close();
});

test('team file composition: close joins late reserve without opening bytes or losing the returned ticket', async () => {
  const pending = deferred(),
    entered = deferred();
  let reservation;
  const h = fixture({
    reserve(value) {
      reservation = value;
      entered.resolve();
      return pending.promise;
    },
  });
  const uploading = h.upload();
  await entered.promise;
  let closed = false;
  const closing = h.service.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  pending.resolve({ kind: 'reserved', ...reservation });
  await assert.rejects(uploading, { code: 'cancelled' });
  await closing;
  assert.deepEqual(h.events, ['reserve', 'release-upload']);
});

test('team file composition: a release failure is reported by close instead of claiming cleanup success', async () => {
  const h = fixture();
  h.authority.abortFile = async () => {
    throw Error('PRIVATE_RELEASE_DETAIL');
  };
  await h.upload();
  await assert.rejects(
    h.service.close(),
    (error) => error.code === 'unavailable' && !error.message.includes('PRIVATE_'),
  );
});

test('team file response handle: original lease stays live until explicit output release, and revocation fences later chunks', async () => {
  const h = fixture();
  await h.upload();
  await h.service.idle();
  const target = { spaceId: h.input.spaceId, assetId: h.input.assetId, versionId: 'fixed-version' };
  const handle = await h.service.openRead(h.request, target, new AbortController().signal);
  assert.deepEqual(Buffer.from(handle.bytes), h.data);
  assert.equal(h.events.includes('release-read'), false);
  let idle = false;
  const waiting = h.service.idle().then(() => {
    idle = true;
  });
  await tick();
  assert.equal(idle, false);
  handle.check();
  h.deny();
  assert.throws(() => handle.check(), /revoked/u);
  handle.release();
  handle.release();
  await waiting;
  assert.equal(h.events.filter((event) => event === 'release-read').length, 1);
  await h.service.close();
});

test('team file response handle: eight held outputs bound memory/lease occupancy until real release', async () => {
  const h = fixture();
  await h.upload();
  await h.service.idle();
  const target = { spaceId: h.input.spaceId, assetId: h.input.assetId, versionId: 'fixed-version' };
  const open = () => h.service.openRead(h.request, target, new AbortController().signal);
  const handles = await Promise.all(Array.from({ length: 8 }, open));
  await assert.rejects(open(), { code: 'limit' });
  assert.equal(h.events.filter((event) => event === 'authorize-read').length, 8);
  handles[0].release();
  await tick();
  handles.push(await open());
  await h.service.close();
  for (const handle of handles) assert.throws(() => handle.check(), { code: 'cancelled' });
  assert.equal(h.events.filter((event) => event === 'release-read').length, 9);
});

test('team file response handle: close joins a late ignored-abort read grant and releases without opening bytes', async () => {
  const h = fixture(),
    pending = deferred(),
    entered = deferred();
  h.authority.readFile = async () => {
    entered.resolve();
    return pending.promise;
  };
  const opening = h.service.openRead(
    h.request,
    { spaceId: 'north', assetId: 'guide', versionId: 'fixed-version' },
    new AbortController().signal,
  );
  await entered.promise;
  let closed = false;
  const closing = h.service.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  let released = 0;
  pending.resolve({
    blob: {},
    grant: { signal: new AbortController().signal, assertCurrent() {} },
    release() {
      released++;
    },
  });
  await assert.rejects(opening, { code: 'cancelled' });
  await closing;
  assert.equal(released, 1);
  assert.deepEqual(h.events, []);
});

test('team file tracked read: physical drain completes independently of the still-live output lease', async () => {
  const h = fixture();
  await h.upload();
  await h.service.idle();
  const op = h.service.openReadTracked(
    h.request,
    { spaceId: 'north', assetId: 'guide', versionId: 'fixed-version' },
    new AbortController().signal,
  );
  const handle = await op.result;
  await op.drain;
  handle.check();
  assert.equal(h.events.includes('release-read'), false);
  handle.release();
  await h.service.close();
});

test('team file tracked read: cancellation cannot complete the physical drain while the original iterator is still pending', async () => {
  const pending = deferred(),
    entered = deferred();
  let blocked = false;
  const h = fixture({
    read: async function* (ref, objects) {
      if (blocked) {
        entered.resolve();
        await pending.promise;
      }
      yield objects.get(ref.attachmentId);
    },
  });
  await h.upload();
  await h.service.idle();
  blocked = true;
  const controller = new AbortController();
  const op = h.service.openReadTracked(
    h.request,
    { spaceId: 'north', assetId: 'guide', versionId: 'fixed-version' },
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  await assert.rejects(op.result, { code: 'cancelled' });
  let drained = false;
  const draining = op.drain.then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  assert.equal(h.events.includes('release-read'), false);
  pending.resolve();
  await draining;
  await h.service.close();
  assert.equal(h.events.filter((event) => event === 'release-read').length, 1);
});

test('team file tracked read: a refused original authorization has a settled no-byte drain', async () => {
  const h = fixture();
  h.deny();
  const op = h.service.openReadTracked(
    h.request,
    { spaceId: 'north', assetId: 'guide', versionId: 'fixed-version' },
    new AbortController().signal,
  );
  await assert.rejects(op.result);
  await op.drain;
  await h.service.close();
  assert.deepEqual(h.events, []);
});
