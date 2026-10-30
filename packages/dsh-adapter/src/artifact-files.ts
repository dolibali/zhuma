/**
 * Trusted file upload facts for deliveries. Bytes live in the upstream
 * content-addressed attachment store (`ctx.attachments`); this module owns
 * only the metadata ledger (`zhuma_files` domain): upload receipts, ownership,
 * and lifecycle. It never stores bytes, and a byte digest never authorizes.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import {
  WorkbenchError,
  WorkTaskSchema,
  canonicalPayload,
  type ArtifactFileRef,
} from '@zhuma/agent-core';
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment';

const id = WorkTaskSchema.shape.id;
const nativeId = z.string().min(1).max(200);

/** Host-only provenance. A digest or serialized copy is never publication authority. */
export const nativeOutputFileSourceSchema = z.strictObject({
  scope: z.strictObject({
    actorId: id,
    spaceId: id,
    taskId: id,
    planId: id,
    revision: z.number().int().positive().refine(Number.isSafeInteger),
    nodeId: id,
    runId: nativeId,
    generation: z.number().int().positive().refine(Number.isSafeInteger),
    segmentId: nativeId,
  }),
  nativeSessionId: nativeId,
  nativeAgentId: nativeId,
  configurationId: nativeId,
  expertVersionId: nativeId,
  toolVersion: z.literal('zhuma-native-output-file@1'),
  callId: nativeId,
});
export type NativeOutputFileSource = z.infer<typeof nativeOutputFileSourceSchema>;
const nativeProducerSchema = z.strictObject({
  kind: z.literal('native-run-output'),
  version: z.literal(1),
  source: nativeOutputFileSourceSchema,
  selectorFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

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
  producer: nativeProducerSchema.optional(),
});

/** The durable field bounds also apply before a stream or provider is opened. */
export const artifactUploadOptionsSchema = FileRecordSchema.pick({
  taskId: true,
  planId: true,
  revision: true,
  nodeId: true,
  spaceId: true,
  idempotencyKey: true,
}).extend({
  declare: FileRecordSchema.pick({ name: true, mediaType: true, byteSize: true, sha256: true }),
});

export type UploadFileRecord = z.infer<typeof FileRecordSchema>;

const GlobalSchema = z.strictObject({});

export const artifactFilesDomainSpec = {
  name: 'zhuma_files' as const,
  version: 1 as const,
  global: { schema: GlobalSchema, initial: {} },
  tables: {
    // One durable unit: the receipt record carries its idempotency key and the
    // full object binding (member/space/node/fingerprint). No separate index
    // table means a crash cannot leave a completed receipt without its key.
    files: { valueSchema: FileRecordSchema },
  },
};

type FilesDomain = Domain<typeof artifactFilesDomainSpec>;

export const ARTIFACT_FILE_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerSubmission: 20,
  maxNodeBytes: 100 * 1024 * 1024,
  uploadTimeoutMs: 60_000,
  maxFilesPerSpace: 1000,
  maxConcurrentUploadsPerSpace: 8,
  maxConcurrentReadsPerSpace: 8,
} as const;

export interface ArtifactFileUploadDeclare {
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export class ArtifactUploadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Verify EOS before the provider can publish. A stalled next()/provider is raced
 * against cancellation and the same deadline on both initial upload and replay.
 * Physical work is retained in drain() even after the caller has been refused.
 */
export class ArtifactUploadStream implements AsyncIterableIterator<Uint8Array> {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly hash = createHash('sha256');
  private readonly aborted: Promise<never>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private bytes = 0;
  private returned = false;
  verified = false;
  failure: ArtifactUploadError | undefined;
  readonly signal: AbortSignal;

  constructor(
    data: AsyncIterable<Uint8Array>,
    private readonly expected: ArtifactFileUploadDeclare,
    signal: AbortSignal,
    private readonly assertCurrent: () => void,
  ) {
    this.iterator = data[Symbol.asyncIterator]();
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.aborted = new Promise<never>((_, reject) => {
      const abort = () => {
        this.failure ??= new ArtifactUploadError('cancelled');
        reject(this.failure);
        this.cancelSource();
      };
      if (this.signal.aborted) abort();
      else this.signal.addEventListener('abort', abort, { once: true });
    });
    void this.aborted.catch(() => undefined);
    this.timer = setTimeout(
      () => this.reject('upload-timeout'),
      ARTIFACT_FILE_LIMITS.uploadTimeoutMs,
    );
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this;
  }

