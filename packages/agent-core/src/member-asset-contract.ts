import { z } from 'zod';
import {
  ResourceOriginSchema,
  PackagePathSchema,
  PackageUploadSchema,
  ImportChoiceSchema,
  ImportPackageItemSchema,
  ImportPackagePreviewSchema,
  ASSET_IMPORT_LIMITS,
} from './asset-package.js';

/** Portable asset facts. Sessions, attachment services and authority stay Host-owned. */
export const MEMBER_ASSET_SOURCE_VERSION = 'zhuma-member-assets@1' as const;
export const MEMBER_ASSET_LIMITS = Object.freeze({
  assets: 100,
  versions: 20,
  dependencies: 100,
  receipts: 128,
  maintainers: 20,
  registryBytes: 8 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  activeUploads: 8,
  runFiles: 50,
});
export const MEMBER_ASSET_IMPORT_LIMITS = Object.freeze({
  requestBytes: 8 * 1024 * 1024,
  active: 2,
});
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = natural.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().trim().min(1).max(160);
const description = z.string().max(8000);
export const MemberAssetKindSchema = z.enum(['template', 'expert', 'skill', 'file']);
export const MemberAssetReferenceSchema = z.strictObject({
  spaceId: id,
  assetId: id,
  kind: MemberAssetKindSchema,
  versionId: z.uuid(),
  sha256: digest,
});
export type MemberAssetReference = z.infer<typeof MemberAssetReferenceSchema>;
/** Explicit published file selections. Absence is distinct from an empty
 * selection on Project/Task; neither value means a latest-version lookup. */
export const MemberAssetFileReferencesSchema = z
  .array(MemberAssetReferenceSchema.extend({ kind: z.literal('file') }))
  .max(MEMBER_ASSET_LIMITS.runFiles)
  .refine(
    (values) =>
      new Set(values.map((value) => value.assetId)).size === values.length &&
      values.every((value) => value.spaceId === values[0]?.spaceId),
  );
export const MemberAssetFileSnapshotQuerySchema = z
  .strictObject({ spaceId: id, references: MemberAssetFileReferencesSchema })
  .refine((value) => value.references.every((ref) => ref.spaceId === value.spaceId));
export type MemberAssetFileSnapshotQuery = z.infer<typeof MemberAssetFileSnapshotQuerySchema>;
/** Original task catalogs use an immutable definition ID per real publication.
 * This alias never replaces the complete asset reference or grants access. */
export function memberAssetDefinitionId(reference: MemberAssetReference): string {
  return `member-asset-${MemberAssetReferenceSchema.parse(reference).versionId}`;
}
export const MemberAssetDependencySchema = z.strictObject({
  slotId: id,
  reference: MemberAssetReferenceSchema,
});
const dependencies = z
  .array(MemberAssetDependencySchema)
  .max(MEMBER_ASSET_LIMITS.dependencies)
  .refine((values) => new Set(values.map((item) => item.slotId)).size === values.length);
export const MemberAssetFileDeclareSchema = z.strictObject({
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  byteSize: natural.max(MEMBER_ASSET_LIMITS.fileBytes),
  sha256: digest,
});
/** Persisted only in the original asset fact. Public metadata omits attachmentId. */
export const MemberAssetFileBlobSchema = MemberAssetFileDeclareSchema.extend({
  attachmentId: z.string().min(1).max(200),
});
export type MemberAssetFileDeclare = z.infer<typeof MemberAssetFileDeclareSchema>;
export type MemberAssetFileBlob = z.infer<typeof MemberAssetFileBlobSchema>;
/** Metadata frozen into the ORIGINAL new Run configuration; not a body read,
 * access grant, accepted task input, or independent directory fact. */
export const MemberAssetFileSnapshotSchema = z
  .strictObject({
    sourceVersion: z.literal('zhuma-native-team-assets@1'),
    spaceId: id,
    files: z
      .array(
        z.strictObject({
          reference: MemberAssetReferenceSchema.refine((value) => value.kind === 'file'),
          file: MemberAssetFileDeclareSchema,
        }),
      )
      .max(MEMBER_ASSET_LIMITS.runFiles),
    sha256: digest,
  })
  .refine(
    (value) =>
      value.files.every((item) => item.reference.spaceId === value.spaceId) &&
      new Set(value.files.map((item) => item.reference.assetId)).size === value.files.length,
  );
