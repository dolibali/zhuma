import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { ExecutionFilesApi } from './files.js';
import type { ProjectArtifactsApi } from '../workbench/project-artifacts-contract.js';
import { createProjectArtifactsApi } from '../workbench/project-artifacts-api.js';
import { createTaskProgressApi, type TaskProgressApi } from './task-progress.js';
import {
  INBOX_ACTIONS,
  INBOX_KINDS,
  NODE_STATUSES,
  type NodeExecutionReport,
  type ArtifactFileRef,
  type InboxAction,
  type InboxItem,
  type InboxKind,
  type NodeStatus,
} from '@zhuma/agent-core';

const ACTOR_FIELDS = new Set(['actorId', 'memberId', 'reviewerId']);

export interface ExecutionArtifactWire {
  readonly id: string;
  readonly version: number;
  readonly text?: string;
  readonly links?: readonly string[];
  readonly files?: readonly ArtifactFileRef[];
}

export interface ExecutionBallotWire {
  readonly reviewerId: string;
  readonly action: string;
  readonly comment?: string;
}

export interface ExecutionRoundWire {
  readonly id: string;
  readonly status: string;
  readonly artifactVersionId: string;
  readonly reviewerIds: readonly string[];
  readonly ballots: readonly ExecutionBallotWire[];
}

/** Node projection returned by `/api/zhuma-exec`. It is not a second execution record. */
export interface ExecutionNodeWire {
  readonly nodeId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly version: number;
  readonly status: NodeStatus;
  readonly goal: string;
  readonly expectedOutput: string;
  readonly assigneeId: string;
  readonly reviewerIds: readonly string[];
  readonly currentRoundId?: string;
  readonly artifacts: readonly ExecutionArtifactWire[];
  readonly rounds: readonly ExecutionRoundWire[];
  readonly comments: readonly { readonly id: string; readonly status: string }[];
  readonly reviewOutcome?: string;
  readonly blockReason?: string;
  readonly acceptedArtifactVersionId?: string;
  readonly inputs?: readonly UpstreamInputWire[];
}

/** Public #81 projection. Hidden rows carry no source identifiers or content. */
export type UpstreamInputWire =
  | {
      readonly access: 'visible';
      readonly blocking: boolean;
      readonly sourceNodeId: string;
      /** Pinned accepted version id carried by the #81 projection for content reads. */
      readonly artifactVersionId: string;
      readonly sourceGoal?: string;
      readonly version: number;
      readonly name: string;
    }
  | {
      readonly access: 'pending';
      readonly blocking: boolean;
      readonly pending: 'none' | 'replaced';
      readonly sourceNodeId: string;
      readonly message: string;
    }
  | {
      readonly access: 'hidden';
      readonly blocking: boolean;
      readonly count: number;
      readonly message: string;
    };

export interface ExecutionInboxValue {
  readonly actorId: string;
  readonly spaceId?: string | undefined;
  readonly items: readonly InboxItem[];
  readonly nodes: readonly ExecutionNodeWire[];
  readonly places?: readonly InboxPlaceWire[];
}
/** Public #85 projection. Empty fields remain unknown; no client-side source reconstruction. */
export interface InboxPlaceWire {
  readonly itemId: string;
  readonly taskPath: string;
  readonly ownerName: string;
}

export function readInboxPlaces(value: unknown): readonly InboxPlaceWire[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid('返回的来源位置不正确。');
  return value.map((raw) => {
    const item = record(raw, '来源位置');
    return {
      itemId: text(item.itemId, '工作项'),
      taskPath: typeof item.taskPath === 'string' ? item.taskPath.trim() : '',
      ownerName: typeof item.ownerName === 'string' ? item.ownerName.trim() : '',
    };
  });
}

export interface DeliveryDraft {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly text?: string;
  readonly files?: readonly ArtifactFileRef[];
  readonly links?: readonly string[];
}

export interface ReviewDraft {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly roundId: string;
  readonly artifactVersionId: string;
  readonly action: 'approve' | 'request-changes' | 'comment';
  readonly comment?: string;
}

