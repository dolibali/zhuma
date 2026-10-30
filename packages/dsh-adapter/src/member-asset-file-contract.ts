import type { Workbench } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';

// Derive the internal carrier types from the one original asset fact schema.
type AssetRecord = NonNullable<Workbench['memberAssets']>[number];
export type MemberAssetFileBlob = NonNullable<AssetRecord['uploads'][number]['blob']>;
export type MemberAssetFileDeclare = AssetRecord['uploads'][number]['declare'];
export interface MemberAssetFileReserve {
  readonly spaceId: string;
  readonly assetId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly declare: MemberAssetFileDeclare;
}
export interface MemberAssetFileRead {
  readonly spaceId: string;
  readonly assetId: string;
  readonly versionId: string;
}
export interface MemberAssetFileGrant {
  readonly signal: AbortSignal;
  /** Original live member + full asset/version source. Check each byte boundary. */
  assertCurrent(): void;
}
/** Shape alone grants nothing; the original D owner recognizes its retained identity. */
export interface MemberAssetFileTicket {
  readonly kind: 'member-asset-file-ticket';
}
export interface MemberAssetFileReceipt {
  readonly spaceId: string;
  readonly assetId: string;
  readonly idempotencyKey: string;
  readonly assetVersion: number;
  readonly file: MemberAssetFileDeclare;
}
/** Host-internal D authority, not a renderer/API payload or a second file store. */
export interface MemberAssetFileAuthority {
  /** Original queue persists a bounded logical reservation before any bytes start.
   * Same body/key reopens a pending upload or returns its fixed committed receipt.
   * Replay retains a grant/ticket too: E verifies this request's actual stream
   * through EOS/length/SHA before returning that receipt, then abortFile releases it.
   * A changed body/key, current version, scope or owner cannot reuse the reservation. */
  reserveFile(
    request: MemberRequest,
    input: MemberAssetFileReserve,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: 'reserved';
        readonly ticket: MemberAssetFileTicket;
        readonly grant: MemberAssetFileGrant;
      }
    | {
        readonly kind: 'replayed';
        readonly receipt: MemberAssetFileReceipt;
        readonly ticket: MemberAssetFileTicket;
        readonly grant: MemberAssetFileGrant;
      }
  >;
  /** E calls only after EOS, exact length/SHA and original attachment verification.
   * D reauthorizes and performs original-row CAS/metadata/idempotency checks.
   * A failed commit never becomes success: unreferenced content-addressed bytes
   * stay under the original attachment retention policy, never eagerly deleted. */
  commitFile(
    ticket: MemberAssetFileTicket,
    blob: MemberAssetFileBlob,
  ): Promise<MemberAssetFileReceipt>;
  /** E calls after its physical stream settles, including on failure/cancellation.
   * Releases only retained occupancy/lease, never invents a committed receipt. */
  abortFile(ticket: MemberAssetFileTicket): Promise<void>;
  /** Exact published version only, even after removal/replacement of a draft.
   * E must fully verify original bytes before returning content or an original file. */
  readFile(
    request: MemberRequest,
    input: MemberAssetFileRead,
    signal: AbortSignal,
  ): Promise<{
    readonly blob: MemberAssetFileBlob;
    readonly grant: MemberAssetFileGrant;
    release(): void;
  }>;
}
