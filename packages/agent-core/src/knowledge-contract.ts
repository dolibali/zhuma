import { z } from 'zod';

/** Product transport only. These fields do not authorize a caller or a Run. */
export const KNOWLEDGE_LIMITS = {
  bodyBytes: 65_536,
  readBytes: 8_192,
  librariesPerQuery: 8,
  searchPages: 200,
  searchBytes: 16 * 1024 * 1024,
  searchResults: 20,
  snippetCharacters: 240,
  listResults: 50,
  librariesPerSpace: 1,
  pagesPerLibrary: 200,
  versionsPerPage: 32,
  sourcesPerVersion: 20,
  receiptsPerPage: 128,
  projectLinks: 20,
  receiptsPerProject: 128,
} as const;

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/u);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const KnowledgeFormatSchema = z.enum(['text', 'markdown']);
export const KnowledgeVersionRefSchema = z.strictObject({
  spaceId: id,
  libraryId: id,
  pageId: id,
  version: positive,
  checksum: digest,
});
export type KnowledgeVersionRef = z.infer<typeof KnowledgeVersionRefSchema>;

/** Project configuration references the original published content, never a copy. */
export const KnowledgeProjectLinkSchema = z.strictObject({
  reference: KnowledgeVersionRefSchema,
  required: z.boolean(),
});
export type KnowledgeProjectLink = z.infer<typeof KnowledgeProjectLinkSchema>;
export const KnowledgeProjectLinksSchema = z
  .array(KnowledgeProjectLinkSchema)
  .max(KNOWLEDGE_LIMITS.projectLinks)
  .refine(
    (links) =>
      new Set(
        links.map(({ reference: ref }) => JSON.stringify([ref.spaceId, ref.libraryId, ref.pageId])),
      ).size === links.length,
    'Each knowledge page can have only one project reference.',
  );
export const KnowledgeProjectLinksRequestSchema = z.strictObject({ spaceId: id, projectId: id });
export const KnowledgeSaveProjectLinksRequestSchema = KnowledgeProjectLinksRequestSchema.extend({
  expectedVersion: natural,
  idempotencyKey: id,
  links: KnowledgeProjectLinksSchema,
});
/** Portable source facts only. A snapshot is not node, Run or read authority. */
export const KnowledgeProjectSnapshotSchema = z
  .strictObject({
    sourceVersion: z.literal('zhuma-project-knowledge@1'),
    spaceId: id,
    projectId: id,
    relationshipVersion: natural,
    links: KnowledgeProjectLinksSchema,
    checksum: digest,
  })
  .refine((value) => value.links.every((link) => link.reference.spaceId === value.spaceId));
export type KnowledgeProjectSnapshot = z.infer<typeof KnowledgeProjectSnapshotSchema>;
export const KnowledgeProjectLinksValueSchema = KnowledgeProjectLinksRequestSchema.extend({
  actorId: id,
  relationshipVersion: natural,
  links: z
    .array(
      KnowledgeProjectLinkSchema.extend({
        title: z.string().min(1).max(200),
        format: z.enum(['text', 'markdown']),
        bytes: natural.max(KNOWLEDGE_LIMITS.bodyBytes),
        hasUpdate: z.boolean(),
      }),
    )
    .max(KNOWLEDGE_LIMITS.projectLinks),
  snapshot: KnowledgeProjectSnapshotSchema,
});
export const KnowledgeProjectLinksWriteValueSchema = KnowledgeProjectLinksRequestSchema.extend({
  actorId: id,
  relationshipVersion: positive,
  disposition: z.enum(['saved', 'replayed']),
});
export type KnowledgeProjectLinksRequest = z.input<typeof KnowledgeProjectLinksRequestSchema>;
export type KnowledgeSaveProjectLinksRequest = z.input<
  typeof KnowledgeSaveProjectLinksRequestSchema
>;
export type KnowledgeProjectLinksValue = z.infer<typeof KnowledgeProjectLinksValueSchema>;
export type KnowledgeProjectLinksWriteValue = z.infer<typeof KnowledgeProjectLinksWriteValueSchema>;

