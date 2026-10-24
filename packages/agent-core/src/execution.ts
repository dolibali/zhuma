import type { ActorRef } from './handoff.js';
import type { NodeStatus } from './node-status.js';
import {
  deriveInbox,
  requestNodeRun,
  observeRunSignal,
  type RunSignal,
  type RunStatus,
} from './delivery.js';
import type { ReviewRound } from './review.js';
import type { ExecutionEngine } from './types.js';

export const SCHEDULE_TRIGGERS = [
  'explicit-run-request',
  'view-refresh',
  'view-switch',
  'session-restore',
  'late-event',
] as const;

export type ScheduleTrigger = (typeof SCHEDULE_TRIGGERS)[number];

export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const EXECUTION_FAULTS = [
  'model-error',
  'tool-failure',
  'network-interruption',
  'executor-disconnected',
  'expert-disabled',
  'attachment-rejected',
] as const;

export type ExecutionFaultKind = (typeof EXECUTION_FAULTS)[number];

export const INTERVENTION_PHASES = [
  'sent',
  'received',
  'pending',
  'applied',
  'not-applied',
] as const;
export type InterventionPhase = (typeof INTERVENTION_PHASES)[number];

export const EXECUTION_NEXT_ACTIONS = [
  'continue-agent',
  'supply-input',
  'retry',
  'restart',
  'wait-for-stop-receipt',
  'edit-or-send',
  'revise-in-new-round',
  'none',
] as const;

export type ExecutionNextAction = (typeof EXECUTION_NEXT_ACTIONS)[number];

export type StopPhase = 'none' | 'requested' | 'confirmed' | 'receipt-rejected';

/** 一次独立的运行尝试。完成运行不是节点交付。 */
export interface ExecutionAttempt {
  readonly id: string;
  readonly nodeId: string;
  readonly workflowVersionId: string;
  readonly planRevision: number;
  readonly attempt: number;
  readonly generation: number;
  readonly executor: ExecutionEngine;
  readonly status: RunStatus;
  readonly contextRefs: readonly string[];
  readonly lastEventSequence: number;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly simulated: boolean;
  readonly acknowledged: boolean;
  readonly expertVersionId: string;
  readonly configSnapshotId: string;
  readonly stopPhase: StopPhase;
  readonly entryNodeStatus: 'ready' | 'needs-revision';
  readonly sessionId?: string;
  /** 会话目录已删除。标识仍留在这条历史记录上，但不再用于恢复。 */
  readonly sessionDiscarded?: true;
  readonly executorRunId?: string;
  readonly modelLabel?: string;
}

export interface ConversationTurn {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly role: 'user' | 'executor' | 'notice';
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly expertVersionId: string;
  readonly configSnapshotId: string;
  readonly simulated: boolean;
  readonly sequence: number;
  readonly faultKind?: ExecutionFaultKind;
}

export interface InterventionRecord {
  readonly id: string;
  readonly runId: string;
  readonly kind: 'supplement' | 'next-turn' | 'resume-input';
  readonly phase: InterventionPhase;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  /** 入队时冻结的附件引用和校验和。字节不进日志。 */
  readonly attachments?: readonly {
    readonly id: string;
    readonly name: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly checksum: string;
  }[];
  readonly notice?: string;
  readonly appliedRunId?: string;
}

export interface LateRecord {
  readonly id: string;
  readonly runId: string;
  readonly generation: number;
  readonly signal: RunSignal;
  readonly reason: 'terminal-run' | 'stale-generation' | 'superseded-run' | 'cancel-unconfirmed';
  readonly summary: string;
  readonly mayChangeNodeStatus: false;
  readonly mayTriggerDownstream: false;
}

export interface ActivityRecord {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly detail: string;
  readonly simulated: boolean;
  readonly succeeded: boolean;
}

export interface FaultRecord {
  readonly id: string;
  readonly kind: ExecutionFaultKind;
  readonly objectLabel: string;
  readonly reason: string;
  readonly nextStep: string;
  readonly forgesRun: false;
  readonly runId?: string;
}

