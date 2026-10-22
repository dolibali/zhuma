import type { ActorRef, ExecutionEngine } from '@zhuma/agent-core';
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

/**
 * Map B's internal execution classification onto an external actor.
 * A human stays human. An agent run with an expert id becomes that expert.
 * An agent run without one stays the human owner. The result is never `agent`.
 */
export function toHandoffActor(input: {
  readonly humanId: string;
  readonly runtime: 'human' | 'agent';
  readonly expertId?: string;
}): ActorRef {
  if (input.runtime === 'human') return { id: input.humanId, kind: 'human' };
  if (input.expertId !== undefined && input.expertId.trim() !== '') {
    return { id: input.expertId, kind: 'expert' };
  }
  return { id: input.humanId, kind: 'human' };
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

export type {
  AgentActivity,
  AgentExecutor,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  CancelReceipt,
  DshModelConfig,
  DshModelConfigResult,
  ExecutorCapabilities,
  ResourceGrant,
  SimulatedExecutorOptions,
} from './agent-executor.js';
export {
  DSH_DEFAULT_MODEL_ID,
  DSH_MODEL_IDS,
  DshChatExecutor,
  ExecutorNotImplementedError,
  SimulatedAgentExecutor,
  UnimplementedNativeExecutor,
  readDshModelConfig,
  selectAgentExecutor,
} from './agent-executor.js';

export type { FileProbeResult } from './file-probe.js';
export { probeRelativeFile } from './file-probe.js';

export type { DeskJournal } from './file-journal.js';
export { createFileJournal } from './file-journal.js';

export type {
  DeskContextSeed,
  DeskDependencies,
  DeskPersistence,
  DeskResult,
  DeskSeed,
} from './execution-desk.js';
export { ExecutionDesk, executionHint } from './execution-desk.js';

export type { WorkbenchServerOptions } from './workbench-server.js';
export { createWorkbenchServer } from './workbench-server.js';
