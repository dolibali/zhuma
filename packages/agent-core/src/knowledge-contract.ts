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
