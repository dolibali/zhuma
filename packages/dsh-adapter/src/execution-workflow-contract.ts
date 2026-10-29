import { z } from 'zod';
import { remoteWorkflowIntentSchema, REMOTE_WORKFLOW_LIMITS } from '@zhuma/agent-core';
import { executionWorkspaceSchema } from './execution-run-state.js';
import type { ExecutionReviewScope } from './execution-review-contract.js';
import type {
  WorkflowReviewCandidate,
  WorkflowReviewAttention,
} from './execution-workflow-reviews.js';

export const WORKFLOW_EXECUTION_LIMITS = Object.freeze({
  commandReceipts: 128,
  starts: 512,
  bytes: 65_536,
  concurrent: 4,
  owners: 256,
});
const id = z.string().min(1).max(200);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = natural.refine((value) => value > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const workflowLocationSchema = z.strictObject({
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
});
export type WorkflowLocation = z.infer<typeof workflowLocationSchema>;
export const workflowDefaultsSchema = z.strictObject({
  model: z.strictObject({
    provider: id,
    model: id,
    reasoningEffort: id.optional(),
    maxTokens: positive.max(65_536),
  }),
  tools: z.enum(['text-only', 'accepted-input-reader', 'local-tools']),
  workspace: executionWorkspaceSchema,
});
export type WorkflowRunDefaults = z.infer<typeof workflowDefaultsSchema>;
const budgetSchema = z.strictObject({
  concurrent: positive.max(WORKFLOW_EXECUTION_LIMITS.concurrent).default(1),
  automaticAttemptsPerNode: z.literal(1).default(1),
  automaticRevisions: z.literal(0).default(0),
});
const reservationSchema = z.strictObject({
  intentId: id,
  generation: positive,
  nodeId: id,
  expectedNodeVersion: natural,
  expectedRunVersion: natural,
  requestId: id,
  newRunId: id,
  newSegmentId: id,
  expertId: id,
  expertVersionId: id,
  inputsFingerprint: digest,
});
export type WorkflowStartReservation = z.infer<typeof reservationSchema>;
export const workflowExecutionIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    intentId: id,
    actorId: id,
    spaceId: id,
    generation: positive,
    version: positive,
    status: z.enum(['running', 'stopping', 'paused', 'completed']),
    defaults: workflowDefaultsSchema,
    budget: budgetSchema,
    commandReceipts: z
      .array(
        z.strictObject({
          requestId: id,
          kind: z.enum(['start', 'resume', 'stop']),
          fingerprint: digest,
          generation: positive,
        }),
      )
      .min(1)
      .max(WORKFLOW_EXECUTION_LIMITS.commandReceipts),
    starts: z.array(reservationSchema).max(WORKFLOW_EXECUTION_LIMITS.starts),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.commandReceipts.map((item) => item.requestId)).size !==
      value.commandReceipts.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate workflow command receipt.' });
    for (const field of ['requestId', 'newRunId', 'newSegmentId'] as const)
      if (new Set(value.starts.map((item) => item[field])).size !== value.starts.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate workflow start identity.' });
    if (
      new Set(value.starts.map((item) => `${item.generation}:${item.nodeId}`)).size !==
      value.starts.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate workflow node reservation.' });
    if (
      value.starts.some(
        (item) => item.intentId !== value.intentId || item.generation > value.generation,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Foreign workflow reservation.' });
    if (Buffer.byteLength(JSON.stringify(value)) > WORKFLOW_EXECUTION_LIMITS.bytes)
      ctx.addIssue({ code: 'custom', message: 'Workflow metadata budget exceeded.' });
  });
export type WorkflowExecutionIntent = z.infer<typeof workflowExecutionIntentSchema>;
/** Same original plan row; old rows omit the optional field and remain inert. */
export const executionPlanReceiptSchema = z.strictObject({
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().min(1),
  nodeIds: z.array(z.string().min(1)),
  workflowExecution: workflowExecutionIntentSchema.optional(),
  remoteWorkflows: z
    .array(remoteWorkflowIntentSchema)
    .max(REMOTE_WORKFLOW_LIMITS.intentsPerPlan)
    .refine(
      (items) =>
        new Set(items.map((item) => item.actorId)).size === items.length &&
        new Set(items.map((item) => item.intentId)).size === items.length,
    )
    .optional(),
});
export const workflowStartSchema = workflowLocationSchema.extend({
  requestId: id,
  defaults: workflowDefaultsSchema,
  budget: budgetSchema.default({
    concurrent: 1,
    automaticAttemptsPerNode: 1,
    automaticRevisions: 0,
  }),
});
export const workflowControlSchema = workflowLocationSchema.extend({
  requestId: id,
  intentId: id,
  generation: positive,
});
export const workflowResumeSchema = workflowControlSchema.extend({ expectedVersion: positive });
export const workflowClaimSchema = workflowLocationSchema.extend({
  intentId: id,
  generation: positive,
});
export interface WorkflowExecutionView {
  readonly disposition: 'applied' | 'replayed' | 'unchanged';
  readonly location: WorkflowLocation;
  readonly intent: WorkflowExecutionIntent | undefined;
  readonly requiresResume: boolean;
  readonly activeRunIds: readonly string[];
  readonly reviewAttention?: readonly WorkflowReviewAttention[];
  /** Independent review lane; never mixed into author Run IDs. Metadata only. */
  readonly reviewResources?: readonly {
    readonly scope: ExecutionReviewScope;
    readonly version: number;
    readonly status: 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';
    readonly resources: 'held' | 'settled';
    readonly stopPhase: 'none' | 'requested' | 'confirmed';
  }[];
  /** Derived from original delivery/resource facts; reads never write status. */
  readonly state: 'running' | 'stopping' | 'paused' | 'completed' | 'requires-resume' | 'inactive';
}
declare const ticketBrand: unique symbol;
/** Original Service-owned object, never a browser/JSON authorization. */
export interface WorkflowStartTicket {
  readonly [ticketBrand]: true;
  readonly location: WorkflowLocation;
  readonly reservation: Readonly<WorkflowStartReservation>;
  readonly defaults: WorkflowRunDefaults;
  readonly signal: AbortSignal;
  check(): undefined;
  /** Yield this permit without consuming a Run slot or changing its fixed IDs. */
  deferBusy(): void;
  dispose(): void;
}
/** Host-only wakeup/ownership projection; must never be JSON-serialized. */
export interface WorkflowExecutionClaim {
  readonly view: WorkflowExecutionView;
  readonly tickets: readonly WorkflowStartTicket[];
  /** No write/dispatch permission; prepare requires this genuine claim again. */
  readonly reviewCandidates?: readonly WorkflowReviewCandidate[];
  readonly signal: AbortSignal;
  check(): undefined;
  onChange(listener: () => void): () => void;
  /** Local admission fence before a queued Stop; does not certify native drain. */
  fence(): void;
}
export class ExecutionWorkflowError extends Error {
  constructor(readonly code: string) {
    super('工作流执行操作未完成。');
    this.name = 'ExecutionWorkflowError';
  }
}
