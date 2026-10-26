import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { symbols, type Context } from '@deepseek-ai/cordis';
import { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { z } from 'zod';
import { canonicalPayload, type Workbench } from '@zhuma/agent-core';
import type { ExecutionService } from './execution-service.js';
import {
  ExecutionRunError,
  currentExecutionRun,
  readExecutionRunState,
  type ExecutionWorkspace,
} from './execution-run-state.js';
import type { FrozenExecutionRunComposition } from './execution-run-composition.js';
import type { NativeSessionBinding, NativeWorkGrant } from './native-work-session-contract.js';
import {
  NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
  NATIVE_RUN_LOCAL_TOOL_CONFIG,
  NativeRunLocalToolProducer,
  type NativeRunWorkspaceCapability,
} from './native-run-local-tools.js';
import {
  NativeOutputFileByteProducer,
  outputRelativePath,
} from './native-work-session-output-file-source.js';
import type { NativeOutputPublicationAuthority } from './native-work-session-output-file-contract.js';
import { describeNativeOutputFileTool } from './native-work-session-output-file-tool.js';
import { describeAcceptedInputTool } from './native-work-session-input-tool.js';

const id = z.string().trim().min(1).max(200);
const range = z.strictObject({
  kind: z.enum(['file', 'directory']),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => {
      try {
        return outputRelativePath(value) === value;
      } catch {
        return false;
      }
    }),
});
/** Private operator configuration; neither the browser nor a workspace row issues grants. */
export const hostLocalExecutionSchema = z.strictObject({
  deviceId: id,
  bindings: z
    .array(
      z.strictObject({
        id,
        generation: z.number().int().positive().refine(Number.isSafeInteger),
        actorId: id,
        spaceId: id,
        projectId: id,
        workspaceId: id,
        access: z.enum(['read', 'write']),
        publish: z.array(range).max(128).default([]),
      }),
    )
    .max(100)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length),
});
export type HostLocalExecutionConfig = z.infer<typeof hostLocalExecutionSchema>;
export type HostWorkspaceChoice = {
  readonly id: string;
  readonly label: string;
  readonly access: 'read' | 'write';
  readonly publish: boolean;
};
type Execution = Pick<ExecutionService, 'readRunNode' | 'readRunComposition'>;
const original = (value: unknown): unknown =>
  value && typeof value === 'object' ? (Reflect.get(value, symbols.original) ?? value) : value;
function denied(): never {
  throw new ExecutionRunError('run-authority-denied');
}