export type MemberAssetFileSnapshot = z.infer<typeof MemberAssetFileSnapshotSchema>;
export function memberAssetFileSnapshotDigestInput(value: MemberAssetFileSnapshot) {
  const { sha256: _digest, ...snapshot } = value;
  return snapshot;
}
export const MemberAssetFileSnapshotValueSchema = z.strictObject({
  actorId: id,
  snapshot: MemberAssetFileSnapshotSchema,
});
export type MemberAssetFileSnapshotValue = z.infer<typeof MemberAssetFileSnapshotValueSchema>;
const commonDefinition = { name, description };
export const MemberAssetDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...commonDefinition,
    kind: z.literal('template'),
    content: z.string().max(150000),
    origin: ResourceOriginSchema.optional(),
  }),
  z.strictObject({
    ...commonDefinition,
    kind: z.literal('skill'),
    content: z.string().max(60000),
    origin: ResourceOriginSchema.optional(),
  }),
  z.strictObject({
    ...commonDefinition,
    kind: z.literal('expert'),
    role: z.string().max(300),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(30),
    instructions: z.string().max(32000),
    origin: ResourceOriginSchema.optional(),
  }),
  z.strictObject({ ...commonDefinition, kind: z.literal('file') }),
]);
export type MemberAssetDefinition = z.infer<typeof MemberAssetDefinitionSchema>;
/** Existing sources retain their real pin, never a synthesized publication UUID. */
export const MemberAssetLegacyFixedSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('builtin'),
    spaceId: id,
    assetId: id,
    assetKind: MemberAssetKindSchema,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sha256: digest,
  }),
  z.strictObject({
    kind: z.literal('package'),
    spaceId: id,
    assetId: id,
    assetKind: MemberAssetKindSchema,
    origin: ResourceOriginSchema,
    sha256: digest,
  }),
  z.strictObject({
    kind: z.literal('member-template'),
    spaceId: id,
    assetId: id,
    assetKind: z.literal('template'),
    ownerId: id,
    sourceTaskId: id,
    sourceWorkbenchRevision: natural,
    sha256: digest,
  }),
]);
export const MemberAssetLegacySourceSchema = z.union([
  MemberAssetLegacyFixedSourceSchema,
  z.strictObject({
    kind: z.literal('unknown'),
    spaceId: id,
    assetId: id,
    assetKind: MemberAssetKindSchema,
    sha256: digest,
  }),
]);
export type MemberAssetLegacyFixedSource = z.infer<typeof MemberAssetLegacyFixedSourceSchema>;
export type MemberAssetLegacySource = z.infer<typeof MemberAssetLegacySourceSchema>;
export const MemberAssetLegacySummarySchema = z
  .strictObject({
    source: MemberAssetLegacySourceSchema,
    kind: MemberAssetKindSchema,
    name,
    description,
    available: z.boolean(),
    readOnly: z.literal(true),
    canCopy: z.boolean(),
  })
  .refine(
    (value) =>
      value.kind === value.source.assetKind && (!value.canCopy || value.source.kind !== 'unknown'),
  );
export const MemberAssetLegacyListValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  items: z.array(MemberAssetLegacySummarySchema).max(200),
});
export type MemberAssetLegacySummary = z.infer<typeof MemberAssetLegacySummarySchema>;
export type MemberAssetLegacyListValue = z.infer<typeof MemberAssetLegacyListValueSchema>;
export const MemberAssetLegacySourceValueSchema = z
  .strictObject({
    actorId: id,
    spaceId: id,
    source: MemberAssetLegacySourceSchema,
    definition: MemberAssetDefinitionSchema,
    requirements: z
      .array(z.strictObject({ slotId: id, kind: z.enum(['skill', 'mcp']) }))
      .max(MEMBER_ASSET_LIMITS.dependencies)
      .refine((items) => new Set(items.map((item) => item.slotId)).size === items.length),
  })
  .refine(
    (value) =>
      value.source.spaceId === value.spaceId && value.source.assetKind === value.definition.kind,
  );
