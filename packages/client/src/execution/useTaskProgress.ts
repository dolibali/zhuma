import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppliedPlan } from '@zhuma/agent-core';
import { executionErrorMessage } from './ExecutionApi.js';
import type { TaskProgressApi, TaskProgressRow, TaskProgressTarget } from './task-progress.js';

export type TaskProgressState =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'ready'; readonly row: TaskProgressRow };

/** The local confirmed catalog supplies an exact ref, never an automatic fallback on conflict. */
export function latestTaskPlan(
  plans: readonly AppliedPlan[],
  taskId: string,
): AppliedPlan | undefined {
  const candidates = plans.filter((plan) => plan.taskId === taskId);
  const revision = Math.max(0, ...candidates.map((plan) => plan.revision));
  const latest = candidates.filter((plan) => plan.revision === revision);
  return latest.length === 1 ? latest[0] : undefined;
}

/** One sequential metadata queue for the visible surface; no background polling or node reports. */
export function useTaskProgress(
  api: TaskProgressApi | undefined,
  spaceId: string | undefined,
  targets: readonly TaskProgressTarget[],
  refreshToken: unknown,
) {
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const identity = JSON.stringify(targets);
  const current = useRef({ api, spaceId, identity, reload, refreshToken });
  if (
    current.current.api !== api ||
    current.current.spaceId !== spaceId ||
    current.current.identity !== identity ||
    current.current.reload !== reload ||
    current.current.refreshToken !== refreshToken
  ) {
    current.current = { api, spaceId, identity, reload, refreshToken };
  }
  const generation = current.current;
  const [snapshot, setSnapshot] = useState<{
    generation: typeof generation;
    items: Readonly<Record<string, TaskProgressState>>;
  }>();
  useEffect(() => {
    if (!api || !spaceId) return;
    const service = api,
      selectedSpace = spaceId;
    const controller = new AbortController();
    const valid = () => !controller.signal.aborted && current.current === generation;
    const plans: TaskProgressTarget[] = JSON.parse(identity);
    const items: Record<string, TaskProgressState> = {};
    async function read() {
      for (let index = 0; index < plans.length && valid(); index += 5) {
        const batch = plans.slice(index, index + 5);
        try {
          const value = await service.read(
            { spaceId: selectedSpace, plans: batch },
            controller.signal,
          );
          if (!valid()) return;
          for (const row of value.items) items[row.target.taskId] = { state: 'ready', row };
        } catch (error) {
          if (!valid()) return;
          for (const target of batch)
            items[target.taskId] = { state: 'error', message: executionErrorMessage(error) };
        }
        if (valid()) setSnapshot({ generation, items: { ...items } });
      }
    }
    void read();
    return () => controller.abort();
  }, [generation, api, spaceId, identity]);
  return {
    refresh,
    get(taskId: string): TaskProgressState | undefined {
      if (!api || !spaceId) return undefined;
      return snapshot?.generation === generation
        ? (snapshot.items[taskId] ?? { state: 'loading' })
        : { state: 'loading' };
    },
  };
}
