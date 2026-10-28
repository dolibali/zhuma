import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  acknowledgeRun,
  admitExecutionSignal,
  applyNodeTransitionCommand,
  canonicalPayload,
  isTerminalRunStatus,
  markRunWaiting,
  openRunAttempt,
  recoveryCommandFor,
  rejectStopReceipt,
  requestRunStop,
  resumeRunAfterInput,
  settleExecutionRun,
  type ExecutionAttempt,
  type ExecutionNodeRecord,
  type NodeTransition,
} from '@zhuma/agent-core';
import type { NativeSessionSelection, NativeWorkScope } from './native-work-session-contract.js';
import { requireExecutionRunWriter } from './execution-run-protocol.js';
import {
  executionRunCompositionSchema,
  assertParsedExecutionRunCompositionBinding,
} from './execution-run-composition.js';
import {
  executionNativeResultDeliverySchema,
  assertNativeResultDelivery,
} from './execution-native-result-delivery.js';
import {
  splitExecutionReviewRecord,
  assertExecutionReviewRecord,
} from './execution-review-record.js';
import type { ExecutionReviewState } from './execution-review-contract.js';
import { remoteRunBindingSchema } from './remote-run-authority-state.js';

// Host-internal facts only. This module neither authenticates a request nor writes storage.
const id = z.string().min(1).max(200);
const integer = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = integer.refine((n) => n > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const EXECUTION_RUN_LIMITS = Object.freeze({ runs: 64, receipts: 256 });
export const executionWorkspaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text-only') }),
  z.strictObject({
    kind: z.literal('local'),
    deviceId: id,
    rootId: id,
    grantId: id,
    generation: positive,
    access: z.enum(['read', 'write']),
  }),
]);
export type ExecutionWorkspace = z.infer<typeof executionWorkspaceSchema>;
const selectionSchema = z.strictObject({
  provider: id,
  model: id,
  reasoningEffort: id.optional(),
  maxTokens: positive.max(65_536),
  configurationId: id,
});
const attemptSchema = z
  .strictObject({
    id,
    nodeId: id,
    workflowVersionId: id,
    planRevision: positive,
    attempt: positive,
    generation: positive,
    executor: z.literal('dsh'),
    status: z.enum([
      'requested',
      'running',
      'waiting-for-input',
      'completed',
      'failed',
      'cancelled',
    ]),
    contextRefs: z.array(id).max(256),
    lastEventSequence: integer,
    idempotencyKey: id,
    payloadHash: digest,
    simulated: z.literal(false),
    acknowledged: z.boolean(),
    expertVersionId: id,
    configSnapshotId: id,
    stopPhase: z.enum(['none', 'requested', 'confirmed', 'receipt-rejected']),
    entryNodeStatus: z.enum(['ready', 'needs-revision']),
    sessionId: id.optional(),
    sessionDiscarded: z.literal(true).optional(),
    executorRunId: id.optional(),
    modelLabel: id.optional(),
  })
  .transform((value) => {
    const { sessionId, sessionDiscarded, executorRunId, modelLabel, ...fields } = value;
    return {
      ...fields,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(sessionDiscarded === undefined ? {} : { sessionDiscarded }),
      ...(executorRunId === undefined ? {} : { executorRunId }),
      ...(modelLabel === undefined ? {} : { modelLabel }),
    };
  });
const wrapperSchema = z.strictObject({
  attempt: attemptSchema,
  composition: executionRunCompositionSchema.optional(),
  resultDelivery: executionNativeResultDeliverySchema.optional(),
  remote: remoteRunBindingSchema.optional(),
  actorId: id,
  spaceId: id,
  segmentId: id,
  selection: selectionSchema,
  workspace: executionWorkspaceSchema,
  dispatch: z.enum(['reserved', 'received', 'unknown']),
  resources: z.enum(['held', 'settled']),
  lastEvent: z.strictObject({ sequence: positive, fingerprint: digest }).optional(),
});
const receiptSchema = z.strictObject({
  requestId: id,
  actorId: id,
  fingerprint: digest,
  runId: id,
});
export const nativeExecutionStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: positive,
  currentRunId: id,
  runs: z.array(wrapperSchema).min(1).max(EXECUTION_RUN_LIMITS.runs),
  receipts: z.array(receiptSchema).min(1).max(EXECUTION_RUN_LIMITS.receipts),
});
export type ExecutionRunState = z.infer<typeof nativeExecutionStateSchema>;
export type ExecutionRun = z.infer<typeof wrapperSchema>;
export type ExecutionRunNode = ExecutionNodeRecord & {
  readonly nativeExecution?:
    | ExecutionRunState
    | (Omit<ExecutionRunState, 'schemaVersion'> & {
        readonly schemaVersion: 2;
        readonly review: ExecutionReviewState;
      });
};

