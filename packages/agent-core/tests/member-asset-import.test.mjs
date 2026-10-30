import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MemberAssetPreviewImportQuerySchema,
  MemberAssetImportDraftsQuerySchema,
  MemberAssetSourceSchema,
  memberAssetImportSkillSlotId,
} from '../dist/index.js';
const query = () => ({
  spaceId: 'north',
  upload: { kind: 'files', files: [{ path: 'SKILL.md', data: 'YQ==' }] },
});
const choice = () => ({
  key: 'SKILL.md',
  id: randomUUID(),
  name: 'Method',
  description: '',
  role: '',
  capabilities: [],
  dependencies: [],
});
test('member import DTO: original raw package shape, new IDs and explicit selection only; no claimed owner/origin/replacement/publication', () => {
  const value = {
    ...query(),
    idempotencyKey: randomUUID(),
    packageChecksum: 'a'.repeat(64),
    choices: [choice()],
  };
  MemberAssetPreviewImportQuerySchema.parse(query());
  MemberAssetImportDraftsQuerySchema.parse(value);
  for (const candidate of [
    { ...value, ownerId: 'ann' },
    { ...value, choices: [{ ...choice(), replace: true }] },
    { ...value, choices: [{ ...choice(), available: true }] },
    { ...value, choices: [{ ...choice(), origin: {} }] },
    { ...value, choices: [{ ...choice(), id: 'builtin-source' }] },
    { ...value, choices: [value.choices[0], value.choices[0]] },
  ])
    assert.equal(MemberAssetImportDraftsQuerySchema.safeParse(candidate).success, false);
  const legacy = { kind: 'import', versionId: randomUUID(), sha256: 'b'.repeat(64) };
  assert.deepEqual(MemberAssetSourceSchema.parse(legacy), legacy);
  MemberAssetSourceSchema.parse({ ...legacy, entryPath: 'expert/SOUL.md' });
});
test('member import DTO: dependency slots are stable indices within the actual immutable source; they never become publication refs', () => {
  assert.equal(memberAssetImportSkillSlotId(0), 'source-skill-1');
  assert.equal(memberAssetImportSkillSlotId(99), 'source-skill-100');
  for (const index of [-1, 100, 0.5, Infinity])
    assert.throws(() => memberAssetImportSkillSlotId(index));
});