export type MemberAssetLegacySourceValue = z.infer<typeof MemberAssetLegacySourceValueSchema>;
export const MemberAssetSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('asset'), reference: MemberAssetReferenceSchema }),
  ...MemberAssetLegacyFixedSourceSchema.options,
  z.strictObject({
    kind: z.literal('import'),
    versionId: z.uuid(),
    sha256: digest,
    entryPath: PackagePathSchema.optional(),
    sourceId: id.optional(),
    sourceVersion: z.string().max(80).optional(),
  }),
]);
const draft = z.strictObject({
  definition: MemberAssetDefinitionSchema,
  dependencies,
  source: MemberAssetSourceSchema.optional(),
  blob: MemberAssetFileBlobSchema.optional(),
});
export const MemberAssetPublishedVersionSchema = draft.extend({
  reference: MemberAssetReferenceSchema,
  number: positive,
  publishedBy: id,
  publishedAt: z.string().datetime(),
});
export type MemberAssetPublishedVersion = z.infer<typeof MemberAssetPublishedVersionSchema>;
/** Hash the complete frozen asset version, excluding only its own digest.
 * File bytes have their separate blob.sha256; neither digest is an ACL. */
export function memberAssetVersionDigestInput(version: MemberAssetPublishedVersion) {
  const { sha256: _digest, ...reference } = version.reference;
  return {
    schemaVersion: 1 as const,
    reference,
    number: version.number,
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt,
    definition: version.definition,
    dependencies: version.dependencies,
    ...(version.source ? { source: version.source } : {}),
    ...(version.blob ? { blob: version.blob } : {}),
  };
}
export const MemberAssetUploadReceiptSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  fingerprint: digest,
  expectedVersion: positive,
  reservedVersion: positive,
  declare: MemberAssetFileDeclareSchema,
  state: z.enum(['pending', 'committed', 'cancelled']),
  resultVersion: positive.optional(),
  blob: MemberAssetFileBlobSchema.optional(),
});
export const MemberAssetRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    spaceId: id,
    assetId: id,
    kind: MemberAssetKindSchema,
    ownerId: id,
    maintainerIds: z.array(id).min(1).max(MEMBER_ASSET_LIMITS.maintainers),
    version: positive,
    draft: draft.nullable(),
    published: z.array(MemberAssetPublishedVersionSchema).max(MEMBER_ASSET_LIMITS.versions),
    uploads: z.array(MemberAssetUploadReceiptSchema).max(MEMBER_ASSET_LIMITS.receipts),
    receipts: z
      .array(
        z.strictObject({
          idempotencyKey: z.uuid(),
          fingerprint: digest,
          operation: z.string().min(1).max(40),
          resultVersion: positive,
          versionId: z.uuid().optional(),
        }),
      )
      .min(1)
      .max(MEMBER_ASSET_LIMITS.receipts),
  })
  .refine(
    (value) =>
      value.maintainerIds.includes(value.ownerId) &&
      new Set(value.maintainerIds).size === value.maintainerIds.length &&
      (!value.draft || value.draft.definition.kind === value.kind) &&
      (!value.draft?.blob || value.kind === 'file') &&
      value.published.every(
        (item) =>
          item.reference.spaceId === value.spaceId &&
          item.reference.assetId === value.assetId &&
          item.reference.kind === value.kind &&
          item.definition.kind === value.kind &&
          (value.kind === 'file' ? !!item.blob : !item.blob),
      ) &&
      new Set(value.published.map((item) => item.reference.versionId)).size ===
        value.published.length &&
      new Set(value.receipts.map((item) => item.idempotencyKey)).size === value.receipts.length &&
      new Set(value.uploads.map((item) => item.idempotencyKey)).size === value.uploads.length &&
      value.uploads.every(
        (item) =>
          value.kind === 'file' &&
          item.reservedVersion > item.expectedVersion &&
          (item.state !== 'committed' || (!!item.resultVersion && !!item.blob)),
      ),
  );
export type MemberAssetRecord = z.infer<typeof MemberAssetRecordSchema>;
export const MemberAssetRegistrySchema = z
  .array(MemberAssetRecordSchema)
  .max(MEMBER_ASSET_LIMITS.assets)
  .refine(
    (values) =>
      new Set(values.map((item) => `${item.spaceId}:${item.assetId}`)).size === values.length &&
      new TextEncoder().encode(JSON.stringify(values)).byteLength <=
        MEMBER_ASSET_LIMITS.registryBytes,
  );
