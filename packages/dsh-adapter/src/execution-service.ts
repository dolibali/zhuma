import { z } from 'zod';
import {
  canonicalPayload,
  completionSource,
  createExecutionHandoff,
  downstreamRecords,
  executionInbox,
  nodeRecordKey,
  settleReview,
  startAppliedPlan,
  submitDelivery,
  toNodeExecutionReport,
  unlockDownstream,
  unlockKey,
  castBallot,
  WorkbenchError,
  type ExecutionNodeRecord,
  type InboxItem,
  type NodeExecutionReport,
  type Workbench,
} from '@zhuma/agent-core';
import { resolveActor, scanActorField, type MemberResolution } from './execution-identity.js';
import {
  decideProjectSpace,
  type ProjectSpaceDirectory,
  type ProjectSpaceLookup,
} from './project-space.js';
import { readRevisionView, type RevisionView } from './revision-view.js';
import {
  upstreamBlockMessage,
  upstreamInputsFor,
  type UpstreamInputView,
} from './upstream-inputs.js';

/** The actor is only `member`, the result of identity's `resolveMember`. */
export interface ExecutionCaller {
  readonly member?: MemberResolution;
}

const id = z.string().min(1);
const TEXT_LIMIT = 100_000;
const boundedText = z.string().max(TEXT_LIMIT);
const fileSchema = z.strictObject({
  id,
  mediaType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  checksum: z.string().min(1),
  accessPolicyId: z.string().min(1),
  uploadComplete: z.boolean(),
});
const locate = {
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: id,
};
const startSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int(),
  idempotencyKey: id,
});
const submitSchema = z.strictObject({
  ...locate,
  text: boundedText.optional(),
  files: z.array(fileSchema).max(20).optional(),
  links: z.array(z.string()).max(20).optional(),
});
const ballotSchema = z.strictObject({
  ...locate,
  roundId: id,
  artifactVersionId: id,
  action: z.enum(['approve', 'request-changes', 'comment']),
  comment: boundedText.optional(),
  unresolvedCommentIds: z.array(z.string()).max(50).optional(),
});
const settleSchema = z.strictObject({
  ...locate,
  roundId: id,
  artifactVersionId: id,
});
const reportSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int(),
});
const revisionSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
});
const inboxSchema = z.strictObject({});

export type StartPlanRequest = z.infer<typeof startSchema>;
export type InboxRequest = z.infer<typeof inboxSchema>;
export type SubmitRequest = z.infer<typeof submitSchema>;
export type BallotRequest = z.infer<typeof ballotSchema>;
export type SettleRequest = z.infer<typeof settleSchema>;
export type ReportRequest = z.infer<typeof reportSchema>;
export type RevisionRequest = z.infer<typeof revisionSchema>;

export interface PlanReceipt {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly nodeIds: readonly string[];
}

export interface ExecutionStorage {
  readNode(key: string): ExecutionNodeRecord | undefined;
  writeNode(key: string, value: ExecutionNodeRecord): Promise<void>;
  listNodes(): readonly ExecutionNodeRecord[];
  readPlan(key: string): PlanReceipt | undefined;
  writePlan(key: string, value: PlanReceipt): Promise<void>;
  listPlans(): readonly { readonly key: string; readonly receipt: PlanReceipt }[];
}

export interface ExecutionFailure {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type ExecutionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExecutionFailure };

export interface ExecutionNodeView {
  readonly nodeId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly version: number;
  readonly status: NodeExecutionReport['status'];
  readonly goal: string;
  readonly expectedOutput: string;
  readonly assigneeId: string;
  readonly assigneeKind: 'human' | 'expert';
  readonly reviewerIds: readonly string[];
  readonly ownerId: string | null;
  readonly rounds: ExecutionNodeRecord['rounds'];
  readonly artifacts: ExecutionNodeRecord['artifactVersions'];
  readonly comments: ExecutionNodeRecord['comments'];
  readonly entryStatus?: 'ready' | 'needs-revision';
  readonly currentRoundId?: string;
  readonly acceptedArtifactVersionId?: string;
  readonly reviewOutcome?: NodeExecutionReport['reviewOutcome'];
  readonly blockReason?: string;
  readonly inputs?: readonly UpstreamInputView[];
}

