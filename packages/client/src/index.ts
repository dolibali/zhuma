import type { TaskSnapshot, TaskStatus } from '@zhuma/agent-core';

export * from './identity/index.js';

export type { InboxItemView, NodeExecutionView } from './execution-view.js';
export type {
  DeliveryDraft,
  ExecutionApi,
  ExecutionInboxValue,
  ExecutionNodeWire,
  ReviewDraft,
} from './execution/ExecutionApi.js';
export { createExecutionApi, readExecutionNode } from './execution/ExecutionApi.js';
export { DeliveryPanel } from './execution/DeliveryPanel.js';
export { ExecutionWorkspace } from './execution/ExecutionWorkspace.js';
export { InboxPanel } from './execution/InboxPanel.js';
export { ReviewWorkspace } from './execution/ReviewWorkspace.js';
export {
  INBOX_ACTION_LABELS,
  INBOX_KIND_LABELS,
  NODE_STATUS_LABELS,
  createInboxItemView,
  createNodeExecutionView,
} from './execution-view.js';

export type { AgentWorkspaceView } from './agent-workspace-view.js';
export { createAgentWorkspaceView, phaseReached } from './agent-workspace-view.js';

export const VIEW_MODES = ['chat', 'run', 'compose'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿',
  ready: '待执行',
  running: '执行中',
  'waiting-for-input': '待补充信息',
  verifying: '验证中',
  'awaiting-review': '待人工审查',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '中断待核对',
};

export interface TaskViewModel {
  readonly taskId: string;
  readonly title: string;
  readonly view: ViewMode;
  readonly status: TaskStatus;
  readonly statusLabel: string;
  readonly planRevision: number;
}

/** A read-only projection: changing view cannot start work or change execution facts. */
export function createTaskView(task: TaskSnapshot, view: ViewMode): TaskViewModel {
  return {
    taskId: task.id,
    title: task.title,
    view,
    status: task.status,
    statusLabel: STATUS_LABELS[task.status],
    planRevision: task.planRevision,
  };
}
