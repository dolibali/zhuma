import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { AttachmentId, type AttachmentStore } from '@deepseek-ai/dsh-attachment';
import {
  KNOWLEDGE_LIMITS,
  KnowledgeFormatSchema,
  KnowledgeVersionRefSchema,
  KnowledgeProjectLinksSchema,
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
export const KnowledgeDraftRecordSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  format: KnowledgeFormatSchema,
  body: KnowledgeBlobSchema,
  original: KnowledgeBlobSchema.optional(),
  sources: z.array(KnowledgeVersionRefSchema).max(KNOWLEDGE_LIMITS.sourcesPerVersion),
  authorship: z.enum(['member', 'agent']),
  savedAt: z.iso.datetime().optional(),
});
export const KnowledgeWriteReceiptSchema = z.strictObject({
  key: id,
  operation: z.enum(['save-draft', 'publish']),
  fingerprint: KnowledgeVersionRefSchema.shape.checksum,
  pageRevision: positive,
  reference: KnowledgeVersionRefSchema.optional(),
});
export type KnowledgeWriteReceipt = z.infer<typeof KnowledgeWriteReceiptSchema>;
export const KnowledgePageRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    spaceId: KnowledgeVersionRefSchema.shape.spaceId,
    libraryId: KnowledgeVersionRefSchema.shape.libraryId,
    pageId: id,
    ownerActorId: id,
    version: positive,
    versions: z.array(KnowledgePublishedSchema).max(KNOWLEDGE_LIMITS.versionsPerPage),
    draft: KnowledgeDraftRecordSchema.optional(),
    receipts: z
      .array(KnowledgeWriteReceiptSchema)
      .max(KNOWLEDGE_LIMITS.receiptsPerPage)
      .default([]),
  })
  .superRefine((page, context) => {
    if (
      page.libraryId !== page.spaceId ||
      page.version < page.versions.length ||
      page.versions.some((version, index) => version.version !== index + 1) ||
      new Set(page.receipts.map((receipt) => receipt.key)).size !== page.receipts.length ||
      page.receipts.some((receipt) => {
        if (receipt.pageRevision > page.version) return true;
        const ref = receipt.reference;
        if (receipt.operation === 'save-draft') return ref !== undefined;
        return (
          !ref ||
          ref.spaceId !== page.spaceId ||
          ref.libraryId !== page.libraryId ||
          ref.pageId !== page.pageId ||
          !page.versions.some(
            (version) => version.version === ref.version && version.body.checksum === ref.checksum,
          )
        );
      })
    )
      context.addIssue({ code: 'custom', message: 'Invalid knowledge version history.' });
  });
export type KnowledgePageRecord = z.infer<typeof KnowledgePageRecordSchema>;

export const KnowledgeProjectLinksRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    spaceId: id,
    projectId: id,
    version: positive,
    links: KnowledgeProjectLinksSchema,
    receipts: z
      .array(
        z.strictObject({
          key: id,
          fingerprint: KnowledgeVersionRefSchema.shape.checksum,
          version: positive,
        }),
      )
      .min(1)
      .max(KNOWLEDGE_LIMITS.receiptsPerProject),
  })
  .refine(
    (row) =>
      row.links.every((link) => link.reference.spaceId === row.spaceId) &&
      new Set(row.receipts.map((receipt) => receipt.key)).size === row.receipts.length &&
      row.receipts.every((receipt, index) => receipt.version === index + 1) &&
      row.receipts.length === row.version,
  );
export type KnowledgeProjectLinksRecord = z.infer<typeof KnowledgeProjectLinksRecordSchema>;

