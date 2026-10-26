import { symbols, type Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import {
  canonicalPayload,
  createExecutionHandoff,
  createNodeHandoffs,
  type Workbench,
} from '@zhuma/agent-core';
import { z } from 'zod';
import type { ExecutionService } from './execution-service.js';
import type { MemberRequest } from './member-session.js';
import type { createHostRunResourceSource } from './host-run-resource-source.js';
import { BASIC_TASK_EXECUTOR } from './execution-run-composition.js';
import type { createHostRunWorkspaces, HostWorkspaceChoice } from './host-run-workspaces.js';
import {
  ExecutionRunError,
  currentExecutionRun,
  readExecutionRunState,
} from './execution-run-state.js';

const id = z.string().trim().min(1).max(200);
const query = z.strictObject({
  spaceId: id,
  taskId: id,
  planId: id,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  nodeId: id,
});
type Executor = { kind: 'builtin' } | { kind: 'plan-expert'; ref: { id: string; version: string } };
type Model = {
  provider: string;
  model: string;
  maxTokens: number;
  reasoningEffort?: string | undefined;
};
export interface HostRunOptionsView {
  readonly target: z.infer<typeof query>;
  readonly nodeVersion: number;
  readonly runVersion: number;
  readonly currentRunId: string | null;
  readonly selection: {
    model: Model;
    executor: Executor;
    workspace?: { kind: 'local'; id: string } | { kind: 'unavailable' };
  } | null;
  readonly workspaces?: readonly HostWorkspaceChoice[];
  readonly models:
    | { kind: 'ready'; items: { id: string; label: string; value: Model }[] }
    | { kind: 'unavailable'; message: string };
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
    const target = parsed.data;
    const authorize = async () => {
      active(signal);
      const result = await options.execution.readRunCompositionInputs(request, target);
      active(signal);
      if (!result.ok) throw new ExecutionRunError('run-authority-denied');
      return result.value;
    };
    // Reject a foreign/changed node before asking any provider for metadata.
    await authorize();
    const providers = llm.listProviders();
    let models: HostRunOptionsView['models'];
    if (providers.length > 16) {
      models = { kind: 'unavailable', message: '模型目录过大，请先缩小已配置的供应商范围。' };
    } else {
      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(options.modelTimeoutMs ?? 2500),
      ]);
      let cancel: (() => void) | undefined;
      try {
        // SDK listModels has no AbortSignal parameter. Bound our wait and contain
        // late rejection; completion never publishes without another member gate.
        const cancelled = new Promise<never>((_, reject) => {
          cancel = () => reject(deadline.reason);
          deadline.addEventListener('abort', cancel, { once: true });
        });
        deadline.throwIfAborted();
        const catalogs = await Promise.race([
          Promise.all(providers.map((provider) => llm.listModels(provider.id))),
          cancelled,
        ]);
        active(signal);
        if (catalogs.flat().length > 256) throw Error('Model catalog exceeds projection limit');
        models = {
          kind: 'ready',
          items: catalogs.flatMap((catalog) =>
            catalog.map((model) => ({
              id: JSON.stringify([model.provider, model.id]),
              label: `${model.name.slice(0, 160)} · ${model.provider.slice(0, 100)}`,
              // Explicit application output budget, never a guessed provider default.
              value: {
                provider: id.parse(model.provider),
                model: id.parse(model.id),
                maxTokens: 4096,
              },
            })),
          ),
        };
      } catch {
        active(signal);
        models = { kind: 'unavailable', message: '模型目录暂不可用，请检查模型配置后刷新。' };
      } finally {
        if (cancel) deadline.removeEventListener('abort', cancel);
      }
    }
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
    const current = currentExecutionRun(node);
    if (current && (current.actorId !== inputs.actorId || current.spaceId !== target.spaceId))
      throw new ExecutionRunError('run-scope-mismatch');
    // This does not project the frozen prompt, method body, owner or grant.
    const saved = current
      ? options.execution.readRunComposition({ ...target, runId: current.attempt.id }).payload
      : undefined;
    const workspaceChoices =
      options.workspaces?.choices(inputs.actorId, target.spaceId, plan.task.projectId) ?? [];
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
                    current.attempt.status !== 'cancelled'
                  ? { kind: 'unavailable', message: '当前运行状态暂不支持重新开始。' }
                  : !current && !['ready', 'needs-revision'].includes(node.command.status)
                    ? { kind: 'unavailable', message: '当前节点尚未进入可处理状态。' }
                    : {
                        kind: 'available',
                        mode: !current
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
      start,
      tools: inputs.items.length ? 'accepted-input-reader' : 'text-only',
      ...(workspaceChoices.length || current?.workspace.kind === 'local'
        ? { workspaces: workspaceChoices }
        : {}),
    };
    active(signal);
    return { ok: true as const, value };
  };
}
