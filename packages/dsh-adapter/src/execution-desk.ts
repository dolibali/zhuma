import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  acceptRoundResult,
  acceptUserMessage,
  acknowledgeRun,
  admitExecutionSignal,
  advanceIntervention,
  applyNodeTransitionCommand,
  assigneeAfterAgentAssist,
  classifyExecutorFailure,
  executionTodoHint,
  isTerminalRunStatus,
  markRunWaiting,
  normalizeActivity,
  openRunAttempt,
  prepareArtifactDraft,
  presentExecutionFault,
  readNodeHandoff,
  preservedTurnsAfterExpertSwitch,
  recordRecoveryRequest,
  recoveryCommandFor,
  rejectStopReceipt,
  requestRunStop,
  resumeRunAfterInput,
  routeLiveInput,
  settleExecutionRun,
  validateExecutionConfig,
  type ActivityRecord,
  type ArtifactDraftHandoff,
  type AttachmentFact,
  type CommandErrorFact,
  type ContextBlockFact,
  type ContextCitationFact,
  type ContextItemFact,
  type ConversationTurn,
  type ExecutionAttempt,
  type ExecutionConfigSnapshot,
  type ExecutionDeskSnapshot,
  type ExecutionEngine,
  type ReviewRound,
  type ExecutionFaultKind,
  type FaultRecord,
  type InterventionRecord,
  type LateRecord,
  type NodeCommandState,
  type NodeHandoff,
  type NodeStatus,
  type NodeTransition,
  type RecoveryRequest,
  type RunSignal,
  type RunStatus,
  type WorkspaceCatalog,
} from '@zhuma/agent-core';
import {
  assembleRunContext,
  claimWritableWorkspace,
  isolateWorkspaceId,
  releaseWritableWorkspace,
  type ContextItemKind,
  type ContextSourceInput,
  type WorkspaceClaim,
} from '@zhuma/context';
import {
  selectAgentExecutor,
  SimulatedAgentExecutor,
  type AgentExecutor,
  type AgentRunEvent,
  type AgentRunRequest,
  type ResourceGrant,
} from './agent-executor.js';
import {
  DshChatExecutor,
  OFFICE_SKILL_UNAVAILABLE,
  attachmentRefusalReason,
  mcpTransportReady,
  officeSkillsReady,
} from './dsh-sdk-executor.js';
import { createFileJournal, type DeskJournal } from './file-journal.js';
import { probeRelativeFile, readRelativeFile, type FileProbeResult } from './file-probe.js';

export type { DeskJournal } from './file-journal.js';
export { createFileJournal } from './file-journal.js';

const ATTACHMENT_LIMIT = 96 * 1024;

export interface DeskContextSeed {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly sourceId: string;
  readonly version: string;
  readonly permission: 'granted' | 'denied';
  readonly summary: string;
  readonly required: boolean;
  readonly includedByDefault: boolean;
  readonly relativePath?: string;
  readonly body?: string;
  readonly sourceNodeId?: string;
  readonly artifactVersionId?: string;
  readonly contextPackId?: string;
}

export interface DeskSeed {
  readonly handoff: NodeHandoff;
  readonly taskTitle: string;
  readonly taskGoal: string;
  readonly actorId: string;
  readonly nodeStatus: NodeStatus;
  readonly catalog: WorkspaceCatalog;
  readonly contextItems: readonly DeskContextSeed[];
  readonly reviewRounds: readonly { readonly id: string; readonly status: ReviewRound['status'] }[];
  readonly fileRoot?: string;
}

export interface DeskDependencies {
  readonly executors: readonly AgentExecutor[];
  readonly newId: (prefix: string) => string;
  readonly probe?: (relativePath: string) => FileProbeResult;
  readonly journal?: DeskJournal<DeskPersistence>;
}

interface Selections {
  expertId: string;
  executorId: ExecutionEngine | null;
  skillIds: string[];
  mcpIds: string[];
}

interface OperationalCheckpoint {
  nodeState: NodeCommandState;
  runs: ExecutionAttempt[];
  turns: ConversationTurn[];
  interventions: InterventionRecord[];
  claims: WorkspaceClaim[];
  faults: FaultRecord[];
  activities: ActivityRecord[];
  lateRecords: LateRecord[];
  attachments: AttachmentFact[];
  attachmentBytes: Map<string, Uint8Array>;
  drafts: ArtifactDraftHandoff[];
  draftRoundId: string | null;
  recoveryRequests: RecoveryRequest[];
  downstreamLaunches: number;
  reviewRounds: { id: string; status: ReviewRound['status'] }[];
  activeRoundId: string | null;
  selections: Selections;
  configId: string;
  included: Set<string>;
  expertEnabled: Map<string, boolean>;
  executorConnected: Map<string, boolean>;
  citations: ContextCitationFact[];
  contextBlocks: ContextBlockFact[];
  sequence: number;
  lastError: CommandErrorFact | null;
  resumeGap: { runId: string; reason: 'session-not-resumed' } | null;
  historyNote: string | null;
}

export interface DeskPersistence {
  readonly schema: 1;
  readonly seed: DeskSeed;
  readonly nodeState: NodeCommandState;
  readonly runs: ExecutionAttempt[];
  readonly turns: ConversationTurn[];
  readonly interventions: InterventionRecord[];
  readonly lateRecords: LateRecord[];
  readonly activities: ActivityRecord[];
  readonly faults: FaultRecord[];
  readonly attachments: AttachmentFact[];
  readonly drafts: ArtifactDraftHandoff[];
  readonly recoveryRequests: RecoveryRequest[];
  readonly downstreamLaunches: number;
  readonly reviewRounds: { id: string; status: ReviewRound['status'] }[];
  readonly activeRoundId: string | null;
  readonly selections: Selections;
  readonly configId: string;
  readonly includedContextIds: string[];
  readonly expertEnabled: Record<string, boolean>;
  readonly executorConnected: Record<string, boolean>;
  readonly claims: WorkspaceClaim[];
  readonly lastError: CommandErrorFact | null;
  readonly citations: ContextCitationFact[];
  readonly contextBlocks: ContextBlockFact[];
  readonly draftRoundId?: string | null;
  readonly handoffInvalid?: boolean;
  readonly historyNote?: string;
}

export type DeskResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly snapshot: ExecutionDeskSnapshot;
      readonly runId?: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly objectLabel: string;
      readonly reason: string;
      readonly nextStep: string;
      readonly snapshot: ExecutionDeskSnapshot;
    };

interface SendInput {
  readonly text: string;
  readonly idempotencyKey: string;
  readonly intent?: 'new' | 'supplement' | 'next-turn';
  readonly attachmentIds?: readonly string[];
}

export class ExecutionDesk {
  private nodeState: NodeCommandState;
  private runs: ExecutionAttempt[] = [];
  private turns: ConversationTurn[] = [];
  private interventions: InterventionRecord[] = [];
  private lateRecords: LateRecord[] = [];
  private activities: ActivityRecord[] = [];
  private faults: FaultRecord[] = [];
  private attachments: AttachmentFact[] = [];
  private drafts: ArtifactDraftHandoff[] = [];
  private recoveryRequests: RecoveryRequest[] = [];
  private downstreamLaunches = 0;
  private reviewRounds: { id: string; status: ReviewRound['status'] }[] = [];
  private activeRoundId: string | null = null;
  private selections: Selections;
  private configId: string;
  private included = new Set<string>();
  private expertEnabled = new Map<string, boolean>();
  private executorConnected = new Map<string, boolean>();
  private claims: WorkspaceClaim[] = [];
  private lastError: CommandErrorFact | null = null;
  private citations: ContextCitationFact[] = [];
  private contextBlocks: ContextBlockFact[] = [];
  private interactionReady = false;
  private resumeGap: { runId: string; reason: 'session-not-resumed' } | null = null;
  private readonly queueApply = new Map<string, string>();
  private readonly aborts = new Map<string, AbortController>();
  private inflight: Promise<void>[] = [];
  private readonly attachmentBytes = new Map<string, Uint8Array>();
  private sequence = 0;
  private draftRoundId: string | null = null;
  private handoffInvalid = false;
  private historyNote: string | null = null;
  private persistenceFault: CommandErrorFact | null = null;
  private lastSaveFailed = false;
  private lastPersistError: unknown = null;
  /** 完成或核实已经记在内存里、但要等日志写上才真正删除的会话。 */
  private pendingSessionDeletes: string[] = [];
  /** 启动前读好的本轮正文。读失败的文件不会改用摘要。进入终态后清掉，避免多轮累积。 */
  private readonly pinnedPrompt = new Map<string, { id: string; body: string }[]>();
  /** 执行器收尾后的下一轮没写上日志。存储恢复后继续消费。 */
  private deferredQueueRunId: string | null = null;
  private consumingQueue = false;

  private readonly seed: DeskSeed;

  private constructor(
    inputSeed: DeskSeed,
    private readonly deps: DeskDependencies,
    restored: DeskPersistence | null,
  ) {
    const handoff = inputSeed.handoff;
    const read = readNodeHandoff({
      ...handoff,
      inputRefs: handoff.inputRefs ?? [],
      skillRefs: handoff.skillRefs ?? [],
      mcpRefs: handoff.mcpRefs ?? [],
    });
    const restoring = restored !== null;
    if (!read.ok && !restoring) throw new Error('invalid-handoff');
    this.handoffInvalid = restoring && (restored.handoffInvalid === true || !read.ok);
    const seed = {
      ...inputSeed,
      handoff: read.ok ? read.handoff : fallbackHandoff(handoff),
    };
    this.seed = seed;
    const expert = seed.catalog.experts.find((item) => item.enabled) ?? seed.catalog.experts[0];
    this.selections = {
      expertId: expert?.id ?? '',
      executorId: null,
      skillIds: [],
      mcpIds: [],
    };
    this.configId = deps.newId('cfg');
    for (const item of seed.contextItems) {
      if (item.includedByDefault) this.included.add(item.id);
    }
    this.reviewRounds = seed.reviewRounds.map((round) => ({ ...round }));
    this.nodeState = initialNodeState(seed.nodeStatus);
    if (!restored) {
      this.noteEntry();
      return;
    }
    this.nodeState = restored.nodeState;
    this.runs = restored.runs;
    this.turns = restored.turns;
    this.interventions = restored.interventions;
    this.lateRecords = restored.lateRecords;
    this.activities = restored.activities;
    this.faults = restored.faults;
    this.attachments = restored.attachments;
    this.drafts = restored.drafts;
    this.recoveryRequests = restored.recoveryRequests;
    this.downstreamLaunches = restored.downstreamLaunches;
    this.reviewRounds = restored.reviewRounds;
    this.activeRoundId = restored.activeRoundId;
    this.selections = restored.selections;
    this.configId = restored.configId;
    this.included = new Set(restored.includedContextIds);
    this.expertEnabled = new Map(Object.entries(restored.expertEnabled));
    this.executorConnected = new Map(Object.entries(restored.executorConnected));
    this.claims = restored.claims;
    this.lastError = restored.lastError;
    this.citations = restored.citations;
    this.contextBlocks = restored.contextBlocks;
    this.draftRoundId = restored.draftRoundId ?? null;
    // 横幅只覆盖「下一轮还没有自己的历史」。重启后不再显示。
    this.historyNote = null;
    this.sequence = restored.turns.reduce((max, turn) => Math.max(max, turn.sequence), 0);
    this.noteEntry();
    if (this.handoffInvalid) this.lastError = invalidHandoffError();
  }

  static create(seed: DeskSeed, deps: DeskDependencies): ExecutionDesk {
    const desk = new ExecutionDesk(seed, deps, null);
    desk.interactionReady = true;
    if (!desk.persist()) {
      const reason = desk.persistenceFault?.reason ?? 'persist-failed';
      throw Object.assign(new Error(reason), { code: 'persist-failed' });
    }
    return desk;
  }

  /** 先装回事实。此阶段拒绝新的执行命令，也不会把未结束的运行推断成完成。 */
  static restore(data: DeskPersistence, deps: DeskDependencies): ExecutionDesk {
    const desk = new ExecutionDesk(data.seed, deps, data);
    desk.interactionReady = false;
    desk.resumeGap = desk.abandonedRun();
    return desk;
  }

