import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assetHost } from './member-asset-host-fixture.mjs';
import { assets, rejects, digest } from './member-asset-fixture.mjs';
import { signal, deferred } from './member-workbench-fixture.mjs';

const tick = () => new Promise((done) => setImmediate(done));
const run = promisify(execFile);
const publishFile = async (h, data = Buffer.from('A汉😀BC')) => {
  const created = await h.create();
  const input = h.uploadInput(created.input.assetId, data);
  const receipt = await h.upload(input, data);
  await h.files.idle();
  const published = await h.publish(input, receipt);
  return {
    created,
    input,
    receipt,
    published,
    data,
    target: {
      spaceId: input.spaceId,
      assetId: input.assetId,
      versionId: published.reference.versionId,
    },
  };
};

test('member asset file: original member lease, JSON row and verified local attachment bytes compose without fake task facts', async (t) => {
  const h = await assetHost(t),
    p = await publishFile(h);
  const value = await h.files.read(h.requests.bob, p.target, signal());
  assert.deepEqual(Buffer.from(value.bytes), p.data);
  assert.deepEqual(value.file, p.input.declare);
  assert(!JSON.stringify(value).includes('attachmentId'));
  assert.equal(h.workbench.snapshot().tasks.length, 0);
  assert.equal(h.workbench.snapshot().projects.length, 0);
  assert.equal(h.workbench.snapshot().memberAssets[0].published.length, 1);
  const sliced = await h.files.text(h.requests.bob, p.target, { offset: 1, length: 4 }, signal());
  assert.equal(sliced.text, '汉');
  await h.files.idle();
  const before = h.workbench.snapshot().revision;
  assert.deepEqual(await h.upload(p.input, p.data), p.receipt);
  await h.files.idle();
  assert.equal(h.workbench.snapshot().revision, before);
  await assert.rejects(h.upload(p.input, Buffer.from('X汉😀BC')), { code: 'digest-mismatch' });
  await h.files.idle();
  await assert.rejects(
    h.files.read(h.requests.dana, p.target, signal()),
    rejects('asset-forbidden'),
  );
  await assert.rejects(
    h.files.read(h.requests.ann, { ...p.target, spaceId: 'south' }, signal()),
    rejects('asset-forbidden'),
  );
  await assert.rejects(
    h.files.read(h.requests.ann, { ...p.target, versionId: randomUUID() }, signal()),
    rejects('asset-not-found'),
  );
  await assert.rejects(
    h.files.read(h.requests.ann, { ...p.target, actorId: 'bob' }, signal()),
    rejects('asset-invalid'),
  );
});

test('member asset file: original-cookie revocation fences a live response and all later metadata/byte reads', async (t) => {
  const h = await assetHost(t),
    p = await publishFile(h);
  const handle = await h.files.openRead(h.requests.bob, p.target, signal());
  handle.check();
  await h.revoke('north', 'bob');
  assert.throws(() => handle.check());
  await h.files.idle();
  await assert.rejects(
    h.files.read(h.requests.bob, p.target, signal()),
    rejects('asset-forbidden'),
  );
  assert.deepEqual(
    Buffer.from((await h.files.read(h.requests.ann, p.target, signal())).bytes),
    p.data,
  );
});

test('member asset file: restart of the original JSON and attachment owners preserves published bytes and committed replay', async (t) => {
  const h = await assetHost(t),
    p = await publishFile(h);
  const before = h.workbench.snapshot();
  await h.close();
  const cold = await assetHost(t, { root: h.root });
  assert.deepEqual(cold.workbench.snapshot().memberAssets, before.memberAssets);
  assert.deepEqual(
    Buffer.from((await cold.files.read(cold.requests.bob, p.target, signal())).bytes),
    p.data,
  );
  assert.deepEqual(await cold.upload(p.input, p.data), p.receipt);
  await cold.files.idle();
  assert.equal(cold.workbench.snapshot().revision, before.revision);
});

test('member asset file: a new OS process reopens the original durable receipt, fixed publication and attachment bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-asset-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locator = join(root, 'fixture-locator.json');
  const fixture = new URL('./member-asset-process.mjs', import.meta.url);
  await run(process.execPath, [fixture.pathname, 'seed', root, locator], { timeout: 20000 });
  const result = await run(process.execPath, [fixture.pathname, 'recover', root, locator], {
    timeout: 20000,
  });
  const value = JSON.parse(result.stdout);
  assert.equal(value.bytesVerified, true);
  assert.equal(value.replayedWithoutWrite, true);
  assert.match(value.fixedVersion, /^[a-f0-9-]{36}$/u);
});

