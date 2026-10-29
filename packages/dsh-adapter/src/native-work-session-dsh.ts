import { Service, type Context } from '@deepseek-ai/cordis';
import { isAbsolute } from 'node:path';
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent';
import {
  MessageId,
  ReasoningEffortId,
  createUserMessage,
  type ContextSnapshotSection,
} from '@deepseek-ai/dsh-llm';
import {
  SessionId,
  SessionLogOffset,
  type SessionSeq,
  type UserMessage,
} from '@deepseek-ai/dsh-session';
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection';
import {
  SessionPersistenceNotFoundError,
  type SessionHandle,
} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-tools';
import { PERSONA_PREFIX_SECTION, joinContextSections } from '@deepseek-ai/dsh-system-prompt';
import { assertNativeInputReadOwner } from './native-work-session.js';
import { nativeWorkspaceAttachment } from './native-work-session-workspace.js';
import {
  NativeSessionPurpose,
  assertNativePurposeOwner,
  invokeNativeWorkGrantAssertion,
} from './native-work-session-purpose.js';
import {
  NATIVE_REVIEW_TOOL,
  NATIVE_REVIEW_READ_TOOL,
  nativeReviewScopeKey,
} from './native-work-session-review-contract.js';
import {
  NATIVE_RESULT_LIMITS,
  type NativeResultSnapshot,
} from './native-work-session-result-contract.js';
import {
  publicNativeResultEvent,
  NativePublicResultProjection,
} from './native-work-session-public-result.js';
import {
  requireNativeInboxRetention,
  type RetainedInboxCreateOptions,
  type RetainedInboxResumeOptions,
} from './native-session-lifecycle.js';
import {
  NativeWorkError,
  type NativeHistoryEvent,
  type NativeMessageMode,
  type NativeSessionBinding,
  type NativeSessionMessage,
  type NativeWorkFrame,
  type NativeWorkGrant,
  type NativeWorkRuntime,
  type NativeMigrationDrain,
  type NativeWorkScope,
  type NativeInboxSnapshot,
} from './native-work-session-contract.js';
import { NativeAssistantSnapshotCache } from './native-work-session-snapshot.js';
import { publicNativeHistoryPage } from './native-work-session-history-view.js';

const MAX_FRAME_BYTES = 262_144;
const MAX_BUFFER_BYTES = 524_288;
const MAX_BUFFER_FRAMES = 128;
const MAX_READERS = 8;
const MAX_OBSERVERS = 16;
const STOP_MS = 5_000;
const READ_MS = 15_000;

/** Shadow only the pinned Web deployment's development guidance in this Agent scope. */
function configureNativeWorkPrompt(ctx: Context, textOnly: boolean): void {
  if (textOnly) {
    // The original service still owns its real directory for Skill lookup.
    // Request admission refreshes this scoped contribution after assembly.
    ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      text: '',
      interpolate: false,
      required: true,
    });
  }
  ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: '你在 Zhuma 中处理当前工作节点。遵循固定节点目标、所选专家指令、固定输入清单和实际授权工具，以及平台的安全与交付约束。',
    interpolate: false,
  });
  for (const [name, order] of [
    ['harness:source', 'HARNESS_SOURCE'],
    ['app:web-surface', 'WEB_SURFACE'],
  ] as const) {
    // Do not suppress all runtime context or replace the complete prompt:
    // workspace/security, selected Skill/MCP guidance and attribution remain.
    ctx.systemPrompt.section({
      name,
      order: ctx.systemPrompt.getSectionOrder(order),
      text: '',
      interpolate: false,
    });
    ctx.systemPrompt.context({
      name,
      order: ctx.systemPrompt.getContextOrder(order),
      text: '',
      interpolate: false,
    });
  }
}

/** Validate every visible SDK snapshot before proposing any model-only replacement. */
function textOnlyContextReplacements(agent: Agent): readonly {
  readonly seq: SessionSeq;
  readonly message: UserMessage;
  readonly sourceEventSeqs: SessionSeq[];
}[] {
  const changes: {
    seq: SessionSeq;
    message: UserMessage;
    sourceEventSeqs: SessionSeq[];
  }[] = [];
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const message = event.data;
    const sourceKind: unknown = Reflect.get(message.source, 'kind');
    if (sourceKind !== 'runtime-context') continue;
    const sections: unknown = Reflect.get(message.source, 'sections');
    if (Reflect.get(message.source, 'form') !== 'snapshot' || !Array.isArray(sections))
      throw new NativeWorkError('unavailable');
    const named: ContextSnapshotSection[] = [];
    const names = new Set<string>();
    for (const section of sections) {
      if (typeof section !== 'object' || section === null || Array.isArray(section))
        throw new NativeWorkError('unavailable');
      const name: unknown = Reflect.get(section, 'name');
      const text: unknown = Reflect.get(section, 'text');
      if (typeof name !== 'string' || !name || names.has(name) || typeof text !== 'string')
        throw new NativeWorkError('unavailable');
      names.add(name);
      named.push({ ...section, name, text });
    }
    const [body] = message.content;
    if (
      message.content.length !== 1 ||
      body?.type !== 'text' ||
      body.text !== joinContextSections(named)
    )
      throw new NativeWorkError('unavailable');
    if (!names.has('working-directory:current')) continue;
    const kept = named.filter((section) => section.name !== 'working-directory:current');
    const source = { ...message.source, sections: kept };
    changes.push({
      seq,
      message: createUserMessage({
        content: [{ ...body, text: joinContextSections(kept) }],
        source,
      }),
      sourceEventSeqs: [...new Set([...(event.sourceEventSeqs ?? []), seq])],
    });
  }
  return changes;
}

interface ResourceEpoch {
  readonly owner: DshNativeWorkRuntime;
  readonly controller: AbortController;
  basis?: NativeMigrationDrain['basis'];
  proof?: { readonly persistence: symbol; readonly registry: object };
  failed?: true;
}
// Process-local resource observations, never Run/workspace authority.
const resourceEpochs = new Map<string, ResourceEpoch>();
function registryIdentity(ctx: Context): object {
  // Cordis returns fresh trace proxies on service lookup; its public tracker
  // metadata belongs to the actual service instance and passes through proxies.
  const identity: unknown = Reflect.get(ctx.agents, Service.tracker);
  if (identity === null || typeof identity !== 'object') throw new NativeWorkError('unavailable');
  return identity;
}

