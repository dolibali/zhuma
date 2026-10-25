import type { TaskSnapshot, TaskStatus } from '@zhuma/agent-core';

export * from './identity/index.js';

export type { InboxItemView, NodeExecutionView, InboxGroup } from './execution-view.js';
export type {
  StartablePlanWire,
  ExecutionStartableValue,
  StartPlanDraft,
  StartPlanValue,
  DeliveryDraft,
  ExecutionApi,
  ExecutionInboxValue,
  InboxPlaceWire,
  ExecutionNodeWire,
  UpstreamInputWire,
  UpstreamContentQuery,
  UpstreamContentWire,
  SavedDeliveryDraftWire,
  DeliveryDraftSave,
  ReviewDraft,
  RevisionQuery,
  RevisionContentWire,
  RevisionViewWire,
} from './execution/ExecutionApi.js';
export {
  ExecutionError,
  executionErrorMessage,
  createExecutionApi,
  readExecutionNode,
  readRevisionView,
  readSavedDeliveryDraft,
  readInboxPlaces,
} from './execution/ExecutionApi.js';
export { StartablePlansPanel } from './execution/StartablePlansPanel.js';
export { StartPlanPanel, type ExecutionPlan } from './execution/StartPlanPanel.js';
export { DeliveryPanel } from './execution/DeliveryPanel.js';
export { UpstreamInputsPanel } from './execution/UpstreamInputsPanel.js';
export { createExecutionHttpApi, type MemberExecutionScope } from './execution/http.js';
export { MemberExecutionPage } from './execution/MemberExecutionPage.js';
export { ExecutionWorkspace } from './execution/ExecutionWorkspace.js';
export { InboxPanel } from './execution/InboxPanel.js';
export { ReviewWorkspace } from './execution/ReviewWorkspace.js';
export { RevisionPanel } from './execution/RevisionPanel.js';
export { RevisionWorkspace } from './execution/RevisionWorkspace.js';
export {
  INBOX_ACTION_LABELS,
  INBOX_KIND_LABELS,
  NODE_STATUS_LABELS,
  createInboxItemView,
  INBOX_GROUPS,
  inboxItemGroup,
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
