import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  emptyWorkbench,
  StoredAssetPackageSchema,
  previewResourcePackage,
  parseWorkflowTemplate,
} from '@zhuma/agent-core';
import { WorkbenchService } from '../dist/workbench-service.js';
import { previewAssetImport, readImportArchive } from '../dist/asset-import.js';
import {
  packageFixture,
  privateCredentialFiles,
  importCommand as packageCommand,
  sourceFile,
  packageZip,
} from '../../../tests/fixtures/asset-package.mjs';
const importCommand = (files = packageFixture()) =>
  packageCommand(previewResourcePackage(files, parseWorkflowTemplate), files);

test('asset archive: ZIP/folder previews agree, private entries stay unread, scripts remain inert', async () => {
  const files = packageFixture();
  const a = await previewAssetImport(
    { kind: 'zip', data: packageZip(files) },
    AbortSignal.timeout(5000),
  );
  const b = await previewAssetImport({ kind: 'files', files }, AbortSignal.timeout(5000));
  assert.deepEqual(a, b);
  assert.equal(a.items.length, 2);
  assert.equal(a.files.length, 6);
  assert(!a.files.some((f) => f.path.endsWith('USER.md')));
});

test('asset archive: corrupt CRC/truncation, traversal, links, case collisions and inflated size fail', async () => {
  const bad = [
    [{ path: '../SKILL.md', content: 'no' }],
    [{ path: 'SOUL.md', content: 'target', attributes: 0o120777 << 16 }],
    [
      { path: 'A.md', content: 'x' },
      { path: 'a.md', content: 'y' },
    ],
    [{ path: 'SOUL.md', content: 'persona', crc: 0 }],
    [{ path: 'SOUL.md', content: 'x', declaredSize: 262145 }],
    [{ path: 'SOUL.md', content: 'x', method: 99 }],
  ];
  for (const entries of bad)
    await assert.rejects(readImportArchive(packageZip(entries), AbortSignal.timeout(5000)));
  const zip = Buffer.from(packageZip([{ path: 'SOUL.md', content: 'Persona' }]), 'base64');
  await assert.rejects(
    readImportArchive(
      zip.subarray(0, zip.length - 5).toString('base64'),
      AbortSignal.timeout(5000),
    ),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readImportArchive(packageZip(packageFixture()), controller.signal));
});

function serviceFixture() {
  let current = emptyWorkbench();
  let writes = 0;
  let packageWrites = 0;
  let failCatalog = false;
  let failPackage = false;
  const versions = new Map();
  const storage = {
    read: () => current,
    write: async (next) => {
      writes++;
      if (failCatalog) throw Error('disk unavailable');
      current = structuredClone(next);
    },
  };
  const audits = {
    get: () => undefined,
    put: async () => assert.fail('Import must not call planning'),
  };
  const packages = {
    get: (id) => versions.get(id),
    put: async (value) => {
      packageWrites++;
      if (failPackage) throw Error('file write failed');
      versions.set(value.versionId, StoredAssetPackageSchema.parse(structuredClone(value)));
    },
  };
  const service = new WorkbenchService(storage, audits, packages);
  return {
    service,
    storage,
    audits,
    packages,
    versions,
    counts: () => ({ writes, packageWrites }),
    failCatalog: (v) => {
      failCatalog = v;
    },
    failPackage: (v) => {
      failPackage = v;
    },
  };
}

