import type {
  MemberAssetDefinition,
  MemberAssetLegacySource,
  MemberAssetLegacySummary,
  MemberAssetLegacySourceValue,
} from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';

export interface MemberAssetSourceItem {
  readonly summary: MemberAssetLegacySummary;
  readonly definition: MemberAssetDefinition;
  readonly requirements: readonly { readonly slotId: string; readonly kind: 'skill' | 'mcp' }[];
}
/** Host-private source snapshot, issued only after original MemberWorkbench.scope
 * and its post-await revalidation. It is never a new owner or file grant. */
export interface MemberAssetSourceSnapshot {
  readonly actorId: string;
  readonly spaceId: string;
  readonly items: readonly MemberAssetSourceItem[];
}
export type MemberAssetSourceProvider = (
  request: MemberRequest,
  query: { readonly spaceId: string },
  signal: AbortSignal,
) => Promise<MemberAssetSourceSnapshot>;

export interface MemberAssetLegacyAuthority {
  sources(
    request: MemberRequest,
    query: { readonly spaceId: string },
    signal: AbortSignal,
  ): Promise<{
    readonly actorId: string;
    readonly spaceId: string;
    readonly items: readonly MemberAssetLegacySummary[];
  }>;
  source(
    request: MemberRequest,
    source: MemberAssetLegacySource,
    signal: AbortSignal,
  ): Promise<MemberAssetLegacySourceValue>;
}
