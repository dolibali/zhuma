import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPayload, type ExecutionNodeRecord } from '@zhuma/agent-core';
import {
  ExecutionReviewError,
  executionReviewScopeSchema,
  type ExecutionReviewAttempt,
  type ExecutionReviewScope,
} from './execution-review-contract.js';
import {
  readExecutionReviewComposition,
  type FrozenExecutionReviewComposition,
} from './execution-review-composition.js';
import {
  executionReviewTarget,
  readExecutionReviewState,
  type ExecutionReviewNode,
} from './execution-review-state.js';

const positive = z.number().int().positive().refine(Number.isSafeInteger);
const id = z.string().min(1).max(200);
const eventFields = { scope: executionReviewScopeSchema, sequence: positive };
const nativeIds = { nativeSessionId: id, nativeAgentId: id };
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventFields, kind: z.literal('received'), ...nativeIds }),
  z.strictObject({ ...eventFields, kind: z.literal('accepted'), ...nativeIds }),
  z.strictObject({ ...eventFields, kind: z.literal('dispatch-unknown') }),
  z.strictObject({ ...eventFields, kind: z.literal('idle') }),
  z.strictObject({ ...eventFields, kind: z.literal('stop-requested') }),
  z.strictObject({ ...eventFields, kind: z.literal('stopped') }),
  z.strictObject({ ...eventFields, kind: z.literal('completed') }),
  z.strictObject({ ...eventFields, kind: z.literal('failed') }),
  z.strictObject({ ...eventFields, kind: z.literal('cleanup') }),
]);
export type ExecutionReviewEvent = z.infer<typeof eventSchema>;
type AdmittedReviewAttempt = Exclude<ExecutionReviewAttempt, { status: 'prepared' }>;
export interface ExecutionReviewDecision {
  readonly disposition: 'applied' | 'replayed' | 'ignored';
  readonly record: ExecutionReviewNode;
  readonly attempt: ExecutionReviewAttempt;
}
function refuse(code: ConstructorParameters<typeof ExecutionReviewError>[0]): never {
  throw new ExecutionReviewError(code);
}
function hash(value: unknown) {
  return createHash('sha256').update(canonicalPayload(value)).digest('hex');
}
function current(record: ExecutionNodeRecord, rawScope: ExecutionReviewScope) {
  const parsed = executionReviewScopeSchema.safeParse(rawScope);
  if (!parsed.success) return refuse('review-validation');
  const state = readExecutionReviewState(record);
  const attempt = state?.attempts.find((item) => item.scope.runId === parsed.data.runId);
  if (!state || !attempt || canonicalPayload(attempt.scope) !== canonicalPayload(parsed.data))
    return refuse('review-not-prepared');
  return { state, attempt };
}
function replace(
  record: ExecutionNodeRecord,
  attempt: ExecutionReviewAttempt,
): ExecutionReviewDecision {
  const { state } = current(record, attempt.scope);
  const native = (record as ExecutionReviewNode).nativeExecution;
  const next: ExecutionReviewNode = {
    ...record,
    nativeExecution: {
      ...native,
      review: {
        ...state,
        version: state.version + 1,
        attempts: state.attempts.map((item) =>
          item.scope.runId === attempt.scope.runId ? attempt : item,
        ),
      },
    },
  };
  readExecutionReviewState(next);
  return { disposition: 'applied', record: next, attempt };
}
function unchanged(
  record: ExecutionNodeRecord,
  attempt: ExecutionReviewAttempt,
  disposition: 'replayed' | 'ignored',
): ExecutionReviewDecision {
  return { disposition, record: record as ExecutionReviewNode, attempt };
}
/** Pure state transition only. The original Service must first qualify the real
 * A configuration source; a serialized composition is never dispatch authority. */
export function admitExecutionReview(
  record: ExecutionNodeRecord,
  input: {
    readonly scope: ExecutionReviewScope;
    readonly expectedAttemptVersion: number;
    readonly composition: FrozenExecutionReviewComposition;
  },
): ExecutionReviewDecision {
  const { attempt } = current(record, input.scope);
  const composition = readExecutionReviewComposition(input.composition);
  if (
    canonicalPayload(composition.payload.scope) !== canonicalPayload(attempt.scope) ||
    composition.configurationId !== attempt.configurationId ||
    canonicalPayload(executionReviewTarget(record, attempt.scope.spaceId)) !==
      canonicalPayload(attempt.scope.review.target)
  )
    return refuse('review-target-stale');
  if (attempt.status !== 'prepared') {
    if (canonicalPayload(attempt.composition) !== canonicalPayload(composition))
      return refuse('review-conflict');
    return unchanged(record, attempt, 'replayed');
  }
  if (input.expectedAttemptVersion !== attempt.version) return refuse('review-conflict');
  return replace(record, {
    ...attempt,
    version: attempt.version + 1,
    status: 'requested',
    composition,
    stopPhase: 'none',
    lastEventSequence: 0,
  });
}

