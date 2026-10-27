import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { NativeWorkGrant, NativeWorkScope } from './native-work-session-contract.js';
import type { NativeOutputFileSource, UploadFileRecord } from './artifact-files.js';

export {
  NATIVE_OUTPUT_FILE_TOOL,
  NATIVE_OUTPUT_FILE_VERSION,
} from './native-work-session-output-file-tool.js';
export type { NativeOutputFileSource } from './artifact-files.js';

/** Explicit Host grant to publish into THIS task space, independent of FS read. */
export interface NativeOutputPublicationAuthority {
  readonly scope: NativeWorkScope;
  readonly configurationId: string;
  readonly signal: AbortSignal;
  readonly paths: readonly { readonly kind: 'file' | 'directory'; readonly path: string }[];
  assertCurrent(relativePath: string): undefined;
}
export interface NativeOutputFileResourceSource {
  readonly signal: AbortSignal;
  assertCurrent(attachments: AttachmentStore): undefined;
  /** Original per-publication authority, synchronously rechecked before persistence. */
  assertPublication(
    grant: NativeWorkGrant,
    source: NativeOutputFileSource,
    selectorFingerprint: string,
  ): undefined;
}
export interface NativeOutputFileReservation {
  readonly signal: AbortSignal;
  readonly drain: Promise<void>;
  readonly completed?: UploadFileRecord;
  check(): undefined;
  publish(input: {
    readonly mediaType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly data: AsyncIterable<Uint8Array>;
  }): Promise<UploadFileRecord>;
  /** Exactly once; physical FS and SDK drain both precede releasing the shared slot. */
  releaseAfter(drain: Promise<void>): void;
}
export interface NativeRunOutputFiles {
  /** Original history/open grant only; no new publication, FS access or reservation. */
  readCompleted(
    grant: NativeWorkGrant,
    request: { readonly source: NativeOutputFileSource; readonly publicationId: string },
    signal: AbortSignal,
  ): Promise<NativeCompletedPublicationLease>;
  reserve(
    grant: NativeWorkGrant,
    request: {
      readonly source: NativeOutputFileSource;
      readonly selectorFingerprint: string;
      readonly name: string;
    } & ({ readonly mode: 'lookup' } | { readonly mode: 'reserve'; readonly maximumBytes: number }),
    signal: AbortSignal,
  ): Promise<NativeOutputFileReservation>;
}
export interface NativeCompletedPublicationLease {
  readonly source: NativeOutputFileSource;
  readonly record: UploadFileRecord;
  readonly signal: AbortSignal;
  check(): undefined;
}
declare const publishedFileBrand: unique symbol;
export interface NativePublishedFileRef {
  readonly [publishedFileBrand]: true;
}
export interface NativePublishedFileLease {
  readonly source: NativeOutputFileSource;
  readonly record: UploadFileRecord;
  readonly signal: AbortSignal;
  check(): undefined;
}