export interface RecoveryRequest {
  readonly id: string;
  readonly kind: 'reassign' | 'human-takeover';
  readonly status: 'recorded';
  readonly assigneeId: string;
  readonly changesAssignee: false;
  readonly forgesRun: false;
}

export interface ArtifactDraftHandoff {
  readonly nodeId: string;
  readonly text: string;
  readonly autoDeliver: false;
  readonly skipReview: false;
  readonly editable: true;
  readonly review: {
    readonly mode: 'new-round-required';
    readonly roundId: string;
    readonly previousRoundIds: readonly string[];
    readonly rejectOldRoundResults: true;
  };
  readonly producerRunId?: string;
}

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** 刷新、切换视图和恢复会话都不是运行请求。 */
export function triggerMayCreateRun(trigger: ScheduleTrigger): boolean {
  return trigger === 'explicit-run-request';
}

export function assigneeAfterAgentAssist(assignee: ActorRef): ActorRef {
  return { id: assignee.id, kind: assignee.kind };
}

export interface ExecutionSignalAdmission {
  readonly disposition: 'apply' | 'attach-only';
  readonly mayChangeNodeStatus: boolean;
  readonly mayTriggerDownstream: false;
  readonly mayUpdateRunRecord: boolean;
  readonly requiresStopRequest: boolean;
  readonly reason?: 'terminal-run' | 'stale-generation' | 'superseded-run';
  readonly suggestedTransition?: 'execution-failed' | 'cancel-confirmed';
}

function held(reason: NonNullable<ExecutionSignalAdmission['reason']>): ExecutionSignalAdmission {
  return {
    disposition: 'attach-only',
    mayChangeNodeStatus: false,
    mayTriggerDownstream: false,
    mayUpdateRunRecord: false,
    requiresStopRequest: false,
    reason,
  };
}

/**
 * 世代和终态分类复用 observeRunSignal，避免和运行观察各写一套。
 * 被替换的运行是执行层才知道的事实，所以仍先在这里拦住。
 * requested 上的成功或产物到达没有 reason，不能记成 terminal-run。
 */
export function admitExecutionSignal(input: {
  readonly runStatus: RunStatus;
  readonly runId: string;
  readonly runGeneration: number;
  readonly activeRunId: string | null;
  readonly currentGeneration: number;
  readonly signal: RunSignal;
}): ExecutionSignalAdmission {
  if (
    !Number.isSafeInteger(input.runGeneration) ||
    !Number.isSafeInteger(input.currentGeneration) ||
    input.runGeneration !== input.currentGeneration
  ) {
    return held('stale-generation');
  }
  if (input.activeRunId !== null && input.runId !== input.activeRunId) {
    return held('superseded-run');
  }
  const observed = observeRunSignal({
    runStatus: input.runStatus,
    runGeneration: input.runGeneration,
    currentGeneration: input.currentGeneration,
    signal: input.signal,
  });
  if (observed.attachOnly) {
    return observed.reason === undefined
      ? {
          disposition: 'attach-only',
          mayChangeNodeStatus: false,
          mayTriggerDownstream: false,
          mayUpdateRunRecord: false,
          requiresStopRequest: false,
        }
      : held(observed.reason);
  }
  return {
    disposition: 'apply',
    mayChangeNodeStatus: observed.mayChangeNodeStatus,
    mayTriggerDownstream: false,
    mayUpdateRunRecord: observed.mayUpdateRunRecord,
    requiresStopRequest: input.signal === 'cancel-confirmed',
    ...(observed.suggestedTransition !== undefined
      ? { suggestedTransition: observed.suggestedTransition }
      : {}),
  };
}

export type OpenRunCode =
  | 'trigger-does-not-schedule'
  | 'executor-not-selected'
  | 'expert-disabled'
  | 'executor-disconnected'
  | 'node-already-completed'
  | 'idempotency-mismatch'
  | 'node-not-executable'
  | 'active-run-exists'
  | 'invalid-run';

