import { z } from 'zod';
import { WorkTaskSchema, type NodeStatus } from '@zhuma/agent-core';

export const TASK_PROGRESS_LIMITS = Object.freeze({
  plans: 5,
  nodesPerPlan: 80,
  nodeReads: 400,
  requestBytes: 8192,
  responseBytes: 128 * 1024,
});
const id = WorkTaskSchema.shape.id;
export const taskProgressTargetSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
});
export type TaskProgressTarget = z.infer<typeof taskProgressTargetSchema>;
/** Opt-in for per-node phase and workflow drive. Absent requests keep the summary. */
export const TASK_PROGRESS_DETAIL = 'nodes' as const;
export const taskProgressQuerySchema = z
  .strictObject({
    spaceId: id,
    plans: z.array(taskProgressTargetSchema).min(1).max(TASK_PROGRESS_LIMITS.plans),
    detail: z.literal(TASK_PROGRESS_DETAIL).optional(),
  })
  .refine((value) => new Set(value.plans.map((plan) => plan.taskId)).size === value.plans.length)
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= TASK_PROGRESS_LIMITS.requestBytes);
export type TaskProgressQuery = z.infer<typeof taskProgressQuerySchema>;

export interface TaskProgressResources {
  /** Persisted metadata only, never a native readiness or drain certificate. */
  readonly authorHeld: number;
  readonly reviewHeld: number;
  readonly stopRequested: number;
}
/** Per-node phase already read for the counts. Titles stay on the confirmed plan. */
export interface TaskProgressNodeState {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly authorHeld: number;
  readonly assignee: 'human' | 'expert';
}
/**
 * Present only when the request opts into `detail: 'nodes'`.
 * `running` is a live arm in this process. `requires-resume` is persisted
 * intent after that arm is gone. Resource holds stay on `resources`.
 */
export type TaskProgressWorkflow =
  'inactive' | 'running' | 'stopping' | 'paused' | 'completed' | 'requires-resume';
interface KnownCounts {
  readonly target: TaskProgressTarget;
  readonly expectedNodes: number;
  readonly acceptedNodes: number;
  readonly byStatus: Readonly<Record<NodeStatus, number>>;
  /** Omitted on the summary protocol. Null only for an unknown row that opted in. */
  readonly nodeStatuses?: readonly TaskProgressNodeState[] | null;
  /** Omitted on the summary protocol. Null until a plan receipt exists. */
  readonly workflow?: TaskProgressWorkflow | null;
  readonly assigneeCounts: { readonly human: number; readonly expert: number };
  readonly resources: TaskProgressResources;
}
export type TaskProgressUnknownReason =
  | 'empty-plan'
  | 'unsupported-child-workflow'
  | 'invalid-plan'
  | 'node-limit'
  | 'incomplete-plan'
  | 'invalid-node'
  | 'invalid-state'
  | 'invalid-accepted';
export type TaskProgressRow =
  | (KnownCounts & {
      readonly facts: 'not-started';
      readonly delivery: 'pending';
    })
  | (KnownCounts & {
      readonly facts: 'present';
      readonly delivery: 'pending' | 'all-accepted' | 'cancelled' | 'mixed-terminal';
      readonly reason?: 'upstream-affected';
    })
  | {
      readonly target: TaskProgressTarget;
      readonly facts: 'unknown';
      readonly reason: TaskProgressUnknownReason;
      readonly delivery: 'unknown';
      readonly expectedNodes: number | null;
      /** No partial ratio, execution counts or cleanup claims on incomplete facts. */
      readonly acceptedNodes: null;
      readonly byStatus: null;
      readonly nodeStatuses?: null;
      readonly workflow?: null;
      readonly assigneeCounts: null;
      readonly resources: null;
    };
export interface TaskProgressValue {
  readonly actorId: string;
  readonly spaceId: string;
  readonly coverage: 'current-confirmed-plans';
  readonly items: readonly TaskProgressRow[];
}
