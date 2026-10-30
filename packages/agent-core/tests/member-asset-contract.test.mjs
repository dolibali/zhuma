/** Portable asset contracts only; no member lease, byte store or product acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  emptyWorkbench,
  WorkbenchSchema,
  ParticipantSchema,
  AssetSchema,
  AppliedPlanSchema,
  applyWorkbenchCommand,
} from '../dist/workbench.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import {
  MEMBER_ASSET_LIMITS,
  MemberAssetCommandSchema,
  MemberAssetFileReadSchema,
  MemberAssetFileReserveSchema,
  MemberAssetListQuerySchema,
  MemberAssetReadQuerySchema,
  MemberAssetRecordSchema,
  MemberAssetReferenceSchema,
  MemberAssetRegistrySchema,
  memberAssetVersionDigestInput,
  MemberAssetLegacyFixedSourceSchema,
  MemberAssetLegacySummarySchema,
  memberAssetDefinitionId,
} from '../dist/member-asset-contract.js';

const reference = () => ({
  spaceId: 'team',
  assetId: randomUUID(),
  kind: 'skill',
  versionId: randomUUID(),
  sha256: 'a'.repeat(64),
});
const record = () => ({
  schemaVersion: 1,
  spaceId: 'team',
  assetId: randomUUID(),
  kind: 'skill',
  ownerId: 'ann',
  maintainerIds: ['ann'],
  version: 1,
  draft: {
    definition: {
      kind: 'skill',
      name: 'Review',
      description: 'Team skill',
      content: 'Check evidence.',
    },
    dependencies: [],
  },
  published: [],
  uploads: [],
  receipts: [
    {
      idempotencyKey: randomUUID(),
      fingerprint: 'b'.repeat(64),
      operation: 'create-draft',
      resultVersion: 1,
    },
  ],
});

test('member asset DTO: old applied definitions remain byte-compatible; real publication aliases require kind and full immutable source', () => {
  const f = fixture(),
    confirmed = applyWorkbenchCommand(f.state, {
      type: 'save-task',
      task: { ...f.task, status: 'ready' },
    }).appliedPlans[0];
  const before = JSON.stringify(confirmed);
  assert.equal(JSON.stringify(AppliedPlanSchema.parse(confirmed)), before);
  assert(!before.includes('memberAsset'));
  const ref = reference(),
    value = { ...f.state.assets[0], id: memberAssetDefinitionId(ref), memberAsset: ref };
  AssetSchema.parse(value);
  assert.equal(AssetSchema.safeParse({ ...value, id: ref.assetId }).success, false);
  assert.equal(
    AssetSchema.safeParse({ ...value, memberAsset: { ...ref, kind: 'expert' } }).success,
    false,
  );
  assert.equal(
    ParticipantSchema.safeParse({
      ...f.state.participants[0],
      id: memberAssetDefinitionId(ref),
      memberAsset: ref,
    }).success,
    false,
  );
});
test('member asset DTO: legacy Workbench has no fabricated asset ownership or normalized leaf', () => {
  const legacy = emptyWorkbench();
  const raw = JSON.stringify(legacy);
  assert.equal(Object.hasOwn(legacy, 'memberAssets'), false);
  assert.equal(JSON.stringify(WorkbenchSchema.parse(legacy)), raw);
  const value = record();
  assert.deepEqual(WorkbenchSchema.parse({ ...legacy, memberAssets: [value] }).memberAssets, [
    value,
  ]);
});
test('member asset DTO: full fixed references distinguish asset CAS from published UUID and digest', () => {
  const value = reference();
  MemberAssetReferenceSchema.parse(value);
  for (const field of ['spaceId', 'assetId', 'kind', 'versionId', 'sha256']) {
    const missing = { ...value };
    delete missing[field];
    assert.equal(MemberAssetReferenceSchema.safeParse(missing).success, false, field);
  }
  assert.equal(MemberAssetReferenceSchema.safeParse({ ...value, versionId: 1 }).success, false);
  assert.equal(MemberAssetReferenceSchema.safeParse({ ...value, actorId: 'ann' }).success, false);
  MemberAssetReadQuerySchema.parse({
    spaceId: value.spaceId,
    assetId: value.assetId,
    versionId: value.versionId,
  });
});
test('member asset DTO: create starts at zero; edits require CAS and cannot set owner/published authority', () => {
  const value = record();
  const input = {
    operation: 'create-draft',
    spaceId: value.spaceId,
    assetId: value.assetId,
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    ...value.draft,
  };
  MemberAssetCommandSchema.parse(input);
  for (const field of ['ownerId', 'actorId', 'maintainerIds', 'published', 'blob'])
    assert.equal(
      MemberAssetCommandSchema.safeParse({ ...input, [field]: value[field] ?? 'forged' }).success,
      false,
      field,
    );
  assert.equal(MemberAssetCommandSchema.safeParse({ ...input, expectedVersion: 1 }).success, false);
  assert.equal(
    MemberAssetCommandSchema.safeParse({ ...input, operation: 'update-draft' }).success,
    false,
  );
  MemberAssetCommandSchema.parse({ ...input, operation: 'update-draft', expectedVersion: 1 });
  MemberAssetListQuerySchema.parse({ spaceId: 'team', kind: 'skill', includeDrafts: true });
  assert.equal(
    MemberAssetListQuerySchema.safeParse({ spaceId: 'team', ownerId: 'ann' }).success,
    false,
  );
});
test('member asset DTO: original fact refuses foreign fixed versions, wrong kinds and duplicate maintainers or receipts', () => {
  const value = record();
  const published = {
    ...value.draft,
    reference: { ...reference(), assetId: value.assetId },
    number: 1,
    publishedBy: 'ann',
    publishedAt: '2026-10-30T05:00:00.000Z',
  };
  MemberAssetRecordSchema.parse({ ...value, published: [published] });
  for (const patch of [
    { maintainerIds: ['bob'] },
    { maintainerIds: ['ann', 'ann'] },
    { kind: 'expert' },
    { published: [{ ...published, reference: { ...published.reference, spaceId: 'other' } }] },
    { receipts: [...value.receipts, ...value.receipts] },
  ])
    assert.equal(MemberAssetRecordSchema.safeParse({ ...value, ...patch }).success, false);
  assert.equal(MemberAssetRegistrySchema.safeParse([value, value]).success, false);
  MemberAssetRegistrySchema.parse([value, { ...value, spaceId: 'other' }]);
});
test('member asset DTO: fixed-version digest binds complete scope, definition and dependencies but excludes its own digest', () => {
  const value = record();
  const version = {
    ...value.draft,
    reference: { ...reference(), assetId: value.assetId },
    number: 1,
    publishedBy: 'ann',
    publishedAt: '2026-10-30T05:00:00.000Z',
  };
  const before = structuredClone(version);
  const input = memberAssetVersionDigestInput(version);
  assert.deepEqual(
    memberAssetVersionDigestInput({
      ...version,
      reference: { ...version.reference, sha256: 'f'.repeat(64) },
    }),
    input,
  );
  for (const patch of [
    { reference: { ...version.reference, spaceId: 'other' } },
    { reference: { ...version.reference, versionId: randomUUID() } },
    { definition: { ...version.definition, content: 'Different fixed bytes.' } },
    { dependencies: [{ slotId: 'required', reference: reference() }] },
  ])
    assert.notDeepEqual(memberAssetVersionDigestInput({ ...version, ...patch }), input);
  assert.deepEqual(version, before);
});
test('member file DTO: independent asset target, bounded declaration and exact published version; no task impersonation', () => {
  const declare = {
    name: 'report.pdf',
    mediaType: 'application/pdf',
    byteSize: MEMBER_ASSET_LIMITS.fileBytes,
    sha256: 'c'.repeat(64),
  };
  const input = {
    spaceId: 'team',
    assetId: randomUUID(),
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    declare,
  };
  MemberAssetFileReserveSchema.parse(input);
  assert.equal(
    MemberAssetFileReserveSchema.safeParse({
      ...input,
      declare: { ...declare, byteSize: declare.byteSize + 1 },
    }).success,
    false,
  );
  assert.equal(
    MemberAssetFileReserveSchema.safeParse({ ...input, taskId: 'fake-task' }).success,
    false,
  );
  assert.equal(MemberAssetFileReserveSchema.safeParse({ ...input, actorId: 'ann' }).success, false);
  assert.equal(
    MemberAssetFileReadSchema.safeParse({ spaceId: 'team', assetId: input.assetId }).success,
    false,
  );
  MemberAssetFileReadSchema.parse({
    spaceId: 'team',
    assetId: input.assetId,
    versionId: randomUUID(),
  });
});
test('member asset source DTO: original built-in commit, package UUID and owned template revision are distinct fixed facts', () => {
  const builtin = {
    kind: 'builtin',
    spaceId: 'team',
    assetId: 'original-flow',
    assetKind: 'template',
    sourceCommit: '1'.repeat(40),
    sha256: '2'.repeat(64),
  };
  MemberAssetLegacyFixedSourceSchema.parse(builtin);
  assert.equal(
    MemberAssetLegacyFixedSourceSchema.safeParse({ ...builtin, versionId: randomUUID() }).success,
    false,
  );
  assert.equal(
    MemberAssetLegacyFixedSourceSchema.safeParse({ ...builtin, ownerId: 'ann' }).success,
    false,
  );
  const unknown = {
    kind: 'unknown',
    spaceId: 'team',
    assetId: 'original-flow',
    assetKind: 'template',
    sha256: '2'.repeat(64),
  };
  assert.equal(
    MemberAssetLegacySummarySchema.safeParse({
      source: unknown,
      kind: 'template',
      name: 'Original',
      description: '',
      available: true,
      readOnly: true,
      canCopy: true,
    }).success,
    false,
  );
  assert.equal(MemberAssetLegacyFixedSourceSchema.safeParse(unknown).success, false);
});