export interface StartPlanDraft {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly spaceId?: string | undefined;
}
export interface StartablePlanWire {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly title: string;
}
export interface ExecutionStartableValue {
  readonly actorId: string;
  readonly spaceId?: string | undefined;
  readonly plans: readonly StartablePlanWire[];
}
export interface StartPlanValue {
  readonly disposition: string;
  readonly reports: NodeExecutionReport[];
}

export interface RevisionQuery {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
}
export interface UpstreamContentQuery extends RevisionQuery {
  readonly sourceNodeId: string;
  readonly artifactVersionId: string;
  /** Local response expectation from the visible row; never sent as a service field. */
  readonly expectedArtifactVersion: number;
}
export interface UpstreamContentWire {
  readonly actorId: string;
  readonly spaceId: string;
  readonly downstream: RevisionQuery;
  readonly source: RevisionQuery;
  readonly version: { readonly id: string; readonly version: number };
  readonly content: {
    readonly text?: string;
    readonly links: readonly string[];
    readonly files: readonly ArtifactFileRef[];
  };
}
export interface SavedDeliveryDraftWire {
  readonly version: number;
  readonly text: string;
  readonly links: readonly string[];
  readonly files: readonly ArtifactFileRef[];
  readonly fileDetails?: readonly { readonly id: string; readonly name: string }[];
}
export interface DeliveryDraftSave extends RevisionQuery {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly text?: string;
  readonly links?: readonly string[];
  readonly files?: readonly ArtifactFileRef[];
}
export interface RevisionContentWire {
  readonly id: string;
  readonly version: number;
  readonly text?: string;
  readonly links: readonly string[];
  readonly files: readonly {
    readonly id: string;
    readonly mediaType: string;
    readonly byteSize: number;
  }[];
}
export interface RevisionViewWire {
  readonly reviewed?: RevisionContentWire;
  readonly previous?: RevisionContentWire;
  readonly notes: readonly {
    readonly id: string;
    readonly reviewerName: string;
    readonly body: string;
    readonly artifactVersionId: string;
    readonly citedCommentIds: readonly string[];
  }[];
}

/** Preserves the service failure DTO, including conflict/version details. */
export class ExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export function executionErrorMessage(error: unknown): string {
  return error instanceof ExecutionError ? error.message : '请求未完成，请重试。';
}