test('member asset file: short or wrong-digest streams cannot commit, and same pending key can retry actual bytes', async (t) => {
  const h = await assetHost(t),
    created = await h.create(),
    data = Buffer.from('complete');
  const input = h.uploadInput(created.input.assetId, data);
  await assert.rejects(h.upload(input, data.subarray(0, 3)));
  await h.files.idle();
  assert.equal(h.workbench.snapshot().memberAssets[0].draft.blob, undefined);
  assert.equal(h.workbench.snapshot().memberAssets[0].uploads[0].state, 'pending');
  await assert.rejects(
    h.upload({ ...input, declare: { ...input.declare, name: 'changed.txt' } }, data),
    rejects('asset-request-reused'),
  );
  const receipt = await h.upload(input, data);
  await h.files.idle();
  assert.equal(receipt.assetVersion, 3);
  assert.equal(h.workbench.snapshot().memberAssets[0].uploads.length, 1);
});

test('member asset file: logical cancel retains the original upload occupancy until ignored-abort provider really drains', async (t) => {
  const entered = deferred(),
    pending = deferred();
  let enteredOnce = false;
  const h = await assetHost(t, {
    attachments: (original) => ({
      saveFileStream: async (input) => {
        if (!enteredOnce) {
          enteredOnce = true;
          entered.resolve();
          await pending.promise;
        }
        return original.saveFileStream(input);
      },
      readFileStream: (ref) => original.readFileStream(ref),
    }),
  });
  const created = await h.create(),
    data = Buffer.from('slow'),
    input = h.uploadInput(created.input.assetId, data);
  const uploading = h.upload(input, data);
  await entered.promise;
  const cancelled = await h.command({
    operation: 'cancel-upload',
    spaceId: 'north',
    assetId: input.assetId,
    expectedVersion: 2,
    idempotencyKey: randomUUID(),
    uploadKey: input.idempotencyKey,
  });
  await assert.rejects(uploading);
  await assert.rejects(
    h.upload(
      { ...input, idempotencyKey: randomUUID(), expectedVersion: cancelled.asset.version },
      data,
    ),
    rejects('asset-upload-pending'),
  );
  let closed = false;
  const closing = h.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  pending.resolve();
  await closing;
  const cold = await assetHost(t, { root: h.root });
  await assert.rejects(cold.upload(input, data), rejects('asset-cancelled'));
  const retry = await cold.upload(
    { ...input, idempotencyKey: randomUUID(), expectedVersion: cancelled.asset.version },
    data,
  );
  assert.equal(retry.assetVersion, 5);
});

test('member asset file: unpublished bytes do not grant fixed reads; old accepted publication remains after a new upload', async (t) => {
  const h = await assetHost(t),
    p = await publishFile(h),
    later = Buffer.from('later bytes');
  const nextInput = h.uploadInput(p.input.assetId, later, {
    expectedVersion: p.published.asset.version,
  });
  const receipt = await h.upload(nextInput, later);
  await h.files.idle();
  assert.deepEqual(
    Buffer.from((await h.files.read(h.requests.bob, p.target, signal())).bytes),
    p.data,
  );
  const newer = await h.publish(nextInput, receipt);
  const newTarget = { ...p.target, versionId: newer.reference.versionId };
  assert.deepEqual(
    Buffer.from((await h.files.read(h.requests.bob, newTarget, signal())).bytes),
    later,
  );
  assert.deepEqual(
    Buffer.from((await h.files.read(h.requests.bob, p.target, signal())).bytes),
    p.data,
  );
});

test('member asset file contracts: ticket identity, declared bytes and row CAS are checked again at original commit', async (t) => {
  const h = assets(t),
    created = await h.create(),
    data = Buffer.from('bytes');
  const input = h.uploadInput(created.input.assetId, data),
    reserved = await h.reserve(input);
  const blob = { ...input.declare, attachmentId: `sha256:${digest(data)}` };
  await assert.rejects(
    h.owner.commitFile({ ...reserved.ticket }, blob),
    rejects('asset-forbidden'),
  );
  await assert.rejects(
    h.owner.commitFile(reserved.ticket, { ...blob, attachmentId: 'unverified-handle' }),
    rejects('asset-file-invalid'),
  );
  await assert.rejects(
    h.owner.commitFile(reserved.ticket, { ...blob, sha256: 'a'.repeat(64) }),
    rejects('asset-file-invalid'),
  );
  await h.command({
    operation: 'update-draft',
    spaceId: 'north',
    assetId: input.assetId,
    expectedVersion: 2,
    idempotencyKey: randomUUID(),
    definition: created.input.definition,
    dependencies: [],
  });
  assert.throws(() => reserved.grant.assertCurrent());
  await assert.rejects(h.owner.commitFile(reserved.ticket, blob));
  assert.equal(h.f.storage.read().memberAssets[0].draft.blob, undefined);
});