interface LiveSession {
  readonly handle: AgentHandle;
  readonly presentation: NativeAssistantSnapshotCache;
  readonly grant: NativeWorkGrant;
  readonly binding: NativeSessionBinding;
  readonly directory: NativeDirectoryContext;
  readonly revoke: () => void;
}

/** A Host-owned live directory capability, not a request path or workspace catalog row. */
export type NativeDshWorkingDirectory =
  | { readonly kind: 'text-only' }
  | {
      readonly kind: 'local';
      readonly scope: NativeWorkScope;
      readonly cwd: string;
      /** Exact existing original WorkspaceRegistry id, provided by the live Host grant. */
      readonly workspaceId?: string;
      readonly signal: AbortSignal;
      assertCurrent(): undefined;
    };

interface NativeDirectoryContext {
  readonly signal: AbortSignal;
  readonly meta: { readonly cwd: string } | undefined;
  assert(agent?: Agent): void;
  prepare(agent: Agent): Promise<void>;
  attach?(agent: Agent): Promise<void>;
}

/** The public working-directory service's narrow read/validation surface. */
interface NativeDirectoryService {
  get(session: Agent['session']): string;
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>;
}

const scopeFields = [
  'actorId',
  'spaceId',
  'taskId',
  'planId',
  'revision',
  'nodeId',
  'runId',
  'generation',
  'segmentId',
] as const;
const scopeAddress = (scope: NativeWorkScope) =>
  JSON.stringify(scopeFields.map((key) => scope[key]));

export interface NativeDshComposition {
  /** Already-authorized task goal and bounded fixed-reference catalog, not source bodies. */
  readonly context: string;
  /** Actual scoped tool names. Empty means no tools; absence never enables defaults. */
  readonly toolAllowlist: readonly string[];
}

export interface NativeDshOptions {
  /** Host-owned per-page wait budget, 10–15,000ms. Does not stop native I/O. */
  readonly readTimeoutMs?: number;
  /** From the actual Run and a currently authorized Host root, before session creation. */
  workingDirectory(
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): NativeDshWorkingDirectory | Promise<NativeDshWorkingDirectory>;
  /** Host-owned scoped composition, before native publication; never drives the Agent. */
  compose(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): NativeDshComposition | Promise<NativeDshComposition>;
}

/** Cancel the caller's wait while consuming every late completion/rejection. */
function waitForRead<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  interrupted: () => NativeWorkError,
  abandoned?: (value: T) => Promise<unknown>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(interrupted());
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(interrupted());
    };
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw interrupted();
        return operation();
      })
      .then(
        (value) => {
          if (settled) {
            // A native open may ignore abort and still hand out an owned reader.
            if (abandoned)
              void Promise.resolve()
                .then(() => abandoned(value))
                .catch(() => undefined);
            return;
          }
          settled = true;
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    if (signal.aborted) abort();
  });
}

function current(grant: NativeWorkGrant): void {
  if (grant.signal.aborted) throw new NativeWorkError('cancelled');
  invokeNativeWorkGrantAssertion(grant, 'open');
}

function identified(message: NativeSessionMessage): UserMessage {
  return Object.freeze({
    id: MessageId(message.id),
    role: 'user',
    content: Object.freeze([{ type: 'text' as const, text: message.text }]),
    source: Object.freeze({ kind: 'user' as const }),
  });
}

function textOf(message: UserMessage): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** Public DSH registry adapter. No child process, replacement factory, or transcript cache. */
export class DshNativeWorkRuntime implements NativeWorkRuntime {
  private readonly admittedAgents = new WeakMap<Agent, NativeWorkGrant>();
  /** Original serial agent/created gate. Matching IDs or a default-factory
   * resume cannot borrow this runtime's unpublished setup/grant identity. */
  assertAgentOwner(agent: Agent): void {
    const grant = this.admittedAgents.get(agent);
    if (!grant || this.lifetime.signal.aborted) throw new NativeWorkError('scope-mismatch');
    this.current(grant);
    grant.assertCurrent('send');
  }
  private readonly live = new Map<string, LiveSession>();
  private readonly disconnecting = new Map<string, Promise<void>>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly barrierHandles = new Map<string, SessionHandle>();
  private readonly retired = new Set<string>();
  private readonly connecting = new Map<
    string,
    { readonly promise: Promise<void>; readonly abort: AbortController }
  >();
  private readonly lifetime = new AbortController();
  private readonly readers = new Set<Promise<unknown>>();
  private observers = 0;
  private readonly readTimeoutMs: number;

  private touch(sessionId: string): ResourceEpoch {
    resourceEpochs.get(sessionId)?.controller.abort();
    const next = { owner: this, controller: new AbortController() };
    if (this.lifetime.signal.aborted) next.controller.abort();
    resourceEpochs.set(sessionId, next);
    return next;
  }

  migrationDrain(sessionId: string): NativeMigrationDrain {
    if (this.lifetime.signal.aborted) throw new NativeWorkError('unavailable');
    assertNativeInputReadOwner(sessionId, this);
    const epoch = resourceEpochs.get(sessionId);
    if (epoch && (epoch.owner !== this || epoch.failed || epoch.controller.signal.aborted))
      throw new NativeWorkError('unavailable');
    if (!epoch || !epoch.basis || !epoch.proof) throw new NativeWorkError('migration-not-ready');
    const { persistence, registry } = epoch.proof;
    const signal = epoch.controller.signal;
    const assertCurrent = () => {
      try {
        assertNativeInputReadOwner(sessionId, this);
        if (
          signal.aborted ||
          this.lifetime.signal.aborted ||
          resourceEpochs.get(sessionId) !== epoch ||
          this.ctx.sessionPersistence.identity !== persistence ||
          registryIdentity(this.ctx) !== registry ||
          this.live.has(sessionId) ||
          this.connecting.has(sessionId) ||
          this.disconnecting.has(sessionId) ||
          this.retiring.has(sessionId) ||
          this.barrierHandles.has(sessionId) ||
          this.ctx.agents.get(SessionId(sessionId)) !== undefined
        )
          throw new NativeWorkError('unavailable');
      } catch {
        epoch.controller.abort();
        throw new NativeWorkError('unavailable');
      }
    };
    assertCurrent();
    return { signal, basis: epoch.basis, assertCurrent };
  }

  constructor(
    private readonly ctx: Context,
    private readonly options: NativeDshOptions,
    private readonly purpose?: NativeSessionPurpose,
  ) {
    this.readTimeoutMs = options.readTimeoutMs ?? READ_MS;
    if (
      !Number.isSafeInteger(this.readTimeoutMs) ||
      this.readTimeoutMs < 10 ||
      this.readTimeoutMs > READ_MS
    )
      throw new NativeWorkError('invalid-request');
  }