export interface ExecutionApi {
  /** Only the member HTTP transport exposes the authorized byte routes. */
  readonly files?: ExecutionFilesApi;
  readonly projectArtifacts?: ProjectArtifactsApi;
  readonly taskProgress?: TaskProgressApi;
  startable(signal?: AbortSignal): Promise<ExecutionStartableValue>;
  startPlan(draft: StartPlanDraft, signal?: AbortSignal): Promise<StartPlanValue>;
  inbox(signal?: AbortSignal): Promise<ExecutionInboxValue>;
  submit(draft: DeliveryDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  ballot(draft: ReviewDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  revision(query: RevisionQuery, signal?: AbortSignal): Promise<RevisionViewWire>;
  upstreamContent(query: UpstreamContentQuery, signal?: AbortSignal): Promise<UpstreamContentWire>;
  readDeliveryDraft(query: RevisionQuery, signal?: AbortSignal): Promise<SavedDeliveryDraftWire>;
  saveDeliveryDraft(
    draft: DeliveryDraftSave,
    signal?: AbortSignal,
  ): Promise<SavedDeliveryDraftWire>;
}

const ACTOR_FIELD_DEPTH_LIMIT = 32;

function rejectActor(value: unknown): void {
  const seen = new Set<unknown>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > ACTOR_FIELD_DEPTH_LIMIT) {
      throw new ExecutionError('validation', '请求嵌套太深。');
    }
    if (current === null || typeof current !== 'object') return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (ACTOR_FIELDS.has(key)) {
        throw new ExecutionError('actor-from-body', '不能在请求里指定操作者。');
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function invalid(message: string): never {
  throw new ExecutionError('validation', message);
}

function integer(value: unknown, minimum: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    invalid(`返回的${field}不正确。`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`返回的${field}不正确。`);
  return value;
}

function readArtifact(value: unknown): ExecutionArtifactWire {
  if (value === null || typeof value !== 'object') invalid('返回的产物不正确。');
  const record = value as Record<string, unknown>;
  return {
    id: text(record.id, '产物'),
    version: integer(record.version, 1, '产物版本'),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(Array.isArray(record.links)
      ? { links: record.links.map((link) => text(link, '链接')) }
      : {}),
    ...(record.files === undefined ? {} : { files: readFileReferences(record.files) }),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`返回的${field}不正确。`);
  return value as Record<string, unknown>;
}
function unique<T>(items: readonly T[], key: (item: T) => string, field: string): void {
  if (new Set(items.map(key)).size !== items.length) invalid(`返回的${field}有重复标识。`);
}

function exactRecord(value: unknown, keys: readonly string[], field: string) {
  const item = record(value, field);
  if (Object.keys(item).some((key) => !keys.includes(key))) invalid(`返回的${field}包含未知字段。`);
  return item;
}

/** #100 read: exact public fields and all echoed identities must match this request. */
function readUpstreamContent(
  value: unknown,
  query: UpstreamContentQuery,
  spaceId: string,
): UpstreamContentWire {
  const item = exactRecord(
    value,
    ['actorId', 'spaceId', 'downstream', 'source', 'version', 'content'],
    '上游内容',
  );
  const locate = (raw: unknown): RevisionQuery => {
    const location = exactRecord(raw, ['taskId', 'planId', 'revision', 'nodeId'], '上游定位');
    return {
      taskId: text(location.taskId, '任务'),
      planId: text(location.planId, '计划'),
      revision: integer(location.revision, 1, '计划版本'),
      nodeId: text(location.nodeId, '节点'),
    };
  };
  const actorId = text(item.actorId, '操作者');
  const returnedSpace = text(item.spaceId, '空间');
  if (returnedSpace !== spaceId)
    throw new ExecutionError('scope-mismatch', '返回的工作空间不一致，请重新连接。');
  const downstream = locate(item.downstream),
    source = locate(item.source);
  const version = exactRecord(item.version, ['id', 'version'], '上游版本');
  const pinned = {
    id: text(version.id, '上游版本标识'),
    version: integer(version.version, 1, '上游版本'),
  };
  if (
    downstream.taskId !== query.taskId ||
    downstream.planId !== query.planId ||
    downstream.revision !== query.revision ||
    downstream.nodeId !== query.nodeId ||
    source.taskId !== query.taskId ||
    source.planId !== query.planId ||
    source.revision !== query.revision ||
    source.nodeId !== query.sourceNodeId ||
    pinned.id !== query.artifactVersionId ||
    pinned.version !== query.expectedArtifactVersion
  )
    throw new ExecutionError(
      'upstream-mismatch',
      '上游内容与当前工作或引用版本不一致，请刷新待办。',
    );
  const content = exactRecord(item.content, ['text', 'links', 'files'], '上游正文');
  if (
    (content.text !== undefined &&
      (typeof content.text !== 'string' || content.text.length > 100_000)) ||
    !Array.isArray(content.links) ||
    content.links.length > 20 ||
    !Array.isArray(content.files) ||
    content.files.length > 20
  )
    invalid('返回的上游内容不完整。');
  const files = content.files.map((raw) => {
    const file = exactRecord(
      raw,
      ['id', 'mediaType', 'byteSize', 'checksum', 'accessPolicyId', 'uploadComplete'],
      '上游文件信息',
    );
    if (typeof file.uploadComplete !== 'boolean') invalid('返回的上游文件状态不正确。');
    return {
      id: text(file.id, '文件'),
      mediaType: text(file.mediaType, '文件类型'),
      byteSize: integer(file.byteSize, 0, '文件大小'),
      checksum: text(file.checksum, '文件摘要'),
      accessPolicyId: text(file.accessPolicyId, '文件权限引用'),
      uploadComplete: file.uploadComplete,
    };
  });
  unique(files, (file) => file.id, '上游文件');
  return {
    actorId,
    spaceId: returnedSpace,
    downstream,
    source,
    version: pinned,
    content: {
      ...(content.text === undefined ? {} : { text: content.text as string }),
      links: content.links.map((link) => text(link, '上游链接')),
      files,
    },
  };
}
function readUpstreamInput(value: unknown): UpstreamInputWire {
  const item = record(value, '上游输入');
  if (typeof item.blocking !== 'boolean') invalid('返回的上游阻塞状态不正确。');
  const blocking = item.blocking;
  switch (item.access) {
    case 'visible':
      if (item.sourceGoal !== undefined && typeof item.sourceGoal !== 'string')
        invalid('返回的来源目标不正确。');
      return {
        access: 'visible',
        blocking,
        sourceNodeId: text(item.sourceNodeId, '来源节点'),
        artifactVersionId: text(item.artifactVersionId, '上游版本标识'),
        ...(item.sourceGoal === undefined ? {} : { sourceGoal: item.sourceGoal as string }),
        version: integer(item.version, 1, '上游版本'),
        name: text(item.name, '产物名称'),
      };
    case 'pending':
      if (item.pending !== 'none' && item.pending !== 'replaced')
        invalid('返回的上游提示状态不正确。');
      return {
        access: 'pending',
        blocking,
        pending: item.pending,
        sourceNodeId: text(item.sourceNodeId, '来源节点'),
        message: text(item.message, '上游提示'),
      };
    case 'hidden':
      return {
        access: 'hidden',
        blocking,
        count: integer(item.count, 1, '受限来源数量'),
        message: text(item.message, '受限来源提示'),
      };
    default:
      return invalid('返回的上游可见状态不正确。');
  }
}
export function readSavedDeliveryDraft(value: unknown): SavedDeliveryDraftWire {
  const draft = record(value, '已存草稿');
  if (typeof draft.text !== 'string' || !Array.isArray(draft.links) || !Array.isArray(draft.files))
    invalid('返回的草稿不完整，请重新读取。');
  return {
    version: integer(draft.version, 0, '草稿版本'),
    text: draft.text,
    links: draft.links.map((link) => text(link, '草稿链接')),
    files: readFileReferences(draft.files),
    ...(draft.fileDetails === undefined
      ? {}
      : { fileDetails: readFileDetails(draft.fileDetails, draft.files) }),
  };
}

export function readArtifactFileReference(raw: unknown): ArtifactFileRef {
  const file = record(raw, '文件引用');
  if (typeof file.uploadComplete !== 'boolean') invalid('文件完成状态不正确。');
  const checksum = text(file.checksum, '文件校验');
  if (file.uploadComplete && !/^[a-f0-9]{64}$/.test(checksum)) invalid('文件校验不正确。');
  return {
    id: text(file.id, '文件引用'),
    mediaType: text(file.mediaType, '文件类型'),
    byteSize: integer(file.byteSize, 0, '文件大小'),
    checksum,
    accessPolicyId: text(file.accessPolicyId, '文件访问策略'),
    uploadComplete: file.uploadComplete,
  };
}
function readFileReferences(value: unknown): ArtifactFileRef[] {
  if (!Array.isArray(value) || value.length > 20) invalid('文件列表不正确。');
  const files = value.map(readArtifactFileReference);
  unique(files, (file) => file.id, '文件');
  return files;
}
function readFileDetails(value: unknown, references: unknown[]): { id: string; name: string }[] {
  if (!Array.isArray(value) || value.length > 20) invalid('文件名称不正确。');
  const ids = new Set(references.map((raw) => readArtifactFileReference(raw).id));
  const details = value.map((raw) => {
    const item = record(raw, '文件名称');
    const id = text(item.id, '文件引用');
    if (!ids.has(id)) invalid('文件名称与引用不一致。');
    return { id, name: text(item.name, '文件名称') };
  });
  unique(details, (item) => item.id, '文件名称');
  return details;
}
function draftQuery(query: RevisionQuery): RevisionQuery {
  return {
    taskId: text(query.taskId, '任务'),
    planId: text(query.planId, '计划'),
    revision: integer(query.revision, 1, '计划版本'),
    nodeId: text(query.nodeId, '节点'),
  };
}
function readRevisionContent(value: unknown): RevisionContentWire {
  const item = record(value, '退回版本');
  if (!Array.isArray(item.links) || !Array.isArray(item.files)) invalid('返回的退回版本不正确。');
  if (item.text !== undefined && typeof item.text !== 'string') invalid('返回的版本正文不正确。');
  const files = item.files.map((raw) => {
    const file = record(raw, '文件信息');
    return {
      id: text(file.id, '文件'),
      mediaType: text(file.mediaType, '文件类型'),
      byteSize: integer(file.byteSize, 0, '文件大小'),
    };
  });
  return {
    id: text(item.id, '产物'),
    version: integer(item.version, 1, '产物版本'),
    ...(item.text === undefined ? {} : { text: item.text as string }),
    links: item.links.map((link) => text(link, '链接')),
    files,
  };
}
/** Exact #80 view projection. It carries metadata and reference ids, never file bytes or comment ranges. */
export function readRevisionView(value: unknown): RevisionViewWire {
  const container = record(value, '退回响应');
  const view = record(container.view, '退回意见');
  if (!Array.isArray(view.notes)) invalid('返回的退回意见不正确。');
  const reviewed = view.reviewed === undefined ? undefined : readRevisionContent(view.reviewed);
  const previous = view.previous === undefined ? undefined : readRevisionContent(view.previous);
  if (
    previous &&
    (!reviewed || previous.id === reviewed.id || previous.version !== reviewed.version - 1)
  )
    invalid('返回的对照版本不正确。');
  const notes = view.notes.map((raw) => {
    const note = record(raw, '退回意见');
    if (typeof note.body !== 'string' || !Array.isArray(note.citedCommentIds))
      invalid('返回的退回意见不正确。');
    const citedCommentIds = note.citedCommentIds.map((id) => text(id, '评论引用'));
    unique(citedCommentIds, (id) => id, '评论引用');
    return {
      id: text(note.id, '退回意见'),
      reviewerName: text(note.reviewerName, '评审人'),
      body: note.body,
      artifactVersionId: text(note.artifactVersionId, '引用版本'),
      citedCommentIds,
    };
  });
  unique(notes, (note) => note.id, '退回意见');
  return { ...(reviewed ? { reviewed } : {}), ...(previous ? { previous } : {}), notes };
}

function readBallot(value: unknown): ExecutionBallotWire {
  if (value === null || typeof value !== 'object') invalid('返回的评审票不正确。');
  const record = value as Record<string, unknown>;
  return {
    reviewerId: text(record.reviewerId, '评审人'),
    action: text(record.action, '评审动作'),
    ...(typeof record.comment === 'string' ? { comment: record.comment } : {}),
  };
}

function readRound(value: unknown): ExecutionRoundWire {
  if (value === null || typeof value !== 'object') invalid('返回的评审轮次不正确。');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.reviewerIds) || !Array.isArray(record.ballots)) {
    invalid('返回的评审轮次不正确。');
  }
  return {
    id: text(record.id, '轮次'),
    status: text(record.status, '轮次状态'),
    artifactVersionId: text(record.artifactVersionId, '产物版本'),
    reviewerIds: record.reviewerIds.map((item) => text(item, '评审人')),
    ballots: record.ballots.map(readBallot),
  };
}

export function readExecutionNode(value: unknown): ExecutionNodeWire {
  if (value === null || typeof value !== 'object') invalid('返回的节点不正确。');
  const record = value as Record<string, unknown>;
  if (!NODE_STATUSES.includes(record.status as NodeStatus)) invalid('返回的节点状态不正确。');
  if (!Array.isArray(record.reviewerIds) || !Array.isArray(record.artifacts)) {
    invalid('返回的节点不正确。');
  }
  if (!Array.isArray(record.rounds) || !Array.isArray(record.comments)) {
    invalid('返回的节点不正确。');
  }
  if (record.inputs !== undefined && !Array.isArray(record.inputs))
    invalid('返回的上游输入不完整，请刷新待办。');
  return {
    nodeId: text(record.nodeId, '节点'),
    taskId: text(record.taskId, '任务'),
    planId: text(record.planId, '计划'),
    revision: integer(record.revision, 1, '计划版本'),
    version: integer(record.version, 0, '节点版本'),
    status: record.status as NodeStatus,
    goal: typeof record.goal === 'string' ? record.goal : invalid('返回的目标不正确。'),
    expectedOutput: typeof record.expectedOutput === 'string' ? record.expectedOutput : '',
    assigneeId: text(record.assigneeId, '执行者'),
    reviewerIds: record.reviewerIds.map((item) => text(item, '评审人')),
    ...(typeof record.currentRoundId === 'string' ? { currentRoundId: record.currentRoundId } : {}),
    artifacts: record.artifacts.map(readArtifact),
    rounds: record.rounds.map(readRound),
    comments: record.comments.map((item) => {
      if (item === null || typeof item !== 'object') invalid('返回的评论不正确。');
      const comment = item as Record<string, unknown>;
      return { id: text(comment.id, '评论'), status: text(comment.status, '评论状态') };
    }),
    ...(typeof record.reviewOutcome === 'string' ? { reviewOutcome: record.reviewOutcome } : {}),
    ...(typeof record.blockReason === 'string' ? { blockReason: record.blockReason } : {}),
    ...(typeof record.acceptedArtifactVersionId === 'string'
      ? { acceptedArtifactVersionId: record.acceptedArtifactVersionId }
      : {}),
    ...(Array.isArray(record.inputs) ? { inputs: record.inputs.map(readUpstreamInput) } : {}),
  };
}

function readItem(value: unknown): InboxItem {
  if (value === null || typeof value !== 'object') invalid('返回的待办不正确。');
  const record = value as Record<string, unknown>;
  if (!INBOX_KINDS.includes(record.kind as InboxKind)) invalid('返回的待办类型不正确。');
  if (!INBOX_ACTIONS.includes(record.action as InboxAction)) invalid('返回的待办动作不正确。');
  return {
    id: text(record.id, '待办'),
    kind: record.kind as InboxKind,
    actorId: text(record.actorId, '待办'),
    nodeId: text(record.nodeId, '节点'),
    taskId: text(record.taskId, '任务'),
    reason: text(record.reason, '待办原因') as InboxItem['reason'],
    action: record.action as InboxAction,
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
  };
}

function readInbox(value: unknown): ExecutionInboxValue {
  if (value === null || typeof value !== 'object') invalid('返回的待办不正确。');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items) || !Array.isArray(record.nodes)) invalid('返回的待办不正确。');
  const places = readInboxPlaces(record.places);
  return {
    actorId: text(record.actorId, '待办'),
    ...(record.spaceId === undefined ? {} : { spaceId: text(record.spaceId, '空间') }),
    items: record.items.map(readItem),
    nodes: record.nodes.map(readExecutionNode),
    ...(places === undefined ? {} : { places }),
  };
}