export function openRunAttempt(input: {
  readonly nodeStatus: NodeStatus;
  readonly runs: readonly ExecutionAttempt[];
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly executor: ExecutionEngine | null;
  readonly expertEnabled: boolean;
  readonly executorConnected: boolean;
  readonly trigger: ScheduleTrigger;
  readonly nodeId: string;
  readonly workflowVersionId: string;
  readonly planRevision: number;
  readonly contextRefs: readonly string[];
  readonly expertVersionId: string;
  readonly configSnapshotId: string;
  readonly simulated: boolean;
  readonly newRunId: string;
  readonly modelLabel?: string;
}):
  | { readonly ok: true; readonly reused: boolean; readonly attempt: ExecutionAttempt }
  | { readonly ok: false; readonly code: OpenRunCode; readonly runId?: string } {
  if (
    blank(input.idempotencyKey) ||
    blank(input.payloadHash) ||
    blank(input.nodeId) ||
    blank(input.newRunId) ||
    blank(input.expertVersionId) ||
    blank(input.configSnapshotId)
  ) {
    return { ok: false, code: 'invalid-run' };
  }
  const prior = input.runs.find((run) => run.idempotencyKey === input.idempotencyKey);
  if (prior) {
    if (prior.payloadHash !== input.payloadHash || prior.nodeId !== input.nodeId) {
      return { ok: false, code: 'idempotency-mismatch', runId: prior.id };
    }
    return { ok: true, reused: true, attempt: prior };
  }
  if (!triggerMayCreateRun(input.trigger)) return { ok: false, code: 'trigger-does-not-schedule' };
  if (input.executor === null) return { ok: false, code: 'executor-not-selected' };
  if (!input.expertEnabled) return { ok: false, code: 'expert-disabled' };
  if (!input.executorConnected) return { ok: false, code: 'executor-disconnected' };
  if (input.nodeStatus === 'completed') return { ok: false, code: 'node-already-completed' };
  const gate = requestNodeRun({
    nodeId: input.nodeId,
    nodeStatus: input.nodeStatus,
    runs: input.runs,
  });
  if (!gate.ok) {
    return gate.code === 'active-run-exists'
      ? { ok: false, code: 'active-run-exists', runId: gate.runId }
      : { ok: false, code: 'node-not-executable' };
  }
  if (input.nodeStatus !== 'ready' && input.nodeStatus !== 'needs-revision') {
    return { ok: false, code: 'node-not-executable' };
  }
  const attemptNo = input.runs.reduce((highest, run) => Math.max(highest, run.attempt), 0) + 1;
  const generation = input.runs.reduce((highest, run) => Math.max(highest, run.generation), 0) + 1;
  const attempt: ExecutionAttempt = {
    id: input.newRunId,
    nodeId: input.nodeId,
    workflowVersionId: input.workflowVersionId,
    planRevision: input.planRevision,
    attempt: attemptNo,
    generation,
    executor: input.executor,
    status: 'requested',
    contextRefs: Object.freeze([...input.contextRefs]),
    lastEventSequence: 0,
    idempotencyKey: input.idempotencyKey,
    payloadHash: input.payloadHash,
    simulated: input.simulated,
    acknowledged: false,
    expertVersionId: input.expertVersionId,
    configSnapshotId: input.configSnapshotId,
    stopPhase: 'none',
    entryNodeStatus: input.nodeStatus,
    ...(input.modelLabel !== undefined ? { modelLabel: input.modelLabel } : {}),
  };
  return { ok: true, reused: false, attempt: Object.freeze(attempt) };
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function replaceAttempt(
  attempt: ExecutionAttempt,
  patch: Partial<ExecutionAttempt> &
    Pick<ExecutionAttempt, 'status' | 'acknowledged' | 'stopPhase'>,
): ExecutionAttempt {
  const sessionId = patch.sessionId ?? attempt.sessionId;
  const executorRunId = patch.executorRunId ?? attempt.executorRunId;
  const modelLabel = patch.modelLabel ?? attempt.modelLabel;
  return Object.freeze({
    id: attempt.id,
    nodeId: attempt.nodeId,
    workflowVersionId: attempt.workflowVersionId,
    planRevision: attempt.planRevision,
    attempt: attempt.attempt,
    generation: attempt.generation,
    executor: attempt.executor,
    status: patch.status,
    contextRefs: attempt.contextRefs,
    lastEventSequence: patch.lastEventSequence ?? attempt.lastEventSequence,
    idempotencyKey: attempt.idempotencyKey,
    payloadHash: attempt.payloadHash,
    simulated: attempt.simulated,
    acknowledged: patch.acknowledged,
    expertVersionId: attempt.expertVersionId,
    configSnapshotId: attempt.configSnapshotId,
    stopPhase: patch.stopPhase,
    entryNodeStatus: attempt.entryNodeStatus,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(attempt.sessionDiscarded === true ? { sessionDiscarded: true as const } : {}),
    ...(executorRunId !== undefined ? { executorRunId } : {}),
    ...(modelLabel !== undefined ? { modelLabel } : {}),
  });
}

export function acknowledgeRun(
  attempt: ExecutionAttempt,
  receipt:
    | { readonly accepted: true; readonly executorRunId: string; readonly sessionId?: string }
    | { readonly accepted: false },
):
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly attempt: ExecutionAttempt;
      readonly mayMarkNodeRunning: boolean;
    }
  | { readonly ok: false; readonly code: 'terminal-run'; readonly mayChangeNodeStatus: false } {
  if (isTerminalRunStatus(attempt.status)) {
    return { ok: false, code: 'terminal-run', mayChangeNodeStatus: false };
  }
  if (attempt.acknowledged && receipt.accepted) {
    return { ok: true, replayed: true, attempt, mayMarkNodeRunning: false };
  }
  if (!receipt.accepted) {
    return {
      ok: true,
      replayed: false,
      mayMarkNodeRunning: false,
      attempt: replaceAttempt(attempt, {
        status: 'failed',
        acknowledged: false,
        stopPhase: attempt.stopPhase,
      }),
    };
  }
  return {
    ok: true,
    replayed: false,
    mayMarkNodeRunning: true,
    attempt: replaceAttempt(attempt, {
      status: 'running',
      acknowledged: true,
      stopPhase: attempt.stopPhase,
      executorRunId: receipt.executorRunId,
      ...(receipt.sessionId !== undefined ? { sessionId: receipt.sessionId } : {}),
    }),
  };
}