const scope = { spaceId: id };
const object = { ...scope, assetId: id };
const mutation = { ...object, expectedVersion: positive, idempotencyKey: z.uuid() };
export const MemberAssetListQuerySchema = z.strictObject({
  ...scope,
  kind: MemberAssetKindSchema.optional(),
  includeDrafts: z.boolean().optional(),
});
export const MemberAssetReadQuerySchema = z.union([
  z.strictObject({ ...object, versionId: z.uuid() }),
  z.strictObject({ ...object, draft: z.literal(true) }),
]);
export const MemberAssetReferenceQuerySchema = MemberAssetReferenceSchema;
export const MemberAssetCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create-draft'),
    ...object,
    expectedVersion: z.literal(0),
    idempotencyKey: z.uuid(),
    definition: MemberAssetDefinitionSchema,
    dependencies,
  }),
  z.strictObject({
    operation: z.literal('update-draft'),
    ...mutation,
    definition: MemberAssetDefinitionSchema,
    dependencies,
  }),
  z.strictObject({ operation: z.literal('publish'), ...mutation }),
  z.strictObject({ operation: z.literal('remove-draft'), ...mutation }),
  z.strictObject({ operation: z.literal('cancel-upload'), ...mutation, uploadKey: z.uuid() }),
  z.strictObject({
    operation: z.literal('set-maintainers'),
    ...mutation,
    maintainerIds: z.array(id).min(1).max(MEMBER_ASSET_LIMITS.maintainers),
  }),
  z.strictObject({
    operation: z.literal('copy'),
    ...object,
    expectedVersion: z.literal(0),
    idempotencyKey: z.uuid(),
    source: z.union([MemberAssetReferenceSchema, MemberAssetLegacyFixedSourceSchema]),
    name,
    dependencies,
  }),
]);
export type MemberAssetCommand = z.infer<typeof MemberAssetCommandSchema>;
export const MemberAssetFileReserveSchema = z.strictObject({
  ...mutation,
  declare: MemberAssetFileDeclareSchema,
});
export const MemberAssetFileReadSchema = z.strictObject({ ...object, versionId: z.uuid() });
export type MemberAssetFileReserve = z.infer<typeof MemberAssetFileReserveSchema>;
export type MemberAssetFileRead = z.infer<typeof MemberAssetFileReadSchema>;
export type MemberAssetListQuery = z.infer<typeof MemberAssetListQuerySchema>;
export type MemberAssetReadQuery = z.infer<typeof MemberAssetReadQuerySchema>;
export const MemberAssetSummarySchema = z.strictObject({
  spaceId: id,
  assetId: id,
  kind: MemberAssetKindSchema,
  name,
  description,
  ownerId: id,
  maintainerIds: z.array(id).max(MEMBER_ASSET_LIMITS.maintainers),
  version: positive,
  canMaintain: z.boolean(),
  canPublish: z.boolean(),
  hasDraft: z.boolean(),
  versions: z
    .array(
      z.strictObject({
        reference: MemberAssetReferenceSchema,
        number: positive,
        publishedBy: id,
        publishedAt: z.string().datetime(),
      }),
    )
    .max(MEMBER_ASSET_LIMITS.versions),
});
export const MemberAssetListValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  items: z.array(MemberAssetSummarySchema).max(MEMBER_ASSET_LIMITS.assets),
});
export const MemberAssetReadValueSchema = z.strictObject({
  actorId: id,
  asset: MemberAssetSummarySchema,
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('draft'), expectedVersion: positive }),
    z.strictObject({ kind: z.literal('published'), reference: MemberAssetReferenceSchema }),
  ]),
  definition: MemberAssetDefinitionSchema,
  dependencies,
  source: MemberAssetSourceSchema.optional(),
  // The original attachment handle is never part of a public read result.
  file: MemberAssetFileDeclareSchema.optional(),
  requirements: z
    .array(
      z.strictObject({
        slotId: id,
        kind: z.literal('skill'),
        name,
        sourceKey: PackagePathSchema,
        suggestedAssetId: id.optional(),
      }),
    )
    .max(MEMBER_ASSET_LIMITS.dependencies)
    .optional(),
});
const importQuery = z.strictObject({ spaceId: id, upload: PackageUploadSchema });
const importBound = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <=
  MEMBER_ASSET_IMPORT_LIMITS.requestBytes;
export const MemberAssetPreviewImportQuerySchema = importQuery.refine(importBound);
export const MemberAssetImportChoiceSchema = ImportChoiceSchema.omit({
  replace: true,
  available: true,
}).extend({ id: z.uuid(), dependencies });
export const MemberAssetImportDraftsQuerySchema = importQuery
  .extend({
    idempotencyKey: z.uuid(),
    packageChecksum: digest,
    choices: z
      .array(MemberAssetImportChoiceSchema)
      .min(1)
      .max(ASSET_IMPORT_LIMITS.items)
      .refine(
        (items) =>
          new Set(items.map((item) => item.key)).size === items.length &&
          new Set(items.map((item) => item.id)).size === items.length,
      ),
  })
  .refine(importBound);