const MESSAGES = {
  'actor-from-body': '不能在请求里指定操作者。',
  unauthenticated: '请先登录。',
  'untrusted-request': '这次请求不可信。',
  'not-assignee': '只有该节点的执行者可以提交。',
  'not-assigned-reviewer': '你不是这一轮的评审人。',
  'actor-mismatch': '不能代替其他评审人投票。',
  'upload-incomplete': '文件还没有上传完成，不能提交。',
  'empty-delivery': '请填写交付说明，或附上已上传完成的文件。',
  conflict: '内容已变化，请刷新后再试。',
  'idempotency-mismatch': '这个请求标识已经用于另一项操作。',
  'plan-not-found': '找不到指定的已确认计划版本。',
  'plan-reference-required': '请提供任务、计划标识和精确计划版本。',
  'stale-round': '这不是当前评审轮次。',
  'stale-version': '这不是当前产物版本。',
  'voided-round': '这一轮评审已作废。',
  'not-in-directory': '当前登录身份不在团队目录里。',
  'not-participant': '只有这项任务的负责人或参与者可以执行这个操作。',
  'plan-incomplete': '计划还没有完整启动，暂时不能查看或写入。',
  unavailable: '执行记录暂时写不进去，请用同一个请求再试一次。',
  'not-found': '找不到这个节点。',
  'not-revision-reader': '只有负责人和当前评审人可以查看退回意见。',
  'not-returned': '这项工作还没有被退回。',
  validation: '提交的数据格式不正确。',
  'unknown-field': '请求里有无法识别的字段。',
  'invalid-handoff': '计划还不能派发，请补选负责人后重新确认。',
  cancelled: '操作已取消。',
} as const;

export type ExecutionMessageCode = keyof typeof MESSAGES;

function fail(
  code: string,
  details: Record<string, unknown> = {},
): { ok: false; error: ExecutionFailure } {
  const message =
    code in MESSAGES ? MESSAGES[code as ExecutionMessageCode] : '执行请求没有被接受。';
  return {
    ok: false,
    error: { code, message, details },
  };
}

/** Directory lookup failed. A real disk write still uses `fail('unavailable')`. */
function directoryUnavailable(): { ok: false; error: ExecutionFailure } {
  return {
    ok: false,
    error: {
      code: 'unavailable',
      message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
      details: {},
    },
  };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): ExecutionResult<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const unknown = parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys');
  return fail(unknown ? 'unknown-field' : 'validation');
}

export function toNodeView(record: ExecutionNodeRecord): ExecutionNodeView {
  const report = toNodeExecutionReport(record);
  return {
    nodeId: record.nodeId,
    taskId: record.taskId,
    planId: record.planId,
    revision: record.revision,
    version: record.command.version,
    status: report.status,
    goal: record.handoff.goal,
    expectedOutput: record.handoff.expectedOutput,
    assigneeId: record.handoff.assignee.id,
    assigneeKind: record.handoff.assignee.kind,
    reviewerIds: record.handoff.reviewerIds,
    ownerId: record.ownerId,
    rounds: record.rounds,
    artifacts: record.artifactVersions,
    comments: record.comments,
    ...(record.command.entryStatus !== undefined
      ? { entryStatus: record.command.entryStatus }
      : {}),
    ...(record.currentRoundId !== undefined ? { currentRoundId: record.currentRoundId } : {}),
    ...(report.acceptedArtifactVersionId !== undefined
      ? { acceptedArtifactVersionId: report.acceptedArtifactVersionId }
      : {}),
    ...(report.reviewOutcome !== undefined ? { reviewOutcome: report.reviewOutcome } : {}),
    ...(report.blockReason !== undefined ? { blockReason: report.blockReason } : {}),
  };
}

