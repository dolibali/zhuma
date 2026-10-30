import { z } from 'zod';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import {
  ARTIFACT_FILE_LIMITS,
  ArtifactUploadError,
  ArtifactUploadStream,
  artifactFileLeaf,
  readVerifiedArtifactFile,
} from './artifact-files.js';

/** Byte identity only. D's original asset/version row owns its ACL, logical
 * upload receipt, draft/publish lifecycle and idempotency. A hash is not a grant. */
export const teamAssetFileDeclareSchema = z.strictObject({
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  byteSize: z.number().int().nonnegative().max(ARTIFACT_FILE_LIMITS.maxFileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const teamAssetFileBlobSchema = teamAssetFileDeclareSchema
  .extend({ attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u) })
  .refine((value) => value.attachmentId === `sha256:${value.sha256}`);
export type TeamAssetFileBlob = z.infer<typeof teamAssetFileBlobSchema>;
export type TeamAssetFileDeclare = z.infer<typeof teamAssetFileDeclareSchema>;

/** Host-only closure minted after D authorizes the complete space/asset/fixed
 * version. Never deserialize this from a Client or use it as publication proof.
 * D must reauthorize again in its original queue before committing a receipt. */
export interface TeamAssetFileAuthority {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface TeamAssetFileOperation<T> {
  readonly result: Promise<T>;
  /** This operation's actual provider/iterator cleanup, including late work. */
  readonly drain: Promise<void>;
}
export type TeamAssetFileErrorCode =
  'invalid' | 'cancelled' | 'unavailable' | 'limit' | 'unsupported' | 'digest-mismatch' | 'timeout';
export class TeamAssetFileError extends Error {
  constructor(readonly code: TeamAssetFileErrorCode) {
    super('团队文件操作未完成。');
    this.name = 'TeamAssetFileError';
  }
}
const textRangeSchema = z.strictObject({
  offset: z.number().int().nonnegative().refine(Number.isSafeInteger),
  length: z.number().int().positive().max(8192).refine(Number.isSafeInteger),
});
const normalizeError = (error: unknown, signal: AbortSignal): TeamAssetFileError => {
  if (signal.aborted) return new TeamAssetFileError('cancelled');
  if (error instanceof TeamAssetFileError) return error;
  if (error instanceof ArtifactUploadError) {
    if (error.code === 'digest-mismatch') return new TeamAssetFileError('digest-mismatch');
    if (error.code === 'upload-timeout' || error.code === 'file-timeout')
      return new TeamAssetFileError('timeout');
    if (error.code === 'file-too-large') return new TeamAssetFileError('limit');
    if (error.code === 'cancelled') return new TeamAssetFileError('cancelled');
  }
  return new TeamAssetFileError('unavailable');
};

/** No domain, file table, background task or I/O at construction. All bytes use
 * the original attachment store and #33 verifier. Failed business commits leave
 * an unreferenced content-addressed blob, never a successful asset/upload fact.
 * A retry may reuse identical bytes; this carrier never deletes shared blobs. */
export class TeamAssetFileBytes {
  private readonly lifetime = new AbortController();
  private readonly jobs = new Set<Promise<unknown>>();
  private uploads = 0;
  private reads = 0;
  private closing: Promise<void> | undefined;
  constructor(private readonly attachments: AttachmentStore) {}

  private retain(job: Promise<unknown>): void {
    this.jobs.add(job);
    void job.then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job),
    );
  }
  private access(authority: TeamAssetFileAuthority) {
    if (!authority || typeof authority.assertCurrent !== 'function' || !authority.signal)
      throw new TeamAssetFileError('invalid');
    const signal = AbortSignal.any([authority.signal, this.lifetime.signal]);
    const check = () => {
      if (signal.aborted) throw new TeamAssetFileError('cancelled');
      try {
        authority.assertCurrent();
      } catch {
        throw new TeamAssetFileError('unavailable');
      }
      if (signal.aborted) throw new TeamAssetFileError('cancelled');
    };
    check();
    return { signal, check };
  }
  private run<T>(
    kind: 'uploads' | 'reads',
    operation: (retainDrain: (drain: Promise<unknown>) => void) => Promise<T>,
  ): TeamAssetFileOperation<T> {
    const refuse = (code: TeamAssetFileErrorCode) => ({
      result: Promise.reject<T>(new TeamAssetFileError(code)),
      drain: Promise.resolve(),
    });
    if (this.lifetime.signal.aborted) return refuse('cancelled');
    const limit =
      kind === 'uploads'
        ? ARTIFACT_FILE_LIMITS.maxConcurrentUploadsPerSpace
        : ARTIFACT_FILE_LIMITS.maxConcurrentReadsPerSpace;
    if (this[kind] >= limit) return refuse('limit');
    this[kind]++;
    const drains: Promise<unknown>[] = [];
    let resolveDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const task = (async () => {
      try {
        return await operation((drain) => drains.push(drain));
      } finally {
        // Logical abort is not physical cleanup. Capacity and close remain held
        // until even an ignored-abort provider/iterator actually settles.
        this.retain(
          Promise.allSettled(drains).then(() => {
            this[kind]--;
            resolveDrain();
          }),
        );
      }
    })();
    this.retain(task);
    return { result: task, drain };
  }
  save(
    raw: TeamAssetFileDeclare,
    source: AsyncIterable<Uint8Array>,
    authority: TeamAssetFileAuthority,
  ): Promise<TeamAssetFileBlob> {
    return this.saveTracked(raw, source, authority).result;
  }
  saveTracked(
    raw: TeamAssetFileDeclare,
    source: AsyncIterable<Uint8Array>,
    authority: TeamAssetFileAuthority,
  ): TeamAssetFileOperation<TeamAssetFileBlob> {
    return this.run('uploads', async (retainDrain) => {
      const { signal, check } = this.access(authority);
      const parsed = teamAssetFileDeclareSchema.safeParse(raw);
      if (!parsed.success) throw new TeamAssetFileError('invalid');
      const declaration = parsed.data;
      artifactFileLeaf(declaration.name);
      const stream = new ArtifactUploadStream(source, declaration, signal, check);
      try {
        const stored = await stream.wait(
          this.attachments.saveFileStream({
            data: stream,
            name: declaration.name,
            signal: stream.signal,
          }),
        );
        stream.check();
        if (
          !stream.verified ||
          stored.name !== declaration.name ||
          stored.bytes !== declaration.byteSize ||
          stored.attachmentId !== `sha256:${declaration.sha256}`
        )
          throw new TeamAssetFileError('unavailable');
        const blob = teamAssetFileBlobSchema.parse({
          ...declaration,
          attachmentId: stored.attachmentId,
        });
        // A provider receipt alone is insufficient: re-read the stored object
        // through the original complete-stream verifier before issuing bytes.
        const read = readVerifiedArtifactFile({
          attachments: this.attachments,
          record: { ...blob, state: 'completed' },
          signal,
          assertCurrent: check,
          collect: false,
        });
        retainDrain(read.drain);
        await read.result;
        check();
        return blob;
      } catch (error) {
        throw normalizeError(error, signal);
      } finally {
        stream.finish();
        retainDrain(stream.drain());
      }
    });
  }
  read(raw: TeamAssetFileBlob, authority: TeamAssetFileAuthority): Promise<Uint8Array> {
    return this.readTracked(raw, authority).result;
  }
  readTracked(
    raw: TeamAssetFileBlob,
    authority: TeamAssetFileAuthority,
  ): TeamAssetFileOperation<Uint8Array> {
    return this.run('reads', async (retainDrain) => {
      const { signal, check } = this.access(authority);
      const parsed = teamAssetFileBlobSchema.safeParse(raw);
      if (!parsed.success) throw new TeamAssetFileError('invalid');
      artifactFileLeaf(parsed.data.name);
      try {
        const read = readVerifiedArtifactFile({
          attachments: this.attachments,
          record: { ...parsed.data, state: 'completed' },
          signal,
          assertCurrent: check,
          collect: true,
        });
        retainDrain(read.drain);
        const bytes = await read.result;
        check();
        if (!bytes) throw new TeamAssetFileError('unavailable');
        return bytes;
      } catch (error) {
        throw normalizeError(error, signal);
      }
    });
  }
  /** Same-body replay still validates this request's actual stream. It creates
   * neither new bytes nor another logical business receipt. */
  verifyReplay(
    raw: TeamAssetFileDeclare,
    source: AsyncIterable<Uint8Array>,
    authority: TeamAssetFileAuthority,
  ): TeamAssetFileOperation<TeamAssetFileDeclare> {
    return this.run('uploads', async (retainDrain) => {
      const { signal, check } = this.access(authority);
      const parsed = teamAssetFileDeclareSchema.safeParse(raw);
      if (!parsed.success) throw new TeamAssetFileError('invalid');
      artifactFileLeaf(parsed.data.name);
      const stream = new ArtifactUploadStream(source, parsed.data, signal, check);
      try {
        for await (const _chunk of stream) {
          /* original EOS verifier consumes bounded bytes */
        }
        stream.check();
        return parsed.data;
      } catch (error) {
        throw normalizeError(error, signal);
      } finally {
        stream.finish();
        retainDrain(stream.drain());
      }
    });
  }
  text(
    raw: TeamAssetFileBlob,
    query: { offset: number; length: number },
    authority: TeamAssetFileAuthority,
  ) {
    return this.textTracked(raw, query, authority).result;
  }
  textTracked(
    raw: TeamAssetFileBlob,
    query: { offset: number; length: number },
    authority: TeamAssetFileAuthority,
  ) {
    const parsed = teamAssetFileBlobSchema.safeParse(raw);
    const range = textRangeSchema.safeParse(query);
    if (!parsed.success || !range.success)
      return {
        result: Promise.reject(new TeamAssetFileError('invalid')),
        drain: Promise.resolve(),
      };
    const blob = parsed.data;
    const operation = this.readTracked(blob, authority);
    const result = operation.result.then((bytes) => {
      const { check } = this.access(authority);
      check();
      try {
        const value = sliceTeamAssetUtf8(bytes, range.data);
        check();
        return { ...value, checksum: blob.sha256 };
      } catch (error) {
        if (error instanceof TeamAssetFileError) throw error;
        throw new TeamAssetFileError('unsupported');
      }
    });
    return { result, drain: operation.drain };
  }
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.idle();
    })());
  }
}

/** Pure byte slicing after the caller's complete-object integrity check. Never
 * decodes only a valid prefix of an otherwise invalid UTF-8 original. */
export function sliceTeamAssetUtf8(bytes: Uint8Array, query: { offset: number; length: number }) {
  const parsed = textRangeSchema.safeParse(query);
  if (!parsed.success) throw new TeamAssetFileError('invalid');
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const { offset, length } = parsed.data;
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80))
      throw new TeamAssetFileError('invalid');
    let end = Math.min(offset + length, bytes.length);
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === offset && offset < bytes.length) throw new TeamAssetFileError('invalid');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(offset, end),
    );
    return { text, offset, length: end - offset, nextOffset: end, totalBytes: bytes.length };
  } catch (error) {
    if (error instanceof TeamAssetFileError) throw error;
    throw new TeamAssetFileError('unsupported');
  }
}
