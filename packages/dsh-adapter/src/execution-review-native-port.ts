import type { NativeFixedReviewIssuer } from './native-work-session-result.js';
import type { NativeWorkGrant, NativeScopeCleanupResult } from './native-work-session-contract.js';
import type {
  ExecutionReviewDriveGrant,
  ExecutionReviewCleanupAuthority,
} from './execution-review-drive-authority.js';
import type { NativeFixedReviewPreparation } from './native-work-session-review-contract.js';
import type {
  ExecutionReviewFixedReceipt,
  ExecutionReviewFailure,
} from './execution-review-fixed-result.js';

type Cleanup = { readonly cleanup?: 'pending' | 'settled' | 'failed' };
export type ExecutionReviewNativeOutcome = Cleanup &
  (
    | {
        readonly status: 'pending';
        readonly reason: Extract<NativeFixedReviewPreparation, { status: 'pending' }>['reason'];
      }
    | { readonly status: 'committed' | 'confirmed'; readonly receipt: ExecutionReviewFixedReceipt }
    | { readonly status: 'needs-attention'; readonly failure: ExecutionReviewFailure }
  );

/** A installs views of the one original C owner, never a replacement factory.
 * Its NativeReviewPorts must authenticate D objects through this same Service. */
export interface ExecutionReviewNativePorts {
  readonly issuer: NativeFixedReviewIssuer;
  grantFor(original: ExecutionReviewDriveGrant): NativeWorkGrant;
  retireForCleanup(
    original: ExecutionReviewCleanupAuthority,
    wait: AbortSignal,
  ): Promise<NativeScopeCleanupResult>;
}