export const EXECUTION_RUN_ERRORS = [
  'run-validation',
  'run-state-invalid',
  'run-not-controller',
  'run-idempotency-mismatch',
  'run-conflict',
  'run-capacity',
  'run-active',
  'run-id-conflict',
  'run-workspace-busy',
  'run-recovery-unavailable',
  'run-entry-invalid',
  'run-node-transition',
  'run-not-started',
  'run-scope-mismatch',
  'run-terminal',
  'run-event-mismatch',
  'run-session-mismatch',
  'run-stopping',
  'run-not-running',
  'run-not-waiting',
  'run-stop-not-requested',
  'run-not-acknowledged',
  'run-not-terminal',
  'run-effect-unknown',
  'run-authority-denied',
  'run-authority-unavailable',
  'run-migration-pending',
] as const;
type OpenFailure = Extract<ReturnType<typeof openRunAttempt>, { ok: false }>['code'];
type SettleFailure = Extract<ReturnType<typeof settleExecutionRun>, { ok: false }>['code'];
export type ExecutionRunErrorCode =
  (typeof EXECUTION_RUN_ERRORS)[number] | `run-${OpenFailure | SettleFailure}`;
export class ExecutionRunError extends Error {
  constructor(readonly code: ExecutionRunErrorCode) {
    super('本地运行操作未完成。');
    this.name = 'ExecutionRunError';
  }
}
function refuse(code: ExecutionRunErrorCode): never {
  throw new ExecutionRunError(code);
}
function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  return value.success ? value.data : refuse('run-validation');
}

