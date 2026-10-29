import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { symbols, type Context } from '@deepseek-ai/cordis';
import { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import { ExecutionRunError } from './execution-run-state.js';
import type { MemberLocalAcceptedRun } from './member-local-execution-protocol.js';
import type {
  NativeSessionBinding,
  NativeWorkGrant,
  NativeWorkScope,
} from './native-work-session-contract.js';
import type { NativeDshOptions } from './native-work-session-dsh.js';
import {
  adoptNativeRunLocalTools,
  NATIVE_RUN_LOCAL_TOOL_CONFIG,
  NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
  NativeRunLocalToolProducer,
  type NativeRunWorkspaceCapability,
} from './native-run-local-tools.js';
import {
  NativeOutputFileByteProducer,
  outputRelativePath,
} from './native-work-session-output-file-source.js';

const id = z.string().trim().min(1).max(200);
export const memberNativePublishRanges = z
  .array(
    z.strictObject({
      kind: z.enum(['file', 'directory']),
      path: z
        .string()
        .min(1)
        .max(512)
        .refine((path) => {
          try {
            return outputRelativePath(path) === path;
          } catch {
            return false;
          }
        }),
    }),
  )
  .max(16)
  .refine(
    (ranges) =>
      new Set(ranges.map((range) => `${range.kind}:${range.path}`)).size === ranges.length,
  );
/** Only the private, current local owner accepts this per-Run permission. */
export const memberNativeWorkspaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text-only') }),
  z.strictObject({ kind: z.literal('local'), id, publish: memberNativePublishRanges.default([]) }),
]);
type Target = Pick<NativeWorkScope, 'spaceId' | 'taskId' | 'planId' | 'revision' | 'nodeId'>;
type LocalChoice = {
  id: string;
  access: 'read' | 'write';
  label: string;
  source: NonNullable<ReturnType<WorkspaceRegistry['get']>>;
  identity: unknown;
  path: string;
  createdAt: string;
  dev: number;
  ino: number;
};
type Selection = {
  readonly fingerprint: string;
  readonly target: Target;
  readonly choice: LocalChoice;
  readonly paths: z.infer<typeof memberNativePublishRanges>;
  readonly workspace: {
    kind: 'local';
    rootId: string;
    grantId: string;
    generation: number;
    access: 'read' | 'write';
  };
};
type Bound = {
  readonly accepted: MemberLocalAcceptedRun;
  readonly local?: Selection;
  session?: { context: Context; agent: Agent; session: Session; published: boolean };
  bytes?: NativeOutputFileByteProducer;
};
const original = (value: unknown): unknown =>
  value && typeof value === 'object' ? (Reflect.get(value, symbols.original) ?? value) : value;
const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalPayload(value)).digest('hex');
function denied(): never {
  throw new ExecutionRunError('run-authority-denied');
}

/** Private, process-local permissions over original registered Workspaces.
 * This is not an approval database or an execution owner. Cold readers retain
 * their original history/Stop path, but never recover these file permissions. */
