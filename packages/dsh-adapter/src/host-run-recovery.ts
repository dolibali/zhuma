import { canonicalPayload, type ExecutionNodeRecord } from '@zhuma/agent-core';
import {
  ExecutionRunError,
  executionRunScope,
  readExecutionRunState,
} from './execution-run-state.js';
import type {
  NativeScopeCleanupResult,
  NativeWorkGrant,
  NativeWorkScope,
} from './native-work-session-contract.js';

/** A retained observation from this one C owner, never persisted or accepted from a client. */
export interface HostAbsentRetirement {
  readonly owner: object;
  readonly scope: NativeWorkScope;
  readonly result: Extract<NativeScopeCleanupResult, { readonly status: 'retired' }>;
}

/** Content/physical-observation gate only. The caller must also check the new
 * drive grant with its original D manager before invoking canonical C.send.
 */
export function assertHostAbsentRetry(
  proof: HostAbsentRetirement,
  owner: object,
  ownerSignal: AbortSignal,
  previousScope: NativeWorkScope,
  node: ExecutionNodeRecord,
  grant: NativeWorkGrant,
): undefined {
  try {
    grant.assertCurrent('send');
    const previous = readExecutionRunState(node)?.runs.find(
      (run) => run.attempt.id === previousScope.runId,
    );
    if (
      ownerSignal.aborted ||
      grant.signal.aborted ||
      proof.owner !== owner ||
      proof.result.status !== 'retired' ||
      proof.result.binding !== undefined ||
      proof.result.drain.basis !== 'absent-unadmitted' ||
      canonicalPayload(proof.scope) !== canonicalPayload(previousScope) ||
      !previous ||
      canonicalPayload(executionRunScope(node, previous)) !== canonicalPayload(previousScope) ||
      previous.attempt.status !== 'failed' ||
      previous.resources !== 'settled' ||
      previous.attempt.acknowledged ||
      previous.attempt.sessionId !== undefined ||
      previous.attempt.executorRunId !== undefined ||
      grant.scope.runId === previousScope.runId ||
      grant.scope.segmentId === previousScope.segmentId ||
      grant.scope.generation <= previousScope.generation ||
      (['actorId', 'spaceId', 'taskId', 'planId', 'revision', 'nodeId'] as const).some(
        (key) => grant.scope[key] !== previousScope[key],
      )
    )
      throw Error('unavailable');
    proof.result.drain.assertCurrent();
    grant.assertCurrent('send');
    if (ownerSignal.aborted || grant.signal.aborted) throw Error('unavailable');
    return undefined;
  } catch {
    throw new ExecutionRunError('run-recovery-unavailable');
  }
}
