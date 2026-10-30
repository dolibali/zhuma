/** Original attachment/read-slot lifecycle only; the asset authority is an
 * explicit contract, without a Run/HTTP/model or GUI acceptance claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { TeamAssetFileBytes } from '../dist/team-asset-file.js';
import { TeamAssetFileService } from '../dist/team-asset-file-service.js';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('file output drain: aborted handles retain original eight slots and authority leases until actual output termination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-output-drain-')),
    ctx = new Context(),
    output = deferred();
  const attachment = ctx.plugin(LocalAttachmentStore, { dshHome: root });
  await attachment;
  let service;
  t.after(async () => {
    output.resolve();
    await service?.close();
    await attachment.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = new TeamAssetFileBytes(ctx.attachments),
    data = Buffer.from('Fixed bytes');
  const blob = await bytes.save(
    {
      name: 'guide.txt',
      mediaType: 'text/plain',
      byteSize: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    },
    (async function* () {
      yield data;
    })(),
    { signal: new AbortController().signal, assertCurrent() {} },
  );
  let releases = 0;
  service = new TeamAssetFileService(bytes, {
    reserveFile() {
      throw Error('not an upload');
    },
    commitFile() {
      throw Error('no writes');
    },
    abortFile() {
      throw Error('no writes');
    },
    async readFile(_request, _input, signal) {
      return {
        blob,
        grant: {
          signal,
          assertCurrent() {
            signal.throwIfAborted();
          },
        },
        release() {
          releases++;
        },
      };
    },
  });
  const target = { spaceId: 'north', assetId: 'guide', versionId: randomUUID() },
    controllers = [];
  for (let i = 0; i < 8; i++) {
    const controller = new AbortController();
    controllers.push(controller);
    const operation = service.openReadTracked(
      { headers: {} },
      target,
      controller.signal,
      output.promise,
    );
    const handle = await operation.result;
    await operation.drain;
    assert.deepEqual(Buffer.from(handle.bytes), data);
  }
  for (const controller of controllers) controller.abort();
  await tick();
  assert.equal(releases, 0);
  await assert.rejects(service.openRead({ headers: {} }, target, new AbortController().signal), {
    code: 'limit',
  });
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(releases, 0);
  output.resolve();
  await closing;
  assert.equal(releases, 8);
  assert.equal(closed, true);
});