function readStartable(value: unknown): ExecutionStartableValue {
  if (!value || typeof value !== 'object') invalid('返回的计划目录不正确。');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.plans)) invalid('返回的计划目录不正确。');
  const seen = new Set<string>();
  return {
    actorId: text(record.actorId, '成员'),
    ...(record.spaceId === undefined ? {} : { spaceId: text(record.spaceId, '空间') }),
    plans: record.plans.map((value) => {
      if (!value || typeof value !== 'object') invalid('返回的计划不正确。');
      const plan = value as Record<string, unknown>;
      const parsed = {
        taskId: text(plan.taskId, '任务'),
        planId: text(plan.planId, '计划'),
        revision: integer(plan.revision, 1, '计划版本'),
        title: text(plan.title, '计划标题'),
      };
      const key = JSON.stringify([parsed.taskId, parsed.planId, parsed.revision]);
      if (seen.has(key)) invalid('返回的计划目录包含重复版本。');
      seen.add(key);
      return parsed;
    }),
  };
}

function readCommand(value: unknown, expected: DeliveryDraft | ReviewDraft): ExecutionNodeWire {
  if (value === null || typeof value !== 'object' || !('node' in value))
    invalid('返回的节点不正确。');
  const node = readExecutionNode((value as { node: unknown }).node);
  if (
    node.taskId !== expected.taskId ||
    node.planId !== expected.planId ||
    node.revision !== expected.revision ||
    node.nodeId !== expected.nodeId
  )
    invalid('返回的工作项与请求不一致。');
  return node;
}