test('asset package credentials: ZIP skips private payloads and ZIP/files imports exclude them from stored versions and origin', async () => {
  const privateFiles = privateCredentialFiles();
  const excluded = new Set(privateFiles.map((f) => f.path));
  const files = [
    ...packageFixture(),
    ...privateFiles,
    sourceFile('analyst/skills/field-review/.editorconfig', 'root = true'),
    sourceFile('analyst/skills/field-review/LICENSE', 'Public fixture license.'),
  ];
  // A wrong CRC would fail if the reader opened and decompressed a private payload.
  const zip = packageZip(files.map((f) => (excluded.has(f.path) ? { ...f, crc: 0 } : f)));
  const raw = await readImportArchive(zip, AbortSignal.timeout(5000));
  for (const path of excluded) assert.equal(raw.find((f) => f.path === path).data, '');
  const preview = await previewAssetImport({ kind: 'zip', data: zip }, AbortSignal.timeout(5000));
  assert.deepEqual(
    preview,
    await previewAssetImport({ kind: 'files', files }, AbortSignal.timeout(5000)),
  );
  assert.deepEqual(
    preview.ignored
      .filter((f) => excluded.has(f.path))
      .map((f) => f.path)
      .sort(),
    [...excluded].sort(),
  );
  assert(!preview.files.some((f) => excluded.has(f.path)));
  assert(preview.files.some((f) => f.path.endsWith('/.editorconfig')));
  assert(preview.files.some((f) => f.path.endsWith('/LICENSE')));
  assert(preview.files.some((f) => f.path.endsWith('/scripts/check.py')));
  for (const source of [files, raw]) {
    const f = serviceFixture();
    const state = await f.service.command(
      { requestId: randomUUID(), expectedRevision: 0, command: importCommand(source) },
      AbortSignal.timeout(5000),
    );
    assert.equal(f.versions.size, 1);
    const stored = [...f.versions.values()][0];
    assert(!stored.files.some((file) => excluded.has(file.path)));
    assert.doesNotMatch(JSON.stringify(stored), /SYNTHETIC_PRIVATE_AUTH/);
    for (const resource of [...state.assets, ...state.participants])
      assert(!resource.origin.filePaths.some((path) => excluded.has(path)));
    assert(
      !f.service.resourceFiles('asset', 'imported-0').files.some((file) => excluded.has(file.path)),
    );
  }
});

test('asset package storage: file failure or catalog failure publishes nothing; durable retry/restart is single-write', async () => {
  const f = serviceFixture();
  const command = importCommand();
  const request = { requestId: randomUUID(), expectedRevision: 0, command };
  f.failPackage(true);
  await assert.rejects(f.service.command(request, AbortSignal.timeout(5000)), /file write/);
  assert.equal(f.service.snapshot().assets.length, 0);
  assert.equal(f.counts().writes, 0);
  f.failPackage(false);
  f.failCatalog(true);
  await assert.rejects(f.service.command(request, AbortSignal.timeout(5000)), /disk unavailable/);
  assert.equal(f.versions.size, 1);
  assert.equal(f.service.snapshot().assets.length, 0);
  assert.throws(() => f.service.resourceFiles('asset', 'imported-0'), /没有来源包/);
  f.failCatalog(false);
  const [a, b] = await Promise.all([
    f.service.command(request, AbortSignal.timeout(5000)),
    f.service.command(request, AbortSignal.timeout(5000)),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.assets.length, 1);
  assert.deepEqual(f.counts(), { writes: 2, packageWrites: 2 });
  const restarted = new WorkbenchService(f.storage, f.audits, f.packages);
  assert.deepEqual(await restarted.command(request, AbortSignal.timeout(5000)), a);
  assert.equal(f.counts().writes, 2);
  const files = restarted.resourceFiles('expert', 'imported-1');
  assert.equal(files.files.length, 3);
  assert(!files.files.some((f) => f.path.includes('skills/') || f.path.endsWith('USER.md')));
  files.files[0].data = 'mutated';
  assert.notEqual(restarted.resourceFiles('expert', 'imported-1').files[0].data, 'mutated');
});

test('asset package storage: fixed version cannot be overwritten by a new command', async () => {
  const f = serviceFixture();
  const cmd = importCommand();
  await f.service.command(
    { requestId: randomUUID(), expectedRevision: 0, command: cmd },
    AbortSignal.timeout(5000),
  );
  const before = f.service.snapshot();
  cmd.input.choices.forEach((c) => (c.replace = true));
  cmd.input.files[0] = sourceFile(cmd.input.files[0].path, 'Changed source.');
  await assert.rejects(
    f.service.command(
      { requestId: randomUUID(), expectedRevision: 1, command: cmd },
      AbortSignal.timeout(5000),
    ),
    /不能替换/,
  );
  assert.deepEqual(f.service.snapshot(), before);
});