test('member asset file: a failed original metadata write after real byte verification retains only pending state, then exact retry commits once', async (t) => {
  let failCommit = false,
    savedOnce = false,
    latestAttachment;
  const h = await assetHost(t, {
    beforeWrite: async (next) => {
      if (
        failCommit &&
        next.memberAssets?.some((item) => item.uploads.some((u) => u.state === 'committed'))
      )
        throw Error('PRIVATE-DISK-FAILURE');
    },
    attachments: (original) => ({
      saveFileStream: async (input) => {
        latestAttachment = await original.saveFileStream(input);
        if (!savedOnce) {
          savedOnce = true;
          failCommit = true;
        }
        return latestAttachment;
      },
      readFileStream: (ref) => original.readFileStream(ref),
    }),
  });
  const created = await h.create(),
    data = Buffer.from('verified then metadata failure'),
    input = h.uploadInput(created.input.assetId, data);
  await assert.rejects(
    h.upload(input, data),
    (error) => error.code === 'asset-unavailable' && !error.message.includes('PRIVATE'),
  );
  await h.files.idle();
  const pending = h.workbench.snapshot().memberAssets[0];
  assert.equal(pending.uploads[0].state, 'pending');
  assert.equal(pending.draft.blob, undefined);
  const retained = [];
  for await (const part of h.ctx.attachments.readFileStream(latestAttachment))
    retained.push(Buffer.from(part));
  assert.deepEqual(Buffer.concat(retained), data);
  failCommit = false;
  const receipt = await h.upload(input, data);
  await h.files.idle();
  assert.equal(receipt.assetVersion, 3);
  assert.equal(h.workbench.snapshot().memberAssets[0].uploads.length, 1);
});

test('member asset file contracts: close joins a pending original lease opening and prevents late reservation writes', async (t) => {
  const gate = deferred();
  let block = false;
  const h = assets(t, { beforeLease: () => (block ? gate.promise : undefined) }),
    created = await h.create();
  block = true;
  const reserving = h.reserve(h.uploadInput(created.input.assetId, Buffer.from('late')));
  let closed = false;
  const closing = h.owner.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  gate.resolve();
  await assert.rejects(reserving, rejects('asset-cancelled'));
  await closing;
  assert.equal(h.f.storage.read().memberAssets[0].uploads.length, 0);
  assert.equal(h.leases.issued, h.leases.released);
});

test('member asset file contracts: authentication openings are bounded and upload quota is checked only after original authorization', async (t) => {
  const gate = deferred();
  let block = false;
  const h = assets(t, { beforeLease: () => (block ? gate.promise : undefined) });
  const created = await Promise.all(Array.from({ length: 9 }, () => h.create()));
  block = true;
  const pending = created
    .slice(0, 8)
    .map(({ input }) => h.reserve(h.uploadInput(input.assetId, Buffer.from('x'))));
  await assert.rejects(
    h.reserve(h.uploadInput(created[8].input.assetId, Buffer.from('x'))),
    rejects('asset-unavailable'),
  );
  gate.resolve();
  const tickets = await Promise.all(pending);
  await assert.rejects(
    h.reserve(h.uploadInput(created[8].input.assetId, Buffer.from('x'))),
    rejects('asset-quota'),
  );
  await assert.rejects(
    h.reserve(h.uploadInput(created[8].input.assetId, Buffer.from('x')), 'dana'),
    rejects('asset-forbidden'),
  );
  await assert.rejects(
    h.reserve(h.uploadInput(created[8].input.assetId, Buffer.from('x')), 'bob'),
    rejects('asset-forbidden'),
  );
  await h.owner.abortFile(tickets[0].ticket);
  await h.reserve(h.uploadInput(created[8].input.assetId, Buffer.from('x')));
  assert.equal(h.f.storage.read().memberAssets.filter((r) => r.uploads.length).length, 9);
});

test('member asset file: original authorization precedes per-object occupancy errors and rejected probes cannot release another upload', async (t) => {
  const h = await assetHost(t),
    created = await h.create(),
    input = h.uploadInput(created.input.assetId, Buffer.from('owned'));
  const attempt = (actor) => h.owner.reserveFile(h.requests[actor], input, signal());
  const before = h.workbench.snapshot();
  for (const actor of ['bob', 'dana'])
    await assert.rejects(attempt(actor), rejects('asset-forbidden'));
  assert.deepEqual(h.workbench.snapshot(), before);
  const reserved = await attempt('ann');
  try {
    const occupied = h.workbench.snapshot();
    for (const actor of ['bob', 'dana'])
      await assert.rejects(attempt(actor), rejects('asset-forbidden'));
    assert.deepEqual(h.workbench.snapshot(), occupied);
    await assert.rejects(attempt('ann'), rejects('asset-upload-pending'));
    reserved.grant.assertCurrent();
  } finally {
    await h.owner.abortFile(reserved.ticket);
  }
  const retry = await attempt('ann');
  await h.owner.abortFile(retry.ticket);
});
