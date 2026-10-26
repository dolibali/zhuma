import { z } from 'zod';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { NativeWorkGrant, NativeWorkScope } from './native-work-session-contract.js';

export const NATIVE_ACCEPTED_FILE_TOOL = 'read_accepted_file';

export const runFileListSchema = z.strictObject({
  inputRef: z.string().regex(/^input_[a-f0-9]{64}$/u),
});
export const runFileReadSchema = runFileListSchema.extend({
  fileId: z.string().min(1).max(200),
  offset: z.number().int().nonnegative().refine(Number.isSafeInteger),
  length: z.number().int().positive().max(16_384).refine(Number.isSafeInteger),
});
export interface NativeRunFileResourceSource {
  readonly signal: AbortSignal;
  /** Resource identity/lifecycle only. The original issuer independently authorizes. */
  assertCurrent(attachments: AttachmentStore): undefined;
}
export interface NativeRunFileSource {
  readonly scope: NativeWorkScope;
  readonly inputRef: string;
  readonly sourceNodeId: string;
  readonly artifactVersionId: string;
  readonly version: number;
}
export interface NativeRunFileInfo {
  readonly fileId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface NativeRunFileList extends NativeRunFileSource {
  readonly files: readonly NativeRunFileInfo[];
  /** Host-only; omit this function when serializing the data whitelist. */
  check(): void;
}
export interface NativeRunFilePage {
  readonly source: NativeRunFileSource & { readonly file: NativeRunFileInfo };
  readonly range: { readonly offset: number; readonly length: number; readonly total: number };
  readonly bytes: Uint8Array;
  /** Full verified object classification. A binary/PDF/image is never called text. */
  readonly encoding: 'utf-8' | 'binary';
  readonly signal: AbortSignal;
  check(): void;
  release(): void;
}
/** Host-only and bound to one ExecutionService and its original Run issuer. */
export interface NativeRunAcceptedFiles {
  list(grant: NativeWorkGrant, query: unknown, signal: AbortSignal): Promise<NativeRunFileList>;
  read(grant: NativeWorkGrant, query: unknown, signal: AbortSignal): Promise<NativeRunFilePage>;
}

/** No rendering/sniffed MIME claim: only accurately decodable UTF-8 may become model text. */
export function runFileEncoding(info: NativeRunFileInfo, bytes: Uint8Array): 'utf-8' | 'binary' {
  const type = info.mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    ![
      'text/plain',
      'text/markdown',
      'text/csv',
      'text/yaml',
      'application/json',
      'application/yaml',
    ].includes(type) ||
    /\.(?:pdf|png|jpe?g|gif|webp|zip|docx?|xlsx?|pptx?)$/iu.test(info.name) ||
    bytes.includes(0) ||
    new TextDecoder().decode(bytes.subarray(0, 8)).startsWith('%PDF-')
  )
    return 'binary';
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let offset = 0; offset < bytes.length; offset += 65536)
      decoder.decode(bytes.subarray(offset, offset + 65536), { stream: true });
    decoder.decode();
    return 'utf-8';
  } catch {
    return 'binary';
  }
}