/** Host-local projection over the original configuration, SDK registry and Run facts. */
export function createHostRunWorkspaces(
  ctx: Context,
  options: {
    config?: HostLocalExecutionConfig | undefined;
    readonly execution: Execution;
    readonly signal: AbortSignal;
    readWorkbench(): Workbench;
  },
) {
  const config =
    options.config === undefined ? undefined : hostLocalExecutionSchema.parse(options.config);
  const sourceConfig = options.config;
  const sourceBindings = sourceConfig?.bindings;
  const execution = options.execution;
  const readNode = execution.readRunNode;
  const readComposition = execution.readRunComposition;
  const readWorkbench = options.readWorkbench;
  const lifetime = options.signal;
  const localLifetime = new AbortController();
  const localSignal = AbortSignal.any([lifetime, localLifetime.signal]);
  const policyLifetimes = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let localReady = false;
  let metadataContext: Context | undefined;
  const changed = () =>
    queueMicrotask(() => {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* Listeners cannot restore a revoked source. */
        }
      }
    });
  localLifetime.signal.addEventListener('abort', changed, { once: true });
  // This component follows the original SDK dependencies. Their unload cancels
  // local I/O without introducing another Host or disabling text-only work.
  const localOwner = config?.bindings.length
    ? ctx.plugin({
        name: 'zhuma-local-workspace-owner',
        inject: ['workspaceRegistry', 'fs', 'tools'],
        async apply(owner: Context) {
          if (localSignal.aborted) return;
          owner.effect(() => () => {
            localReady = false;
            localLifetime.abort();
          });
          // A private original SDK Tools service owns real registrations with
          // the SAME bounded config as runtime adoption. No Agent/session is
          // created here, and Agents never inherit this metadata-only context.
          const definitions = owner.isolate('tools').isolate('systemPrompt');
          await definitions.plugin(SystemPrompt);
          await definitions.plugin(Tools, { mode: 'native' });
          await definitions.plugin(ToolFs, NATIVE_RUN_LOCAL_TOOL_CONFIG);
          metadataContext = definitions;
          localReady = true;
        },
      })
    : undefined;
  const ready = localOwner
    ? Promise.resolve(localOwner).then(
        () => undefined,
        () => {
          localLifetime.abort();
        },
      )
    : Promise.resolve();
  const remembered = new Map<
    string,
    { snapshot: FrozenExecutionRunComposition; workspace: ExecutionWorkspace }
  >();
  let registry: WorkspaceRegistry | undefined;
  let producer: NativeRunLocalToolProducer | undefined;
  const roots = new Map<string, { identity: unknown; path: string; createdAt: string }>();
  function active() {
    ctx.fiber.assertActive();
    if (
      closed ||
      lifetime.aborted ||
      options.signal !== lifetime ||
      options.execution !== execution ||
      execution.readRunNode !== readNode ||
      execution.readRunComposition !== readComposition ||
      options.readWorkbench !== readWorkbench ||
      options.config !== sourceConfig ||
      sourceConfig?.bindings !== sourceBindings ||
      sourceConfig?.deviceId !== config?.deviceId
    ) {
      localLifetime.abort();
      denied();
    }
  }
  function actualRegistry() {
    active();
    if (!localReady || localSignal.aborted) denied();
    const current = ctx.get('workspaceRegistry');
    const identity = original(current);
    if (
      !(identity instanceof WorkspaceRegistry) ||
      (registry && identity !== registry) ||
      !current
    ) {
      localLifetime.abort();
      denied();
    }
    registry ??= identity;
    return current;
  }
  function actualProducer() {
    active();
    if (!metadataContext || !localReady || localSignal.aborted) denied();
    producer ??= new NativeRunLocalToolProducer(metadataContext, {
      sourceVersion: NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
      signal: localSignal,
      assertCurrent() {
        active();
        metadataContext!.fiber.assertActive();
        if (localSignal.aborted) denied();
        return undefined;
      },
    });
    producer.assertCurrent();
    return producer;
  }
  function selected(actorId: string, spaceId: string, projectId: string, bindingId: string) {
    active();
    const policy = config?.bindings.find(
      (row) =>
        row.id === bindingId &&
        row.actorId === actorId &&
        row.spaceId === spaceId &&
        row.projectId === projectId,
    );
    if (!policy || !config) denied();
    const currentPolicy = sourceConfig?.bindings.filter((row) => row.id === policy.id);
    const controller = policyLifetimes.get(policy.id) ?? new AbortController();
    policyLifetimes.set(policy.id, controller);
    if (controller.signal.aborted) denied();
    const parsedPolicy =
      currentPolicy?.length === 1
        ? hostLocalExecutionSchema.shape.bindings.element.safeParse(currentPolicy[0])
        : undefined;
    if (
      !parsedPolicy?.success ||
      canonicalPayload(parsedPolicy.data) !== canonicalPayload(policy)
    ) {
      controller.abort();
      changed();
      denied();
    }
    const source = actualRegistry().get(WorkspaceId(policy.workspaceId));
    if (!source || source.id !== policy.workspaceId || !isAbsolute(source.path)) {
      controller.abort();
      changed();
      denied();
    }
    const identity = original(source);
    const prior = roots.get(policy.id);
    if (
      prior &&
      (prior.identity !== identity ||
        prior.path !== source.path ||
        prior.createdAt !== source.createdAt)
    ) {
      controller.abort();
      changed();
      denied();
    }
    roots.set(policy.id, { identity, path: source.path, createdAt: source.createdAt });
    const tools = actualProducer();
    tools.describe(policy.access === 'write' ? ['read', 'write', 'edit'] : ['read']);
    const grantId = `workspace_${createHash('sha256')
      .update(
        canonicalPayload({
          policy,
          deviceId: config.deviceId,
          path: source.path,
          createdAt: source.createdAt,
        }),
      )
      .digest('hex')}`;
    return {
      policy,
      source,
      tools,
      signal: AbortSignal.any([localSignal, controller.signal]),
      workspace: {
        kind: 'local' as const,
        deviceId: config.deviceId,
        rootId: policy.workspaceId,
        grantId,
        generation: policy.generation,
        access: policy.access,
      },
    };
  }
  function frozen(configurationId: string) {
    active();
    const known = remembered.get(configurationId);
    if (known) return known;
    // Cold recovery reads the original persisted Run; this map is only an index,
    // never an additional workspace, authorization or execution fact store.
    for (const plan of readWorkbench().appliedPlans) {
      for (const flow of plan.task.workflows)
        for (const node of flow.nodes) {
          const locator = {
            taskId: plan.taskId,
            planId: plan.id,
            revision: plan.revision,
            nodeId: node.id,
          };
          const record = readNode.call(execution, locator);
          const run =
            record &&
            readExecutionRunState(record)?.runs.find(
              (run) => run.selection.configurationId === configurationId,
            );
          if (run) {
            const snapshot = readComposition.call(execution, { ...locator, runId: run.attempt.id });
            const value = { snapshot, workspace: run.workspace };
            remember(snapshot, run.workspace);
            return value;
          }
        }
    }
    denied();
  }
  function remember(snapshot: FrozenExecutionRunComposition, workspace: ExecutionWorkspace) {
    active();
    const known = remembered.get(snapshot.configurationId);
    if (known && canonicalPayload(known) !== canonicalPayload({ snapshot, workspace })) denied();
    if (remembered.size >= 256 && !known) remembered.delete(remembered.keys().next().value!);
    remembered.set(snapshot.configurationId, {
      snapshot: structuredClone(snapshot),
      workspace: structuredClone(workspace),
    });
  }
  function assertWorkspace(
    actorId: string,
    spaceId: string,
    workspace: ExecutionWorkspace,
    access: 'read' | 'write',
    configurationId: string,
  ): undefined {
    active();
    if (workspace.kind === 'text-only') return undefined;
    const stored = frozen(configurationId);
    const scope = stored.snapshot.payload.scope;
    if (
      scope.actorId !== actorId ||
      scope.spaceId !== spaceId ||
      canonicalPayload(stored.workspace) !== canonicalPayload(workspace)
    )
      denied();
    const current = byWorkspace(
      actorId,
      spaceId,
      stored.snapshot.payload.plan.projectId,
      workspace,
    );
    if (
      canonicalPayload(current.workspace) !== canonicalPayload(workspace) ||
      (access === 'write' && current.policy.access !== 'write')
    )
      denied();
    return undefined;
  }
  function byWorkspace(
    actorId: string,
    spaceId: string,
    projectId: string,
    workspace: ExecutionWorkspace,
  ) {
    for (const row of config?.bindings ?? []) {
      if (row.actorId !== actorId || row.spaceId !== spaceId || row.projectId !== projectId)
        continue;
      try {
        const current = selected(actorId, spaceId, projectId, row.id);
        if (canonicalPayload(current.workspace) === canonicalPayload(workspace)) return current;
      } catch (error) {
        // An independently revoked binding must not shadow another valid grant.
        if (!(error instanceof ExecutionRunError) || error.code !== 'run-authority-denied')
          throw error;
      }
    }
    denied();
  }
  function resolve(binding: NativeSessionBinding, grant: NativeWorkGrant) {
    active();
    grant.assertCurrent('send');
    const node = readNode.call(execution, grant.scope);
    const run = node && currentExecutionRun(node);
    if (
      !run ||
      run.attempt.id !== grant.scope.runId ||
      run.workspace.kind !== 'local' ||
      canonicalPayload(binding.scope) !== canonicalPayload(grant.scope)
    )
      denied();
    const snapshot = readComposition.call(execution, { ...grant.scope, runId: grant.scope.runId });
    remember(snapshot, run.workspace);
    assertWorkspace(
      grant.scope.actorId,
      grant.scope.spaceId,
      run.workspace,
      run.workspace.access,
      snapshot.configurationId,
    );
    const current = byWorkspace(
      grant.scope.actorId,
      grant.scope.spaceId,
      snapshot.payload.plan.projectId,
      run.workspace,
    );
    const check = (action: 'read' | 'write'): undefined => {
      active();
      grant.assertCurrent('send');
      const latest = readNode.call(execution, grant.scope);
      const latestRun = latest && currentExecutionRun(latest);
      if (
        !latestRun ||
        latestRun.attempt.id !== grant.scope.runId ||
        latestRun.selection.configurationId !== snapshot.configurationId
      )
        denied();
      return assertWorkspace(
        grant.scope.actorId,
        grant.scope.spaceId,
        latestRun.workspace,
        action,
        snapshot.configurationId,
      );
    };
    const workspace: NativeRunWorkspaceCapability = Object.freeze({
      scope: structuredClone(grant.scope),
      root: current.source.path,
      permissions: Object.freeze({ read: true, write: current.policy.access === 'write' }),
      signal: AbortSignal.any([current.signal, grant.signal]),
      assertCurrent: check,
    });
    return { ...current, snapshot, workspace };
  }
  return {
    ready,
    /** The Host calls this only after native and physical I/O cleanup confirms drain. */
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      localLifetime.abort();
      return (closing = (async () => {
        await localOwner?.dispose();
        listeners.clear();
        remembered.clear();
        roots.clear();
        metadataContext = undefined;
        producer = undefined;
      })());
    },
    dependenciesPresent: () =>
      !!ctx.get('workspaceRegistry') && !!ctx.get('fs') && !!ctx.get('tools'),
    onChange(callback: () => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    remember,
    assertWorkspace,
    assertComposition(snapshot: FrozenExecutionRunComposition): undefined {
      const stored = frozen(snapshot.configurationId);
      if (
        stored.workspace.kind !== 'local' ||
        canonicalPayload(stored.snapshot) !== canonicalPayload(snapshot)
      )
        denied();
      const scope = snapshot.payload.scope;
      assertWorkspace(
        scope.actorId,
        scope.spaceId,
        stored.workspace,
        stored.workspace.access,
        snapshot.configurationId,
      );
      const local = byWorkspace(
        scope.actorId,
        scope.spaceId,
        snapshot.payload.plan.projectId,
        stored.workspace,
      );
      const tools = {
        kind: 'local-tools',
        definitions: local.tools.describe(
          local.policy.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
        ),
        ...(snapshot.payload.inputs.length
          ? { acceptedInputReader: describeAcceptedInputTool() }
          : {}),
      };
      if (
        canonicalPayload(snapshot.payload.tools) !== canonicalPayload(tools) ||
        canonicalPayload(
          snapshot.schemaVersion === 2 ? (snapshot.payload.outputFilePublisherTool ?? null) : null,
        ) !== canonicalPayload(local.policy.publish.length ? describeNativeOutputFileTool() : null)
      )
        denied();
      return undefined;
    },
    choices(actorId: string, spaceId: string, projectId: string): readonly HostWorkspaceChoice[] {
      active();
      return (config?.bindings ?? [])
        .filter(
          (row) =>
            row.actorId === actorId && row.spaceId === spaceId && row.projectId === projectId,
        )
        .flatMap((row) => {
          try {
            const current = selected(actorId, spaceId, projectId, row.id);
            return [
              {
                id: row.id,
                label: current.source.title,
                access: row.access,
                publish: row.publish.length > 0,
              },
            ];
          } catch {
            return [];
          }
        });
    },
    select: selected,
    resolve,
    output(binding: NativeSessionBinding, grant: NativeWorkGrant) {
      const current = resolve(binding, grant);
      if (!current.policy.publish.length) denied();
      const paths = structuredClone(current.policy.publish);
      const publication: NativeOutputPublicationAuthority = Object.freeze({
        scope: structuredClone(grant.scope),
        configurationId: current.snapshot.configurationId,
        signal: current.workspace.signal,
        paths,
        assertCurrent(path: string): undefined {
          current.workspace.assertCurrent('read');
          const fresh = selected(
            grant.scope.actorId,
            grant.scope.spaceId,
            current.snapshot.payload.plan.projectId,
            current.policy.id,
          );
          if (
            canonicalPayload(fresh.policy.publish) !== canonicalPayload(paths) ||
            !paths.some(
              (range) =>
                path === range.path ||
                (range.kind === 'directory' && path.startsWith(`${range.path}/`)),
            )
          )
            denied();
          outputRelativePath(path);
          return undefined;
        },
      });
      return new NativeOutputFileByteProducer(current.tools, current.workspace, publication);
    },
  };
}
