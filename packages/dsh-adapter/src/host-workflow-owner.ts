import type { Context } from '@deepseek-ai/cordis';
import { createExecutionHandoff, createNodeHandoffs, type Workbench } from '@zhuma/agent-core';
import { z } from 'zod';
import type { ExecutionResult, ExecutionService } from './execution-service.js';
import {
  ExecutionWorkflowError,
  workflowControlSchema,
  workflowDefaultsSchema,
  workflowLocationSchema,
  workflowResumeSchema,
  type WorkflowExecutionView,
  type WorkflowLocation,
} from './execution-workflow-contract.js';
import {
  createNativeWorkflowBridge,
  type NativeWorkflowRunPort,
} from './native-work-session-workflow-bridge.js';
import { resolveMember, type MemberRequest } from './member-session.js';
import { readHostRunModels, type HostRunModel, type HostRunModels } from './host-run-models.js';
import type { createHostRunWorkspaces, HostWorkspaceChoice } from './host-run-workspaces.js';

const id = z.string().trim().min(1).max(200);
const publicWorkspace = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text-only') }),
  z.strictObject({ kind: z.literal('local'), id }),
]);
const publicStart = workflowLocationSchema.extend({
  requestId: id,
  model: workflowDefaultsSchema.shape.model,
  workspace: publicWorkspace,
  concurrent: z.number().int().min(1).max(4).default(1),
});
type PublicWorkspace = z.infer<typeof publicWorkspace> | { readonly kind: 'unavailable' };
export interface HostWorkflowView {
  readonly target: WorkflowLocation;
  readonly title: string;
  readonly state: WorkflowExecutionView['state'];
  readonly planStarted: boolean;
  readonly requiresResume: boolean;
  readonly activeRunCount: number;
  readonly expertNodeCount: number;
  readonly intent: {
    readonly intentId: string;
    readonly generation: number;
    readonly version: number;
    readonly concurrent: number;
  } | null;
  readonly selection: { readonly model: HostRunModel; readonly workspace: PublicWorkspace } | null;
}
export interface HostWorkflowOptions extends HostWorkflowView {
  readonly models: HostRunModels;
  readonly workspaces: readonly HostWorkspaceChoice[];
}
export interface HostWorkflowOperations {
  options(
    original: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostWorkflowOptions>>;
  read(
    original: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostWorkflowView>>;
  start(
    original: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostWorkflowView>>;
  resume(
    original: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostWorkflowView>>;
  stop(
    original: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostWorkflowView>>;
}

/** Public projections and explicit controls over the original D facts and C bridge. */
export function createHostWorkflowOwner(
  ctx: Context,
  options: {
    readonly execution: ExecutionService;
    readonly runs: NativeWorkflowRunPort;
    readonly workspaces: ReturnType<typeof createHostRunWorkspaces>;
    readonly signal: AbortSignal;
    readWorkbench(): Workbench;
  },
) {
  const { execution, signal, workspaces } = options;
  const bridge = createNativeWorkflowBridge({ execution, runs: options.runs, signal });
  const active = (wait?: AbortSignal) => {
    signal.throwIfAborted();
    wait?.throwIfAborted();
  };
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ExecutionWorkflowError('workflow-validation');
    return result.data;
  }
  async function context(original: MemberRequest, location: WorkflowLocation, wait?: AbortSignal) {
    active(wait);
    const member = await resolveMember(ctx, original);
    if (!member.ok) throw new ExecutionWorkflowError('workflow-authority-denied');
    const result = await execution.readWorkflowExecution(original, location);
    active(wait);
    if (!result.ok) throw new ExecutionWorkflowError(result.error.code);
    const applied = createExecutionHandoff(location, options.readWorkbench());
    return { member, view: result.value, applied };
  }
  type Facts = Awaited<ReturnType<typeof context>>;
  function projection(facts: Facts): HostWorkflowView {
    const { member, view, applied } = facts;
    const nodes = createNodeHandoffs(applied);
    let workspace: PublicWorkspace = { kind: 'text-only' };
    if (view.intent?.defaults.workspace.kind === 'local') {
      try {
        const selected = workspaces.selectFrozen(
          member.memberId,
          view.location.spaceId,
          applied.task.projectId,
          view.intent.defaults.workspace,
        );
        workspace = { kind: 'local', id: selected.policy.id };
      } catch {
        workspace = { kind: 'unavailable' };
      }
    }
    return {
      target: view.location,
      title: applied.task.title,
      state: view.state,
      planStarted:
        nodes.length > 0 &&
        nodes.every(
          (node) => execution.readRunNode({ ...view.location, nodeId: node.nodeId }) !== undefined,
        ),
      requiresResume: view.requiresResume,
      activeRunCount: view.activeRunIds.length,
      expertNodeCount: nodes.filter((node) => node.assignee.kind === 'expert').length,
      intent: view.intent
        ? {
            intentId: view.intent.intentId,
            generation: view.intent.generation,
            version: view.intent.version,
            concurrent: view.intent.budget.concurrent,
          }
        : null,
      selection: view.intent ? { model: view.intent.defaults.model, workspace } : null,
    };
  }
  async function current(original: MemberRequest, location: WorkflowLocation, wait?: AbortSignal) {
    return { ok: true as const, value: projection(await context(original, location, wait)) };
  }
  const operations: HostWorkflowOperations = {
    async options(original, payload, wait) {
      const location = parse(workflowLocationSchema, payload);
      await context(original, location, wait);
      const models = await readHostRunModels(
        ctx,
        AbortSignal.any([signal, ...(wait ? [wait] : [])]),
      );
      const facts = await context(original, location, wait);
      return {
        ok: true,
        value: {
          ...projection(facts),
          models,
          workspaces: workspaces.choices(
            facts.member.memberId,
            location.spaceId,
            facts.applied.task.projectId,
          ),
        },
      };
    },
    async read(original, payload, wait) {
      return current(original, parse(workflowLocationSchema, payload), wait);
    },
    async start(original, payload, wait) {
      const input = parse(publicStart, payload);
      const { spaceId, taskId, planId, revision } = input;
      const location = { spaceId, taskId, planId, revision };
      await context(original, location, wait);
      const models = await readHostRunModels(
        ctx,
        AbortSignal.any([signal, ...(wait ? [wait] : [])]),
      );
      if (
        models.kind !== 'ready' ||
        !models.items.some(
          (item) =>
            item.value.provider === input.model.provider && item.value.model === input.model.model,
        )
      )
        throw new ExecutionWorkflowError('workflow-model-unavailable');
      const facts = await context(original, location, wait);
      const selected =
        input.workspace.kind === 'local'
          ? workspaces.select(
              facts.member.memberId,
              location.spaceId,
              facts.applied.task.projectId,
              input.workspace.id,
            )
          : undefined;
      const started = await execution.startWorkflowExecution(original, {
        ...location,
        requestId: input.requestId,
        defaults: {
          model: input.model,
          tools: selected ? 'local-tools' : 'accepted-input-reader',
          workspace: selected?.workspace ?? { kind: 'text-only' },
        },
        budget: {
          concurrent: input.concurrent,
          automaticAttemptsPerNode: 1,
          automaticRevisions: 0,
        },
      });
      if (!started.ok) return started;
      // Once the original command commits, a lost UI reply cannot retract it.
      // The bridge retains this exact request and D's actual generation.
      await bridge.attach(original, started.value);
      return current(original, location);
    },
    async resume(original, payload, wait) {
      active(wait);
      const input = parse(workflowResumeSchema, payload);
      const resumed = await execution.resumeWorkflowExecution(original, input);
      if (!resumed.ok) return resumed;
      await bridge.attach(original, resumed.value);
      return current(original, resumed.value.location);
    },
    async stop(original, payload, wait) {
      active(wait);
      const input = parse(workflowControlSchema, payload);
      const stopped = await bridge.stop(original, input);
      if (!stopped.ok) return stopped;
      return current(original, stopped.value.location);
    },
  };
  return { operations, fence: bridge.fence, close: bridge.close };
}