  resumeInteraction(): DeskResult {
    const ready = this.interactionReady;
    this.interactionReady = true;
    if (!this.persist()) {
      this.interactionReady = ready;
      return this.persistRejected();
    }
    return { ok: true, replayed: false, snapshot: this.snapshot() };
  }

  /** 存储恢复后，把当前内存事实重写进同一份日志。成功保存会清掉持久化故障。 */
  rewritePersistence(): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    if (!this.persist(true)) return this.persistRejected();
    return { ok: true, replayed: false, snapshot: this.snapshot() };
  }

  snapshot(): ExecutionDeskSnapshot {
    const assignee = assigneeAfterAgentAssist(this.seed.handoff.assignee);
    return {
      schema: 1,
      interactionReady: this.interactionReady,
      taskTitle: this.seed.taskTitle,
      taskGoal: this.seed.taskGoal,
      actorId: this.seed.actorId,
      handoff: copyHandoff(this.seed.handoff),
      node: {
        status: this.nodeState.status,
        version: this.nodeState.version,
        upstreamAffected: this.nodeState.upstreamAffected,
      },
      assignee,
      runs: this.runs,
      turns: this.turns,
      interventions: this.interventions,
      lateRecords: this.lateRecords,
      activities: this.activities,
      faults: this.faults,
      attachments: this.attachments.map((item) => ({
        ...item,
        contentAvailable: this.attachmentBytes.has(item.id),
      })),
      drafts: this.drafts,
      recoveryRequests: this.recoveryRequests,
      downstreamLaunches: this.downstreamLaunches,
      delivered: false,
      resumeGap: this.resumeGap,
      ...(this.historyNote !== null ? { historyNote: this.historyNote } : {}),
      lastError: this.lastError,
      reviewRounds: this.reviewRounds,
      activeRoundId: this.activeRoundId,
      config: this.buildConfig(),
      contextItems: this.contextFacts(),
      citations: this.citations,
      contextBlocks: this.contextBlocks,
      catalog: this.catalog(),
      claims: this.claims.map((claim) => ({
        workspaceId: claim.workspaceId,
        writerRunId: claim.writerRunId,
        active: claim.active,
      })),
      persistenceFault: this.persistenceFault,
    };
  }

  persistence(): DeskPersistence {
    return {
      schema: 1,
      seed: this.seed,
      nodeState: this.nodeState,
      runs: this.runs,
      turns: this.turns,
      interventions: this.interventions,
      lateRecords: this.lateRecords,
      activities: this.activities,
      faults: this.faults,
      attachments: this.attachments,
      drafts: this.drafts,
      recoveryRequests: this.recoveryRequests,
      downstreamLaunches: this.downstreamLaunches,
      reviewRounds: this.reviewRounds,
      activeRoundId: this.activeRoundId,
      selections: this.selections,
      configId: this.configId,
      includedContextIds: [...this.included],
      expertEnabled: Object.fromEntries(this.expertEnabled),
      executorConnected: Object.fromEntries(this.executorConnected),
      claims: this.claims,
      lastError: this.lastError,
      citations: this.citations,
      contextBlocks: this.contextBlocks,
      ...(this.draftRoundId !== null ? { draftRoundId: this.draftRoundId } : {}),
      ...(this.handoffInvalid ? { handoffInvalid: true } : {}),
      ...(this.historyNote !== null ? { historyNote: this.historyNote } : {}),
    };
  }

  /** 刷新和读取都走这里。关闭页面和计时器都不是调度触发。 */
  viewDidNotSchedule(): boolean {
    return true;
  }

  updateConfig(input: {
    readonly expertId?: string;
    readonly executorId?: ExecutionEngine | null;
    readonly skillIds?: readonly string[];
    readonly mcpIds?: readonly string[];
  }): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const before = this.turns.length;
    const checkpoint = this.captureOperational();
    if (input.expertId !== undefined) this.selections.expertId = input.expertId;
    if (input.executorId !== undefined) this.selections.executorId = input.executorId;
    if (input.skillIds !== undefined) this.selections.skillIds = [...input.skillIds];
    if (input.mcpIds !== undefined) this.selections.mcpIds = [...input.mcpIds];
    this.configId = this.deps.newId('cfg');
    this.turns = [...preservedTurnsAfterExpertSwitch(this.turns)];
    if (this.turns.length !== before) {
      return this.undoIfUnsaved(
        checkpoint,
        this.fail('history-lost', '对话', '切换专家时历史被改写', '停止使用这份构建'),
      );
    }
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  setAvailability(input: {
    readonly expertId?: string;
    readonly enabled?: boolean;
    readonly executorId?: ExecutionEngine;
    readonly connected?: boolean;
  }): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const checkpoint = this.captureOperational();
    if (input.expertId !== undefined && input.enabled !== undefined) {
      this.expertEnabled.set(input.expertId, input.enabled);
    }
    if (input.executorId !== undefined && input.connected !== undefined) {
      this.executorConnected.set(input.executorId, input.connected);
    }
    this.configId = this.deps.newId('cfg');
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  setContextIncluded(id: string, included: boolean): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const item = this.seed.contextItems.find((entry) => entry.id === id);
    if (!item) {
      return this.fail('context-missing', '上下文', '没有这条来源', '刷新后再选择');
    }
    if (item.required && !included) {
      return this.fail('context-required', item.sourceId, '这项上下文是本轮必需的', '保留勾选');
    }
    const checkpoint = this.captureOperational();
    if (included) this.included.add(id);
    else this.included.delete(id);
    this.contextBlocks = [];
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  addAttachment(input: {
    readonly name: string;
    readonly mediaType: string;
    readonly text?: string;
    readonly bytesBase64?: string;
  }): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const name = path.posix.basename(input.name.replaceAll('\\', '/'));
    if (name.length === 0 || name === '.' || name === '..') {
      return this.fail('attachment-name', '附件', '文件名无效', '换一个文件名后再上传');
    }
    const encoded =
      typeof input.bytesBase64 === 'string'
        ? Buffer.from(input.bytesBase64, 'base64')
        : typeof input.text === 'string'
          ? Buffer.from(input.text, 'utf8')
          : null;
    if (encoded === null) {
      return this.fail('attachment-type', name, '缺少文件内容', '重新选择文件');
    }
    if (encoded.byteLength > ATTACHMENT_LIMIT) {
      return this.fail(
        'attachment-too-large',
        name,
        '附件超过 96 KB',
        '缩小文件或改成链接后再上传',
      );
    }
    if (input.mediaType.trim().length === 0) {
      return this.fail('attachment-type', name, '缺少媒体类型', '重新选择文件');
    }
    const refused = attachmentRefusalReason(name, input.mediaType);
    if (refused !== null) {
      return this.fail(
        'attachment-unsupported',
        name,
        refused,
        '改用文本、JSON 或 png、jpeg、webp、gif 图片',
      );
    }
    const id = this.deps.newId('file');
    const previewText =
      input.mediaType.startsWith('text/') && typeof input.text === 'string'
        ? input.text.slice(0, 80)
        : '';
    const checkpoint = this.captureOperational();
    this.attachments = [
      ...this.attachments,
      {
        id,
        name,
        mediaType: input.mediaType,
        byteSize: encoded.byteLength,
        checksum: createHash('sha256').update(encoded).digest('hex'),
        reference: `attachment:${id}`,
        ...(previewText.length > 0 ? { previewText } : {}),
      },
    ];
    this.attachmentBytes.set(id, encoded);
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  removeAttachment(id: string): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const checkpoint = this.captureOperational();
    this.attachments = this.attachments.filter((item) => item.id !== id);
    const saved = this.succeed();
    if (!saved.ok || this.lastSaveFailed) return this.undoIfUnsaved(checkpoint, saved);
    this.attachmentBytes.delete(id);
    return { ...saved, snapshot: this.snapshot() };
  }

  send(input: SendInput): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    if (this.brokenRecord()) return this.recordBlocked();
    const replay = this.replayRun(input) ?? this.replayQueued(input);
    if (replay) return replay;
    if (this.resumeGap) return this.gapBlocked();
    const active = this.activeRun();
    if (active) return this.enqueue(active, input);
    const opened = this.beginRun(input);
    if (!opened.ok) return opened;
    if (!opened.replayed && opened.runId)
      this.startDrive(opened.runId, input.text, input.attachmentIds ?? []);
    return opened;
  }

  async stop(): Promise<DeskResult> {
    if (!this.interactionReady) return this.blockedRestore();
    if (this.brokenRecord()) return this.recordBlocked();
    if (this.resumeGap) return this.gapBlocked();
    const active = this.activeRun();
    if (!active) {
      return this.fail('run-terminal', '运行', '没有可停止的有效运行', '刷新后再看是否需要重试');
    }
    const requested = requestRunStop(active);
    if (!requested.ok) {
      return this.fail('terminal-run', active.id, '运行已经结束，停止不能改写它', '查看附属记录');
    }
    const previous = active;
    this.putRun(requested.attempt);
    if (!this.persist()) {
      this.putRun(previous);
      return this.persistRejected();
    }
    let executor: AgentExecutor;
    try {
      executor = selectAgentExecutor(active.executor, this.deps.executors);
    } catch (error) {
      return this.fail(
        'executor-not-selected',
        active.executor,
        error instanceof Error ? error.message : '执行器缺失',
        '不要把节点标成已取消',
      );
    }
    const receipt = await cancelWithTimeout(executor.cancel(active.id));
    const latest = this.runs.find((run) => run.id === active.id) ?? requested.attempt;
    if (latest.status === 'cancelled' || receipt.receipt === 'cancelled') {
      this.dropPending(active.id);
      if (!this.persist(false, true)) return this.persistRejected();
      return this.succeed({ runId: active.id });
    }
    this.putRun(rejectStopReceipt(latest));
    if (!latest.acknowledged) this.dropPending(active.id);
    return this.fail(
      'stop-receipt-missing',
      humanExecutor(executor.id),
      receipt.reason ?? '没有取得取消回执',
      '节点保持原状态。不能把关闭页面当成取消。',
    );
  }

  retry(idempotencyKey: string): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    if (this.brokenRecord()) return this.recordBlocked();
    const returnTo = recordedEntryStatus(this.nodeState);
    if (returnTo === undefined) {
      return this.fail(
        'recovery-not-available',
        '节点',
        '没有记下进入运行前的状态，不能重试或重新开始',
        '失败用重试，取消后用显式重新开始。returnTo 只取节点命令记下的 entryStatus',
      );
    }
    const recovery = recoveryCommandFor(this.nodeState.status, returnTo);
    if (!recovery.ok) {
      return this.fail(
        'recovery-not-available',
        '节点',
        '当前状态不能重试或重新开始',
        '失败用重试，取消后用显式重新开始，并带回进入运行前的 ready 或 needs-revision',
      );
    }
    const transition: NodeTransition =
      recovery.transition === 'retry' ? { type: 'retry', returnTo } : { type: 'restart', returnTo };
    const checkpoint = this.captureOperational();
    const applied = this.applyTransition(transition, `recovery:${idempotencyKey}`);
    if (!applied.ok) {
      return this.undoIfUnsaved(
        checkpoint,
        this.fail(
          'recovery-rejected',
          '节点',
          recoveryRejectedReason(idempotencyKey, applied.code),
          '刷新事实后再看节点是否已经恢复。不要重复使用同一个请求标识。',
        ),
      );
    }
    const last = [...this.turns].reverse().find((turn) => turn.role === 'user');
    if (!last) return this.undoIfUnsaved(checkpoint, this.succeed());
    return this.undoIfUnsaved(
      checkpoint,
      this.send({
        text: last.body,
        idempotencyKey: `retry-run:${idempotencyKey}`,
        attachmentIds: last.attachmentIds,
        intent: 'new',
      }),
    );
  }

  recover(kind: 'reassign' | 'human-takeover'): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const assignee = assigneeAfterAgentAssist(this.seed.handoff.assignee);
    const checkpoint = this.captureOperational();
    this.recoveryRequests = [
      ...this.recoveryRequests,
      recordRecoveryRequest({ id: this.deps.newId(kind), kind, assigneeId: assignee.id }),
    ];
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  verifyAbandoned(): DeskResult {
    if (this.deps.journal?.writable === false) return this.writeLocked();
    if (!this.interactionReady) return this.blockedRestore();
    const gap = this.resumeGap;
    if (!gap) {
      return this.fail('abandon-missing', '运行', '没有待核实的中断运行', '先恢复事实');
    }
    const run = this.runs.find((item) => item.id === gap.runId);
    if (!run || isTerminalRunStatus(run.status)) {
      const checkpoint = this.captureOperational();
      this.resumeGap = null;
      return this.undoIfUnsaved(
        checkpoint,
        this.fail('terminal-run', gap.runId, '运行已经结束', '不要再次改写节点'),
      );
    }
    const checkpoint = this.captureOperational();
    const settled = settleExecutionRun(run, 'failed');
    if (!settled.ok) {
      return this.undoIfUnsaved(
        checkpoint,
        this.fail('terminal-run', run.id, '不能把已结束的运行再标成失败', '保留现有事实'),
      );
    }
    this.putRun(settled.attempt);
    if (settled.nodeTransition.type === 'execution-failed') {
      const moved = this.applyTransition(settled.nodeTransition, `abandon:${run.id}`);
      if (!moved.ok) this.preserveRecordError();
    }
    const fault = presentExecutionFault('executor-disconnected');
    this.faults.push({
      id: this.deps.newId('fault'),
      kind: 'executor-disconnected',
      objectLabel: fault.objectLabel,
      reason: '重启后原执行器会话不在。这是核实后的失败，不是完成。',
      nextStep: fault.nextStep,
      forgesRun: false,
      runId: run.id,
    });
    this.resumeGap = null;
    this.dropPending(run.id);
    this.releaseClaim(run.id);
    this.dropEmptyExecutorTurn(run.id);
    this.discardRunSession(run);
    return this.undoIfUnsaved(checkpoint, this.succeed({ runId: run.id }));
  }

  /** 保存失败则退回这次草稿，内存与调用前一致。 */
  saveDraft(text: string): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const producer = [...this.runs].reverse().find((run) => run.status === 'completed');
    const roundId = this.draftRoundId ?? this.deps.newId('round');
    const draft = prepareArtifactDraft({
      nodeId: this.seed.handoff.nodeId,
      text,
      previousRoundIds: this.reviewRounds.map((round) => round.id),
      existingRounds: this.reviewRounds,
      newRoundId: roundId,
      ...(producer ? { producerRunId: producer.id } : {}),
    });
    if (!draft.ok) {
      return this.fail(
        draft.code,
        '产物草稿',
        draft.code === 'voided-round' ? '目标轮次已作废' : '不能把草稿交回旧评审轮次',
        '使用新的评审轮次。此操作不会自动交付。',
      );
    }
    const checkpoint = this.captureOperational();
    this.draftRoundId = roundId;
    this.drafts = [draft.draft];
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  /** 显式拒绝把旧轮次或作废轮次的结果当成推进。 */
  acceptReviewResult(roundId: string, roundStatus: string): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    if (!isReviewRoundStatus(roundStatus)) {
      return this.fail(
        'invalid-round',
        roundId,
        '轮次状态无法识别',
        '使用开放、通过、退回或作废。',
      );
    }
    const decision = acceptRoundResult({
      roundId,
      roundStatus,
      activeRoundId: this.activeRoundId,
    });
    if (!decision.ok) {
      return this.fail(
        decision.code,
        roundId,
        decision.code === 'voided-round' ? '该评审轮次已作废' : '这不是当前轮次的结果',
        '不要用它改变节点状态',
      );
    }
    const checkpoint = this.captureOperational();
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  /**
   * 把不要求评审的节点标成已完成。进入 `completed` 时删除会话目录。
   * 历史运行仍保留 sessionId，并标成已丢弃。交接要求评审时拒绝，不直接完成。
   */
  confirmCompleted(): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    if (this.brokenRecord()) return this.recordBlocked();
    if (this.resumeGap) return this.gapBlocked();
    if (this.activeRun()) {
      return this.fail('run-active', '节点', '还有运行没有结束', '先结束运行再确认完成');
    }
    if (this.nodeState.status === 'completed') return this.succeed();
    if (this.seed.handoff.reviewRequired) {
      return this.fail(
        'review-required',
        '节点',
        '交接要求评审，不能直接完成',
        '请走评审路径。不要跳过评审把节点标成完成。',
      );
    }
    const checkpoint = this.captureOperational();
    const moved = this.applyTransition(
      { type: 'submit-artifact', reviewRequired: false },
      `complete:${this.deps.newId('complete')}`,
    );
    if (!moved.ok) {
      return this.undoIfUnsaved(
        checkpoint,
        this.fail(
          'illegal-transition',
          '节点',
          '节点现在不能标成完成',
          '先结束当前运行。需修改的节点不能跳过评审直接完成。',
        ),
      );
    }
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  /** 已完成的节点被退回，进入需修改。不恢复已删除的会话，也不自动开始运行。 */
  reopenForRework(): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    if (this.nodeState.status !== 'completed') {
      return this.fail('not-completed', '节点', '只有已完成的节点可以退回', '先确认完成');
    }
    const checkpoint = this.captureOperational();
    const moved = this.applyTransition(
      { type: 'reopen-for-rework' },
      `reopen:${this.deps.newId('reopen')}`,
    );
    if (!moved.ok) {
      return this.undoIfUnsaved(
        checkpoint,
        this.fail('illegal-transition', '节点', '节点现在不能退回', '保持已完成'),
      );
    }
    return this.undoIfUnsaved(checkpoint, this.succeed());
  }

  markWaitingForInput(): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const active = this.activeRun();
    if (!active)
      return this.fail('run-terminal', '运行', '没有正在执行的运行', '不要凭空进入等待输入');
    const marked = markRunWaiting(active);
    if (!marked.ok) {
      return this.fail(marked.code, active.id, '运行还不能进入等待输入', '先取得执行回执');
    }
    const checkpoint = this.captureOperational();
    const applied = this.applyTransition({ type: 'input-required' }, `wait:${active.id}`);
    if (!applied.ok) {
      this.preserveRecordError();
      const rejected = this.fail('illegal-transition', '节点', '节点不能进入等待输入', '刷新事实');
      return this.undoIfUnsaved(checkpoint, rejected);
    }
    this.putRun(marked.attempt);
    return this.undoIfUnsaved(checkpoint, this.succeed({ runId: active.id }));
  }

  releaseActive(): void {
    const active = this.activeRun();
    if (!active) return;
    const executor = this.deps.executors.find((item) => item.id === active.executor);
    if (executor instanceof SimulatedAgentExecutor) executor.release(active.id);
  }

  /** 测试钩子：丢掉记下的入口，不释放正在执行的运行。 */
  dropRecordedEntry(): void {
    const { entryStatus: _ignored, ...rest } = this.nodeState;
    this.nodeState = rest;
    this.persist(false, true);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  async waitForRun(runId: string, status: RunStatus): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 3000) {
      const run = this.runs.find((item) => item.id === runId);
      if (run?.status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`运行 ${runId} 没有进入 ${status}`);
  }

  private replayRun(input: SendInput): DeskResult | null {
    const existing = this.runs.find((run) => run.idempotencyKey === input.idempotencyKey);
    if (!existing) return null;
    const payloadHash = hashPayload({
      text: input.text.trim(),
      attachmentIds: [...(input.attachmentIds ?? [])],
    });
    if (existing.payloadHash !== payloadHash) {
      return this.fail(
        'idempotency-mismatch',
        input.idempotencyKey,
        '同一个请求标识对应了不同内容',
        '换一个新请求再发送',
      );
    }
    return this.succeed({ replayed: true, runId: existing.id });
  }

  /** 已经入队的幂等键在运行结束后仍然只重放，不再开第二次执行。 */
  private replayQueued(input: SendInput): DeskResult | null {
    const existing = this.interventions.find(
      (item) => item.idempotencyKey === input.idempotencyKey,
    );
    if (!existing) return null;
    const intent = input.intent === 'next-turn' ? 'next-turn' : 'supplement';
    const attachments = this.frozenAttachments([...(input.attachmentIds ?? [])]);
    const payloadHash = hashPayload(
      queueFingerprint(input.text.trim(), intent, existing.runId, attachments),
    );
    if (existing.payloadHash !== payloadHash) {
      return this.fail(
        'idempotency-mismatch',
        input.idempotencyKey,
        '同一个请求标识对应了不同内容',
        '换一个新请求再发送',
      );
    }
    return this.succeed({ replayed: true, runId: existing.appliedRunId ?? existing.runId });
  }

  private beginRun(input: SendInput): DeskResult {
    if (!entryIsConsistent(this.nodeState)) {
      if (this.brokenRecord()) return this.recordBlocked();
      return this.fail(
        'entry-inconsistent',
        '节点',
        '读回的入口和节点状态对不上',
        '不要按这份记录发送。先核对节点命令里的 entryStatus。',
      );
    }
    const text = input.text.trim();
    if (text.length === 0) {
      return this.fail('empty-message', '消息', '没有要发送的内容', '写上本轮要求后再发送');
    }
    const attachmentIds = [...(input.attachmentIds ?? [])];
    const unknown = this.unknownAttachment(attachmentIds);
    if (unknown) return unknown;
    const config = this.buildConfig();
    const issues = validateExecutionConfig(config);
    if (!issues.ok) {
      const issue = issues.issues[0];
      return this.fail(
        issue?.code ?? 'config-invalid',
        issue?.target ?? '配置',
        issue?.reason ?? '执行配置无效',
        '修正配置后再发送。未配置时不会改用模拟执行器。',
      );
    }
    if (config.executorId === null) {
      return this.fail(
        'executor-not-selected',
        '执行器',
        '尚未选择执行器',
        '请显式选择。不会自动改用模拟。',
      );
    }
    let executor: AgentExecutor;
    try {
      executor = selectAgentExecutor(config.executorId, this.deps.executors);
    } catch (error) {
      return this.fail(
        'executor-not-selected',
        config.executorId,
        error instanceof Error ? error.message : '执行器未配置',
        '不会静默改用模拟执行器',
      );
    }
    if (executor.capabilities.mode === 'native' && !executor.capabilities.verified) {
      return this.fail(
        'executor-unverified',
        executor.id,
        executor.unavailableReason ?? '该执行器尚未实现或尚未验证',
        '不要伪造运行。可以改选已明确标注的模拟执行器。',
      );
    }
    const assembled = this.assemble();
    if (!assembled.ok) {
      const block = assembled.blocks[0];
      const blockedItem = this.seed.contextItems.find((item) => item.sourceId === block?.sourceId);
      const node = blockedItem?.sourceNodeId ?? blockedItem?.sourceId ?? block?.sourceId ?? '来源';
      const version =
        blockedItem === undefined
          ? (block?.version ?? '')
          : blockedItem.artifactVersionId !== undefined &&
              blockedItem.artifactVersionId !== blockedItem.version
            ? `${blockedItem.version}（产物 ${blockedItem.artifactVersionId}）`
            : (blockedItem.artifactVersionId ?? blockedItem.version);
      return this.fail(
        'context-blocked',
        node,
        `来源节点 ${node} 的版本 ${version} 被阻塞：${block?.reason ?? 'context-blocked'}。`,
        '补齐文件或权限，或移除此来源后再运行。不会传出不可访问的本机路径。',
      );
    }
    const payloadHash = hashPayload({
      text,
      attachmentIds,
    });
    const opened = openRunAttempt({
      nodeStatus: this.nodeState.status,
      runs: this.runs,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      executor: config.executorId,
      expertEnabled: config.expertEnabled,
      executorConnected: config.executorAvailable,
      trigger: 'explicit-run-request',
      nodeId: this.seed.handoff.nodeId,
      workflowVersionId: this.seed.handoff.workflowVersionId,
      planRevision: this.seed.handoff.revision,
      contextRefs: assembled.manifest.citations.map((item) => item.reference),
      expertVersionId: config.expertVersionId,
      configSnapshotId: config.id,
      simulated: config.simulated,
      newRunId: this.deps.newId('run'),
      ...(config.simulated ? { modelLabel: config.modelLabel } : {}),
    });
    if (!opened.ok) {
      return this.fail(
        opened.code,
        this.seed.handoff.nodeId,
        openRunReason(opened.code),
        openRunNext(opened.code),
      );
    }
    if (opened.reused) return this.succeed({ replayed: true, runId: opened.attempt.id });
    const frozen = this.freezePromptContext();
    if (!frozen.ok) return this.unreadableContext(frozen.item);
    const claimed = claimWritableWorkspace({
      workspaceId: isolateWorkspaceId(this.seed.handoff.nodeId),
      writerRunId: opened.attempt.id,
      existing: this.claims,
    });
    if (!claimed.ok) {
      return this.fail(
        'workspace-busy',
        claimed.writerRunId,
        '这个可写工作区已经有一个有效写入者',
        '等待对方结束，或使用本次运行自己的隔离工作区',
      );
    }
    const checkpoint = this.captureAccept();
    this.claims = [...this.claims, claimed.claim];
    this.runs = [...this.runs, opened.attempt];
    this.turns = [
      ...this.turns,
      {
        id: this.deps.newId('turn'),
        runId: opened.attempt.id,
        nodeId: opened.attempt.nodeId,
        role: 'user',
        body: text,
        attachmentIds,
        expertVersionId: config.expertVersionId,
        configSnapshotId: config.id,
        simulated: false,
        sequence: ++this.sequence,
      },
    ];
    this.citations = assembled.manifest.citations.map((item) => ({
      id: item.id,
      kind: item.kind,
      sourceId: item.sourceId,
      version: item.version,
      summary: item.summary,
      reference: item.reference,
    }));
    this.contextBlocks = [];
    this.pinnedPrompt.set(opened.attempt.id, frozen.blocks);
    const committed = this.succeed({ runId: opened.attempt.id });
    if (!committed.ok) {
      this.pinnedPrompt.delete(opened.attempt.id);
      this.restoreAccept(checkpoint);
      return this.persistRejected();
    }
    return committed;
  }

  private enqueue(active: ExecutionAttempt, input: SendInput): DeskResult {
    const text = input.text.trim();
    if (text.length === 0) {
      return this.fail('empty-message', '消息', '没有要补充的内容', '写上内容后再发送');
    }
    const unknown = this.unknownAttachment([...(input.attachmentIds ?? [])]);
    if (unknown) return unknown;
    let executor: AgentExecutor;
    try {
      executor = selectAgentExecutor(active.executor, this.deps.executors);
    } catch (error) {
      return this.fail(
        'executor-not-selected',
        active.executor,
        error instanceof Error ? error.message : '执行器缺失',
        '不会改用另一个执行器',
      );
    }
    const intent = input.intent === 'next-turn' ? 'next-turn' : 'supplement';
    const routed = routeLiveInput({
      runStatus: active.status,
      supportsLiveInjection: executor.capabilities.liveInjection,
      intent,
    });
    if (!routed.ok) {
      return this.fail(
        'run-not-active',
        active.id,
        '运行已结束，不能再插入',
        '如需继续，显式开始下一轮',
      );
    }
    const attachments = this.frozenAttachments([...(input.attachmentIds ?? [])]);
    const payloadHash = hashPayload(queueFingerprint(text, intent, active.id, attachments));
    const deduped = acceptUserMessage({
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      existing: this.interventions,
    });
    if (deduped.action === 'replay') return this.succeed({ replayed: true, runId: active.id });
    if (deduped.action === 'mismatch') {
      return this.fail(
        'idempotency-mismatch',
        input.idempotencyKey,
        '同一个请求标识对应了不同内容',
        '换一个新请求再发送',
      );
    }
    let phase = advanceIntervention('sent', 'receive');
    if (!phase.ok)
      return this.fail(phase.code, '队列', '介入状态不能跳跃', '不要把发送成功显示成已应用');
    if (routed.queued) {
      phase = advanceIntervention(phase.phase, 'queue');
      if (!phase.ok) return this.fail(phase.code, '队列', '不能进入待生效', '保持已接收');
    }
    const record: InterventionRecord = {
      id: this.deps.newId('queue'),
      runId: active.id,
      kind: routed.kind,
      phase: phase.phase,
      body: text,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(routed.notice !== undefined ? { notice: routed.notice } : {}),
    };
    const checkpoint = this.captureQueue();
    this.interventions = [...this.interventions, record];
    if (routed.kind === 'resume-input') {
      const resumed = resumeRunAfterInput(active);
      if (!resumed.ok) {
        const rejected = this.fail(
          'not-waiting',
          active.id,
          '运行并不在等待输入',
          '消息留在已接收，未应用',
        );
        if (this.lastSaveFailed) {
          this.restoreQueue(checkpoint);
          return this.persistRejected();
        }
        return rejected;
      }
      const applied = this.applyTransition({ type: 'input-supplied' }, `resume:${record.id}`);
      if (!applied.ok) {
        this.preserveRecordError();
        const kept = this.succeed({ runId: active.id });
        if (!kept.ok || this.lastSaveFailed) {
          this.restoreQueue(checkpoint);
          return this.persistRejected();
        }
        return kept;
      }
      const done = advanceIntervention(record.phase, 'apply');
      if (done.ok) {
        this.interventions = this.interventions.map((item) =>
          item.id === record.id
            ? copyIntervention(item, done.phase, { appliedRunId: active.id })
            : item,
        );
      }
      this.putRun(resumed.attempt);
    }
    const committed = this.succeed({ runId: active.id });
    if (!committed.ok || this.lastSaveFailed) {
      this.restoreQueue(checkpoint);
      return this.persistRejected();
    }
    return committed;
  }

  private startDrive(runId: string, instruction: string, attachmentIds: readonly string[]): void {
    const controller = new AbortController();
    this.aborts.set(runId, controller);
    const promise = this.drive(runId, instruction, attachmentIds, controller.signal);
    this.inflight.push(promise);
    void promise
      .catch((error: unknown) => {
        if (this.persistenceFault === null) this.persistenceFault = persistenceFaultFrom(error);
      })
      .finally(() => {
        this.inflight = this.inflight.filter((item) => item !== promise);
        this.aborts.delete(runId);
      });
  }

  private async drive(
    runId: string,
    instruction: string,
    attachmentIds: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    const attempt = this.runs.find((run) => run.id === runId);
    if (!attempt) return;
    let executor: AgentExecutor;
    try {
      executor = selectAgentExecutor(attempt.executor, this.deps.executors);
    } catch (error) {
      this.applyFault(
        runId,
        'executor-disconnected',
        error instanceof Error ? error.message : '执行器缺失',
      );
      return;
    }
    this.noteUnconnectedMcp(attempt);
    const resumeSessionId = this.previousSessionId(attempt.nodeId, runId);
    const request: AgentRunRequest = {
      runId,
      attempt: attempt.attempt,
      generation: attempt.generation,
      taskId: this.seed.handoff.taskId,
      nodeId: attempt.nodeId,
      workflowVersionId: attempt.workflowVersionId,
      planRevision: attempt.planRevision,
      contextReferences: attempt.contextRefs,
      expertVersionId: attempt.expertVersionId,
      resourceGrants: this.grants(attachmentIds),
      instruction,
      attachmentIds,
      goal: this.seed.handoff.goal,
      inputNote: this.seed.handoff.inputNote,
      expectedOutput: this.seed.handoff.expectedOutput,
      simulatedRequested: attempt.simulated,
      signal,
      skills: this.authorized('skill'),
      mcp: this.authorized('mcp'),
      toolAllowlist: this.toolAllowlist(),
      attachments: this.attachmentPayloads(attachmentIds),
      promptContext: this.promptContext(runId),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    };
    try {
      for await (const event of executor.run(request)) this.applyExecutorEvent(runId, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行器中断';
      this.applyFault(runId, classifyExecutorFailure(message), message);
    }
  }

  private applyExecutorEvent(runId: string, event: AgentRunEvent): void {
    const attempt = this.runs.find((run) => run.id === runId);
    if (!attempt) return;
    if (event.type === 'accepted') {
      if (isTerminalRunStatus(attempt.status)) {
        this.addLate(attempt, 'output-arrived', '执行器在运行结束后才回执接收。', 'terminal-run');
        return;
      }
      const acked = acknowledgeRun(attempt, {
        accepted: true,
        executorRunId: event.executorRunId,
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      });
      if (!acked.ok || !acked.mayMarkNodeRunning) {
        if (!acked.ok) this.addLate(attempt, 'output-arrived', '接收回执已迟到。', 'terminal-run');
        return;
      }
      const applied = this.applyTransition({ type: 'execution-acknowledged' }, `ack:${runId}`);
      if (!applied.ok) {
        const executor = this.deps.executors.find((item) => item.id === attempt.executor);
        if (executor) void executor.cancel(runId);
        const settled = settleExecutionRun(attempt, 'failed');
        if (settled.ok) this.putRun(settled.attempt);
        this.dropPending(runId);
        this.releaseClaim(runId);
        this.lastError = missingRecord();
        this.persistEvent();
        return;
      }
      this.putRun(acked.attempt);
      this.noteQueueApplied(runId);
      this.ensureExecutorTurn(acked.attempt, '');
      this.persistEvent();
      return;
    }
    if (event.type === 'delta') {
      const admission = this.admit(attempt, 'output-arrived');
      if (admission.disposition !== 'apply') {
        this.addLate(attempt, 'output-arrived', event.text, admission.reason ?? 'terminal-run');
        this.persistEvent();
        return;
      }
      this.appendExecutorText(attempt, event.text, event.simulated);
      this.persistEvent();
      return;
    }
    if (event.type === 'activity') {
      this.activities.push(
        normalizeActivity({
          id: event.activity.id,
          runId,
          title: event.activity.title,
          detail: event.activity.detail,
          simulated: event.activity.simulated,
          succeeded: event.activity.succeeded,
        }),
      );
      this.persistEvent();
      return;
    }
    if (event.type === 'late-output') {
      this.addLate(attempt, 'output-arrived', event.text);
      this.persistEvent();
      return;
    }
    if (event.type === 'completed') {
      this.finishRun(attempt, event.result.draftText, event.result.simulated);
      return;
    }
    if (event.type === 'failed') {
      if (event.droppedSessionId !== undefined) {
        this.retireSession(event.droppedSessionId);
        this.rememberHistoryOmitted();
        const executor = this.deps.executors.find((item) => item instanceof DshChatExecutor);
        if (executor instanceof DshChatExecutor) executor.discardSession(event.droppedSessionId);
      }
      this.applyFault(runId, event.fault, event.message);
      return;
    }
    const admission = this.admit(attempt, 'cancel-confirmed');
    if (admission.disposition !== 'apply' || !admission.mayChangeNodeStatus) {
      this.addLate(
        attempt,
        'cancel-confirmed',
        '取消回执已迟到。',
        admission.reason ?? 'terminal-run',
      );
      this.persistEvent();
      return;
    }
    const settled = settleExecutionRun(attempt, 'cancelled');
    if (!settled.ok) {
      this.addLate(
        attempt,
        'cancel-confirmed',
        settled.code === 'cancel-unconfirmed' ? '尚未请求停止，取消不能生效。' : '取消回执已迟到。',
        settled.code === 'cancel-unconfirmed' ? 'cancel-unconfirmed' : 'terminal-run',
      );
      this.persistEvent();
      return;
    }
    this.putRun(settled.attempt);
    if (settled.nodeTransition.type === 'cancel-confirmed') {
      const moved = this.applyTransition(settled.nodeTransition, `cancel:${runId}`);
      if (!moved.ok) this.preserveRecordError();
    }
    this.dropEmptyExecutorTurn(runId);
    this.dropPending(runId);
    this.releaseClaim(runId);
    this.persistEvent();
  }

  private finishRun(attempt: ExecutionAttempt, draftText: string, simulated: boolean): void {
    const admission = this.admit(attempt, 'succeeded');
    if (admission.disposition !== 'apply' || !admission.mayUpdateRunRecord) {
      this.addLate(attempt, 'succeeded', draftText, admission.reason ?? 'terminal-run');
      this.persistEvent();
      return;
    }
    const settled = settleExecutionRun(attempt, 'completed');
    if (!settled.ok) {
      this.addLate(attempt, 'succeeded', draftText, 'terminal-run');
      this.persistEvent();
      return;
    }
    this.appendExecutorText(attempt, '', simulated, draftText);
    if (settled.nodeTransition.type === 'execution-finished') {
      const returnTo = recordedEntryStatus(this.nodeState);
      if (returnTo === undefined) {
        this.failInconsistentRun(attempt.id);
        return;
      }
      const moved = this.applyTransition(
        { type: 'execution-finished', returnTo },
        `finish:${attempt.id}`,
      );
      if (!moved.ok) {
        this.failInconsistentRun(attempt.id);
        return;
      }
      this.putRun(settled.attempt);
      this.releaseClaim(attempt.id);
      this.noteFreshHistory(settled.attempt);
      this.persistEvent();
      this.consumeQueue(attempt.id);
      return;
    }
    this.putRun(settled.attempt);
    this.noteFreshHistory(settled.attempt);
    this.persistEvent();
  }

  private consumeQueue(finishedRunId: string): void {
    if (this.consumingQueue) return;
    this.consumingQueue = true;
    try {
      this.consumeQueueBody(finishedRunId);
    } finally {
      this.consumingQueue = false;
    }
  }

  private consumeQueueBody(finishedRunId: string): void {
    const pending = this.interventions.filter(
      (item) => item.runId === finishedRunId && item.phase === 'pending',
    );
    const first = pending[0];
    if (!first) return;
    const frozen = first.attachments ?? [];
    const missingBytes = frozen.filter((item) => {
      const bytes = this.attachmentBytes.get(item.id);
      if (bytes === undefined || bytes.byteLength !== item.byteSize) return true;
      return createHash('sha256').update(bytes).digest('hex') !== item.checksum;
    });
    if (missingBytes.length > 0) {
      this.dropPending(finishedRunId, '附件内容不在，需重新上传');
      this.persistEvent();
      return;
    }
    const attachmentIds = frozen.map((item) => item.id);
    const opened = this.beginRun({
      text: first.body,
      idempotencyKey: `apply:${first.id}`,
      intent: 'new',
      attachmentIds,
    });
    if (!opened.ok) {
      if (opened.code === 'persist-failed') {
        this.deferredQueueRunId = finishedRunId;
        if (this.persistenceFault === null) {
          this.persistenceFault = persistenceFaultFrom(this.lastPersistError);
        }
        return;
      }
      this.dropPending(finishedRunId, opened.reason);
      this.persistEvent();
      return;
    }
    if (!opened.runId || opened.replayed) return;
    const nextRunId = opened.runId;
    this.queueApply.set(nextRunId, first.id);
    const moving = new Set(pending.slice(1).map((item) => item.id));
    if (moving.size > 0) {
      this.interventions = this.interventions.map((item) =>
        moving.has(item.id) ? copyIntervention(item, item.phase, { runId: nextRunId }) : item,
      );
    }
    this.startDrive(nextRunId, first.body, attachmentIds);
  }

  private dropPending(runId: string, blockedReason?: string): void {
    const applying = this.queueApply.get(runId);
    const notice = blockedReason
      ? `下一轮没有启动：${blockedReason}`
      : '这次运行已结束，队列里的内容未应用。';
    this.interventions = this.interventions.map((item) => {
      const tied = item.runId === runId || item.id === applying;
      if (!tied || item.phase !== 'pending') return item;
      return copyIntervention(item, 'not-applied', { notice });
    });
    if (applying) this.queueApply.delete(runId);
  }

  /** 运行中丢掉入口记录时，把这次运行标成失败，不推进节点。 */
  private failInconsistentRun(runId: string): void {
    const attempt = this.runs.find((run) => run.id === runId);
    this.lastError = missingRecord();
    if (attempt && !isTerminalRunStatus(attempt.status)) {
      const settled = settleExecutionRun(attempt, 'failed');
      if (settled.ok) this.putRun(settled.attempt);
    }
    this.dropPending(runId);
    this.releaseClaim(runId);
    this.persistEvent();
  }

  private noteQueueApplied(runId: string): void {
    const interventionId = this.queueApply.get(runId);
    if (!interventionId) return;
    this.interventions = this.interventions.map((item) => {
      if (item.id !== interventionId) return item;
      const next = advanceIntervention(item.phase, 'apply');
      return next.ok ? copyIntervention(item, next.phase, { appliedRunId: runId }) : item;
    });
  }

  private applyFault(runId: string, kind: ExecutionFaultKind, message: string): void {
    const attempt = this.runs.find((run) => run.id === runId);
    if (!attempt || isTerminalRunStatus(attempt.status)) {
      if (attempt) this.addLate(attempt, 'failed', message, 'terminal-run');
      this.persistEvent();
      return;
    }
    const settled = settleExecutionRun(attempt, 'failed');
    if (!settled.ok) {
      this.addLate(attempt, 'failed', message, 'terminal-run');
      this.persistEvent();
      return;
    }
    this.putRun(settled.attempt);
    if (settled.nodeTransition.type === 'execution-failed') {
      const moved = this.applyTransition(settled.nodeTransition, `fail:${runId}`);
      if (!moved.ok) this.preserveRecordError();
    }
    const presented = presentExecutionFault(kind);
    this.faults.push({
      id: this.deps.newId('fault'),
      kind,
      objectLabel: presented.objectLabel,
      reason: message || presented.reason,
      nextStep: presented.nextStep,
      forgesRun: false,
      runId,
    });
    this.dropEmptyExecutorTurn(runId);
    this.dropPending(runId);
    this.releaseClaim(runId);
    this.persistEvent();
  }

  private admit(attempt: ExecutionAttempt, signal: RunSignal) {
    return admitExecutionSignal({
      runStatus: attempt.status,
      runId: attempt.id,
      runGeneration: attempt.generation,
      activeRunId: this.activeRun()?.id ?? null,
      currentGeneration: this.currentGeneration(),
      signal,
    });
  }

  private addLate(
    attempt: ExecutionAttempt,
    signal: RunSignal,
    summary: string,
    reason: LateRecord['reason'] = 'terminal-run',
  ): void {
    const admission = this.admit(attempt, signal);
    this.lateRecords.push({
      id: this.deps.newId('late'),
      runId: attempt.id,
      generation: attempt.generation,
      signal,
      reason: admission.reason ?? reason,
      summary,
      mayChangeNodeStatus: false,
      mayTriggerDownstream: false,
    });
  }

  private dropEmptyExecutorTurn(runId: string): void {
    this.turns = this.turns.filter(
      (turn) =>
        !(turn.runId === runId && turn.role === 'executor' && turn.body.trim().length === 0),
    );
  }

  private ensureExecutorTurn(attempt: ExecutionAttempt, body: string): void {
    if (this.turns.some((turn) => turn.runId === attempt.id && turn.role === 'executor')) return;
    this.turns = [
      ...this.turns,
      {
        id: this.deps.newId('turn'),
        runId: attempt.id,
        nodeId: attempt.nodeId,
        role: 'executor',
        body,
        attachmentIds: [],
        expertVersionId: attempt.expertVersionId,
        configSnapshotId: attempt.configSnapshotId,
        simulated: attempt.simulated,
        sequence: ++this.sequence,
      },
    ];
  }

  private appendExecutorText(
    attempt: ExecutionAttempt,
    chunk: string,
    simulated: boolean,
    replaceWith?: string,
  ): void {
    this.ensureExecutorTurn(attempt, '');
    this.turns = this.turns.map((turn) => {
      if (turn.runId !== attempt.id || turn.role !== 'executor') return turn;
      const body =
        replaceWith !== undefined && replaceWith.length > 0 ? replaceWith : `${turn.body}${chunk}`;
      return { ...turn, body, simulated: turn.simulated || simulated };
    });
  }

  private assemble() {
    const items: ContextSourceInput[] = [];
    const referenced = new Set(this.referencedContext().map((item) => item.id));
    for (const item of this.seed.contextItems) {
      if (!this.included.has(item.id)) continue;
      const source: ContextSourceInput = {
        id: item.id,
        kind: item.kind,
        sourceId: item.sourceId,
        version: item.version,
        permission: item.permission,
        summary: item.summary,
        required: item.required,
      };
      if (item.relativePath !== undefined) {
        const probed = this.probe(item.relativePath);
        items.push({
          ...source,
          file: probed.ok
            ? { exists: probed.exists, readable: probed.readable, pathAccepted: true }
            : { exists: false, readable: false, pathAccepted: false },
        });
      } else {
        items.push(source);
      }
    }
    const result = assembleRunContext({
      id: this.deps.newId('ctx'),
      taskId: this.seed.handoff.taskId,
      nodeId: this.seed.handoff.nodeId,
      planRevision: this.seed.handoff.revision,
      items,
    });
    if (!result.ok) {
      this.contextBlocks = result.manifest.blocks.map((block) => ({
        sourceId: block.sourceId,
        kind: block.kind,
        version: block.version,
        reason: block.reason,
      }));
      this.citations = [];
    }
    if (!result.ok) {
      return {
        ok: false as const,
        blocks: result.manifest.blocks.map((block) => ({
          sourceId: block.sourceId,
          kind: block.kind,
          version: block.version,
          reason: block.reason,
        })),
      };
    }
    const citations = result.manifest.citations.filter((item) => referenced.has(item.id));
    return {
      ok: true as const,
      manifest: { ...result.manifest, citations: Object.freeze(citations) },
      blocks: [] as ContextBlockFact[],
    };
  }

  private contextFacts(): ContextItemFact[] {
    return this.seed.contextItems.map((item) => {
      const fact: ContextItemFact = {
        id: item.id,
        kind: item.kind,
        sourceId: item.sourceId,
        version: item.version,
        summary: item.summary,
        required: item.required,
        included: this.included.has(item.id),
        permission: item.permission,
      };
      if (item.relativePath === undefined) return fact;
      const probed = this.probe(item.relativePath);
      const fileState = !probed.ok
        ? 'rejected'
        : !probed.exists
          ? 'missing'
          : probed.readable
            ? 'readable'
            : 'unreadable';
      return { ...fact, fileState };
    });
  }

  private catalog(): WorkspaceCatalog {
    return {
      experts: this.seed.catalog.experts.map((expert) => {
        const enabled = this.expertEnabled.get(expert.id) ?? expert.enabled;
        if (enabled) return { ...expert, enabled: true };
        return {
          ...expert,
          enabled: false,
          unavailableReason: expert.unavailableReason ?? '专家已停用',
        };
      }),
      skills: this.seed.catalog.skills.map((skill) => {
        if (skill.id !== 'skill-office' || this.officeReady()) return skill;
        return {
          ...skill,
          available: false,
          unavailableReason: OFFICE_SKILL_UNAVAILABLE,
        };
      }),
      mcp: this.seed.catalog.mcp,
      executors: this.seed.catalog.executors.map((executor) => {
        const connected = this.executorConnected.get(executor.id);
        if (connected === false) {
          return {
            ...executor,
            available: false,
            unavailableReason: '执行器已断开',
          };
        }
        return executor;
      }),
    };
  }

  private buildConfig(): ExecutionConfigSnapshot {
    const catalog = this.catalog();
    const expert = catalog.experts.find((item) => item.id === this.selections.expertId);
    const executor = catalog.executors.find((item) => item.id === this.selections.executorId);
    const simulated = executor?.id === 'simulated';
    const skills = this.selections.skillIds.flatMap((id) => {
      const skill = catalog.skills.find((item) => item.id === id);
      if (!skill) return [];
      const selection = {
        id: skill.id,
        version: skill.version,
        label: skill.label,
        origin: expert?.presetSkillIds.includes(skill.id)
          ? ('expert-preset' as const)
          : ('added' as const),
        available: skill.available,
      };
      return skill.unavailableReason
        ? [{ ...selection, unavailableReason: skill.unavailableReason }]
        : [selection];
    });
    const mcp = this.selections.mcpIds.flatMap((id) => {
      const item = catalog.mcp.find((entry) => entry.id === id);
      if (!item) return [];
      const selection = {
        id: item.id,
        version: item.version,
        label: item.label,
        origin: expert?.presetMcpIds.includes(item.id)
          ? ('expert-preset' as const)
          : ('added' as const),
        available: item.available,
        toolsAuthorized: false,
        explicitToolGrant: false,
      };
      return item.unavailableReason
        ? [{ ...selection, unavailableReason: item.unavailableReason }]
        : [selection];
    });
    const config: ExecutionConfigSnapshot = {
      id: this.configId,
      expertId: expert?.id ?? this.selections.expertId,
      expertVersionId: expert?.versionId ?? 'unknown',
      expertLabel: expert?.label ?? '未选择专家',
      expertSummary: expert?.summary ?? '',
      expertEnabled: expert?.enabled ?? false,
      executorId: executor?.id ?? null,
      executorLabel: executor?.label ?? '未选择执行器',
      executorAvailable: executor?.available ?? false,
      executorVerified: executor?.verified ?? false,
      simulated,
      modelInheritance: 'executor-managed',
      modelCompatible: !executor || simulated || executor.verified,
      modelLabel: simulated
        ? '由模拟执行器声明：不连接真实模型'
        : executor
          ? '由执行器管理'
          : '尚未选择执行器',
      skills,
      mcp,
      attachmentIds: this.attachments.map((item) => item.id),
      contextSummaries: this.contextFacts()
        .filter((item) => item.included)
        .map((item) => ({ sourceId: item.sourceId, version: item.version, summary: item.summary })),
    };
    if (!config.expertEnabled) {
      return { ...config, expertUnavailableReason: expert?.unavailableReason ?? '专家已停用' };
    }
    if (executor && !executor.available) {
      return {
        ...config,
        executorUnavailableReason: executor.unavailableReason ?? '执行器不可用',
        ...(simulated
          ? {}
          : { modelCompatible: false, modelUnavailableReason: '执行器不可用，不能显示已生效模型' }),
      };
    }
    if (executor && !simulated && !executor.verified) {
      return {
        ...config,
        executorUnavailableReason: executor.unavailableReason ?? '执行器尚未验证',
        modelCompatible: false,
        modelUnavailableReason: '执行器尚未验证，不能显示已生效模型',
      };
    }
    return config;
  }

  private grants(attachmentIds: readonly string[]): ResourceGrant[] {
    const config = this.buildConfig();
    return [
      ...this.authorized('skill').map((skill) => ({
        kind: 'skill' as const,
        id: skill.id,
        version: skill.version,
        toolsAuthorized: false,
      })),
      ...this.authorized('mcp').map((item) => ({
        kind: 'mcp' as const,
        id: item.id,
        version: item.version,
        toolsAuthorized: false,
      })),
      ...attachmentIds.map((id) => ({
        kind: 'attachment' as const,
        id,
        version: '1',
        toolsAuthorized: false,
      })),
      ...config.contextSummaries.map((item) => ({
        kind: 'context' as const,
        id: item.sourceId,
        version: item.version,
        toolsAuthorized: false,
      })),
    ];
  }

  private authorized(kind: 'skill'): {
    id: string;
    version: string;
    label?: string;
    description?: string;
    body?: string;
  }[];
  private authorized(kind: 'mcp'): {
    id: string;
    version: string;
    label?: string;
    transport?: 'stdio' | 'streamable-http';
    command?: string;
    args?: readonly string[];
    url?: string;
  }[];
  private authorized(kind: 'skill' | 'mcp') {
    const refs = kind === 'skill' ? this.seed.handoff.skillRefs : this.seed.handoff.mcpRefs;
    const selected = new Set(kind === 'skill' ? this.selections.skillIds : this.selections.mcpIds);
    return refs
      .filter((ref) => selected.has(ref.id))
      .map((ref) => {
        if (kind === 'skill') {
          const skill = this.seed.catalog.skills.find((item) => item.id === ref.id);
          return {
            id: ref.id,
            version: ref.version,
            ...(skill?.label !== undefined ? { label: skill.label } : {}),
            ...(skill?.description !== undefined ? { description: skill.description } : {}),
            ...(skill?.body !== undefined ? { body: skill.body } : {}),
          };
        }
        const mcp = this.seed.catalog.mcp.find((item) => item.id === ref.id);
        return {
          id: ref.id,
          version: ref.version,
          ...(mcp?.label !== undefined ? { label: mcp.label } : {}),
          ...(mcp?.transport !== undefined ? { transport: mcp.transport } : {}),
          ...(mcp?.command !== undefined ? { command: mcp.command } : {}),
          ...(mcp?.args !== undefined ? { args: mcp.args } : {}),
          ...(mcp?.url !== undefined ? { url: mcp.url } : {}),
        };
      });
  }

  private toolAllowlist(): readonly string[] {
    const expert = this.seed.catalog.experts.find((item) => item.id === this.selections.expertId);
    return expert?.toolAllowlist ?? [];
  }

  private referencedContext(): DeskContextSeed[] {
    const refs = this.seed.handoff.inputRefs;
    if (refs.length === 0) return [];
    return this.seed.contextItems.filter(
      (item) => this.included.has(item.id) && refs.some((ref) => inputRefMatches(item, ref)),
    );
  }

  private promptContext(runId: string): { id: string; body: string }[] {
    return this.pinnedPrompt.get(runId) ?? [];
  }

  /** 受理时读完本轮要交给执行器的正文。文件读失败则整次不启动。 */
  private freezePromptContext():
    { ok: true; blocks: { id: string; body: string }[] } | { ok: false; item: DeskContextSeed } {
    const blocks: { id: string; body: string }[] = [];
    for (const item of this.referencedContext()) {
      let body = item.body;
      if (body === undefined && item.relativePath !== undefined && this.seed.fileRoot) {
        const read = readRelativeFile(this.seed.fileRoot, item.relativePath);
        if (!read.ok) return { ok: false, item };
        body = read.text;
      }
      if (body === undefined) body = item.summary;
      blocks.push({ id: item.id, body });
    }
    return { ok: true, blocks };
  }

  private unreadableContext(item: DeskContextSeed): DeskResult {
    const node = item.sourceNodeId ?? item.sourceId;
    const version =
      item.artifactVersionId !== undefined && item.artifactVersionId !== item.version
        ? `${item.version}（产物 ${item.artifactVersionId}）`
        : (item.artifactVersionId ?? item.version);
    return this.fail(
      'context-blocked',
      node,
      `来源节点 ${node} 的版本 ${version} 读取失败，不会改用摘要。`,
      '补齐文件或权限，或移除此来源后再运行。不会传出不可访问的本机路径。',
    );
  }

  private attachmentPayloads(attachmentIds: readonly string[]): {
    id: string;
    name: string;
    mediaType: string;
    bytes: Uint8Array;
  }[] {
    const payloads: { id: string; name: string; mediaType: string; bytes: Uint8Array }[] = [];
    for (const id of attachmentIds) {
      const fact = this.attachments.find((item) => item.id === id);
      const bytes = this.attachmentBytes.get(id);
      if (!fact || bytes === undefined) continue;
      payloads.push({ id, name: fact.name, mediaType: fact.mediaType, bytes });
    }
    return payloads;
  }

  private discardRunSession(run: ExecutionAttempt): void {
    if (run.sessionId === undefined || run.sessionDiscarded === true) return;
    const sessionId = run.sessionId;
    if (!this.pendingSessionDeletes.includes(sessionId)) this.pendingSessionDeletes.push(sessionId);
    this.retireSession(sessionId);
    this.rememberHistoryOmitted();
  }

  /** 日志已经记下丢弃之后才删目录。写失败则放弃这次删除。 */
  private flushSessionDeletes(): void {
    const pending = this.pendingSessionDeletes;
    this.pendingSessionDeletes = [];
    for (const sessionId of pending) {
      for (const executor of this.deps.executors) {
        if (executor instanceof DshChatExecutor) executor.discardSession(sessionId);
      }
    }
  }

  private discardNodeSessions(): void {
    for (const run of this.runs) this.discardRunSession(run);
  }

  /** 不再恢复这个会话。历史运行仍保留 sessionId，并标成已丢弃。 */
  private retireSession(sessionId: string): void {
    this.runs = this.runs.map((run) =>
      run.sessionId === sessionId ? markSessionDiscarded(run) : run,
    );
  }

  private rememberHistoryOmitted(): void {
    this.historyNote = '没有带上之前的历史。';
  }

  /** 新会话已经有自己的一轮结果，横幅不再表示「下一轮没有历史」。 */
  private noteFreshHistory(attempt: ExecutionAttempt): void {
    if (attempt.sessionId === undefined || attempt.sessionDiscarded === true) return;
    this.historyNote = null;
  }

  private sessionDirectoryExists(sessionId: string): boolean {
    const executor = this.deps.executors.find((item) => item instanceof DshChatExecutor);
    if (!(executor instanceof DshChatExecutor)) return true;
    return executor.hasSessionDirectory(sessionId);
  }

  private previousSessionId(nodeId: string, runId: string): string | undefined {
    const candidate = [...this.runs]
      .reverse()
      .find(
        (run) =>
          run.nodeId === nodeId &&
          run.id !== runId &&
          run.sessionId !== undefined &&
          run.sessionDiscarded !== true,
      )?.sessionId;
    if (candidate === undefined) return undefined;
    if (this.sessionDirectoryExists(candidate)) return candidate;
    this.retireSession(candidate);
    this.rememberHistoryOmitted();
    return undefined;
  }

  private officeReady(): boolean {
    const executor = this.deps.executors.find((item) => item instanceof DshChatExecutor);
    return executor instanceof DshChatExecutor ? executor.officeReady() : officeSkillsReady();
  }

  private noteUnconnectedMcp(run: ExecutionAttempt): void {
    const pending = this.authorized('mcp').filter((item) => !mcpTransportReady(item));
    if (pending.length === 0) return;
    const detail = pending
      .map((item) => `${item.label ?? item.id}：未连接。没有配置传输，不会连接外部服务。`)
      .join('');
    this.activities.push(
      normalizeActivity({
        id: this.deps.newId('act'),
        runId: run.id,
        title: 'MCP',
        detail,
        simulated: run.simulated,
        succeeded: false,
      }),
    );
    this.persistEvent();
  }

  private applyTransition(
    transition: NodeTransition,
    key: string,
  ): { readonly ok: boolean; readonly code: string } {
    const outcome = applyNodeTransitionCommand(this.nodeState, {
      idempotencyKey: key,
      actorId: this.seed.actorId,
      objectId: this.seed.handoff.nodeId,
      expectedVersion: this.nodeState.version,
      payload: transition,
    });
    this.nodeState = outcome.state;
    if (outcome.decision.status === 'applied') {
      if (outcome.decision.result.effects.includes('accept-handoff')) this.downstreamLaunches += 1;
      if (this.nodeState.status === 'completed') this.discardNodeSessions();
      if (!entryIsConsistent(this.nodeState)) this.preserveRecordError();
      return { ok: true, code: 'applied' };
    }
    if (outcome.decision.status === 'replayed') return { ok: true, code: 'replayed' };
    return {
      ok: false,
      code:
        outcome.decision.status === 'rejected' ? outcome.decision.code : outcome.decision.status,
    };
  }

  private activeRun(): ExecutionAttempt | undefined {
    return this.runs.find(
      (run) =>
        run.nodeId === this.seed.handoff.nodeId &&
        !isTerminalRunStatus(run.status) &&
        run.id !== this.resumeGap?.runId,
    );
  }

  private unknownAttachment(ids: readonly string[]): DeskResult | null {
    for (const id of ids) {
      const fact = this.attachments.find((item) => item.id === id);
      if (!fact) {
        return this.fail('unknown-attachment', '附件', '有附件不在当前工作区', '重新上传后再发送');
      }
      const bytes = this.attachmentBytes.get(id);
      if (bytes === undefined || bytes.byteLength !== fact.byteSize) {
        return this.reuploadNeeded(fact.name);
      }
      const checksum = createHash('sha256').update(bytes).digest('hex');
      if (checksum !== fact.checksum) return this.reuploadNeeded(fact.name);
    }
    return null;
  }

  private reuploadNeeded(name: string): DeskResult {
    return this.fail(
      'attachment-reupload',
      name,
      '附件内容不在，需重新上传',
      '重新上传这份附件后再发送。不会用缺失的字节继续运行。',
    );
  }

  private frozenAttachments(
    ids: readonly string[],
  ): NonNullable<InterventionRecord['attachments']> {
    return ids.map((id) => {
      const fact = this.attachments.find((item) => item.id === id);
      return {
        id,
        name: fact?.name ?? id,
        mediaType: fact?.mediaType ?? 'application/octet-stream',
        byteSize: fact?.byteSize ?? 0,
        checksum: fact?.checksum ?? '',
      };
    });
  }

  private gapBlocked(): DeskResult {
    return this.fail(
      'resume-gap',
      '运行',
      '原运行仍未结束。请核实为执行器已断开。',
      '先核实中断。不要把未结束的运行当成仍在执行，也不要据此发送或停止。',
    );
  }

  private abandonedRun(): { runId: string; reason: 'session-not-resumed' } | null {
    const run = [...this.runs].reverse().find((item) => !isTerminalRunStatus(item.status));
    if (!run) return null;
    // 进程已经不在。DSH 仍可在下一次显式运行里 session/resume，但这次中断不能当成还在执行。
    return { runId: run.id, reason: 'session-not-resumed' };
  }

  private currentGeneration(): number {
    return this.runs.reduce((highest, run) => Math.max(highest, run.generation), 0);
  }

  private putRun(next: ExecutionAttempt): void {
    this.runs = this.runs.map((run) => (run.id === next.id ? next : run));
    if (isTerminalRunStatus(next.status)) this.pinnedPrompt.delete(next.id);
  }

  private releaseClaim(runId: string): void {
    this.claims = [
      ...releaseWritableWorkspace(this.claims, isolateWorkspaceId(this.seed.handoff.nodeId), runId),
    ];
  }

  private probe(relativePath: string): FileProbeResult {
    if (this.deps.probe) return this.deps.probe(relativePath);
    if (!this.seed.fileRoot) return { ok: false, code: 'path-rejected' };
    return probeRelativeFile(this.seed.fileRoot, relativePath);
  }

  /** 没拿到写锁。不改运行、不释放写权、不写日志。 */
  private writeLocked(): DeskResult {
    return {
      ok: false,
      code: 'write-locked',
      objectLabel: '会话',
      reason: '另一个进程正持有这份会话的写权',
      nextStep: '不要把仍在运行的执行标成放弃。',
      snapshot: this.snapshot(),
    };
  }

  private blockedRestore(): DeskResult {
    return this.fail(
      'restore-facts-first',
      '工作区',
      '正在恢复已保存的事实',
      '恢复完成后再操作。不会据此创建新运行。',
    );
  }

  private fail(code: string, objectLabel: string, reason: string, nextStep: string): DeskResult {
    const previous = this.lastError;
    this.lastError = { code, objectLabel, reason, nextStep };
    this.preserveRecordError();
    if (!this.persist()) this.lastError = previous;
    return { ok: false, code, objectLabel, reason, nextStep, snapshot: this.snapshot() };
  }

  private succeed(extra: { replayed?: boolean; runId?: string } = {}): DeskResult {
    this.lastError = null;
    this.preserveRecordError();
    if (!this.persist()) return this.persistRejected();
    return {
      ok: true,
      replayed: extra.replayed ?? false,
      snapshot: this.snapshot(),
      ...(extra.runId !== undefined ? { runId: extra.runId } : {}),
    };
  }

  /** 这次受理改过的运行、写权和轮次。落盘失败时整段退回，避免同键重放伪报已启动。 */
  private captureAccept(): {
    claims: WorkspaceClaim[];
    runs: ExecutionAttempt[];
    turns: ConversationTurn[];
    citations: ContextCitationFact[];
    contextBlocks: ContextBlockFact[];
    sequence: number;
    lastError: CommandErrorFact | null;
  } {
    return {
      claims: this.claims,
      runs: this.runs,
      turns: this.turns,
      citations: this.citations,
      contextBlocks: this.contextBlocks,
      sequence: this.sequence,
      lastError: this.lastError,
    };
  }

  private restoreAccept(checkpoint: {
    claims: WorkspaceClaim[];
    runs: ExecutionAttempt[];
    turns: ConversationTurn[];
    citations: ContextCitationFact[];
    contextBlocks: ContextBlockFact[];
    sequence: number;
    lastError: CommandErrorFact | null;
  }): void {
    this.claims = checkpoint.claims;
    this.runs = checkpoint.runs;
    this.turns = checkpoint.turns;
    this.citations = checkpoint.citations;
    this.contextBlocks = checkpoint.contextBlocks;
    this.sequence = checkpoint.sequence;
    this.lastError = checkpoint.lastError;
  }

  /** 排队受理改过的队列、运行和节点。落盘失败时整段退回，避免前一轮结束后自动执行。 */
  private captureQueue(): {
    interventions: InterventionRecord[];
    runs: ExecutionAttempt[];
    nodeState: NodeCommandState;
    claims: WorkspaceClaim[];
    lastError: CommandErrorFact | null;
    downstreamLaunches: number;
  } {
    return {
      interventions: this.interventions,
      runs: this.runs,
      nodeState: structuredClone(this.nodeState),
      claims: this.claims,
      lastError: this.lastError,
      downstreamLaunches: this.downstreamLaunches,
    };
  }

  private restoreQueue(checkpoint: {
    interventions: InterventionRecord[];
    runs: ExecutionAttempt[];
    nodeState: NodeCommandState;
    claims: WorkspaceClaim[];
    lastError: CommandErrorFact | null;
    downstreamLaunches: number;
  }): void {
    this.interventions = checkpoint.interventions;
    this.runs = checkpoint.runs;
    this.nodeState = checkpoint.nodeState;
    this.claims = checkpoint.claims;
    this.lastError = checkpoint.lastError;
    this.downstreamLaunches = checkpoint.downstreamLaunches;
  }

  /** 命令改过的内存。落盘失败时退回，避免失败的修改继续被看见或被消费。 */
  private captureOperational(): OperationalCheckpoint {
    return {
      nodeState: structuredClone(this.nodeState),
      runs: this.runs,
      turns: this.turns,
      interventions: this.interventions,
      claims: this.claims,
      faults: this.faults.slice(),
      activities: this.activities.slice(),
      lateRecords: this.lateRecords.slice(),
      attachments: this.attachments.slice(),
      attachmentBytes: new Map(this.attachmentBytes),
      drafts: this.drafts,
      draftRoundId: this.draftRoundId,
      recoveryRequests: this.recoveryRequests.slice(),
      downstreamLaunches: this.downstreamLaunches,
      reviewRounds: this.reviewRounds.slice(),
      activeRoundId: this.activeRoundId,
      selections: {
        expertId: this.selections.expertId,
        executorId: this.selections.executorId,
        skillIds: [...this.selections.skillIds],
        mcpIds: [...this.selections.mcpIds],
      },
      configId: this.configId,
      included: new Set(this.included),
      expertEnabled: new Map(this.expertEnabled),
      executorConnected: new Map(this.executorConnected),
      citations: this.citations,
      contextBlocks: this.contextBlocks,
      sequence: this.sequence,
      lastError: this.lastError,
      resumeGap: this.resumeGap,
      historyNote: this.historyNote,
    };
  }

  private restoreOperational(checkpoint: OperationalCheckpoint): void {
    this.nodeState = checkpoint.nodeState;
    this.runs = checkpoint.runs;
    this.turns = checkpoint.turns;
    this.interventions = checkpoint.interventions;
    this.claims = checkpoint.claims;
    this.faults = checkpoint.faults;
    this.activities = checkpoint.activities;
    this.lateRecords = checkpoint.lateRecords;
    this.attachments = checkpoint.attachments;
    this.attachmentBytes.clear();
    for (const [id, bytes] of checkpoint.attachmentBytes) this.attachmentBytes.set(id, bytes);
    this.drafts = checkpoint.drafts;
    this.draftRoundId = checkpoint.draftRoundId;
    this.recoveryRequests = checkpoint.recoveryRequests;
    this.downstreamLaunches = checkpoint.downstreamLaunches;
    this.reviewRounds = checkpoint.reviewRounds;
    this.activeRoundId = checkpoint.activeRoundId;
    this.selections = checkpoint.selections;
    this.configId = checkpoint.configId;
    this.included = checkpoint.included;
    this.expertEnabled = checkpoint.expertEnabled;
    this.executorConnected = checkpoint.executorConnected;
    this.citations = checkpoint.citations;
    this.contextBlocks = checkpoint.contextBlocks;
    this.sequence = checkpoint.sequence;
    this.lastError = checkpoint.lastError;
    this.resumeGap = checkpoint.resumeGap;
    this.historyNote = checkpoint.historyNote;
  }

  private undoIfUnsaved(checkpoint: OperationalCheckpoint, result: DeskResult): DeskResult {
    if (this.lastSaveFailed || (!result.ok && result.code === 'persist-failed')) {
      this.restoreOperational(checkpoint);
      return this.persistRejected();
    }
    return result;
  }

  private persistRejected(): DeskResult {
    const fault = persistenceFaultFrom(this.lastPersistError ?? new Error('persist-failed'));
    return {
      ok: false,
      code: 'persist-failed',
      objectLabel: fault.objectLabel,
      reason: fault.reason,
      nextStep: fault.nextStep,
      snapshot: this.snapshot(),
    };
  }

  /**
   * 用户命令保存失败只让调用方回滚，不记持久化故障。
   * 执行器事件用 persistEvent：失败留下故障。成功保存清掉故障。
   * 延后队列在这次调用返回之后再恢复。恢复写失败只记故障，不回滚刚提交的命令。
   */
  private persist(_reconcile = false, recordFault = false): boolean {
    if (!this.deps.journal) {
      this.persistenceFault = null;
      this.lastSaveFailed = false;
      this.lastPersistError = null;
      this.flushSessionDeletes();
      this.scheduleDeferredQueue();
      return true;
    }
    try {
      this.deps.journal.save(this.persistence());
      this.lastSaveFailed = false;
      this.lastPersistError = null;
      this.flushSessionDeletes();
      this.persistenceFault = null;
      this.scheduleDeferredQueue();
      return true;
    } catch (error) {
      this.lastSaveFailed = true;
      this.pendingSessionDeletes = [];
      this.lastPersistError = error;
      if (recordFault && this.persistenceFault === null) {
        this.persistenceFault = persistenceFaultFrom(error);
      }
      return false;
    }
  }

  private persistEvent(): boolean {
    return this.persist(false, true);
  }

  /** 排到当前调用返回之后。失败不能把 lastSaveFailed 留给下一条同步命令。 */
  private scheduleDeferredQueue(): void {
    if (this.deferredQueueRunId === null || this.consumingQueue) return;
    const runId = this.deferredQueueRunId;
    this.deferredQueueRunId = null;
    const job = Promise.resolve().then(() => {
      try {
        this.consumeQueue(runId);
      } finally {
        this.lastSaveFailed = false;
      }
    });
    this.inflight.push(job);
    void job.finally(() => {
      this.inflight = this.inflight.filter((item) => item !== job);
    });
  }

  /**
   * 应带入口的状态丢了记录，且没有进行中的运行。
   * 停止或失败可以进入 cancelled / failed，标记仍然成立，直到人工核对记录。
   */
  private brokenRecord(): boolean {
    if (this.handoffInvalid) return true;
    if (entryIsConsistent(this.nodeState)) return false;
    const status = this.nodeState.status;
    if (
      status !== 'running' &&
      status !== 'waiting-for-input' &&
      status !== 'ready' &&
      status !== 'failed' &&
      status !== 'cancelled'
    ) {
      return false;
    }
    return this.activeRun() === undefined;
  }

  private recordBlocked(): DeskResult {
    if (this.handoffInvalid) {
      return this.fail(
        'invalid-handoff',
        '节点',
        '节点记录异常，需要人工处理',
        '交接引用无法读取。请重新建立交接，不要补写来源节点或产物版本。',
      );
    }
    return this.fail(
      'entry-inconsistent',
      '节点',
      '节点记录异常，需要人工处理',
      '不要按这份记录发送、重试、重新开始或停止。',
    );
  }

  private preserveRecordError(): void {
    if (this.handoffInvalid) {
      this.lastError = invalidHandoffError();
      return;
    }
    if (entryIsConsistent(this.nodeState)) return;
    if (this.brokenRecord()) {
      this.lastError = missingRecord();
      return;
    }
    if (this.lastError?.code !== 'entry-inconsistent') this.lastError = entryMismatch();
  }

  private noteEntry(): void {
    if (this.handoffInvalid) {
      this.lastError = invalidHandoffError();
      return;
    }
    if (entryIsConsistent(this.nodeState)) return;
    this.lastError = this.brokenRecord() ? missingRecord() : entryMismatch();
  }
}