export const MemberAssetPreviewImportValueSchema = z
  .strictObject({
    actorId: id,
    spaceId: id,
    packageChecksum: digest,
    items: z.array(ImportPackageItemSchema).min(1).max(ASSET_IMPORT_LIMITS.items),
    ignored: ImportPackagePreviewSchema.shape.ignored,
  })
  .refine(importBound);
export const MemberAssetImportDraftsValueSchema = z
  .strictObject({
    actorId: id,
    spaceId: id,
    disposition: z.enum(['applied', 'replayed']),
    source: z.strictObject({ kind: z.literal('import'), versionId: z.uuid(), sha256: digest }),
    assets: z.array(MemberAssetSummarySchema).min(1).max(ASSET_IMPORT_LIMITS.items),
    resultVersions: z
      .array(z.strictObject({ assetId: id, version: z.literal(1) }))
      .min(1)
      .max(ASSET_IMPORT_LIMITS.items),
  })
  .refine(
    (value) =>
      value.assets.every(
        (asset) =>
          asset.spaceId === value.spaceId &&
          asset.ownerId === value.actorId &&
          asset.kind !== 'file',
      ) &&
      value.resultVersions.length === value.assets.length &&
      new Set(value.assets.map((asset) => asset.assetId)).size === value.assets.length &&
      new Set(value.resultVersions.map((item) => item.assetId)).size === value.assets.length &&
      value.resultVersions.every((item) =>
        value.assets.some((asset) => asset.assetId === item.assetId),
      ),
  );
export type MemberAssetPreviewImportQuery = z.infer<typeof MemberAssetPreviewImportQuerySchema>;
export type MemberAssetImportDraftsQuery = z.infer<typeof MemberAssetImportDraftsQuerySchema>;
export type MemberAssetPreviewImportValue = z.infer<typeof MemberAssetPreviewImportValueSchema>;
export type MemberAssetImportDraftsValue = z.infer<typeof MemberAssetImportDraftsValueSchema>;
export function memberAssetImportSkillSlotId(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MEMBER_ASSET_LIMITS.dependencies)
    throw new RangeError('Invalid import dependency slot.');
  return `source-skill-${index + 1}`;
}
export const MemberAssetCommandValueSchema = z.strictObject({
  disposition: z.enum(['applied', 'replayed']),
  actorId: id,
  resultVersion: positive,
  asset: MemberAssetSummarySchema,
  reference: MemberAssetReferenceSchema.optional(),
});
export const MemberAssetReferenceValueSchema = z.strictObject({
  actorId: id,
  reference: MemberAssetReferenceSchema,
  definition: MemberAssetDefinitionSchema,
  dependencies,
  file: MemberAssetFileDeclareSchema.optional(),
});
export type MemberAssetListValue = z.infer<typeof MemberAssetListValueSchema>;
export type MemberAssetReadValue = z.infer<typeof MemberAssetReadValueSchema>;
export type MemberAssetCommandValue = z.infer<typeof MemberAssetCommandValueSchema>;
export type MemberAssetReferenceValue = z.infer<typeof MemberAssetReferenceValueSchema>;
/** Request is an original Host member request, supplied by the mounting owner.
 * Results are projections, never native execution or file-reading authority. */
export interface MemberAssetAuthority<Request> {
  list(
    request: Request,
    query: MemberAssetListQuery,
    signal: AbortSignal,
  ): Promise<MemberAssetListValue>;
  read(
    request: Request,
    query: MemberAssetReadQuery,
    signal: AbortSignal,
  ): Promise<MemberAssetReadValue>;
  command(
    request: Request,
    command: MemberAssetCommand,
    signal: AbortSignal,
  ): Promise<MemberAssetCommandValue>;
  reference(
    request: Request,
    reference: MemberAssetReference,
    signal: AbortSignal,
  ): Promise<MemberAssetReferenceValue>;
}
export const MemberAssetErrorCodeSchema = z.enum([
  'asset-unavailable',
  'asset-not-found',
  'asset-forbidden',
  'asset-conflict',
  'asset-request-reused',
  'asset-quota',
  'asset-invalid',
  'asset-dependency-required',
  'asset-reference-denied',
  'asset-upload-pending',
  'asset-file-invalid',
  'asset-cancelled',
]);
export type MemberAssetErrorCode = z.infer<typeof MemberAssetErrorCodeSchema>;
