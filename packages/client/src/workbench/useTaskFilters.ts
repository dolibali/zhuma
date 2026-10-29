import { useMemo, useState } from 'react';
import { createTaskFilterStore, type TaskFilters, type TaskFilterScope } from './task-filters.js';

/** A changed account/space reads its own preferences before rendering any old selection. */
export function useTaskFilters(scope?: TaskFilterScope) {
  const store = useMemo(() => createTaskFilterStore(), []);
  const key = JSON.stringify(scope ? [scope.accountId, scope.spaceId] : []);
  const restored = useMemo(() => store.read(scope), [store, key]);
  const [selection, setSelection] = useState({ key, value: restored });
  const value = selection.key === key ? selection.value : restored;
  return [
    value,
    (next: TaskFilters) => {
      setSelection({ key, value: next });
      store.save(scope, next);
    },
  ] as const;
}
