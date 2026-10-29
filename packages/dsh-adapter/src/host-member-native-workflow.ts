import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  canonicalPayload,
  createExecutionHandoff,
  createNodeHandoffs,
  WorkbenchSchema,
  remoteWorkflowDefaultsSchema,
  type RemoteWorkflowView,
} from '@zhuma/agent-core';
import type { HostSharedBackend } from './host-shared-backend.js';
import { MemberLocalExecutionProtocol } from './member-local-execution-protocol.js';
import { MemberLocalExecutionOwner } from './member-local-execution-owner.js';
import type { MemberLocalReviewProtocol } from './member-local-review-protocol.js';
import {
  NativeMemberWorkflowConsumer,
  type NativeMemberWorkflowHooks,
} from './native-work-session-member-workflow.js';
import {
  workflowControlSchema,
  workflowLocationSchema,
  workflowResumeSchema,
} from './execution-workflow-contract.js';
import { readHostRunModels } from './host-run-models.js';
import type { HostWorkflowView } from './host-workflow-owner.js';
import {
  memberNativeWorkspaceSchema,
  type createHostMemberNativeWorkspaces,
} from './host-member-native-workspaces.js';
import { ExecutionRunError } from './execution-run-state.js';

const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const metadataSchema = z.object({
  target: workflowLocationSchema,
  title: z.string().min(1).max(1000),
  planStarted: z.boolean(),
  expertNodeCount: natural.max(1000),
  controlledNodeCount: natural.max(1000),
  controlledReviewNodeCount: natural.max(1000),
  expertReviewRequired: z.boolean().optional(),
  intent: z.null(),
});
const startSchema = workflowLocationSchema.extend({
  requestId: z.string().min(1).max(200),
  model: remoteWorkflowDefaultsSchema.shape.model,
  workspace: memberNativeWorkspaceSchema,
  concurrent: z.literal(1).default(1),
  automaticRevisions: natural.max(2).default(0),
});
const resumeSchema = workflowResumeSchema.extend({
  workspace: memberNativeWorkspaceSchema.optional(),
});

/** Same backend facts, original device protocol and C consumer. This owns only
 * local composition; it stores no workflow/Run facts, tickets or credentials. */