/** Missing is legacy; present-but-invalid is never interpreted as an empty Run list. */
export function readExecutionRunState(record: ExecutionNodeRecord): ExecutionRunState | undefined {
  if (!Object.hasOwn(record, 'nativeExecution')) return undefined;
  let raw: unknown;
  let review: ReturnType<typeof splitExecutionReviewRecord>['review'];
  try {
    ({ author: raw, review } = splitExecutionReviewRecord(record));
    if (review && raw === undefined) {
      assertExecutionReviewRecord(record, review, undefined, EXECUTION_RUN_LIMITS.runs);
      return undefined;
    }
  } catch {
    return refuse('run-state-invalid');
  }
  const parsed = nativeExecutionStateSchema.safeParse(raw);
  if (!parsed.success) return refuse('run-state-invalid');
  const state = parsed.data;
  const ids = new Set<string>();
  const segments = new Set<string>();
  const nativeSessions = new Set<string>();
  for (const [index, run] of state.runs.entries()) {
    const a = run.attempt;
    if (
      ids.has(a.id) ||
      segments.has(run.segmentId) ||
      (a.sessionId !== undefined && nativeSessions.has(a.sessionId)) ||
      a.nodeId !== record.nodeId ||
      a.workflowVersionId !== record.planId ||
      a.planRevision !== record.revision ||
      a.generation !== index + 1 ||
      a.attempt !== index + 1 ||
      a.configSnapshotId !== run.selection.configurationId ||
      (run.resources === 'settled' && !isTerminalRunStatus(a.status)) ||
      (a.stopPhase === 'confirmed' && a.status !== 'cancelled') ||
      a.acknowledged !== (a.executorRunId !== undefined) ||
      (['running', 'waiting-for-input', 'completed'].includes(a.status) && !a.acknowledged) ||
      (a.status === 'requested' && a.acknowledged) ||
      a.lastEventSequence !== (run.lastEvent?.sequence ?? 0)
    )
      refuse('run-state-invalid');
    ids.add(a.id);
    if (run.remote) {
      const remote = run.remote;
      const source = remote.result?.source;
      const fileConfiguration =
        run.composition?.schemaVersion === 2 ? run.composition.payload : undefined;
      if (
        remote.acceptRequestId !== a.idempotencyKey ||
        (remote.result && (a.status !== 'completed' || run.resources !== 'settled')) ||
        (remote.lastWireEvent?.sequence ?? 0) > a.lastEventSequence ||
        (run.workspace.kind === 'local' && run.workspace.deviceId !== remote.deviceId) ||
        (remote.files !== undefined &&
          (run.workspace.kind !== 'local' ||
            fileConfiguration?.resultIntentTool?.sourceVersion !== 'zhuma-native-result-intent@2' ||
            fileConfiguration.outputFilePublisherTool?.sourceVersion !== remote.files)) ||
        (remote.acceptedFiles !== undefined &&
          fileConfiguration?.acceptedFileReader?.sourceVersion !== remote.acceptedFiles) ||
        (fileConfiguration?.acceptedFileReader !== undefined) !==
          (remote.acceptedFiles !== undefined) ||
        (remote.knowledge !== undefined &&
          fileConfiguration?.knowledgeTool?.sourceVersion !== remote.knowledge) ||
        (fileConfiguration?.knowledgeTool !== undefined) !== (remote.knowledge !== undefined) ||
        (source?.toolVersion === 'zhuma-native-result-intent@2' && remote.files === undefined) ||
        (source &&
          (canonicalPayload(source.scope) !== canonicalPayload(executionRunScope(record, run)) ||
            source.configurationId !== run.selection.configurationId ||
            source.nativeSessionId !== a.sessionId ||
            source.nativeAgentId !== a.executorRunId)) ||
        (remote.receipt &&
          (!remote.result ||
            remote.receipt.requestId !== remote.result.requestId ||
            remote.receipt.digest !== remote.result.digest ||
            remote.receipt.artifactDigest !== remote.result.artifactDigest ||
            !record.artifactVersions.some(
              (artifact) => artifact.id === remote.receipt!.artifactVersionId,
            )))
      )
        refuse('run-state-invalid');
    }
    if (run.composition) {
      try {
        assertParsedExecutionRunCompositionBinding(
          run.composition,
          executionRunScope(record, run),
          {
            selection: run.selection,
            expertVersionId: a.expertVersionId,
            contextRefs: a.contextRefs,
            inputFingerprint: a.payloadHash,
          },
        );
      } catch {
        refuse('run-state-invalid');
      }
    }
    if (Object.hasOwn(run, 'resultDelivery')) {
      try {
        assertNativeResultDelivery(record, run);
      } catch {
        refuse('run-state-invalid');
      }
    }
    segments.add(run.segmentId);
    if (a.sessionId !== undefined) nativeSessions.add(a.sessionId);
  }
  if (state.currentRunId !== state.runs.at(-1)?.attempt.id) refuse('run-state-invalid');
  const active = state.runs.at(-1)!.attempt;
  if (
    !isTerminalRunStatus(active.status) &&
    (active.entryNodeStatus !== record.command.entryStatus ||
      (active.status === 'requested' &&
        !['ready', 'needs-revision'].includes(record.command.status)) ||
      (active.status === 'running' && record.command.status !== 'running') ||
      (active.status === 'waiting-for-input' && record.command.status !== 'waiting-for-input'))
  )
    refuse('run-state-invalid');
  if (
    state.runs
      .slice(0, -1)
      .some((r) => !isTerminalRunStatus(r.attempt.status) || r.resources !== 'settled')
  )
    refuse('run-state-invalid');
  const receipts = new Set<string>();
  for (const receipt of state.receipts) {
    if (receipts.has(receipt.requestId) || !ids.has(receipt.runId)) refuse('run-state-invalid');
    receipts.add(receipt.requestId);
  }
  if (review) {
    try {
      assertExecutionReviewRecord(record, review, state, EXECUTION_RUN_LIMITS.runs);
    } catch {
      return refuse('run-state-invalid');
    }
  }
  return state;
}
export function executionRunScope(record: ExecutionNodeRecord, run: ExecutionRun): NativeWorkScope {
  return Object.freeze({
    actorId: run.actorId,
    spaceId: run.spaceId,
    taskId: record.taskId,
    planId: record.planId,
    revision: record.revision,
    nodeId: record.nodeId,
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
  });
}
export function currentExecutionRun(record: ExecutionNodeRecord): ExecutionRun | undefined {
  return readExecutionRunState(record)?.runs.at(-1);
}
/** Metadata eligibility only. The original Service must still qualify physical drain. */
export function isExecutionRunRevisionStart(record: ExecutionNodeRecord): boolean {
  const run = currentExecutionRun(record);
  const round = record.rounds.find((item) => item.id === record.currentRoundId);
  const artifact = record.artifactVersions.at(-1);
  return (
    record.command.status === 'needs-revision' &&
    record.command.entryStatus === 'needs-revision' &&
    !record.command.upstreamAffected &&
    !record.acceptedArtifactVersionId &&
    run?.attempt.status === 'completed' &&
    run.resources === 'settled' &&
    round?.status === 'changes-requested' &&
    artifact !== undefined &&
    round.artifactVersionId === artifact.id &&
    (artifact.producerRunId === undefined || artifact.producerRunId === run.attempt.id)
  );
}
/** B must call this in the same command queue before human submit/recovery/overwrite. */
export function assertExecutionRunQuiescent(record: ExecutionNodeRecord): void {
  const state = readExecutionRunState(record);
  if (state?.runs.some((r) => r.resources === 'held' || !isTerminalRunStatus(r.attempt.status)))
    refuse('run-active');
}
export function withExecutionRunState(
  record: ExecutionNodeRecord,
  state: ExecutionRunState,
): ExecutionRunNode {
  if (!nativeExecutionStateSchema.safeParse(state).success) refuse('run-state-invalid');
  const parts = splitExecutionReviewRecord(record);
  const next = {
    ...record,
    nativeExecution: parts.review
      ? {
          ...state,
          schemaVersion: 2,
          review: (record as { nativeExecution?: { review?: unknown } }).nativeExecution!.review,
        }
      : state,
  };
  readExecutionRunState(next);
  return next as ExecutionRunNode;
}
function withState(record: ExecutionNodeRecord, state: ExecutionRunState): ExecutionRunNode {
  return withExecutionRunState(record, state);
}
function transition(
  record: ExecutionNodeRecord,
  actorId: string,
  key: string,
  payload: NodeTransition,
): ExecutionNodeRecord {
  const result = applyNodeTransitionCommand(record.command, {
    actorId,
    objectId: record.nodeId,
    idempotencyKey: key,
    expectedVersion: record.command.version,
    payload,
  });
  if (result.decision.status !== 'applied' && result.decision.status !== 'replayed')
    refuse('run-node-transition');
  return { ...record, command: result.state };
}
function canDrive(record: ExecutionNodeRecord, actorId: string): boolean {
  return record.handoff.assignee.kind === 'human'
    ? record.handoff.assignee.id === actorId
    : record.ownerId === actorId;
}
export const beginExecutionRunSchema = z.strictObject({
  requestId: id,
  actorId: id,
  spaceId: id,
  expectedNodeVersion: integer,
  expectedRunVersion: integer,
  mode: z.enum(['begin', 'retry', 'restart']),
  newRunId: id,
  newSegmentId: id,
  inputFingerprint: digest,
  selection: selectionSchema,
  expertVersionId: id,
  contextRefs: z.array(id).max(256),
  workspace: executionWorkspaceSchema,
  composition: executionRunCompositionSchema.optional(),
});
export type BeginExecutionRun = z.infer<typeof beginExecutionRunSchema>;
type InputEffect<K extends 'dispatch' | 'reconcile'> = {
  readonly kind: K;
  readonly scope: NativeWorkScope;
  readonly previousScope?: NativeWorkScope;
  readonly requestId: string;
  readonly inputFingerprint: string;
  readonly selection: NativeSessionSelection;
};
export type ExecutionRunEffect =
  | InputEffect<'dispatch'>
  | InputEffect<'reconcile'>
  | { readonly kind: 'stop'; readonly scope: NativeWorkScope };
