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

/** Pipeline order for detecting a drag that jumps past review. */
const BOARD_PIPELINE = ['planning', 'attention', 'running', 'review', 'ended'] as const;

export type BoardDragDecision =
  | { readonly type: 'same' }
  | { readonly type: 'reject-no-authority' }
  | { readonly type: 'reject-bypass-review' };

/**
 * Board columns are projections of plan confirmation + execution/review facts
 * (docs: 禁止拖卡绕过评审; #34 拖动不绕过命令、依赖或评审; FR05 只显示已确认事实).
 *
 * A column drop is not a migration command. Confirming a draft, starting work,
 * submitting review, and ending a task each need their own explicit action.
 * Dragging a planning card onto another column must not save the draft as ready:
 * that confirms an immutable plan while the projection stays on the fact column
 * (usually 待处理), not the drop target. Refuse and keep the card where the facts
 * are. Never fake a stage with session state.
 */
export function boardDragDecision(
  from: TaskBoardColumn,
  to: TaskBoardColumn,
  opts: { readonly reviewRequired: boolean },
): BoardDragDecision {
  if (from === to) return { type: 'same' };
  if (from === 'unknown' || to === 'unknown') return { type: 'reject-no-authority' };

  const fromIdx = (BOARD_PIPELINE as readonly string[]).indexOf(from);
  const toIdx = (BOARD_PIPELINE as readonly string[]).indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return { type: 'reject-no-authority' };

  const reviewIdx = (BOARD_PIPELINE as readonly string[]).indexOf('review');

  // Dragging into「待评审」fakes submit-for-review.
  if (to === 'review' && from !== 'review') return { type: 'reject-bypass-review' };

  // Jumping past review when the path requires review.
  if (opts.reviewRequired && fromIdx < reviewIdx && toIdx > reviewIdx) {
    return { type: 'reject-bypass-review' };
  }

  // No drag command confirms a draft or moves execution / review / ended facts.
  return { type: 'reject-no-authority' };
}

/** True when any node requires review, or progress already shows in-review work. */
export function boardReviewRequired(
  task: {
    readonly workflows: readonly {
      readonly nodes: readonly { readonly reviewRequired: boolean }[];
    }[];
  },
  progress?: TaskProgressState,
): boolean {
  if (
    progress?.state === 'ready' &&
    progress.row.facts !== 'unknown' &&
    progress.row.byStatus &&
    progress.row.byStatus['in-review'] > 0
  )
    return true;
  return task.workflows.some((workflow) => workflow.nodes.some((node) => node.reviewRequired));
}
