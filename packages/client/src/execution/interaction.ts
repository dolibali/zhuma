import { useEffect, useRef, useState } from 'react';
import type { ExecutionNodeWire } from './ExecutionApi.js';
import { executionErrorMessage } from './ExecutionApi.js';

export function nodeIdentity(node: ExecutionNodeWire): string {
  return JSON.stringify([node.taskId, node.planId, node.revision, node.nodeId]);
}
export function reviewIdentity(node: ExecutionNodeWire): string {
  return JSON.stringify([nodeIdentity(node), node.currentRoundId ?? null]);
}

/** Remount forms on API/session or item change, before an old form can be used. */
export function useFormKey(api: object, identity: string): number {
  const scope = useRef({ api, identity, generation: 0 });
  if (scope.current.api !== api || scope.current.identity !== identity) {
    scope.current = { api, identity, generation: scope.current.generation + 1 };
  }
  return scope.current.generation;
}

/** One explicit command per form. A cancelled lifetime can never apply a receipt. */
export function useExecutionCommand() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const retry = useRef({ fingerprint: '', key: '' });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = undefined;
    };
  }, []);
  async function run<T>(
    payload: object,
    invoke: (key: string, signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
  ) {
    if (!mounted.current || active.current) return;
    const fingerprint = JSON.stringify(payload);
    if (retry.current.fingerprint !== fingerprint) {
      retry.current = { fingerprint, key: crypto.randomUUID() };
    }
    const request = new AbortController();
    active.current = request;
    const current = () => mounted.current && active.current === request && !request.signal.aborted;
    setPending(true);
    setError('');
    try {
      const value = await invoke(retry.current.key, request.signal);
      if (!current()) return;
      retry.current = { fingerprint: '', key: '' };
      apply(value);
    } catch (caught) {
      if (current()) setError(executionErrorMessage(caught));
    } finally {
      if (current()) {
        active.current = undefined;
        setPending(false);
      }
    }
  }
  return { run, pending, error, setError };
}