export interface ExecutionRunDecision {
  readonly disposition: 'applied' | 'replayed' | 'ignored';
  readonly record: ExecutionRunNode;
  readonly run: ExecutionRun;
  /** May run only AFTER the returned record has become durable, outside B's write queue. */
  readonly effect?: ExecutionRunEffect;
}
function beginFingerprint(record: ExecutionNodeRecord, request: BeginExecutionRun): string {
  const {
    newRunId: _run,
    newSegmentId: _segment,
    expectedNodeVersion: _node,
    expectedRunVersion: _version,
    ...body
  } = request;
  return fingerprintOf({
    taskId: record.taskId,
    planId: record.planId,
    revision: record.revision,
    nodeId: record.nodeId,
    ...body,
  });
}
function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(canonicalPayload(value)).digest('hex');
}
/** Pure RMW decision. Caller supplies only verified Host facts, under B's existing global queue. */
export function beginExecutionRun(
  record: ExecutionNodeRecord,
  input: unknown,
  peers: readonly ExecutionNodeRecord[],
  availability: {
    readonly expertEnabled: boolean;
    readonly executorConnected: boolean;
    readonly writerState: unknown;
    readonly stoppedPreparedReviewRunIds?: ReadonlySet<string>;
  },
): ExecutionRunDecision {
  requireExecutionRunWriter(availability.writerState);
  return decideExecutionRunBegin(record, input, peers, availability);
}

