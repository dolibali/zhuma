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
export const taskProgressQuerySchema = z
  .strictObject({
    spaceId: id,
    plans: z.array(taskProgressTargetSchema).min(1).max(TASK_PROGRESS_LIMITS.plans),
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
interface KnownCounts {
  readonly target: TaskProgressTarget;
  readonly expectedNodes: number;
  readonly acceptedNodes: number;
  readonly byStatus: Readonly<Record<NodeStatus, number>>;
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
      readonly assigneeCounts: null;
      readonly resources: null;
    };
export interface TaskProgressValue {
  readonly actorId: string;
  readonly spaceId: string;
  readonly coverage: 'current-confirmed-plans';
  readonly items: readonly TaskProgressRow[];
}
