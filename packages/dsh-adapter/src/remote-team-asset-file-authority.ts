import type {
  MemberAssetReference,
  MemberAssetFileDeclare,
  RemoteRunScope,
} from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';

/** Original RemoteRunAuthorities owns identity, authority, inputReads and cleanup.
 * Never accept a decoded instance as a grant or return request headers to a Client. */
export interface RemoteTeamAssetFileReadGrant {
  readonly scope: RemoteRunScope;
  readonly reference: MemberAssetReference;
  readonly file: MemberAssetFileDeclare;
  readonly request: MemberRequest;
  readonly signal: AbortSignal;
  check(): void;
  /** Exactly one real producer drain, including its HTTP output termination.
   * Repeated calls join that same cleanup; cancellation alone never releases. */
  releaseAfter(drain: Promise<void>): Promise<void>;
}
