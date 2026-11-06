import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MemberAssetFolderCreateSchema,
  MemberAssetFoldersSchema,
  MemberAssetCommandSchema,
  WorkbenchSchema,
  emptyWorkbench,
} from '../dist/index.js';
const input = (patch = {}) => ({
  spaceId: 'north',
  folderId: randomUUID(),
  parentFolderId: null,
  name: ' 资料 ',
  expectedVersion: 0,
  idempotencyKey: randomUUID(),
  ...patch,
});
const record = (patch = {}) => {
  const { expectedVersion: _expected, ...row } = MemberAssetFolderCreateSchema.parse(input(patch));
  return { ...row, schemaVersion: 1, createdBy: 'ann', version: 1, fingerprint: 'a'.repeat(64) };
};
test('folder contract: normalized labels are not paths or authority and original omitted facts/commands keep exact bytes', () => {
  assert.equal(MemberAssetFolderCreateSchema.parse(input()).name, '资料');
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'a'.repeat(81)])
    assert.equal(MemberAssetFolderCreateSchema.safeParse(input({ name })).success, false);
  const own = input();
  assert.equal(
    MemberAssetFolderCreateSchema.safeParse({ ...own, parentFolderId: own.folderId }).success,
    false,
  );
  assert.equal(MemberAssetFolderCreateSchema.safeParse({ ...own, actorId: 'bob' }).success, false);
  const old = emptyWorkbench();
  assert.equal(JSON.stringify(WorkbenchSchema.parse(old)), JSON.stringify(old));
  assert.equal(Object.hasOwn(WorkbenchSchema.parse(old), 'memberAssetFolders'), false);
  const create = {
    operation: 'create-draft',
    spaceId: 'north',
    assetId: randomUUID(),
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    definition: { name: 'file', description: '', kind: 'file' },
    dependencies: [],
  };
  assert.equal(JSON.stringify(MemberAssetCommandSchema.parse(create)), JSON.stringify(create));
  assert.equal(
    MemberAssetCommandSchema.safeParse({
      ...create,
      folderId: null,
      definition: { kind: 'skill', name: 'method', description: '', content: 'x' },
    }).success,
    false,
  );
});
test('folder contract: same-scope parents, cycles, duplicate IDs/keys/sibling names and depth are bounded in the original fact', () => {
  const first = record({ name: 'Case' }),
    second = record({ name: 'case' });
  assert.equal(MemberAssetFoldersSchema.safeParse([first, second]).success, false);
  assert.equal(
    MemberAssetFoldersSchema.safeParse([
      first,
      { ...second, name: 'Other', parentFolderId: first.folderId, spaceId: 'south' },
    ]).success,
    false,
  );
  assert.equal(
    MemberAssetFoldersSchema.safeParse([
      { ...first, parentFolderId: second.folderId },
      { ...second, parentFolderId: first.folderId },
    ]).success,
    false,
  );
  const rows = [];
  for (let index = 0; index < 13; index++)
    rows.push(record({ name: String(index), parentFolderId: rows.at(-1)?.folderId ?? null }));
  assert.equal(MemberAssetFoldersSchema.safeParse(rows.slice(0, 12)).success, true);
  assert.equal(MemberAssetFoldersSchema.safeParse(rows).success, false);
});