function readStart(value: unknown, expected: StartPlanDraft): StartPlanValue {
  if (value === null || typeof value !== 'object') invalid('返回的执行结果不正确。');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.reports)) invalid('返回的执行结果不正确。');
  return {
    disposition: text(record.disposition, '执行结果'),
    reports: record.reports.map((value) => {
      if (value === null || typeof value !== 'object') invalid('返回的执行报告不正确。');
      const report = value as Record<string, unknown>;
      if (
        !NODE_STATUSES.includes(report.status as NodeStatus) ||
        !Number.isInteger(report.revision) ||
        typeof report.upstreamAffected !== 'boolean'
      ) {
        invalid('返回的执行报告不正确。');
      }
      if (
        report.taskId !== expected.taskId ||
        report.workflowVersionId !== expected.planId ||
        report.revision !== expected.revision
      )
        invalid('返回的执行报告与计划不一致。');
      return {
        nodeId: text(report.nodeId, '节点'),
        taskId: text(report.taskId, '任务'),
        workflowVersionId: text(report.workflowVersionId, '工作流版本'),
        revision: report.revision as number,
        status: report.status as NodeStatus,
        upstreamAffected: report.upstreamAffected as boolean,
        ...(typeof report.blockReason === 'string' ? { blockReason: report.blockReason } : {}),
        ...(typeof report.acceptedArtifactVersionId === 'string'
          ? { acceptedArtifactVersionId: report.acceptedArtifactVersionId }
          : {}),
        ...(typeof report.activeRunId === 'string' ? { activeRunId: report.activeRunId } : {}),
        ...(report.reviewOutcome === 'pending' ||
        report.reviewOutcome === 'approved' ||
        report.reviewOutcome === 'changes-requested'
          ? { reviewOutcome: report.reviewOutcome }
          : {}),
      };
    }),
  };
}