export function requestRunStop(
  attempt: ExecutionAttempt,
):
  | { readonly ok: true; readonly replayed: boolean; readonly attempt: ExecutionAttempt }
  | { readonly ok: false; readonly code: 'terminal-run'; readonly mayChangeNodeStatus: false } {
  if (isTerminalRunStatus(attempt.status)) {
    return { ok: false, code: 'terminal-run', mayChangeNodeStatus: false };
  }
  if (attempt.stopPhase === 'requested' || attempt.stopPhase === 'confirmed') {
    return { ok: true, replayed: true, attempt };
  }
  return {
    ok: true,
    replayed: false,
    attempt: replaceAttempt(attempt, {
      status: attempt.status,
      acknowledged: attempt.acknowledged,
      stopPhase: 'requested',
    }),
  };
}

export function settleExecutionRun(
  attempt: ExecutionAttempt,
  next: 'completed' | 'failed' | 'cancelled',
):
  | {
      readonly ok: true;
      readonly attempt: ExecutionAttempt;
      readonly nodeTransition:
        | { readonly type: 'execution-finished'; readonly returnTo: 'ready' | 'needs-revision' }
        | { readonly type: 'execution-failed' }
        | { readonly type: 'cancel-confirmed' }
        | { readonly type: 'none' };
    }
  | {
      readonly ok: false;
      readonly code: 'terminal-run' | 'cancel-unconfirmed' | 'not-acknowledged';
      readonly mayChangeNodeStatus: false;
      readonly attempt: ExecutionAttempt;
    } {
  if (isTerminalRunStatus(attempt.status)) {
    return { ok: false, code: 'terminal-run', mayChangeNodeStatus: false, attempt };
  }
  if (next === 'cancelled') {
    if (attempt.stopPhase !== 'requested' && attempt.stopPhase !== 'receipt-rejected') {
      return { ok: false, code: 'cancel-unconfirmed', mayChangeNodeStatus: false, attempt };
    }
    return {
      ok: true,
      nodeTransition: attempt.acknowledged ? { type: 'cancel-confirmed' } : { type: 'none' },
      attempt: replaceAttempt(attempt, {
        status: 'cancelled',
        acknowledged: attempt.acknowledged,
        stopPhase: 'confirmed',
      }),
    };
  }
  if (next === 'failed') {
    return {
      ok: true,
      nodeTransition: attempt.acknowledged ? { type: 'execution-failed' } : { type: 'none' },
      attempt: replaceAttempt(attempt, {
        status: 'failed',
        acknowledged: attempt.acknowledged,
        stopPhase: attempt.stopPhase,
      }),
    };
  }
  if (!attempt.acknowledged) {
    return { ok: false, code: 'not-acknowledged', mayChangeNodeStatus: false, attempt };
  }
  return {
    ok: true,
    nodeTransition: { type: 'execution-finished', returnTo: attempt.entryNodeStatus },
    attempt: replaceAttempt(attempt, {
      status: 'completed',
      acknowledged: true,
      stopPhase: attempt.stopPhase,
    }),
  };
}

