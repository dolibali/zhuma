import type { TaskProgressState } from '../execution/useTaskProgress.js';

/** Toolbar for a confirmed member task. Viewing never starts a plan. */
export function confirmedPlanAction(
  progress: TaskProgressState | undefined,
  canStart: boolean,
): 'start' | 'view' {
  if (!canStart || progress?.state !== 'ready' || progress.row.facts !== 'not-started')
    return 'view';
  return 'start';
}
