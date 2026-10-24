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
}

export interface ExecutionInboxValue {
  readonly actorId: string;
  readonly items: readonly InboxItem[];
  readonly nodes: readonly ExecutionNodeWire[];
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
  readonly action: 'approve' | 'request-changes';
  readonly comment?: string;
}

export interface ExecutionApi {
  inbox(signal?: AbortSignal): Promise<ExecutionInboxValue>;
  submit(draft: DeliveryDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  ballot(draft: ReviewDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
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
  return {
    actorId: text(record.actorId, '待办'),
    items: record.items.map(readItem),
    nodes: record.nodes.map(readExecutionNode),
  };
}

function readCommand(value: unknown): ExecutionNodeWire {
  if (value === null || typeof value !== 'object' || !('node' in value))
    invalid('返回的节点不正确。');
  return readExecutionNode((value as { node: unknown }).node);
}

export function createExecutionApi(rpc: ClientConnectionRpc): ExecutionApi {
  async function call(endpoint: string, payload: object, signal?: AbortSignal): Promise<unknown> {
    rejectActor(payload);
    const response = await rpc.call('/api', `zhuma-exec/${endpoint}`, payload, signal);
    if (!response.ok) throw new WorkbenchError(response.error.code, response.error.message);
    return response.value;
  }
  return {
    async inbox(signal) {
      return readInbox(await call('inbox', {}, signal));
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
      return readCommand(await call('ballot', payload, signal));
    },
  };
}