export function markRunWaiting(attempt: ExecutionAttempt):
  | { readonly ok: true; readonly attempt: ExecutionAttempt }
  | {
      readonly ok: false;
      readonly code: 'not-running' | 'terminal-run';
      readonly mayChangeNodeStatus: false;
    } {
  if (isTerminalRunStatus(attempt.status)) {
    return { ok: false, code: 'terminal-run', mayChangeNodeStatus: false };
  }
  if (attempt.status !== 'running' || !attempt.acknowledged) {
    return { ok: false, code: 'not-running', mayChangeNodeStatus: false };
  }
  return {
    ok: true,
    attempt: replaceAttempt(attempt, {
      status: 'waiting-for-input',
      acknowledged: true,
      stopPhase: attempt.stopPhase,
    }),
  };
}

export function resumeRunAfterInput(
  attempt: ExecutionAttempt,
):
  | { readonly ok: true; readonly attempt: ExecutionAttempt }
  | { readonly ok: false; readonly code: 'not-waiting'; readonly mayChangeNodeStatus: false } {
  if (attempt.status !== 'waiting-for-input') {
    return { ok: false, code: 'not-waiting', mayChangeNodeStatus: false };
  }
  return {
    ok: true,
    attempt: replaceAttempt(attempt, {
      status: 'running',
      acknowledged: true,
      stopPhase: attempt.stopPhase,
    }),
  };
}

export function rejectStopReceipt(attempt: ExecutionAttempt): ExecutionAttempt {
  if (isTerminalRunStatus(attempt.status) || attempt.stopPhase !== 'requested') return attempt;
  return replaceAttempt(attempt, {
    status: attempt.status,
    acknowledged: attempt.acknowledged,
    stopPhase: 'receipt-rejected',
  });
}

export function routeLiveInput(input: {
  readonly runStatus: RunStatus;
  readonly supportsLiveInjection: boolean;
  readonly intent: 'supplement' | 'next-turn';
}):
  | {
      readonly ok: true;
      readonly kind: 'supplement' | 'next-turn' | 'resume-input';
      readonly queued: boolean;
      readonly notice?: string;
    }
  | { readonly ok: false; readonly code: 'run-not-active' } {
  if (isTerminalRunStatus(input.runStatus)) return { ok: false, code: 'run-not-active' };
  if (input.runStatus === 'waiting-for-input' && input.intent === 'supplement') {
    return { ok: true, kind: 'resume-input', queued: false };
  }
  if (input.intent === 'next-turn' || !input.supportsLiveInjection) {
    return {
      ok: true,
      kind: 'next-turn',
      queued: true,
      notice: input.supportsLiveInjection
        ? '已排入下一轮。发送成功不等于已应用。'
        : '执行器不支持实时注入，已转入下一轮队列。发送成功不等于已应用。',
    };
  }
  return { ok: true, kind: 'supplement', queued: false };
}

