import { z } from 'zod';
import {
  canonicalPayload,
  completionSource,
  createExecutionHandoff,
  downstreamRecords,
  eventsAfter,
  executionInbox,
  nodeRecordKey,
  recordCommandEvent,
  settleReview,
  startAppliedPlan,
  submitDelivery,
  toNodeExecutionReport,
  unlockDownstream,
  unlockKey,
  castBallot,
  WorkbenchError,
  WorkTaskSchema,
  type DomainEvent,
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
  applyDeliveryDraft,
  deliveryDraftView,
  withoutDeliveryDraft,
  type DeliveryDraftView,
} from './delivery-draft.js';
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
const draftLocate = {
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
};
const draftReadSchema = z.strictObject(draftLocate);
const DRAFT_LINK_MAX = 2048;
const DRAFT_LINK_TOTAL_MAX = 8192;
const DRAFT_FILE_FIELD_MAX = 2048;
const DRAFT_BODY_MAX = 262_144;
const DRAFT_KEY_MAX = 200;
const draftWriteSchema = z.strictObject({
  ...draftLocate,
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: id,
  text: boundedText.optional(),
  files: z.array(fileSchema).max(20).optional(),
  links: z.array(z.string().min(1)).max(20).optional(),
});
const inboxSchema = z.strictObject({});
const eventsSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
  after: z.number().refine((value) => Number.isSafeInteger(value) && value >= 0),
  seenEventIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
});

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
  'files-not-accepted': '文件还不能随这次提交完成。请只提交文字或链接。',
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
  'not-returned': '这项工作还没有被退回。',
  'not-deliverable': '这项工作现在不能保存交付草稿。',
  'empty-request-changes': '退回要写意见，或引用一条还没解决的评论。',
  'empty-comment': '只评论时要写下评论，不能只留空白。',
  'comment-not-unresolved': '引用的评论不是这条产物上还没解决的评论。',
  validation: '提交的数据格式不正确。',
  'unknown-field': '请求里有无法识别的字段。',
  'invalid-handoff': '计划还不能派发，请补选负责人后重新确认。',
  cancelled: '操作已取消。',
} as const;

export type ExecutionMessageCode = keyof typeof MESSAGES;

const DIRECTORY_UNAVAILABLE_MESSAGE = '执行记录暂时不可用，请稍后用同一个请求再试一次。';

/** Same id rule as `save-task` and stored tasks. Not a second copy of the pattern. */
function acceptedTaskId(value: string): boolean {
  return WorkTaskSchema.shape.id.safeParse(value).success;
}

function directoryUnavailable(): { ok: false; error: ExecutionFailure } {
  return {
    ok: false,
    error: { code: 'unavailable', message: DIRECTORY_UNAVAILABLE_MESSAGE, details: {} },
  };
}

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

function draftLinkLimit(
  links: readonly string[],
): { readonly ok: false; readonly error: ExecutionFailure } | undefined {
  if (links.some((link) => link.length > DRAFT_LINK_MAX)) {
    return {
      ok: false,
      error: { code: 'validation', message: '单条链接不能超过 2048 个字符。', details: {} },
    };
  }
  let total = 0;
  for (const link of links) total += link.length;
  if (total > DRAFT_LINK_TOTAL_MAX) {
    return {
      ok: false,
      error: { code: 'validation', message: '草稿里的链接合计不能超过 8192 个字符。', details: {} },
    };
  }
  return undefined;
}

function draftFileLimit(
  text: string,
  links: readonly string[],
  files: readonly {
    id: string;
    mediaType: string;
    checksum: string;
    accessPolicyId: string;
  }[],
): { readonly ok: false; readonly error: ExecutionFailure } | undefined {
  for (const file of files) {
    const fields = [file.id, file.mediaType, file.checksum, file.accessPolicyId];
    if (fields.some((field) => field.length > DRAFT_FILE_FIELD_MAX)) {
      return {
        ok: false,
        error: {
          code: 'validation',
          message: '文件信息的每一项不能超过 2048 个字符。',
          details: {},
        },
      };
    }
  }
  let total = text.length;
  for (const link of links) total += link.length;
  for (const file of files) {
    total +=
      file.id.length + file.mediaType.length + file.checksum.length + file.accessPolicyId.length;
  }
  if (total > DRAFT_BODY_MAX) {
    return {
      ok: false,
      error: { code: 'validation', message: '草稿合计不能超过 262144 个字符。', details: {} },
    };
  }
  return undefined;
}

