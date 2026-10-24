import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import {
  INBOX_ACTIONS,
  INBOX_KINDS,
  NODE_STATUSES,
  WorkbenchError,
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

export type UpstreamInputWire =
  | {
      readonly access: 'visible';
      readonly blocking: boolean;
      readonly sourceNodeId: string;
      readonly sourceGoal?: string;
      readonly version: number;
      readonly name: string;
    }
  | {
      readonly access: 'pending';
      readonly pending: 'none' | 'replaced';
      readonly blocking: boolean;
      readonly sourceNodeId: string;
      readonly message: string;
    }
  | {
      readonly access: 'hidden';
      readonly blocking: boolean;
      readonly count: number;
      readonly message: string;
    };

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
export interface EventsRequest {
  taskId: string;
  planId: string;
  revision: number;
  nodeId: string;
  after: number;
  seenEventIds?: readonly string[];
}
export interface ExecutionInboxValue {
  readonly actorId: string;
  readonly items: readonly InboxItem[];
  readonly nodes: readonly ExecutionNodeWire[];
  readonly places?: readonly InboxPlace[];
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
  readonly unresolvedCommentIds?: readonly string[];
}

export interface SavedDeliveryDraft {
  readonly version: number;
  readonly text: string;
  readonly links: readonly string[];
  readonly files: readonly ArtifactFileRef[];
}

export interface DeliveryDraftWrite {
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

export interface ExecutionApi {
  inbox(signal?: AbortSignal): Promise<ExecutionInboxValue>;
  inboxCounts(signal?: AbortSignal): Promise<InboxCounts>;
  events(
    query: EventsRequest,
    signal?: AbortSignal,
  ): Promise<{ readonly events: readonly ExecutionEvent[] }>;
  submit(draft: DeliveryDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  ballot(draft: ReviewDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  revision(
    query: { taskId: string; planId: string; revision: number; nodeId: string },
    signal?: AbortSignal,
  ): Promise<RevisionViewWire>;
  readDeliveryDraft(
    query: { taskId: string; planId: string; revision: number; nodeId: string },
    signal?: AbortSignal,
  ): Promise<SavedDeliveryDraft>;
  saveDeliveryDraft(draft: DeliveryDraftWrite, signal?: AbortSignal): Promise<SavedDeliveryDraft>;
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

const ACTOR_FIELD_DEPTH_LIMIT = 32;

function rejectActor(value: unknown): void {
  const seen = new Set<unknown>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > ACTOR_FIELD_DEPTH_LIMIT) {
      throw new WorkbenchError('validation', '请求嵌套太深。');
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
        throw new WorkbenchError('actor-from-body', '不能在请求里指定操作者。');
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function invalid(message: string): never {
  throw new WorkbenchError('validation', message);
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
    version:
      typeof record.version === 'number' ? record.version : invalid('返回的产物版本不正确。'),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
  };
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
  return {
    nodeId: text(record.nodeId, '节点'),
    taskId: text(record.taskId, '任务'),
    planId: text(record.planId, '计划'),
    revision:
      typeof record.revision === 'number' ? record.revision : invalid('返回的计划版本不正确。'),
    version:
      typeof record.version === 'number' ? record.version : invalid('返回的节点版本不正确。'),
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

function pendingUpstreamMessage(kind: 'none' | 'replaced', sourceNodeId: string): string {
  return kind === 'none'
    ? `上游节点 ${sourceNodeId} 尚无已接受版本。`
    : `上游节点 ${sourceNodeId} 已有新的已接受版本，当前引用的版本已被取代。`;
}

function hiddenUpstreamMessage(count: number): string {
  return `有 ${count} 个上游来源你没有权限查看。`;
}

function readUpstreamInput(value: unknown): UpstreamInputWire {
  if (value === null || typeof value !== 'object') invalid('返回的上游产物不正确。');
  const record = value as Record<string, unknown>;
  const blocking = record.blocking === true;
  if (record.access === 'hidden') {
    if (
      typeof record.count !== 'number' ||
      !Number.isSafeInteger(record.count) ||
      record.count < 1
    ) {
      invalid('返回的上游产物不正确。');
    }
    return {
      access: 'hidden',
      blocking,
      count: record.count,
      message: hiddenUpstreamMessage(record.count),
    };
  }
  const sourceNodeId = text(record.sourceNodeId, '来源节点');
  if (record.access === 'pending') {
    if (record.pending !== 'none' && record.pending !== 'replaced') {
      invalid('返回的上游产物不正确。');
    }
    return {
      access: 'pending',
      pending: record.pending,
      blocking,
      sourceNodeId,
      message: pendingUpstreamMessage(record.pending, sourceNodeId),
    };
  }
  if (record.access !== 'visible' || typeof record.version !== 'number') {
    invalid('返回的上游产物不正确。');
  }
  const sourceGoal = typeof record.sourceGoal === 'string' ? record.sourceGoal.trim() : '';
  return {
    access: 'visible',
    blocking,
    sourceNodeId,
    ...(sourceGoal === '' ? {} : { sourceGoal }),
    version: record.version,
    name: text(record.name, '产物'),
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
  const places = Array.isArray(record.places) ? record.places : [];
  return {
    actorId: text(record.actorId, '待办'),
    items: record.items.map(readItem),
    nodes: record.nodes.map(readExecutionNode),
    places: places.map(readPlace),
  };
}

function readPlace(value: unknown): InboxPlace {
  if (value === null || typeof value !== 'object') invalid('返回的待办不正确。');
  const record = value as Record<string, unknown>;
  return {
    itemId: text(record.itemId, '待办'),
    taskPath: typeof record.taskPath === 'string' ? record.taskPath : '',
    ownerName: typeof record.ownerName === 'string' ? record.ownerName : '',
  };
}

/** Drop a repeated eventId and keep sequence order. Unknown fields are not copied. */
export function mergeExecutionEvents(events: readonly ExecutionEvent[]): readonly ExecutionEvent[] {
  const seen = new Set<string>();
  const unique: ExecutionEvent[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    unique.push(event);
  }
  return unique.sort(
    (left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
  );
}

export function readExecutionEvents(value: unknown): {
  readonly events: readonly ExecutionEvent[];
} {
  if (value === null || typeof value !== 'object') invalid('返回的执行事件不正确。');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.events)) invalid('返回的执行事件不正确。');
  return { events: mergeExecutionEvents(record.events.map(readExecutionEvent)) };
}

function readExecutionEvent(value: unknown): ExecutionEvent {
  if (value === null || typeof value !== 'object') invalid('返回的执行事件不正确。');
  const record = value as Record<string, unknown>;
  if (
    typeof record.sequence !== 'number' ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1
  ) {
    invalid('返回的执行事件不正确。');
  }
  if (typeof record.version !== 'number' || !Number.isSafeInteger(record.version)) {
    invalid('返回的执行事件不正确。');
  }
  return {
    eventId: text(record.eventId, '事件'),
    sequence: record.sequence,
    occurredAt: text(record.occurredAt, '事件'),
    actorId: text(record.actorId, '事件'),
    type: text(record.type, '事件'),
    nodeId: text(record.nodeId, '节点'),
    status: text(record.status, '事件'),
    version: record.version,
  };
}

function readInboxCounts(value: unknown): InboxCounts {
  if (value === null || typeof value !== 'object') invalid('返回的待办计数不正确。');
  const record = value as Record<string, unknown>;
  const count = (field: string) => {
    const number = record[field];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
      invalid('返回的待办计数不正确。');
    }
    return number as number;
  };
  return { deliver: count('deliver'), review: count('review'), confirm: count('confirm') };
}

type RevisionNoteWire = RevisionViewWire['notes'][number];

function readRevisionContent(value: unknown): RevisionContentWire {
  if (value === null || typeof value !== 'object') invalid('返回的产物不正确。');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.links) || !Array.isArray(record.files)) invalid('返回的产物不正确。');
  return {
    id: text(record.id, '产物'),
    version:
      typeof record.version === 'number' ? record.version : invalid('返回的产物版本不正确。'),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    links: record.links.map((item) => text(item, '链接')),
    files: record.files.map((item) => {
      if (item === null || typeof item !== 'object') invalid('返回的文件不正确。');
      const file = item as Record<string, unknown>;
      if (typeof file.byteSize !== 'number') invalid('返回的文件大小不正确。');
      return {
        id: text(file.id, '文件'),
        mediaType: text(file.mediaType, '文件类型'),
        byteSize: file.byteSize,
      };
    }),
  };
}

function readRevisionNote(value: unknown): RevisionNoteWire {
  if (value === null || typeof value !== 'object') invalid('返回的退回意见不正确。');
  const record = value as Record<string, unknown>;
  if (typeof record.body !== 'string' || !Array.isArray(record.citedCommentIds)) {
    invalid('返回的退回意见不正确。');
  }
  return {
    id: text(record.id, '退回意见'),
    reviewerName: text(record.reviewerName, '评审人'),
    body: record.body,
    artifactVersionId: text(record.artifactVersionId, '产物版本'),
    citedCommentIds: record.citedCommentIds.map((item) => text(item, '评论')),
  };
}

export function readRevisionView(value: unknown): RevisionViewWire {
  if (value === null || typeof value !== 'object' || !('view' in value)) {
    invalid('返回的退回意见不正确。');
  }
  const view = (value as { view: unknown }).view;
  if (view === null || typeof view !== 'object') invalid('返回的退回意见不正确。');
  const record = view as Record<string, unknown>;
  if (!Array.isArray(record.notes)) invalid('返回的退回意见不正确。');
  return {
    ...(record.reviewed === undefined ? {} : { reviewed: readRevisionContent(record.reviewed) }),
    ...(record.previous === undefined ? {} : { previous: readRevisionContent(record.previous) }),
    notes: record.notes.map(readRevisionNote),
  };
}

export function readSavedDeliveryDraft(value: unknown): SavedDeliveryDraft {
  if (value === null || typeof value !== 'object') invalid('返回的交付草稿不正确。');
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'number' || !Number.isSafeInteger(record.version)) {
    invalid('返回的交付草稿不正确。');
  }
  if (
    typeof record.text !== 'string' ||
    !Array.isArray(record.links) ||
    !Array.isArray(record.files)
  ) {
    invalid('返回的交付草稿不正确。');
  }
  return {
    version: record.version,
    text: record.text,
    links: record.links.map((item) => text(item, '链接')),
    files: record.files.map(readDraftFile),
  };
}

function readDraftFile(value: unknown): ArtifactFileRef {
  if (value === null || typeof value !== 'object') invalid('返回的文件信息不正确。');
  const file = value as Record<string, unknown>;
  if (typeof file.byteSize !== 'number' || typeof file.uploadComplete !== 'boolean') {
    invalid('返回的文件信息不正确。');
  }
  return {
    id: text(file.id, '文件'),
    mediaType: text(file.mediaType, '媒体类型'),
    byteSize: file.byteSize,
    checksum: text(file.checksum, '校验'),
    accessPolicyId: text(file.accessPolicyId, '访问策略'),
    uploadComplete: file.uploadComplete,
  };
}

function readCommand(value: unknown): ExecutionNodeWire {
  if (value === null || typeof value !== 'object' || !('node' in value))
    invalid('返回的节点不正确。');
  return readExecutionNode((value as { node: unknown }).node);
}

const TRANSPORT_FAILURE = /^transport failure for \/api\/zhuma-exec\/[A-Za-z0-9_$.-]+: HTTP (\d+)$/;

function transportFailure(error: unknown): WorkbenchError | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = TRANSPORT_FAILURE.exec(error.message)?.[1];
  if (status === '401') return new WorkbenchError('unauthenticated', '请先登录。');
  if (status === '403') return new WorkbenchError('untrusted-request', '这次请求不可信。');
  if (status === '413') return new WorkbenchError('body-too-large', '请求过大，请减少内容。');
  if (status === '408')
    return new WorkbenchError('body-timeout', '请求没有在时间内传完，请再试一次。');
  return undefined;
}

export function createExecutionApi(rpc: ClientConnectionRpc): ExecutionApi {
  async function call(endpoint: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    rejectActor(payload);
    let response;
    try {
      response = await rpc.call('/api', `zhuma-exec/${endpoint}`, payload, signal);
    } catch (error) {
      const mapped = transportFailure(error);
      if (mapped) throw mapped;
      throw error;
    }
    if (!response.ok) throw new WorkbenchError(response.error.code, response.error.message);
    return response.value;
  }
  return {
    async inbox(signal) {
      return readInbox(await call('inbox', {}, signal));
    },
    async inboxCounts(signal) {
      return readInboxCounts(await call('inbox-counts', {}, signal));
    },
    async events(query, signal) {
      return readExecutionEvents(
        await call(
          'events',
          {
            taskId: query.taskId,
            planId: query.planId,
            revision: query.revision,
            nodeId: query.nodeId,
            after: query.after,
            ...(query.seenEventIds === undefined ? {} : { seenEventIds: [...query.seenEventIds] }),
          },
          signal,
        ),
      );
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
      return readCommand(await call('submit', payload, signal));
    },
    async revision(query, signal) {
      const payload = {
        taskId: query.taskId,
        planId: query.planId,
        revision: query.revision,
        nodeId: query.nodeId,
      };
      return readRevisionView(await call('revision', payload, signal));
    },
    async readDeliveryDraft(query, signal) {
      return readSavedDeliveryDraft(
        await call(
          'draft',
          {
            taskId: query.taskId,
            planId: query.planId,
            revision: query.revision,
            nodeId: query.nodeId,
          },
          signal,
        ),
      );
    },
    async saveDeliveryDraft(draft, signal) {
      return readSavedDeliveryDraft(
        await call(
          'draft',
          {
            taskId: draft.taskId,
            planId: draft.planId,
            revision: draft.revision,
            nodeId: draft.nodeId,
            expectedVersion: draft.expectedVersion,
            idempotencyKey: draft.idempotencyKey,
            files: [...(draft.files ?? [])],
            links: [...(draft.links ?? [])],
            ...(draft.text === undefined ? {} : { text: draft.text }),
          },
          signal,
        ),
      );
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
        ...(draft.unresolvedCommentIds === undefined
          ? {}
          : { unresolvedCommentIds: [...draft.unresolvedCommentIds] }),
      };
      return readCommand(await call('ballot', payload, signal));
    },
  };
}