export function advanceIntervention(
  phase: InterventionPhase,
  step: 'receive' | 'queue' | 'apply',
):
  | { readonly ok: true; readonly phase: InterventionPhase; readonly replayed: boolean }
  | { readonly ok: false; readonly code: 'send-is-not-adoption' | 'phase-conflict' } {
  if (phase === 'applied' || phase === 'not-applied') return { ok: true, phase, replayed: true };
  if (step === 'apply' && phase === 'sent') return { ok: false, code: 'send-is-not-adoption' };
  if (step === 'receive' && phase === 'sent')
    return { ok: true, phase: 'received', replayed: false };
  if (step === 'queue' && phase === 'received')
    return { ok: true, phase: 'pending', replayed: false };
  if (step === 'apply' && (phase === 'received' || phase === 'pending')) {
    return { ok: true, phase: 'applied', replayed: false };
  }
  if (
    (step === 'receive' && (phase === 'received' || phase === 'pending')) ||
    (step === 'queue' && phase === 'pending')
  ) {
    return { ok: true, phase, replayed: true };
  }
  return { ok: false, code: 'phase-conflict' };
}

export function acceptUserMessage(input: {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly existing: readonly {
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly id: string;
  }[];
}):
  | { readonly action: 'replay'; readonly id: string }
  | { readonly action: 'accept' }
  | { readonly action: 'mismatch'; readonly id: string } {
  const prior = input.existing.find((item) => item.idempotencyKey === input.idempotencyKey);
  if (!prior) return { action: 'accept' };
  if (prior.payloadHash === input.payloadHash) return { action: 'replay', id: prior.id };
  return { action: 'mismatch', id: prior.id };
}

export interface FaultPresentation {
  readonly kind: ExecutionFaultKind;
  readonly objectLabel: string;
  readonly reason: string;
  readonly nextStep: string;
  readonly forgesRun: false;
  readonly recovery: readonly ('retry' | 'reassign' | 'human-takeover')[];
}

const FAULT_COPY: Record<ExecutionFaultKind, Omit<FaultPresentation, 'kind' | 'forgesRun'>> = {
  'model-error': {
    objectLabel: '模型',
    reason: '模型返回错误。已保留本轮已有输出。',
    nextStep: '可以重试、改派或由责任人人工接回。',
    recovery: ['retry', 'reassign', 'human-takeover'],
  },
  'tool-failure': {
    objectLabel: '工具',
    reason: '工具执行失败。这不是模型错误，也不是网络中断。',
    nextStep: '查看失败的工具后再重试、改派或人工接回。',
    recovery: ['retry', 'reassign', 'human-takeover'],
  },
  'network-interruption': {
    objectLabel: '网络',
    reason: '连接中断。不能据此把运行标成完成。',
    nextStep: '恢复连接后重试，或改派、人工接回。',
    recovery: ['retry', 'reassign', 'human-takeover'],
  },
  'executor-disconnected': {
    objectLabel: '执行器',
    reason: '执行器已断开。不会伪造一次运行或成功结果。',
    nextStep: '重新连接后再显式选择执行器，或改派、人工接回。',
    recovery: ['retry', 'reassign', 'human-takeover'],
  },
  'expert-disabled': {
    objectLabel: '专家',
    reason: '专家已停用，不能作为本次执行配置。',
    nextStep: '换一个可用专家，或改派、人工接回。历史消息仍保留。',
    recovery: ['reassign', 'human-takeover'],
  },
  'attachment-rejected': {
    objectLabel: '附件',
    reason: '当前 SDK 接入方式不能发送这个附件。',
    nextStep: '改用文本、JSON 或 png、jpeg、webp、gif 图片。',
    recovery: ['retry', 'reassign', 'human-takeover'],
  },
};

