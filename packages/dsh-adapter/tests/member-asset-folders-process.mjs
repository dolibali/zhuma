import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assetHost } from './member-asset-host-fixture.mjs';
import { signal } from './member-workbench-fixture.mjs';
const [root, locator] = process.argv.slice(2),
  hooks = [];
const h = await assetHost({ after: (fn) => hooks.push(fn) }, { root });
try {
  const input = JSON.parse(await readFile(locator, 'utf8'));
  assert.equal(
    (await h.owner.createFolder(h.requests.ann, input.create, signal())).disposition,
    'replayed',
  );
  assert.equal(
    (await h.owner.command(h.requests.ann, input.move, signal())).disposition,
    'replayed',
  );
  const list = await h.owner.listFolder(
    h.requests.bob,
    { spaceId: 'north', folderId: null },
    signal(),
  );
  assert.equal(list.files[0].assetId, input.reference.assetId);
  assert.equal(list.folders.length, 1);
  const file = await h.files.read(
    h.requests.bob,
    { spaceId: 'north', assetId: input.reference.assetId, versionId: input.reference.versionId },
    signal(),
  );
  assert.equal(Buffer.from(file.bytes).toString(), input.text);
  assert.equal(h.workbench.snapshot().revision, input.revision);
  process.stdout.write(
    JSON.stringify({ recovered: true, originalBytes: true, noExtraWrite: true }),
  );
} finally {
  for (const hook of hooks) await hook();
}