/** All pure begin constraints, with no write, effect or permission result. The
 * explicit first-start path uses this before changing the compatibility barrier;
 * actual admission still requires beginExecutionRun's durable writer check.
 */
export function validateExecutionRunBegin(
  record: ExecutionNodeRecord,
  input: unknown,
  peers: readonly ExecutionNodeRecord[],
  availability: {
    readonly expertEnabled: boolean;
    readonly executorConnected: boolean;
    readonly stoppedPreparedReviewRunIds?: ReadonlySet<string>;
  },
): undefined {
  decideExecutionRunBegin(record, input, peers, availability);
  return undefined;
}

function decideExecutionRunBegin(
  record: ExecutionNodeRecord,
  input: unknown,
  peers: readonly ExecutionNodeRecord[],
  availability: {
    readonly expertEnabled: boolean;
    readonly executorConnected: boolean;
    readonly stoppedPreparedReviewRunIds?: ReadonlySet<string>;
  },
): ExecutionRunDecision {
  const request = parsed(beginExecutionRunSchema, input);
  if (!canDrive(record, request.actorId)) refuse('run-not-controller');
  const state = readExecutionRunState(record);
  const review = splitExecutionReviewRecord(record).review;
  if (state?.runs.some((run) => run.actorId !== request.actorId || run.spaceId !== request.spaceId))
    refuse('run-scope-mismatch');
  const fingerprint = beginFingerprint(record, request);
  const prior = state?.receipts.find((r) => r.requestId === request.requestId);
  if (prior) {
    if (prior.actorId !== request.actorId || prior.fingerprint !== fingerprint)
      refuse('run-idempotency-mismatch');
    const run = state!.runs.find((r) => r.attempt.id === prior.runId)!;
    const index = state!.runs.indexOf(run);
    const previous = index > 0 ? state!.runs[index - 1] : undefined;
    return {
      disposition: 'replayed',
      record: record as ExecutionRunNode,
      run,
      effect: {
        kind: 'reconcile',
        scope: executionRunScope(record, run),
        requestId: request.requestId,
        inputFingerprint: run.attempt.payloadHash,
        selection: run.selection,
        ...(previous ? { previousScope: executionRunScope(record, previous) } : {}),
      },
    };
  }
  if (
    record.command.version !== request.expectedNodeVersion ||
    (state?.version ?? 0) !== request.expectedRunVersion
  )
    refuse('run-conflict');
  if (
    (state?.runs.length ?? 0) + (review?.attempts.length ?? 0) >= EXECUTION_RUN_LIMITS.runs ||
    (state?.receipts.length ?? 0) >= EXECUTION_RUN_LIMITS.receipts
  )
    refuse('run-capacity');
  assertExecutionRunQuiescent(record);
  if (
    review?.attempts.some(
      (attempt) =>
        attempt.resources === 'held' &&
        !(
          attempt.status === 'prepared' &&
          attempt.version === 1 &&
          availability.stoppedPreparedReviewRunIds?.has(attempt.scope.runId)
        ),
    )
  )
    refuse('run-active');
  if (
    review?.attempts.some(
      (attempt) =>
        attempt.scope.runId === request.newRunId ||
        attempt.scope.segmentId === request.newSegmentId,
    ) ||
    state?.runs.some(
      (r) => r.attempt.id === request.newRunId || r.segmentId === request.newSegmentId,
    )
  )
    refuse('run-id-conflict');
  if (request.workspace.kind === 'local' && request.workspace.access === 'write') {
    const workspace = request.workspace;
    if (
      peers.some((peer) =>
        readExecutionRunState(peer)?.runs.some(
          (r) =>
            r.resources === 'held' &&
            r.workspace.kind === 'local' &&
            r.workspace.access === 'write' &&
            r.workspace.deviceId === workspace.deviceId &&
            r.workspace.rootId === workspace.rootId,
        ),
      )
    )
      refuse('run-workspace-busy');
  }
  let base = record;
  if (request.mode !== 'begin') {
    const previous = state?.runs.at(-1);
    const expected = request.mode === 'retry' ? 'failed' : 'cancelled';
    if (!previous || previous.attempt.status !== expected) refuse('run-recovery-unavailable');
    if (previous.attempt.acknowledged) {
      const recovery = recoveryCommandFor(record.command.status, record.command.entryStatus);
      if (!recovery.ok || recovery.transition !== request.mode) refuse('run-recovery-unavailable');
      base = transition(record, request.actorId, `native-recovery:${request.requestId}`, {
        type: recovery.transition,
        returnTo: recovery.returnTo,
      });
    } else if (
      !['ready', 'needs-revision'].includes(record.command.status) ||
      record.command.entryStatus !== previous.attempt.entryNodeStatus
    )
      refuse('run-recovery-unavailable');
  }
  const entry = base.command.entryStatus;
  if (
    (entry !== 'ready' && entry !== 'needs-revision') ||
    (base.command.status === 'needs-revision' && entry !== 'needs-revision')
  )
    refuse('run-entry-invalid');
  const opened = openRunAttempt({
    nodeStatus: base.command.status,
    runs: state?.runs.map((r) => r.attempt) ?? [],
    idempotencyKey: request.requestId,
    payloadHash: request.inputFingerprint,
    executor: 'dsh',
    expertEnabled: availability.expertEnabled,
    executorConnected: availability.executorConnected,
    trigger: 'explicit-run-request',
    nodeId: record.nodeId,
    workflowVersionId: record.planId,
    planRevision: record.revision,
    contextRefs: request.contextRefs,
    expertVersionId: request.expertVersionId,
    configSnapshotId: request.selection.configurationId,
    simulated: false,
    newRunId: request.newRunId,
  });
  if (!opened.ok || opened.reused) refuse(opened.ok ? 'run-state-invalid' : `run-${opened.code}`);
  // A child return may be ready while retaining a needs-revision obligation.
  const run: ExecutionRun = {
    attempt: { ...opened.attempt, entryNodeStatus: entry } as ExecutionRun['attempt'],
    actorId: request.actorId,
    spaceId: request.spaceId,
    segmentId: request.newSegmentId,
    selection: request.selection,
    workspace: request.workspace,
    dispatch: 'reserved',
    resources: 'held',
    ...(request.composition ? { composition: request.composition } : {}),
  };
  const next = withState(base, {
    schemaVersion: 1,
    version: (state?.version ?? 0) + 1,
    currentRunId: run.attempt.id,
    runs: [...(state?.runs ?? []), run],
    receipts: [
      ...(state?.receipts ?? []),
      {
        requestId: request.requestId,
        actorId: request.actorId,
        fingerprint,
        runId: run.attempt.id,
      },
    ],
  });
  return {
    disposition: 'applied',
    record: next,
    run,
    effect: {
      kind: 'dispatch',
      scope: executionRunScope(next, run),
      requestId: request.requestId,
      inputFingerprint: request.inputFingerprint,
      selection: run.selection,
      ...(state?.runs.at(-1)
        ? { previousScope: executionRunScope(record, state.runs.at(-1)!) }
        : {}),
    },
  };
}

