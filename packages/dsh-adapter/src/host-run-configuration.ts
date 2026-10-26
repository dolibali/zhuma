import { symbols, type Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import { canonicalPayload, type Workbench } from '@zhuma/agent-core';
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
  type ResultIntentToolDefinition,
  type OutputFilePublisherToolDefinition,
} from './execution-run-composition.js';
import { ExecutionRunError, readExecutionRunState } from './execution-run-state.js';
import type { MemberRequest } from './member-session.js';
import { describeAcceptedInputTool } from './native-work-session-input-tool.js';
import { describeNativeResultTool } from './native-work-session-result-tool.js';
import {
  NATIVE_RESULT_TOOL,
  NATIVE_RESULT_TOOL_VERSION,
} from './native-work-session-result-contract.js';
import { NATIVE_WORK_LIMITS } from './native-work-session.js';
import type { createHostRunWorkspaces } from './host-run-workspaces.js';
import { describeNativeOutputFileTool } from './native-work-session-output-file-tool.js';
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

function declaredResultTool(): ResultIntentToolDefinition {
  const definition = describeNativeResultTool();
  if (
    definition.name !== NATIVE_RESULT_TOOL ||
    definition.sourceVersion !== NATIVE_RESULT_TOOL_VERSION
  )
    throw new ExecutionRunError('run-authority-unavailable');
  return { ...definition, name: NATIVE_RESULT_TOOL, sourceVersion: NATIVE_RESULT_TOOL_VERSION };
}

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
      'catalog' | 'prepareResourceCatalog'
    >;
  },
) {
  const llm = ctx.llm;
  // Cordis returns a fresh tracing proxy on each service read. Compare the
  // public original identity, while calling through the scoped proxy.
  const origin = llm && (Reflect.get(llm, symbols.original) ?? llm);
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

  return {
    ...assertions,
    assertModel,
    async prepare(request: MemberRequest, payload: unknown): Promise<BeginRunRequest> {
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
          ? options.workspaces!.select(
              inputs.actorId,
              input.spaceId,
              applied.task.projectId,
              input.workspace.id,
            )
          : undefined;
      const workspace = local?.workspace ?? { kind: 'text-only' as const };
      const state = readExecutionRunState(node);
      const prior = state?.receipts.find((receipt) => receipt.requestId === input.requestId);
      if (
        prior &&
        canonicalPayload(state!.runs.find((run) => run.attempt.id === prior.runId)?.workspace) !==
          canonicalPayload(workspace)
      )
        throw new ExecutionRunError('run-idempotency-mismatch');
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
          ...(resourceCatalog ? { resourceCatalog } : {}),
          ...(node.handoff.assignee.kind === 'expert'
            ? { resultIntentTool: declaredResultTool() }
            : {}),
          tools: local
            ? {
                kind: 'local-tools',
                definitions: local.tools.describe(
                  local.policy.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
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
  };
}