export function executionHint(snapshot: ExecutionDeskSnapshot) {
  const active = snapshot.runs.find(
    (run) => !isTerminalRunStatus(run.status) && run.id !== snapshot.resumeGap?.runId,
  );
  return executionTodoHint({
    nodeStatus: snapshot.node.status,
    actorId: snapshot.actorId,
    assignee: snapshot.assignee,
    ...(active ? { runStatus: active.status, stopPhase: active.stopPhase } : {}),
  });
}

function markSessionDiscarded(attempt: ExecutionAttempt): ExecutionAttempt {
  if (attempt.sessionDiscarded === true) return attempt;
  return { ...attempt, sessionDiscarded: true };
}

function copyIntervention(
  item: InterventionRecord,
  phase: InterventionRecord['phase'],
  extras: {
    readonly appliedRunId?: string;
    readonly runId?: string;
    readonly notice?: string;
  } = {},
): InterventionRecord {
  const appliedRunId = extras.appliedRunId ?? item.appliedRunId;
  const notice = extras.notice ?? item.notice;
  return {
    id: item.id,
    runId: extras.runId ?? item.runId,
    kind: item.kind,
    phase,
    body: item.body,
    idempotencyKey: item.idempotencyKey,
    payloadHash: item.payloadHash,
    ...(item.attachments !== undefined ? { attachments: item.attachments } : {}),
    ...(notice !== undefined ? { notice } : {}),
    ...(appliedRunId !== undefined ? { appliedRunId } : {}),
  };
}