export function presentExecutionFault(kind: ExecutionFaultKind): FaultPresentation {
  return { kind, forgesRun: false, ...FAULT_COPY[kind] };
}

export function normalizeActivity(activity: ActivityRecord): ActivityRecord {
  if (!activity.simulated || !activity.succeeded) return activity;
  return {
    ...activity,
    succeeded: false,
    detail: `${activity.detail}（模拟执行不会记为工具成功）`,
  };
}

/**
 * 草稿交接。这里不创建产物版本。
 * 正式提交仍要经过 validateDeliveryContent 和 createArtifactVersion，空交付和非法链接在那一层拒绝。
 */
export function prepareArtifactDraft(input: {
  readonly nodeId: string;
  readonly text: string;
  readonly previousRoundIds: readonly string[];
  readonly existingRounds: readonly {
    readonly id: string;
    readonly status: ReviewRound['status'];
  }[];
  readonly newRoundId: string;
  readonly producerRunId?: string;
}):
  | { readonly ok: true; readonly draft: ArtifactDraftHandoff }
  | {
      readonly ok: false;
      readonly code:
        'empty-draft' | 'old-round-rejected' | 'voided-round' | 'resubmit-requires-new-round';
    } {
  if (blank(input.text) || blank(input.nodeId)) return { ok: false, code: 'empty-draft' };
  if (blank(input.newRoundId)) return { ok: false, code: 'resubmit-requires-new-round' };
  const matched = input.existingRounds.find((round) => round.id === input.newRoundId);
  if (matched?.status === 'voided') return { ok: false, code: 'voided-round' };
  if (matched || input.previousRoundIds.includes(input.newRoundId)) {
    return { ok: false, code: 'old-round-rejected' };
  }
  const draft: ArtifactDraftHandoff = {
    nodeId: input.nodeId,
    text: input.text.trim(),
    autoDeliver: false,
    skipReview: false,
    editable: true,
    review: {
      mode: 'new-round-required',
      roundId: input.newRoundId,
      previousRoundIds: Object.freeze([...input.previousRoundIds]),
      rejectOldRoundResults: true,
    },
    ...(input.producerRunId !== undefined ? { producerRunId: input.producerRunId } : {}),
  };
  return { ok: true, draft: Object.freeze(draft) };
}

