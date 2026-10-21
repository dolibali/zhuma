import type { ExecutionEngine } from '@zhuma/agent-core';
import type { ContextPack } from '@zhuma/context';

/** Future adapters implement this port; no DSH or CLI is executed by this scaffold. */
export interface ExecutionRequest {
  readonly taskId: string;
  readonly instruction: string;
  readonly workspaceDirectory: string;
  readonly context: ContextPack;
}

export type ExecutionResult =
  | { readonly status: 'completed'; readonly summary: string }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'cancelled'; readonly reason: string };

export interface ExecutionPort {
  readonly engine: ExecutionEngine;
  execute(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
}

/** Explicit selection only; a missing executor must never silently change engines. */
export function selectExecutor(
  engine: ExecutionEngine,
  executors: readonly ExecutionPort[],
): ExecutionPort {
  const matches = executors.filter((executor) => executor.engine === engine);
  if (matches.length === 0) throw new Error(`Executor is not configured: ${engine}`);
  if (matches.length !== 1) throw new Error(`Executor is registered more than once: ${engine}`);
  const executor = matches[0];
  if (!executor) throw new Error(`Executor is not configured: ${engine}`);
  return executor;
}
