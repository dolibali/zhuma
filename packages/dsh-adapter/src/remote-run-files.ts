import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalPayload,
  remoteFileValueSchema,
  type RemoteRunScope,
  type RemoteRunRequest,
  type RemoteRunOperationValue,
} from '@zhuma/agent-core';
import {
  ArtifactUploadError,
  artifactFileReference,
  type UploadFileRecord,
} from './artifact-files.js';
import type {
  ExecutionOutputFileGrant,
  ExecutionOutputFilePort,
} from './execution-output-file-port.js';
import type { NativeOutputFileReservation } from './native-work-session-output-file-contract.js';

/** The issuer authenticates object identity in a private WeakMap, never serialized fields. */
export interface RemoteRunFileGrant extends ExecutionOutputFileGrant {
  readonly remoteScope: RemoteRunScope;
  check(): undefined;
  cancel(): void;
}
export interface RemoteRunUpload {
  readonly data: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
}
type FileCommand = Extract<
  RemoteRunRequest,
  { operation: 'publish-file' | 'file-status' | 'abandon-file' }
>;
type FileValue = RemoteRunOperationValue<'publish-file'>;
type Entry = {
  readonly scope: RemoteRunScope;
  readonly key: string;
  readonly fingerprint: string;
  readonly name: string;
  readonly maximumBytes: number;
  readonly reservation: NativeOutputFileReservation;
  readonly grant: RemoteRunFileGrant;
  released: boolean;
  drained: boolean;
  publishing?: Promise<UploadFileRecord>;
  record?: UploadFileRecord;
};
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);
const nativeKey = (source: unknown) =>
  `native-output_${createHash('sha256').update(canonicalPayload(source)).digest('hex')}`;

