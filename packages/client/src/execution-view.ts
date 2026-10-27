import type {
  InboxAction,
  InboxItem,
  InboxKind,
  NodeExecutionReport,
  NodeStatus,
} from '@zhuma/agent-core';

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

export const INBOX_ACTION_LABELS: Record<InboxAction, string> = {
  submit: '提交产物',
  revise: '提交新版本',
  'continue-handling': '继续处理',
  'provide-input': '补充输入',
  'retry-or-take-back': '重试或接回',
  review: '提交评审',
  confirm: '确认',
};

export const INBOX_GROUPS = [
  { id: 'deliver', label: '待我交付' },
  { id: 'revise', label: '退回修改' },
  { id: 'review', label: '待我评审' },
  { id: 'active', label: '处理中' },
  { id: 'attention', label: '补充与确认' },
  { id: 'other', label: '其他工作项' },
] as const;
export type InboxGroup = (typeof INBOX_GROUPS)[number]['id'];

/** Groups only service-provided items. Node state alone never creates a human obligation. */
export function inboxItemGroup(item: InboxItem): InboxGroup {
  if (item.kind === 'deliver' && item.action === 'submit' && item.reason === 'assignee-delivery')
    return 'deliver';
  if (item.kind === 'deliver' && item.action === 'revise' && item.reason === 'revision-delivery')
    return 'revise';
  if (item.kind === 'review' && item.action === 'review' && item.reason === 'review-assigned')
    return 'review';
  if (
    item.kind === 'deliver' &&
    item.action === 'continue-handling' &&
    item.reason === 'agent-assisted-delivery'
  )
    return 'active';
  if (
    (item.kind === 'confirm' &&
      item.action === 'confirm' &&
      ['parent-confirmation', 'explicit-confirmation'].includes(item.reason)) ||
    (item.kind === 'deliver' &&
      item.action === 'provide-input' &&
      ['input-required', 'owner-input-required'].includes(item.reason)) ||
    (item.kind === 'deliver' &&
      item.action === 'retry-or-take-back' &&
      ['retry-or-take-back', 'owner-take-back'].includes(item.reason))
  )
    return 'attention';
  return 'other';
}

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
  readonly action: InboxAction;
  readonly actionLabel: string;
  readonly detail?: string;
}

/** Handoffs combine a node title and work in goal; only the display heading is shortened. */
export function createExecutionGoalView(goal: string): { title: string; description?: string } {
  const title = goal.split(/\r?\n/, 1)[0]!.trim().slice(0, 160) || '工作项';
  return { title, ...(goal !== title ? { description: goal } : {}) };
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
    action: item.action,
    actionLabel: INBOX_ACTION_LABELS[item.action],
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
  };
}