export function createHostMemberNativeWorkflow(
  ctx: Context,
  options: {
    backend: HostSharedBackend;
    connectionId: string;
    actorId: string;
    protocol: MemberLocalExecutionProtocol;
    native: MemberLocalExecutionOwner;
    review?: MemberLocalReviewProtocol;
    workspaces: ReturnType<typeof createHostMemberNativeWorkspaces>;
    hooks: NativeMemberWorkflowHooks;
    signal: AbortSignal;
    current(signal: AbortSignal): Promise<void>;
  },
) {
  const consumers = new Map<string, NativeMemberWorkflowConsumer>();
  // Only a failed explicit cold Stop can leave an unarmed consumer needing
  // another recovery attempt. This is not a durable Run or workflow fact.
  const coldStopRecovery = new WeakSet<NativeMemberWorkflowConsumer>();
  const automaticReview = !!(options.review && options.hooks.prepareReview);
  const key = (target: unknown) => canonicalPayload(target);
  async function call(
    operation: 'member.snapshot' | 'execution.task-progress' | 'execution.start-plan',
    payload: object,
    signal: AbortSignal,
  ) {
    await options.current(signal);
    const rpcId = randomUUID();
    const response = await options.backend.request(
      {
        connectionId: options.connectionId,
        operation,
        rpcId,
        payload,
      },
      signal,
    );
    await options.current(signal);
    const reply = z
      .object({
        type: z.literal('server-response'),
        rpcId: z.literal(rpcId),
        result: z.object({ ok: z.literal(true), value: z.unknown() }),
      })
      .parse(response.body);
    return reply.result.value;
  }
  async function metadata(target: z.infer<typeof workflowLocationSchema>, signal: AbortSignal) {
    if (!(await options.protocol.negotiateWorkflow(signal)))
      throw new ExecutionRunError('run-authority-unavailable');
    const snapshot = z
      .object({
        actorId: z.literal(options.actorId),
        spaceId: z.literal(target.spaceId),
        state: WorkbenchSchema,
      })
      .parse(await call('member.snapshot', { spaceId: target.spaceId }, signal));
    const task = snapshot.state.tasks.find((item) => item.id === target.taskId);
    const plans = snapshot.state.appliedPlans.filter((item) => item.taskId === target.taskId);
    const latest = Math.max(0, ...plans.map((item) => item.revision));
    if (
      !task ||
      latest !== target.revision ||
      plans.filter((item) => item.revision === latest).length !== 1
    )
      throw new ExecutionRunError('run-scope-mismatch');
    const plan = createExecutionHandoff(target, snapshot.state),
      nodes = createNodeHandoffs(plan);
    const { spaceId, ...planTarget } = target;
    const progress = z
      .object({
        actorId: z.literal(options.actorId),
        spaceId: z.literal(spaceId),
        coverage: z.literal('current-confirmed-plans'),
        items: z
          .array(
            z.object({
              target: workflowLocationSchema.omit({ spaceId: true }),
              facts: z.enum(['present', 'not-started', 'unknown']),
            }),
          )
          .length(1),
      })
      .parse(await call('execution.task-progress', { spaceId, plans: [planTarget] }, signal));
    const row = progress.items[0]!;
    if (key(row.target) !== key(planTarget) || row.facts === 'unknown')
      throw new ExecutionRunError('run-authority-unavailable');
    return metadataSchema.parse({
      target,
      title: plan.task.title,
      planStarted: row.facts === 'present',
      intent: null,
      expertNodeCount: nodes.filter((node) => node.assignee.kind === 'expert').length,
      controlledNodeCount: nodes.filter((node) =>
        node.assignee.kind === 'human'
          ? node.assignee.id === options.actorId
          : node.assignee.kind === 'expert' &&
            task.ownerId === options.actorId &&
            plan.task.ownerId === options.actorId,
      ).length,
      controlledReviewNodeCount:
        task.ownerId === options.actorId && plan.task.ownerId === options.actorId
          ? nodes.filter(
              (node) =>
                node.reviewRequired &&
                node.reviewerIds.some((id) =>
                  plan.participants.some((item) => item.id === id && item.kind === 'expert'),
                ),
            ).length
          : 0,
      expertReviewRequired: nodes.some(
        (node) =>
          node.reviewRequired &&
          node.reviewerIds.some((id) =>
            plan.participants.some((item) => item.id === id && item.kind === 'expert'),
          ),
      ),
    });
  }
  function consumer(target: z.infer<typeof workflowLocationSchema>) {
    const identity = key(target);
    let value = consumers.get(identity);
    if (!value) {
      if (consumers.size >= 128) throw new ExecutionRunError('run-authority-unavailable');
      value = new NativeMemberWorkflowConsumer({
        protocol: options.protocol,
        native: options.native,
        ...(options.review ? { review: options.review } : {}),
        hooks: options.hooks,
        signal: options.signal,
      });
      consumers.set(identity, value);
    }
    return value;
  }
  function project(
    base: z.infer<typeof metadataSchema>,
    remote?: RemoteWorkflowView,
  ): HostWorkflowView {
    if (!remote?.intent)
      return {
        target: base.target,
        title: base.title,
        planStarted: base.planStarted,
        expertNodeCount: base.expertNodeCount,
        controlledNodeCount: base.controlledNodeCount,
        controlledReviewNodeCount: base.controlledReviewNodeCount,
        ...(base.expertReviewRequired === undefined
          ? {}
          : { expertReviewRequired: base.expertReviewRequired }),
        intent: null,
        state: 'inactive',
        requiresResume: false,
        activeRunCount: 0,
        selection: null,
        automaticReview,
      };
    if (
      key(base.target) !== key(workflowLocationSchema.strip().parse(remote.scope)) ||
      remote.scope.actorId !== options.actorId
    )
      throw new ExecutionRunError('run-scope-mismatch');
    const intent = remote.intent;
    let workspace: NonNullable<HostWorkflowView['selection']>['workspace'];
    try {
      workspace = options.workspaces.workflowSelection(intent.defaults.workspace);
    } catch {
      workspace = { kind: 'unavailable' };
    }
    const local = consumers.get(key(base.target))?.view();
    const budgetExhausted = remote.attention.some(
      (item) => item.code === 'rework-budget-exhausted',
    );
    return {
      target: base.target,
      title: base.title,
      planStarted: base.planStarted,
      expertNodeCount: base.expertNodeCount,
      controlledNodeCount: base.controlledNodeCount,
      controlledReviewNodeCount: base.controlledReviewNodeCount,
      ...(remote.revisions ? { revisions: structuredClone(remote.revisions) } : {}),
      ...(base.expertReviewRequired === undefined
        ? {}
        : { expertReviewRequired: base.expertReviewRequired }),
      automaticReview,
      state: remote.state,
      requiresResume: remote.requiresResume,
      activeRunCount: [...remote.activeWork, ...remote.activeReviews].filter(
        (run) => run.resources !== 'settled',
      ).length,
      intent: {
        intentId: intent.intentId,
        generation: intent.generation,
        version: intent.version,
        concurrent: intent.budget.concurrent,
        automaticRevisions: intent.budget.automaticRevisions,
      },
      selection: { model: intent.defaults.model, workspace },
      ...(budgetExhausted || local?.blocked
        ? {
            attention: budgetExhausted
              ? `自动返工已达到所选上限（${intent.budget.automaticRevisions} 轮），请在待办中处理退回意见。`
              : '自动接续需要处理，请检查当前工作节点，或停止后继续。',
          }
        : {}),
    };
  }
  async function modelAvailable(model: z.infer<typeof startSchema>['model'], signal: AbortSignal) {
    const models = await readHostRunModels(ctx, signal);
    if (
      models.kind !== 'ready' ||
      !models.items.some(
        (item) => item.value.provider === model.provider && item.value.model === model.model,
      )
    )
      throw new ExecutionRunError('run-authority-unavailable');
    await options.current(signal);
  }
  return {
    async handle(endpoint: string, raw: unknown, signal: AbortSignal) {
      const target = workflowLocationSchema.parse(
        z
          .object({
            spaceId: z.unknown(),
            taskId: z.unknown(),
            planId: z.unknown(),
            revision: z.unknown(),
          })
          .parse(raw),
      );
      let base = await metadata(target, signal);
      if (endpoint === 'workflow-start') {
        const input = startSchema.parse(raw);
        if (input.automaticRevisions && !automaticReview)
          throw new ExecutionRunError('run-authority-unavailable');
        await modelAvailable(input.model, signal);
        if (!base.planStarted) {
          await call(
            'execution.start-plan',
            { ...target, idempotencyKey: `workflow:${input.requestId}` },
            signal,
          );
          base = await metadata(target, signal);
          if (!base.planStarted) throw new ExecutionRunError('run-authority-unavailable');
        }
        const choice = options.workspaces.workflowWorkspace(input.workspace);
        if (choice.workspace.kind === 'local' && !options.native.outputFileSource)
          throw new ExecutionRunError('run-authority-unavailable');
        const resources = MemberLocalExecutionOwner.resourceSource(ctx);
        const defaults = remoteWorkflowDefaultsSchema.parse({
          model: input.model,
          workspace: choice.workspace,
          capabilities: {
            ...(resources ? { resources } : {}),
            ...(options.native.knowledgeSource
              ? { knowledge: options.native.knowledgeSource }
              : {}),
            acceptedInput: '1',
            ...(options.protocol.supportsFilePublishing && options.native.acceptedFileSource
              ? { acceptedFile: options.native.acceptedFileSource }
              : {}),
            ...(choice.workspace.kind === 'local'
              ? { outputFile: options.native.outputFileSource }
              : {}),
            resultIntent:
              choice.workspace.kind === 'local'
                ? 'zhuma-native-result-intent@2'
                : 'zhuma-native-result-intent@1',
            localTools: choice.localTools,
          },
        });
        const next = await consumer(target).start(
          input.requestId,
          {
            target,
            defaults,
            budget: { concurrent: 1, automaticRevisions: input.automaticRevisions },
          },
          signal,
        );
        return project(base, next.remote);
      }
      if (!base.planStarted) {
        if (!['workflow-options', 'workflow-read'].includes(endpoint))
          throw new ExecutionRunError('run-authority-denied');
      }
      const existing = consumers.get(key(target));
      let remote = base.planStarted
        ? existing
          ? (await existing.inspect(target, signal)).remote
          : await options.protocol.workflowStatus({ target }, signal)
        : undefined;
      if (endpoint === 'workflow-resume') {
        const input = resumeSchema.parse(raw);
        if (!remote?.intent) throw new ExecutionRunError('run-authority-denied');
        await modelAvailable(remote.intent.defaults.model, signal);
        let defaults: z.infer<typeof remoteWorkflowDefaultsSchema> | undefined;
        if (input.workspace !== undefined) {
          if (remote.state === 'stopping') throw new ExecutionRunError('run-authority-unavailable');
          const choice = options.workspaces.workflowWorkspace(input.workspace);
          if (choice.workspace.kind === 'local' && !options.native.outputFileSource)
            throw new ExecutionRunError('run-authority-unavailable');
          const {
            outputFile: _output,
            resultIntent: _result,
            localTools: _tools,
            ...ceiling
          } = remote.intent.defaults.capabilities;
          defaults = remoteWorkflowDefaultsSchema.parse({
            ...remote.intent.defaults,
            workspace: choice.workspace,
            capabilities: {
              ...ceiling,
              localTools: choice.localTools,
              resultIntent:
                choice.workspace.kind === 'local'
                  ? 'zhuma-native-result-intent@2'
                  : 'zhuma-native-result-intent@1',
              ...(choice.workspace.kind === 'local'
                ? { outputFile: options.native.outputFileSource }
                : {}),
            },
          });
        } else {
          options.workspaces.workflowSelection(remote.intent.defaults.workspace);
        }
        const identity = key(target),
          old = consumers.get(identity);
        if (old) {
          if (!old.canSwitchBackend()) throw new ExecutionRunError('run-authority-unavailable');
          await old.close();
          consumers.delete(identity);
        }
        const next = await consumer(target).resume(
          input.requestId,
          {
            target,
            workflow: { intentId: input.intentId, generation: input.generation },
            expectedVersion: input.expectedVersion,
            ...(defaults ? { defaults } : {}),
          },
          signal,
        );
        remote = next.remote;
      } else if (endpoint === 'workflow-stop') {
        const input = workflowControlSchema.parse(raw);
        if (
          remote?.intent?.intentId !== input.intentId ||
          remote.intent.generation !== input.generation
        )
          throw new ExecutionRunError('run-scope-mismatch');
        let active = consumers.get(key(target));
        if (!active) {
          active = consumer(target);
          coldStopRecovery.add(active);
        }
        if (coldStopRecovery.has(active)) {
          // Only explicit Stop reconciles the original cold unknown accept.
          // Ordinary reads never recover, arm, retry accept or start an Agent.
          const state = active.view();
          if (!state.armed && !state.busy) await active.recover(target, signal);
          // An original pending handle is cleaned by stop/close. Do not call
          // recover again after that consumer has entered closing.
          coldStopRecovery.delete(active);
        }
        const intent = active.view().remote?.intent;
        if (intent?.intentId !== input.intentId || intent.generation !== input.generation)
          throw new ExecutionRunError('run-scope-mismatch');
        remote = (await active.stop(input.requestId, signal)).remote;
      } else if (!['workflow-read', 'workflow-options'].includes(endpoint))
        throw new ExecutionRunError('run-validation');
      const view = project(base, remote);
      if (endpoint !== 'workflow-options') return view;
      return {
        ...view,
        models: await readHostRunModels(ctx, signal),
        workspaces: options.workspaces.choices(),
        maxConcurrent: 1,
      };
    },
    fence() {
      for (const value of consumers.values()) value.fence();
    },
    whenAdmissionsIdle: () =>
      Promise.all([...consumers.values()].map((value) => value.whenAdmissionsIdle())),
    close: () => Promise.all([...consumers.values()].map((value) => value.close())),
    canSwitchBackend: () => [...consumers.values()].every((value) => value.canSwitchBackend()),
  };
}