function queueFingerprint(
  text: string,
  intent: string,
  runId: string,
  attachments: NonNullable<InterventionRecord['attachments']>,
): {
  text: string;
  intent: string;
  runId: string;
  attachments?: { id: string; checksum: string }[];
} {
  const base = { text, intent, runId };
  if (attachments.length === 0) return base;
  return {
    ...base,
    attachments: attachments.map((item) => ({ id: item.id, checksum: item.checksum })),
  };
}

const STOP_RECEIPT_TIMEOUT_MS = 4000;

function cancelWithTimeout(pending: Promise<{ receipt: string; reason?: string }>): Promise<{
  receipt: string;
  reason?: string;
}> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ receipt: 'rejected', reason: '等待停止回执超时。' });
    }, STOP_RECEIPT_TIMEOUT_MS);
    pending.then(
      (receipt) => {
        clearTimeout(timer);
        resolve(receipt);
      },
      () => {
        clearTimeout(timer);
        resolve({ receipt: 'rejected', reason: '停止回执失败。' });
      },
    );
  });
}

function initialNodeState(status: NodeStatus): NodeCommandState {
  if (status === 'ready' || status === 'needs-revision') {
    return { status, version: 1, upstreamAffected: false, stored: [], entryStatus: status };
  }
  return { status, version: 1, upstreamAffected: false, stored: [] };
}