/** 旧轮次和已作废轮次的结果不能推进节点。这不是评审结算。 */
export function acceptRoundResult(input: {
  readonly roundId: string;
  readonly roundStatus: ReviewRound['status'];
  readonly activeRoundId: string | null;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'voided-round' | 'old-round-rejected' } {
  if (input.roundStatus === 'voided') return { ok: false, code: 'voided-round' };
  if (input.activeRoundId === null || input.roundId !== input.activeRoundId) {
    return { ok: false, code: 'old-round-rejected' };
  }
  return { ok: true };
}

const INBOX_HINTS: Partial<
  Record<string, { readonly nextAction: ExecutionNextAction; readonly label: string }>
> = {
  'continue-handling': { nextAction: 'continue-agent', label: '继续 Agent 处理' },
  'provide-input': { nextAction: 'supply-input', label: '补充信息' },
  'retry-or-take-back': { nextAction: 'retry', label: '重试' },
  revise: { nextAction: 'revise-in-new-round', label: '按新评审轮次修改' },
  submit: { nextAction: 'edit-or-send', label: '发送给 Agent 或编辑草稿' },
};

/**
 * 重叠的节点动作来自 deriveInbox。
 * 停止回执、显式重开和已完成是工作区自己的提示，待办里没有对应项。
 */
export function executionTodoHint(input: {
  readonly nodeStatus: NodeStatus;
  readonly runStatus?: RunStatus;
  readonly stopPhase?: StopPhase;
  readonly actorId?: string;
  readonly assignee?: ActorRef;
}): { readonly nextAction: ExecutionNextAction; readonly label: string } {
  if (input.stopPhase === 'requested') {
    return { nextAction: 'wait-for-stop-receipt', label: '等待停止回执' };
  }
  if (input.nodeStatus === 'cancelled') return { nextAction: 'restart', label: '显式重新开始' };
  if (input.runStatus === 'waiting-for-input' && input.nodeStatus !== 'waiting-for-input') {
    return { nextAction: 'supply-input', label: '补充信息' };
  }
  if (input.nodeStatus === 'completed')
    return { nextAction: 'none', label: '已完成，不会再次调度' };
  const assignee = input.assignee ?? {
    id:
      input.actorId !== undefined && input.actorId.trim().length > 0 ? input.actorId : 'workspace',
    kind: 'human' as const,
  };
  const actorId =
    input.actorId !== undefined && input.actorId.trim().length > 0 ? input.actorId : assignee.id;
  const [item] = deriveInbox({
    actorId,
    nodes: [
      {
        nodeId: 'workspace',
        taskId: 'workspace',
        status: input.nodeStatus,
        assignee,
        access: 'write',
        awaitingParentConfirmation: false,
      },
    ],
    rounds: [],
    confirmations: [],
  });
  return INBOX_HINTS[item?.action ?? ''] ?? { nextAction: 'none', label: '当前没有执行动作' };
}

export function recoveryCommandFor(
  nodeStatus: NodeStatus,
  returnTo?: 'ready' | 'needs-revision',
):
  | {
      readonly ok: true;
      readonly transition: 'retry' | 'restart';
      readonly returnTo: 'ready' | 'needs-revision';
    }
  | { readonly ok: false; readonly code: 'recovery-not-available' } {
  if (returnTo !== 'ready' && returnTo !== 'needs-revision') {
    return { ok: false, code: 'recovery-not-available' };
  }
  if (nodeStatus === 'failed') return { ok: true, transition: 'retry', returnTo };
  if (nodeStatus === 'cancelled') return { ok: true, transition: 'restart', returnTo };
  return { ok: false, code: 'recovery-not-available' };
}

export function recordRecoveryRequest(input: {
  readonly id: string;
  readonly kind: 'reassign' | 'human-takeover';
  readonly assigneeId: string;
}): RecoveryRequest {
  return {
    id: input.id,
    kind: input.kind,
    status: 'recorded',
    assigneeId: input.assigneeId,
    changesAssignee: false,
    forgesRun: false,
  };
}

/** 执行器抛出的原文分成故障种类。无法归类时记为断开，避免把未知错误写成网络中断。 */
export function classifyExecutorFailure(message: string): ExecutionFaultKind {
  const text = message.toLowerCase();
  if (text.includes('未实现') || text.includes('尚未实现') || text.includes('unsupported')) {
    return 'executor-disconnected';
  }
  if (text.includes('工具') || text.includes('tool')) return 'tool-failure';
  if (
    text.includes('模型') ||
    text.includes('model') ||
    text.includes('json') ||
    text.includes('syntax') ||
    text.includes('unexpected token') ||
    text.includes('event-stream') ||
    text.includes('流式')
  ) {
    return 'model-error';
  }
  if (
    text.includes('网络') ||
    text.includes('network') ||
    text.includes('fetch') ||
    text.includes('econn') ||
    text.includes('etimedout') ||
    text.includes('enotfound') ||
    text.includes('超时') ||
    text.includes('timeout') ||
    text.includes('abort') ||
    text.includes('hang up') ||
    text.includes('socket')
  ) {
    return 'network-interruption';
  }
  return 'executor-disconnected';
}

/** 切换专家只影响下一次配置。深拷贝，调用方改嵌套字段也不会改到已保留的轮次。 */
export function preservedTurnsAfterExpertSwitch<T extends object>(turns: readonly T[]): T[] {
  return turns.map((turn) => structuredClone(turn));
}