/** Facts from the original native/cleanup bridge only, not Client/model JSON.
 * This helper cannot issue that bridge capability or a physical drain proof. */
export function recordExecutionReviewEvent(
  record: ExecutionNodeRecord,
  rawEvent: unknown,
): ExecutionReviewDecision {
  const parsed = eventSchema.safeParse(rawEvent);
  if (!parsed.success) return refuse('review-validation');
  const event = parsed.data;
  const { attempt, state } = current(record, event.scope);
  if (attempt.status === 'prepared') return refuse('review-not-admitted');
  const fingerprint = hash(event);
  if (attempt.lastEvent?.sequence === event.sequence) {
    if (attempt.lastEvent.fingerprint !== fingerprint) return refuse('review-event-mismatch');
    return unchanged(record, attempt, 'replayed');
  }
  if (event.sequence <= attempt.lastEventSequence) return unchanged(record, attempt, 'ignored');
  const terminal = ['completed', 'failed', 'cancelled'].includes(attempt.status);
  if (terminal && event.kind !== 'cleanup') return unchanged(record, attempt, 'ignored');
  let next: AdmittedReviewAttempt = { ...attempt };
  switch (event.kind) {
    case 'received':
    case 'accepted': {
      if (attempt.stopPhase !== 'none') return refuse('review-stopping');
      if (
        event.nativeSessionId !== event.nativeAgentId ||
        (attempt.nativeSessionId !== undefined &&
          attempt.nativeSessionId !== event.nativeSessionId) ||
        (attempt.nativeAgentId !== undefined && attempt.nativeAgentId !== event.nativeAgentId)
      )
        return refuse('review-session-mismatch');
      const borrowedIds = new Set([
        ...((record as ExecutionReviewNode).nativeExecution.runs ?? []).flatMap((run) => [
          run.attempt.sessionId,
          run.attempt.executorRunId,
        ]),
        ...state.attempts.flatMap((other) =>
          other.scope.runId === attempt.scope.runId || other.status === 'prepared'
            ? []
            : [other.nativeSessionId, other.nativeAgentId],
        ),
      ]);
      if (borrowedIds.has(event.nativeSessionId) || borrowedIds.has(event.nativeAgentId))
        return refuse('review-session-mismatch');
      next = {
        ...next,
        nativeSessionId: event.nativeSessionId,
        nativeAgentId: event.nativeAgentId,
        dispatch: 'received',
        ...(event.kind === 'accepted' ? { status: 'running' as const } : {}),
      };
      break;
    }
    case 'dispatch-unknown':
      next = { ...next, dispatch: 'unknown' };
      break;
    case 'idle':
      if (attempt.status !== 'running') return refuse('review-not-running');
      break; // A turn boundary is neither fixed completion nor a ballot.
    case 'stop-requested':
      next = { ...next, stopPhase: 'requested' };
      break;
    case 'stopped':
      if (attempt.stopPhase !== 'requested') return refuse('review-stop-not-requested');
      next = { ...next, status: 'cancelled', stopPhase: 'confirmed' };
      break;
    case 'completed':
      if (attempt.stopPhase !== 'none') return refuse('review-stopping');
      if (attempt.status !== 'running' || !attempt.nativeSessionId)
        return refuse('review-not-running');
      next = { ...next, status: 'completed' };
      break;
    case 'failed':
      next = { ...next, status: 'failed' };
      break;
    case 'cleanup':
      if (!terminal) return refuse('review-native-active');
      if (attempt.resources === 'settled') return unchanged(record, attempt, 'replayed');
      next = { ...next, resources: 'settled' };
      break;
  }
  return replace(record, {
    ...next,
    version: attempt.version + 1,
    lastEventSequence: event.sequence,
    lastEvent: { sequence: event.sequence, fingerprint },
  });
}
