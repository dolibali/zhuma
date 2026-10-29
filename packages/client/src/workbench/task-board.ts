import type { WorkTask } from '@zhuma/agent-core';
import type { TaskProgressState } from '../execution/useTaskProgress.js';

export const taskBoardColumns = [
  { id: 'planning', label: '规划中' },
  { id: 'attention', label: '待处理' },
  { id: 'running', label: '进行中' },
  { id: 'review', label: '待评审' },
  { id: 'ended', label: '已结束' },
  { id: 'unknown', label: '待核实' },
] as const;
export type TaskBoardColumn = (typeof taskBoardColumns)[number]['id'];

/** Read-only grouping of the same task/confirmed-plan projection used by the list. */
export function taskBoardColumn(
  task: Pick<WorkTask, 'status'>,
  confirmed: boolean,
  progress?: TaskProgressState,
): TaskBoardColumn {
  if (!confirmed) return task.status === 'draft' ? 'planning' : 'unknown';
  if (progress?.state !== 'ready' || progress.row.facts === 'unknown') return 'unknown';
  const row = progress.row;
  if (row.facts === 'not-started') return 'attention';
  if (row.delivery !== 'pending') return 'ended';
  if (row.byStatus['in-review']) return 'review';
  if (row.byStatus['needs-revision'] || row.byStatus['waiting-for-input'] || row.byStatus.failed)
    return 'attention';
  return row.byStatus.running ? 'running' : 'attention';
}
