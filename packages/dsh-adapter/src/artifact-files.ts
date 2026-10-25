/**
 * Trusted file upload facts for deliveries. Bytes live in the upstream
 * content-addressed attachment store (`ctx.attachments`); this module owns
 * only the metadata ledger (`zhuma_files` domain): upload receipts, ownership,
 * and lifecycle. It never stores bytes, and a byte digest never authorizes.
 */
import { z } from 'zod';
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { WorkbenchError } from '@zhuma/agent-core';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);

/** Upload receipt states. Bytes publish first; the receipt completes after metadata lands. */
export type UploadState = 'completed' | 'abandoned';

const FileRecordSchema = z.strictObject({
  uploadId: id,
  attachmentId: z.string().min(1).max(200),
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  byteSize: z.number().int().nonnegative(),
  sha256: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]+$/),
  spaceId: id,
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
  uploadedBy: id,
  idempotencyKey: id,
  state: z.enum(['completed', 'abandoned']),
  uploadedAt: z.string(),
});

export type UploadFileRecord = z.infer<typeof FileRecordSchema>;

const GlobalSchema = z.strictObject({});

export const artifactFilesDomainSpec = defineDomain({
  name: 'zhuma_files',
  version: 1,
  global: { schema: GlobalSchema, initial: {} },
  tables: {
    files: { valueSchema: FileRecordSchema },
    idempotency: { valueSchema: z.strictObject({ uploadId: id }) },
  },
});

type FilesDomain = Domain<typeof artifactFilesDomainSpec>;

export const ARTIFACT_FILE_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerSubmission: 20,
  maxNodeBytes: 100 * 1024 * 1024,
  uploadTimeoutMs: 60_000,
  maxFilesPerSpace: 1000,
  maxConcurrentUploadsPerSpace: 8,
} as const;

export interface ArtifactFileUploadDeclare {
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface FileUploadReceipt {
  readonly uploadId: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArtifactFileStore {
  /** Read one receipt by its logical upload id. */
  get(uploadId: string): UploadFileRecord | undefined;
  /** Read the receipt a prior request with the same idempotency key produced. */
  findByIdempotencyKey(idempotencyKey: string): UploadFileRecord | undefined;
  /** Persist a completed receipt; a conflict on the id rejects. */
  put(record: UploadFileRecord): Promise<void>;
  /** Count completed uploads in one space (quota). */
  countInSpace(spaceId: string): number;
  /** Bytes pinned by delivery facts of one node (node quota). */
  bytesForNode(taskId: string, planId: string, revision: number, nodeId: string): number;
  close(): Promise<void>;
}

class OpenedArtifactFileStore implements ArtifactFileStore {
  constructor(private readonly domain: FilesDomain) {}

  get(uploadId: string): UploadFileRecord | undefined {
    return this.domain.table('files').get(uploadId);
  }

  findByIdempotencyKey(idempotencyKey: string): UploadFileRecord | undefined {
    const link = this.domain.table('idempotency').get(idempotencyKey);
    if (link === undefined) return undefined;
    return this.get(link.uploadId);
  }

  async put(record: UploadFileRecord): Promise<void> {
    if (this.domain.table('files').get(record.uploadId) !== undefined) {
      throw new WorkbenchError('conflict', '上传回执已存在。');
    }
    if (this.countInSpace(record.spaceId) >= ARTIFACT_FILE_LIMITS.maxFilesPerSpace) {
      throw new WorkbenchError('validation', '空间的文件数量已达上限。');
    }
    await this.domain.table('files').put(record.uploadId, record);
    await this.domain
      .table('idempotency')
      .put(record.idempotencyKey, { uploadId: record.uploadId });
  }

  countInSpace(spaceId: string): number {
    let count = 0;
    for (const [, record] of this.domain.table('files').entries()) {
      if (record.spaceId === spaceId && record.state === 'completed') count += 1;
    }
    return count;
  }

  bytesForNode(taskId: string, planId: string, revision: number, nodeId: string): number {
    let bytes = 0;
    for (const [, record] of this.domain.table('files').entries()) {
      if (
        record.taskId === taskId &&
        record.planId === planId &&
        record.revision === revision &&
        record.nodeId === nodeId &&
        record.state === 'completed'
      ) {
        bytes += record.byteSize;
      }
    }
    return bytes;
  }

  async close(): Promise<void> {
    await this.domain.close();
  }
}

/** Open the metadata ledger on the host's storage. */
export async function openArtifactFileStore(ctx: {
  readonly storageDomain: { open(spec: typeof artifactFilesDomainSpec): Promise<FilesDomain> };
}): Promise<ArtifactFileStore> {
  const domain = await ctx.storageDomain.open(artifactFilesDomainSpec);
  return new OpenedArtifactFileStore(domain);
}
