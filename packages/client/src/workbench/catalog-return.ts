/** The open task detail, if any, owns leaving back to the task list. */
export type CatalogReturn = (signal: AbortSignal, proceed: () => void) => void;

let current: CatalogReturn | undefined;

export function registerCatalogReturn(next: CatalogReturn): () => void {
  current = next;
  return () => {
    if (current === next) current = undefined;
  };
}

export function requestCatalogReturn(signal: AbortSignal, proceed: () => void): boolean {
  if (!current || signal.aborted) return false;
  current(signal, proceed);
  return true;
}

/**
 * Reselecting the already-open team workbench must not be a no-op while a task
 * detail is showing. With no open detail, the same panel selection still completes.
 */
export function selectRepeatedWorkbenchPanel(input: {
  target: string | null;
  active: string | null;
  workbenchId: string;
  signal: AbortSignal;
  proceed(): void;
}): boolean {
  if (input.target !== input.workbenchId || input.target !== input.active) return false;
  if (requestCatalogReturn(input.signal, input.proceed)) return true;
  input.proceed();
  return true;
}