export const KnowledgeLibrarySchema = z.strictObject({
  id,
  spaceId: id,
  kind: z.enum(['personal', 'team']),
  name: z.string().trim().min(1).max(200),
  canCreate: z.literal(true),
});
export type KnowledgeLibrary = z.infer<typeof KnowledgeLibrarySchema>;

export const KnowledgePageSummarySchema = z.strictObject({
  reference: KnowledgeVersionRefSchema,
  title: z.string().trim().min(1).max(200),
  format: KnowledgeFormatSchema,
  ownerActorId: id,
  pageRevision: positive,
  bytes: natural.max(KNOWLEDGE_LIMITS.bodyBytes),
  publishedAt: z.iso.datetime(),
});
export type KnowledgePageSummary = z.infer<typeof KnowledgePageSummarySchema>;

export const KnowledgeLibrariesRequestSchema = z.strictObject({ spaceId: id });
export const KnowledgeLibrariesValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  libraries: z.array(KnowledgeLibrarySchema).max(KNOWLEDGE_LIMITS.librariesPerSpace),
});
export type KnowledgeLibrariesRequest = z.input<typeof KnowledgeLibrariesRequestSchema>;
export type KnowledgeLibrariesValue = z.infer<typeof KnowledgeLibrariesValueSchema>;

export const KnowledgeListRequestSchema = z.strictObject({
  spaceId: id,
  libraryId: id,
  cursor: z.string().min(1).max(2048).optional(),
  limit: positive.max(KNOWLEDGE_LIMITS.listResults).default(20),
});
export const KnowledgeListValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  libraryId: id,
  pages: z.array(KnowledgePageSummarySchema).max(KNOWLEDGE_LIMITS.listResults),
  nextCursor: z.string().max(2048).nullable(),
});
export type KnowledgeListRequest = z.input<typeof KnowledgeListRequestSchema>;
export type KnowledgeListValue = z.infer<typeof KnowledgeListValueSchema>;

/** Author-only draft discovery. A draft is not a published version reference. */
export const KnowledgeDraftsRequestSchema = KnowledgeListRequestSchema;
export const KnowledgeDraftSummarySchema = z.strictObject({
  spaceId: id,
  libraryId: id,
  pageId: id,
  ownerActorId: id,
  title: z.string().trim().min(1).max(200),
  format: KnowledgeFormatSchema,
  pageRevision: positive,
  bytes: natural.max(KNOWLEDGE_LIMITS.bodyBytes),
  authorship: z.enum(['member', 'agent']),
  savedAt: z.iso.datetime().optional(),
  hasPublished: z.boolean(),
});
export const KnowledgeDraftsValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  libraryId: id,
  pages: z.array(KnowledgeDraftSummarySchema).max(KNOWLEDGE_LIMITS.listResults),
  nextCursor: z.string().max(2048).nullable(),
});
export type KnowledgeDraftsRequest = z.input<typeof KnowledgeDraftsRequestSchema>;
export type KnowledgeDraftSummary = z.infer<typeof KnowledgeDraftSummarySchema>;
export type KnowledgeDraftsValue = z.infer<typeof KnowledgeDraftsValueSchema>;

export const KnowledgeSearchRequestSchema = z.strictObject({
  spaceId: id,
  libraryIds: z
    .array(id)
    .min(1)
    .max(KNOWLEDGE_LIMITS.librariesPerQuery)
    .refine((ids) => new Set(ids).size === ids.length),
  query: z.string().trim().min(1).max(200),
  limit: positive.max(KNOWLEDGE_LIMITS.searchResults).default(10),
});
export const KnowledgeSearchValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  libraryIds: z.array(id).min(1).max(KNOWLEDGE_LIMITS.librariesPerQuery),
  query: z.string().max(200),
  hits: z
    .array(
      KnowledgePageSummarySchema.extend({
        snippet: z.string().max(KNOWLEDGE_LIMITS.snippetCharacters * 2),
      }),
    )
    .max(KNOWLEDGE_LIMITS.searchResults),
  /** No partial result is returned: exceeding the scan budget is a limit error. */
  complete: z.literal(true),
});
export type KnowledgeSearchRequest = z.input<typeof KnowledgeSearchRequestSchema>;
export type KnowledgeSearchValue = z.infer<typeof KnowledgeSearchValueSchema>;

