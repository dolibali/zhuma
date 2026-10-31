import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MemberAssetFileDeclareSchema, type MemberAssetFileDeclare } from '@zhuma/agent-core';
import { TeamAssetFileError } from './team-asset-file.js';

/** An opaque byte proof only. Neither this identity nor a checksum authorizes
 * an actor, space, Run or file. No raw buffer or persistent token is exposed. */
export interface VerifiedTeamAssetFile {
  readonly kind: 'team-asset-verified-bytes';
  readonly byteSize: number;
  readonly sha256: string;
}
const values = new WeakMap<
  VerifiedTeamAssetFile,
  {
    readonly file: Readonly<MemberAssetFileDeclare>;
    readonly bytes: Uint8Array;
    readonly utf8: boolean;
  }
>();
const rangeSchema = z.strictObject({
  offset: z.number().int().nonnegative().refine(Number.isSafeInteger),
  length: z.number().int().positive().max(8192),
});
function original(carrier: VerifiedTeamAssetFile) {
  const value = values.get(carrier);
  if (!value) throw new TeamAssetFileError('invalid');
  return value;
}
/** Copy once BEFORE hashing, so later mutation of even a shared caller buffer
 * cannot change the proof. Whole UTF-8 validation is streamed once with bounded
 * temporary strings; future slices never hash/copy/decode the whole object. */
export function createVerifiedTeamAssetFile(
  raw: MemberAssetFileDeclare,
  input: Uint8Array,
): VerifiedTeamAssetFile {
  const parsed = MemberAssetFileDeclareSchema.safeParse(raw);
  if (!parsed.success || !(input instanceof Uint8Array)) throw new TeamAssetFileError('invalid');
  if (input.byteLength !== parsed.data.byteSize) throw new TeamAssetFileError('digest-mismatch');
  const bytes = Uint8Array.from(input);
  if (createHash('sha256').update(bytes).digest('hex') !== parsed.data.sha256)
    throw new TeamAssetFileError('digest-mismatch');
  let utf8 = true;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (let offset = 0; offset < bytes.byteLength; offset += 65536)
      decoder.decode(bytes.subarray(offset, Math.min(offset + 65536, bytes.byteLength)), {
        stream: true,
      });
    decoder.decode();
  } catch {
    utf8 = false;
  }
  const file = Object.freeze({ ...parsed.data });
  const carrier: VerifiedTeamAssetFile = Object.freeze({
    kind: 'team-asset-verified-bytes',
    byteSize: file.byteSize,
    sha256: file.sha256,
  });
  values.set(carrier, { file, bytes, utf8 });
  return carrier;
}
export function verifiedTeamAssetFileInfo(carrier: VerifiedTeamAssetFile): MemberAssetFileDeclare {
  return { ...original(carrier).file };
}
/** Only an immutable string and accurate bounded byte coordinates leave the
 * private carrier. Discovery/reading still require the caller's fresh grants. */
export function readVerifiedTeamAssetText(
  carrier: VerifiedTeamAssetFile,
  raw: { offset: number; length: number },
) {
  const value = original(carrier),
    range = rangeSchema.safeParse(raw);
  if (!range.success) throw new TeamAssetFileError('invalid');
  if (!value.utf8) throw new TeamAssetFileError('unsupported');
  const { bytes } = value,
    { offset, length } = range.data;
  if (offset > bytes.byteLength || (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80))
    throw new TeamAssetFileError('invalid');
  let end = Math.min(offset + length, bytes.byteLength);
  while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
  if (end === offset && offset < bytes.byteLength) throw new TeamAssetFileError('invalid');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(offset, end),
  );
  return { text, offset, length: end - offset, nextOffset: end, totalBytes: bytes.byteLength };
}