  private own<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  check(): void {
    if (this.failure) throw this.failure;
    if (this.signal.aborted) throw new ArtifactUploadError('cancelled');
    this.assertCurrent();
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    const owned = this.own(operation);
    this.check();
    const result = await Promise.race([owned, this.aborted]);
    this.check();
    return result;
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    try {
      this.check();
      if (this.verified) return { done: true, value: undefined };
      const chunk = await this.wait(Promise.resolve().then(() => this.iterator.next()));
      if (chunk.done) {
        if (
          this.bytes !== this.expected.byteSize ||
          this.hash.digest('hex') !== this.expected.sha256
        )
          throw new ArtifactUploadError('digest-mismatch');
        this.verified = true;
        return { done: true, value: undefined };
      }
      if (!(chunk.value instanceof Uint8Array)) throw new ArtifactUploadError('validation');
      this.bytes += chunk.value.byteLength;
      if (this.bytes > ARTIFACT_FILE_LIMITS.maxFileBytes)
        throw new ArtifactUploadError('file-too-large');
      this.hash.update(chunk.value);
      return { done: false, value: chunk.value };
    } catch (error) {
      this.failure ??= new ArtifactUploadError(
        error instanceof ArtifactUploadError ? error.code : 'unavailable',
      );
      // Let the SDK observe the rejected next() and finish its staging cleanup
      // before returning a validation failure. Abort/deadline still race a
      // stalled provider, retaining it in drain() rather than faking settlement.
      this.cancelSource();
      throw this.failure;
    }
  }

  private cancelSource(): void {
    if (this.returned || this.verified) return;
    this.returned = true;
    // Do not wait for a generator whose return is queued behind a stuck next.
    // The HTTP adapter's return cancels its reader immediately; any other source
    // stays owned until its actual pending operation settles.
    this.own(Promise.resolve().then(() => this.iterator.return?.()));
  }

  private reject(code: string): void {
    this.failure ??= new ArtifactUploadError(code);
    this.controller.abort();
    this.cancelSource();
  }

  async return(): Promise<IteratorResult<Uint8Array>> {
    if (!this.verified) this.reject('cancelled');
    return { done: true, value: undefined };
  }

  finish(): void {
    clearTimeout(this.timer);
    if (!this.verified || this.failure) this.reject(this.failure?.code ?? 'cancelled');
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export interface FileUploadReceipt {
  readonly uploadId: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Canonical input for draft/submit; its completion is still reverified by the Host. */
  readonly reference: ArtifactFileRef;
}

/** A policy label is metadata, never an authorization capability. */
export function artifactFileReference(record: UploadFileRecord): ArtifactFileRef {
  return {
    id: record.uploadId,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    checksum: record.sha256,
    accessPolicyId: `space:${record.spaceId}`,
    uploadComplete: record.state === 'completed',
  };
}

/** A caller flag is ignored; every other claimed fact must match the durable receipt. */
export function matchesArtifactFileReference(
  file: ArtifactFileRef,
  record: UploadFileRecord,
): boolean {
  const trusted = artifactFileReference(record);
  return (
    record.state === 'completed' &&
    file.id === trusted.id &&
    file.mediaType === trusted.mediaType &&
    file.byteSize === trusted.byteSize &&
    file.checksum === trusted.checksum &&
    file.accessPolicyId === trusted.accessPolicyId
  );
}

/** Only a display leaf from the original upload may enter response headers. */
export function artifactFileLeaf(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/u.test(name))
    throw new ArtifactUploadError('unavailable');
  return name;
}

/**
 * SDK reads yield before their final integrity check. Never expose those chunks
 * directly: consume the complete bounded object, then return verified bytes.
 * drain stays owned after a logical abort, including a late pending next().
 */
export function readVerifiedArtifactFile(input: {
  readonly attachments: AttachmentStore;
  readonly record: Pick<
    UploadFileRecord,
    'state' | 'byteSize' | 'attachmentId' | 'sha256' | 'name' | 'mediaType'
  >;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly collect: boolean;
}): { readonly result: Promise<Uint8Array | undefined>; readonly drain: Promise<void> } {
  const { record, signal, assertCurrent } = input;
  if (
    record.state !== 'completed' ||
    record.byteSize > ARTIFACT_FILE_LIMITS.maxFileBytes ||
    record.attachmentId !== `sha256:${record.sha256}`
  )
    throw new ArtifactUploadError('unavailable');
  const name = artifactFileLeaf(record.name);
  const source = input.attachments.readFileStream(
    {
      attachmentId: record.attachmentId as FileAttachmentRef['attachmentId'],
      name,
      bytes: record.byteSize,
    },
    signal,
  );
  const stream = new ArtifactUploadStream(source, record, signal, assertCurrent);
  let resolveDrain!: () => void;
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  const result = (async () => {
    try {
      const bytes = input.collect ? new Uint8Array(record.byteSize) : undefined;
      let offset = 0;
      for await (const chunk of stream) {
        if (offset + chunk.byteLength > record.byteSize)
          throw new ArtifactUploadError('unavailable');
        bytes?.set(chunk, offset);
        offset += chunk.byteLength;
      }
      stream.check();
      return bytes;
    } catch (error) {
      const code = error instanceof ArtifactUploadError ? error.code : 'unavailable';
      throw new ArtifactUploadError(
        code === 'upload-timeout'
          ? 'file-timeout'
          : code === 'digest-mismatch' || code === 'file-too-large'
            ? 'unavailable'
            : code,
      );
    } finally {
      stream.finish();
      void stream.drain().then(resolveDrain);
    }
  })();
  return { result, drain };
}

export interface ArtifactFileStore {
  /** Read one receipt by its logical upload id. */
  get(uploadId: string): UploadFileRecord | undefined;
  /**
   * Read the full idempotency record a prior request produced: the receipt id
   * plus its member/space/node/fingerprint binding, so the caller re-verifies
   * the object identity instead of trusting the raw key.
   */
  findByIdempotencyKey(idempotencyKey: string): UploadFileRecord | undefined;
  /** Persist a completed receipt; a conflict on the id rejects. */
  put(record: UploadFileRecord): Promise<void>;
  findNativePublication(source: NativeOutputFileSource): UploadFileRecord | undefined;
  putNativePublication(record: UploadFileRecord): Promise<void>;
  countNativePublications(scope: NativeOutputFileSource['scope']): number;
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
    for (const [, record] of this.domain.table('files').entries()) {
      if (record.idempotencyKey === idempotencyKey) return record;
    }
    return undefined;
  }