/** Optional binding preserves legacy callers. Member UI must always bind a verified space. */
export function createExecutionApi(rpc: ClientConnectionRpc, spaceId?: string): ExecutionApi {
  if (spaceId !== undefined) text(spaceId, '空间');
  const scope = spaceId === undefined ? {} : { spaceId };
  function scoped<T extends { readonly spaceId?: string | undefined }>(value: T): T {
    if (spaceId !== undefined && value.spaceId !== spaceId)
      throw new ExecutionError('scope-mismatch', '返回的工作空间不一致，请重新连接。');
    return value;
  }
  async function call(endpoint: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    rejectActor(payload);
    const response = await rpc.call('/api', `zhuma-exec/${endpoint}`, payload, signal);
    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean')
      invalid('返回的执行响应不正确。');
    if (!response.ok) {
      const failure = response.error;
      if (
        !failure ||
        typeof failure.code !== 'string' ||
        typeof failure.message !== 'string' ||
        !failure.details ||
        typeof failure.details !== 'object' ||
        Array.isArray(failure.details)
      ) {
        invalid('返回的错误信息不正确。');
      }
      throw new ExecutionError(failure.code, failure.message, { ...failure.details });
    }
    return response.value;
  }
  return {
    ...(spaceId === undefined
      ? {}
      : {
          projectArtifacts: createProjectArtifactsApi(
            (query, signal) => call('project-artifacts', query, signal),
            spaceId,
          ),
          taskProgress: createTaskProgressApi(
            (query, signal) => call('task-progress', query, signal),
            spaceId,
          ),
        }),
    async startable(signal) {
      return scoped(readStartable(await call('startable', scope, signal)));
    },
    async startPlan(draft, signal) {
      if (spaceId !== undefined && draft.spaceId !== undefined && draft.spaceId !== spaceId)
        throw new ExecutionError('scope-mismatch', '计划的工作空间不一致，请重新选择。');
      return readStart(
        await call(
          'start-plan',
          {
            taskId: draft.taskId,
            planId: draft.planId,
            revision: draft.revision,
            idempotencyKey: draft.idempotencyKey,
            ...scope,
            ...(spaceId === undefined && draft.spaceId !== undefined
              ? { spaceId: draft.spaceId }
              : {}),
          },
          signal,
        ),
        draft,
      );
    },
    async inbox(signal) {
      return scoped(readInbox(await call('inbox', scope, signal)));
    },
    async revision(query, signal) {
      const payload = {
        taskId: text(query.taskId, '任务'),
        planId: text(query.planId, '计划'),
        revision: integer(query.revision, 1, '计划版本'),
        nodeId: text(query.nodeId, '节点'),
      };
      // revision's strict request has no spaceId. The bound HTTP precheck and frozen node reference remain in force.
      return readRevisionView(await call('revision', payload, signal));
    },
    async upstreamContent(query, signal) {
      signal?.throwIfAborted();
      if (spaceId === undefined)
        throw new ExecutionError('scope-required', '请先选择工作空间，再查看上游内容。');
      const expected: UpstreamContentQuery = {
        ...draftQuery(query),
        sourceNodeId: text(query.sourceNodeId, '来源节点'),
        artifactVersionId: text(query.artifactVersionId, '上游版本标识'),
        expectedArtifactVersion: integer(query.expectedArtifactVersion, 1, '上游版本'),
      };
      const value = await call(
        'upstream-content',
        {
          ...draftQuery(expected),
          sourceNodeId: expected.sourceNodeId,
          artifactVersionId: expected.artifactVersionId,
          spaceId,
        },
        signal,
      );
      signal?.throwIfAborted();
      return readUpstreamContent(value, expected, spaceId);
    },
    async readDeliveryDraft(query, signal) {
      return readSavedDeliveryDraft(await call('draft', draftQuery(query), signal));
    },
    async saveDeliveryDraft(draft, signal) {
      const payload = {
        ...draftQuery(draft),
        expectedVersion: integer(draft.expectedVersion, 0, '草稿版本'),
        idempotencyKey: text(draft.idempotencyKey, '幂等键'),
        ...(draft.text === undefined ? {} : { text: draft.text }),
        ...(draft.links === undefined ? {} : { links: [...draft.links] }),
        ...(draft.files === undefined ? {} : { files: draft.files.map((file) => ({ ...file })) }),
      };
      const saved = readSavedDeliveryDraft(await call('draft', payload, signal));
      if (saved.version !== draft.expectedVersion + 1) invalid('返回的草稿版本与本次保存不一致。');
      return saved;
    },
    async submit(draft, signal) {
      const payload = {
        taskId: draft.taskId,
        planId: draft.planId,
        revision: draft.revision,
        nodeId: draft.nodeId,
        expectedVersion: draft.expectedVersion,
        idempotencyKey: draft.idempotencyKey,
        files: [...(draft.files ?? [])],
        links: [...(draft.links ?? [])],
        ...(draft.text === undefined ? {} : { text: draft.text }),
      };
      return readCommand(await call('submit', payload, signal), draft);
    },
    async ballot(draft, signal) {
      const payload = {
        taskId: draft.taskId,
        planId: draft.planId,
        revision: draft.revision,
        nodeId: draft.nodeId,
        expectedVersion: draft.expectedVersion,
        idempotencyKey: draft.idempotencyKey,
        roundId: draft.roundId,
        artifactVersionId: draft.artifactVersionId,
        action: draft.action,
        ...(draft.comment === undefined ? {} : { comment: draft.comment }),
      };
      return readCommand(await call('ballot', payload, signal), draft);
    },
  };
}