function planKey(taskId: string, planId: string, revision: number): string {
  return `${taskId}:${planId}:${revision}`;
}

function directoryIds(workbench: Workbench): readonly string[] {
  return workbench.participants
    .filter((participant) => participant.kind === 'human')
    .map((participant) => participant.id);
}

function planMembership(
  workbench: Workbench,
  taskId: string,
  actorId: string,
): 'allowed' | 'missing' | 'not-participant' {
  const task = workbench.tasks.find((item) => item.id === taskId);
  if (!task) return 'missing';
  if (task.ownerId === actorId || task.participantIds.includes(actorId)) return 'allowed';
  return 'not-participant';
}

function maySettle(record: ExecutionNodeRecord, actorId: string): boolean {
  const assignee = record.handoff.assignee;
  if (assignee.kind === 'human' && assignee.id === actorId) return true;
  return record.handoff.reviewerIds.includes(actorId);
}

function recordedPlan(storage: ExecutionStorage, record: ExecutionNodeRecord): boolean {
  return storage.readPlan(planKey(record.taskId, record.planId, record.revision)) !== undefined;
}

/** A stored value that cannot be read as a node is skipped, not fatal. */
function intactNode(record: ExecutionNodeRecord): boolean {
  try {
    if (record == null || typeof record !== 'object') return false;
    if (
      typeof record.nodeId !== 'string' ||
      typeof record.taskId !== 'string' ||
      typeof record.planId !== 'string' ||
      typeof record.revision !== 'number'
    ) {
      return false;
    }
    const handoff = record.handoff as {
      dependencyNodeIds?: unknown;
      reviewerIds?: unknown;
      assignee?: { kind?: unknown; id?: unknown };
    } | null;
    if (handoff == null || typeof handoff !== 'object' || Array.isArray(handoff)) return false;
    if (!Array.isArray(handoff.dependencyNodeIds) || !Array.isArray(handoff.reviewerIds)) {
      return false;
    }
    if (
      handoff.assignee == null ||
      typeof handoff.assignee !== 'object' ||
      typeof handoff.assignee.kind !== 'string' ||
      typeof handoff.assignee.id !== 'string'
    ) {
      return false;
    }
    if (record.command == null || typeof record.command !== 'object') return false;
    if (typeof record.command.status !== 'string' || typeof record.command.version !== 'number') {
      return false;
    }
    return Array.isArray(record.rounds) && Array.isArray(record.receipts);
  } catch {
    return false;
  }
}

function samePlan(record: ExecutionNodeRecord, taskId: string, planId: string, revision: number) {
  return record.taskId === taskId && record.planId === planId && record.revision === revision;
}

function rejectionDetails(
  code: string,
  current: ExecutionNodeRecord,
  request: { expectedVersion: number },
): Record<string, unknown> {
  if (code === 'not-assignee') return { canSubmitNode: false };
  if (code === 'conflict') {
    return { currentVersion: current.command.version, expectedVersion: request.expectedVersion };
  }
  return {};
}