  async put(record: UploadFileRecord): Promise<void> {
    if (record.producer !== undefined) throw new ArtifactUploadError('validation');
    await this.write(record);
  }

  findNativePublication(source: NativeOutputFileSource): UploadFileRecord | undefined {
    const parsed = nativeOutputFileSourceSchema.parse(source);
    for (const [, record] of this.domain.table('files').entries())
      if (record.producer && canonicalPayload(record.producer.source) === canonicalPayload(parsed))
        return record;
    return undefined;
  }

  countNativePublications(scope: NativeOutputFileSource['scope']): number {
    let count = 0;
    for (const [, record] of this.domain.table('files').entries())
      if (
        record.state === 'completed' &&
        record.producer &&
        canonicalPayload(record.producer.source.scope) === canonicalPayload(scope)
      )
        count++;
    return count;
  }

  async putNativePublication(record: UploadFileRecord): Promise<void> {
    const parsed = FileRecordSchema.safeParse(record);
    if (!parsed.success || !parsed.data.producer) throw new ArtifactUploadError('validation');
    const scope = parsed.data.producer.source.scope;
    if (
      record.state !== 'completed' ||
      record.byteSize > ARTIFACT_FILE_LIMITS.maxFileBytes ||
      record.attachmentId !== `sha256:${record.sha256}` ||
      record.uploadedBy !== scope.actorId ||
      ['spaceId', 'taskId', 'planId', 'revision', 'nodeId'].some(
        (key) => Reflect.get(record, key) !== Reflect.get(scope, key),
      ) ||
      this.findNativePublication(parsed.data.producer.source) ||
      this.findByIdempotencyKey(record.idempotencyKey)
    )
      throw new ArtifactUploadError('conflict');
    await this.write(parsed.data);
  }

  private async write(record: UploadFileRecord): Promise<void> {
    // The record must parse before any write; an invalid record can never
    // poison the domain.
    const parsed = FileRecordSchema.safeParse(record);
    if (!parsed.success) throw new WorkbenchError('validation', '上传记录不合法。');
    if (this.domain.table('files').get(record.uploadId) !== undefined) {
      throw new WorkbenchError('conflict', '上传回执已存在。');
    }
    if (this.countInSpace(record.spaceId) >= ARTIFACT_FILE_LIMITS.maxFilesPerSpace) {
      throw new WorkbenchError('validation', '空间的文件数量已达上限。');
    }
    await this.domain.table('files').put(record.uploadId, parsed.data);
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