function entryIsConsistent(state: NodeCommandState): boolean {
  const entry = state.entryStatus;
  const recorded = entry === 'ready' || entry === 'needs-revision';
  if (state.status === 'completed' || state.status === 'draft' || state.status === 'blocked') {
    return entry === undefined;
  }
  if (state.status === 'needs-revision') return entry === 'needs-revision';
  if (
    state.status === 'ready' ||
    state.status === 'running' ||
    state.status === 'waiting-for-input' ||
    state.status === 'failed' ||
    state.status === 'cancelled' ||
    state.status === 'child-workflow' ||
    state.status === 'in-review'
  ) {
    return recorded;
  }
  return false;
}

function recordedEntryStatus(state: NodeCommandState): 'ready' | 'needs-revision' | undefined {
  if (!entryIsConsistent(state)) return undefined;
  if (state.entryStatus === 'ready' || state.entryStatus === 'needs-revision') {
    return state.entryStatus;
  }
  return undefined;
}

function recoveryRejectedReason(idempotencyKey: string, code: string): string {
  if (code === 'idempotency-mismatch') {
    return `恢复请求 ${idempotencyKey} 已经对应过不同的迁移，不能再改写节点。`;
  }
  if (code === 'version-conflict') {
    return `恢复请求 ${idempotencyKey} 和当前节点版本不一致，没有再次改写。`;
  }
  if (code === 'illegal-transition') {
    return `恢复请求 ${idempotencyKey} 和记下的入口不一致，节点保持原状。`;
  }
  return `恢复请求 ${idempotencyKey} 没有被接受（${code}）。`;
}

