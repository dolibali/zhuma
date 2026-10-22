import type { InboxItem, InboxKind, NodeExecutionReport, NodeStatus } from '@zhuma/agent-core';

/** Labels for the node state machine. These do not replace task snapshot labels. */
export const NODE_STATUS_LABELS: Record<NodeStatus, string> = {
  draft: '草稿',
  blocked: '等待前置',
  ready: '待处理',
  running: '执行中',
  'waiting-for-input': '等待输入',
  'child-workflow': '子工作流处理中',
  'in-review': '待评审',
  'needs-revision': '需修改',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const INBOX_KIND_LABELS: Record<InboxKind, string> = {
  deliver: '待我交付',
  review: '待我评审',
  confirm: '待我确认',
};

export interface NodeExecutionView {
  readonly nodeId: string;
  readonly taskId: string;
  readonly workflowVersionId: string;
  readonly revision: number;
  readonly status: NodeStatus;
  readonly statusLabel: string;
  readonly upstreamAffected: boolean;
  readonly blockReason?: string;
  readonly acceptedArtifactVersionId?: string;
  readonly activeRunId?: string;
  readonly reviewOutcome?: NodeExecutionReport['reviewOutcome'];
}

export interface InboxItemView {
  readonly id: string;
  readonly kind: InboxKind;
  readonly kindLabel: string;
  readonly actorId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly reason: string;
}

/** Read-only projection. Rendering a node does not start work or change execution facts. */
export function createNodeExecutionView(report: NodeExecutionReport): NodeExecutionView {
  return {
    nodeId: report.nodeId,
    taskId: report.taskId,
    workflowVersionId: report.workflowVersionId,
    revision: report.revision,
    status: report.status,
    statusLabel: NODE_STATUS_LABELS[report.status],
    upstreamAffected: report.upstreamAffected,
    ...(report.blockReason !== undefined ? { blockReason: report.blockReason } : {}),
    ...(report.acceptedArtifactVersionId !== undefined
      ? { acceptedArtifactVersionId: report.acceptedArtifactVersionId }
      : {}),
    ...(report.activeRunId !== undefined ? { activeRunId: report.activeRunId } : {}),
    ...(report.reviewOutcome !== undefined ? { reviewOutcome: report.reviewOutcome } : {}),
  };
}

/** Read-only inbox row. The label is not a second source of execution truth. */
export function createInboxItemView(item: InboxItem): InboxItemView {
  return {
    id: item.id,
    kind: item.kind,
    kindLabel: INBOX_KIND_LABELS[item.kind],
    actorId: item.actorId,
    nodeId: item.nodeId,
    taskId: item.taskId,
    reason: item.reason,
  };
}
