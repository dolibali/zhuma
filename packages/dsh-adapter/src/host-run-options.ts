import { symbols, type Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import {
  canonicalPayload,
  createExecutionHandoff,
  createNodeHandoffs,
  type Workbench,
} from '@zhuma/agent-core';
import { z } from 'zod';
import type { HostRunReadView } from './host-run-reader.js';
import type { ExecutionService } from './execution-service.js';
import type { MemberRequest } from './member-session.js';
import type { createHostRunResourceSource } from './host-run-resource-source.js';
import { BASIC_TASK_EXECUTOR } from './execution-run-composition.js';
import {
  readHostRunModels,
  type HostRunModel as Model,
  type HostRunModels,
} from './host-run-models.js';
import type { createHostRunWorkspaces, HostWorkspaceChoice } from './host-run-workspaces.js';
import {
  ExecutionRunError,
  currentExecutionRun,
  isExecutionRunRevisionStart,
  readExecutionRunState,
} from './execution-run-state.js';

const id = z.string().trim().min(1).max(200);
const query = z.strictObject({
  spaceId: id,
  taskId: id,
  planId: id,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  nodeId: id,
  runId: id.optional(),
});
export const hostRunOptionsQuerySchema = query;
type Executor = { kind: 'builtin' } | { kind: 'plan-expert'; ref: { id: string; version: string } };
export interface HostRunOptionsView {
  readonly target: z.infer<typeof query>;
  readonly nodeVersion: number;
  readonly runVersion: number;
  readonly currentRunId: string | null;
  /** Original persisted Run facts; a backend cannot certify a local Session. */
  readonly currentRun?: Omit<HostRunReadView, 'resultDelivery' | 'sendCapabilities'> | null;
  readonly selection: {
    model: Model;
    executor: Executor;
    workspace?: { kind: 'local'; id: string } | { kind: 'unavailable' };
  } | null;
  readonly workspaces?: readonly HostWorkspaceChoice[];
  readonly workspaceApprovalScope?: { readonly spaceId: string; readonly projectId: string };
  readonly models: HostRunModels;
  readonly experts: { id: string; label: string; description: string; value: Executor }[];
  readonly resources: {
    id: string;
    kind: 'skill' | 'mcp' | 'input';
    name: string;
    status: 'fixed' | 'unavailable' | 'unknown';
  }[];
  readonly start:
    | { kind: 'available'; mode: 'begin' | 'retry' | 'restart' }
    | { kind: 'unavailable'; message: string };
  readonly tools: 'text-only' | 'accepted-input-reader';
}

/** Metadata only. Never enables the writer, opens a native session or invokes inference. */
export function createHostRunOptions(
  ctx: Context,
  options: {
    execution: ExecutionService;
    readWorkbench(): Workbench;
    signal: AbortSignal;
    modelTimeoutMs?: number;
    /** Shared backend metadata never discovers backend models/directories.
     * A member's local Host supplies those actual choices separately. */
    readonly localSelection?: true;
    readonly resources?: Pick<ReturnType<typeof createHostRunResourceSource>, 'catalog'>;
    readonly workspaces?: ReturnType<typeof createHostRunWorkspaces>;
  },
) {
  const llm = ctx.llm;
  const origin = llm && (Reflect.get(llm, symbols.original) ?? llm);
  function active(signal: AbortSignal) {
    signal.throwIfAborted();
    const current = ctx.get('llm');
    if (!llm || !current || (Reflect.get(current, symbols.original) ?? current) !== origin)
      throw new ExecutionRunError('run-authority-unavailable');
  }
  return async function read(request: MemberRequest, payload: unknown, wait?: AbortSignal) {
    const parsed = query.safeParse(payload);
    if (!parsed.success) throw new ExecutionRunError('run-validation');
    const signal = AbortSignal.any([options.signal, ...(wait ? [wait] : [])]);
    const { runId: requestedRunId, ...target } = parsed.data;
    const authorize = async () => {
      active(signal);
      const result = await options.execution.readRunCompositionInputs(request, target);
      active(signal);
      if (!result.ok) throw new ExecutionRunError('run-authority-denied');
      return result.value;
    };
    // Reject a foreign/changed node before asking any provider for metadata.
    await authorize();
    const models: HostRunModels = options.localSelection
      ? { kind: 'unavailable', message: '请在成员本机选择已配置的模型。' }
      : await readHostRunModels(ctx, signal, options.modelTimeoutMs);
    // Metadata discovery may await network IO. Revalidate member, directory,
    // controller, full locator and inputs, then synchronously read current facts.
    let resourceReady = false;
    if (options.resources) {
      try {
        await options.resources.catalog(request, target);
        resourceReady = true;
      } catch {
        active(signal);
      }
    }
    const inputs = await authorize();
    const node = options.execution.readRunNode(target);
    if (!node) throw new ExecutionRunError('run-authority-denied');
    const workbench = options.readWorkbench();
    const plan = createExecutionHandoff(
      { taskId: target.taskId, planId: target.planId, revision: target.revision },
      workbench,
    );
    const expected = createNodeHandoffs(plan).find((item) => item.nodeId === target.nodeId);
    if (
      !expected ||
      canonicalPayload({ ...expected, inputRefs: node.handoff.inputRefs }) !==
        canonicalPayload(node.handoff)
    )
      throw new ExecutionRunError('run-scope-mismatch');
    const state = readExecutionRunState(node);
    const latest = currentExecutionRun(node);
    const current = requestedRunId
      ? state?.runs.find((run) => run.attempt.id === requestedRunId)
      : latest;
    if (requestedRunId && !current) throw new ExecutionRunError('run-scope-mismatch');
    if (current && (current.actorId !== inputs.actorId || current.spaceId !== target.spaceId))
      throw new ExecutionRunError('run-scope-mismatch');
    // This does not project the frozen prompt, method body, owner or grant.
    const saved = current
      ? options.execution.readRunComposition({ ...target, runId: current.attempt.id }).payload
      : undefined;
    const workspaceChoices = options.localSelection
      ? []
      : (options.workspaces?.choices(inputs.actorId, target.spaceId, plan.task.projectId) ?? []);
    const workspaceChoice =
      current?.workspace.kind === 'local'
        ? workspaceChoices.find((choice) =>
            options.workspaces!.sameGrant(
              options.workspaces!.select(
                inputs.actorId,
                target.spaceId,
                plan.task.projectId,
                choice.id,
              ).workspace,
              current.workspace,
            ),
          )
        : undefined;
    const experts: HostRunOptionsView['experts'] = [];
    if (node.handoff.assignee.kind === 'human')
      experts.push({
        id: 'builtin',
        label: BASIC_TASK_EXECUTOR.name,
        description: '处理当前工作节点',
        value: { kind: 'builtin' },
      });
    for (const expert of plan.participants) {
      if (
        expert.kind !== 'expert' ||
        !expert.available ||
        !expert.instructions.trim() ||
        expert.origin?.missing.length ||
        !plan.task.participantIds.includes(expert.id) ||
        (node.handoff.expertRef && node.handoff.expertRef.id !== expert.id) ||
        expert.resourceBindings?.skillIds.some(
          (id) => !resourceReady || !node.handoff.skillRefs.some((ref) => ref.id === id),
        ) ||
        expert.resourceBindings?.mcpIds.some(
          (id) => !resourceReady || !node.handoff.mcpRefs.some((ref) => ref.id === id),
        )
      )
        continue;
      experts.push({
        id: JSON.stringify([expert.id, plan.id]),
        label: expert.name,
        description: expert.role,
        value: { kind: 'plan-expert', ref: { id: expert.id, version: plan.id } },
      });
    }
    const resources: HostRunOptionsView['resources'] = [
      ...node.handoff.skillRefs.map((ref) => ({
        id: ref.id,
        kind: 'skill' as const,
        name: plan.assets.find((asset) => asset.id === ref.id)?.name ?? ref.id,
        status: resourceReady ? ('fixed' as const) : ('unavailable' as const),
      })),
      ...node.handoff.mcpRefs.map((ref) => ({
        id: ref.id,
        kind: 'mcp' as const,
        name: plan.assets.find((asset) => asset.id === ref.id)?.name ?? ref.id,
        status: resourceReady ? ('fixed' as const) : ('unavailable' as const),
      })),
      ...inputs.items.map((input, index) => ({
        id: input.access === 'visible' ? input.artifactVersionId : `unavailable-input-${index}`,
        kind: 'input' as const,
        name: input.access === 'visible' ? input.name || '上游产物' : '待就绪的上游产物',
        status:
          input.access === 'visible' && !input.blocking
            ? ('fixed' as const)
            : ('unavailable' as const),
      })),
    ];
    const revisionStart = isExecutionRunRevisionStart(node);
    const start: HostRunOptionsView['start'] =
      current?.resources === 'held'
        ? { kind: 'unavailable', message: '当前运行仍占用资源，请先停止并等待确认。' }
        : node.command.status === 'in-review'
          ? { kind: 'unavailable', message: '产物已提交，正在等待评审。' }
          : node.command.status === 'completed'
            ? { kind: 'unavailable', message: '此工作节点已完成。' }
            : resources.some((resource) => resource.status !== 'fixed')
              ? { kind: 'unavailable', message: '节点所需能力或上游产物尚未接通。' }
              : !experts.length
                ? { kind: 'unavailable', message: '固定计划中的执行者暂不可用。' }
                : current &&
                    current.attempt.status !== 'failed' &&
                    current.attempt.status !== 'cancelled' &&
                    !revisionStart
                  ? { kind: 'unavailable', message: '当前运行状态暂不支持重新开始。' }
                  : !current && !['ready', 'needs-revision'].includes(node.command.status)
                    ? { kind: 'unavailable', message: '当前节点尚未进入可处理状态。' }
                    : {
                        kind: 'available',
                        mode:
                          !current || revisionStart
                            ? 'begin'
                            : current.attempt.status === 'failed'
                              ? 'retry'
                              : 'restart',
                      };
    const value: HostRunOptionsView = {
      target,
      nodeVersion: node.command.version,
      runVersion: state?.version ?? 0,
      currentRunId: current?.attempt.id ?? null,
      ...(options.localSelection
        ? {
            currentRun:
              current && state
                ? {
                    taskId: target.taskId,
                    planId: target.planId,
                    revision: target.revision,
                    nodeId: target.nodeId,
                    runId: current.attempt.id,
                    generation: current.attempt.generation,
                    segmentId: current.segmentId,
                    nodeVersion: node.command.version,
                    runVersion: state.version,
                    status: current.attempt.status,
                    dispatch: current.dispatch,
                    resources: current.resources,
                    acknowledged: current.attempt.acknowledged,
                    stopPhase: current.attempt.stopPhase,
                    native: null,
                  }
                : null,
          }
        : {}),
      selection: saved
        ? {
            model: saved.model,
            executor:
              saved.executor.kind === 'builtin'
                ? { kind: 'builtin' }
                : { kind: 'plan-expert', ref: saved.executor.ref },
            ...(current?.workspace.kind === 'local'
              ? {
                  workspace: workspaceChoice
                    ? { kind: 'local' as const, id: workspaceChoice.id }
                    : { kind: 'unavailable' as const },
                }
              : {}),
          }
        : null,
      models,
      experts,
      resources,
      start:
        requestedRunId && requestedRunId !== latest?.attempt.id
          ? { kind: 'unavailable', message: '历史执行仅供查看，请返回当前工作节点开始新一轮。' }
          : start,
      tools: inputs.items.length ? 'accepted-input-reader' : 'text-only',
      ...(!options.localSelection && options.workspaces
        ? {
            workspaces: workspaceChoices,
            workspaceApprovalScope: { spaceId: target.spaceId, projectId: plan.task.projectId },
          }
        : {}),
    };
    active(signal);
    return { ok: true as const, value };
  };
}
