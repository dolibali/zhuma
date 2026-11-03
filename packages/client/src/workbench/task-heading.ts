/** Shown when a task has neither a name nor a goal line. */
export const UNNAMED_TASK = '未命名任务';
/** Goal excerpts stay short so a missing 任务名称 does not become the whole card. */
export const TASK_HEADING_LIMIT = 36;
/** Empty 任务名称 is stored as this many characters of the goal's first line. */
export const AUTOMATIC_TASK_TITLE_LIMIT = 60;

/** True only for the title saved when 任务名称 was left empty. */
function automaticTitle(title: string, goalLine: string): boolean {
  if (!title || !goalLine) return false;
  if (title === goalLine) return true;
  return (
    goalLine.length > AUTOMATIC_TASK_TITLE_LIMIT &&
    title === goalLine.slice(0, AUTOMATIC_TASK_TITLE_LIMIT)
  );
}

/**
 * Primary heading for lists, the board, and the task page.
 * A hand-written 任务名称 stays as written. A title that is the goal, or the
 * automatic first-line excerpt saved when the name was left empty, is shown
 * as a short first line of the goal.
 */
export function taskHeading(task: { readonly title?: string; readonly goal?: string }): string {
  const title = task.title?.trim() ?? '';
  const goalLine = (task.goal?.trim() ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';
  const named = title.length > 0 && !automaticTitle(title, goalLine);
  const source = named ? title : goalLine || title;
  if (!source) return UNNAMED_TASK;
  if (!named && source.length > TASK_HEADING_LIMIT)
    return `${source.slice(0, TASK_HEADING_LIMIT)}…`;
  return source;
}
