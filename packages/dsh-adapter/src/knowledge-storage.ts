import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { AttachmentId, type AttachmentStore } from '@deepseek-ai/dsh-attachment';
import {
  KNOWLEDGE_LIMITS,
  KnowledgeFormatSchema,
  KnowledgeVersionRefSchema,
} from '@zhuma/agent-core';
import { ArtifactUploadStream } from './artifact-files.js';

const id = KnowledgeVersionRefSchema.shape.pageId;
const positive = z.number().int().positive().refine(Number.isSafeInteger);
export const KnowledgeBlobSchema = z
  .strictObject({
    attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    name: z.enum(['knowledge.txt', 'knowledge.md', 'original.txt', 'original.md']),
    bytes: z.number().int().nonnegative().max(KNOWLEDGE_LIMITS.bodyBytes),
    checksum: KnowledgeVersionRefSchema.shape.checksum,
  })
  .refine((value) => value.attachmentId === `sha256:${value.checksum}`);
export type KnowledgeBlob = z.infer<typeof KnowledgeBlobSchema>;
export const KnowledgePublishedSchema = z.strictObject({
  version: positive,
  title: z.string().trim().min(1).max(200),
  format: KnowledgeFormatSchema,
  body: KnowledgeBlobSchema,
  original: KnowledgeBlobSchema.optional(),
  sources: z.array(KnowledgeVersionRefSchema).max(KNOWLEDGE_LIMITS.sourcesPerVersion),
  publishedAt: z.iso.datetime(),
});
export type KnowledgePublished = z.infer<typeof KnowledgePublishedSchema>;
export const KnowledgePageRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    spaceId: KnowledgeVersionRefSchema.shape.spaceId,
    libraryId: KnowledgeVersionRefSchema.shape.libraryId,
    pageId: id,
    ownerActorId: id,
    version: positive,
    versions: z.array(KnowledgePublishedSchema).max(KNOWLEDGE_LIMITS.versionsPerPage),
  })
  .superRefine((page, context) => {
    if (
      page.libraryId !== page.spaceId ||
      page.version < page.versions.length ||
      page.versions.some((version, index) => version.version !== index + 1)
    )
      context.addIssue({ code: 'custom', message: 'Invalid knowledge version history.' });
  });
export type KnowledgePageRecord = z.infer<typeof KnowledgePageRecordSchema>;

export const knowledgeDomainSpec = defineDomain({
  name: 'zhuma_knowledge',
  version: 1,
  global: {
    schema: z.strictObject({ schemaVersion: z.literal(1) }),
    initial: { schemaVersion: 1 as const },
  },
  tables: { pages: { valueSchema: KnowledgePageRecordSchema } },
});
type KnowledgeDomain = Domain<typeof knowledgeDomainSpec>;
export function knowledgePageKey(spaceId: string, pageId: string): string {
  return `knowledge_${createHash('sha256')
    .update(JSON.stringify([spaceId, pageId]))
    .digest('hex')}`;
}
/** One authoritative metadata record per page. Body bytes live in the original
 * DSH attachment provider; no task/Run/artifact facts are copied into this domain. */
export class KnowledgeStorage {
  constructor(private readonly domain: KnowledgeDomain) {}
  get(spaceId: string, pageId: string): KnowledgePageRecord | undefined {
    const row = this.domain.table('pages').get(knowledgePageKey(spaceId, pageId));
    return row && structuredClone(row);
  }
  pages(spaceId: string): readonly KnowledgePageRecord[] {
    return [...this.domain.table('pages').entries()]
      .map(([, row]) => row)
      .filter((row) => row.spaceId === spaceId)
      .map((row) => structuredClone(row));
  }
  async put(row: KnowledgePageRecord): Promise<void> {
    const parsed = KnowledgePageRecordSchema.parse(row);
    await this.domain.table('pages').put(knowledgePageKey(parsed.spaceId, parsed.pageId), parsed);
  }
  close(): Promise<void> {
    return this.domain.close();
  }
}
export async function openKnowledgeStorage(
  ctx: Pick<Context, 'storageDomain'>,
): Promise<KnowledgeStorage> {
  return new KnowledgeStorage(await ctx.storageDomain.open(knowledgeDomainSpec));
}

/** Reuse #33's byte/digest/EOS verifier. A blob hash is never an ACL. */
export class KnowledgeBytes {
  private readonly drains = new Set<Promise<unknown>>();
  constructor(private readonly attachments: AttachmentStore) {}
  private retain(work: Promise<unknown>): void {
    this.drains.add(work);
    void work.then(
      () => this.drains.delete(work),
      () => this.drains.delete(work),
    );
  }
  async read(blob: KnowledgeBlob, signal: AbortSignal, check: () => void): Promise<Uint8Array> {
    KnowledgeBlobSchema.parse(blob);
    check();
    signal.throwIfAborted();
    const source = this.attachments.readFileStream(
      { attachmentId: AttachmentId(blob.attachmentId), name: blob.name, bytes: blob.bytes },
      signal,
    );
    const stream = new ArtifactUploadStream(
      source,
      {
        name: blob.name,
        mediaType: 'text/plain',
        byteSize: blob.bytes,
        sha256: blob.checksum,
      },
      signal,
      check,
    );
    try {
      const bytes = new Uint8Array(blob.bytes);
      let offset = 0;
      for await (const chunk of stream) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      stream.check();
      check();
      // Validate complete UTF-8 before any range or snippet is delivered.
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return bytes;
    } finally {
      stream.finish();
      this.retain(stream.drain());
    }
  }
  async idle(): Promise<void> {
    while (this.drains.size) await Promise.allSettled([...this.drains]);
  }
}