export const knowledgeDomainSpec = defineDomain({
  name: 'zhuma_knowledge',
  version: 1,
  global: {
    // Format 2 deliberately refuses the old page-only writer. Its original
    // single-document backend otherwise drops unknown relation tables on write.
    schema: z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]) }),
    initial: { schemaVersion: 1 as const },
  },
  tables: {
    pages: { valueSchema: KnowledgePageRecordSchema },
    project_links: { valueSchema: KnowledgeProjectLinksRecordSchema },
  },
});
type KnowledgeDomain = Domain<typeof knowledgeDomainSpec>;
export function knowledgePageKey(spaceId: string, pageId: string): string {
  return `knowledge_${createHash('sha256')
    .update(JSON.stringify([spaceId, pageId]))
    .digest('hex')}`;
}
export function knowledgeProjectKey(spaceId: string, projectId: string): string {
  return `project_${createHash('sha256')
    .update(JSON.stringify([spaceId, projectId]))
    .digest('hex')}`;
}
/** One authoritative metadata record per page. Body bytes live in the original
 * DSH attachment provider; no task/Run/artifact facts are copied into this domain. */
export class KnowledgeStorage {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly domain: KnowledgeDomain) {}
  /** One service/store handle per mounted Host; CAS and receipt checks share this queue. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.writes.then(work);
    this.writes = operation.catch(() => undefined);
    return operation;
  }
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
  projectLinks(spaceId: string, projectId: string): KnowledgeProjectLinksRecord | undefined {
    const table = this.domain.table('project_links');
    if (this.domain.global.get().schemaVersion === 1 && table.size > 0)
      throw new Error('Unprotected knowledge relationship format.');
    const row = table.get(knowledgeProjectKey(spaceId, projectId));
    return row && structuredClone(row);
  }
  /** Call inside exclusive(), before a first relation write. Reads never upgrade.
   * If the following put fails, format 2 is safe and the original intent retries.
   * Rollback requires the pre-association backup, never lowering this marker. */
  async protectProjectLinks(): Promise<void> {
    if (this.domain.global.get().schemaVersion === 1)
      await this.domain.global.set({ schemaVersion: 2 });
  }
  async putProjectLinks(row: KnowledgeProjectLinksRecord): Promise<void> {
    const parsed = KnowledgeProjectLinksRecordSchema.parse(row);
    if (this.domain.global.get().schemaVersion !== 2)
      throw new Error('Unprotected knowledge relationship format.');
    await this.domain
      .table('project_links')
      .put(knowledgeProjectKey(parsed.spaceId, parsed.projectId), parsed);
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
  async save(
    text: string,
    format: 'text' | 'markdown',
    original: boolean,
    signal: AbortSignal,
    check: () => void,
  ): Promise<KnowledgeBlob> {
    check();
    const data = new TextEncoder().encode(text);
    if (data.byteLength > KNOWLEDGE_LIMITS.bodyBytes) throw new Error('Knowledge byte limit');
    // Reject unpaired UTF-16 surrogates rather than silently changing submitted text.
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) !== text)
      throw new Error('Invalid knowledge text');
    const name =
      `${original ? 'original' : 'knowledge'}.${format === 'text' ? 'txt' : 'md'}` as const;
    const checksum = createHash('sha256').update(data).digest('hex');
    const source = (async function* () {
      yield data;
    })();
    const stream = new ArtifactUploadStream(
      source,
      { name, mediaType: 'text/plain', byteSize: data.byteLength, sha256: checksum },
      signal,
      check,
    );
    try {
      const stored = await stream.wait(
        this.attachments.saveFileStream({ data: stream, name, signal: stream.signal }),
      );
      stream.check();
      if (!stream.verified || stored.bytes !== data.byteLength || stored.name !== name)
        throw new Error('Invalid knowledge receipt');
      const blob = KnowledgeBlobSchema.parse({ ...stored, checksum });
      // The provider receipt alone does not certify actual bytes.
      await this.read(blob, signal, check);
      check();
      return blob;
    } finally {
      stream.finish();
      this.retain(stream.drain());
    }
  }
  async idle(): Promise<void> {
    while (this.drains.size) await Promise.allSettled([...this.drains]);
  }
}
