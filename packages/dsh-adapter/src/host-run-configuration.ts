import { symbols, type Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import type {} from '@deepseek-ai/dsh-llm';
import { canonicalPayload, createExecutionHandoff, type Workbench } from '@zhuma/agent-core';
import { z } from 'zod';
import type {
  BeginRunRequest,
  ExecutionRunHostPorts,
  ExecutionService,
} from './execution-service.js';
import {
  assertExecutionRunCompositionBinding,
  executionRunCompositionRequest,
  freezeExecutionRunComposition,
  type FrozenExecutionRunComposition,
  type OutputFilePublisherToolDefinition,
  type AcceptedFileToolDefinition,
} from './execution-run-composition.js';
import {
  ExecutionRunError,
  readExecutionRunState,
  type ExecutionWorkspace,
} from './execution-run-state.js';
import { resolveMember, type MemberRequest } from './member-session.js';
import type { WorkflowStartTicket } from './execution-workflow-contract.js';
import { effectiveWorkflowToolKind } from './execution-workflow-tools.js';
import { describeAcceptedInputTool } from './native-work-session-input-tool.js';
import {
  describeNativeAcceptedFileTool,
  NATIVE_ACCEPTED_FILE_TOOL,
  NATIVE_ACCEPTED_FILE_TOOL_VERSION,
} from './native-work-session-files-tool.js';
import { hostResultTool } from './host-run-result-protocol.js';
import { NATIVE_WORK_LIMITS } from './native-work-session.js';
import type { createHostRunWorkspaces } from './host-run-workspaces.js';
import { describeNativeOutputFileTool } from './native-work-session-output-file-tool.js';
import { describeNativeReviewTool } from './native-work-session-review-tool.js';
import { describeNativeReviewReadTool } from './native-work-session-review-read.js';
import {
  ExecutionReviewCompositionError,
  freezeExecutionReviewComposition,
  readExecutionReviewComposition,
  type ExecutionReviewPreparation,
  type FrozenExecutionReviewComposition,
} from './execution-review-composition.js';
import { executionReviewTargetSchema } from './execution-review-contract.js';
import { readHostRunModels } from './host-run-models.js';
import {
  NATIVE_OUTPUT_FILE_TOOL,
  NATIVE_OUTPUT_FILE_VERSION,
} from './native-work-session-output-file-contract.js';
function declaredOutputTool(): OutputFilePublisherToolDefinition {
  const definition = describeNativeOutputFileTool();
  if (
    definition.name !== NATIVE_OUTPUT_FILE_TOOL ||
    definition.sourceVersion !== NATIVE_OUTPUT_FILE_VERSION
  )
    throw new ExecutionRunError('run-authority-unavailable');
  return {
    ...definition,
    name: NATIVE_OUTPUT_FILE_TOOL,
    sourceVersion: NATIVE_OUTPUT_FILE_VERSION,
  };
}
import type { createHostRunResourceSource } from './host-run-resource-source.js';

const id = z.string().trim().min(1).max(200);
const nonnegative = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = nonnegative.refine((value) => value > 0);
const beginRequest = z.strictObject({
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  requestId: id,
  spaceId: id,
  expectedNodeVersion: nonnegative,
  expectedRunVersion: nonnegative,
  mode: z.enum(['begin', 'retry', 'restart']),
  newRunId: id,
  newSegmentId: id,
  model: z.strictObject({
    provider: id,
    model: id,
    reasoningEffort: id.optional(),
    maxTokens: positive.max(65_536),
  }),
  executor: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('builtin') }),
    z.strictObject({ kind: z.literal('plan-expert'), ref: z.strictObject({ id, version: id }) }),
  ]),
  tools: z.enum(['text-only', 'accepted-input-reader', 'local-tools']),
  workspace: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text-only') }),
    z.strictObject({ kind: z.literal('local'), id }),
  ]),
});
const reviewRequest = z.strictObject({
  requestId: id,
  expectedReviewVersion: nonnegative,
  target: executionReviewTargetSchema,
  reviewerRef: z.strictObject({ id, version: id }),
  model: beginRequest.shape.model.extend({ maxTokens: positive.max(65_536).default(16_384) }),
});
export const hostRunBeginRequestSchema = beginRequest;
const reviewTools = () => ({
  readTarget: describeNativeReviewReadTool(),
  completeReview: describeNativeReviewTool(),
});
function declaredAcceptedFileTool(): AcceptedFileToolDefinition {
  const definition = describeNativeAcceptedFileTool();
  if (
    definition.name !== NATIVE_ACCEPTED_FILE_TOOL ||
    definition.sourceVersion !== NATIVE_ACCEPTED_FILE_TOOL_VERSION
  )
    throw new ExecutionRunError('run-authority-unavailable');
  return {
    ...definition,
    name: NATIVE_ACCEPTED_FILE_TOOL,
    sourceVersion: NATIVE_ACCEPTED_FILE_TOOL_VERSION,
  };
}

