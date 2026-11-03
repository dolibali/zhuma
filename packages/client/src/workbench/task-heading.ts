/** Shown when a task has neither a name nor a goal line. */
export const UNNAMED_TASK = '未命名任务';
/** Goal excerpts stay short so a missing 任务名称 does not become the whole card. */
export const TASK_HEADING_LIMIT = 36;

/**
 * Primary heading for lists, the board, and the task page.
 * A title that is not just the goal (or the automatic goal excerpt saved when
 * 任务名称 was left empty) is the task name. Otherwise the heading is a short
 * first line of the goal.
 */
export function taskHeading(task: { readonly title?: string; readonly goal?: string }): string {
  const title = task.title?.trim() ?? '';
  const goalLine = (task.goal?.trim() ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';
  const distinct =
    title.length > 0 && goalLine.length > 0 && title !== goalLine && !goalLine.startsWith(title);
  const source = distinct ? title : goalLine || title;
  if (!source) return UNNAMED_TASK;
  if (!distinct && source.length > TASK_HEADING_LIMIT)
    return `${source.slice(0, TASK_HEADING_LIMIT)}…`;
  return source;
}