function entryMismatch(): CommandErrorFact {
  return {
    code: 'entry-inconsistent',
    objectLabel: '节点',
    reason: '读回的入口和节点状态对不上',
    nextStep: '不要按这份记录重试或结束运行。先核对节点命令里的 entryStatus。',
  };
}

function invalidHandoffError(): CommandErrorFact {
  return {
    code: 'invalid-handoff',
    objectLabel: '节点',
    reason: '节点记录异常，需要人工处理',
    nextStep: '交接引用无法读取。请重新建立交接，不要补写来源节点或产物版本。',
  };
}

function copyHandoff(handoff: NodeHandoff): NodeHandoff {
  const fields = {
    nodeId: handoff.nodeId,
    taskId: handoff.taskId,
    workflowVersionId: handoff.workflowVersionId,
    revision: handoff.revision,
    goal: handoff.goal,
    dependencyNodeIds: [...handoff.dependencyNodeIds],
    reviewRequired: handoff.reviewRequired,
    reviewerIds: [...handoff.reviewerIds],
    inputRefs: handoff.inputRefs.map((ref) => ({ ...ref })),
    skillRefs: handoff.skillRefs.map((ref) => ({ ...ref })),
    mcpRefs: handoff.mcpRefs.map((ref) => ({ ...ref })),
    inputNote: handoff.inputNote,
    expectedOutput: handoff.expectedOutput,
    ...(handoff.childTaskId !== undefined ? { childTaskId: handoff.childTaskId } : {}),
  };
  if (handoff.assignee.kind === 'expert' && handoff.expertRef !== undefined) {
    return {
      ...fields,
      assignee: { id: handoff.assignee.id, kind: 'expert' },
      expertRef: { id: handoff.expertRef.id, version: handoff.expertRef.version },
    };
  }
  return {
    ...fields,
    assignee: { id: handoff.assignee.id, kind: 'human' },
    ...(handoff.expertRef !== undefined
      ? { expertRef: { id: handoff.expertRef.id, version: handoff.expertRef.version } }
      : {}),
  };
}