/** Host content assembly only. D still checks fresh authority/inputs in its original queue. */
export function createHostRunConfiguration(
  ctx: Context,
  options: {
    readonly execution: ExecutionService;
    readWorkbench(): Workbench;
    readonly signal: AbortSignal;
    readonly workspaces?: ReturnType<typeof createHostRunWorkspaces>;
    readonly resources?: Pick<
      ReturnType<typeof createHostRunResourceSource>,
      'catalog' | 'prepareResourceCatalog' | 'reviewCatalog' | 'prepareReviewResourceCatalog'
    >;
    /** Host readiness only; never a Client-selected protocol or an old-Run upgrade. */
    readonly resultProtocol?: () => 1 | 2;
    /** The actual installed issuer/file factory is ready; never inferred from metadata. */
    readonly acceptedFilesReady?: () => boolean;
  },
) {
  const llm = ctx.llm;
  // Cordis returns a fresh tracing proxy on each service read. Compare the
  // public original identity, while calling through the scoped proxy.
  const origin = llm && (Reflect.get(llm, symbols.original) ?? llm);
  const reviewExecution = options.execution;
  const readReview = reviewExecution.readExpertReviewPreparation;
  const reviewResources = options.resources;
  const prepareReviewResources = reviewResources?.prepareReviewResourceCatalog;
  const currentReviewCatalog = reviewResources?.reviewCatalog;
  const reviewSignal = options.signal;
  const readWorkbench = options.readWorkbench;
  function active() {
    const current = ctx.get('llm');
    if (
      options.signal.aborted ||
      !llm ||
      !current ||
      (Reflect.get(current, symbols.original) ?? current) !== origin
    )
      throw new ExecutionRunError('run-authority-unavailable');
  }
  function assertModel(snapshot: FrozenExecutionRunComposition): undefined {
    active();
    if (snapshot.payload.firstMessage.text.length > NATIVE_WORK_LIMITS.messageChars)
      throw new ExecutionRunError('run-validation');
    // This proves a registered route, not credentials, model quality or successful inference.
    if (!llm.listProviders().some((provider) => provider.id === snapshot.payload.model.provider))
      throw new ExecutionRunError('run-authority-unavailable');
    active();
    const tools = snapshot.payload.tools;
    if (tools.kind === 'local-tools') {
      if (!options.workspaces) throw new ExecutionRunError('run-authority-unavailable');
      options.workspaces.assertComposition(snapshot);
    }
    if (
      tools.kind === 'accepted-input-reader' &&
      canonicalPayload(tools.definition) !== canonicalPayload(describeAcceptedInputTool())
    )
      throw new ExecutionRunError('run-authority-unavailable');
    if (snapshot.schemaVersion === 2 && snapshot.payload.acceptedFileReader) {
      if (
        !options.acceptedFilesReady?.() ||
        canonicalPayload(snapshot.payload.acceptedFileReader) !==
          canonicalPayload(declaredAcceptedFileTool())
      )
        throw new ExecutionRunError('run-authority-unavailable');
    }
    return undefined;
  }
  function reviewActive() {
    active();
    if (
      options.execution !== reviewExecution ||
      !readReview ||
      reviewExecution.readExpertReviewPreparation !== readReview ||
      options.resources !== reviewResources ||
      !reviewResources ||
      reviewResources.prepareReviewResourceCatalog !== prepareReviewResources ||
      reviewResources.reviewCatalog !== currentReviewCatalog ||
      options.signal !== reviewSignal ||
      options.readWorkbench !== readWorkbench
    )
      throw new ExecutionRunError('run-authority-unavailable');
  }
  function assertCurrentReviewComposition(
    snapshot: FrozenExecutionReviewComposition,
    current: ExecutionReviewPreparation,
    synchronousApplied: ExecutionReviewPreparation['applied'],
  ): undefined {
    reviewActive();
    if (!options.resources) throw new ExecutionRunError('run-authority-unavailable');
    if (
      !llm.listProviders().some((provider) => provider.id === snapshot.payload.model.provider) ||
      snapshot.payload.firstMessage.text.length > NATIVE_WORK_LIMITS.messageChars
    )
      throw new ExecutionRunError('run-authority-unavailable');
    // Both callers have just validated/frozen this snapshot. Rebuild the current
    // configuration once; reparsing the same immutable value cannot add freshness.
    const fresh = freezeExecutionReviewComposition({
      ...current,
      model: snapshot.payload.model,
      tools: reviewTools(),
      // This plan was read in this synchronous call. Comparing it with current
      // also rejects a preparation that became stale across its final await.
      resourceCatalog: options.resources.reviewCatalog(current, synchronousApplied),
    });
    if (canonicalPayload(snapshot) !== canonicalPayload(fresh))
      throw new ExecutionReviewCompositionError('review-composition-mismatch');
    reviewActive();
    return undefined;
  }

  const assertions: Pick<ExecutionRunHostPorts, 'assertConfiguration' | 'assertWorkspace'> = {
    assertConfiguration(memberId, spaceId, node, request) {
      active();
      const state = readExecutionRunState(node);
      const prior = state?.receipts.find((receipt) => receipt.requestId === request.requestId);
      const generation = prior
        ? state!.runs.find((run) => run.attempt.id === prior.runId)!.attempt.generation
        : (state?.runs.length ?? 0) + 1;
      assertExecutionRunCompositionBinding(
        request.composition,
        {
          actorId: memberId,
          spaceId,
          taskId: node.taskId,
          planId: node.planId,
          revision: node.revision,
          nodeId: node.nodeId,
          runId: request.newRunId,
          generation,
          segmentId: request.newSegmentId,
        },
        request,
      );
      return assertModel(request.composition);
    },
    assertWorkspace(memberId, spaceId, workspace, access, configurationId) {
      active();
      if (!options.workspaces) {
        if (workspace.kind !== 'text-only') throw new ExecutionRunError('run-authority-denied');
        return undefined;
      }
      return options.workspaces.assertWorkspace(
        memberId,
        spaceId,
        workspace,
        access,
        configurationId,
      );
    },
  };

  const configuration = {
    ...assertions,
    assertModel,
    /** Synchronous re-derivation from D's current authorized preparation facts.
     * The returned configuration/string is never read/send/vote authority. */
    assertReviewConfiguration(
      ...[memberId, spaceId, node, raw]: Parameters<
        NonNullable<ExecutionRunHostPorts['assertReviewConfiguration']>
      >
    ): undefined {
      reviewActive();
      const snapshot = readExecutionReviewComposition(raw);
      const scope = snapshot.payload.scope;
      if (
        scope.actorId !== memberId ||
        scope.spaceId !== spaceId ||
        node.taskId !== scope.taskId ||
        node.planId !== scope.planId ||
        node.revision !== scope.revision ||
        node.nodeId !== scope.nodeId
      )
        throw new ExecutionRunError('run-authority-denied');
      const applied = createExecutionHandoff(scope, readWorkbench.call(options));
      return assertCurrentReviewComposition(snapshot, { scope, node, applied }, applied);
    },
    async prepareReview(
      request: MemberRequest,
      payload: unknown,
      wait?: AbortSignal,
    ): Promise<FrozenExecutionReviewComposition> {
      const parsed = reviewRequest.safeParse(payload);
      if (!parsed.success) throw new ExecutionRunError('run-validation');
      reviewActive();
      wait?.throwIfAborted();
      if (!options.resources) throw new ExecutionRunError('run-authority-unavailable');
      const { model, ...query } = parsed.data;
      const signal = AbortSignal.any([options.signal, ...(wait ? [wait] : [])]);
      const first = await readReview.call(reviewExecution, request, query);
      reviewActive();
      signal.throwIfAborted();
      if (!first.ok) throw new ExecutionRunError('run-authority-denied');
      const models = await readHostRunModels(ctx, signal);
      reviewActive();
      if (
        models.kind !== 'ready' ||
        !models.items.some(
          (item) => item.value.provider === model.provider && item.value.model === model.model,
        )
      )
        throw new ExecutionRunError('run-authority-unavailable');
      const qualified = await options.resources.prepareReviewResourceCatalog(request, query, wait);
      try {
        reviewActive();
        signal.throwIfAborted();
        qualified.assertCurrent();
        if (
          canonicalPayload(first.value.scope) !== canonicalPayload(qualified.preparation.scope) ||
          canonicalPayload(first.value.applied) !== canonicalPayload(qualified.preparation.applied)
        )
          throw new ExecutionRunError('run-authority-denied');
        const composition = freezeExecutionReviewComposition({
          ...qualified.preparation,
          model,
          tools: reviewTools(),
          resourceCatalog: qualified.catalog,
        });
        const final = await readReview.call(reviewExecution, request, query);
        reviewActive();
        signal.throwIfAborted();
        qualified.assertCurrent();
        if (!final.ok) throw new ExecutionRunError('run-authority-denied');
        assertCurrentReviewComposition(
          composition,
          final.value,
          createExecutionHandoff(final.value.scope, readWorkbench.call(options)),
        );
        return composition;
      } finally {
        qualified.release();
      }
    },
    async prepare(
      request: MemberRequest,
      payload: unknown,
      frozenWorkspace?: ExecutionWorkspace,
    ): Promise<BeginRunRequest> {
      const parsed = beginRequest.safeParse(payload);
      if (!parsed.success) throw new ExecutionRunError('run-validation');
      active();
      const input = parsed.data;
      // Same B owner and queue, with the original request and a true fresh
      // member/controller check. Expert-ready nodes need not be human todos.
      const visible = await options.execution.readRunCompositionInputs(request, {
        taskId: input.taskId,
        planId: input.planId,
        revision: input.revision,
        nodeId: input.nodeId,
        spaceId: input.spaceId,
      });
      active();
      if (!visible.ok || !Array.isArray(visible.value.items))
        throw new ExecutionRunError('run-authority-denied');
      const inputs = visible.value;
      const node = options.execution.readRunNode(input);
      if (!node) throw new ExecutionRunError('run-authority-denied');
      const applied = options
        .readWorkbench()
        .appliedPlans.find(
          (plan) =>
            plan.id === input.planId &&
            plan.taskId === input.taskId &&
            plan.revision === input.revision,
        );
      if (!applied) throw new ExecutionRunError('run-authority-denied');
      if ((input.workspace.kind === 'local') !== (input.tools === 'local-tools'))
        throw new ExecutionRunError('run-validation');
      if (input.workspace.kind === 'local' && !options.workspaces)
        throw new ExecutionRunError('run-authority-unavailable');
      const local =
        input.workspace.kind === 'local'
          ? frozenWorkspace
            ? options.workspaces!.selectFrozen(
                inputs.actorId,
                input.spaceId,
                applied.task.projectId,
                frozenWorkspace,
              )
            : options.workspaces!.select(
                inputs.actorId,
                input.spaceId,
                applied.task.projectId,
                input.workspace.id,
              )
          : undefined;
      let workspace: ExecutionWorkspace = local?.workspace ?? { kind: 'text-only' };
      if (local && input.workspace.kind === 'local' && local.policy.id !== input.workspace.id)
        throw new ExecutionRunError('run-authority-denied');
      const state = readExecutionRunState(node);
      const prior = state?.receipts.find((receipt) => receipt.requestId === input.requestId);
      if (prior) {
        const previous = state!.runs.find((run) => run.attempt.id === prior.runId)?.workspace;
        if (previous && options.workspaces?.sameGrant(previous, workspace)) workspace = previous;
        else if (canonicalPayload(previous) !== canonicalPayload(workspace))
          throw new ExecutionRunError('run-idempotency-mismatch');
      }
      let composition: FrozenExecutionRunComposition;
      if (prior) {
        // Cold or same-process retry keeps the original content. It never
        // resolves a saved configuration id to a newer expert/model/context.
        composition = options.execution.readRunComposition({ ...input, runId: prior.runId });
        const saved = composition.payload;
        const choice =
          saved.executor.kind === 'builtin'
            ? { kind: 'builtin' }
            : { kind: 'plan-expert', ref: saved.executor.ref };
        if (
          saved.scope.actorId !== inputs.actorId ||
          saved.scope.spaceId !== input.spaceId ||
          saved.scope.runId !== input.newRunId ||
          saved.scope.segmentId !== input.newSegmentId ||
          canonicalPayload(saved.model) !== canonicalPayload(input.model) ||
          canonicalPayload(choice) !== canonicalPayload(input.executor) ||
          saved.tools.kind !== input.tools
        )
          throw new ExecutionRunError('run-idempotency-mismatch');
      } else {
        const resourceCatalog = await options.resources?.catalog(request, input);
        active();
        composition = freezeExecutionRunComposition({
          workbench: options.readWorkbench(),
          node,
          scope: {
            actorId: inputs.actorId,
            spaceId: input.spaceId,
            taskId: input.taskId,
            planId: input.planId,
            revision: input.revision,
            nodeId: input.nodeId,
            runId: input.newRunId,
            generation: (state?.runs.length ?? 0) + 1,
            segmentId: input.newSegmentId,
          },
          model: input.model,
          executor: input.executor,
          inputs,
          ...(inputs.items.some((item) => item.access === 'visible') &&
          options.acceptedFilesReady?.()
            ? { acceptedFileReader: declaredAcceptedFileTool() }
            : {}),
          ...(resourceCatalog ? { resourceCatalog } : {}),
          ...(node.handoff.assignee.kind === 'expert'
            ? { resultIntentTool: hostResultTool(options.resultProtocol?.() ?? 1) }
            : {}),
          tools: local
            ? {
                kind: 'local-tools',
                definitions: local.tools.describe(
                  local.workspace.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
                ),
                ...(inputs.items.length
                  ? { acceptedInputReader: describeAcceptedInputTool() }
                  : {}),
              }
            : input.tools === 'text-only'
              ? { kind: 'text-only' }
              : { kind: 'accepted-input-reader', definition: describeAcceptedInputTool() },
          ...(local?.policy.publish.length
            ? { outputFilePublisherTool: declaredOutputTool() }
            : {}),
        });
      }
      options.workspaces?.remember(composition, workspace);
      assertModel(composition);
      const { model: _model, executor: _executor, tools: _tools, ...command } = input;
      const { firstMessage: _message, ...projection } = executionRunCompositionRequest(composition);
      const prepared = { ...command, workspace, ...projection, composition };
      if (prior && options.resources) {
        const qualified = await options.resources.prepareResourceCatalog(request, prepared);
        try {
          qualified.assertCurrent();
          active();
        } finally {
          qualified.release();
        }
      }
      return prepared;
    },
    /** Original Service ticket only. HTTP never passes a ticket or full workspace here. */
    async prepareWorkflow(
      request: MemberRequest,
      ticket: WorkflowStartTicket,
      wait?: AbortSignal,
    ): Promise<BeginRunRequest> {
      active();
      wait?.throwIfAborted();
      ticket.check();
      const { location, reservation, defaults } = ticket;
      const original = canonicalPayload({ location, reservation, defaults });
      const member = await resolveMember(ctx, request);
      if (!member.ok) throw new ExecutionRunError('run-authority-denied');
      ticket.check();
      const applied = options
        .readWorkbench()
        .appliedPlans.find(
          (plan) =>
            plan.id === location.planId &&
            plan.taskId === location.taskId &&
            plan.revision === location.revision,
        );
      if (!applied) throw new ExecutionRunError('run-authority-denied');
      const currentNode = options.execution.readRunNode({
        ...location,
        nodeId: reservation.nodeId,
      });
      if (!currentNode) throw new ExecutionRunError('run-authority-denied');
      const tools = effectiveWorkflowToolKind(defaults.tools, currentNode.handoff.inputRefs);
      const selected =
        defaults.workspace.kind === 'local'
          ? options.workspaces?.selectFrozen(
              member.memberId,
              location.spaceId,
              applied.task.projectId,
              defaults.workspace,
            )
          : undefined;
      if (defaults.workspace.kind === 'local' && !selected)
        throw new ExecutionRunError('run-authority-unavailable');
      const prepared = await configuration.prepare(
        request,
        {
          ...location,
          nodeId: reservation.nodeId,
          requestId: reservation.requestId,
          newRunId: reservation.newRunId,
          newSegmentId: reservation.newSegmentId,
          expectedNodeVersion: reservation.expectedNodeVersion,
          expectedRunVersion: reservation.expectedRunVersion,
          mode: 'begin',
          model: defaults.model,
          executor: {
            kind: 'plan-expert',
            ref: { id: reservation.expertId, version: reservation.expertVersionId },
          },
          tools,
          workspace: selected ? { kind: 'local', id: selected.policy.id } : { kind: 'text-only' },
        },
        defaults.workspace,
      );
      active();
      wait?.throwIfAborted();
      ticket.check();
      const node = options.execution.readRunNode({ ...location, nodeId: reservation.nodeId });
      const executor = prepared.composition.payload.executor;
      if (
        canonicalPayload({
          location: ticket.location,
          reservation: ticket.reservation,
          defaults: ticket.defaults,
        }) !== original ||
        !node ||
        node.handoff.assignee.kind !== 'expert' ||
        node.handoff.assignee.id !== reservation.expertId ||
        node.handoff.expertRef?.version !== reservation.expertVersionId ||
        createHash('sha256').update(canonicalPayload(node.handoff.inputRefs)).digest('hex') !==
          reservation.inputsFingerprint ||
        executor.kind !== 'plan-expert' ||
        executor.ref.id !== reservation.expertId ||
        executor.ref.version !== reservation.expertVersionId ||
        canonicalPayload(prepared.workspace) !== canonicalPayload(defaults.workspace) ||
        prepared.composition.payload.tools.kind !==
          effectiveWorkflowToolKind(defaults.tools, node.handoff.inputRefs)
      )
        throw new ExecutionRunError('run-authority-denied');
      return prepared;
    },
  };
  return configuration;
}