export const KnowledgeReadRequestSchema = z.strictObject({
  spaceId: id,
  libraryId: id,
  pageId: id,
  version: positive,
  checksum: digest.optional(),
  part: z.enum(['body', 'original']).default('body'),
  offset: natural.default(0),
  length: positive.max(KNOWLEDGE_LIMITS.readBytes).default(KNOWLEDGE_LIMITS.readBytes),
});
export const KnowledgeReadValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  reference: KnowledgeVersionRefSchema,
  part: z.enum(['body', 'original']),
  title: z.string().max(200),
  format: KnowledgeFormatSchema,
  text: z.string(),
  /** UTF-8 byte coordinates, never JavaScript string indices. */
  offset: natural,
  length: natural.max(KNOWLEDGE_LIMITS.readBytes),
  nextOffset: natural,
  totalBytes: natural.max(KNOWLEDGE_LIMITS.bodyBytes),
  /** Digest of the complete selected part; reference.checksum binds the page body. */
  partChecksum: digest,
  sources: z.array(KnowledgeVersionRefSchema).max(KNOWLEDGE_LIMITS.sourcesPerVersion),
});
export type KnowledgeReadRequest = z.input<typeof KnowledgeReadRequestSchema>;
export type KnowledgeReadValue = z.infer<typeof KnowledgeReadValueSchema>;

const knowledgeText = z
  .string()
  .max(KNOWLEDGE_LIMITS.bodyBytes)
  .refine((text) => {
    const bytes = new TextEncoder().encode(text);
    return (
      bytes.byteLength <= KNOWLEDGE_LIMITS.bodyBytes &&
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === text
    );
  });
export const KnowledgeDraftContentSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  format: KnowledgeFormatSchema,
  text: knowledgeText,
  originalText: knowledgeText.optional(),
  sources: z.array(KnowledgeVersionRefSchema).max(KNOWLEDGE_LIMITS.sourcesPerVersion).default([]),
});
export type KnowledgeDraftContent = z.infer<typeof KnowledgeDraftContentSchema>;
export const KnowledgeDraftRequestSchema = z.strictObject({
  spaceId: id,
  libraryId: id,
  pageId: id,
});
export const KnowledgeSaveDraftRequestSchema = KnowledgeDraftRequestSchema.extend({
  /** Zero creates a page; later writes compare the authoritative page revision. */
  expectedVersion: natural,
  idempotencyKey: id,
  content: KnowledgeDraftContentSchema,
});
export const KnowledgePublishRequestSchema = KnowledgeDraftRequestSchema.extend({
  expectedVersion: positive,
  idempotencyKey: id,
});
export const KnowledgeDraftValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  libraryId: id,
  pageId: id,
  ownerActorId: id,
  pageRevision: positive,
  draft: KnowledgeDraftContentSchema.extend({ authorship: z.enum(['member', 'agent']) }).nullable(),
  published: KnowledgeVersionRefSchema.nullable(),
  publishedHasOriginal: z.boolean(),
});
export const KnowledgeWriteValueSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  libraryId: id,
  pageId: id,
  pageRevision: positive,
  operation: z.enum(['save-draft', 'publish']),
  disposition: z.enum(['saved', 'published', 'replayed']),
  reference: KnowledgeVersionRefSchema.optional(),
});
export type KnowledgeDraftRequest = z.input<typeof KnowledgeDraftRequestSchema>;
export type KnowledgeSaveDraftRequest = z.input<typeof KnowledgeSaveDraftRequestSchema>;
export type KnowledgePublishRequest = z.input<typeof KnowledgePublishRequestSchema>;
export type KnowledgeDraftValue = z.infer<typeof KnowledgeDraftValueSchema>;
export type KnowledgeWriteValue = z.infer<typeof KnowledgeWriteValueSchema>;

export const KnowledgeErrorCodeSchema = z.enum([
  'invalid',
  'not-found',
  'conflict',
  'unavailable',
  'limit',
  'cancelled',
  'unauthenticated',
  'forbidden',
]);
export type KnowledgeErrorCode = z.infer<typeof KnowledgeErrorCodeSchema>;
export type KnowledgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: KnowledgeErrorCode; readonly message: string };
    };