export function createHostMemberNativeWorkspaces(
  ctx: Context,
  options: {
    readonly connectionId: string;
    readonly backendId: string;
    readonly deviceId: string;
    readonly actorId: string;
    readonly signal: AbortSignal;
  },
) {
  const local = new AbortController();
  const signal = AbortSignal.any([local.signal, options.signal]);
  const identity = fingerprint({
    connectionId: options.connectionId,
    backendId: options.backendId,
    deviceId: options.deviceId,
    actorId: options.actorId,
  });
  let ready = false,
    closed = false,
    definitions: Context | undefined;
  let registryIdentity: unknown, sandboxIdentity: unknown, fsIdentity: unknown;
  let producer: NativeRunLocalToolProducer | undefined;
  const selections = new Map<string, Selection>();
  const bound = new Map<string, Bound>();
  const acceptedRequests = new Set<string>();
  const bytes = new Set<NativeOutputFileByteProducer>();
  const fiber = ctx.plugin({
    name: 'zhuma-member-native-workspaces',
    inject: ['workspaceRegistry', 'fs', 'tools', 'sandboxPolicy', 'sessions'],
    async apply(owner: Context) {
      if (signal.aborted) return;
      owner.effect(() => () => {
        ready = false;
        local.abort();
      });
      const source = owner.isolate('tools').isolate('systemPrompt').isolate('fs');
      await source.plugin(FsLocal);
      await source.plugin(SystemPrompt);
      await source.plugin(Tools, { mode: 'native' });
      await source.plugin(ToolFs, NATIVE_RUN_LOCAL_TOOL_CONFIG);
      definitions = source;
      ready = !signal.aborted;
    },
  });
  // Optional filesystem readiness never blocks the original text-only owner.
  const whenReady = Promise.resolve(fiber).then(
    () => undefined,
    () => {
      local.abort();
    },
  );
  function active() {
    ctx.fiber.assertActive();
    if (closed || signal.aborted || !ready || !definitions) denied();
    definitions.fiber.assertActive();
    if (
      identity !==
      fingerprint({
        connectionId: options.connectionId,
        backendId: options.backendId,
        deviceId: options.deviceId,
        actorId: options.actorId,
      })
    )
      denied();
  }
  function services() {
    active();
    const registry = ctx.get('workspaceRegistry'),
      sandbox = ctx.get('sandboxPolicy'),
      fs = ctx.get('fs');
    if (
      !registry ||
      !(original(registry) instanceof WorkspaceRegistry) ||
      !sandbox ||
      !(original(sandbox) instanceof SandboxPolicyService) ||
      !fs ||
      (registryIdentity && registryIdentity !== original(registry)) ||
      (sandboxIdentity && sandboxIdentity !== original(sandbox)) ||
      (fsIdentity && fsIdentity !== original(fs)) ||
      Reflect.get(original(sandbox) as object, 'resolve') !== SandboxPolicyService.prototype.resolve
    )
      denied();
    registryIdentity ??= original(registry);
    sandboxIdentity ??= original(sandbox);
    fsIdentity ??= original(fs);
    return { registry, sandbox };
  }
  function policy(session?: Session) {
    const { sandbox } = services();
    const value = sandbox.resolve(session ? { session } : {});
    if (
      !['read-only', 'workspace-write', 'danger-full-access'].includes(value.mode) ||
      !isAbsolute(value.workspaceRoot)
    )
      denied();
    return value;
  }
  function tools() {
    active();
    producer ??= new NativeRunLocalToolProducer(definitions!, {
      sourceVersion: NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
      signal,
      assertCurrent() {
        active();
        return undefined;
      },
    });
    producer.assertCurrent();
    return producer;
  }
  function choices(): LocalChoice[] {
    const { registry } = services();
    const writable = policy().mode !== 'read-only';
    return registry
      .list()
      .slice(0, 50)
      .flatMap((source) => {
        try {
          if (!isAbsolute(source.path) || realpathSync(source.path) !== source.path) return [];
          const stat = statSync(source.path);
          if (!stat.isDirectory()) return [];
          const base = {
            source,
            identity: original(source),
            path: source.path,
            createdAt: source.createdAt,
            dev: stat.dev,
            ino: stat.ino,
          };
          const accesses = writable ? (['read', 'write'] as const) : (['read'] as const);
          return accesses.map((access) => ({
            ...base,
            access,
            label: source.title,
            id: fingerprint({
              identity,
              workspaceId: source.id,
              path: source.path,
              createdAt: source.createdAt,
              dev: stat.dev,
              ino: stat.ino,
              access,
            }),
          }));
        } catch {
          return [];
        }
      });
  }
  function current(selection: Selection) {
    const { registry } = services(),
      saved = selection.choice;
    const source = registry.get(WorkspaceId(saved.source.id));
    if (
      !source ||
      original(source) !== saved.identity ||
      source.createdAt !== saved.createdAt ||
      source.path !== saved.path ||
      realpathSync(source.path) !== saved.path
    )
      denied();
    const stat = statSync(source.path);
    if (
      !stat.isDirectory() ||
      stat.dev !== saved.dev ||
      stat.ino !== saved.ino ||
      (saved.access === 'write' && policy().mode === 'read-only')
    )
      denied();
    tools().describe(saved.access === 'write' ? ['read', 'write', 'edit'] : ['read']);
  }
  function prepare(requestId: string, target: Target, raw: unknown) {
    if (closed || options.signal.aborted || (bound.size >= 128 && !acceptedRequests.has(requestId)))
      denied();
    const input = memberNativeWorkspaceSchema.parse(raw);
    if (input.kind === 'text-only') return undefined;
    active();
    const key = fingerprint({ target, input });
    const previous = selections.get(requestId);
    if (previous) {
      if (previous.fingerprint !== key) denied();
      current(previous);
      return previous;
    }
    if (selections.size >= 128 || bound.size >= 128) denied();
    const choice = choices().find((choice) => choice.id === input.id);
    if (!choice) denied();
    const selected: Selection = {
      fingerprint: key,
      target: structuredClone(target),
      choice,
      paths: structuredClone(input.publish),
      workspace: {
        kind: 'local',
        rootId: choice.source.id,
        grantId: randomUUID(),
        generation: 1,
        access: choice.access,
      },
    };
    current(selected);
    selections.set(requestId, selected);
    return selected;
  }
  function bind(requestId: string, accepted: MemberLocalAcceptedRun) {
    const { backendId, ...scope } = accepted.value.scope;
    if (
      closed ||
      options.signal.aborted ||
      backendId !== options.backendId ||
      accepted.value.deviceId !== options.deviceId ||
      scope.actorId !== options.actorId ||
      canonicalPayload(scope) !== canonicalPayload(accepted.composition.payload.scope)
    )
      denied();
    const selected = selections.get(requestId),
      snapshot = accepted.composition;
    if (selected) {
      current(selected);
      const {
        runId: _runId,
        generation: _generation,
        segmentId: _segmentId,
        actorId: _actorId,
        ...target
      } = scope;
      if (
        canonicalPayload(target) !== canonicalPayload(selected.target) ||
        snapshot.payload.tools.kind !== 'local-tools' ||
        snapshot.payload.tools.shell ||
        canonicalPayload(snapshot.payload.tools.definitions) !==
          canonicalPayload(
            tools().describe(
              selected.choice.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
            ),
          )
      )
        denied();
    } else if (snapshot.payload.tools.kind === 'local-tools') denied();
    const key = fingerprint(scope),
      previous = bound.get(key);
    if (previous) {
      if (
        previous.local !== selected ||
        canonicalPayload(previous.accepted.composition) !== canonicalPayload(snapshot)
      )
        denied();
      return;
    }
    if (bound.size >= 128) denied();
    bound.set(key, { accepted, ...(selected ? { local: selected } : {}) });
    acceptedRequests.add(requestId);
  }
  function locate(binding: NativeSessionBinding, grant: NativeWorkGrant) {
    grant.assertCurrent('send');
    if (
      closed ||
      options.signal.aborted ||
      canonicalPayload(binding.scope) !== canonicalPayload(grant.scope)
    )
      denied();
    const value = bound.get(fingerprint(grant.scope));
    if (!value || value.accepted.composition.configurationId !== binding.selection.configurationId)
      denied();
    if (value.local) current(value.local);
    return value;
  }
  function capability(
    value: Bound,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): NativeRunWorkspaceCapability {
    const selected = value.local;
    if (!selected || !value.session) denied();
    const fixed = value.session;
    const check = (action: 'read' | 'write'): undefined => {
      if (locate(binding, grant) !== value || value.session !== fixed) denied();
      fixed.context.fiber.assertActive();
      const published = ctx.sessions.get(SessionId(binding.nativeSessionId));
      if (published) fixed.published = true;
      if (
        (published && original(published) !== original(fixed.session)) ||
        (!published && fixed.published) ||
        scopeOf(fixed.context) !== fixed.agent ||
        fixed.agent.session !== fixed.session ||
        fixed.session.id !== binding.nativeSessionId ||
        fixed.agent.id !== binding.nativeAgentId ||
        fixed.session.header.cwd !== selected.choice.path
      )
        denied();
      const effective = policy(fixed.session);
      if (
        action === 'write' &&
        (selected.choice.access !== 'write' ||
          effective.mode === 'read-only' ||
          effective.workspaceRoot !== selected.choice.path)
      )
        denied();
      return undefined;
    };
    check('read');
    return Object.freeze({
      scope: structuredClone(grant.scope),
      root: selected.choice.path,
      permissions: Object.freeze({ read: true, write: selected.choice.access === 'write' }),
      signal: AbortSignal.any([signal, grant.signal]),
      assertCurrent: check,
    });
  }
  const native: NativeDshOptions = {
    async workingDirectory(binding, grant) {
      const value = locate(binding, grant),
        selected = value.local;
      if (!selected) return { kind: 'text-only' };
      const fs = tools().filesystem,
        combined = AbortSignal.any([signal, grant.signal]);
      const root = await fs.resolve(selected.choice.path, { signal: combined });
      const info = await fs.stat(root, combined);
      if (info?.type !== 'directory' || fs.processPath(root) !== selected.choice.path) denied();
      locate(binding, grant);
      return {
        kind: 'local',
        workspaceId: selected.choice.source.id,
        cwd: selected.choice.path,
        scope: grant.scope,
        signal: combined,
        assertCurrent() {
          locate(binding, grant);
          return undefined;
        },
      };
    },
    async compose(agentCtx, binding, grant) {
      const value = locate(binding, grant),
        selected = value.local;
      if (!selected) return { context: '', toolAllowlist: [] };
      const agent = scopeOf(agentCtx) as Agent | undefined;
      if (
        !agent ||
        agent.ctx !== agentCtx ||
        agent.id !== binding.nativeAgentId ||
        !agent.session ||
        agent.session.id !== binding.nativeSessionId ||
        agent.session.header.cwd !== selected.choice.path
      )
        denied();
      if (value.session && value.session.agent !== agent) denied();
      if (!value.session) {
        const saved = {
          context: agentCtx,
          agent,
          session: agent.session,
          published: !!ctx.sessions.get(SessionId(binding.nativeSessionId)),
        };
        value.session = saved;
        agentCtx.effect(() => () => {
          if (value.session === saved) delete value.session;
        });
      }
      await adoptNativeRunLocalTools(agentCtx, binding, grant, {
        composition: value.accepted.composition,
        producer: tools(),
        workspace: capability(value, binding, grant),
      });
      locate(binding, grant);
      // C owns result/resource/input tools; extra composition adds only real FS tools.
      return {
        context: selected.paths.length
          ? `文件交付范围（相对工作区）：${selected.paths.map((range) => `${range.kind}: ${range.path}`).join('；')}。范围外文件不得上传。`
          : '本次未授权上传本机文件；可在工作区操作后提交文字成果。',
        toolAllowlist: selected.choice.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
      };
    },
  };
  return {
    ready: whenReady,
    /** Metadata for the workflow ceiling only; every node still needs prepare/bind. */
    workflowWorkspace(raw: unknown) {
      const input = memberNativeWorkspaceSchema.parse(raw);
      if (input.kind === 'text-only')
        return { workspace: { kind: 'text-only' as const }, localTools: [] };
      const choice = choices().find((item) => item.id === input.id);
      if (!choice) denied();
      return {
        workspace: {
          kind: 'local' as const,
          rootId: choice.source.id,
          access: choice.access,
          ...(input.publish.length ? { publish: structuredClone(input.publish) } : {}),
        },
        localTools: tools().describe(
          choice.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
        ),
      };
    },
    workflowSelection(
      workspace:
        | { kind: 'text-only' }
        | {
            kind: 'local';
            rootId: string;
            access: 'read' | 'write';
            publish?: z.infer<typeof memberNativePublishRanges> | undefined;
          },
    ) {
      if (workspace.kind === 'text-only') return { kind: 'text-only' as const };
      const choice = choices().find(
        (item) => item.source.id === workspace.rootId && item.access === workspace.access,
      );
      if (!choice) denied();
      return {
        kind: 'local' as const,
        id: choice.id,
        ...(workspace.publish === undefined
          ? {}
          : { publish: memberNativePublishRanges.parse(workspace.publish) }),
      };
    },
    choices() {
      try {
        tools();
        return choices().map(({ id, label, access }) => ({
          id,
          label,
          access,
          publish: false,
          publication: 'per-run' as const,
        }));
      } catch {
        return [];
      }
    },
    prepare,
    describe(selection: Selection) {
      current(selection);
      return tools().describe(
        selection.choice.access === 'write' ? ['read', 'write', 'edit'] : ['read'],
      );
    },
    bind,
    native,
    /** Presentation only. No cold reconstruction or replacement permission. */
    selection(scope: NativeWorkScope) {
      const value = bound.get(fingerprint(scope));
      if (!value?.local) return { kind: 'unavailable' as const };
      try {
        current(value.local);
        return {
          kind: 'local' as const,
          id: value.local.choice.id,
          publish: structuredClone(value.local.paths),
        };
      } catch {
        return { kind: 'unavailable' as const };
      }
    },
    output(binding: NativeSessionBinding, grant: NativeWorkGrant) {
      const value = locate(binding, grant),
        selected = value.local;
      if (!selected) denied();
      const workspace = capability(value, binding, grant);
      value.bytes ??= new NativeOutputFileByteProducer(tools(), workspace, {
        scope: structuredClone(grant.scope),
        configurationId: binding.selection.configurationId,
        signal: workspace.signal,
        paths: structuredClone(selected.paths),
        assertCurrent(path) {
          outputRelativePath(path);
          workspace.assertCurrent('read');
          return undefined;
        },
      });
      bytes.add(value.bytes);
      return value.bytes;
    },
    fence() {
      closed = true;
      local.abort();
    },
    async close() {
      closed = true;
      local.abort();
      await Promise.all([...bytes].map((source) => source.close()));
      await fiber.dispose();
      selections.clear();
      bound.clear();
      acceptedRequests.clear();
      bytes.clear();
    },
  };
}