function draftKeyLimit(
  idempotencyKey: string,
): { readonly ok: false; readonly error: ExecutionFailure } | undefined {
  if (idempotencyKey.length > DRAFT_KEY_MAX) {
    return {
      ok: false,
      error: { code: 'validation', message: '幂等键不能超过 200 个字符。', details: {} },
    };
  }
  return undefined;
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

function taskForPlanKey<T extends { readonly id: string }>(
  key: string,
  tasks: readonly T[],
): T | undefined {
  let found: T | undefined;
  for (const task of tasks) {
    if (!key.startsWith(`${task.id}:`)) continue;
    const rest = key.slice(task.id.length + 1);
    const splitAt = rest.lastIndexOf(':');
    if (splitAt <= 0) continue;
    if (!/^\d+$/.test(rest.slice(splitAt + 1))) continue;
    if (!found || task.id.length > found.id.length) found = task;
  }
  return found;
}

function directoryIds(workbench: Workbench): readonly string[] {
  return workbench.participants
    .filter((participant) => participant.kind === 'human')
    .map((participant) => participant.id);
}

export interface InboxPlace {
  readonly itemId: string;
  readonly taskPath: string;
  readonly ownerName: string;
}

export interface InboxCounts {
  readonly deliver: number;
  readonly review: number;
  readonly confirm: number;
}

/** Project, task, then ancestor node titles. The current node title stays on the row. */
function inboxPlace(workbench: Workbench, item: InboxItem): InboxPlace {
  const task = workbench.tasks.find((entry) => entry.id === item.taskId);
  const project = task
    ? workbench.projects.find((entry) => entry.id === task.projectId)
    : undefined;
  const titles: string[] = [];
  const projectName = project?.name.trim() ?? '';
  const taskTitle = task?.title.trim() ?? '';
  if (projectName !== '') titles.push(projectName);
  if (taskTitle !== '') titles.push(taskTitle);
  if (task) {
    const located = new Map<string, { parentNodeId: string | null; title: string }>();
    for (const workflow of task.workflows) {
      for (const node of workflow.nodes) {
        located.set(node.id, { parentNodeId: workflow.parentNodeId, title: node.title.trim() });
      }
    }
    const chain: string[] = [];
    const seen = new Set<string>();
    let parentId = located.get(item.nodeId)?.parentNodeId ?? null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = located.get(parentId);
      if (!parent) break;
      if (parent.title !== '') chain.push(parent.title);
      parentId = parent.parentNodeId;
    }
    titles.push(...chain.reverse());
  }
  const owner = task?.ownerId
    ? workbench.participants.find((person) => person.id === task.ownerId)
    : undefined;
  return { itemId: item.id, taskPath: titles.join(' / '), ownerName: owner?.name.trim() ?? '' };
}

function countInbox(items: readonly InboxItem[]): InboxCounts {
  return {
    deliver: items.filter((item) => item.kind === 'deliver').length,
    review: items.filter((item) => item.kind === 'review').length,
    confirm: items.filter((item) => item.kind === 'confirm').length,
  };
}

type NodeEvent = DomainEvent<{ readonly status: string; readonly version: number }>;

export interface ExecutionEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly type: string;
  readonly nodeId: string;
  readonly status: string;
  readonly version: number;
}

/** Append one accepted fact onto the node record. The id is the next sequence. */
function withExecutionEvent(
  record: ExecutionNodeRecord,
  type: string,
  actorId: string,
): ExecutionNodeRecord | undefined {
  const log: readonly NodeEvent[] = Array.isArray(record.events) ? record.events : [];
  const sequence = log.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
  const appended = recordCommandEvent({
    decisionStatus: 'applied',
    log,
    event: {
      eventId: `evt:${record.nodeId}:${sequence}`,
      sequence,
      occurredAt: new Date().toISOString(),
      actorId,
      object: { type: 'node', id: record.nodeId },
      type,
      payload: { status: record.command.status, version: record.command.version },
    },
  });
  if (!appended.ok || !appended.emitted) return undefined;
  return { ...record, events: appended.log };
}

