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
  executionTodoHint,
  isTerminalRunStatus,
  markRunWaiting,
  normalizeActivity,
  openRunAttempt,
  prepareArtifactDraft,
  presentExecutionFault,
  preservedTurnsAfterExpertSwitch,
  recordRecoveryRequest,
  recoveryCommandFor,
  requestRunStop,
  resumeRunAfterInput,
  routeLiveInput,
  settleExecutionRun,
  timerCompletesRun,
  validateExecutionConfig,
  viewCloseCancelsRun,
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
import { createFileJournal, type DeskJournal } from './file-journal.js';
import { probeRelativeFile, type FileProbeResult } from './file-probe.js';

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
  private sequence = 0;

  private constructor(
    private readonly seed: DeskSeed,
    private readonly deps: DeskDependencies,
    restored: DeskPersistence | null,
  ) {
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
    this.nodeState = {
      status: seed.nodeStatus,
      version: 1,
      upstreamAffected: false,
      stored: [],
    };
    if (!restored) return;
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
    this.sequence = restored.turns.reduce((max, turn) => Math.max(max, turn.sequence), 0);
  }

  static create(seed: DeskSeed, deps: DeskDependencies): ExecutionDesk {
    const desk = new ExecutionDesk(seed, deps, null);
    desk.interactionReady = true;
    desk.persist();
    return desk;
  }

  /** 先装回事实。此阶段拒绝新的执行命令，也不会把未结束的运行推断成完成。 */
  static restore(data: DeskPersistence, deps: DeskDependencies): ExecutionDesk {
    const desk = new ExecutionDesk(data.seed, deps, data);
    desk.interactionReady = false;
    desk.resumeGap = desk.abandonedRun();
    return desk;
  }

  resumeInteraction(): void {
    this.interactionReady = true;
    this.persist();
  }

  snapshot(): ExecutionDeskSnapshot {
    const assignee = assigneeAfterAgentAssist(this.seed.handoff.assignee);
    return {
      schema: 1,
      interactionReady: this.interactionReady,
      taskTitle: this.seed.taskTitle,
      taskGoal: this.seed.taskGoal,
      actorId: this.seed.actorId,
      handoff: this.seed.handoff,
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
      attachments: this.attachments,
      drafts: this.drafts,
      recoveryRequests: this.recoveryRequests,
      downstreamLaunches: this.downstreamLaunches,
      delivered: false,
      resumeGap: this.resumeGap,
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
    };
  }

  /** 刷新和读取都走这里，不会创建运行。 */
  viewDidNotSchedule(): boolean {
    return viewCloseCancelsRun() === false && timerCompletesRun() === false;
  }

  updateConfig(input: {
    readonly expertId?: string;
    readonly executorId?: ExecutionEngine | null;
    readonly skillIds?: readonly string[];
    readonly mcpIds?: readonly string[];
  }): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const before = this.turns.length;
    if (input.expertId !== undefined) this.selections.expertId = input.expertId;
    if (input.executorId !== undefined) this.selections.executorId = input.executorId;
    if (input.skillIds !== undefined) this.selections.skillIds = [...input.skillIds];
    if (input.mcpIds !== undefined) this.selections.mcpIds = [...input.mcpIds];
    this.configId = this.deps.newId('cfg');
    this.turns = [...preservedTurnsAfterExpertSwitch(this.turns)];
    if (this.turns.length !== before) {
      return this.fail('history-lost', '对话', '切换专家时历史被改写', '停止使用这份构建');
    }
    return this.succeed();
  }

  setAvailability(input: {
    readonly expertId?: string;
    readonly enabled?: boolean;
    readonly executorId?: ExecutionEngine;
    readonly connected?: boolean;
  }): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    if (input.expertId !== undefined && input.enabled !== undefined) {
      this.expertEnabled.set(input.expertId, input.enabled);
    }
    if (input.executorId !== undefined && input.connected !== undefined) {
      this.executorConnected.set(input.executorId, input.connected);
    }
    this.configId = this.deps.newId('cfg');
    return this.succeed();
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
    if (included) this.included.add(id);
    else this.included.delete(id);
    this.contextBlocks = [];
    return this.succeed();
  }

  addAttachment(input: {
    readonly name: string;
    readonly mediaType: string;
    readonly text: string;
  }): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const name = path.posix.basename(input.name.replaceAll('\\', '/'));
    if (name.length === 0 || name === '.' || name === '..') {
      return this.fail('attachment-name', '附件', '文件名无效', '换一个文件名后再上传');
    }
    const byteSize = Buffer.byteLength(input.text);
    if (byteSize > ATTACHMENT_LIMIT) {
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
    const id = this.deps.newId('file');
    this.attachments.push({
      id,
      name,
      mediaType: input.mediaType,
      byteSize,
      checksum: createHash('sha256').update(input.text).digest('hex'),
      reference: `attachment:${id}`,
    });
    return this.succeed();
  }

  removeAttachment(id: string): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    this.attachments = this.attachments.filter((item) => item.id !== id);
    return this.succeed();
  }

  send(input: SendInput): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const replay = this.replayRun(input);
    if (replay) return replay;
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
    const active = this.activeRun();
    if (!active) {
      return this.fail('run-terminal', '运行', '没有可停止的有效运行', '刷新后再看是否需要重试');
    }
    const requested = requestRunStop(active);
    if (!requested.ok) {
      return this.fail('terminal-run', active.id, '运行已经结束，停止不能改写它', '查看附属记录');
    }
    this.putRun(requested.attempt);
    this.persist();
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
    const receipt = await executor.cancel(active.id);
    const latest = this.runs.find((run) => run.id === active.id) ?? requested.attempt;
    if (latest.status === 'cancelled' || receipt.receipt === 'cancelled') {
      this.persist();
      return this.succeed({ runId: active.id });
    }
    return this.fail(
      'stop-receipt-missing',
      executor.id,
      receipt.reason ?? '没有取得取消回执',
      '节点保持原状态。不能把关闭页面当成取消。',
    );
  }

  retry(idempotencyKey: string): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const entry = [...this.runs]
      .reverse()
      .find((run) => run.status === 'failed' || run.status === 'cancelled');
    const recovery = recoveryCommandFor(this.nodeState.status, entry?.entryNodeStatus);
    if (!recovery.ok) {
      return this.fail(
        'recovery-not-available',
        '节点',
        '当前状态不能重试或重新开始',
        '失败用重试，取消后用显式重新开始，并带回进入运行前的 ready 或 needs-revision',
      );
    }
    const applied = this.applyTransition(
      { type: recovery.transition, returnTo: recovery.returnTo },
      `recovery:${idempotencyKey}`,
    );
    if (!applied) {
      return this.fail('recovery-rejected', '节点', '恢复命令没有被接受', '刷新事实后再试');
    }
    const last = [...this.turns].reverse().find((turn) => turn.role === 'user');
    if (!last) return this.succeed();
    return this.send({
      text: last.body,
      idempotencyKey: `retry-run:${idempotencyKey}`,
      attachmentIds: last.attachmentIds,
      intent: 'new',
    });
  }

  recover(kind: 'reassign' | 'human-takeover'): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const assignee = assigneeAfterAgentAssist(this.seed.handoff.assignee);
    this.recoveryRequests.push(
      recordRecoveryRequest({ id: this.deps.newId(kind), kind, assigneeId: assignee.id }),
    );
    return this.succeed();
  }

  verifyAbandoned(): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const gap = this.resumeGap;
    if (!gap) {
      return this.fail('abandon-missing', '运行', '没有待核实的中断运行', '先恢复事实');
    }
    const run = this.runs.find((item) => item.id === gap.runId);
    if (!run || isTerminalRunStatus(run.status)) {
      this.resumeGap = null;
      return this.fail('terminal-run', gap.runId, '运行已经结束', '不要再次改写节点');
    }
    const settled = settleExecutionRun(run, 'failed');
    if (!settled.ok) {
      return this.fail('terminal-run', run.id, '不能把已结束的运行再标成失败', '保留现有事实');
    }
    this.putRun(settled.attempt);
    if (settled.nodeTransition.type === 'execution-failed') {
      this.applyTransition(settled.nodeTransition, `abandon:${run.id}`);
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
    this.releaseClaim(run.id);
    return this.succeed({ runId: run.id });
  }

  saveDraft(text: string): DeskResult {
    if (!this.interactionReady) return this.blockedRestore();
    const producer = [...this.runs].reverse().find((run) => run.status === 'completed');
    const draft = prepareArtifactDraft({
      nodeId: this.seed.handoff.nodeId,
      text,
      previousRoundIds: this.reviewRounds.map((round) => round.id),
      existingRounds: this.reviewRounds,
      newRoundId: this.deps.newId('round'),
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
    const roundCheck = acceptRoundResult({
      roundId: draft.draft.review.roundId,
      roundStatus: 'open',
      activeRoundId: draft.draft.review.roundId,
    });
    if (!roundCheck.ok) {
      return this.fail(roundCheck.code, '评审轮次', '旧轮次结果被拒绝', '新建一轮后再提交');
    }
    this.drafts.push(draft.draft);
    this.reviewRounds.push({ id: draft.draft.review.roundId, status: 'open' });
    this.activeRoundId = draft.draft.review.roundId;
    return this.succeed();
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
    return this.succeed();
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
    const applied = this.applyTransition({ type: 'input-required' }, `wait:${active.id}`);
    if (!applied)
      return this.fail('illegal-transition', '节点', '节点不能进入等待输入', '刷新事实');
    this.putRun(marked.attempt);
    return this.succeed({ runId: active.id });
  }

  releaseActive(): void {
    const active = this.activeRun();
    if (!active) return;
    const executor = this.deps.executors.find((item) => item.id === active.executor);
    if (executor instanceof SimulatedAgentExecutor) executor.release(active.id);
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
      configId: this.configId,
      expertVersionId: this.buildConfig().expertVersionId,
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

  private beginRun(input: SendInput): DeskResult {
    const text = input.text.trim();
    if (text.length === 0) {
      return this.fail('empty-message', '消息', '没有要发送的内容', '写上本轮要求后再发送');
    }
    const attachmentIds = [...(input.attachmentIds ?? [])];
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
        '该执行器尚未实现或尚未验证',
        '不要伪造运行。可以改选已明确标注的模拟执行器。',
      );
    }
    const assembled = this.assemble();
    if (!assembled.ok) {
      const block = assembled.blocks[0];
      return this.fail(
        'context-blocked',
        block?.sourceId ?? '上下文',
        `来源被阻塞：${block?.reason ?? 'context-blocked'}`,
        '补齐文件或权限，或移除此来源后再运行。不会传出不可访问的本机路径。',
      );
    }
    const payloadHash = hashPayload({
      text,
      attachmentIds,
      configId: config.id,
      expertVersionId: config.expertVersionId,
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
    const claimed = claimWritableWorkspace({
      workspaceId: isolateWorkspaceId(opened.attempt.id),
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
    return this.succeed({ runId: opened.attempt.id });
  }

  private enqueue(active: ExecutionAttempt, input: SendInput): DeskResult {
    const text = input.text.trim();
    if (text.length === 0) {
      return this.fail('empty-message', '消息', '没有要补充的内容', '写上内容后再发送');
    }
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
    const payloadHash = hashPayload({ text, intent, runId: active.id });
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
      ...(routed.notice !== undefined ? { notice: routed.notice } : {}),
    };
    this.interventions = [...this.interventions, record];
    if (routed.kind === 'resume-input') {
      const resumed = resumeRunAfterInput(active);
      if (!resumed.ok) {
        return this.fail('not-waiting', active.id, '运行并不在等待输入', '消息留在已接收，未应用');
      }
      const applied = this.applyTransition({ type: 'input-supplied' }, `resume:${record.id}`);
      if (!applied) return this.succeed({ runId: active.id });
      const done = advanceIntervention(record.phase, 'apply');
      if (done.ok) {
        this.interventions = this.interventions.map((item) =>
          item.id === record.id ? copyIntervention(item, done.phase, active.id) : item,
        );
      }
      this.putRun(resumed.attempt);
    }
    return this.succeed({ runId: active.id });
  }

  private startDrive(runId: string, instruction: string, attachmentIds: readonly string[]): void {
    const controller = new AbortController();
    this.aborts.set(runId, controller);
    const promise = this.drive(runId, instruction, attachmentIds, controller.signal);
    this.inflight.push(promise);
    void promise.finally(() => {
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
      simulatedRequested: attempt.simulated,
      signal,
    };
    try {
      for await (const event of executor.run(request)) this.applyExecutorEvent(runId, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行器中断';
      this.applyFault(runId, 'network-interruption', message);
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
      const acked = acknowledgeRun(attempt, { accepted: true, executorRunId: event.executorRunId });
      if (!acked.ok || !acked.mayMarkNodeRunning) {
        if (!acked.ok) this.addLate(attempt, 'output-arrived', '接收回执已迟到。', 'terminal-run');
        return;
      }
      const applied = this.applyTransition({ type: 'execution-acknowledged' }, `ack:${runId}`);
      if (!applied) return;
      this.putRun(acked.attempt);
      this.noteQueueApplied(runId);
      this.ensureExecutorTurn(acked.attempt, '');
      this.persist();
      return;
    }
    if (event.type === 'delta') {
      const admission = this.admit(attempt, 'output-arrived');
      if (admission.disposition !== 'apply') {
        this.addLate(attempt, 'output-arrived', event.text, admission.reason ?? 'terminal-run');
        this.persist();
        return;
      }
      this.appendExecutorText(attempt, event.text, event.simulated);
      this.persist();
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
      this.persist();
      return;
    }
    if (event.type === 'late-output') {
      this.addLate(attempt, 'output-arrived', event.text);
      this.persist();
      return;
    }
    if (event.type === 'completed') {
      this.finishRun(attempt, event.result.draftText, event.result.simulated);
      return;
    }
    if (event.type === 'failed') {
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
      this.persist();
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
      this.persist();
      return;
    }
    this.putRun(settled.attempt);
    if (settled.nodeTransition.type === 'cancel-confirmed') {
      this.applyTransition(settled.nodeTransition, `cancel:${runId}`);
    }
    this.releaseClaim(runId);
    this.persist();
  }

  private finishRun(attempt: ExecutionAttempt, draftText: string, simulated: boolean): void {
    const admission = this.admit(attempt, 'succeeded');
    if (admission.disposition !== 'apply' || !admission.mayUpdateRunRecord) {
      this.addLate(attempt, 'succeeded', draftText, admission.reason ?? 'terminal-run');
      this.persist();
      return;
    }
    const settled = settleExecutionRun(attempt, 'completed');
    if (!settled.ok) {
      this.addLate(attempt, 'succeeded', draftText, 'terminal-run');
      this.persist();
      return;
    }
    this.appendExecutorText(attempt, '', simulated, draftText);
    this.putRun(settled.attempt);
    if (settled.nodeTransition.type === 'execution-finished') {
      this.applyTransition(settled.nodeTransition, `finish:${attempt.id}`);
      this.releaseClaim(attempt.id);
      this.persist();
      this.consumeQueue(attempt.id);
      return;
    }
    this.persist();
  }

  private consumeQueue(finishedRunId: string): void {
    const pending = this.interventions.find(
      (item) => item.runId === finishedRunId && item.phase === 'pending',
    );
    if (!pending) return;
    const opened = this.beginRun({
      text: pending.body,
      idempotencyKey: `apply:${pending.id}`,
      intent: 'new',
    });
    if (!opened.ok || !opened.runId || opened.replayed) return;
    this.queueApply.set(opened.runId, pending.id);
    this.startDrive(opened.runId, pending.body, []);
  }

  private noteQueueApplied(runId: string): void {
    const interventionId = this.queueApply.get(runId);
    if (!interventionId) return;
    this.interventions = this.interventions.map((item) => {
      if (item.id !== interventionId) return item;
      const next = advanceIntervention(item.phase, 'apply');
      return next.ok ? copyIntervention(item, next.phase, runId) : item;
    });
  }

  private applyFault(runId: string, kind: ExecutionFaultKind, message: string): void {
    const attempt = this.runs.find((run) => run.id === runId);
    if (!attempt || isTerminalRunStatus(attempt.status)) {
      if (attempt) this.addLate(attempt, 'failed', message, 'terminal-run');
      this.persist();
      return;
    }
    const settled = settleExecutionRun(attempt, 'failed');
    if (!settled.ok) {
      this.addLate(attempt, 'failed', message, 'terminal-run');
      this.persist();
      return;
    }
    this.putRun(settled.attempt);
    if (settled.nodeTransition.type === 'execution-failed') {
      this.applyTransition(settled.nodeTransition, `fail:${runId}`);
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
    this.releaseClaim(runId);
    this.persist();
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
    return result.ok
      ? { ok: true as const, manifest: result.manifest, blocks: [] as ContextBlockFact[] }
      : {
          ok: false as const,
          blocks: result.manifest.blocks.map((block) => ({
            sourceId: block.sourceId,
            kind: block.kind,
            version: block.version,
            reason: block.reason,
          })),
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
      skills: this.seed.catalog.skills,
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
      ...config.skills.map((skill) => ({
        kind: 'skill' as const,
        id: skill.id,
        version: skill.version,
        toolsAuthorized: false,
      })),
      ...config.mcp.map((item) => ({
        kind: 'mcp' as const,
        id: item.id,
        version: item.version,
        toolsAuthorized: item.toolsAuthorized,
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

  private applyTransition(transition: NodeTransition, key: string): boolean {
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
      return true;
    }
    return outcome.decision.status === 'replayed';
  }

  private activeRun(): ExecutionAttempt | undefined {
    return this.runs.find(
      (run) => run.nodeId === this.seed.handoff.nodeId && !isTerminalRunStatus(run.status),
    );
  }

  private abandonedRun(): { runId: string; reason: 'session-not-resumed' } | null {
    const run = [...this.runs].reverse().find((item) => !isTerminalRunStatus(item.status));
    if (!run) return null;
    const executor = this.deps.executors.find((item) => item.id === run.executor);
    if (executor?.capabilities.sessionResume) return null;
    return { runId: run.id, reason: 'session-not-resumed' };
  }

  private currentGeneration(): number {
    return this.runs.reduce((highest, run) => Math.max(highest, run.generation), 0);
  }

  private putRun(next: ExecutionAttempt): void {
    this.runs = this.runs.map((run) => (run.id === next.id ? next : run));
  }

  private releaseClaim(runId: string): void {
    this.claims = [...releaseWritableWorkspace(this.claims, isolateWorkspaceId(runId), runId)];
  }

  private probe(relativePath: string): FileProbeResult {
    if (this.deps.probe) return this.deps.probe(relativePath);
    if (!this.seed.fileRoot) return { ok: false, code: 'path-rejected' };
    return probeRelativeFile(this.seed.fileRoot, relativePath);
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
    this.lastError = { code, objectLabel, reason, nextStep };
    this.persist();
    return { ok: false, code, objectLabel, reason, nextStep, snapshot: this.snapshot() };
  }

  private succeed(extra: { replayed?: boolean; runId?: string } = {}): DeskResult {
    this.lastError = null;
    this.persist();
    return {
      ok: true,
      replayed: extra.replayed ?? false,
      snapshot: this.snapshot(),
      ...(extra.runId !== undefined ? { runId: extra.runId } : {}),
    };
  }

  private persist(): void {
    this.deps.journal?.save(this.persistence());
  }
}

export function executionHint(snapshot: ExecutionDeskSnapshot) {
  const active = snapshot.runs.find((run) => !isTerminalRunStatus(run.status));
  return executionTodoHint({
    nodeStatus: snapshot.node.status,
    actorId: snapshot.actorId,
    assignee: snapshot.assignee,
    ...(active ? { runStatus: active.status, stopPhase: active.stopPhase } : {}),
  });
}

function copyIntervention(
  item: InterventionRecord,
  phase: InterventionRecord['phase'],
  appliedRunId?: string,
): InterventionRecord {
  return {
    id: item.id,
    runId: item.runId,
    kind: item.kind,
    phase,
    body: item.body,
    idempotencyKey: item.idempotencyKey,
    payloadHash: item.payloadHash,
    ...(item.notice !== undefined ? { notice: item.notice } : {}),
    ...(appliedRunId !== undefined
      ? { appliedRunId }
      : item.appliedRunId !== undefined
        ? { appliedRunId: item.appliedRunId }
        : {}),
  };
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
