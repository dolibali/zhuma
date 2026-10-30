/** Original queue/DSH JSON/member lease/attachments. Accounts and admission are
 * contracts. User folders are facts, not OS paths; no GUI or Agent model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assetHost } from './member-asset-host-fixture.mjs';
import { fixedFilesHost } from './member-fixed-files-fixture.mjs';
import { assets } from './member-asset-fixture.mjs';
import { signal, deferred, projectCommand, taskInput } from './member-workbench-fixture.mjs';

const folder = (patch = {}) => ({
  spaceId: 'north',
  folderId: randomUUID(),
  parentFolderId: null,
  name: '资料',
  expectedVersion: 0,
  idempotencyKey: randomUUID(),
  ...patch,
});
const createFolder = (h, input = folder(), actor = 'ann', active = signal()) =>
  h.owner.createFolder(h.requests[actor], input, active);
const list = (h, folderId = null, actor = 'ann', patch = {}) =>
  h.owner.listFolder(
    h.requests[actor],
    { spaceId: 'north', folderId, includeDrafts: true, ...patch },
    signal(),
  );
const move = (h, asset, folderId, patch = {}) => ({
  operation: 'move-file',
  spaceId: 'north',
  assetId: asset.assetId,
  expectedVersion: asset.version,
  idempotencyKey: randomUUID(),
  folderId,
  ...patch,
});

test('folders: actual root/subdirectory, selected upload and move keep original published bytes, plan and reference-only snapshot unchanged across a new process', async (t) => {
  const h = await fixedFilesHost(t),
    root = folder(),
    child = folder({ parentFolderId: root.folderId, name: '接口' });
  await createFolder(h, root);
  await createFolder(h, child);
  assert.deepEqual(
    (await list(h, child.folderId)).path.map((row) => row.name),
    ['资料', '接口'],
  );
  const created = await h.create({ folderId: child.folderId }),
    data = Buffer.from('original fixed bytes 汉😀');
  const upload = h.uploadInput(created.input.assetId, data),
    receipt = await h.upload(upload, data);
  await h.files.idle();
  const published = await h.publish(upload, receipt);
  await h.command({ type: 'create-project', project: projectCommand().project });
  await h.command({ type: 'create-task', task: taskInput({ fileRefs: [published.reference] }) });
  await h.command({ type: 'confirm-task', taskId: 'task-one' });
  const before = h.workbench.snapshot(),
    fixed = await h.owner.fileSnapshot(
      h.requests.ann,
      { spaceId: 'north', references: [published.reference] },
      signal(),
    );
  const held = await h.files.openRead(
    h.requests.ann,
    {
      spaceId: 'north',
      assetId: published.asset.assetId,
      versionId: published.reference.versionId,
    },
    signal(),
  );
  const input = move(h, published.asset, null);
  held.check();
  const moved = await h.owner.command(h.requests.ann, input, signal());
  assert.equal(moved.asset.folderId, null);
  // Preserve the original whole-row live-read fence. A fresh read of this
  // same fixed publication still returns the exact bytes after organization.
  assert.throws(() => held.check(), { code: 'asset-conflict' });
  held.release();
  const fresh = await h.files.read(
    h.requests.ann,
    {
      spaceId: 'north',
      assetId: published.asset.assetId,
      versionId: published.reference.versionId,
    },
    signal(),
  );
  assert.deepEqual(Buffer.from(fresh.bytes), data);
  assert.deepEqual(h.workbench.snapshot().appliedPlans, before.appliedPlans);
  assert.deepEqual(
    h.workbench.snapshot().memberAssets[0].published,
    before.memberAssets[0].published,
  );
  assert.deepEqual(
    await h.owner.fileSnapshot(
      h.requests.ann,
      { spaceId: 'north', references: [published.reference] },
      signal(),
    ),
    fixed,
  );
  assert.equal((await list(h, child.folderId)).files.length, 0);
  assert.equal((await list(h)).files[0].assetId, published.asset.assetId);
  assert.equal(
    (await h.owner.list(h.requests.ann, { spaceId: 'north' }, signal())).items.length,
    1,
  );
  const visible = await h.member().snapshot({ spaceId: 'north' });
  assert.equal(Object.hasOwn(visible.state, 'memberAssetFolders'), false);
  const locator = join(h.root, 'folder-recovery.json');
  await writeFile(
    locator,
    JSON.stringify({
      create: root,
      move: input,
      reference: published.reference,
      text: data.toString(),
      revision: h.workbench.snapshot().revision,
    }),
  );
  await h.close();
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [new URL('./member-asset-folders-process.mjs', import.meta.url).pathname, h.root, locator],
    { timeout: 15000, env: { PATH: process.env.PATH } },
  );
  assert.deepEqual(JSON.parse(stdout), {
    recovered: true,
    originalBytes: true,
    noExtraWrite: true,
  });
});

test('folders: original draft privacy and maintainer rights survive organization; an old omitted create replay never moves a file back', async (t) => {
  const h = await assetHost(t),
    place = folder();
  await createFolder(h, place);
  const { input, result } = await h.create({
    definition: { kind: 'file', name: 'PRIVATE-DRAFT', description: 'PRIVATE-BODY' },
  });
  const movement = move(h, result.asset, place.folderId);
  await assert.rejects(h.owner.command(h.requests.bob, movement, signal()), {
    code: 'asset-forbidden',
  });
  await h.owner.command(h.requests.ann, movement, signal());
  assert.deepEqual((await list(h, place.folderId, 'bob')).files, []);
  assert(!JSON.stringify(await list(h, place.folderId, 'bob')).includes('PRIVATE-'));
  assert.equal((await list(h, place.folderId)).files[0].name, 'PRIVATE-DRAFT');
  const before = h.workbench.snapshot();
  assert.equal((await h.owner.command(h.requests.ann, input, signal())).disposition, 'replayed');
  assert.deepEqual(h.workbench.snapshot(), before);
  await assert.rejects(h.owner.command(h.requests.ann, { ...input, folderId: null }, signal()), {
    code: 'asset-request-reused',
  });
  assert.equal(
    (await h.owner.list(h.requests.ann, { spaceId: 'north', includeDrafts: true }, signal())).items
      .length,
    1,
  );
});

test('folders: scope/owner precede parent lookup, and foreign/missing/self parent, duplicate sibling/key and stale file versions never write', async (t) => {
  const h = await assetHost(t),
    input = folder();
  await createFolder(h, input);
  const before = h.workbench.snapshot();
  await assert.rejects(createFolder(h, folder({ parentFolderId: input.folderId }), 'dana'), {
    code: 'asset-forbidden',
  });
  for (const change of [
    folder({ parentFolderId: randomUUID() }),
    folder({ spaceId: 'south', parentFolderId: input.folderId }),
  ])
    await assert.rejects(createFolder(h, change));
  const self = folder();
  await assert.rejects(createFolder(h, { ...self, parentFolderId: self.folderId }), {
    code: 'asset-invalid',
  });
  await assert.rejects(createFolder(h, folder({ name: '资料' })), { code: 'asset-conflict' });
  await assert.rejects(createFolder(h, { ...input, name: 'changed' }), {
    code: 'asset-request-reused',
  });
  assert.deepEqual(h.workbench.snapshot(), before);
  assert.equal((await createFolder(h, input)).disposition, 'replayed');
  await assert.rejects(
    h.owner.listFolder(h.requests.ann, { spaceId: 'north', folderId: randomUUID() }, signal()),
    { code: 'asset-not-found' },
  );
  const created = await h.create();
  const unchanged = h.workbench.snapshot();
  await assert.rejects(h.create({ folderId: randomUUID() }), { code: 'asset-not-found' });
  await assert.rejects(
    h.owner.command(h.requests.ann, move(h, created.result.asset, randomUUID()), signal()),
    { code: 'asset-not-found' },
  );
  assert.deepEqual(h.workbench.snapshot(), unchanged);
  await assert.rejects(
    h.owner.command(
      h.requests.ann,
      move(h, created.result.asset, input.folderId, { expectedVersion: 99 }),
      signal(),
    ),
    { code: 'asset-conflict' },
  );
  await h.personalOwners.set('personal-ann', 'bob');
  await assert.rejects(createFolder(h, folder({ spaceId: 'personal-ann' })), {
    code: 'asset-forbidden',
  });
});

test('folders: parent depth and global capacity are bounded without changing legacy callback or initializing asset rows', async (t) => {
  const h = assets(t);
  let parent = null;
  for (let index = 0; index < 12; index++) {
    const input = folder({ parentFolderId: parent, name: String(index) });
    await createFolder(h, input);
    parent = input.folderId;
  }
  await assert.rejects(createFolder(h, folder({ parentFolderId: parent })), {
    code: 'asset-quota',
  });
  for (let index = 12; index < 200; index++) await createFolder(h, folder({ name: String(index) }));
  await assert.rejects(createFolder(h, folder({ name: 'over quota' })), { code: 'asset-quota' });
  assert.equal(h.f.workbench.snapshot().memberAssets, undefined);
  const old = await h.create('skill');
  assert.equal(old.result.asset.kind, 'skill');
  assert.equal(h.f.workbench.snapshot().memberAssetFolders.length, 200);
});

test('folders: concurrent create and actual committed-but-lost ACK replay only one directory', async (t) => {
  let fail = true;
  const h = await assetHost(t, {
    afterWrite: async (next) => {
      if (fail && next.memberAssetFolders?.length) {
        fail = false;
        throw Error('CONTRACT_ACK');
      }
    },
  });
  const input = folder();
  await assert.rejects(createFolder(h, input), { code: 'asset-unavailable' });
  const before = h.workbench.snapshot();
  const results = await Promise.all([createFolder(h, input), createFolder(h, input)]);
  assert(results.every((value) => value.disposition === 'replayed'));
  assert.deepEqual(h.workbench.snapshot(), before);
});

test('folders: late queued cancellation and revocation refuse writes; close joins an unabortable physical commit and its original receipt resolves actual result', async (t) => {
  const h = await assetHost(t),
    entered = deferred(),
    release = deferred();
  const blocker = h.workbench.memberAssetCommand(
    signal(),
    () => {},
    async () => {
      entered.resolve();
      await release.promise;
      return { value: true };
    },
  );
  await entered.promise;
  const abort = new AbortController(),
    input = folder();
  const pending = createFolder(h, input, 'ann', abort.signal);
  pending.catch(() => {});
  abort.abort();
  release.resolve();
  await blocker;
  await assert.rejects(pending);
  assert.equal(h.workbench.snapshot().memberAssetFolders, undefined);
  const queued = deferred(),
    wait = deferred();
  const heldQueue = h.workbench.memberAssetCommand(
    signal(),
    () => {},
    async () => {
      await wait.promise;
      return { value: true };
    },
  );
  const original = h.workbench.memberAssetCommand.bind(h.workbench);
  h.workbench.memberAssetCommand = (...args) => {
    queued.resolve();
    return original(...args);
  };
  const revoked = createFolder(h, input);
  revoked.catch(() => {});
  await queued.promise;
  await h.revoke('north', 'ann');
  wait.resolve();
  await heldQueue;
  await assert.rejects(revoked);
  assert.equal(h.workbench.snapshot().memberAssetFolders, undefined);
  const writing = deferred(),
    drain = deferred();
  const k = await assetHost(t, {
    beforeWrite: async () => {
      writing.resolve();
      await drain.promise;
    },
  });
  const create = folder();
  const operation = createFolder(k, create);
  operation.catch(() => {});
  await writing.promise;
  let closed = false;
  const closing = k.close().then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  drain.resolve();
  await assert.rejects(operation);
  await closing;
  const cold = await assetHost(t, { root: k.root });
  assert.equal((await createFolder(cold, create)).disposition, 'replayed');
  assert.equal(cold.workbench.snapshot().memberAssetFolders.length, 1);
});

test('folders: file movement rejects until actual upload drain, including after logical cancellation', async (t) => {
  const h = assets(t),
    place = folder();
  await createFolder(h, place);
  const created = await h.create(),
    data = Buffer.from('pending'),
    input = h.uploadInput(created.input.assetId, data);
  const reservation = await h.reserve(input);
  const reservedVersion = h.f.workbench
    .memberAssetRecords()
    .find((row) => row.assetId === input.assetId).version;
  await assert.rejects(
    h.command(move(h, { ...created.result.asset, version: reservedVersion }, place.folderId)),
    { code: 'asset-upload-pending' },
  );
  const cancelled = await h.command({
    operation: 'cancel-upload',
    spaceId: 'north',
    assetId: input.assetId,
    expectedVersion: reservedVersion,
    idempotencyKey: randomUUID(),
    uploadKey: input.idempotencyKey,
  });
  await assert.rejects(h.command(move(h, cancelled.asset, place.folderId)), {
    code: 'asset-upload-pending',
  });
  await h.owner.abortFile(reservation.ticket);
  assert.equal(
    (await h.command(move(h, cancelled.asset, place.folderId))).asset.folderId,
    place.folderId,
  );
});