function publishExecutionEvent(event: NodeEvent): ExecutionEvent | undefined {
  const payload = event.payload;
  if (
    event.object.type !== 'node' ||
    typeof payload?.status !== 'string' ||
    typeof payload.version !== 'number'
  ) {
    return undefined;
  }
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    actorId: event.actorId,
    type: event.type,
    nodeId: event.object.id,
    status: payload.status,
    version: payload.version,
  };
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
    ExecutionResult<{
      actorId: string;
      items: readonly InboxItem[];
      nodes: ExecutionNodeView[];
      places?: readonly InboxPlace[];
    }>
  > {
    return this.enqueue(async () => {
      const opened = await this.openInbox(caller, body);
      if (!opened.ok) return opened;
      const workbench = this.workbench.readWorkbench();
      const nodes = opened.records
        .filter((record) =>
          opened.items.some(
            (item) => item.nodeId === record.nodeId && item.taskId === record.taskId,
          ),
        )
        .map((record) => ({
          ...toNodeView(record),
          inputs: upstreamInputsFor(record, opened.records),
        }));
      return {
        ok: true,
        value: {
          actorId: opened.actorId,
          items: opened.items,
          nodes,
          places: opened.items.map((item) => inboxPlace(workbench, item)),
        },
      };
    });
  }

  /** Counts for a shortcut. The next read follows the current node status. */
  inboxCounts(caller: ExecutionCaller, body: unknown): Promise<ExecutionResult<InboxCounts>> {
    return this.enqueue(async () => {
      const opened = await this.openInbox(caller, body);
      if (!opened.ok) return opened;
      return { ok: true, value: countInbox(opened.items) };
    });
  }

  /** Events after a cursor. Seen ids are dropped so a replay does not apply twice. */
  events(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ readonly events: readonly ExecutionEvent[] }>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(eventsSchema, body);
      if (!parsed.ok) return parsed;
      const space = await this.gateSpace(parsed.value.taskId, actor.value.spaceIds);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
      if (space === 'missing' || !space.ok) return fail('not-found');
      const current = this.storage.readNode(nodeRecordKey(parsed.value));
      if (!current || !intactNode(current)) return fail('not-found');
      if (
        planMembership(this.workbench.readWorkbench(), current.taskId, actor.value.actorId) !==
        'allowed'
      ) {
        return fail('not-found');
      }
      if (!recordedPlan(this.storage, current)) return fail('not-found');
      await this.repairTaskUnlocks(current.taskId, actor.value.spaceIds);
      const latest = this.storage.readNode(nodeRecordKey(parsed.value)) ?? current;
      const log: readonly NodeEvent[] = Array.isArray(latest.events) ? latest.events : [];
      const page = eventsAfter(log, {
        sequence: parsed.value.after,
        seenEventIds: parsed.value.seenEventIds ?? [],
      });
      return {
        ok: true,
        value: {
          events: page.flatMap((event) => {
            const published = publishExecutionEvent(event);
            return published ? [published] : [];
          }),
        },
      };
    });
  }

  submit(caller: ExecutionCaller, body: unknown) {
    return this.enqueue(() =>
      this.command(
        caller,
        body,
        submitSchema,
        (actorId, request, record) => {
          if ((request.files ?? []).length > 0) {
            return {
              result: {
                ok: false as const,
                disposition: 'rejected' as const,
                code: 'files-not-accepted',
                record,
              },
              settle: false,
            };
          }
          const result = submitDelivery({
            record,
            actorId,
            idempotencyKey: request.idempotencyKey,
            expectedVersion: request.expectedVersion,
            draft: {
              files: [],
              links: request.links ?? [],
              ...(request.text === undefined ? {} : { text: request.text }),
            },
            artifactId: `artifact:${request.idempotencyKey}`,
            roundId: `round:${request.idempotencyKey}`,
          });
          return { result, settle: false };
        },
        'delivery-submitted',
        true,
      ),
    );
  }

  ballot(caller: ExecutionCaller, body: unknown) {
    return this.enqueue(() =>
      this.command(
        caller,
        body,
        ballotSchema,
        (actorId, request, record) => {
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
            comments: record.comments,
          });
          return { result, settle: true };
        },
        'ballot-recorded',
      ),
    );
  }

  settle(caller: ExecutionCaller, body: unknown) {
    return this.enqueue(() =>
      this.command(
        caller,
        body,
        settleSchema,
        (actorId, request, record) => {
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
        },
        'review-settled',
      ),
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
      if (space === 'missing' || !space.ok) {
        return space === 'missing' ? fail('not-found') : space;
      }
      const membership = planMembership(
        this.workbench.readWorkbench(),
        parsed.value.taskId,
        actor.value.actorId,
      );
      if (membership === 'missing') return fail('not-found');
      if (membership === 'not-participant') return fail('not-participant');
      const { taskId, planId, revision } = parsed.value;
      const listed = () =>
        this.storage
          .listNodes()
          .filter((record) => intactNode(record) && samePlan(record, taskId, planId, revision));
      if (this.storage.readPlan(planKey(taskId, planId, revision)) === undefined) {
        if (listed().length > 0) return fail('plan-incomplete');
        return { ok: true, value: { reports: [] } };
      }
      await this.repairTaskUnlocks(taskId, actor.value.spaceIds);
      return { ok: true, value: { reports: listed().map(toNodeExecutionReport) } };
    });
  }

  /** Space, membership, and assignee checks shared by reading and saving a draft. */
  private async prepareDraft(
    spaceIds: readonly string[],
    actorId: string,
    query: { taskId: string; planId: string; revision: number; nodeId: string },
  ): Promise<ExecutionResult<ExecutionNodeRecord>> {
    const space = await this.gateSpace(query.taskId, spaceIds);
    if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
    if (space === 'missing' || !space.ok) return fail('not-found');
    const current = this.storage.readNode(nodeRecordKey(query));
    if (!current || !intactNode(current)) return fail('not-found');
    const membership = planMembership(this.workbench.readWorkbench(), current.taskId, actorId);
    if (membership === 'missing') return fail('not-found');
    if (membership === 'not-participant') return fail('not-participant');
    if (!recordedPlan(this.storage, current)) return fail('plan-incomplete');
    const assignee = current.handoff.assignee;
    if (assignee.kind !== 'human' || assignee.id !== actorId) return fail('not-assignee');
    if (current.command.status !== 'ready' && current.command.status !== 'needs-revision') {
      return fail('not-deliverable');
    }
    await this.repairTaskUnlocks(query.taskId, spaceIds);
    const refreshed = this.storage.readNode(nodeRecordKey(query));
    if (!refreshed || !intactNode(refreshed)) return fail('not-found');
    return { ok: true, value: refreshed };
  }

  /** Read or save the assignee's delivery draft. The draft itself is unchanged by a read. */
  draft(caller: ExecutionCaller, body: unknown): Promise<ExecutionResult<DeliveryDraftView>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const writing = body !== null && typeof body === 'object' && 'idempotencyKey' in body;
      if (!writing) {
        const parsed = parseBody(draftReadSchema, body);
        if (!parsed.ok) return parsed;
        const opened = await this.prepareDraft(
          actor.value.spaceIds,
          actor.value.actorId,
          parsed.value,
        );
        if (!opened.ok) return opened;
        return { ok: true, value: deliveryDraftView(opened.value.deliveryDraft) };
      }
      const parsed = parseBody(draftWriteSchema, body);
      if (!parsed.ok) return parsed;
      const limited = draftLinkLimit(parsed.value.links ?? []);
      if (limited) return limited;
      const sized = draftFileLimit(
        parsed.value.text ?? '',
        parsed.value.links ?? [],
        parsed.value.files ?? [],
      );
      if (sized) return sized;
      const space = await this.gateSpace(parsed.value.taskId, actor.value.spaceIds);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
      if (space === 'missing' || !space.ok) return fail('not-found');
      const keyed = draftKeyLimit(parsed.value.idempotencyKey);
      if (keyed) return keyed;
      const opened = await this.prepareDraft(
        actor.value.spaceIds,
        actor.value.actorId,
        parsed.value,
      );
      if (!opened.ok) return opened;
      const current = opened.value;
      const text = parsed.value.text ?? '';
      const links = parsed.value.links ?? [];
      const files = (parsed.value.files ?? []).map((file) => ({ ...file, uploadComplete: false }));
      const applied = applyDeliveryDraft({
        current: current.deliveryDraft,
        expectedVersion: parsed.value.expectedVersion,
        idempotencyKey: parsed.value.idempotencyKey,
        fingerprint: canonicalPayload({
          kind: 'delivery-draft',
          actorId: actor.value.actorId,
          nodeId: current.nodeId,
          text,
          links,
          files,
        }),
        text,
        links,
        files,
      });
      if (!applied.ok) {
        if (applied.code === 'conflict') {
          return fail('conflict', {
            currentVersion: applied.currentVersion,
            expectedVersion: parsed.value.expectedVersion,
          });
        }
        return fail(applied.code);
      }
      if (applied.disposition === 'applied') {
        const stored = await this.persist(() =>
          this.storage.writeNode(nodeRecordKey(current), {
            ...current,
            deliveryDraft: applied.draft,
          }),
        );
        if (!stored.ok) return stored;
      }
      return { ok: true, value: deliveryDraftView(applied.draft) };
    });
  }

  /** Return notes and the two newest relevant versions. The revision record itself is unchanged. */
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
      await this.repairTaskUnlocks(current.taskId, actor.value.spaceIds);
      return { ok: true, value: { view: read.view } };
    });
  }

  /** Fill unlocks that were settled before their downstream write landed. */
  reconcile(): Promise<ExecutionResult<{ unlocked: number }>> {
    return this.enqueue(() => this.reconcileNow());
  }

  /**
   * Finish unlocks for one task the caller is already allowed to see.
   * A failed write is left for the next authorized request and does not
   * change this request's result. Other tasks are not written.
   */
  private async repairTaskUnlocks(taskId: string, spaceIds: readonly string[]): Promise<void> {
    const space = await this.gateSpace(taskId, spaceIds);
    if (space === 'missing' || !space.ok) return;
    for (const record of [...this.storage.listNodes()]) {
      if (
        !intactNode(record) ||
        record.command.status !== 'completed' ||
        record.taskId !== taskId
      ) {
        continue;
      }
      try {
        const result = await this.unlockFrom(record);
        if (!result.ok) return;
      } catch {
        return;
      }
    }
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
   * Ask the directory before distinguishing a missing task from a hidden one.
   * A thrown lookup, `unavailable`, or an ok answer whose space id cannot be
   * used is the same answer either way.
   * No directory, an unknown project, or a mismatch is not-found.
   * A missing task is asked with its task id only when that id matches
   * `WorkTaskSchema`. Any other requested id is not-found and is not sent.
   * An empty string is never sent.
   */
  private async gateSpace(
    taskId: string,
    spaceIds: readonly string[],
  ): Promise<'missing' | ExecutionResult<string>> {
    const task = this.workbench.readWorkbench().tasks.find((item) => item.id === taskId);
    const directory = this.projectSpaceDirectory();
    if (!directory) {
      if (!task) return 'missing';
      return fail('not-found');
    }
    let lookup: ProjectSpaceLookup;
    try {
      if (!task && !acceptedTaskId(taskId)) return 'missing';
      const projectId = task ? task.projectId : taskId;
      if (projectId === '') return task ? fail('not-found') : 'missing';
      lookup = await directory.spaceForProject(projectId);
    } catch {
      return directoryUnavailable();
    }
    if (
      lookup == null ||
      typeof lookup !== 'object' ||
      (!lookup.ok && lookup.reason !== 'unknown')
    ) {
      return directoryUnavailable();
    }
    const decision = decideProjectSpace(lookup, spaceIds);
    if (decision === 'ok' && lookup.ok) return { ok: true, value: lookup.spaceId };
    if (decision === 'unavailable') return directoryUnavailable();
    if (!task) return 'missing';
    return fail('not-found');
  }

  /**
   * Ask the directory about every workbench task before any node is read.
   * An illegal answer is unavailable either way, so a missing node is not distinct.
   */
  private async directoryGate(
    spaceIds: readonly string[],
  ): Promise<{ readonly ok: false; readonly error: ExecutionFailure } | undefined> {
    const seen = new Set<string>();
    for (const task of this.workbench.readWorkbench().tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      const space = await this.gateSpace(task.id, spaceIds);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
    }
    return undefined;
  }

  private async openInbox(caller: ExecutionCaller, body: unknown) {
    const actor = this.actor(caller, body);
    if (!actor.ok) return actor;
    const parsed = parseBody(inboxSchema.optional(), body ?? {});
    if (!parsed.ok) return parsed;
    if (!this.projectSpaceDirectory()) return fail('not-found');
    const blocked = await this.directoryGate(actor.value.spaceIds);
    if (blocked) return blocked;
    const visible = await this.readableRecords(actor.value.spaceIds, actor.value.actorId);
    if (!Array.isArray(visible)) return visible;
    for (const taskId of new Set(visible.map((record) => record.taskId))) {
      await this.repairTaskUnlocks(taskId, actor.value.spaceIds);
    }
    const records = await this.readableRecords(actor.value.spaceIds, actor.value.actorId);
    if (!Array.isArray(records)) return records;
    return {
      ok: true as const,
      actorId: actor.value.actorId,
      records,
      items: executionInbox({ actorId: actor.value.actorId, records }),
    };
  }

  /** Intact nodes this actor can read. A failed lookup stops the scan. */
  private async readableRecords(spaceIds: readonly string[], actorId: string) {
    // A down directory is the same answer whether or not any node is stored.
    for (const task of this.workbench.readWorkbench().tasks) {
      const space = await this.gateSpace(task.id, spaceIds);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
    }
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

  /**
   * Another plan in this space already used the key.
   * Only an explicit other space id is ignored, so a foreign key neither
   * blocks the start nor changes the response when that lookup succeeds.
   * `unknown` is a directory fault here: the task still exists on the workbench.
   * A throw, `unavailable`, `unknown`, or an unusable answer refuses the start.
   */
  private async sameSpaceIdempotencyConflict(
    idempotencyKey: string,
    key: string,
    spaceId: string,
    projectId: string,
  ): Promise<ExecutionResult<boolean>> {
    const directory = this.projectSpaceDirectory();
    const tasks = this.workbench.readWorkbench().tasks;
    const spaceByProject = new Map<string, string | undefined>([[projectId, spaceId]]);
    for (const item of this.storage.listPlans()) {
      if (item.receipt.idempotencyKey !== idempotencyKey || item.key === key) continue;
      const task = taskForPlanKey(item.key, tasks);
      if (!task) continue;
      let owner = spaceByProject.get(task.projectId);
      if (!spaceByProject.has(task.projectId)) {
        owner = undefined;
        if (directory) {
          try {
            const lookup = await directory.spaceForProject(task.projectId);
            if (lookup != null && typeof lookup === 'object' && lookup.ok === false) {
              return directoryUnavailable();
            }
            const decision = decideProjectSpace(lookup, [spaceId]);
            if (decision === 'unavailable') return directoryUnavailable();
            owner = decision === 'ok' ? spaceId : undefined;
          } catch {
            return directoryUnavailable();
          }
        }
        spaceByProject.set(task.projectId, owner);
      }
      if (owner === spaceId) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }

  private async startPlanNow(caller: ExecutionCaller, body: unknown) {
    const actor = this.actor(caller, body);
    if (!actor.ok) return actor;
    const parsed = parseBody(startSchema, body);
    if (!parsed.ok) return parsed;
    const { taskId, planId, revision, idempotencyKey } = parsed.value;
    const space = await this.gateSpace(taskId, actor.value.spaceIds);
    if (space === 'missing' || !space.ok) {
      return space === 'missing' ? fail('not-found') : space;
    }
    const membership = planMembership(this.workbench.readWorkbench(), taskId, actor.value.actorId);
    if (membership === 'not-participant') return fail('not-participant');
    const fingerprint = canonicalPayload({ taskId, planId, revision });
    const key = planKey(taskId, planId, revision);
    const task = this.workbench.readWorkbench().tasks.find((item) => item.id === taskId);
    if (!task) return fail('not-found');
    const prior = this.storage.readPlan(key);
    const replayed = {
      ok: true as const,
      value: { disposition: 'replayed', reports: this.reportsFor(taskId, planId, revision) },
    };
    // The same key replays before the conflict scan, so another project's
    // directory fault cannot change that retry. Any other key is checked first.
    if (prior?.fingerprint === fingerprint && prior.idempotencyKey === idempotencyKey) {
      return replayed;
    }
    const conflict = await this.sameSpaceIdempotencyConflict(
      idempotencyKey,
      key,
      space.value,
      task.projectId,
    );
    if (!conflict.ok) return conflict;
    if (conflict.value) return fail('idempotency-mismatch');
    if (prior?.fingerprint === fingerprint) return replayed;
    let applied;
    try {
      applied = createExecutionHandoff(
        { taskId, planId, revision },
        this.workbench.readWorkbench(),
      );
    } catch (error) {
      if (error instanceof WorkbenchError) return fail(error.code);
      return directoryUnavailable();
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
      const stamped = withExecutionEvent(record, 'node-started', actor.value.actorId);
      if (!stamped) return fail('unavailable');
      const stored = await this.persist(() => this.storage.writeNode(key, stamped));
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
    eventType: string,
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
        record = withoutDeliveryDraft(record);
      }
      if (executed.result.disposition === 'applied') {
        const stamped = withExecutionEvent(record, eventType, actor.value.actorId);
        if (!stamped) return fail('unavailable');
        record = stamped;
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
    await this.repairTaskUnlocks(current.taskId, actor.value.spaceIds);
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
      const stamped = withExecutionEvent(moved.record, 'downstream-unlocked', completed.ownerId);
      if (!stamped) return fail('unavailable');
      const stored = await this.persist(() =>
        this.storage.writeNode(nodeRecordKey(stamped), stamped),
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
        if (!result.ok) continue;
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