  private current(grant: NativeWorkGrant): void {
    assertNativePurposeOwner(grant, this.purpose);
    current(grant);
  }
  private scopeAddress(scope: NativeWorkScope): string {
    const context = this.purpose?.context(scope);
    return context ? nativeReviewScopeKey(context) : scopeAddress(scope);
  }

  private async directory(
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    parentSignal: AbortSignal,
  ): Promise<NativeDirectoryContext> {
    this.current(grant);
    const address = this.scopeAddress(binding.scope);
    if (
      this.scopeAddress(grant.scope) !== address ||
      typeof this.options.workingDirectory !== 'function'
    )
      throw new NativeWorkError('unavailable');
    let selected: NativeDshWorkingDirectory;
    try {
      selected = await this.options.workingDirectory(structuredClone(binding), grant);
    } catch {
      throw new NativeWorkError('unavailable');
    }
    this.current(grant);
    if (parentSignal.aborted) throw new NativeWorkError('cancelled');
    if (selected?.kind === 'text-only') {
      const assert = () => {
        this.current(grant);
        if (parentSignal.aborted) throw new NativeWorkError('cancelled');
        if (selected.kind !== 'text-only' || this.scopeAddress(grant.scope) !== address)
          throw new NativeWorkError('configuration-mismatch');
      };
      assert();
      return { signal: parentSignal, meta: undefined, assert, prepare: async () => assert() };
    }
    if (
      selected?.kind !== 'local' ||
      typeof selected.cwd !== 'string' ||
      !isAbsolute(selected.cwd) ||
      !(selected.signal instanceof AbortSignal) ||
      typeof selected.assertCurrent !== 'function' ||
      !selected.scope
    )
      throw new NativeWorkError('unavailable');
    const { cwd, signal: sourceSignal, assertCurrent } = selected;
    const workspaceId = selected.workspaceId;
    const signal = AbortSignal.any([parentSignal, sourceSignal]);
    const directories = this.ctx.get('workingDirectory') as NativeDirectoryService | undefined;
    if (typeof directories?.get !== 'function' || typeof directories.ensure !== 'function')
      throw new NativeWorkError('unavailable');
    const directoryIdentity: unknown = Reflect.get(directories, Service.tracker);
    if (!directoryIdentity || typeof directoryIdentity !== 'object')
      throw new NativeWorkError('unavailable');
    const assert = (agent?: Agent) => {
      this.current(grant);
      if (signal.aborted) throw new NativeWorkError('cancelled');
      if (
        selected.kind !== 'local' ||
        selected.cwd !== cwd ||
        selected.signal !== sourceSignal ||
        selected.assertCurrent !== assertCurrent ||
        selected.workspaceId !== workspaceId ||
        this.scopeAddress(selected.scope) !== address ||
        this.scopeAddress(grant.scope) !== address
      )
        throw new NativeWorkError('configuration-mismatch');
      try {
        const latest = this.ctx.get('workingDirectory');
        if (!latest || Reflect.get(latest, Service.tracker) !== directoryIdentity)
          throw new NativeWorkError('unavailable');
        const result: unknown = selected.assertCurrent();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined);
          throw new NativeWorkError('unavailable');
        }
        if (agent && (agent.session.header.cwd !== cwd || directories.get(agent.session) !== cwd))
          throw new NativeWorkError('configuration-mismatch');
      } catch (error) {
        if (error instanceof NativeWorkError) throw error;
        throw new NativeWorkError('unavailable');
      }
    };
    assert();
    const workspace =
      workspaceId === undefined
        ? undefined
        : nativeWorkspaceAttachment(this.ctx, workspaceId, cwd, () => assert());
    return {
      signal,
      meta: { cwd },
      assert: (agent) => {
        assert(agent);
        workspace?.check();
      },
      ...(workspace
        ? {
            attach: async (agent: Agent) => {
              assert(agent);
              await workspace.attach(agent.session.id);
              assert(agent);
            },
          }
        : {}),
      prepare: async (agent) => {
        assert(agent);
        workspace?.check();
        let effective: string;
        try {
          effective = await directories.ensure(agent, signal);
        } catch {
          throw new NativeWorkError(signal.aborted ? 'cancelled' : 'unavailable');
        }
        assert(agent);
        workspace?.check();
        if (effective !== cwd) throw new NativeWorkError('configuration-mismatch');
      },
    };
  }

  async connect(
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    allowCreate: boolean,
  ): Promise<void> {
    this.current(grant);
    // Even a parked resume constructs an executable Agent scope/writer. A
    // separate historical read grant must never authorize that factory call.
    grant.assertCurrent('send');
    assertNativeInputReadOwner(binding.nativeSessionId, this);
    if (
      this.retired.has(binding.nativeSessionId) ||
      this.disconnecting.has(binding.nativeSessionId)
    )
      throw new NativeWorkError('unavailable');
    if (this.lifetime.signal.aborted) throw new NativeWorkError('unavailable');
    const live = this.live.get(binding.nativeSessionId);
    if (live) {
      this.agent(binding.nativeSessionId);
      return;
    }
    const prior = this.connecting.get(binding.nativeSessionId);
    if (prior) {
      await prior.promise;
      this.current(grant);
      this.agent(binding.nativeSessionId);
      return;
    }
    const owner = resourceEpochs.get(binding.nativeSessionId);
    if (owner && owner.owner !== this && !owner.basis) throw new NativeWorkError('unavailable');
    this.touch(binding.nativeSessionId);
    const abort = new AbortController();
    const signal = AbortSignal.any([grant.signal, abort.signal, this.lifetime.signal]);
    const promise = this.attach(binding, grant, signal, allowCreate);
    this.connecting.set(binding.nativeSessionId, { promise, abort });
    try {
      await promise;
    } finally {
      if (this.connecting.get(binding.nativeSessionId)?.promise === promise)
        this.connecting.delete(binding.nativeSessionId);
    }
  }

  private async attach(
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    parentSignal: AbortSignal,
    allowCreate: boolean,
  ): Promise<void> {
    // Read-only history never reaches this factory gate. Creation/resume must
    // inspect the real active factory; an ignored option on the old SDK is unsafe.
    const registry = requireNativeInboxRetention(this.ctx.agents);
    const id = SessionId(binding.nativeSessionId);
    // Never adopt another consumer's same-id handle or global owner session.
    if (this.ctx.agents.get(id)) throw new NativeWorkError('unavailable');
    const directory = await this.directory(binding, grant, parentSignal);
    const signal = directory.signal;
    const stored = await this.ctx.sessionPersistence.stat(id, { signal });
    signal.throwIfAborted();
    this.current(grant);
    directory.assert();
    assertNativeInputReadOwner(binding.nativeSessionId, this);
    if (!stored && !allowCreate) throw new NativeWorkError('delivery-unknown');
    const presentation = new NativeAssistantSnapshotCache(binding.nativeSessionId);
    const setup: AgentSetup = async (agentCtx, unpublishedAgent) => {
      this.current(grant);
      this.admittedAgents.set(unpublishedAgent, grant);
      agentCtx.effect(() => () => {
        this.admittedAgents.delete(unpublishedAgent);
      });
      // Capture before the first request, in this exact Agent's owned scope.
      agentCtx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent === unpublishedAgent) presentation.push(frame, Number(agent.session.seq) - 1);
      });
      const forget = () => presentation.close();
      signal.addEventListener('abort', forget, { once: true });
      agentCtx.effect(() => () => {
        signal.removeEventListener('abort', forget);
        presentation.close();
      });
      await directory.prepare(unpublishedAgent);
      if (stored) await directory.attach?.(unpublishedAgent);
      assertNativeInputReadOwner(binding.nativeSessionId, this);
      // Native end tools only: PTC's reserved run_code cannot be masked by restrict().
      agentCtx.tools.presentAs('native');
      configureNativeWorkPrompt(agentCtx, directory.meta === undefined);
      const composition = await this.options.compose(agentCtx, structuredClone(binding), grant);
      signal.throwIfAborted();
      this.current(grant);
      directory.assert(unpublishedAgent);
      if (
        typeof composition.context !== 'string' ||
        composition.context.length > 20_000 ||
        composition.toolAllowlist.length > 100
      )
        throw new NativeWorkError('invalid-request');
      const allowed = new Set(composition.toolAllowlist);
      const review = this.purpose?.context(grant.scope);
      if (
        review
          ? allowed.has('complete_work')
          : allowed.has(NATIVE_REVIEW_TOOL) || allowed.has(NATIVE_REVIEW_READ_TOOL)
      )
        throw new NativeWorkError('invalid-request');
      // DSH restrict() masks inherited/global capabilities, not registrations
      // owned by this Agent scope; passing a scope-local name is an error.
      agentCtx.tools.restrict({
        allow: composition.toolAllowlist.filter((name) => this.ctx.tools.get(name) !== undefined),
      });
      agentCtx.tools.guard((exec) => {
        try {
          this.current(grant);
          directory.assert(unpublishedAgent);
          grant.assertCurrent('send');
          return allowed.has(exec.name) ? undefined : 'native-tool-not-authorized';
        } catch {
          return 'native-work-not-authorized';
        }
      });
      const checkToolSurface = () => {
        const names = this.ctx.tools.schemas(unpublishedAgent).map((tool) => tool.name);
        if (names.length !== allowed.size || names.some((name) => !allowed.has(name)))
          throw new NativeWorkError('invalid-request');
      };
      agentCtx.systemPrompt.context({
        name: 'zhuma-work',
        order: 10,
        text: composition.context,
        interpolate: false,
        required: true,
      });
      agentCtx.on('agent/pre-step', async (_payload, next) => {
        this.current(grant);
        await directory.prepare(unpublishedAgent);
        grant.assertCurrent('send');
        checkToolSurface();
        const result = await next();
        this.current(grant);
        directory.assert(unpublishedAgent);
        checkToolSurface();
        return result;
      });
      agentCtx.on('tools/pre-execute', async (_exec, next) => {
        this.current(grant);
        await directory.prepare(unpublishedAgent);
        grant.assertCurrent('send');
        return next();
      });
      agentCtx.on('agent/request', async (_payload, next) => {
        this.current(grant);
        directory.assert(unpublishedAgent);
        grant.assertCurrent('send');
        const config = await next();
        this.current(grant);
        directory.assert(unpublishedAgent);
        if (
          config.provider !== binding.selection.provider ||
          config.model !== binding.selection.model
        )
          throw new NativeWorkError('configuration-mismatch');
        return config;
      });
      return {
        commit: () => {
          this.current(grant);
          directory.assert(unpublishedAgent);
          checkToolSurface();
          if (directory.meta === undefined) {
            // Preparation is explicit create/resume, never a history/view read.
            // Original append-origin events remain the human transcript.
            const changes = textOnlyContextReplacements(unpublishedAgent);
            for (const change of changes) {
              this.current(grant);
              directory.assert(unpublishedAgent);
              grant.assertCurrent('send');
              unpublishedAgent.session.append('user/message', change.message, {
                surfaceOp: { op: 'replace', startSeq: change.seq, endSeq: change.seq },
                sourceEventSeqs: change.sourceEventSeqs,
              });
            }
            this.current(grant);
            directory.assert(unpublishedAgent);
          }
        },
      };
    };
    const { configurationId: _configurationId, reasoningEffort, ...selection } = binding.selection;
    const agentOptions = {
      ...selection,
      ...(reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    };
    const create: RetainedInboxCreateOptions = {
      sessionId: id,
      ...(directory.meta ? { meta: directory.meta } : {}),
      agentOptions,
      setup,
      signal,
      retainPendingInboxOnDispose: true,
    };
    const resume: RetainedInboxResumeOptions = {
      resumeSessionId: id,
      agentOptions,
      setup,
      signal,
      retainPendingInboxOnDispose: true,
    };
    const handle = stored ? await registry.resume(resume) : await registry.create(create);
    if (signal.aborted) {
      await handle.dispose();
      throw new NativeWorkError('cancelled');
    }
    try {
      this.current(grant);
      directory.assert(handle.agent);
      await directory.attach?.(handle.agent);
      this.current(grant);
      directory.assert(handle.agent);
    } catch (error) {
      await handle.dispose();
      throw error;
    }
    if (
      handle.agent.id !== id ||
      handle.agent.options.provider !== binding.selection.provider ||
      handle.agent.options.model !== binding.selection.model
    ) {
      await handle.dispose();
      throw new NativeWorkError('configuration-mismatch');
    }
    const revoke = () => {
      presentation.close();
      // Revocation cannot wake parked input or grant authority to a late frame.
      handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true });
      void handle.agent
        .whenIdle()
        .then(() => this.disconnect(binding.nativeSessionId))
        .catch(() => undefined);
    };
    this.live.set(binding.nativeSessionId, {
      handle,
      presentation,
      binding: structuredClone(binding),
      directory,
      grant,
      revoke,
    });
    directory.signal.addEventListener('abort', revoke, { once: true });
    if (directory.signal.aborted) revoke();
  }

  private agent(sessionId: string): Agent {
    if (this.retired.has(sessionId)) throw new NativeWorkError('unavailable');
    const live = this.live.get(sessionId);
    if (!live) throw new NativeWorkError('not-started');
    current(live.grant);
    live.directory.assert(live.handle.agent);
    if (this.ctx.agents.get(SessionId(sessionId)) !== live.handle.agent)
      throw new NativeWorkError('unavailable');
    return live.handle.agent;
  }

  isConnected(sessionId: string): boolean {
    return this.live.has(sessionId);
  }
  status(sessionId: string) {
    return this.agent(sessionId).status;
  }
  pending(sessionId: string) {
    const inbox = this.agent(sessionId).inbox;
    return [
      ...inbox.nextTurn.map((message) => ({
        id: message.id,
        text: textOf(message),
        target: 'next-turn' as const,
      })),
      ...inbox.nextStep.map((message) => ({
        id: message.id,
        text: textOf(message),
        target: 'next-step' as const,
      })),
    ];
  }

  send(sessionId: string, message: NativeSessionMessage, mode: NativeMessageMode): void {
    const agent = this.agent(sessionId);
    this.touch(sessionId);
    const input = identified(message);
    if (mode === 'queue') agent.send(input, 'next-turn', false);
    else if (mode === 'steer') {
      if (agent.status !== 'running') throw new NativeWorkError('not-pending');
      agent.steer(input);
    } else agent.followup(input);
  }

  edit(sessionId: string, messageId: string, text: string): boolean {
    const agent = this.agent(sessionId);
    this.touch(sessionId);
    const old = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(
      (message) => message.id === messageId,
    );
    return old === undefined
      ? false
      : agent.inbox.replace(old.id, identified({ id: old.id, text }));
  }
  remove(sessionId: string, messageId: string): boolean {
    const agent = this.agent(sessionId);
    this.touch(sessionId);
    return agent.inbox.remove(MessageId(messageId));
  }
  reorder(sessionId: string, messageIds: readonly string[]): void {
    const agent = this.agent(sessionId);
    this.touch(sessionId);
    const pending = agent.inbox.nextTurn;
    if (
      messageIds.length !== pending.length ||
      new Set(messageIds).size !== pending.length ||
      messageIds.some((id) => !pending.some((message) => message.id === id))
    )
      throw new NativeWorkError('not-pending');
    const byId = new Map(pending.map((message) => [message.id as string, message]));
    // One native durable splice, not remove/reinsert commands that claim cancellation.
    agent.inbox.splice(
      'next-turn',
      0,
      pending.length,
      messageIds.map((id) => byId.get(id)!),
    );
  }
  async stop(sessionId: string, signal: AbortSignal): Promise<'stopped' | 'pending'> {
    if (!this.retired.has(sessionId)) this.touch(sessionId);
    const joinRetirement = async () => {
      if (!this.retired.has(sessionId)) return false;
      const work = this.retiring.get(sessionId);
      if (work) await work;
      // The same original physical barrier, never a closed-handle error or
      // absence of a live Agent, certifies a concurrent cleanup finished.
      this.migrationDrain(sessionId).assertCurrent();
      signal.throwIfAborted();
      return true;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), STOP_MS);
    });
    try {
      const settled = (async () => {
        if (await joinRetirement()) return 'stopped' as const;
        const connecting = this.connecting.get(sessionId);
        if (connecting) {
          connecting.abort.abort();
          await connecting.promise.catch(() => undefined);
        }
        const live = this.live.get(sessionId);
        if (!live) return connecting ? ('stopped' as const) : ('pending' as const);
        live.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
        await live.handle.agent.whenIdle();
        if (!(await joinRetirement())) {
          try {
            await this.flush(sessionId);
          } catch (error) {
            // Cleanup can start between the check and flush. Do not swallow
            // failed retirement: joining/rechecking its real proof must pass.
            if (!(await joinRetirement())) throw error;
          }
        }
        signal.throwIfAborted();
        return 'stopped' as const;
      })();
      return await Promise.race([settled, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async flush(sessionId: string): Promise<void> {
    const agent = this.live.get(sessionId)?.handle.agent;
    if (agent) this.touch(sessionId);
    if (agent && !(await this.ctx.sessions.flush(agent.session)))
      throw new NativeWorkError('unavailable');
  }

  async history(
    sessionId: string,
    after: number,
    limit: number,
    signal: AbortSignal,
    allowAbsent = false,
  ): Promise<readonly NativeHistoryEvent[]> {
    return this.readSession<readonly NativeHistoryEvent[]>(
      sessionId,
      signal,
      allowAbsent,
      () => [],
      async (handle, bounded) => {
        const result = await handle.read(after + 1, limit, { signal: bounded });
        const events = result.events.map(publicNativeResultEvent);
        if (Buffer.byteLength(JSON.stringify(events)) > MAX_FRAME_BYTES)
          throw new NativeWorkError('capacity');
        return events;
      },
    );
  }

  /** Same original SDK read, authority and physical close. Only the public
   * presentation is budgeted here; raw history/result reads keep their limits. */
  conversationHistory(
    sessionId: string,
    after: number,
    limit: number,
    signal: AbortSignal,
    allowAbsent = false,
  ): Promise<readonly NativeHistoryEvent[]> {
    return this.readSession(
      sessionId,
      signal,
      allowAbsent,
      () => [],
      async (handle, bounded) => {
        const result = await handle.read(after + 1, limit, { signal: bounded });
        return publicNativeHistoryPage(result.events);
      },
    );
  }

  /** Own actual native I/O and handle close after a caller's bounded wait has ended. */
  private readSession<T>(
    sessionId: string,
    signal: AbortSignal,
    allowAbsent: boolean,
    absent: () => T,
    read: (handle: SessionHandle, bounded: AbortSignal, verify: () => void) => Promise<T>,
    assertCurrent: () => void = () => {},
  ): Promise<T> {
    if (this.readers.size >= MAX_READERS) return Promise.reject(new NativeWorkError('capacity'));
    const bounded = AbortSignal.any([
      signal,
      this.lifetime.signal,
      AbortSignal.timeout(this.readTimeoutMs),
    ]);
    const interrupted = () =>
      new NativeWorkError(
        signal.aborted || this.lifetime.signal.aborted ? 'cancelled' : 'read-timeout',
      );
    const source = this.ctx.sessionPersistence;
    const identity = source.identity;
    const guard = () => {
      if (bounded.aborted) throw interrupted();
      assertCurrent();
      if (this.ctx.sessionPersistence.identity !== identity)
        throw new NativeWorkError('unavailable');
    };
    const physical = (async () => {
      guard();
      await this.flush(sessionId);
      guard();
      let handle: SessionHandle;
      try {
        handle = await source.open(SessionId(sessionId), 'read', { signal: bounded });
      } catch (error) {
        guard();
        if (allowAbsent && error instanceof SessionPersistenceNotFoundError) return absent();
        throw error;
      }
      try {
        guard();
        if (handle.id !== sessionId) throw new NativeWorkError('unavailable');
        const value = await read(handle, bounded, guard);
        guard();
        return value;
      } finally {
        await this.closeReadHandle(handle);
      }
    })();
    this.readers.add(physical);
    void physical.then(
      () => this.readers.delete(physical),
      () => this.readers.delete(physical),
    );
    return waitForRead(() => physical, bounded, interrupted);
  }

  readInbox(
    sessionId: string,
    signal: AbortSignal,
    allowAbsent: boolean,
    assertCurrent: () => void,
  ): Promise<NativeInboxSnapshot> {
    return this.readSession<NativeInboxSnapshot>(
      sessionId,
      signal,
      allowAbsent,
      () => ({ asOfSeq: -1, claimedMessageIds: [], items: [] }),
      async (handle, bounded, verify) => {
        const projections = this.ctx.sessionProjections;
        const projectionIdentity: unknown = Reflect.get(projections, Service.tracker);
        const check = () => {
          verify();
          assertNativeInputReadOwner(sessionId, this);
          if (
            !projectionIdentity ||
            Reflect.get(this.ctx.sessionProjections, Service.tracker) !== projectionIdentity
          )
            throw new NativeWorkError('unavailable');
        };
        let checkpoint: ProjectionCheckpoint = {};
        let offset = 0;
        let bytes = 0;
        const claimed = new Set<string>();
        for (let page = 0; page < 100; page++) {
          check();
          const result = await handle.read(offset, 100, { signal: bounded });
          check();
          bytes += Buffer.byteLength(JSON.stringify(result.events));
          if (bytes > 8 * 1024 * 1024) throw new NativeWorkError('capacity');
          for (const event of result.events)
            if (event.type === 'user/message' && event.data.source.kind === 'user')
              claimed.add(event.data.id);
          const restored = projections.restore(
            checkpoint,
            result.events,
            SessionLogOffset(offset),
            handle.header,
            handle.inheritedEventCount,
          );
          checkpoint = restored.checkpoint;
          if (result.events.length === 100) {
            offset += result.events.length;
            continue;
          }
          const inbox = restored.snapshot.values.inbox;
          if (!inbox) throw new NativeWorkError('unavailable');
          const items: NativeInboxSnapshot['items'][number][] = [];
          for (const target of ['next-turn', 'next-step'] as const)
            for (const value of inbox[target]) {
              if (value === null || typeof value !== 'object' || Array.isArray(value))
                throw new NativeWorkError('unavailable');
              // Product sends are textual user input. Internal/runtime inbox work
              // stays in the native log and never enters the public projection.
              if (
                value.role !== 'user' ||
                value.source === null ||
                typeof value.source !== 'object' ||
                Array.isArray(value.source) ||
                value.source.kind !== 'user'
              )
                continue;
              if (typeof value.id !== 'string' || !Array.isArray(value.content))
                throw new NativeWorkError('unavailable');
              const text = value.content
                .flatMap((block) =>
                  block !== null &&
                  typeof block === 'object' &&
                  !Array.isArray(block) &&
                  block.type === 'text' &&
                  typeof block.text === 'string'
                    ? [block.text]
                    : [],
                )
                .join('\n');
              items.push({ id: value.id, text, target });
            }
          if (Buffer.byteLength(JSON.stringify(items)) > MAX_FRAME_BYTES)
            throw new NativeWorkError('capacity');
          return { asOfSeq: restored.snapshot.asOfSeq, claimedMessageIds: [...claimed], items };
        }
        throw new NativeWorkError('capacity');
      },
      assertCurrent,
    );
  }

  /** Host-only complete cut: includes internal inbox occupancy, never a public chat frame. */
  readResultSnapshot(
    binding: NativeSessionBinding,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<NativeResultSnapshot> {
    const sessionId = binding.nativeSessionId;
    return this.readSession(
      sessionId,
      signal,
      false,
      () => {
        throw new NativeWorkError('unavailable');
      },
      async (handle, bounded, verifyRead) => {
        const source = this.live.get(sessionId)?.handle.agent;
        const sequence = source?.session.seq;
        const persistence = this.ctx.sessionPersistence.identity;
        const projection: unknown = Reflect.get(this.ctx.sessionProjections, Service.tracker);
        const check = () => {
          signal.throwIfAborted();
          assertCurrent();
          assertNativeInputReadOwner(sessionId, this);
          if (
            this.lifetime.signal.aborted ||
            !projection ||
            this.ctx.sessionPersistence.identity !== persistence ||
            Reflect.get(this.ctx.sessionProjections, Service.tracker) !== projection ||
            this.live.get(sessionId)?.handle.agent !== source ||
            this.ctx.agents.get(SessionId(sessionId)) !== source ||
            (source && source.session.seq !== sequence)
          )
            throw new NativeWorkError('unavailable');
        };
        let offset = 0;
        let bytes = 0;
        let checkpoint: ProjectionCheckpoint = {};
        const events: NativeHistoryEvent[] = [];
        for (let page = 0; page < 100; page++) {
          verifyRead();
          check();
          const result = await handle.read(offset, 100, { signal: bounded });
          verifyRead();
          check();
          bytes += Buffer.byteLength(JSON.stringify(result.events));
          if (bytes > NATIVE_RESULT_LIMITS.scanBytes) throw new NativeWorkError('capacity');
          events.push(...result.events);
          const restored = this.ctx.sessionProjections.restore(
            checkpoint,
            result.events,
            SessionLogOffset(offset),
            handle.header,
            handle.inheritedEventCount,
          );
          checkpoint = restored.checkpoint;
          if (result.events.length === 100) {
            offset += 100;
            continue;
          }
          const inbox = restored.snapshot.values.inbox;
          if (!inbox || !Array.isArray(inbox['next-step']) || !Array.isArray(inbox['next-turn']))
            throw new NativeWorkError('unavailable');
          if (sequence !== undefined && sequence !== restored.snapshot.asOfSeq + 1)
            throw new NativeWorkError('unavailable');
          check();
          return {
            asOfSeq: restored.snapshot.asOfSeq,
            ...(this.purpose?.context(binding.scope) ? { sourceBytes: bytes } : {}),
            inheritedEventCount: handle.inheritedEventCount,
            hasPending: inbox['next-step'].length > 0 || inbox['next-turn'].length > 0,
            pendingMessageIds: [...inbox['next-step'], ...inbox['next-turn']].flatMap((value) =>
              value &&
              typeof value === 'object' &&
              value.role === 'user' &&
              typeof value.id === 'string'
                ? [value.id]
                : [],
            ),
            events: structuredClone(events),
            check,
          };
        }
        throw new NativeWorkError('capacity');
      },
      assertCurrent,
    );
  }

  private closeReadHandle(handle: SessionHandle): Promise<void> {
    const closing = Promise.resolve().then(() => handle.close());
    void closing.catch(() => {
      // No provider diagnostics, source body, native path or abort reason is logged.
      this.ctx.logger.warn('Native work session reader cleanup failed.');
    });
    return closing;
  }

  async messageStatus(
    sessionId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<'received' | 'claimed' | 'discarded' | 'absent'> {
    const pending = this.pending(sessionId);
    if (pending.some((message) => message.id === messageId)) return 'received';
    let after = -1;
    const queues: Record<string, string[]> = { 'next-turn': [], 'next-step': [] };
    let status: 'received' | 'claimed' | 'discarded' | 'absent' = 'absent';
    // Bounded reconciliation. Exhaustion is unknown, never permission to resend.
    for (let page = 0; page < 100; page++) {
      const events = await this.history(sessionId, after, 100, signal);
      for (const event of events) {
        const data = event.data as {
          readonly id?: string;
          readonly inserted?: readonly { readonly id?: string }[];
          readonly outcome?: string;
          readonly target?: string;
          readonly start?: number;
          readonly removedCount?: number;
        };
        if (event.type === 'user/message' && data.id === messageId) return 'claimed';
        if (
          event.type === 'agent/inbox/spliced' &&
          data.target !== undefined &&
          data.start !== undefined
        ) {
          const queue = queues[data.target];
          if (queue === undefined) continue;
          const inserted = (data.inserted ?? []).flatMap((item) =>
            item.id === undefined ? [] : [item.id],
          );
          const removed = queue.splice(data.start, data.removedCount ?? 0, ...inserted);
          if (inserted.includes(messageId)) status = 'received';
          else if (removed.includes(messageId))
            status = data.outcome === 'canceled' ? 'discarded' : 'claimed';
        }
      }
      if (events.length < 100) return status;
      after = events.at(-1)!.seq;
    }
    throw new NativeWorkError('delivery-unknown');
  }

  async *follow(
    sessionId: string,
    after: number,
    callerSignal: AbortSignal,
    allowAbsent = false,
    assertCurrent: () => void = () => {},
    expectedScope?: NativeWorkScope,
  ): AsyncIterable<NativeWorkFrame> {
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    signal.throwIfAborted();
    if (this.observers >= MAX_OBSERVERS) throw new NativeWorkError('capacity');
    const queue: { readonly value: NativeWorkFrame; readonly bytes: number }[] = [];
    const projection = new NativePublicResultProjection();
    let bufferedBytes = 0;
    let overflow = false;
    let failure: unknown;
    const live = this.live.get(sessionId);
    const source = live?.handle.agent;
    const persistence = this.ctx.sessionPersistence.identity;
    const registry = registryIdentity(this.ctx);
    const stops: (() => void)[] = [];
    let cleaned = false;
    this.observers++;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.observers--;
      for (const stop of stops.reverse()) stop();
      stops.length = 0;
      queue.length = 0;
      bufferedBytes = 0;
    };
    const subscribe = (register: () => () => void) => {
      try {
        stops.push(register());
      } catch (error) {
        cleanup();
        throw error;
      }
    };
    const checkSource = () => {
      assertCurrent();
      if (
        this.ctx.sessionPersistence.identity !== persistence ||
        registryIdentity(this.ctx) !== registry ||
        this.live.get(sessionId)?.handle.agent !== source
      )
        throw new NativeWorkError('unavailable');
      // Observation uses its fresh read grant, not the old drive grant that
      // may have ended with the Run. Source identity must still be exact.
      if (source && this.ctx.agents.get(SessionId(sessionId)) !== source)
        throw new NativeWorkError('unavailable');
      if (
        live &&
        expectedScope &&
        this.scopeAddress(live.binding.scope) !== this.scopeAddress(expectedScope)
      )
        throw new NativeWorkError('scope-mismatch');
    };
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const push = (original: NativeWorkFrame) => {
      if (overflow || failure || signal.aborted) return;
      try {
        checkSource();
      } catch (error) {
        failure = error;
        cleanup();
        notify();
        return;
      }
      const value = projection.frame(original);
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (
        bytes > MAX_FRAME_BYTES ||
        queue.length >= MAX_BUFFER_FRAMES ||
        bufferedBytes + bytes > MAX_BUFFER_BYTES
      ) {
        overflow = true;
        queue.length = 0;
        bufferedBytes = 0;
        notify();
        return;
      }
      queue.push({ value, bytes });
      bufferedBytes += bytes;
      notify();
    };
    subscribe(() =>
      this.ctx.on(
        'session/event',
        (session, event) => {
          if (source && session === source.session) push({ type: 'event', event });
        },
        { global: true },
      ),
    );
    subscribe(() =>
      this.ctx.on(
        'agent/assistant-stream',
        ({ agent, frame }) => {
          if (agent === source) push({ type: 'assistant-stream', frame });
        },
        { global: true },
      ),
    );
    subscribe(() =>
      this.ctx.on(
        'agent/status',
        ({ agent, status }) => {
          if (agent === source) push({ type: 'status', status });
        },
        { global: true },
      ),
    );
    const onAbort = () => {
      cleanup();
      notify();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let cursor = after;
    try {
      // Subscribe first, then native durable history. The seq cursor drops overlap.
      for (;;) {
        const events = await this.history(sessionId, cursor, 100, signal, allowAbsent);
        checkSource();
        for (const event of events) {
          if (signal.aborted) return;
          cursor = event.seq;
          yield { type: 'event', event };
        }
        if (events.length < 100) break;
      }
      checkSource();
      if (overflow) {
        yield { type: 'gap', after: cursor };
        return;
      }
      let opening;
      try {
        opening = live?.presentation.snapshot() ?? { type: 'snapshot' as const, revision: 0 };
      } catch {
        yield { type: 'gap', after: cursor };
        return;
      }
      // Capture and watermark are synchronous. Queued native frames through
      // this revision are represented (or settled) by this opening baseline.
      const streamCut = opening.revision;
      yield { type: 'assistant-stream', frame: opening };
      while (!signal.aborted) {
        if (failure) throw failure;
        checkSource();
        if (overflow) {
          yield { type: 'gap', after: cursor };
          return;
        }
        const item = queue.shift();
        if (!item) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (signal.aborted) notify();
          });
          continue;
        }
        bufferedBytes -= item.bytes;
        if (item.value.type === 'event') {
          if (item.value.event.seq <= cursor) continue;
          cursor = item.value.event.seq;
        } else if (item.value.type === 'assistant-stream') {
          const frame = item.value.frame;
          if (
            frame !== null &&
            typeof frame === 'object' &&
            'revision' in frame &&
            typeof frame.revision === 'number' &&
            frame.revision <= streamCut
          )
            continue;
        }
        yield item.value;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      cleanup();
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    const prior = this.disconnecting.get(sessionId);
    if (prior) return prior;
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    live.presentation.close();
    this.touch(sessionId);
    live.directory.signal.removeEventListener('abort', live.revoke);
    const work = Promise.resolve().then(() => live.handle.dispose());
    this.disconnecting.set(sessionId, work);
    // A failed disposal is still owned/unknown, never evidence of a closed writer.
    void work.then(
      () => {
        if (this.disconnecting.get(sessionId) === work) this.disconnecting.delete(sessionId);
      },
      () => undefined,
    );
    return work;
  }

  async retire(
    sessionId: string,
    signal: AbortSignal,
    allowAbsent = false,
  ): Promise<NativeMigrationDrain> {
    if (signal.aborted || this.lifetime.signal.aborted) throw new NativeWorkError('cancelled');
    assertNativeInputReadOwner(sessionId, this);
    const owner = resourceEpochs.get(sessionId);
    if (owner && owner.owner !== this && !owner.basis) throw new NativeWorkError('unavailable');
    this.retired.add(sessionId);
    let work = this.retiring.get(sessionId);
    if (!work) {
      work = Promise.resolve().then(async () => {
        this.touch(sessionId);
        const persistence = this.ctx.sessionPersistence.identity;
        const registry = registryIdentity(this.ctx);
        const connecting = this.connecting.get(sessionId);
        if (connecting) {
          connecting.abort.abort();
          await connecting.promise.catch(() => undefined);
        }
        // Join the original handle's memoized teardown: it drains the scope
        // and writer even when its provider already detached the session.
        // SessionStore.flush cannot address that detached session. The exclusive
        // persistence barrier below still independently verifies durable closure.
        const live = this.live.get(sessionId);
        if (live) {
          live.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
          await live.handle.agent.whenIdle();
          await this.disconnect(sessionId);
        }
        const disposing = this.disconnecting.get(sessionId);
        if (disposing) await disposing;
        if (this.ctx.agents.get(SessionId(sessionId))) throw new NativeWorkError('unavailable');
        let basis: NativeMigrationDrain['basis'] = 'flushed-and-closed';
        let handle: SessionHandle | undefined;
        try {
          // Explicit cleanup only: history never write-opens, creates or resumes.
          handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'write');
          this.barrierHandles.set(sessionId, handle);
          await handle.flush();
        } catch (error) {
          if (!handle && allowAbsent && error instanceof SessionPersistenceNotFoundError)
            basis = 'absent-unadmitted';
          else throw error;
        } finally {
          if (handle) {
            await handle.close();
            if (this.barrierHandles.get(sessionId) === handle)
              this.barrierHandles.delete(sessionId);
          }
        }
        if (
          this.ctx.sessionPersistence.identity !== persistence ||
          registryIdentity(this.ctx) !== registry
        )
          throw new NativeWorkError('unavailable');
        const epoch = resourceEpochs.get(sessionId);
        if (!epoch || epoch.owner !== this) throw new NativeWorkError('unavailable');
        epoch.basis = basis;
        epoch.proof = { persistence, registry };
      });
      this.retiring.set(sessionId, work);
      const owned = work;
      const release = () => {
        if (this.retiring.get(sessionId) === owned) this.retiring.delete(sessionId);
      };
      void owned.then(release, () => {
        const epoch = resourceEpochs.get(sessionId);
        if (epoch?.owner === this) {
          epoch.failed = true;
          epoch.controller.abort();
        }
        // Do not forget an unconfirmed writer after flush/disposal failure.
        if (
          !this.barrierHandles.has(sessionId) &&
          !this.live.has(sessionId) &&
          !this.disconnecting.has(sessionId) &&
          !this.connecting.has(sessionId)
        )
          release();
      });
    }
    try {
      await waitForRead(
        () => work!,
        signal,
        () => new NativeWorkError('cancelled'),
      );
    } catch (error) {
      if (error instanceof NativeWorkError) throw error;
      throw new NativeWorkError('unavailable');
    }
    return this.migrationDrain(sessionId);
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    for (const epoch of resourceEpochs.values()) if (epoch.owner === this) epoch.controller.abort();
    await Promise.allSettled([...this.connecting.values()].map((value) => value.promise));
    const outcomes = await Promise.allSettled([
      ...this.retiring.values(),
      ...this.disconnecting.values(),
      ...[...this.barrierHandles.entries()].map(async ([id, handle]) => {
        await handle.close();
        if (this.barrierHandles.get(id) === handle) this.barrierHandles.delete(id);
      }),
      ...[...this.live.keys()].map((id) => this.disconnect(id)),
    ]);
    while (this.readers.size) await Promise.allSettled([...this.readers]);
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new NativeWorkError('unavailable');
    for (const [id, epoch] of resourceEpochs) if (epoch.owner === this) resourceEpochs.delete(id);
  }
}