export const stopExecutionRunSchema = z.strictObject({
  requestId: id,
  actorId: id,
  runId: id,
  generation: positive,
  segmentId: id,
  expectedNodeVersion: integer,
  expectedRunVersion: integer,
});
export function requestExecutionRunStop(
  record: ExecutionNodeRecord,
  input: unknown,
): ExecutionRunDecision {
  const request = parsed(stopExecutionRunSchema, input);
  if (!canDrive(record, request.actorId)) refuse('run-not-controller');
  const state = readExecutionRunState(record);
  if (!state) refuse('run-not-started');
  const run = state.runs.at(-1)!;
  if (
    run.attempt.id !== request.runId ||
    run.attempt.generation !== request.generation ||
    run.segmentId !== request.segmentId
  )
    refuse('run-scope-mismatch');
  const fingerprint = fingerprintOf({
    kind: 'stop',
    actorId: request.actorId,
    runId: request.runId,
    generation: request.generation,
    segmentId: request.segmentId,
  });
  const prior = state.receipts.find((r) => r.requestId === request.requestId);
  if (prior) {
    if (prior.actorId !== request.actorId || prior.fingerprint !== fingerprint)
      refuse('run-idempotency-mismatch');
    return {
      disposition: 'replayed',
      record: record as ExecutionRunNode,
      run,
      ...(!isTerminalRunStatus(run.attempt.status)
        ? { effect: { kind: 'stop' as const, scope: executionRunScope(record, run) } }
        : {}),
    };
  }
  if (
    record.command.version !== request.expectedNodeVersion ||
    state.version !== request.expectedRunVersion
  )
    refuse('run-conflict');
  if (state.receipts.length >= EXECUTION_RUN_LIMITS.receipts) refuse('run-capacity');
  const stopped = requestRunStop(run.attempt);
  if (!stopped.ok) refuse('run-terminal');
  const changed = { ...run, attempt: stopped.attempt as ExecutionRun['attempt'] };
  const next = withState(record, {
    ...state,
    version: state.version + 1,
    runs: state.runs.map((r) => (r === run ? changed : r)),
    receipts: [
      ...state.receipts,
      {
        requestId: request.requestId,
        actorId: request.actorId,
        fingerprint,
        runId: run.attempt.id,
      },
    ],
  });
  return {
    disposition: 'applied',
    record: next,
    run: changed,
    effect: { kind: 'stop', scope: executionRunScope(next, changed) },
  };
}

