import { canonicalPayload, isTerminalRunStatus, type ExecutionNodeRecord } from '@zhuma/agent-core';
import {
  ExecutionRunError,
  currentExecutionRun,
  executionRunScope,
  readExecutionRunState,
} from './execution-run-state.js';
import type {
  NativeMigrationOriginRequest,
  NativeScopeCleanupAuthority,
  NativeScopeCleanupResult,
  NativeWorkGrant,
  NativeWorkScope,
} from './native-work-session-contract.js';
import { NativeWorkError } from './native-work-session-contract.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import type { ExecutionRunAuthorities } from './execution-run-authority.js';
import { nativeScopeKey } from './native-work-session-record.js';
import { ExecutionWorkflowError } from './execution-workflow-contract.js';
import type { WorkflowLocation, WorkflowStartReservation } from './execution-workflow-contract.js';

/** Original reservation metadata only; this cannot authorize or certify a drain. */
export function hostWorkflowRecoveryBinding(
  node: ExecutionNodeRecord | undefined,
  reservation: WorkflowStartReservation,
  location: WorkflowLocation,
  actorId: string,
) {
  const state = node && readExecutionRunState(node);
  const receipt = state?.receipts.find((item) => item.requestId === reservation.requestId);
  const run = receipt && state?.runs.find((item) => item.attempt.id === receipt.runId);
  const current = node && currentExecutionRun(node);
  if (
    !node ||
    !run ||
    !current ||
    node.taskId !== location.taskId ||
    node.planId !== location.planId ||
    node.revision !== location.revision ||
    node.nodeId !== reservation.nodeId ||
    run.attempt.id !== reservation.newRunId ||
    run.segmentId !== reservation.newSegmentId ||
    [run, current].some(
      (item) =>
        item.actorId !== actorId ||
        item.spaceId !== location.spaceId ||
        item.resources !== 'settled' ||
        !isTerminalRunStatus(item.attempt.status),
    ) ||
    current.attempt.generation < run.attempt.generation ||
    run.dispatch !== 'received' ||
    !run.attempt.acknowledged ||
    !run.attempt.sessionId ||
    !run.attempt.executorRunId
  )
    throw new ExecutionWorkflowError('workflow-recovery-required');
  return {
    scope: executionRunScope(node, run),
    run,
    currentRunId: current.attempt.id,
    control: canonicalPayload({
      command: node.command,
      handoff: node.handoff,
      currentRoundId: node.currentRoundId,
      stateVersion: state!.version,
      run,
      current,
    }),
  };
}

/** Rebuild one original physical certificate outside the domain command queue.
 * Fresh authorization/target checks are supplied by the explicit Host command.
 */
export async function retireHostSettledScope(
  owner: Pick<NativeWorkSessionService, 'retireForCleanup'>,
  cleanup: NativeScopeCleanupAuthority,
  expected: { readonly nativeSessionId: string; readonly nativeAgentId: string },
  signal: AbortSignal,
  fresh: () => Promise<void>,
  drainResources: () => Promise<void>,
): Promise<Extract<NativeScopeCleanupResult, { readonly status: 'retired' }>> {
  const check = () => {
    signal.throwIfAborted();
    cleanup.assertCurrent();
  };
  check();
  await fresh();
  check();
  const result = await owner.retireForCleanup(cleanup, signal);
  check();
  await fresh();
  check();
  if (
    result.status !== 'retired' ||
    !result.binding ||
    nativeScopeKey(result.binding.scope) !== nativeScopeKey(cleanup.scope) ||
    result.binding.nativeSessionId !== expected.nativeSessionId ||
    result.binding.nativeAgentId !== expected.nativeAgentId ||
    result.drain.basis !== 'flushed-and-closed'
  )
    throw new ExecutionRunError('run-migration-pending');
  result.drain.assertCurrent();
  await drainResources();
  await fresh();
  check();
  result.drain.assertCurrent();
  return result;
}

/** A retained observation from this one C owner, never persisted or accepted from a client. */
export interface HostAbsentRetirement {
  readonly owner: object;
  readonly scope: NativeWorkScope;
  readonly result: Extract<NativeScopeCleanupResult, { readonly status: 'retired' }>;
}

/** A missing locator is only eligibility to ask the same C owner for a real
 * absence drain. Neither the lookup nor D's derived authority proves absence.
 */
export async function retireHostUnadmittedScope(
  owner: Pick<NativeWorkSessionService, 'migrationOrigin' | 'retireForCleanup'>,
  authorities: Pick<ExecutionRunAuthorities, 'assertGrant' | 'unadmittedCleanup'>,
  ownerSignal: AbortSignal,
  grant: NativeWorkGrant,
  previousScope: NativeWorkScope,
  query: NativeMigrationOriginRequest,
): Promise<HostAbsentRetirement | undefined> {
  ownerSignal.throwIfAborted();
  authorities.assertGrant(grant, 'send');
  if (canonicalPayload(query.scope) !== canonicalPayload(grant.scope))
    throw new ExecutionRunError('run-recovery-unavailable');
  try {
    owner.migrationOrigin(query);
    return undefined;
  } catch (error) {
    if (!(error instanceof NativeWorkError) || error.code !== 'not-started') throw error;
  }
  const cleanup = authorities.unadmittedCleanup(grant);
  cleanup.assertCurrent();
  if (canonicalPayload(cleanup.scope) !== canonicalPayload(previousScope))
    throw new ExecutionRunError('run-recovery-unavailable');
  const result = await owner.retireForCleanup(cleanup, cleanup.signal);
  ownerSignal.throwIfAborted();
  cleanup.assertCurrent();
  authorities.assertGrant(grant, 'send');
  if (
    result.status !== 'retired' ||
    result.binding !== undefined ||
    result.drain.basis !== 'absent-unadmitted'
  )
    throw new ExecutionRunError('run-recovery-unavailable');
  result.drain.assertCurrent();
  return { owner, scope: cleanup.scope, result };
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