function fallbackHandoff(input: NodeHandoff): NodeHandoff {
  const read = readNodeHandoff({
    nodeId:
      typeof input?.nodeId === 'string' && input.nodeId.length > 0 ? input.nodeId : 'unknown-node',
    taskId:
      typeof input?.taskId === 'string' && input.taskId.length > 0 ? input.taskId : 'unknown-task',
    workflowVersionId:
      typeof input?.workflowVersionId === 'string' && input.workflowVersionId.length > 0
        ? input.workflowVersionId
        : 'unknown-plan',
    revision: typeof input?.revision === 'number' ? input.revision : 0,
    goal: typeof input?.goal === 'string' ? input.goal : '',
    assignee: { id: 'unknown', kind: 'human' },
    dependencyNodeIds: [],
    reviewRequired: false,
    reviewerIds: [],
    inputRefs: [],
    skillRefs: [],
    mcpRefs: [],
    inputNote: '',
    expectedOutput: '',
  });
  if (!read.ok) {
    return {
      nodeId: 'unknown-node',
      taskId: 'unknown-task',
      workflowVersionId: 'unknown-plan',
      revision: 0,
      goal: '',
      assignee: { id: 'unknown', kind: 'human' },
      dependencyNodeIds: [],
      reviewRequired: false,
      reviewerIds: [],
      inputRefs: [],
      skillRefs: [],
      mcpRefs: [],
      inputNote: '',
      expectedOutput: '',
    };
  }
  return read.handoff;
}