const location = { runId: id, generation: positive, segmentId: id, sequence: positive };
const stable = {
  idle: z.literal(true),
  flushed: z.literal(true),
  resourcesSettled: z.literal(true),
};
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...location, kind: z.literal('received'), nativeSessionId: id }),
  z.strictObject({
    ...location,
    kind: z.literal('accepted'),
    nativeSessionId: id,
    executorRunId: id,
  }),
  z.strictObject({ ...location, kind: z.literal('dispatch-unknown') }),
  z.strictObject({ ...location, kind: z.literal('idle') }),
  z.strictObject({ ...location, kind: z.literal('waiting') }),
  z.strictObject({ ...location, kind: z.literal('resumed') }),
  z.strictObject({ ...location, kind: z.literal('stop-pending') }),
  z.strictObject({ ...location, kind: z.literal('stopped'), ...stable }),
  z.strictObject({ ...location, kind: z.literal('completed'), ...stable }),
  z.strictObject({ ...location, kind: z.literal('failed'), resourcesSettled: z.boolean() }),
  z.strictObject({ ...location, kind: z.literal('cleanup'), ...stable }),
]);
export type ExecutionRunEvent = z.infer<typeof eventSchema>;

/** Only B's trusted native/cleanup bridge may supply these events, never a Client envelope. */
export function recordExecutionRunEvent(
  record: ExecutionNodeRecord,
  input: unknown,
): ExecutionRunDecision {
  const event = parsed(eventSchema, input);
  const state = readExecutionRunState(record);
  if (!state) refuse('run-not-started');
  const run = state.runs.find((r) => r.attempt.id === event.runId);
  if (!run || run.segmentId !== event.segmentId || run.attempt.generation !== event.generation)
    refuse('run-scope-mismatch');
  const fingerprint = fingerprintOf(event);
  if (
    (event.kind === 'received' || event.kind === 'accepted') &&
    state.runs.some(
      (other) =>
        other.attempt.id !== run.attempt.id && other.attempt.sessionId === event.nativeSessionId,
    )
  )
    refuse('run-session-mismatch');
  if (run.lastEvent?.sequence === event.sequence) {
    if (run.lastEvent.fingerprint !== fingerprint) refuse('run-event-mismatch');
    return { disposition: 'replayed', record: record as ExecutionRunNode, run };
  }
  if (run.attempt.id !== state.currentRunId || event.sequence <= run.attempt.lastEventSequence) {
    return { disposition: 'ignored', record: record as ExecutionRunNode, run };
  }
  if (isTerminalRunStatus(run.attempt.status) && event.kind !== 'cleanup')
    return { disposition: 'ignored', record: record as ExecutionRunNode, run };
  let base = record;
  let attempt: ExecutionAttempt = run.attempt;
  let resources = run.resources;
  let dispatch = run.dispatch;
  const move = (payload: NodeTransition) => {
    base = transition(
      base,
      run.actorId,
      `native-event:${run.attempt.id}:${event.sequence}`,
      payload,
    );
  };
  switch (event.kind) {
    case 'received':
      if (attempt.sessionId && attempt.sessionId !== event.nativeSessionId)
        refuse('run-session-mismatch');
      attempt = { ...attempt, sessionId: event.nativeSessionId };
      dispatch = 'received';
      break;
    case 'accepted': {
      if (attempt.stopPhase !== 'none') refuse('run-stopping');
      if (attempt.sessionId && attempt.sessionId !== event.nativeSessionId)
        refuse('run-session-mismatch');
      if (attempt.executorRunId && attempt.executorRunId !== event.executorRunId)
        refuse('run-session-mismatch');
      const accepted = acknowledgeRun(attempt, {
        accepted: true,
        executorRunId: event.executorRunId,
        sessionId: event.nativeSessionId,
      });
      if (!accepted.ok) refuse('run-terminal');
      if (accepted.mayMarkNodeRunning) move({ type: 'execution-acknowledged' });
      attempt = accepted.attempt;
      dispatch = 'received';
      break;
    }
    case 'dispatch-unknown':
      dispatch = 'unknown';
      break;
    case 'idle':
      break; // A continuous Run survives native turn boundaries, retaining its lease.
    case 'waiting': {
      const waiting = markRunWaiting(attempt);
      if (!waiting.ok) refuse('run-not-running');
      attempt = waiting.attempt;
      move({ type: 'input-required' });
      break;
    }
    case 'resumed': {
      if (attempt.stopPhase !== 'none') refuse('run-stopping');
      const resumed = resumeRunAfterInput(attempt);
      if (!resumed.ok) refuse('run-not-waiting');
      attempt = resumed.attempt;
      move({ type: 'input-supplied' });
      break;
    }
    case 'stop-pending':
      if (attempt.stopPhase !== 'requested' && attempt.stopPhase !== 'receipt-rejected')
        refuse('run-stop-not-requested');
      attempt = rejectStopReceipt(attempt);
      break;
    case 'stopped':
    case 'completed':
    case 'failed': {
      if (event.kind === 'completed' && attempt.stopPhase !== 'none') refuse('run-stopping');
      const admission = admitExecutionSignal({
        runStatus: attempt.status,
        runId: attempt.id,
        runGeneration: attempt.generation,
        currentGeneration: run.attempt.generation,
        activeRunId: state.currentRunId,
        signal:
          event.kind === 'stopped'
            ? 'cancel-confirmed'
            : event.kind === 'completed'
              ? 'succeeded'
              : 'failed',
      });
      if (event.kind !== 'stopped' && !admission.mayUpdateRunRecord) refuse('run-not-acknowledged');
      const terminal = settleExecutionRun(
        attempt,
        event.kind === 'stopped' ? 'cancelled' : event.kind,
      );
      if (!terminal.ok) refuse(`run-${terminal.code}`);
      attempt = terminal.attempt;
      if (terminal.nodeTransition.type !== 'none') move(terminal.nodeTransition);
      if (event.resourcesSettled) resources = 'settled';
      break;
    }
    case 'cleanup':
      if (!isTerminalRunStatus(attempt.status)) refuse('run-not-terminal');
      resources = 'settled';
      break;
  }
  const changed: ExecutionRun = {
    ...run,
    attempt: { ...attempt, lastEventSequence: event.sequence } as ExecutionRun['attempt'],
    resources,
    dispatch,
    lastEvent: { sequence: event.sequence, fingerprint },
  };
  const next = withState(base, {
    ...state,
    version: state.version + 1,
    runs: state.runs.map((r) => (r.attempt.id === run.attempt.id ? changed : r)),
  });
  return { disposition: 'applied', record: next, run: changed };
}
