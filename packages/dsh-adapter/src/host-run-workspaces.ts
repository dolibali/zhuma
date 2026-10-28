import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { symbols, type Context } from '@deepseek-ai/cordis';
import { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { scopeOf } from '@deepseek-ai/dsh-scope';
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
import type {
  WorkspaceApprovalIdentity,
  WorkspaceApprovalOwner,
} from './execution-workspace-approval-contract.js';

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
type LocalPolicy = HostLocalExecutionConfig['bindings'][number];
type PolicySource = {
  readonly policy: LocalPolicy;
  readonly deviceId: string;
  readonly identity?: WorkspaceApprovalIdentity;
};
const policyKey = (source: PolicySource) =>
  createHash('sha256').update(canonicalPayload(source)).digest('hex');
type BoundSession = { context: Context; agent: Agent; session: Session; published: boolean };
type RememberedWorkspace = {
  snapshot: FrozenExecutionRunComposition;
  workspace: ExecutionWorkspace;
  session?: BoundSession;
};
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
    readonly approvals?: WorkspaceApprovalOwner | undefined;
    readonly execution: Execution;
    readonly signal: AbortSignal;
    readWorkbench(): Workbench;
  },
) {
  const config =
    options.config === undefined ? undefined : hostLocalExecutionSchema.parse(options.config);
  const sourceConfig = options.config;
  const sourceBindings = sourceConfig?.bindings;
  const approvals = options.approvals;
  const approvalSnapshot = approvals?.snapshot;
  const approvalSubscribe = approvals?.onChange;
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
  const localOwner =
    config?.bindings.length || approvals
      ? ctx.plugin({
          name: 'zhuma-local-workspace-owner',
          inject: ['workspaceRegistry', 'fs', 'tools', 'sandboxPolicy', 'sessions'],
          async apply(owner: Context) {
            if (localSignal.aborted) return;
            owner.effect(() => () => {
              localReady = false;
              localLifetime.abort();
            });
            // A private original SDK Tools service owns real registrations with
            // the SAME bounded config as runtime adoption. No Agent/session is
            // created here, and Agents never inherit this metadata-only context.
            const definitions = owner.isolate('tools').isolate('systemPrompt').isolate('fs');
            await definitions.plugin(FsLocal);
            await definitions.plugin(SystemPrompt);
            await definitions.plugin(Tools, { mode: 'native' });
            await definitions.plugin(ToolFs, NATIVE_RUN_LOCAL_TOOL_CONFIG);
            metadataContext = definitions;
            localReady = true;
            owner.on(
              'session/event',
              (_session, event) => {
                if (event.type === 'sandbox/mode') changed();
              },
              { global: true },
            );
            owner.on('session/disposed', () => changed(), { global: true });
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
  const remembered = new Map<string, RememberedWorkspace>();
  let registry: WorkspaceRegistry | undefined;
  let sandbox: SandboxPolicyService | undefined;
  let resolvePolicy: SandboxPolicyService['resolve'] | undefined;
  let producer: NativeRunLocalToolProducer | undefined;
  const roots = new Map<
    string,
    { identity: unknown; path: string; createdAt: string; canonical?: string }
  >();
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
      options.approvals !== approvals ||
      approvals?.snapshot !== approvalSnapshot ||
      approvals?.onChange !== approvalSubscribe ||
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
  function sdkPolicy(session?: Session) {
    active();
    const current = ctx.get('sandboxPolicy');
    const identity = original(current);
    if (
      !current ||
      !(identity instanceof SandboxPolicyService) ||
      identity.resolve !== SandboxPolicyService.prototype.resolve ||
      (sandbox && identity !== sandbox) ||
      (resolvePolicy && identity.resolve !== resolvePolicy)
    ) {
      localLifetime.abort();
      denied();
    }
    sandbox ??= identity;
    resolvePolicy ??= identity.resolve;
    // No explicit mode: only the original deployment and real session projection apply.
    const policy = current.resolve(session ? { session } : {});
    if (
      !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode) ||
      !isAbsolute(policy.workspaceRoot)
    )
      denied();
    return policy;
  }
  function sameGrant(left: ExecutionWorkspace, right: ExecutionWorkspace) {
    if (left.kind !== 'local' || right.kind !== 'local') return false;
    const { access: _leftAccess, ...a } = left;
    const { access: _rightAccess, ...b } = right;
    return canonicalPayload(a) === canonicalPayload(b);
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
  function policySources(): PolicySource[] {
    active();
    // These are the original domain facts, not a cached permission table. A
    // tombstone shadows legacy configuration for the same member/project/root.
    const state = approvals?.snapshot().state;
    const rows = state?.approvals ?? [];
    const legacy = (config?.bindings ?? []).filter(
      (policy) =>
        !rows.some(
          (row) =>
            row.id === policy.id ||
            (row.actorId === policy.actorId &&
              row.spaceId === policy.spaceId &&
              row.projectId === policy.projectId &&
              row.identity.workspaceId === policy.workspaceId),
        ),
    );
    return [
      ...legacy.map((policy) => ({ policy, deviceId: config!.deviceId })),
      ...rows.flatMap((row): PolicySource[] =>
        row.status === 'approved' && row.policy && state
          ? [
              {
                policy: {
                  id: row.id,
                  generation: row.generation,
                  actorId: row.actorId,
                  spaceId: row.spaceId,
                  projectId: row.projectId,
                  workspaceId: row.identity.workspaceId,
                  ...row.policy,
                },
                deviceId: state.deviceId,
                identity: row.identity,
              },
            ]
          : [],
      ),
    ];
  }
  const stopApprovals = approvals?.onChange(() => {
    let current: Set<string>;
    try {
      current = new Set(policySources().map(policyKey));
    } catch {
      current = new Set();
    }
    // Abort the old generation immediately, including pending physical IO.
    for (const [key, controller] of policyLifetimes)
      if (!current.has(key)) {
        controller.abort();
        policyLifetimes.delete(key);
        roots.delete(key);
      }
    changed();
  });
  function selected(actorId: string, spaceId: string, projectId: string, bindingId: string) {
    active();
    const binding = policySources().find(
      ({ policy }) =>
        policy.id === bindingId &&
        policy.actorId === actorId &&
        policy.spaceId === spaceId &&
        policy.projectId === projectId,
    );
    if (!binding) denied();
    const { policy, deviceId, identity: approvedIdentity } = binding;
    const key = policyKey(binding);
    const currentPolicy = sourceConfig?.bindings.filter((row) => row.id === policy.id);
    const controller = policyLifetimes.get(key) ?? new AbortController();
    policyLifetimes.set(key, controller);
    if (controller.signal.aborted) denied();
    const parsedPolicy =
      currentPolicy?.length === 1
        ? hostLocalExecutionSchema.shape.bindings.element.safeParse(currentPolicy[0])
        : undefined;
    if (
      !approvedIdentity &&
      (!parsedPolicy?.success || canonicalPayload(parsedPolicy.data) !== canonicalPayload(policy))
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
    if (approvedIdentity) {
      try {
        if (
          source.createdAt !== approvedIdentity.createdAt ||
          source.path !== realpathSync(source.path) ||
          !statSync(source.path).isDirectory() ||
          createHash('sha256').update(source.path).digest('hex') !==
            approvedIdentity.pathFingerprint
        )
          denied();
      } catch {
        controller.abort();
        changed();
        denied();
      }
    }
    const identity = original(source);
    const prior = roots.get(key);
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
    roots.set(key, prior ?? { identity, path: source.path, createdAt: source.createdAt });
    const access: 'read' | 'write' =
      policy.access === 'write' && sdkPolicy().mode !== 'read-only' ? 'write' : 'read';
    const tools = actualProducer();
    tools.describe(access === 'write' ? ['read', 'write', 'edit'] : ['read']);
    const grantId = `workspace_${createHash('sha256')
      .update(
        canonicalPayload({
          policy,
          deviceId,
          path: source.path,
          createdAt: source.createdAt,
        }),
      )
      .digest('hex')}`;
    return {
      policy,
      key,
      source,
      tools,
      signal: AbortSignal.any([localSignal, controller.signal]),
      workspace: {
        kind: 'local' as const,
        deviceId,
        rootId: policy.workspaceId,
        grantId,
        generation: policy.generation,
        access,
      },
    };
  }
  function frozen(configurationId: string): RememberedWorkspace {
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
    if (known) {
      if (
        canonicalPayload({ snapshot: known.snapshot, workspace: known.workspace }) !==
        canonicalPayload({ snapshot, workspace })
      )
        denied();
      return;
    }
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
      !sameGrant(current.workspace, workspace) ||
      (workspace.access === 'write' && current.policy.access !== 'write') ||
      (access === 'write' && workspace.access !== 'write')
    )
      denied();
    const node = readNode.call(execution, scope);
    const run = node && currentExecutionRun(node);
    const sessionId = run?.attempt.id === scope.runId ? run.attempt.sessionId : undefined;
    const session =
      stored.session?.session ?? (sessionId ? ctx.sessions.get(SessionId(sessionId)) : undefined);
    if (access === 'write' && sdkPolicy(session).mode === 'read-only') denied();
    return undefined;
  }
  function byWorkspace(
    actorId: string,
    spaceId: string,
    projectId: string,
    workspace: ExecutionWorkspace,
  ) {
    for (const { policy: row } of policySources()) {
      if (row.actorId !== actorId || row.spaceId !== spaceId || row.projectId !== projectId)
        continue;
      try {
        const current = selected(actorId, spaceId, projectId, row.id);
        if (sameGrant(current.workspace, workspace)) return current;
      } catch (error) {
        // An independently revoked binding must not shadow another valid grant.
        if (!(error instanceof ExecutionRunError) || error.code !== 'run-authority-denied')
          throw error;
      }
    }
    denied();
  }
  function located(binding: NativeSessionBinding, grant: NativeWorkGrant) {
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
    return { ...current, snapshot, frozenWorkspace: run.workspace };
  }
  async function directory(binding: NativeSessionBinding, grant: NativeWorkGrant) {
    const current = located(binding, grant);
    const filesystem = current.tools.filesystem;
    const signal = AbortSignal.any([current.signal, grant.signal]);
    const target = await filesystem.resolve(current.source.path, { signal });
    const info = await filesystem.stat(target, signal);
    grant.assertCurrent('send');
    const canonical = filesystem.processPath(target);
    // Registry.create accepts only real canonical directories. Re-prove that identity
    // on explicit start, before the original runtime creates the session cwd.
    if (info?.type !== 'directory' || canonical !== current.source.path) denied();
    const root = roots.get(current.key);
    if (!root || (root.canonical && root.canonical !== canonical)) denied();
    root.canonical = canonical;
    const check = () => {
      grant.assertCurrent('send');
      return assertWorkspace(
        grant.scope.actorId,
        grant.scope.spaceId,
        current.frozenWorkspace,
        current.frozenWorkspace.access,
        current.snapshot.configurationId,
      );
    };
    check();
    return {
      kind: 'local' as const,
      scope: grant.scope,
      cwd: canonical,
      workspaceId: current.policy.workspaceId,
      signal,
      assertCurrent: check,
    };
  }
  function bindSession(
    agentContext: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ) {
    const current = located(binding, grant);
    const agent = scopeOf(agentContext) as Partial<Agent> | undefined;
    if (
      !agent ||
      agent.id !== binding.nativeAgentId ||
      agent.ctx !== agentContext ||
      !agent.session ||
      agent.session.id !== binding.nativeSessionId ||
      scopeOf(agent.ctx) !== agent
    )
      denied();
    const canonical = roots.get(current.key)?.canonical;
    if (!canonical || agent.session.header.cwd !== canonical) denied();
    const stored = frozen(current.snapshot.configurationId);
    if (stored.session && stored.session.agent !== agent) denied();
    if (stored.session) return;
    const session = agent.session;
    const bound = {
      context: agentContext,
      agent: agent as Agent,
      session,
      published: !!ctx.sessions.get(SessionId(session.id)),
    };
    stored.session = bound;
    agentContext.effect(() => () => {
      if (stored.session === bound) delete stored.session;
      changed();
    });
  }
  function resolve(binding: NativeSessionBinding, grant: NativeWorkGrant) {
    const current = located(binding, grant);
    const snapshot = current.snapshot;
    const canonical = roots.get(current.key)?.canonical;
    const bound = frozen(snapshot.configurationId).session;
    const session = bound?.session;
    if (
      !canonical ||
      !bound ||
      !session ||
      session.id !== binding.nativeSessionId ||
      session.header.cwd !== canonical
    )
      denied();
    const sessionIdentity = original(session);
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
      assertWorkspace(
        grant.scope.actorId,
        grant.scope.spaceId,
        latestRun.workspace,
        action,
        snapshot.configurationId,
      );
      bound.context.fiber.assertActive();
      const published = ctx.sessions.get(SessionId(binding.nativeSessionId));
      if (published) bound.published = true;
      if (
        (published && original(published) !== sessionIdentity) ||
        (!published && bound.published) ||
        scopeOf(bound.context) !== bound.agent ||
        bound.agent.session !== session ||
        session.header.cwd !== canonical
      )
        denied();
      const policy = sdkPolicy(session);
      if (action === 'write' && (policy.mode === 'read-only' || policy.workspaceRoot !== canonical))
        denied();
      return undefined;
    };
    const workspace: NativeRunWorkspaceCapability = Object.freeze({
      scope: structuredClone(grant.scope),
      root: canonical,
      permissions: Object.freeze({ read: true, write: current.frozenWorkspace.access === 'write' }),
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
      stopApprovals?.();
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
      !!ctx.get('workspaceRegistry') &&
      !!ctx.get('fs') &&
      !!ctx.get('tools') &&
      !!ctx.get('sandboxPolicy') &&
      !!ctx.get('sessions'),
    onChange(callback: () => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    remember,
    sameGrant,
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
          stored.workspace.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
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
      return policySources()
        .map(({ policy }) => policy)
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
                access: current.workspace.access,
                publish: row.publish.length > 0,
              },
            ];
          } catch {
            return [];
          }
        });
    },
    select: selected,
    /** Private workflow defaults are compared with this original local source;
     * a rootId is never a public selector and cannot itself issue authority. */
    selectFrozen(
      actorId: string,
      spaceId: string,
      projectId: string,
      workspace: ExecutionWorkspace,
    ) {
      if (workspace.kind !== 'local') denied();
      const current = byWorkspace(actorId, spaceId, projectId, workspace);
      if (workspace.access === 'write' && current.workspace.access !== 'write') denied();
      return { ...current, workspace: structuredClone(workspace) };
    },
    directory,
    bindSession,
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
