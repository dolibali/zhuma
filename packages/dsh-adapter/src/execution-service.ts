import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalPayload,
  completionSource,
  createExecutionHandoff,
  createNodeHandoffs,
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
  type ArtifactFileRef,
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
  draftFiles,
  withoutDeliveryDraft,
  type DeliveryDraftView,
} from './delivery-draft.js';
import {
  upstreamBlockMessage,
  upstreamInputsFor,
  type UpstreamInputView,
} from './upstream-inputs.js';
import type { MemberRequest } from './member-session.js';
import type { NativeWorkGrant } from './native-work-session-contract.js';
import {
  runFileListSchema,
  runFileReadSchema,
  runFileEncoding,
  NATIVE_ACCEPTED_FILE_TOOL,
  type NativeRunAcceptedFiles,
  type NativeRunFileResourceSource,
  type NativeRunFileInfo,
  type NativeRunFileSource,
} from './native-work-session-files-contract.js';
import {
  executionRunCompositionSchema,
  readExecutionRunComposition,
  assertExecutionRunComposition,
  ExecutionRunCompositionError,
  type ExecutionRunCompositionInput,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';
import {
  ExecutionRunAuthorities,
  type ExecutionMemberLease,
  type ExecutionRunAuthoritySource,
  type ExecutionRunCleanupAuthority,
  type ExecutionRunLocator,
} from './execution-run-authority.js';
import {
  assertExecutionRunQuiescent,
  beginExecutionRun,
  beginExecutionRunSchema,
  currentExecutionRun,
  ExecutionRunError,
  executionRunScope,
  readExecutionRunState,
  recordExecutionRunEvent,
  requestExecutionRunStop,
  validateExecutionRunBegin,
  stopExecutionRunSchema,
  type ExecutionRunDecision,
  type ExecutionRunEvent,
} from './execution-run-state.js';
import {
  assertExecutionRunStoreCompatibility,
  enableExecutionRunWriter,
  ExecutionRunProtocolError,
  requireExecutionRunWriter,
} from './execution-run-protocol.js';
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment';
import {
  ARTIFACT_FILE_LIMITS,
  artifactUploadOptionsSchema,
  ArtifactUploadError,
  ArtifactUploadStream,
  artifactFileReference,
  matchesArtifactFileReference,
  readVerifiedArtifactFile,
  artifactFileLeaf,
  type ArtifactFileStore,
  type ArtifactFileUploadDeclare,
  type FileUploadReceipt,
  type UploadFileRecord,
} from './artifact-files.js';

/** The actor is only `member`, the result of identity's `resolveMember`. */
export interface ExecutionCaller {
  readonly member?: MemberResolution;
}

/** Minted from the original request and current published directory, never JSON. */
export interface ExecutionFileAuthority {
  readonly lease: ExecutionMemberLease;
  assertProjectSpace(projectId: string, spaceId: string): void;
}
export type ExecutionFileAuthoritySource = () => Promise<ExecutionFileAuthority>;

const fileReadLocation = {
  taskId: WorkTaskSchema.shape.id,
  planId: WorkTaskSchema.shape.id,
  revision: z.number().int().positive(),
  nodeId: WorkTaskSchema.shape.id,
  spaceId: WorkTaskSchema.shape.id,
  uploadId: WorkTaskSchema.shape.id,
  mode: z.enum(['metadata', 'preview', 'download']).default('metadata'),
};
const artifactId = z.string().min(1).max(1000);
const fileReadSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ ...fileReadLocation, purpose: z.literal('draft') }),
  z.strictObject({
    ...fileReadLocation,
    purpose: z.literal('artifact'),
    artifactVersionId: artifactId,
  }),
  z.strictObject({
    ...fileReadLocation,
    purpose: z.literal('review'),
    artifactVersionId: artifactId,
    roundId: artifactId,
  }),
  z.strictObject({
    ...fileReadLocation,
    purpose: z.literal('upstream'),
    sourceNodeId: WorkTaskSchema.shape.id,
    artifactVersionId: artifactId,
  }),
]);
export type FileContentRequest = z.infer<typeof fileReadSchema>;
export interface FileContentInfo {
  readonly request: FileContentRequest;
  readonly uploadId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly reference: ArtifactFileRef;
}
/** Host-only owned response. Raw HTTP strips control functions from metadata JSON. */
export interface AuthorizedFileContent {
  readonly info: FileContentInfo;
  readonly bytes?: Uint8Array;
  readonly signal: AbortSignal;
  check(): void;
  release(): void;
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
  spaceId: id.optional(),
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
  spaceId: id.optional(),
});
const revisionSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
});
const upstreamContentSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
  sourceNodeId: id,
  artifactVersionId: id,
  spaceId: id,
});
const draftLocate = {
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
};
const draftReadSchema = z.strictObject(draftLocate);
const runCompositionInputsSchema = draftReadSchema.extend({ spaceId: id });
const beginRunSchema = beginExecutionRunSchema
  .omit({ actorId: true })
  .extend({ ...draftLocate, composition: executionRunCompositionSchema });
const stopRunSchema = stopExecutionRunSchema
  .omit({ actorId: true })
  .extend({ ...draftLocate, spaceId: id });
export type BeginRunRequest = z.infer<typeof beginRunSchema>;
export type StopRunRequest = z.infer<typeof stopRunSchema>;
export type ExecutionNodeLocator = z.infer<typeof draftReadSchema>;
export type ExecutionRunCompositionInputs = ExecutionRunCompositionInput['inputs'];

/** Host-only real producers. Omission refuses Run admission; no DTO is a capability. */
export interface ExecutionRunHostPorts extends Pick<
  ExecutionRunAuthoritySource,
  'memberLease' | 'onChange' | 'signal' | 'migrationOrigin' | 'migrationDrain'
> {
  /** Current authoritative mapping (and its source lifetime), not a browser-selected space. */
  assertProjectSpace(projectId: string, spaceId: string): undefined;
  /** Verify the exact frozen expert/input/model/tool composition and executor readiness. */
  assertConfiguration(
    memberId: string,
    spaceId: string,
    node: ExecutionNodeRecord,
    request: BeginRunRequest,
  ): undefined;
  assertWorkspace(...args: Parameters<ExecutionRunAuthoritySource['assertWorkspace']>): undefined;
}

/** `void` accepts async callbacks in TypeScript. Recheck runtime JS producers too:
 * only synchronous undefined means the assertion completed. Observe a rejected
 * promise to avoid an unhandled rejection, but never await it as authorization.
 */
function synchronousRunAssertion(result: unknown): undefined {
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => undefined);
    throw new ExecutionRunError('run-authority-unavailable');
  }
  return undefined;
}

export type RunEventAuthority =
  { readonly grant: NativeWorkGrant } | { readonly cleanup: ExecutionRunCleanupAuthority };
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
const inboxSchema = z.strictObject({ spaceId: id.optional() });
const startableSchema = z.strictObject({ spaceId: id.optional() });
const eventsSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
  after: z.number().refine((value) => Number.isSafeInteger(value) && value >= 0),
  seenEventIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  spaceId: id.optional(),
});

export type StartPlanRequest = z.infer<typeof startSchema>;
export type InboxRequest = z.infer<typeof inboxSchema>;
export type StartableRequest = z.infer<typeof startableSchema>;

/**
 * One confirmed plan the member may explicitly start. Read-only discovery for
 * the "task → confirmed plan → explicit start" entry; nothing here launches.
 */
export type UpstreamContentRequest = z.infer<typeof upstreamContentSchema>;

/** Accepted content of a pinned upstream input. File refs carry metadata only, never bytes. */
export interface UpstreamContentValue {
  readonly actorId: string;
  readonly spaceId: string;
  readonly downstream: {
    readonly nodeId: string;
    readonly taskId: string;
    readonly planId: string;
    readonly revision: number;
  };
  readonly source: {
    readonly nodeId: string;
    readonly taskId: string;
    readonly planId: string;
    readonly revision: number;
  };
  readonly version: { readonly id: string; readonly version: number };
  readonly content: {
    readonly text?: string;
    readonly links: readonly string[];
    readonly files: readonly ArtifactFileRef[];
  };
}

export interface StartablePlan {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly title: string;
}
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
  /** Same execution domain global. Optional only for legacy non-Run consumers. */
  readGlobal?(): unknown;
  writeGlobal?(value: { schemaVersion: 1; nativeExecutionWriter: 1 }): Promise<void>;
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
  'file-too-large': '文件超过大小上限。',
  'quota-exceeded': '文件数量或总量已达上限。',
  'digest-mismatch': '文件内容与声明的摘要不一致。',
  'upload-timeout': '文件上传超时，请重试。',
  'file-timeout': '文件读取超时，请重试。',
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
    artifacts: record.artifactVersions.map((artifact) => ({
      ...artifact,
      links: [...artifact.links],
      files: artifact.files.map((file) => ({ ...file })),
    })),
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