/** Serializes durable execution commands. One user command writes one node record. */
export class ExecutionService {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: ExecutionStorage,
    private readonly workbench: { readWorkbench(): Workbench },
    private readonly projectSpaces: ProjectSpaceDirectory | undefined,
  ) {}

  startPlan(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ disposition: string; reports: NodeExecutionReport[] }>> {
    return this.enqueue(() => this.startPlanNow(caller, body));
  }

  inbox(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<
    ExecutionResult<{ actorId: string; items: readonly InboxItem[]; nodes: ExecutionNodeView[] }>
  > {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(inboxSchema.optional(), body ?? {});
      if (!parsed.ok) return parsed;
      if (!this.projectSpaceDirectory()) return fail('not-found');
      const records = await this.readableRecords(actor.value.spaceIds, actor.value.actorId);
      if (!Array.isArray(records)) return records;
      const items = executionInbox({ actorId: actor.value.actorId, records });
      const nodes = records
        .filter((record) =>
          items.some((item) => item.nodeId === record.nodeId && item.taskId === record.taskId),
        )
        .map((record) => ({ ...toNodeView(record), inputs: upstreamInputsFor(record, records) }));
      return { ok: true, value: { actorId: actor.value.actorId, items, nodes } };
    });
  }

  submit(caller: ExecutionCaller, body: unknown) {
    return this.enqueue(() =>
      this.command(
        caller,
        body,
        submitSchema,
        (actorId, request, record) => {
          const result = submitDelivery({
            record,
            actorId,
            idempotencyKey: request.idempotencyKey,
            expectedVersion: request.expectedVersion,
            draft: {
              files: request.files ?? [],
              links: request.links ?? [],
              ...(request.text === undefined ? {} : { text: request.text }),
            },
            artifactId: `artifact:${request.idempotencyKey}`,
            roundId: `round:${request.idempotencyKey}`,
          });
          return { result, settle: false };
        },
        true,
      ),
    );
  }

  ballot(caller: ExecutionCaller, body: unknown) {
    return this.enqueue(() =>
      this.command(caller, body, ballotSchema, (actorId, request, record) => {
        const result = castBallot({
          record,
          actorId,
          idempotencyKey: request.idempotencyKey,
          expectedVersion: request.expectedVersion,
          ballot: {
            reviewerId: actorId,
            roundId: request.roundId,
            artifactVersionId: request.artifactVersionId,
            action: request.action,
            ...(request.comment === undefined ? {} : { comment: request.comment }),
            ...(request.unresolvedCommentIds === undefined
              ? {}
              : { unresolvedCommentIds: request.unresolvedCommentIds }),
          },
        });
        return { result, settle: true };
      }),
    );
  }

  settle(caller: ExecutionCaller, body: unknown) {
    return this.enqueue(() =>
      this.command(caller, body, settleSchema, (actorId, request, record) => {
        if (!maySettle(record, actorId)) {
          return {
            result: {
              ok: false as const,
              disposition: 'rejected' as const,
              code: 'not-assigned-reviewer',
              record,
            },
            settle: false,
          };
        }
        return {
          result: settleReview({
            record,
            actorId,
            idempotencyKey: request.idempotencyKey,
            expectedVersion: request.expectedVersion,
            roundId: request.roundId,
            artifactVersionId: request.artifactVersionId,
          }),
          settle: false,
        };
      }),
    );
  }

  report(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ reports: NodeExecutionReport[] }>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(reportSchema, body);
      if (!parsed.ok) return parsed;
      const space = await this.gateSpace(parsed.value.taskId, actor.value.spaceIds);
      if (space !== 'missing' && !space.ok) return space;
      const membership = planMembership(
        this.workbench.readWorkbench(),
        parsed.value.taskId,
        actor.value.actorId,
      );
      if (membership === 'missing') return fail('plan-not-found');
      if (membership === 'not-participant') return fail('not-participant');
      const { taskId, planId, revision } = parsed.value;
      const reports = this.storage
        .listNodes()
        .filter((record) => intactNode(record) && samePlan(record, taskId, planId, revision));
      if (this.storage.readPlan(planKey(taskId, planId, revision)) === undefined) {
        if (reports.length > 0) return fail('plan-incomplete');
        return { ok: true, value: { reports: [] } };
      }
      return { ok: true, value: { reports: reports.map(toNodeExecutionReport) } };
    });
  }

  /** Return notes and the two newest relevant versions. Does not write. */
  revision(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ view: RevisionView }>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(revisionSchema, body);
      if (!parsed.ok) return parsed;
      const space = await this.gateSpace(parsed.value.taskId, actor.value.spaceIds);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
      if (space === 'missing' || !space.ok) return fail('not-found');
      const current = this.storage.readNode(nodeRecordKey(parsed.value));
      if (!current || !intactNode(current)) return fail('not-found');
      const membership = planMembership(
        this.workbench.readWorkbench(),
        current.taskId,
        actor.value.actorId,
      );
      if (membership === 'missing') return fail('not-found');
      if (membership === 'not-participant') return fail('not-participant');
      if (!recordedPlan(this.storage, current)) return fail('plan-incomplete');
      const reviewerNames: Record<string, string> = {};
      for (const participant of this.workbench.readWorkbench().participants) {
        const name = participant.name.trim();
        if (name !== '') reviewerNames[participant.id] = name;
      }
      const read = readRevisionView(current, actor.value.actorId, reviewerNames);
      if (!read.ok) return fail(read.code);
      return { ok: true, value: { view: read.view } };
    });
  }

  /** Fill unlocks that were settled before their downstream write landed. */
  reconcile(): Promise<ExecutionResult<{ unlocked: number }>> {
    return this.enqueue(() => this.reconcileNow());
  }

  private enqueue<T>(work: () => Promise<ExecutionResult<T>>): Promise<ExecutionResult<T>> {
    const operation = this.writes.then(work, work);
    this.writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private directory(): readonly string[] {
    return directoryIds(this.workbench.readWorkbench());
  }

  private actorField(
    body: unknown,
  ): { readonly ok: false; readonly error: ExecutionFailure } | undefined {
    const scan = scanActorField(body);
    if (scan === 'too-deep') return fail('validation');
    if (scan === 'present') return fail('actor-from-body');
    return undefined;
  }

  private actor(
    input: ExecutionCaller,
    body: unknown,
  ): ExecutionResult<{ readonly actorId: string; readonly spaceIds: readonly string[] }> {
    const actorField = this.actorField(body);
    if (actorField) return actorField;
    const resolved = resolveActor(input.member, this.directory());
    if (!resolved.ok) return fail(resolved.code);
    return {
      ok: true,
      value: { actorId: resolved.actorId, spaceIds: resolved.spaceIds },
    };
  }

  /** Absent or unusable injection. Callers do not fall back to the project id. */
  private projectSpaceDirectory(): ProjectSpaceDirectory | undefined {
    const directory = this.projectSpaces;
    if (typeof directory?.spaceForProject !== 'function') return undefined;
    return directory;
  }

  /**
   * Ask the directory before deciding whether the task is missing.
   * An illegal answer is unavailable either way. No directory, an unknown
   * project, or a mismatch is not-found.
   */
  private async gateSpace(
    taskId: string,
    spaceIds: readonly string[],
  ): Promise<'missing' | ExecutionResult<void>> {
    const task = this.workbench.readWorkbench().tasks.find((item) => item.id === taskId);
    const directory = this.projectSpaceDirectory();
    if (!directory) {
      if (!task) return 'missing';
      return fail('not-found');
    }
    let lookup: ProjectSpaceLookup;
    try {
      lookup = await directory.spaceForProject(task ? task.projectId : '');
    } catch {
      return directoryUnavailable();
    }
    const decision = decideProjectSpace(lookup, spaceIds);
    if (decision === 'unavailable') return directoryUnavailable();
    if (!task) return 'missing';
    if (decision === 'ok') return { ok: true, value: undefined };
    return fail('not-found');
  }

  /** Intact nodes this actor can read. A failed lookup stops the scan. */
  private async readableRecords(spaceIds: readonly string[], actorId: string) {
    const records: ExecutionNodeRecord[] = [];
    for (const record of this.storage.listNodes()) {
      if (!intactNode(record) || !recordedPlan(this.storage, record)) continue;
      const space = await this.gateSpace(record.taskId, spaceIds);
      if (space === 'missing') continue;
      if (!space.ok) {
        if (space.error.code === 'unavailable') return space;
        continue;
      }
      if (planMembership(this.workbench.readWorkbench(), record.taskId, actorId) !== 'allowed') {
        continue;
      }
      records.push(record);
    }
    return records;
  }

  /** Hidden upstream refs refuse the write. The message is the count placeholder. */
  private async upstreamRefusal(
    spaceIds: readonly string[],
    actorId: string,
    current: ExecutionNodeRecord,
  ) {
    const readable = await this.readableRecords(spaceIds, actorId);
    if (!Array.isArray(readable)) return readable;
    const message = upstreamBlockMessage(upstreamInputsFor(current, readable));
    if (message === undefined) return undefined;
    return {
      ok: false as const,
      error: { code: 'upstream-blocked', message, details: {} },
    };
  }

  private async startPlanNow(caller: ExecutionCaller, body: unknown) {
    const actor = this.actor(caller, body);
    if (!actor.ok) return actor;
    const parsed = parseBody(startSchema, body);
    if (!parsed.ok) return parsed;
    const { taskId, planId, revision, idempotencyKey } = parsed.value;
    const space = await this.gateSpace(taskId, actor.value.spaceIds);
    if (space !== 'missing' && !space.ok) return space;
    const membership = planMembership(this.workbench.readWorkbench(), taskId, actor.value.actorId);
    if (membership === 'not-participant') return fail('not-participant');
    const fingerprint = canonicalPayload({ taskId, planId, revision });
    const key = planKey(taskId, planId, revision);
    const reused = this.storage
      .listPlans()
      .find((item) => item.receipt.idempotencyKey === idempotencyKey && item.key !== key);
    if (reused) return fail('idempotency-mismatch');
    const prior = this.storage.readPlan(key);
    if (prior?.fingerprint === fingerprint) {
      return {
        ok: true as const,
        value: { disposition: 'replayed', reports: this.reportsFor(taskId, planId, revision) },
      };
    }
    let applied;
    try {
      applied = createExecutionHandoff(
        { taskId, planId, revision },
        this.workbench.readWorkbench(),
      );
    } catch (error) {
      if (error instanceof WorkbenchError) return fail(error.code);
      return fail('unavailable');
    }
    const started = startAppliedPlan({
      requested: { taskId, planId, revision },
      applied,
      actorId: actor.value.actorId,
      existing: this.storage
        .listNodes()
        .filter((record) => intactNode(record) && samePlan(record, taskId, planId, revision)),
    });
    if (!started.ok) return fail(started.code);
    for (const record of started.records) {
      const key = nodeRecordKey(record);
      if (this.storage.readNode(key) === record) continue;
      const stored = await this.persist(() => this.storage.writeNode(key, record));
      if (!stored.ok) return stored;
    }
    for (const record of started.records) {
      const latest = this.storage.readNode(nodeRecordKey(record));
      if (!latest || latest.command.status !== 'completed') continue;
      const unlocked = await this.unlockFrom(latest);
      if (!unlocked.ok) return unlocked;
    }
    const receipt: PlanReceipt = {
      idempotencyKey,
      fingerprint,
      nodeIds: started.records.map((record) => record.nodeId),
    };
    const stored = await this.persist(() => this.storage.writePlan(key, receipt));
    if (!stored.ok) return stored;
    return {
      ok: true as const,
      value: {
        disposition: started.disposition,
        reports: started.records.map(toNodeExecutionReport),
      },
    };
  }

  private async command<
    T extends {
      taskId: string;
      planId: string;
      revision: number;
      nodeId: string;
      expectedVersion: number;
    },
  >(
    caller: ExecutionCaller,
    body: unknown,
    schema: z.ZodType<T>,
    run: (
      actorId: string,
      request: T,
      record: ExecutionNodeRecord,
    ) => { result: ReturnType<typeof submitDelivery>; settle: boolean },
    guardUpstream = false,
  ) {
    const actor = this.actor(caller, body);
    if (!actor.ok) return actor;
    const parsed = parseBody(schema, body);
    if (!parsed.ok) return parsed;
    const space = await this.gateSpace(parsed.value.taskId, actor.value.spaceIds);
    if (space !== 'missing' && !space.ok) {
      if (space.error.code === 'unavailable') return space;
      return fail('not-found');
    }
    const current = this.storage.readNode(nodeRecordKey(parsed.value));
    if (space === 'missing' || !current || !intactNode(current)) return fail('not-found');
    const membership = planMembership(
      this.workbench.readWorkbench(),
      current.taskId,
      actor.value.actorId,
    );
    if (membership === 'missing') return fail('not-found');
    if (membership === 'not-participant') return fail('not-participant');
    if (!recordedPlan(this.storage, current)) return fail('plan-incomplete');
    const executed = run(actor.value.actorId, parsed.value, current);
    if (!executed.result.ok) {
      return fail(
        executed.result.code,
        rejectionDetails(executed.result.code, current, parsed.value),
      );
    }
    let record = executed.result.record;
    if (executed.settle && record.currentRoundId) {
      const round = record.rounds.find((item) => item.id === record.currentRoundId);
      if (round && (round.status === 'approved' || round.status === 'changes-requested')) {
        const settled = settleReview({
          record,
          actorId: actor.value.actorId,
          idempotencyKey: `settle:${round.id}`,
          expectedVersion: record.command.version,
          roundId: round.id,
          artifactVersionId: round.artifactVersionId,
        });
        if (!settled.ok) return fail(settled.code);
        record = settled.record;
      }
    }
    if (record !== current) {
      if (guardUpstream) {
        const blocked = await this.upstreamRefusal(
          actor.value.spaceIds,
          actor.value.actorId,
          current,
        );
        if (blocked) return blocked;
      }
      const stored = await this.persist(() =>
        this.storage.writeNode(nodeRecordKey(record), record),
      );
      if (!stored.ok) return stored;
    }
    if (record.command.status === 'completed') {
      const unlocked = await this.unlockFrom(record);
      if (!unlocked.ok) return unlocked;
    }
    return {
      ok: true as const,
      value: {
        disposition: executed.result.disposition,
        report: toNodeExecutionReport(record),
        node: toNodeView(record),
      },
    };
  }

  private async unlockFrom(completed: ExecutionNodeRecord): Promise<ExecutionResult<number>> {
    const source = completionSource(completed);
    if (!source || completed.ownerId === null) return { ok: true, value: 0 };
    let unlocked = 0;
    const peers = () =>
      this.storage
        .listNodes()
        .filter(
          (record) =>
            intactNode(record) &&
            samePlan(record, completed.taskId, completed.planId, completed.revision),
        );
    for (const downstream of downstreamRecords(peers(), completed.nodeId)) {
      const latest = this.storage.readNode(nodeRecordKey(downstream)) ?? downstream;
      const moved = unlockDownstream({
        record: latest,
        dependencies: peers(),
        actorId: completed.ownerId,
        idempotencyKey: unlockKey(source, downstream.nodeId),
        expectedVersion: latest.command.version,
      });
      if (!moved.ok || moved.disposition !== 'applied') continue;
      const stored = await this.persist(() =>
        this.storage.writeNode(nodeRecordKey(moved.record), moved.record),
      );
      if (!stored.ok) return stored;
      unlocked += 1;
    }
    return { ok: true, value: unlocked };
  }

  private async reconcileNow() {
    let unlocked = 0;
    for (const record of [...this.storage.listNodes()]) {
      if (!intactNode(record) || record.command.status !== 'completed') continue;
      try {
        const result = await this.unlockFrom(record);
        if (!result.ok) return result;
        unlocked += result.value;
      } catch {
        continue;
      }
    }
    return { ok: true as const, value: { unlocked } };
  }

  private reportsFor(taskId: string, planId: string, revision: number) {
    return this.storage
      .listNodes()
      .filter((record) => intactNode(record) && samePlan(record, taskId, planId, revision))
      .map(toNodeExecutionReport);
  }

  private async persist(write: () => Promise<void>): Promise<ExecutionResult<void>> {
    try {
      await write();
      return { ok: true, value: undefined };
    } catch {
      return fail('unavailable');
    }
  }
}