function missingRecord(): CommandErrorFact {
  return {
    code: 'entry-inconsistent',
    objectLabel: '节点',
    reason: '节点记录异常，需要人工处理',
    nextStep: '不要按这份记录重试或结束运行。先核对节点命令里的 entryStatus。',
  };
}

function persistenceFaultFrom(error: unknown): CommandErrorFact {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length > 0
      ? error.code
      : 'persist-failed';
  return {
    code: 'persist-failed',
    objectLabel: '日志',
    reason: `日志没有写进去（${code}）。`,
    nextStep: '存储恢复后重写这份日志。重写成功前，不要把界面上的运行当成已经受理或已经落盘。',
  };
}

function humanExecutor(id: string): string {
  if (id === 'codearts-cli') return '码道';
  if (id === 'dsh') return 'DSH';
  if (id === 'simulated') return '模拟执行器';
  return id;
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function openRunReason(code: string): string {
  if (code === 'node-already-completed') return '节点已确认完成，不会再次调度';
  if (code === 'active-run-exists') return '该节点已有有效运行';
  if (code === 'expert-disabled') return '专家已停用，没有创建运行';
  if (code === 'executor-disconnected') return '执行器已断开，没有创建运行';
  if (code === 'executor-not-selected') return '尚未选择执行器';
  if (code === 'idempotency-mismatch') return '同一个请求标识对应了不同内容';
  if (code === 'node-not-executable') return '节点当前不能启动执行';
  return '没有创建运行';
}

function inputRefMatches(
  item: DeskContextSeed,
  ref: {
    readonly sourceNodeId?: string;
    readonly artifactVersionId?: string;
    readonly contextPackId?: string;
  },
): boolean {
  const checks: boolean[] = [];
  if (ref.sourceNodeId !== undefined) checks.push(item.sourceNodeId === ref.sourceNodeId);
  if (ref.artifactVersionId !== undefined)
    checks.push(item.artifactVersionId === ref.artifactVersionId);
  if (ref.contextPackId !== undefined) checks.push(item.contextPackId === ref.contextPackId);
  return checks.length > 0 && checks.every(Boolean);
}

function isReviewRoundStatus(value: string): value is ReviewRound['status'] {
  return (
    value === 'open' || value === 'approved' || value === 'changes-requested' || value === 'voided'
  );
}

function openRunNext(code: string): string {
  if (code === 'node-already-completed') return '如需返工，使用显式的重开流程，而不是再调度一次';
  if (code === 'active-run-exists') return '等待当前运行结束，或把补充内容排入下一轮';
  if (code === 'expert-disabled') return '更换可用专家。历史消息仍保留';
  if (code === 'executor-disconnected') return '重新连接后再显式选择执行器';
  if (code === 'idempotency-mismatch') return '使用新的请求标识';
  return '修正条件后再显式发送';
}