/** Ephemeral handles only. All completed file facts remain in the original ArtifactFileStore. */
export class RemoteRunFiles {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly port: ExecutionOutputFilePort<RemoteRunFileGrant>,
    private readonly readRecord: (key: string) => UploadFileRecord | undefined,
  ) {}
  private completed(scope: RemoteRunScope, record: UploadFileRecord): FileValue {
    return remoteFileValueSchema.parse({
      scope,
      uploadId: record.uploadId,
      idempotencyKey: record.idempotencyKey,
      status: 'completed',
      file: artifactFileReference(record),
      record,
    });
  }
  private async originalCompleted(
    grant: RemoteRunFileGrant,
    expected: UploadFileRecord,
  ): Promise<FileValue> {
    grant.check();
    const record = this.readRecord(expected.uploadId);
    if (!record?.producer || !same(record, expected)) throw new ArtifactUploadError('not-found');
    const lease = await this.port.readCompleted(
      grant,
      { source: record.producer.source, publicationId: record.uploadId },
      grant.signal,
    );
    lease.check();
    if (!same(lease.record, expected)) throw new ArtifactUploadError('not-found');
    return this.completed(grant.remoteScope, lease.record);
  }
  private handle(grant: RemoteRunFileGrant, id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || !same(entry.scope, grant.remoteScope)) throw new ArtifactUploadError('not-found');
    return entry;
  }
  private projection(id: string, entry: Entry) {
    return {
      scope: entry.scope,
      reservationId: id,
      idempotencyKey: entry.key,
      status: entry.released ? ('released' as const) : ('reserved' as const),
      maximumBytes: entry.maximumBytes,
    };
  }
  private release(entry: Entry): void {
    if (entry.released) return;
    entry.released = true;
    entry.grant.cancel();
    // Called only on a signed C releaseAfter/whole-Run drained declaration, or a
    // closed backend. The original reservation also joins its actual SDK drain.
    entry.reservation.releaseAfter(Promise.resolve());
    void entry.reservation.drain.then(
      () => {
        entry.drained = true;
      },
      () => undefined,
    );
  }
  hasHeld(scope: RemoteRunScope): boolean {
    return [...this.entries.values()].some((entry) => same(entry.scope, scope) && !entry.drained);
  }
  async releaseDrained(scope: RemoteRunScope): Promise<void> {
    const entries = [...this.entries.values()].filter((entry) => same(entry.scope, scope));
    for (const entry of entries) this.release(entry);
    await Promise.all(entries.map((entry) => entry.reservation.drain));
  }
  /** Closing local IO is not certification that the remote Run has stopped. */
  fence(): void {
    for (const entry of this.entries.values()) this.release(entry);
  }
  async command(
    grant: RemoteRunFileGrant,
    body: FileCommand,
    upload?: RemoteRunUpload,
  ): Promise<FileValue> {
    grant.check();
    if (body.operation === 'abandon-file') {
      const entry = this.handle(grant, body.payload.reservationId);
      this.release(entry);
      await entry.reservation.drain;
      grant.check();
      return this.projection(body.payload.reservationId, entry);
    }
    if (body.operation === 'file-status') {
      const query = body.payload;
      if ('reservationId' in query) {
        const entry = this.handle(grant, query.reservationId);
        if (entry.record) return this.originalCompleted(grant, entry.record);
        return this.projection(query.reservationId, entry);
      }
      const record =
        'publicationId' in query
          ? this.readRecord(query.publicationId)
          : this.readRecord(query.idempotencyKey);
      if (
        !record ||
        ('idempotencyKey' in query && record.idempotencyKey !== query.idempotencyKey)
      ) {
        if ('idempotencyKey' in query)
          return {
            scope: grant.remoteScope,
            idempotencyKey: query.idempotencyKey,
            status: 'absent',
          };
        throw new ArtifactUploadError('not-found');
      }
      if (!record.producer || !same(record.producer.source.scope, grant.scope)) {
        if ('idempotencyKey' in query)
          return {
            scope: grant.remoteScope,
            idempotencyKey: query.idempotencyKey,
            status: 'absent',
          };
        throw new ArtifactUploadError('not-found');
      }
      if ('publicationId' in query && record.uploadId !== query.publicationId)
        throw new ArtifactUploadError('not-found');
      const lease = await this.port.readCompleted(
        grant,
        {
          source: 'source' in query ? query.source : record.producer.source,
          publicationId: record.uploadId,
        },
        grant.signal,
      );
      lease.check();
      return this.completed(grant.remoteScope, lease.record);
    }
    if (body.operation !== 'publish-file') throw new ArtifactUploadError('invalid-request');
    const publication = body.payload;
    if (publication.mode === 'publish') {
      const entry = this.handle(grant, publication.reservationId);
      if (
        publication.declare.name !== entry.name ||
        publication.declare.byteSize > entry.maximumBytes
      )
        throw new ArtifactUploadError('idempotency-mismatch');
      if (entry.record) {
        const actual = {
          name: entry.record.name,
          mediaType: entry.record.mediaType,
          byteSize: entry.record.byteSize,
          sha256: entry.record.sha256,
        };
        if (!same(publication.declare, actual))
          throw new ArtifactUploadError('idempotency-mismatch');
        return this.originalCompleted(grant, entry.record);
      }
      if (entry.released || entry.publishing) throw new ArtifactUploadError('conflict');
      if (
        !upload ||
        !(upload.signal instanceof AbortSignal) ||
        upload.signal.aborted ||
        !upload.data ||
        typeof upload.data[Symbol.asyncIterator] !== 'function'
      )
        throw new ArtifactUploadError('invalid-request');
      const iterator = upload.data[Symbol.asyncIterator]();
      const cancel = () => entry.grant.cancel();
      upload.signal.addEventListener('abort', cancel, { once: true });
      let byteSize = 0;
      const bytes: AsyncIterableIterator<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (upload.signal.aborted) throw new ArtifactUploadError('cancelled');
          // Original ArtifactUploadStream checks the retained issuer before
          // and after next(); this proxy adds only transport/length checks.
          const chunk = await iterator.next();
          if (upload.signal.aborted) throw new ArtifactUploadError('cancelled');
          if (!chunk.done) {
            if (!(chunk.value instanceof Uint8Array)) throw new ArtifactUploadError('validation');
            byteSize += chunk.value.byteLength;
            if (byteSize > publication.declare.byteSize)
              throw new ArtifactUploadError('validation');
          }
          return chunk;
        },
        // Preserve the HTTP reader's immediate cancellation even while next() is pending.
        return: () => iterator.return?.() ?? Promise.resolve({ done: true, value: undefined }),
      };
      const job = entry.reservation.publish({ ...publication.declare, data: bytes });
      entry.publishing = job;
      try {
        const record = await job;
        entry.record = record;
        grant.check();
        return this.completed(grant.remoteScope, record);
      } finally {
        upload.signal.removeEventListener('abort', cancel);
        delete entry.publishing;
      }
    }
    if (
      publication.idempotencyKey !== nativeKey(publication.source) ||
      !same(publication.source.scope, grant.scope)
    )
      throw new ArtifactUploadError('idempotency-mismatch');
    const fingerprint = canonicalPayload({
      source: publication.source,
      selectorFingerprint: publication.selectorFingerprint,
      name: publication.name,
    });
    const previous = [...this.entries.entries()].find(
      ([, entry]) =>
        same(entry.scope, grant.remoteScope) && entry.key === publication.idempotencyKey,
    );
    if (previous && !previous[1].record) {
      const [id, entry] = previous;
      if (
        entry.fingerprint !== fingerprint ||
        (publication.mode === 'reserve' && publication.maximumBytes !== entry.maximumBytes)
      )
        throw new ArtifactUploadError('idempotency-mismatch');
      return this.projection(id, entry);
    }
    if (this.entries.size >= 1024) {
      for (const [id, entry] of this.entries)
        if (entry.drained) {
          this.entries.delete(id);
          break;
        }
      if (this.entries.size >= 1024) throw new ArtifactUploadError('quota-exceeded');
    }
    let reservation: NativeOutputFileReservation;
    try {
      const selector = {
        source: publication.source,
        selectorFingerprint: publication.selectorFingerprint,
        name: publication.name,
      };
      const request =
        publication.mode === 'lookup'
          ? { ...selector, mode: publication.mode }
          : { ...selector, mode: publication.mode, maximumBytes: publication.maximumBytes };
      reservation = await this.port.reserve(grant, request, grant.signal);
    } catch (error) {
      if (
        publication.mode === 'lookup' &&
        error instanceof ArtifactUploadError &&
        error.code === 'not-found'
      )
        return {
          scope: grant.remoteScope,
          idempotencyKey: publication.idempotencyKey,
          status: 'absent',
        };
      throw error;
    }
    if (reservation.completed) {
      try {
        reservation.check();
        return this.completed(grant.remoteScope, reservation.completed);
      } finally {
        reservation.releaseAfter(Promise.resolve());
      }
    }
    if (publication.mode !== 'reserve') throw new ArtifactUploadError('not-found');
    const id = randomUUID();
    const entry: Entry = {
      scope: grant.remoteScope,
      key: publication.idempotencyKey,
      fingerprint,
      name: publication.name,
      maximumBytes: publication.maximumBytes,
      reservation,
      grant,
      released: false,
      drained: false,
    };
    this.entries.set(id, entry);
    return this.projection(id, entry);
  }
}
