import type { WorkTask } from '@zhuma/agent-core';
import { taskBoardColumns, type TaskBoardColumn } from './task-board.js';

export interface TaskFilters {
  readonly projectId: string;
  readonly participantId: string;
  readonly stage: '' | TaskBoardColumn;
  readonly search: string;
  readonly view: 'list' | 'board';
}
export const emptyTaskFilters: TaskFilters = {
  projectId: '',
  participantId: '',
  stage: '',
  search: '',
  view: 'list',
};
export interface TaskFilterScope {
  readonly accountId: string;
  readonly spaceId: string;
}
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
function parse(raw: unknown): TaskFilters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...emptyTaskFilters };
  const value = raw as Record<string, unknown>;
  const id = (key: string) =>
    typeof value[key] === 'string' && value[key].length <= 100 ? (value[key] as string) : '';
  return {
    projectId: id('projectId'),
    participantId: id('participantId'),
    stage: taskBoardColumns.some((column) => column.id === value.stage)
      ? (value.stage as TaskBoardColumn)
      : '',
    search: typeof value.search === 'string' ? value.search.slice(0, 200) : '',
    view: value.view === 'board' ? 'board' : 'list',
  };
}
/** Local view preferences contain no permission or cached task facts. */
export function createTaskFilterStore(
  storage: () => StoragePort | undefined = () => globalThis.localStorage,
) {
  const key = (scope: TaskFilterScope) =>
    `zhuma:task-filters:v1:${encodeURIComponent(scope.accountId)}:${encodeURIComponent(scope.spaceId)}`;
  return {
    read(scope?: TaskFilterScope): TaskFilters {
      if (!scope) return { ...emptyTaskFilters };
      try {
        const raw = storage()?.getItem(key(scope));
        return raw && raw.length <= 4096 ? parse(JSON.parse(raw)) : { ...emptyTaskFilters };
      } catch {
        return { ...emptyTaskFilters };
      }
    },
    save(scope: TaskFilterScope | undefined, value: TaskFilters) {
      if (!scope) return;
      try {
        storage()?.setItem(key(scope), JSON.stringify(parse(value)));
      } catch {
        /* Storage failure cannot block work. */
      }
    },
  };
}

/** Stage is intentionally excluded: all matching plans must be read before stage filtering. */
export function taskFilterCandidates(tasks: readonly WorkTask[], filters: TaskFilters): WorkTask[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return tasks
    .filter(
      (task) =>
        (!filters.projectId || task.projectId === filters.projectId) &&
        (!filters.participantId ||
          task.ownerId === filters.participantId ||
          task.participantIds.includes(filters.participantId)) &&
        `${task.title} ${task.goal}`.toLocaleLowerCase().includes(search),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