function receiptOf(record: UploadFileRecord): FileUploadReceipt {
  return {
    uploadId: record.uploadId,
    attachmentId: record.attachmentId,
    name: record.name,
    mediaType: record.mediaType,
    bytes: record.byteSize,
    sha256: record.sha256,
    reference: artifactFileReference(record),
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
  readonly actorId: string;
  /** Echoes the requested scope. Absent when the caller did not send one. */
  readonly spaceId?: string | undefined;
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

function countInbox(
  items: readonly InboxItem[],
): Pick<InboxCounts, 'deliver' | 'review' | 'confirm'> {
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

/**
 * The round was already settled, or the node already reached the outcome of
 * this round. A later ballot replay must not settle again as the current actor.
 */
function settlementLanded(record: ExecutionNodeRecord, roundId: string): boolean {
  const round = record.rounds.find((item) => item.id === roundId);
  if (!round || record.currentRoundId !== roundId) return false;
  const stored = record.command.stored;
  if (Array.isArray(stored) && stored.some((item) => item.idempotencyKey === `settle:${roundId}`)) {
    return true;
  }
  if (round.status === 'approved' && record.command.status === 'completed') return true;
  if (round.status === 'changes-requested' && record.command.status === 'needs-revision') {
    return true;
  }
  return false;
}

function recordedPlan(storage: ExecutionStorage, record: ExecutionNodeRecord): boolean {
  const receipt = storage.readPlan(planKey(record.taskId, record.planId, record.revision));
  if (
    !receipt ||
    typeof receipt.idempotencyKey !== 'string' ||
    receipt.idempotencyKey.length === 0 ||
    typeof receipt.fingerprint !== 'string' ||
    receipt.fingerprint.length === 0 ||
    !Array.isArray(receipt.nodeIds) ||
    !receipt.nodeIds.every((nodeId) => typeof nodeId === 'string' && nodeId.length > 0)
  )
    return false;
  const nodes = new Set(receipt.nodeIds);
  return nodes.size === receipt.nodeIds.length && nodes.has(record.nodeId);
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
  private readonly runLifetime = new AbortController();
  private readonly runChanges = new Set<() => void>();
  private runHost: ExecutionRunHostPorts | undefined;
  private runAuthorities: ExecutionRunAuthorities | undefined;
  private readonly uploadLifetime = new AbortController();
  private readonly uploadDrains = new Set<Promise<void>>();
  private readonly uploadOperations = new Set<Promise<unknown>>();
  private readonly fileLifetime = new AbortController();
  private readonly fileOperations = new Set<Promise<unknown>>();
  private readonly fileReadResources = new Set<{
    readonly spaceId: string;
    readonly drain: Promise<void>;
  }>();
  /** Ephemeral resource reservations; durable file facts still have one queued writer. */
  private readonly pendingUploads = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly spaceId: string;
      readonly nodeKey: string;
      readonly bytes: number;
      readonly newFile: boolean;
    }
  >();

  constructor(
    private readonly storage: ExecutionStorage,
    private readonly workbench: { readWorkbench(): Workbench },
    private readonly projectSpaces: ProjectSpaceDirectory | undefined,
    private readonly attachments?: AttachmentStore,
    private readonly fileStore?: ArtifactFileStore,
  ) {
    this.assertRunStoreCompatibility();
  }

  /** Install once on this owner. A supplies the SAME Host bundle's real member lease issuer. */
  installRunHost(host: ExecutionRunHostPorts): ExecutionRunAuthorities {
    if (
      this.runHost ||
      this.runLifetime.signal.aborted ||
      !host ||
      !(host.signal instanceof AbortSignal) ||
      host.signal.aborted ||
      [
        'memberLease',
        'assertProjectSpace',
        'assertConfiguration',
        'assertWorkspace',
        'onChange',
      ].some((key) => typeof (host as unknown as Record<string, unknown>)[key] !== 'function')
    )
      throw new ExecutionRunError('run-authority-unavailable');
    const migrationOrigin = host.migrationOrigin?.bind(host);
    const migrationDrain = host.migrationDrain?.bind(host);
    const authorities = new ExecutionRunAuthorities({
      writerState: () => this.readRunGlobal(),
      memberLease: (request) => host.memberLease(request),
      readNode: (locator) => this.readRunNode(locator),
      assertNodeAccess: (memberId, spaceId, node, action) => {
        this.assertRunNodeAccess(host, memberId, spaceId, node);
        if (['send', 'queue', 'stop'].includes(action)) this.assertRunController(memberId, node);
      },
      assertWorkspace: (...args) => synchronousRunAssertion(host.assertWorkspace(...args)),
      onChange: (recheck) => {
        const stop = host.onChange(recheck);
        this.runChanges.add(recheck);
        return () => {
          this.runChanges.delete(recheck);
          stop();
        };
      },
      signal: AbortSignal.any([host.signal, this.runLifetime.signal]),
      ...(migrationOrigin ? { migrationOrigin } : {}),
      ...(migrationDrain ? { migrationDrain } : {}),
    });
    this.runHost = host;
    this.runAuthorities = authorities;
    return authorities;
  }

  /** Host-only current facts, copied so a consumer cannot mutate the domain's live row. */
  readRunNode(locator: ExecutionNodeLocator): ExecutionNodeRecord | undefined {
    const parsed = draftReadSchema.parse({
      taskId: locator.taskId,
      planId: locator.planId,
      revision: locator.revision,
      nodeId: locator.nodeId,
    });
    const node = this.storage.readNode(nodeRecordKey(parsed));
    if (!node) return undefined;
    if (
      !intactNode(node) ||
      node.taskId !== parsed.taskId ||
      node.planId !== parsed.planId ||
      node.revision !== parsed.revision ||
      node.nodeId !== parsed.nodeId
    )
      throw new ExecutionRunError('run-state-invalid');
    readExecutionRunState(node);
    return structuredClone(node);
  }

  readRunGlobal(): unknown {
    if (!this.storage.readGlobal) throw new ExecutionRunError('run-authority-unavailable');
    return structuredClone(this.storage.readGlobal());
  }

  readRunComposition(locator: ExecutionRunLocator): FrozenExecutionRunComposition {
    const node = this.readRunNode(locator);
    const run =
      node && readExecutionRunState(node)?.runs.find((item) => item.attempt.id === locator.runId);
    if (!run?.composition) throw new ExecutionRunCompositionError('composition-invalid');
    return readExecutionRunComposition(run.composition);
  }

  /** Host-only preparation for this node's current controller, independent of human inbox items. */
  readRunCompositionInputs(
    request: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<ExecutionRunCompositionInputs>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(runCompositionInputsSchema, body);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return this.withRunMember(
        request,
        input,
        async (host, lease) => {
          const visible = await this.readableRecords(
            [input.spaceId],
            lease.memberId,
            input.spaceId,
          );
          const { node, items } = this.currentRunCompositionInputs(host, lease, input, visible);
          return {
            ok: true,
            value: structuredClone({
              actorId: lease.memberId,
              spaceId: input.spaceId,
              taskId: node.taskId,
              planId: node.planId,
              revision: node.revision,
              nodeId: node.nodeId,
              items,
            }),
          };
        },
        false,
      );
    });
  }

  /** Explicit opt-in only, after guards are installed. Reads and startup never enable it. */
  enableRunWriter(): Promise<ExecutionResult<void>> {
    return this.enqueue(async () => {
      this.requireRunHost();
      if (!this.storage.writeGlobal) throw new ExecutionRunError('run-authority-unavailable');
      await enableExecutionRunWriter(
        () => this.readRunGlobal(),
        (next) => this.storage.writeGlobal!(next),
        this.storage.listNodes(),
      );
      return { ok: true, value: undefined };
    });
  }

  /** Commit only. A runs a returned effect AFTER awaiting success, outside this queue. */
  beginRun(request: MemberRequest, body: unknown): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.enqueue(() => this.beginRunNow(request, body, false));
  }

  /** Normal explicit first start: authenticate all facts before the first global write. */
  startRun(request: MemberRequest, body: unknown): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.enqueue(() => this.beginRunNow(request, body, true));
  }

  private async beginRunNow(
    request: MemberRequest,
    body: unknown,
    enableWriter: boolean,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    // The snapshot's scope is data to compare against the real lease below,
    // not an actor assignment. All other command fields keep the old scan.
    const commandFields =
      body && typeof body === 'object' && !Array.isArray(body)
        ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'composition'))
        : body;
    const actorField = this.actorField(commandFields);
    if (actorField) return actorField;
    const parsed = parseBody(beginRunSchema, body);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    return this.withRunMember(
      request,
      input,
      async (host, lease, initial) => {
        let node = initial;
        const verify = async () => {
          this.requireRunHost();
          lease.assertCurrent(input.spaceId);
          const visible = await this.readableRecords(
            [input.spaceId],
            lease.memberId,
            input.spaceId,
          );
          const fresh = this.currentRunCompositionInputs(host, lease, input, visible);
          node = fresh.node;
          const state = readExecutionRunState(node);
          const prior = state?.receipts.find((receipt) => receipt.requestId === input.requestId);
          const generation = prior
            ? state!.runs.find((run) => run.attempt.id === prior.runId)!.attempt.generation
            : (state?.runs.length ?? 0) + 1;
          const { configurationId: _configuration, ...model } = input.selection;
          const executor = input.composition.payload.executor;
          assertExecutionRunComposition(
            input.composition,
            {
              workbench: this.workbench.readWorkbench(),
              node,
              scope: {
                actorId: lease.memberId,
                spaceId: input.spaceId,
                taskId: node.taskId,
                planId: node.planId,
                revision: node.revision,
                nodeId: node.nodeId,
                runId: input.newRunId,
                generation,
                segmentId: input.newSegmentId,
              },
              model,
              executor:
                executor.kind === 'builtin'
                  ? { kind: 'builtin' }
                  : { kind: 'plan-expert', ref: executor.ref },
              tools: input.composition.payload.tools,
              inputs: {
                actorId: lease.memberId,
                spaceId: input.spaceId,
                taskId: node.taskId,
                planId: node.planId,
                revision: node.revision,
                nodeId: node.nodeId,
                items: fresh.items,
              },
            },
            input,
          );
          synchronousRunAssertion(
            host.assertConfiguration(lease.memberId, input.spaceId, node, input),
          );
          synchronousRunAssertion(
            host.assertWorkspace(
              lease.memberId,
              input.spaceId,
              input.workspace,
              input.workspace.kind === 'local' ? input.workspace.access : 'read',
              input.selection.configurationId,
            ),
          );
          validateExecutionRunBegin(
            node,
            this.runInput(input, lease.memberId),
            this.storage.listNodes(),
            {
              expertEnabled: true,
              executorConnected: true,
            },
          );
        };
        await verify();
        if (enableWriter) {
          if (!this.storage.writeGlobal) throw new ExecutionRunError('run-authority-unavailable');
          await enableExecutionRunWriter(
            () => this.readRunGlobal(),
            (next) => this.storage.writeGlobal!(next),
            this.storage.listNodes(),
          );
          await verify();
        }
        const decision = beginExecutionRun(
          node,
          this.runInput(input, lease.memberId),
          this.storage.listNodes(),
          { expertEnabled: true, executorConnected: true, writerState: this.readRunGlobal() },
        );
        lease.assertCurrent(input.spaceId);
        return this.commitRunDecision(decision);
      },
      !enableWriter,
    );
  }

  stopRun(request: MemberRequest, body: unknown): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(stopRunSchema, body);
      if (!parsed.ok) return parsed;
      return this.withRunMember(request, parsed.value, async (_host, lease, node) => {
        const { spaceId, ...input } = parsed.value;
        const run = currentExecutionRun(node);
        if (!run || run.spaceId !== spaceId || run.actorId !== lease.memberId)
          throw new ExecutionRunError('run-authority-denied');
        const decision = requestExecutionRunStop(node, this.runInput(input, lease.memberId));
        lease.assertCurrent(spaceId);
        return this.commitRunDecision(decision);
      });
    });
  }

  /** Native bridge only: require a capability issued by THIS owner, never a Client envelope. */
  recordRunEvent(
    locator: ExecutionNodeLocator,
    event: ExecutionRunEvent,
    authority: RunEventAuthority,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.enqueue(async () => {
      requireExecutionRunWriter(this.readRunGlobal());
      const manager = this.runAuthorities;
      if (!manager) throw new ExecutionRunError('run-authority-unavailable');
      const node = this.readRunNode(locator);
      if (!node || !recordedPlan(this.storage, node))
        throw new ExecutionRunError('run-authority-denied');
      const state = readExecutionRunState(node);
      const run = state?.runs.find((item) => item.attempt.id === event.runId);
      if (!run) throw new ExecutionRunError('run-scope-mismatch');
      const capability = 'grant' in authority ? authority.grant : authority.cleanup;
      if (canonicalPayload(capability.scope) !== canonicalPayload(executionRunScope(node, run)))
        throw new ExecutionRunError('run-scope-mismatch');
      // `stop` is permitted by drive grants even while stopping, and denied by
      // read grants. Checking only `open` would let a history reader emit events.
      if ('grant' in authority) manager.assertGrant(authority.grant, 'stop');
      else {
        if (!['failed', 'stop-pending', 'stopped', 'cleanup'].includes(event.kind))
          throw new ExecutionRunError('run-authority-denied');
        manager.assertCleanup(
          authority.cleanup,
          event.kind as 'failed' | 'stop-pending' | 'stopped' | 'cleanup',
        );
      }
      return this.commitRunDecision(recordExecutionRunEvent(node, event));
    });
  }

  /** Fence driving first. A may still commit capability-checked cleanup during native drain. */
  fenceRuns(): void {
    this.runLifetime.abort();
    this.runAuthorities?.fence();
  }

  /** Call only after the native owner drained and its cleanup facts committed. */
  async closeRuns(): Promise<void> {
    this.fenceRuns();
    await this.writes;
    await this.runAuthorities?.close();
  }

  private requireRunHost(): ExecutionRunHostPorts {
    const host = this.runHost;
    if (!host || host.signal.aborted || this.runLifetime.signal.aborted)
      throw new ExecutionRunError('run-authority-unavailable');
    return host;
  }

  private assertRunNodeAccess(
    host: ExecutionRunHostPorts,
    memberId: string,
    spaceId: string,
    node: ExecutionNodeRecord,
  ): void {
    const workbench = this.workbench.readWorkbench();
    const task = workbench.tasks.find((item) => item.id === node.taskId);
    if (
      !task ||
      !workbench.participants.some(
        (item) => item.id === memberId && item.kind === 'human' && item.available,
      ) ||
      planMembership(workbench, node.taskId, memberId) !== 'allowed' ||
      !recordedPlan(this.storage, node)
    )
      throw new ExecutionRunError('run-authority-denied');
    synchronousRunAssertion(host.assertProjectSpace(task.projectId, spaceId));
    this.assertRunRecordedPlan(workbench, node);
  }

  /** A receipt must certify the exact complete plan, not just exist at its storage key. */
  private assertRunRecordedPlan(workbench: Workbench, node: ExecutionNodeRecord): void {
    let expected: string[];
    try {
      expected = createNodeHandoffs(createExecutionHandoff(node, workbench)).map(
        (handoff) => handoff.nodeId,
      );
    } catch {
      throw new ExecutionRunError('run-authority-denied');
    }
    const receipt = this.storage.readPlan(planKey(node.taskId, node.planId, node.revision));
    const nodes = new Set(receipt?.nodeIds);
    if (
      receipt?.fingerprint !==
        canonicalPayload({ taskId: node.taskId, planId: node.planId, revision: node.revision }) ||
      expected.length === 0 ||
      nodes.size !== expected.length ||
      !expected.every((nodeId) => {
        if (!nodes.has(nodeId)) return false;
        const record = this.storage.readNode(nodeRecordKey({ ...node, nodeId }));
        return (
          record !== undefined &&
          intactNode(record) &&
          samePlan(record, node.taskId, node.planId, node.revision) &&
          record.nodeId === nodeId &&
          record.handoff.nodeId === nodeId &&
          record.handoff.taskId === node.taskId &&
          record.handoff.workflowVersionId === node.planId &&
          record.handoff.revision === node.revision
        );
      })
    )
      throw new ExecutionRunError('run-authority-denied');
  }

  private assertRunController(memberId: string, node: ExecutionNodeRecord): void {
    const task = this.workbench.readWorkbench().tasks.find((item) => item.id === node.taskId);
    const controller =
      node.handoff.assignee.kind === 'human'
        ? node.handoff.assignee.id
        : node.ownerId === task?.ownerId
          ? node.ownerId
          : undefined;
    if (controller !== memberId) throw new ExecutionRunError('run-not-controller');
  }

  private async withRunMember<T>(
    request: MemberRequest,
    input: ExecutionNodeLocator & { spaceId: string },
    work: (
      host: ExecutionRunHostPorts,
      lease: ExecutionMemberLease,
      node: ExecutionNodeRecord,
    ) => Promise<ExecutionResult<T>>,
    requireWriter = true,
  ): Promise<ExecutionResult<T>> {
    const host = this.requireRunHost();
    if (requireWriter) requireExecutionRunWriter(this.readRunGlobal());
    else this.assertRunStoreCompatibility();
    let lease: ExecutionMemberLease;
    try {
      lease = await host.memberLease(request);
    } catch {
      throw new ExecutionRunError('run-authority-denied');
    }
    try {
      this.requireRunHost();
      if (
        !lease ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= Date.now() ||
        lease.signal.aborted
      )
        throw new ExecutionRunError('run-authority-denied');
      lease.assertCurrent(input.spaceId);
      const node = this.readRunNode(input);
      if (!node) throw new ExecutionRunError('run-authority-denied');
      this.assertRunNodeAccess(host, lease.memberId, input.spaceId, node);
      this.assertRunController(lease.memberId, node);
      return await work(host, lease, node);
    } catch (error) {
      if (
        error instanceof ExecutionRunError ||
        error instanceof ExecutionRunProtocolError ||
        error instanceof ExecutionRunCompositionError
      )
        throw error;
      throw new ExecutionRunError('run-authority-denied');
    } finally {
      try {
        lease?.release();
      } catch {
        // A release failure cannot turn a durable commit into a retryable write failure.
        this.fenceRuns();
      }
    }
  }

  private currentRunCompositionInputs(
    host: ExecutionRunHostPorts,
    lease: ExecutionMemberLease,
    input: ExecutionNodeLocator & { spaceId: string },
    visible: ExecutionNodeRecord[] | ExecutionResult<never>,
  ): { node: ExecutionNodeRecord; items: UpstreamInputView[] } {
    if (!Array.isArray(visible)) throw new ExecutionRunError('run-authority-unavailable');
    this.requireRunHost();
    lease.assertCurrent(input.spaceId);
    const node = this.readRunNode(input);
    if (!node) throw new ExecutionRunError('run-authority-denied');
    this.assertRunNodeAccess(host, lease.memberId, input.spaceId, node);
    this.assertRunController(lease.memberId, node);
    if (
      !visible.some(
        (record) =>
          samePlan(record, node.taskId, node.planId, node.revision) &&
          record.nodeId === node.nodeId,
      )
    )
      throw new ExecutionRunError('run-authority-denied');

    // A directory lookup awaited later in the scan may outlive an earlier source row.
    // Re-read only same-plan refs synchronously, after the final task/space/controller gate.
    const refs = new Set(node.handoff.inputRefs.map((ref) => ref.sourceNodeId.trim()));
    const sources = visible
      .filter(
        (record) =>
          samePlan(record, node.taskId, node.planId, node.revision) && refs.has(record.nodeId),
      )
      .flatMap((record) => {
        const current = this.readRunNode(record);
        return current ? [current] : [];
      });
    return { node, items: upstreamInputsFor(node, sources) };
  }

  private runInput<T extends ExecutionNodeLocator>(input: T, actorId: string) {
    const { taskId: _task, planId: _plan, revision: _revision, nodeId: _node, ...fields } = input;
    return { ...fields, actorId };
  }

  private async commitRunDecision(
    decision: ExecutionRunDecision,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    if (decision.disposition === 'applied') {
      const stored = await this.persist(() => this.writeNode(decision.record, true));
      if (!stored.ok) return stored;
    }
    return { ok: true, value: structuredClone(decision) };
  }

  private assertRunStoreCompatibility(): void {
    const nodes = this.storage.listNodes();
    assertExecutionRunStoreCompatibility(
      this.storage.readGlobal ? this.storage.readGlobal() : { schemaVersion: 1 },
      nodes,
    );
    for (const node of nodes) readExecutionRunState(node);
  }

  /** Every old writer passes here in the original queue. Never drop native metadata. */
  private async writeNode(record: ExecutionNodeRecord, native = false): Promise<void> {
    assertExecutionRunStoreCompatibility(
      this.storage.readGlobal ? this.storage.readGlobal() : { schemaVersion: 1 },
      [record],
    );
    readExecutionRunState(record);
    const current = this.storage.readNode(nodeRecordKey(record));
    if (current && !native) {
      assertExecutionRunQuiescent(current);
      if (
        canonicalPayload(readExecutionRunState(current) ?? null) !==
        canonicalPayload(readExecutionRunState(record) ?? null)
      )
        throw new ExecutionRunError('run-state-invalid');
    }
    await this.storage.writeNode(nodeRecordKey(record), record);
    for (const recheck of this.runChanges) {
      try {
        recheck();
      } catch {
        /* A notification cannot undo a durable commit. */
      }
    }
  }

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
      return {
        ok: true,
        value: {
          actorId: opened.actorId,
          ...(opened.scope === undefined ? {} : { spaceId: opened.scope }),
          items: opened.items,
          nodes: opened.nodes,
          places: opened.items.map((item) => inboxPlace(workbench, item)),
        },
      };
    });
  }

  /**
   * Counts for a shortcut. The next read follows the current node status.
   * `actorId` and a requested `spaceId` are echoes, not a grant.
   */
  inboxCounts(caller: ExecutionCaller, body: unknown): Promise<ExecutionResult<InboxCounts>> {
    return this.enqueue(async () => {
      const opened = await this.openInbox(caller, body);
      if (!opened.ok) return opened;
      return {
        ok: true,
        value: {
          actorId: opened.actorId,
          ...(opened.scope === undefined ? {} : { spaceId: opened.scope }),
          ...countInbox(opened.items),
        },
      };
    });
  }

  /**
   * Events after a cursor. A requested scope is checked before the node is
   * read or an unlock is repaired. Seen ids are dropped inside that one node.
   */
  events(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<
    ExecutionResult<{
      readonly actorId: string;
      readonly spaceId?: string | undefined;
      readonly taskId: string;
      readonly planId: string;
      readonly revision: number;
      readonly nodeId: string;
      readonly events: readonly ExecutionEvent[];
    }>
  > {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(eventsSchema, body);
      if (!parsed.ok) return parsed;
      const scope = parsed.value.spaceId;
      const space = await this.gateSpaceScoped(parsed.value.taskId, actor.value.spaceIds, scope);
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
          actorId: actor.value.actorId,
          ...(scope === undefined ? {} : { spaceId: scope }),
          taskId: parsed.value.taskId,
          planId: parsed.value.planId,
          revision: parsed.value.revision,
          nodeId: parsed.value.nodeId,
          events: page.flatMap((event) => {
            const published = publishExecutionEvent(event);
            return published ? [published] : [];
          }),
        },
      };
    });
  }

  /**
   * Confirmed plans this member may explicitly start. A task qualifies when it
   * is `ready`, the member owns or participates in it, the trusted directory
   * places its project in a space the member belongs to, and its latest
   * applied plan has not been started yet. No directory, an unknown project,
   * or a mismatched space hides the task; a directory failure is unavailable.
   */
  startable(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ actorId: string; plans: readonly StartablePlan[] }>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(startableSchema.optional(), body ?? {});
      if (!parsed.ok) return parsed;
      if (!this.projectSpaceDirectory()) return fail('not-found');
      const scope = parsed.value?.spaceId;
      if (!this.scopeHeld(actor.value.spaceIds, scope)) {
        return {
          ok: true,
          value: {
            actorId: actor.value.actorId,
            ...(scope === undefined ? {} : { spaceId: scope }),
            plans: [],
          },
        };
      }
      const workbench = this.workbench.readWorkbench();
      const plans: StartablePlan[] = [];
      for (const task of workbench.tasks) {
        if (task.status !== 'ready') continue;
        if (planMembership(workbench, task.id, actor.value.actorId) !== 'allowed') continue;
        const space = await this.gateSpaceScoped(task.id, actor.value.spaceIds, scope);
        if (space === 'missing') continue;
        if (!space.ok) {
          if (space.error.code === 'unavailable') return space;
          continue;
        }
        const applied = workbench.appliedPlans
          .filter((plan) => plan.taskId === task.id)
          .sort((a, b) => b.revision - a.revision)[0];
        if (applied === undefined) continue;
        if (this.storage.readPlan(planKey(task.id, applied.id, applied.revision)) !== undefined) {
          continue;
        }
        plans.push({
          taskId: task.id,
          planId: applied.id,
          revision: applied.revision,
          title: task.title,
        });
      }
      return {
        ok: true,
        value: {
          actorId: actor.value.actorId,
          ...(scope === undefined ? {} : { spaceId: scope }),
          plans,
        },
      };
    });
  }

  submit(caller: ExecutionCaller, body: unknown, fileAuthority?: ExecutionFileAuthoritySource) {
    if (
      this.attachments &&
      this.fileStore &&
      body &&
      typeof body === 'object' &&
      Array.isArray((body as { files?: unknown }).files) &&
      (body as { files: unknown[] }).files.length
    )
      return this.submitFiles(caller, body, fileAuthority);
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

  private submitFiles(
    caller: ExecutionCaller,
    body: unknown,
    source: ExecutionFileAuthoritySource | undefined,
  ) {
    const actorField = this.actorField(body);
    if (actorField) return Promise.resolve(actorField);
    const parsed = parseBody(submitSchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    const input = parsed.value;
    const keyed = draftKeyLimit(input.idempotencyKey);
    if (keyed) return Promise.resolve(keyed);
    return this.withFileAuthority(caller, body, source, async (actor, authority) => {
      const submit = (record: ExecutionNodeRecord, files: ArtifactFileRef[]) =>
        submitDelivery({
          record,
          actorId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
          expectedVersion: input.expectedVersion,
          draft: {
            files,
            links: input.links ?? [],
            ...(input.text === undefined ? {} : { text: input.text }),
          },
          artifactId: `artifact:${input.idempotencyKey}`,
          roundId: `round:${input.idempotencyKey}`,
        });
      const space = await this.gateSpace(input.taskId, actor.spaceIds);
      if (space === 'missing' || !space.ok)
        return fail(space === 'missing' ? 'not-found' : space.error.code);
      const task = this.workbench.readWorkbench().tasks.find((item) => item.id === input.taskId);
      if (!task) return fail('not-found');
      const admission = await this.enqueue(async () => {
        const node = this.assertFileNode(
          authority,
          actor.actorId,
          input,
          task.projectId,
          space.value,
        );
        assertExecutionRunQuiescent(node);
        const bound = this.boundFileReferences(input.files ?? [], node, space.value, actor.actorId);
        const proposal = submit(node, bound.files);
        if (!proposal.ok) return fail(proposal.code);
        return {
          ok: true,
          value: {
            nodeSnapshot: canonicalPayload(node),
            projectId: task.projectId,
            spaceId: space.value,
            ...bound,
          },
        };
      });
      if (!admission.ok) return admission;
      const state = admission.value;
      let commitSnapshot: string | undefined;
      const guard = (current: ExecutionNodeRecord) => {
        const fresh = this.assertFileNode(
          authority,
          actor.actorId,
          input,
          state.projectId,
          state.spaceId,
        );
        const freshSnapshot = canonicalPayload(fresh);
        if (
          freshSnapshot !== canonicalPayload(current) ||
          (commitSnapshot !== undefined && freshSnapshot !== commitSnapshot)
        )
          throw new ArtifactUploadError('conflict');
        if (freshSnapshot !== state.nodeSnapshot) {
          const replay = submit(fresh, state.files);
          if (!replay.ok || replay.disposition !== 'replayed')
            throw new ArtifactUploadError('conflict');
        }
        commitSnapshot ??= freshSnapshot;
        const bound = this.boundFileReferences(
          input.files ?? [],
          fresh,
          state.spaceId,
          actor.actorId,
        );
        if (canonicalPayload(bound.records) !== canonicalPayload(state.records))
          throw new ArtifactUploadError('not-found');
      };
      // SDK byte verification is outside the only command queue. The resulting
      // preparation is never a grant: every final write rechecks its live source.
      for (const record of state.records)
        await this.verifyFileBytes(
          record,
          authority,
          () =>
            this.assertFileNode(authority, actor.actorId, input, state.projectId, state.spaceId),
          false,
        );
      return this.enqueue(() =>
        this.command(
          caller,
          { ...input, files: state.files },
          submitSchema,
          (_actor, request, record) => ({
            result: submit(record, request.files ?? []),
            settle: false,
          }),
          'delivery-submitted',
          true,
          guard,
        ),
      );
    });
  }

  private withFileAuthority<T>(
    caller: ExecutionCaller,
    body: unknown,
    source: ExecutionFileAuthoritySource | undefined,
    work: (
      actor: { actorId: string; spaceIds: readonly string[] },
      authority: ExecutionFileAuthority,
    ) => Promise<ExecutionResult<T>>,
    retainLeaseOnSuccess = false,
  ): Promise<ExecutionResult<T>> {
    const operation = (async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      if (typeof source !== 'function') return fail('unauthenticated');
      let authority: ExecutionFileAuthority | undefined;
      let transferred = false;
      try {
        if (this.fileLifetime.signal.aborted) return fail('cancelled');
        authority = await source();
        if (
          !authority ||
          authority.lease?.memberId !== actor.value.actorId ||
          !(authority.lease.signal instanceof AbortSignal) ||
          typeof authority.assertProjectSpace !== 'function'
        )
          return fail('unauthenticated');
        const result = await work(actor.value, authority);
        transferred = retainLeaseOnSuccess && result.ok;
        return result;
      } catch (error) {
        return fail(
          error instanceof ArtifactUploadError || error instanceof WorkbenchError
            ? error.code
            : 'unavailable',
        );
      } finally {
        if (!transferred) authority?.lease.release();
      }
    })();
    this.fileOperations.add(operation);
    void operation.then(
      () => this.fileOperations.delete(operation),
      () => this.fileOperations.delete(operation),
    );
    return operation;
  }

  private assertFileAuthority(
    authority: ExecutionFileAuthority,
    actorId: string,
    projectId: string,
    spaceId: string,
  ): void {
    const lease = authority.lease;
    if (this.fileLifetime.signal.aborted || lease.signal.aborted)
      throw new ArtifactUploadError('cancelled');
    if (
      lease.memberId !== actorId ||
      !Number.isFinite(lease.expiresAt) ||
      Date.now() >= lease.expiresAt
    )
      throw new ArtifactUploadError('unauthenticated');
    try {
      for (const result of [
        lease.assertCurrent(spaceId),
        authority.assertProjectSpace(projectId, spaceId),
      ]) {
        const checked: unknown = result;
        if (checked !== undefined) {
          void Promise.resolve(checked).catch(() => undefined);
          throw new Error('A current file authority must decide synchronously.');
        }
      }
    } catch {
      throw new ArtifactUploadError('not-found');
    }
  }

  private assertFileRecord(
    authority: ExecutionFileAuthority,
    actorId: string,
    locator: { taskId: string; planId: string; revision: number; nodeId: string },
    projectId: string,
    spaceId: string,
  ): ExecutionNodeRecord {
    this.assertFileAuthority(authority, actorId, projectId, spaceId);
    const workbench = this.workbench.readWorkbench();
    const task = workbench.tasks.find((item) => item.id === locator.taskId);
    if (
      !task ||
      task.projectId !== projectId ||
      !this.directory().includes(actorId) ||
      planMembership(workbench, locator.taskId, actorId) !== 'allowed'
    )
      throw new ArtifactUploadError('not-found');
    return this.currentFileNode(locator);
  }

  /** Read the exact current node without cloning its whole artifact history per byte chunk. */
  private currentFileNode(locator: {
    taskId: string;
    planId: string;
    revision: number;
    nodeId: string;
  }): ExecutionNodeRecord {
    const node = this.storage.readNode(nodeRecordKey(locator));
    if (
      !node ||
      !intactNode(node) ||
      !samePlan(node, locator.taskId, locator.planId, locator.revision) ||
      node.nodeId !== locator.nodeId ||
      !recordedPlan(this.storage, node)
    )
      throw new ArtifactUploadError('not-found');
    try {
      readExecutionRunState(node);
    } catch {
      throw new ArtifactUploadError('not-found');
    }
    return node;
  }

  private assertFileNode(
    authority: ExecutionFileAuthority,
    actorId: string,
    locator: { taskId: string; planId: string; revision: number; nodeId: string },
    projectId: string,
    spaceId: string,
  ): ExecutionNodeRecord {
    const node = this.assertFileRecord(authority, actorId, locator, projectId, spaceId);
    if (node.handoff.assignee.kind !== 'human' || node.handoff.assignee.id !== actorId)
      throw new ArtifactUploadError('not-assignee');
    return node;
  }

  private boundFileReferences(
    files: readonly ArtifactFileRef[],
    node: ExecutionNodeRecord,
    spaceId: string,
    memberId: string,
  ): { records: UploadFileRecord[]; files: ArtifactFileRef[] } {
    if (!this.fileStore || !this.attachments) throw new ArtifactUploadError('files-not-accepted');
    if (
      files.length > ARTIFACT_FILE_LIMITS.maxFilesPerSubmission ||
      new Set(files.map((file) => file.id)).size !== files.length
    )
      throw new ArtifactUploadError('validation');
    const records = files.map((file) => {
      const record = this.fileStore!.get(file.id);
      if (
        !record ||
        record.uploadedBy !== memberId ||
        record.spaceId !== spaceId ||
        record.taskId !== node.taskId ||
        record.planId !== node.planId ||
        record.revision !== node.revision ||
        record.nodeId !== node.nodeId ||
        !matchesArtifactFileReference(file, record)
      )
        throw new ArtifactUploadError('not-found');
      return { ...record };
    });
    if (
      records.reduce((sum, record) => sum + record.byteSize, 0) > ARTIFACT_FILE_LIMITS.maxNodeBytes
    )
      throw new ArtifactUploadError('quota-exceeded');
    return { records, files: records.map(artifactFileReference) };
  }

  private async verifyFileBytes(
    record: UploadFileRecord,
    authority: ExecutionFileAuthority,
    assertCurrent: () => unknown,
    collect: boolean,
  ): Promise<{ bytes: Uint8Array | undefined; release(): void }> {
    return this.verifyOwnedFileBytes(
      record,
      AbortSignal.any([authority.lease.signal, this.fileLifetime.signal]),
      assertCurrent,
      collect,
    );
  }

  /** Same physical quota/drain for human reads and the Host-only Run consumer. */
  private async verifyOwnedFileBytes(
    record: UploadFileRecord,
    signal: AbortSignal,
    assertCurrent: () => unknown,
    collect: boolean,
    drainBeforeReject = false,
  ): Promise<{ bytes: Uint8Array | undefined; release(): void }> {
    if (!this.attachments) throw new ArtifactUploadError('unavailable');
    if (
      [...this.fileReadResources].filter((item) => item.spaceId === record.spaceId).length >=
      ARTIFACT_FILE_LIMITS.maxConcurrentReadsPerSpace
    )
      throw new ArtifactUploadError('quota-exceeded');
    const read = readVerifiedArtifactFile({
      attachments: this.attachments,
      record,
      signal,
      assertCurrent: () => {
        assertCurrent();
      },
      collect,
    });
    let resolveRelease!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const release = () => {
      resolveRelease();
    };
    const resource = {
      spaceId: record.spaceId,
      drain: Promise.all([read.drain, released]).then(() => undefined),
    };
    this.fileReadResources.add(resource);
    signal.addEventListener('abort', release, { once: true });
    if (!collect || signal.aborted) release();
    void resource.drain.then(() => {
      signal.removeEventListener('abort', release);
      this.fileReadResources.delete(resource);
    });
    try {
      return { bytes: await read.result, release };
    } catch (error) {
      release();
      if (drainBeforeReject) await resource.drain;
      throw error;
    }
  }

  sealFileReads(): void {
    this.fileLifetime.abort();
  }
  async closeFileReads(): Promise<void> {
    this.sealFileReads();
    while (this.fileOperations.size) await Promise.allSettled([...this.fileOperations]);
    while (this.fileReadResources.size)
      await Promise.all([...this.fileReadResources].map((item) => item.drain));
  }

  /** Host-only factory: the original installed issuer, not a structural grant, authorizes. */
  createRunAcceptedFiles(
    issuer: ExecutionRunAuthorities,
    resources: NativeRunFileResourceSource,
  ): NativeRunAcceptedFiles {
    const host = this.requireRunHost();
    const attachments = this.attachments;
    const files = this.fileStore;
    if (
      issuer !== this.runAuthorities ||
      !attachments ||
      !files ||
      !(resources?.signal instanceof AbortSignal) ||
      typeof resources.assertCurrent !== 'function'
    )
      throw new ArtifactUploadError('unavailable');
    const assertCurrent = (grant: NativeWorkGrant, signal: AbortSignal) => {
      if (issuer !== this.runAuthorities || host !== this.requireRunHost())
        throw new ArtifactUploadError('unavailable');
      issuer.assertGrant(grant, 'send');
      if (signal.aborted || resources.signal.aborted || this.fileLifetime.signal.aborted)
        throw new ArtifactUploadError('cancelled');
      if (attachments !== this.attachments || files !== this.fileStore)
        throw new ArtifactUploadError('unavailable');
      const result: unknown = resources.assertCurrent(attachments);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        throw new ArtifactUploadError('unavailable');
      }
    };
    const operation = <T>(work: () => Promise<T>): Promise<T> => {
      const pending = Promise.resolve()
        .then(work)
        .catch((error: unknown) => {
          if (error instanceof ArtifactUploadError || error instanceof ExecutionRunError)
            throw error;
          throw new ArtifactUploadError('unavailable');
        });
      this.fileOperations.add(pending);
      void pending.then(
        () => this.fileOperations.delete(pending),
        () => this.fileOperations.delete(pending),
      );
      return pending;
    };
    const begin = (grant: NativeWorkGrant, caller: AbortSignal) => {
      // Check issuer identity before inspecting any claimed scope/signal.
      issuer.assertGrant(grant, 'send');
      if (!(caller instanceof AbortSignal)) throw new ArtifactUploadError('invalid-request');
      const signal = AbortSignal.any([
        caller,
        grant.signal,
        resources.signal,
        host.signal,
        this.fileLifetime.signal,
        this.runLifetime.signal,
      ]);
      assertCurrent(grant, signal);
      return signal;
    };
    const capture = (grant: NativeWorkGrant, inputRef: string, signal: AbortSignal) => {
      assertCurrent(grant, signal);
      const initial = this.currentRunFileInput(grant, inputRef, host);
      const fingerprint = canonicalPayload(initial);
      const check = () => {
        assertCurrent(grant, signal);
        if (canonicalPayload(this.currentRunFileInput(grant, inputRef, host)) !== fingerprint)
          throw new ArtifactUploadError('not-found');
        assertCurrent(grant, signal);
      };
      return { ...initial, check };
    };
    return Object.freeze({
      list: (grant, raw, caller) =>
        operation(async () => {
          const signal = begin(grant, caller);
          const query = runFileListSchema.safeParse(raw);
          if (!query.success) throw new ArtifactUploadError('invalid-request');
          const state = capture(grant, query.data.inputRef, signal);
          const value = {
            ...structuredClone(state.source),
            files: state.infos.map((file) => ({ ...file })),
          };
          if (Buffer.byteLength(JSON.stringify(value)) > 24_576)
            throw new ArtifactUploadError('output-too-large');
          state.check();
          return { ...value, check: state.check };
        }),
      read: (grant, raw, caller) =>
        operation(async () => {
          const signal = begin(grant, caller);
          const query = runFileReadSchema.safeParse(raw);
          if (!query.success) throw new ArtifactUploadError('invalid-request');
          const { inputRef, fileId, offset, length } = query.data;
          const state = capture(grant, inputRef, signal);
          const index = state.records.findIndex((record) => record.uploadId === fileId);
          const record = state.records[index];
          const info = state.infos[index];
          if (!record || !info) throw new ArtifactUploadError('not-found');
          if (offset > record.byteSize) throw new ArtifactUploadError('invalid-request');
          let owned: { bytes: Uint8Array | undefined; release(): void } | undefined;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            signal.removeEventListener('abort', release);
            owned?.release();
            owned = undefined;
          };
          signal.addEventListener('abort', release, { once: true });
          try {
            owned = await this.verifyOwnedFileBytes(record, signal, state.check, true, true);
            state.check();
            if (released || !owned.bytes) throw new ArtifactUploadError('cancelled');
            const bytes = owned.bytes.slice(offset, Math.min(offset + length, record.byteSize));
            const encoding = runFileEncoding(info, owned.bytes);
            state.check();
            return {
              source: { ...structuredClone(state.source), file: { ...info } },
              range: { offset, length: bytes.length, total: record.byteSize },
              bytes,
              encoding,
              signal,
              check() {
                if (released) throw new ArtifactUploadError('cancelled');
                state.check();
              },
              release,
            };
          } catch (error) {
            // An abort may have happened before the pending read returned its handle.
            owned?.release();
            release();
            throw error;
          }
        }),
    } satisfies NativeRunAcceptedFiles);
  }

  /** Current authoritative fixed objects; no human-assignee or caller impersonation. */
  private currentRunFileInput(
    grant: NativeWorkGrant,
    inputRef: string,
    host: ExecutionRunHostPorts,
  ): { source: NativeRunFileSource; infos: NativeRunFileInfo[]; records: UploadFileRecord[] } {
    if (!this.fileStore) throw new ArtifactUploadError('unavailable');
    const scope = grant.scope;
    const node = this.currentFileNode(scope);
    this.assertRunNodeAccess(host, scope.actorId, scope.spaceId, node);
    const snapshot = this.readRunComposition(scope);
    const saved = snapshot.payload;
    const allowed: readonly string[] = saved.toolAllowlist;
    if (
      !allowed.includes(NATIVE_ACCEPTED_FILE_TOOL) ||
      canonicalPayload(saved.scope) !== canonicalPayload(scope) ||
      canonicalPayload(saved.handoff) !== canonicalPayload(node.handoff) ||
      saved.contextRefs.length !== saved.inputs.length ||
      saved.contextRefs.filter((ref) => ref === inputRef).length !== 1
    )
      throw new ArtifactUploadError('not-found');
    const input = saved.inputs[saved.contextRefs.indexOf(inputRef)];
    if (
      !input ||
      !(node.handoff.inputRefs ?? []).some(
        (ref) =>
          ref.sourceNodeId === input.sourceNodeId &&
          ref.artifactVersionId === input.artifactVersionId,
      )
    )
      throw new ArtifactUploadError('not-found');
    const upstream = this.currentFileNode({ ...scope, nodeId: input.sourceNodeId });
    this.assertRunNodeAccess(host, scope.actorId, scope.spaceId, upstream);
    const artifact = upstream.artifactVersions.find(
      (version) => version.id === input.artifactVersionId,
    );
    if (
      upstream.acceptedArtifactVersionId !== input.artifactVersionId ||
      !artifact ||
      artifact.version !== input.version ||
      artifact.files.length > ARTIFACT_FILE_LIMITS.maxFilesPerSubmission ||
      new Set(artifact.files.map((file) => file.id)).size !== artifact.files.length
    )
      throw new ArtifactUploadError('not-found');
    const records = artifact.files.map((file) => {
      const record = this.fileStore!.get(file.id);
      if (
        !record ||
        record.spaceId !== scope.spaceId ||
        record.taskId !== scope.taskId ||
        record.planId !== scope.planId ||
        record.revision !== scope.revision ||
        record.nodeId !== upstream.nodeId ||
        !matchesArtifactFileReference(file, record)
      )
        throw new ArtifactUploadError('not-found');
      return { ...record };
    });
    const infos = records.map((record) => ({
      fileId: record.uploadId,
      name: artifactFileLeaf(record.name),
      mediaType: record.mediaType,
      bytes: record.byteSize,
      sha256: record.sha256,
    }));
    return {
      source: {
        scope: structuredClone(scope),
        inputRef,
        sourceNodeId: upstream.nodeId,
        artifactVersionId: artifact.id,
        version: artifact.version,
      },
      infos,
      records,
    };
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
      const space = await this.gateSpaceScoped(
        parsed.value.taskId,
        actor.value.spaceIds,
        parsed.value.spaceId,
      );
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
  draft(
    caller: ExecutionCaller,
    body: unknown,
    fileAuthority?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionResult<DeliveryDraftView>> {
    if (this.attachments && this.fileStore) {
      const actor = this.actor(caller, body);
      if (!actor.ok) return Promise.resolve(actor);
      if (this.isFileDraft(body)) return this.fileDraft(caller, body, fileAuthority);
    }
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
      assertExecutionRunQuiescent(current);
      const text = parsed.value.text ?? '';
      const links = parsed.value.links ?? [];
      const files = draftFiles(parsed.value.files ?? []);
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
          this.writeNode({
            ...current,
            deliveryDraft: applied.draft,
          }),
        );
        if (!stored.ok) return stored;
      }
      return { ok: true, value: deliveryDraftView(applied.draft) };
    });
  }

  private isFileDraft(body: unknown): boolean {
    const writing = body !== null && typeof body === 'object' && 'idempotencyKey' in body;
    const parsed = (writing ? draftWriteSchema : draftReadSchema).safeParse(body);
    if (!parsed.success) return false;
    const supplied = (parsed.data as { files?: unknown }).files;
    if (Array.isArray(supplied) && supplied.length > 0) return true;
    try {
      return (
        (this.storage.readNode(nodeRecordKey(parsed.data))?.deliveryDraft?.files.length ?? 0) > 0
      );
    } catch {
      return true;
    }
  }

  private fileDraft(
    caller: ExecutionCaller,
    body: unknown,
    source: ExecutionFileAuthoritySource | undefined,
  ): Promise<ExecutionResult<DeliveryDraftView>> {
    const writing = body !== null && typeof body === 'object' && 'idempotencyKey' in body;
    let input: z.infer<typeof draftWriteSchema> | undefined;
    let query: z.infer<typeof draftReadSchema>;
    if (writing) {
      const parsed = parseBody(draftWriteSchema, body);
      if (!parsed.ok) return Promise.resolve(parsed);
      input = parsed.value;
      query = parsed.value;
    } else {
      const parsed = parseBody(draftReadSchema, body);
      if (!parsed.ok) return Promise.resolve(parsed);
      query = parsed.value;
    }
    const write = input;
    return this.withFileAuthority(caller, body, source, async (actor, authority) => {
      const space = await this.gateSpace(query.taskId, actor.spaceIds);
      if (space === 'missing' || !space.ok)
        return fail(space === 'missing' ? 'not-found' : space.error.code);
      const task = this.workbench.readWorkbench().tasks.find((item) => item.id === query.taskId);
      if (!task) return fail('not-found');
      return this.enqueue(async () => {
        const current = this.assertFileNode(
          authority,
          actor.actorId,
          query,
          task.projectId,
          space.value,
        );
        if (current.command.status !== 'ready' && current.command.status !== 'needs-revision')
          return fail('not-deliverable');
        const view = (draft: ExecutionNodeRecord['deliveryDraft']): DeliveryDraftView => {
          const verified: ArtifactFileRef[] = [],
            details: { id: string; name: string }[] = [];
          for (const file of draft?.files ?? []) {
            try {
              const bound = this.boundFileReferences([file], current, space.value, actor.actorId);
              verified.push(...bound.files);
              details.push({ id: file.id, name: artifactFileLeaf(bound.records[0]!.name) });
            } catch {
              verified.push(...draftFiles([file]));
            }
          }
          return { ...deliveryDraftView(draft, verified), fileDetails: details };
        };
        if (!write) return { ok: true, value: view(current.deliveryDraft) };
        assertExecutionRunQuiescent(current);
        const text = write.text ?? '',
          links = write.links ?? [];
        const limited =
          draftLinkLimit(links) ??
          draftFileLimit(text, links, write.files ?? []) ??
          draftKeyLimit(write.idempotencyKey);
        if (limited) return limited;
        const bound = this.boundFileReferences(
          write.files ?? [],
          current,
          space.value,
          actor.actorId,
        );
        const files = draftFiles(bound.files);
        const applied = applyDeliveryDraft({
          current: current.deliveryDraft,
          expectedVersion: write.expectedVersion,
          idempotencyKey: write.idempotencyKey,
          fingerprint: canonicalPayload({
            kind: 'delivery-draft',
            actorId: actor.actorId,
            nodeId: current.nodeId,
            text,
            links,
            files,
          }),
          text,
          links,
          files,
        });
        if (!applied.ok)
          return fail(
            applied.code,
            applied.code === 'conflict'
              ? {
                  currentVersion: applied.currentVersion,
                  expectedVersion: write.expectedVersion,
                }
              : {},
          );
        if (applied.disposition === 'applied') {
          this.assertFileNode(authority, actor.actorId, query, task.projectId, space.value);
          const stored = await this.persist(() =>
            this.writeNode({ ...current, deliveryDraft: applied.draft }),
          );
          if (!stored.ok) return stored;
        }
        this.assertFileAuthority(authority, actor.actorId, task.projectId, space.value);
        return { ok: true, value: view(applied.draft) };
      });
    });
  }

  /** Return notes and the two newest relevant versions. The revision record itself is unchanged. */
  /**
   * Upload one file's exact bytes for a node this member currently executes.
   * The server computes the digest and length from the streamed bytes; a
   * declared size/digest mismatch fails. The trusted receipt is a server-issued
   * uploadId plus the content-addressed attachment reference; the client cannot
   * prove completion itself. Bytes publish through the upstream store; metadata
   * lands in `zhuma_files`. A missing provider, budget, or attachment service
   * fails closed.
   */
  uploadFile(
    caller: ExecutionCaller,
    options: {
      readonly declare: ArtifactFileUploadDeclare;
      readonly taskId: string;
      readonly planId: string;
      readonly revision: number;
      readonly nodeId: string;
      readonly spaceId: string;
      readonly idempotencyKey: string;
      readonly data: AsyncIterable<Uint8Array>;
      readonly signal?: AbortSignal;
    },
    authority: ExecutionFileAuthority,
  ): Promise<ExecutionResult<FileUploadReceipt>> {
    const operation = (async (): Promise<ExecutionResult<FileUploadReceipt>> => {
      const actor = this.actor(caller, options);
      if (!actor.ok) return actor;
      const attachments = this.attachments;
      const fileStore = this.fileStore;
      if (!attachments || !fileStore) return fail('unavailable');
      const located = artifactUploadOptionsSchema.safeParse({
        declare: options.declare,
        taskId: options.taskId,
        planId: options.planId,
        revision: options.revision,
        nodeId: options.nodeId,
        spaceId: options.spaceId,
        idempotencyKey: options.idempotencyKey,
      });
      if (!located.success) return fail('validation');
      const request = { ...located.data, data: options.data, signal: options.signal };
      if (request.declare.byteSize > ARTIFACT_FILE_LIMITS.maxFileBytes)
        return fail('file-too-large');
      // This is the original request's Host lease, never a MemberResolution
      // snapshot or a client-provided field. Upload does not require NativeRun.
      const lease = authority?.lease;
      if (
        !lease ||
        lease.memberId !== actor.value.actorId ||
        !(lease.signal instanceof AbortSignal) ||
        typeof lease.assertCurrent !== 'function' ||
        !Number.isFinite(lease.expiresAt) ||
        typeof authority.assertProjectSpace !== 'function'
      )
        return fail('unauthenticated');
      const signal = AbortSignal.any([
        lease.signal,
        this.uploadLifetime.signal,
        ...(request.signal ? [request.signal] : []),
      ]);
      const initialTask = this.workbench.readWorkbench().tasks.find((t) => t.id === request.taskId);
      const assertCurrent = () => {
        if (signal.aborted) throw new ArtifactUploadError('cancelled');
        if (Date.now() >= lease.expiresAt) throw new ArtifactUploadError('unauthenticated');
        try {
          // Reject an accidentally async assertion: permission must be decided
          // synchronously at the publication/write boundary.
          const asserted: unknown = lease.assertCurrent(request.spaceId);
          if (asserted !== undefined) {
            void Promise.resolve(asserted).catch(() => undefined);
            throw new Error('invalid lease assertion');
          }
        } catch {
          throw new ArtifactUploadError('not-found');
        }
        const workbench = this.workbench.readWorkbench();
        const task = workbench.tasks.find((t) => t.id === request.taskId);
        if (
          !initialTask ||
          !task ||
          task.projectId !== initialTask.projectId ||
          !this.directory().includes(actor.value.actorId) ||
          planMembership(workbench, request.taskId, actor.value.actorId) !== 'allowed'
        )
          throw new ArtifactUploadError('not-found');
        try {
          const asserted: unknown = authority.assertProjectSpace(task.projectId, request.spaceId);
          if (asserted !== undefined) {
            void Promise.resolve(asserted).catch(() => undefined);
            throw new Error('invalid project assertion');
          }
        } catch {
          throw new ArtifactUploadError('not-found');
        }
        let node: ExecutionNodeRecord | undefined;
        try {
          node = this.readRunNode(request);
        } catch {
          throw new ArtifactUploadError('not-found');
        }
        if (!node) throw new ArtifactUploadError('not-found');
        if (!recordedPlan(this.storage, node)) throw new ArtifactUploadError('plan-incomplete');
        if (
          node.handoff.assignee.kind !== 'human' ||
          node.handoff.assignee.id !== actor.value.actorId
        )
          throw new ArtifactUploadError('not-assignee');
        if (node.command.status !== 'ready' && node.command.status !== 'needs-revision')
          throw new ArtifactUploadError('not-deliverable');
      };
      let stream: ArtifactUploadStream | undefined;
      const reservation = {
        fingerprint: canonicalPayload({ ...located.data, uploadedBy: actor.value.actorId }),
        spaceId: request.spaceId,
        nodeKey: nodeRecordKey(request),
        bytes: request.declare.byteSize,
        newFile: true,
      };
      let reserved = false;
      try {
        assertCurrent();
        const gate = async () => {
          const space = await this.gateSpaceScoped(
            request.taskId,
            actor.value.spaceIds,
            request.spaceId,
          );
          assertCurrent();
          if (space === 'missing' || !space.ok)
            throw new ArtifactUploadError(space === 'missing' ? 'not-found' : space.error.code);
        };
        // The only business queue admits/reserves briefly, then stays free
        // while real byte I/O waits. Same-key concurrent bodies cannot publish twice.
        await gate();
        const admission = await this.enqueue<UploadFileRecord | undefined>(async () => {
          assertCurrent();
          const pending = this.pendingUploads.get(request.idempotencyKey);
          if (pending)
            return fail(
              pending.fingerprint === reservation.fingerprint ? 'conflict' : 'idempotency-mismatch',
              { reason: 'upload-in-progress' },
            );
          const prior = fileStore.findByIdempotencyKey(request.idempotencyKey);
          if (
            prior &&
            (prior.uploadedBy !== actor.value.actorId ||
              prior.spaceId !== request.spaceId ||
              prior.taskId !== request.taskId ||
              prior.planId !== request.planId ||
              prior.revision !== request.revision ||
              prior.nodeId !== request.nodeId ||
              prior.name !== request.declare.name ||
              prior.mediaType !== request.declare.mediaType ||
              prior.byteSize !== request.declare.byteSize ||
              prior.sha256 !== request.declare.sha256)
          )
            return fail('idempotency-mismatch');
          const peers = [...this.pendingUploads.values()].filter(
            (item) => item.spaceId === request.spaceId,
          );
          if (peers.length >= ARTIFACT_FILE_LIMITS.maxConcurrentUploadsPerSpace)
            return fail('quota-exceeded');
          if (!prior) {
            if (
              fileStore.countInSpace(request.spaceId) +
                peers.filter((item) => item.newFile).length >=
                ARTIFACT_FILE_LIMITS.maxFilesPerSpace ||
              fileStore.bytesForNode(
                request.taskId,
                request.planId,
                request.revision,
                request.nodeId,
              ) +
                peers
                  .filter((item) => item.nodeKey === reservation.nodeKey)
                  .reduce((sum, item) => sum + item.bytes, 0) +
                request.declare.byteSize >
                ARTIFACT_FILE_LIMITS.maxNodeBytes
            )
              return fail('quota-exceeded');
          }
          this.pendingUploads.set(
            request.idempotencyKey,
            prior ? { ...reservation, bytes: 0, newFile: false } : reservation,
          );
          reserved = true;
          return { ok: true, value: prior };
        });
        if (!admission.ok) return admission;
        const prior = admission.value;
        stream = new ArtifactUploadStream(request.data, request.declare, signal, assertCurrent);
        if (prior) {
          for await (const _chunk of stream) {
            /* Bounded actual replay bytes. */
          }
          await stream.wait(gate());
          return await this.enqueue(async () => {
            stream!.check();
            const current = fileStore.get(prior.uploadId);
            if (
              !current ||
              current.state !== 'completed' ||
              current.idempotencyKey !== request.idempotencyKey
            )
              return fail('not-found');
            return { ok: true, value: receiptOf(current) };
          });
        }
        const ref: FileAttachmentRef = await stream.wait(
          attachments.saveFileStream({
            name: request.declare.name,
            data: stream,
            signal: stream.signal,
          }),
        );
        // Actual SDK must have observed our verified EOS; an early or malformed
        // provider response cannot mint a trusted receipt.
        if (
          !stream.verified ||
          ref.attachmentId !== `sha256:${request.declare.sha256}` ||
          ref.bytes !== request.declare.byteSize ||
          ref.name !== request.declare.name
        )
          return fail('digest-mismatch');
        await stream.wait(gate());
        return await this.enqueue(async () => {
          stream!.check();
          if (
            fileStore.countInSpace(request.spaceId) >= ARTIFACT_FILE_LIMITS.maxFilesPerSpace ||
            fileStore.bytesForNode(
              request.taskId,
              request.planId,
              request.revision,
              request.nodeId,
            ) +
              request.declare.byteSize >
              ARTIFACT_FILE_LIMITS.maxNodeBytes
          )
            return fail('quota-exceeded');
          const record = {
            uploadId: randomUUID(),
            attachmentId: ref.attachmentId,
            name: ref.name,
            mediaType: request.declare.mediaType,
            byteSize: ref.bytes,
            sha256: request.declare.sha256,
            spaceId: request.spaceId,
            taskId: request.taskId,
            planId: request.planId,
            revision: request.revision,
            nodeId: request.nodeId,
            uploadedBy: actor.value.actorId,
            idempotencyKey: request.idempotencyKey,
            state: 'completed' as const,
            uploadedAt: new Date().toISOString(),
          };
          // Keep the actual durable write owned by the existing command queue;
          // cancellation must not release that queue while a put is still writing.
          await fileStore.put(record);
          stream!.check();
          return { ok: true, value: receiptOf(record) };
        });
      } catch (error) {
        const failure = stream?.failure;
        if (failure) return fail(failure.code);
        if (error instanceof ArtifactUploadError || error instanceof WorkbenchError)
          return fail(error.code);
        return fail(signal.aborted ? 'cancelled' : 'unavailable');
      } finally {
        const releaseReservation = () => {
          if (reserved) this.pendingUploads.delete(request.idempotencyKey);
        };
        if (stream) {
          stream.finish();
          const drain = stream.drain().then(releaseReservation);
          this.uploadDrains.add(drain);
          void drain.then(() => this.uploadDrains.delete(drain));
        } else releaseReservation();
      }
    })();
    this.uploadOperations.add(operation);
    void operation.then(
      () => this.uploadOperations.delete(operation),
      () => this.uploadOperations.delete(operation),
    );
    return operation;
  }

  /** Seal before draining the existing command queue or closing either domain. */
  sealUploads(): void {
    this.uploadLifetime.abort();
  }

  async closeUploads(): Promise<void> {
    this.sealUploads();
    while (this.uploadOperations.size) await Promise.allSettled([...this.uploadOperations]);
    await this.writes;
    while (this.uploadDrains.size) await Promise.all([...this.uploadDrains]);
  }

  /**
   * Read the content of the accepted version a downstream node froze as its
   * input. Bounded, on demand, read-only: the member must be a participant of
   * the downstream task, the frozen ref must be among the node's inputRefs,
   * and the source's current accepted version must be exactly the pinned one.
   * No hidden source leaks; pending or replaced refs stay a hint, not content.
   * A read writes nothing.
   */
  fileContent(
    caller: ExecutionCaller,
    body: unknown,
    source?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionResult<AuthorizedFileContent>> {
    const parsed = parseBody(fileReadSchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    const query = parsed.value;
    return this.withFileAuthority(
      caller,
      body,
      source,
      async (actor, authority) => {
        if (!this.attachments || !this.fileStore) return fail('unavailable');
        const space = await this.gateSpaceScoped(query.taskId, actor.spaceIds, query.spaceId);
        if (space === 'missing' || !space.ok)
          return fail(space === 'missing' ? 'not-found' : space.error.code);
        const task = this.workbench.readWorkbench().tasks.find((item) => item.id === query.taskId);
        if (!task) return fail('not-found');
        const assertAccess = () =>
          this.readableFileRecord(authority, actor.actorId, query, task.projectId);
        const record = assertAccess();
        const check = () => {
          const fresh = assertAccess();
          if (canonicalPayload(fresh) !== canonicalPayload(record))
            throw new ArtifactUploadError('not-found');
        };
        const info: FileContentInfo = {
          request: { ...query },
          uploadId: record.uploadId,
          name: artifactFileLeaf(record.name),
          mediaType: record.mediaType,
          bytes: record.byteSize,
          sha256: record.sha256,
          reference: artifactFileReference(record),
        };
        const signal = AbortSignal.any([authority.lease.signal, this.fileLifetime.signal]);
        let read: { bytes: Uint8Array | undefined; release(): void } | undefined;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          signal.removeEventListener('abort', release);
          read?.release();
          authority.lease.release();
        };
        signal.addEventListener('abort', release, { once: true });
        try {
          if (query.mode !== 'metadata')
            read = await this.verifyFileBytes(record, authority, check, true);
          if (signal.aborted) throw new ArtifactUploadError('cancelled');
          const fresh = assertAccess();
          if (canonicalPayload(fresh) !== canonicalPayload(record))
            throw new ArtifactUploadError('not-found');
          return {
            ok: true,
            value: {
              info,
              ...(read?.bytes === undefined ? {} : { bytes: read.bytes }),
              signal,
              check: () => {
                if (released) throw new ArtifactUploadError('cancelled');
                check();
              },
              release,
            },
          };
        } catch (error) {
          release();
          throw error;
        }
      },
      true,
    );
  }

  private readableFileRecord(
    authority: ExecutionFileAuthority,
    actorId: string,
    query: FileContentRequest,
    projectId: string,
  ): UploadFileRecord {
    if (!this.fileStore) throw new ArtifactUploadError('not-found');
    const target = this.assertFileRecord(authority, actorId, query, projectId, query.spaceId);
    let source = target;
    let file: ArtifactFileRef | undefined;
    if (query.purpose === 'draft') {
      if (
        target.handoff.assignee.kind !== 'human' ||
        target.handoff.assignee.id !== actorId ||
        (target.command.status !== 'ready' && target.command.status !== 'needs-revision')
      )
        throw new ArtifactUploadError('not-found');
    } else {
      if (query.purpose === 'upstream') {
        if (
          target.handoff.assignee.kind !== 'human' ||
          target.handoff.assignee.id !== actorId ||
          !(target.handoff.inputRefs ?? []).some(
            (ref) =>
              ref.sourceNodeId === query.sourceNodeId &&
              ref.artifactVersionId === query.artifactVersionId,
          )
        )
          throw new ArtifactUploadError('not-found');
        try {
          source = this.currentFileNode({ ...query, nodeId: query.sourceNodeId });
        } catch {
          throw new ArtifactUploadError('not-found');
        }
        if (
          !source ||
          !recordedPlan(this.storage, source) ||
          source.acceptedArtifactVersionId !== query.artifactVersionId
        )
          throw new ArtifactUploadError('not-found');
      }
      const artifact = source.artifactVersions.find((item) => item.id === query.artifactVersionId);
      if (!artifact) throw new ArtifactUploadError('not-found');
      if (query.purpose === 'review') {
        const round = source.rounds.find(
          (item) => item.id === query.roundId && item.artifactVersionId === artifact.id,
        );
        if (
          !round ||
          round.status === 'voided' ||
          !round.reviewerIds.includes(actorId) ||
          !source.handoff.reviewerIds.includes(actorId)
        )
          throw new ArtifactUploadError('not-found');
      } else if (
        query.purpose === 'artifact' &&
        (source.handoff.assignee.kind !== 'human' || source.handoff.assignee.id !== actorId)
      )
        throw new ArtifactUploadError('not-found');
      file = artifact.files.find((item) => item.id === query.uploadId);
      if (!file) throw new ArtifactUploadError('not-found');
    }
    const record = this.fileStore.get(query.uploadId);
    if (
      !record ||
      record.state !== 'completed' ||
      record.spaceId !== query.spaceId ||
      record.taskId !== source.taskId ||
      record.planId !== source.planId ||
      record.revision !== source.revision ||
      record.nodeId !== source.nodeId ||
      (query.purpose === 'draft'
        ? record.uploadedBy !== actorId
        : !file || !matchesArtifactFileReference(file, record))
    )
      throw new ArtifactUploadError('not-found');
    return { ...record };
  }

  upstreamContent(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<UpstreamContentValue>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(upstreamContentSchema, body);
      if (!parsed.ok) return parsed;
      if (!this.projectSpaceDirectory()) return fail('not-found');
      // The scope is required for this read: a member holding two spaces must
      // name the current one, so the chosen constraint is always explicit.
      const scope = parsed.value.spaceId;
      if (!this.scopeHeld(actor.value.spaceIds, scope)) return fail('not-found');
      // Authorize the downstream node first: the member must belong to its task.
      const space = await this.gateSpaceScoped(parsed.value.taskId, actor.value.spaceIds, scope);
      if (space === 'missing' || !space.ok) return space === 'missing' ? fail('not-found') : space;
      const downstream = this.storage.readNode(nodeRecordKey(parsed.value));
      if (!downstream || !intactNode(downstream)) return fail('not-found');
      const membership = planMembership(
        this.workbench.readWorkbench(),
        downstream.taskId,
        actor.value.actorId,
      );
      if (membership !== 'allowed') return fail('not-found');
      // The frozen ref must be exactly one of this node's declared inputs.
      const ref = (downstream.handoff.inputRefs ?? []).find(
        (input) =>
          input.sourceNodeId === parsed.value.sourceNodeId &&
          input.artifactVersionId === parsed.value.artifactVersionId,
      );
      if (!ref) return fail('not-found');
      // Read the source node in the same task.
      const source = this.storage.readNode(
        nodeRecordKey({
          taskId: parsed.value.taskId,
          planId: parsed.value.planId,
          revision: parsed.value.revision,
          nodeId: parsed.value.sourceNodeId,
        }),
      );
      if (!source || !intactNode(source)) return fail('not-found');
      // The source's current accepted version must be exactly the pinned one:
      // pending or replaced refs stay a hint and never serve content.
      if (source.acceptedArtifactVersionId !== parsed.value.artifactVersionId) {
        return fail('not-found');
      }
      const artifact = source.artifactVersions.find(
        (item) => item.id === parsed.value.artifactVersionId,
      );
      if (!artifact) return fail('not-found');
      return {
        ok: true,
        value: {
          actorId: actor.value.actorId,
          spaceId: scope,
          downstream: {
            nodeId: parsed.value.nodeId,
            taskId: parsed.value.taskId,
            planId: parsed.value.planId,
            revision: parsed.value.revision,
          },
          source: {
            nodeId: parsed.value.sourceNodeId,
            taskId: parsed.value.taskId,
            planId: parsed.value.planId,
            revision: parsed.value.revision,
          },
          version: { id: artifact.id, version: artifact.version },
          content: {
            ...(artifact.text === undefined ? {} : { text: artifact.text }),
            // Copy the arrays and file metadata: the domain table returns the
            // stored objects, and a caller mutating this DTO must not rewrite
            // the stored fact.
            links: [...artifact.links],
            files: artifact.files.map((file) => ({ ...file })),
          },
        },
      };
    });
  }

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
    const operation = this.writes.then(work, work).catch((error: unknown) => {
      if (
        error instanceof ArtifactUploadError ||
        error instanceof ExecutionRunError ||
        error instanceof ExecutionRunProtocolError ||
        error instanceof ExecutionRunCompositionError
      )
        return fail(error.code);
      throw error;
    });
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
  /**
   * The requested space scope is a filter the caller chose, never a grant.
   * The member must currently hold it in the trusted session: an unknown,
   * revoked, or foreign scope is indistinguishable from an empty one for
   * reads (empty list) and from a missing task for commands (not-found).
   */
  private scopeHeld(spaceIds: readonly string[], scope: string | undefined): boolean {
    if (scope === undefined) return true;
    return spaceIds.includes(scope);
  }

  /**
   * Scope check on top of the space gate: the task's owning space must equal
   * the requested scope. Returns the gate verdict; a scoped miss collapses
   * into not-found for commands and an empty projection for reads.
   */
  private async gateSpaceScoped(
    taskId: string,
    spaceIds: readonly string[],
    scope: string | undefined,
  ): Promise<'missing' | ExecutionResult<string>> {
    const space = await this.gateSpace(taskId, spaceIds);
    if (scope === undefined || space === 'missing' || !space.ok) return space;
    if (space.value !== scope) return fail('not-found');
    return space;
  }

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
   * Shared inbox read. An unknown scope is an empty projection and does not
   * ask the directory. A held scope keeps that space; no scope keeps every
   * space the member can already see.
   */
  private async openInbox(caller: ExecutionCaller, body: unknown) {
    const actor = this.actor(caller, body);
    if (!actor.ok) return actor;
    const parsed = parseBody(inboxSchema.optional(), body ?? {});
    if (!parsed.ok) return parsed;
    if (!this.projectSpaceDirectory()) return fail('not-found');
    const scope = parsed.value?.spaceId;
    if (!this.scopeHeld(actor.value.spaceIds, scope)) {
      // Unknown or revoked scope: an empty projection, indistinguishable from an empty space.
      return {
        ok: true as const,
        actorId: actor.value.actorId,
        scope,
        items: [] as readonly InboxItem[],
        nodes: [] as ExecutionNodeView[],
      };
    }
    const visible = await this.readableRecords(actor.value.spaceIds, actor.value.actorId, scope);
    if (!Array.isArray(visible)) return visible;
    for (const taskId of new Set(visible.map((record) => record.taskId))) {
      await this.repairTaskUnlocks(taskId, actor.value.spaceIds);
    }
    const records = await this.readableRecords(actor.value.spaceIds, actor.value.actorId, scope);
    if (!Array.isArray(records)) return records;
    const items = executionInbox({ actorId: actor.value.actorId, records });
    const nodes = records
      .filter((record) =>
        items.some((item) => item.nodeId === record.nodeId && item.taskId === record.taskId),
      )
      .map((record) => ({ ...toNodeView(record), inputs: upstreamInputsFor(record, records) }));
    return { ok: true as const, actorId: actor.value.actorId, scope, items, nodes };
  }

  /**
   * Intact nodes this actor can read. A requested scope keeps that space only.
   * A failed lookup stops the scan, whether or not any node is stored.
   */
  private async readableRecords(spaceIds: readonly string[], actorId: string, scope?: string) {
    for (const task of this.workbench.readWorkbench().tasks) {
      const space = await this.gateSpaceScoped(task.id, spaceIds, scope);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
    }
    const records: ExecutionNodeRecord[] = [];
    for (const record of this.storage.listNodes()) {
      if (!intactNode(record) || !recordedPlan(this.storage, record)) continue;
      const space = await this.gateSpaceScoped(record.taskId, spaceIds, scope);
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
    // The chosen scope re-checks the plan's owning space before any idempotent
    // replay: "currently in A, the old plan actually lives in B" refuses even
    // when the member holds both spaces.
    const space = await this.gateSpaceScoped(taskId, actor.value.spaceIds, parsed.value.spaceId);
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
    // The same key replays before the conflict scan, so another project's
    // directory fault cannot change that retry. Any other key is checked first.
    // A replay still compensates unlocks that failed after the nodes completed.
    // Reports are read only after that compensation succeeds, so a retry that
    // finishes a previously failed downstream write does not return the blocked snapshot.
    const replayAfterUnlock = async () => {
      const compensated = await this.unlockCompleted(taskId, planId, revision);
      if (!compensated.ok) return compensated;
      return {
        ok: true as const,
        value: { disposition: 'replayed', reports: this.reportsFor(taskId, planId, revision) },
      };
    };
    if (prior?.fingerprint === fingerprint && prior.idempotencyKey === idempotencyKey) {
      return replayAfterUnlock();
    }
    const conflict = await this.sameSpaceIdempotencyConflict(
      idempotencyKey,
      key,
      space.value,
      task.projectId,
    );
    if (!conflict.ok) return conflict;
    if (conflict.value) return fail('idempotency-mismatch');
    if (prior?.fingerprint === fingerprint) {
      return replayAfterUnlock();
    }
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
      const stored = await this.persist(() => this.writeNode(stamped));
      if (!stored.ok) return stored;
    }
    const compensated = await this.unlockCompleted(taskId, planId, revision);
    if (!compensated.ok) return compensated;
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
    beforeFileWrite?: (current: ExecutionNodeRecord) => void,
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
    assertExecutionRunQuiescent(current);
    beforeFileWrite?.(current);
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
      if (
        round &&
        (round.status === 'approved' || round.status === 'changes-requested') &&
        !settlementLanded(record, round.id)
      ) {
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
      beforeFileWrite?.(current);
      if (executed.result.disposition === 'applied') {
        const stamped = withExecutionEvent(record, eventType, actor.value.actorId);
        if (!stamped) return fail('unavailable');
        record = stamped;
      }
      const stored = await this.persist(() => this.writeNode(record));
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

  /** Idempotent unlock for nodes already completed in this plan. Write failures propagate. */
  private async unlockCompleted(
    taskId: string,
    planId: string,
    revision: number,
  ): Promise<ExecutionResult<void>> {
    const completed = this.storage
      .listNodes()
      .filter(
        (record) =>
          intactNode(record) &&
          samePlan(record, taskId, planId, revision) &&
          record.command.status === 'completed',
      );
    for (const record of completed) {
      const latest = this.storage.readNode(nodeRecordKey(record));
      if (!latest || !intactNode(latest) || latest.command.status !== 'completed') continue;
      const unlocked = await this.unlockFrom(latest);
      if (!unlocked.ok) return unlocked;
    }
    return { ok: true, value: undefined };
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
      const stored = await this.persist(() => this.writeNode(stamped));
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
    } catch (error) {
      if (error instanceof ExecutionRunError || error instanceof ExecutionRunProtocolError)
        return fail(error.code);
      return fail('unavailable');
    }
  }
}
