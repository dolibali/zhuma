import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill';
import {
  canonicalPayload,
  REMOTE_RUN_LIMITS,
  remoteResultDeclarationSchema,
  remoteResultDigestInput,
  type RemoteRunEvent,
  type RemoteRunView,
  type RemoteResultReceipt,
  type RemoteResultDeclaration,
  type RemoteResultDraft,
} from '@zhuma/agent-core';
import {
  MemberLocalExecutionProtocol,
  MemberLocalProtocolError,
  type MemberLocalAcceptedRun,
  type MemberLocalRunHandle,
  type MemberLocalReadHandle,
  type MemberLocalStopInput,
} from './member-local-execution-protocol.js';
import { openNativeWorkSessions } from './native-work-session-storage.js';
import {
  NativeWorkError,
  type NativeWorkAction,
  type NativeWorkGrant,
  type NativeWorkScope,
  type NativeSessionBinding,
  type NativeSessionSelection,
} from './native-work-session-contract.js';
import type { NativeDshOptions } from './native-work-session-dsh.js';
import {
  createNativeFixedResultIssuer,
  type NativeFixedResultIssuer,
} from './native-work-session-result.js';
import type { NativeFixedResultRef } from './native-work-session-result-contract.js';
import {
  executionRunCompositionRequest,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';
import {
  registerExecutionRunResources,
  EXECUTION_RESOURCE_SOURCE_VERSION,
  type ExecutionRunResourceAdoption,
  type ExecutionMcpConnectionLease,
  type FrozenMcpResource,
} from './execution-run-resources.js';
import { observeHostNativeRun } from './host-run-observation.js';
import { registerMemberLocalAcceptedInputs } from './member-local-execution-inputs.js';
import { MemberLocalExecutionHistory } from './member-local-execution-history.js';

export interface MemberLocalOwnerOptions {
  readonly protocol: MemberLocalExecutionProtocol;
  /** Normal local model owner; this does not copy provider credentials. */
  assertModel(selection: NativeSessionSelection, signal: AbortSignal): void | Promise<void>;
  /** Actual original local tool/workspace adapters, when those tools were selected. */
  readonly native?: NativeDshOptions;
  /** Original private MCP configuration owner, required for selected MCP entries. */
  openMcp?(resource: FrozenMcpResource, signal: AbortSignal): Promise<ExecutionMcpConnectionLease>;
}
type Phase =
  'dispatching' | 'working' | 'fixed' | 'submitted' | 'retiring' | 'retired' | 'recovery-required';
type Observation = ReturnType<typeof observeHostNativeRun>;
type NativeOwner = Awaited<ReturnType<typeof openNativeWorkSessions>>;
interface Owned {
  readonly run: MemberLocalReadHandle;
  readonly workRun?: MemberLocalRunHandle;
  readonly role: 'drive' | 'result-only' | 'cleanup-only';
  readonly scope: NativeWorkScope;
  readonly abort: AbortController;
  readonly grant: NativeWorkGrant;
  view: RemoteRunView;
  deadline: number;
  cleanupDeadline: number;
  phase: Phase;
  sequence: number;
  queue: Promise<unknown>;
  dispatch?: Promise<void>;
  collecting?: Promise<void>;
  retirement?: Promise<void>;
  observation?: Observation;
  resources?: ExecutionRunResourceAdoption;
  received: boolean;
  accepted: boolean;
  firstMessageId?: string;
  timer?: ReturnType<typeof setTimeout>;
  receipt?: RemoteResultReceipt;
  binding?: NativeSessionBinding;
}
export interface MemberLocalOwnerView {
  readonly phase: Phase;
  readonly remote: RemoteRunView;
  readonly native: ReturnType<NativeOwner['service']['open']> | undefined;
  readonly receipt?: RemoteResultReceipt;
}
const address = (scope: NativeWorkScope) => canonicalPayload(scope);
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

/** One thin owner over the ORIGINAL local SDK/factory, native table and result
 * issuer. No backend ExecutionService, second transcript or Agent loop lives here. */
export class MemberLocalExecutionOwner {
  private readonly states = new Map<string, Owned>();
  private readonly handles = new WeakMap<MemberLocalReadHandle, Owned>();
  private readonly grants = new WeakMap<NativeWorkGrant, Owned>();
  private readonly lifetime = new AbortController();
  private readonly jobs = new Set<Promise<unknown>>();
  private native!: NativeOwner;
  private results!: NativeFixedResultIssuer;
  private historyReader!: MemberLocalExecutionHistory;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private constructor(private readonly options: MemberLocalOwnerOptions) {}
  /** Read-only local SDK availability for the accept capability declaration.
   * Actual frozen resources are still adopted and checked in the unpublished
   * Agent scope, before its first model request. No catalog/body is loaded here. */
  static resourceSource(ctx: Context): typeof EXECUTION_RESOURCE_SOURCE_VERSION | undefined {
    try {
      const tools = ctx.get('tools');
      return tools &&
        ctx.get('workingDirectory') &&
        typeof SkillRegistry === 'function' &&
        typeof Reflect.get(tools, 'getRegistered') === 'function' &&
        typeof Reflect.get(ToolSkill, 'bindSkillRegistry') === 'function'
        ? EXECUTION_RESOURCE_SOURCE_VERSION
        : undefined;
    } catch {
      return undefined;
    }
  }
  static async open(ctx: Context, options: MemberLocalOwnerOptions) {
    const owner = new MemberLocalExecutionOwner(options);
    await owner.initialize(ctx);
    ctx.effect(() => () => owner.close());
    return owner;
  }
  private state(grant: NativeWorkGrant): Owned {
    const state = this.grants.get(grant);
    if (!state || this.states.get(address(state.scope)) !== state)
      throw new NativeWorkError('scope-mismatch');
    return state;
  }
  private owned(run: MemberLocalReadHandle): Owned | undefined {
    const state = this.handles.get(run);
    return state && this.states.get(address(state.scope)) === state ? state : undefined;
  }
  private workRun(state: Owned): MemberLocalRunHandle {
    if (!state.workRun || state.role === 'cleanup-only')
      throw new NativeWorkError('configuration-mismatch');
    return state.workRun;
  }
  private composition(state: Owned): FrozenExecutionRunComposition {
    return this.workRun(state).composition;
  }
  private active(state: Owned): boolean {
    return !(
      ['submitted', 'retired'].includes(state.phase) &&
      state.view.resources === 'settled' &&
      !state.collecting &&
      !state.retirement
    );
  }
  private trim(): void {
    const settled = [...this.states].filter(([, state]) => !this.active(state));
    for (const [key, state] of settled.slice(
      0,
      Math.max(0, settled.length - REMOTE_RUN_LIMITS.activeAuthorities),
    )) {
      if (state.timer) clearTimeout(state.timer);
      state.observation?.close();
      state.abort.abort();
      this.states.delete(key);
    }
  }
  private check(state: Owned, action: NativeWorkAction): void {
    if (
      this.lifetime.signal.aborted ||
      state.abort.signal.aborted ||
      performance.now() >= state.deadline ||
      state.view.stopRequested ||
      state.role === 'cleanup-only' ||
      (state.role === 'drive'
        ? state.view.authority !== 'drive'
        : state.view.authority !== 'commit-only' || !['open', 'history'].includes(action)) ||
      (state.phase !== 'working' &&
        state.phase !== 'dispatching' &&
        !['open', 'history', 'follow'].includes(action))
    )
      throw new NativeWorkError('cancelled');
  }
  private checkResult(grant: NativeWorkGrant): void {
    const state = this.state(grant);
    this.check(state, 'history');
    if (!['working', 'dispatching', 'fixed'].includes(state.phase))
      throw new NativeWorkError('cancelled');
  }
  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return job;
  }
  private enqueue<T>(state: Owned, task: () => Promise<T>): Promise<T> {
    const job = state.queue.then(task);
    state.queue = job.catch(() => undefined);
    return this.track(job);
  }
  private async initialize(ctx: Context): Promise<void> {
    this.native = await openNativeWorkSessions(
      ctx,
      {
        workingDirectory: async (binding, grant) => {
          const state = this.state(grant);
          this.check(state, 'send');
          if (!this.options.native) {
            if (this.composition(state).payload.tools.kind === 'local-tools')
              throw new NativeWorkError('configuration-mismatch');
            return { kind: 'text-only' };
          }
          const directory = await this.options.native.workingDirectory(binding, grant);
          this.check(state, 'send');
          return directory;
        },
        compose: async (agentCtx, binding, grant) => {
          const state = this.state(grant),
            snapshot = this.composition(state);
          this.check(state, 'send');
          const input = await registerMemberLocalAcceptedInputs(
            agentCtx,
            binding,
            grant,
            this.native.service,
            this.options.protocol,
            this.workRun(state),
          );
          this.check(state, 'send');
          await this.options.assertModel(binding.selection, grant.signal);
          this.check(state, 'send');
          const extra = this.options.native
            ? await this.options.native.compose(agentCtx, binding, grant)
            : { context: '', toolAllowlist: [] };
          this.check(state, 'send');
          const result = this.results.registerNativeResultTool(agentCtx, binding, grant);
          state.resources = await registerExecutionRunResources(
            agentCtx,
            snapshot,
            binding,
            grant,
            {
              sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
              signal: grant.signal,
              assertCurrent: (saved, actual, permission) => {
                this.check(state, 'send');
                if (
                  permission !== grant ||
                  canonicalPayload(saved) !== canonicalPayload(snapshot) ||
                  canonicalPayload(actual) !== canonicalPayload(binding)
                )
                  throw new NativeWorkError('configuration-mismatch');
                return undefined;
              },
              openMcp: async (resource, signal) => {
                this.check(state, 'send');
                if (!this.options.openMcp) throw new NativeWorkError('configuration-mismatch');
                // The original adopter records even a late lease before its
                // current() recheck, so revocation cannot strand that resource.
                return this.options.openMcp(resource, signal);
              },
            },
          );
          await state.resources.ready;
          this.check(state, 'send');
          if (
            canonicalPayload([
              ...extra.toolAllowlist,
              ...input.toolAllowlist,
              ...result.toolAllowlist,
              ...state.resources.toolAllowlist,
            ]) !== canonicalPayload(snapshot.payload.toolAllowlist)
          )
            throw new NativeWorkError('configuration-mismatch');
          state.observation = observeHostNativeRun(agentCtx, binding, grant);
          state.observation.onClaim(() => {
            if (state.received) void this.acceptClaim(state).catch(() => this.fence(state));
          });
          state.observation.onFault(() => {
            // Actual result preparation retires this same original Agent. Its
            // disposal is a wakeup, never a fabricated failed/completed event.
            this.wake(state);
          });
          state.resources.signal.addEventListener('abort', () => this.wake(state), { once: true });
          return {
            context: snapshot.payload.context,
            toolAllowlist: snapshot.payload.toolAllowlist,
          };
        },
      },
      undefined,
      this.options.protocol.backendId,
    );
    this.results = createNativeFixedResultIssuer(
      ctx,
      this.native.service,
      this.native.runtime,
      { assertGrant: (grant) => this.checkResult(grant) },
      {
        readRunComposition: (locator) => {
          const state = [...this.states.values()].find((candidate) =>
            (['taskId', 'planId', 'revision', 'nodeId', 'runId'] as const).every(
              (field) => candidate.scope[field] === locator[field],
            ),
          );
          if (!state) throw new NativeWorkError('scope-mismatch');
          this.checkResult(state.grant);
          return this.composition(state);
        },
      },
    );
    this.historyReader = new MemberLocalExecutionHistory(this.native, this.options.protocol);
    this.results.onReady((grant, ref) => {
      const state = this.grants.get(grant);
      if (state)
        void (
          state.role === 'result-only' ? this.continueFixed(state, ref) : this.collect(state, ref)
        ).catch(() => this.fence(state));
    });
    this.heartbeat = setInterval(() => {
      for (const state of this.states.values()) {
        if (['working', 'dispatching'].includes(state.phase))
          void this.refresh(state.run).catch(() => this.fence(state));
      }
    }, REMOTE_RUN_LIMITS.renewAfterMs);
    this.heartbeat.unref();
  }
  private update(state: Owned, view: RemoteRunView, before: number): void {
    if (
      canonicalPayload(view.scope) !== canonicalPayload(state.run.value.scope) ||
      view.deviceId !== this.options.protocol.deviceId ||
      view.permit.id !== state.run.value.permit.id ||
      view.permit.epoch !== state.run.value.permit.epoch ||
      view.cleanup.id !== state.run.value.cleanup.id ||
      view.cleanup.epoch !== state.run.value.cleanup.epoch ||
      view.nextSequence < state.sequence
    )
      throw new MemberLocalProtocolError('local-mismatch');
    state.view = structuredClone(view);
    state.sequence = view.nextSequence;
    const ttl = view.permit.expiresAt - view.serverTime,
      cleanupTtl = view.cleanup.expiresAt - view.serverTime;
    state.deadline = before + Math.min(ttl, REMOTE_RUN_LIMITS.driveTtlMs);
    state.cleanupDeadline = before + Math.min(cleanupTtl, REMOTE_RUN_LIMITS.cleanupTtlMs);
    if (state.timer) clearTimeout(state.timer);
    const granted =
      state.role === 'drive' ? view.authority === 'drive' : view.authority === 'commit-only';
    if (!granted || view.stopRequested || ttl <= 0) {
      if (state.phase !== 'fixed' && state.phase !== 'submitted') this.fence(state);
    } else {
      state.timer = setTimeout(
        () => this.fence(state),
        Math.max(1, state.deadline - performance.now()),
      );
      state.timer.unref();
    }
  }
  private wake(state: Owned): void {
    setImmediate(() => {
      if (!['working', 'dispatching'].includes(state.phase)) return;
      try {
        const binding = this.native.service.open(state.grant)?.binding;
        if (binding?.resultIntent) void this.collect(state).catch(() => this.fence(state));
        else this.fence(state);
      } catch {
        this.fence(state);
      }
    });
  }
  /** Requires this protocol's private accepted handle and a fresh backend status.
   * Opening old persisted native work never silently resumes or creates an Agent. */
  async start(run: MemberLocalAcceptedRun): Promise<MemberLocalOwnerView> {
    if (this.lifetime.signal.aborted) throw new NativeWorkError('unavailable');
    this.options.protocol.assertStartHandle(run);
    const before = performance.now(),
      view = await this.options.protocol.status(run),
      { backendId: _backendId, ...scope } = view.scope,
      existing = this.states.get(address(scope));
    if (existing) {
      if (
        !existing.workRun ||
        existing.role === 'cleanup-only' ||
        canonicalPayload(existing.workRun?.composition) !== canonicalPayload(run.composition) ||
        existing.run.value.permit.id !== run.value.permit.id ||
        existing.run.value.cleanup.id !== run.value.cleanup.id
      )
        throw new NativeWorkError('scope-mismatch');
      this.handles.set(run, existing);
      return this.read(run);
    }
    this.trim();
    const snapshot = run.composition;
    if (
      [...this.states.values()].filter((state) => this.active(state)).length >=
        REMOTE_RUN_LIMITS.activeAuthorities ||
      view.authority !== 'drive' ||
      view.resources !== 'held' ||
      view.runStatus !== 'requested' ||
      view.stopRequested ||
      snapshot.schemaVersion !== 2 ||
      snapshot.payload.resultIntentTool?.sourceVersion !== 'zhuma-native-result-intent@1' ||
      snapshot.payload.outputFilePublisherTool ||
      snapshot.payload.acceptedFileReader ||
      (snapshot.payload.tools.kind === 'local-tools' && !this.options.native) ||
      (snapshot.payload.resources?.mcp.length && !this.options.openMcp)
    )
      throw new NativeWorkError('configuration-mismatch');
    const state = this.retain(run, view, before, 'drive', run);
    try {
      this.check(state, 'open');
      if (this.native.service.open(state.grant)) throw new NativeWorkError('scope-mismatch');
      state.dispatch = this.track(this.dispatch(state));
      await state.dispatch;
    } catch (error) {
      this.fence(state);
      throw error;
    }
    return this.read(run);
  }
  private retain(
    run: MemberLocalReadHandle,
    view: RemoteRunView,
    before: number,
    role: Owned['role'],
    workRun?: MemberLocalRunHandle,
  ): Owned {
    const { backendId: _backendId, ...scope } = view.scope,
      abort = new AbortController(),
      grant: NativeWorkGrant = Object.freeze({
        scope: Object.freeze(structuredClone(scope)),
        signal: abort.signal,
        assertCurrent: (action: NativeWorkAction) => this.check(this.state(grant), action),
      }),
      state: Owned = {
        run,
        ...(workRun ? { workRun } : {}),
        role,
        scope: grant.scope,
        abort,
        grant,
        view,
        deadline: before,
        cleanupDeadline: before,
        phase:
          role === 'drive' ? 'dispatching' : role === 'result-only' ? 'fixed' : 'recovery-required',
        sequence: view.nextSequence,
        queue: Promise.resolve(),
        received: false,
        accepted: false,
      };
    const previous = this.states.get(address(scope));
    if (previous) {
      if (previous.timer) clearTimeout(previous.timer);
      previous.abort.abort();
      previous.observation?.close();
    }
    this.states.set(address(scope), state);
    this.handles.set(run, state);
    this.grants.set(grant, state);
    this.update(state, view, before);
    return state;
  }
  private async dispatch(state: Owned): Promise<void> {
    const { firstMessage, selection } = executionRunCompositionRequest(this.composition(state));
    await this.options.assertModel(selection, state.grant.signal);
    this.check(state, 'send');
    const receipt = await this.native.service.send(state.grant, {
        requestId: randomUUID(),
        text: firstMessage.text,
        mode: firstMessage.mode,
        selection,
      }),
      binding = this.native.service.open(state.grant)?.binding;
    if (!binding || !['received', 'claimed'].includes(receipt.status))
      throw new NativeWorkError('unavailable');
    state.binding = binding;
    state.firstMessageId = receipt.messageId;
    await this.emit(state, {
      kind: 'received',
      sequence: state.sequence,
      nativeSessionId: binding.nativeSessionId,
    });
    state.received = true;
    state.phase = 'working';
    await this.acceptClaim(state);
  }
  private acceptClaim(state: Owned): Promise<void> {
    return this.enqueue(state, async () => {
      if (state.accepted || !state.received || !state.firstMessageId) return;
      const claim = state.observation?.claimFor(state.firstMessageId);
      if (!claim) return;
      const before = performance.now(),
        view = await this.options.protocol.command(state.run, {
          operation: 'event',
          payload: {
            event: {
              kind: 'accepted',
              sequence: state.sequence,
              nativeSessionId: claim.nativeSessionId,
              executorRunId: claim.nativeAgentId,
            },
          },
        });
      this.update(state, view, before);
      state.accepted = true;
    });
  }
  private emit(state: Owned, event: RemoteRunEvent): Promise<void> {
    return this.enqueue(state, async () => {
      const before = performance.now(),
        view = await this.options.protocol.command(state.run, {
          operation: 'event',
          payload: { event: { ...event, sequence: state.sequence } },
        });
      this.update(state, view, before);
    });
  }
  private collect(state: Owned, ref?: NativeFixedResultRef): Promise<void> {
    if (state.collecting) return state.collecting;
    if (!['dispatching', 'working'].includes(state.phase)) return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      await state.dispatch;
      await state.queue;
      if (!state.accepted) return;
      const prepared = ref
        ? { status: 'ready' as const, ref }
        : await this.results.prepareFixedResult(state.grant, state.grant.signal);
      if (prepared.status !== 'ready') return;
      const lease = await this.results.readFixedResult(
        state.grant,
        prepared.ref,
        state.grant.signal,
      );
      try {
        await state.resources?.drain();
        lease.check();
        const draft = remoteResultDigestInput({ ...lease.content, files: [] }),
          result = remoteResultDeclarationSchema.parse({
            requestId: lease.source.intentId,
            digest: lease.digest,
            artifactDigest: hash(draft),
            source: lease.source,
          });
        state.phase = 'fixed';
        await this.emit(state, {
          kind: 'completed',
          sequence: state.sequence,
          idle: true,
          flushed: true,
          resourcesSettled: true,
          result,
        });
        await this.commit(state, result, draft);
      } finally {
        lease.release();
      }
    });
    state.collecting = this.track(
      work.finally(() => {
        delete state.collecting;
        this.trim();
      }),
    );
    return state.collecting;
  }
  private async commit(
    state: Owned,
    result: RemoteResultDeclaration,
    draft: RemoteResultDraft,
  ): Promise<void> {
    const submitted = await this.enqueue(state, () =>
      this.options.protocol.command(state.run, {
        operation: 'submit-result',
        requestId: result.requestId,
        payload: { expectedNodeVersion: state.view.nodeVersion, result, draft },
      }),
    );
    if (
      submitted.receipt.requestId !== result.requestId ||
      submitted.receipt.digest !== result.digest ||
      submitted.receipt.artifactDigest !== result.artifactDigest
    )
      throw new MemberLocalProtocolError('local-mismatch');
    state.receipt = Object.freeze(structuredClone(submitted.receipt));
    state.phase = 'submitted';
    if (state.timer) clearTimeout(state.timer);
  }
  /** Explicit same-result continuation. It cannot call send, factory create/
   * resume, register tools or issue a new completion declaration. */
  async continueResult(run: MemberLocalRunHandle): Promise<MemberLocalOwnerView> {
    if (this.lifetime.signal.aborted) throw new NativeWorkError('unavailable');
    const before = performance.now(),
      view = await this.options.protocol.status(run),
      { backendId: _backendId, ...scope } = view.scope,
      prior = this.states.get(address(scope));
    if (
      view.authority !== 'commit-only' ||
      view.runStatus !== 'completed' ||
      view.resources !== 'settled' ||
      view.stopRequested ||
      !view.result ||
      view.result.source.toolVersion !== 'zhuma-native-result-intent@1'
    )
      throw new MemberLocalProtocolError('remote-recovery-required');
    if (prior?.collecting || (prior && !prior.abort.signal.aborted && prior.phase !== 'fixed'))
      throw new NativeWorkError('unavailable');
    if (prior?.retirement) await prior.retirement;
    const state = this.retain(run, view, before, 'result-only', run);
    try {
      await this.continueFixed(state);
    } catch (error) {
      this.fence(state);
      throw error;
    }
    return this.read(run);
  }
  private continueFixed(state: Owned, ref?: NativeFixedResultRef): Promise<void> {
    if (state.collecting) return state.collecting;
    if (state.role !== 'result-only' || state.phase !== 'fixed') return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      this.checkResult(state.grant);
      const declared = state.view.result;
      if (!declared) throw new NativeWorkError('scope-mismatch');
      const prepared = ref
        ? { status: 'ready' as const, ref }
        : await this.results.prepareFixedResult(state.grant, state.grant.signal);
      if (prepared.status !== 'ready') return;
      const lease = await this.results.readFixedResult(
        state.grant,
        prepared.ref,
        state.grant.signal,
      );
      try {
        lease.check();
        const draft = remoteResultDigestInput({ ...lease.content, files: [] });
        if (
          canonicalPayload(lease.source) !== canonicalPayload(declared.source) ||
          lease.digest !== declared.digest ||
          hash(draft) !== declared.artifactDigest
        )
          throw new MemberLocalProtocolError('local-mismatch');
        await this.commit(state, declared, draft);
      } finally {
        lease.release();
      }
    });
    state.collecting = this.track(
      work.finally(() => {
        delete state.collecting;
        this.trim();
      }),
    );
    return state.collecting;
  }
  private fence(state: Owned): void {
    if (state.phase === 'submitted' || state.phase === 'retired' || state.retirement) return;
    state.phase = 'recovery-required';
    state.abort.abort();
    if (state.timer) clearTimeout(state.timer);
    // Leave the SDK callback stack before joining native disposal/persistence.
    const work = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      this.retire(state),
    );
    state.retirement = this.track(
      work.finally(() => {
        delete state.retirement;
        this.trim();
      }),
    );
    void work.catch(() => undefined);
  }
  private async retire(state: Owned): Promise<void> {
    state.phase = 'retiring';
    try {
      const retired = await this.native.service.retireForCleanup(
        {
          scope: state.scope,
          assertCurrent: () => {
            if (performance.now() >= state.cleanupDeadline) throw new NativeWorkError('cancelled');
            return undefined;
          },
        },
        AbortSignal.timeout(Math.max(1, Math.ceil(state.cleanupDeadline - performance.now()))),
      );
      if (retired.status !== 'retired') return;
      await state.resources?.drain();
      retired.drain.assertCurrent();
      const evidence =
        retired.drain.basis === 'absent-unadmitted'
          ? { basis: 'absent-unadmitted' as const }
          : retired.binding
            ? {
                basis: 'flushed-and-closed' as const,
                nativeSessionId: retired.binding.nativeSessionId,
                nativeAgentId: retired.binding.nativeAgentId,
              }
            : undefined;
      if (!evidence) throw new NativeWorkError('unavailable');
      const before = performance.now(),
        view = await this.enqueue(state, () =>
          this.options.protocol.command(state.run, {
            operation: 'cleanup',
            payload: { observation: { kind: 'drained', sequence: state.sequence, evidence } },
          }),
        );
      this.update(state, view, before);
      state.phase = view.resources === 'settled' ? 'retired' : 'recovery-required';
    } finally {
      if (state.phase === 'retiring') state.phase = 'recovery-required';
    }
  }
  read(run: MemberLocalReadHandle): MemberLocalOwnerView {
    const state = this.owned(run);
    if (!state) throw new NativeWorkError('scope-mismatch');
    let native: MemberLocalOwnerView['native'];
    if (
      !state.abort.signal.aborted &&
      performance.now() < state.deadline &&
      !['fixed', 'submitted'].includes(state.phase)
    ) {
      native = this.native.service.open(state.grant);
      if (native) state.binding = native.binding;
    } else if (state.binding)
      native = { binding: structuredClone(state.binding), status: 'detached' };
    return {
      phase: state.phase,
      remote: structuredClone(state.view),
      native,
      ...(state.receipt ? { receipt: state.receipt } : {}),
    };
  }
  /** Host routing only. A still checks current member/space/Run before read/send. */
  lookupNativeSession(nativeSessionId: string) {
    return this.native.lookupNativeSession(nativeSessionId);
  }
  /** Fresh authorized navigation. Unlike read(), this is the UI's initial read.
   * It never activates a drive, factory, model, input or resource registration. */
  async open(run: MemberLocalReadHandle, signal?: AbortSignal): Promise<MemberLocalOwnerView> {
    const value = await this.historyReader.open(run, signal),
      { backendId: _backendId, ...scope } = value.remote.scope,
      state = this.states.get(address(scope));
    if (state && value.native) state.binding = value.native.binding;
    const localPhase =
      state &&
      ['working', 'dispatching'].includes(state.phase) &&
      (state.abort.signal.aborted || performance.now() >= state.deadline)
        ? 'recovery-required'
        : state?.phase;
    const phase: Phase =
      localPhase ??
      (value.remote.receipt
        ? 'submitted'
        : value.remote.resources === 'settled'
          ? value.remote.runStatus === 'completed'
            ? 'fixed'
            : 'retired'
          : 'recovery-required');
    return { ...value, phase, ...(value.remote.receipt ? { receipt: value.remote.receipt } : {}) };
  }
  async openScope(scope: RemoteRunView['scope'], signal?: AbortSignal) {
    const run = await this.options.protocol.history(scope, signal);
    return { run, view: await this.open(run, signal) };
  }
  async openSession(nativeSessionId: string, signal?: AbortSignal) {
    const found = this.native.lookupNativeSession(nativeSessionId);
    if (!found || found.role !== 'work' || found.backendId !== this.options.protocol.backendId)
      throw new NativeWorkError('scope-mismatch');
    const opened = await this.openScope(
      { backendId: found.backendId, ...found.binding.scope },
      signal,
    );
    if (opened.view.native?.binding.nativeSessionId !== nativeSessionId)
      throw new NativeWorkError('scope-mismatch');
    return opened;
  }
  /** Host-internal raw history. Client transport uses observe's whitelist. */
  history(run: MemberLocalReadHandle, after = -1, limit = 100, signal?: AbortSignal) {
    return this.historyReader.history(run, after, limit, signal);
  }
  readInbox(run: MemberLocalReadHandle, signal?: AbortSignal) {
    return this.historyReader.readInbox(run, signal);
  }
  async updateQueue(
    run: MemberLocalReadHandle,
    update: Parameters<NativeOwner['service']['updateQueue']>[1],
  ) {
    const state = await this.liveDrive(run);
    this.check(state, 'queue');
    return this.track(this.native.service.updateQueue(state.grant, update));
  }
  observe(run: MemberLocalReadHandle, after = -1, signal?: AbortSignal) {
    return this.historyReader.observe(run, after, signal);
  }
  /** Host-internal raw frames; never mount this directly in Client transport. */
  follow(run: MemberLocalReadHandle, after = -1, signal?: AbortSignal) {
    return this.historyReader.follow(run, after, signal);
  }
  async stop(
    run: MemberLocalReadHandle,
    input: MemberLocalStopInput,
    signal?: AbortSignal,
  ): Promise<MemberLocalOwnerView> {
    this.options.protocol.assertReadHandle(run);
    const { backendId: _backendId, ...scope } = run.value.scope;
    let state = this.states.get(address(scope));
    if (!state && run.value.resources === 'held') {
      // Do not extend an old cleanup deadline by treating cached serverTime as
      // a fresh sample. Actual cleanup still verifies its backend capability.
      const sampledAt =
        performance.now() - Math.max(0, this.options.protocol.serverTime - run.value.serverTime);
      state = this.retain(run, run.value, sampledAt, 'cleanup-only');
    }
    // No history read/renew gates a local stop: revoked member access may deny
    // the business command while the old independent cleanup must still drain.
    // Dispatch the explicit original stop first. The physical local retirement
    // is independent of the HTTP wait; unknown is never a stopped/drained ACK.
    const stopping = this.track(this.options.protocol.stop(run, input, signal));
    if (state) this.fence(state);
    await stopping;
    return this.open(run, signal);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.lifetime.abort();
      await this.historyReader.close();
      for (const state of this.states.values()) this.fence(state);
      await Promise.allSettled([...this.jobs]);
      await this.results.close();
      await this.native.close();
    })());
  }
  async refresh(run: MemberLocalReadHandle): Promise<MemberLocalOwnerView> {
    const state = this.owned(run);
    if (!state) throw new NativeWorkError('scope-mismatch');
    await this.enqueue(state, async () => {
      this.check(state, 'open');
      const before = performance.now(),
        view = await this.options.protocol.command(run, { operation: 'renew', payload: {} });
      this.update(state, view, before);
    }).catch((error: unknown) => {
      this.fence(state);
      throw error;
    });
    return this.read(run);
  }
  /** Explicit interaction may use this process's still-live original drive.
   * A history handle never mints/resumes one, and an expired drive stays expired. */
  private async liveDrive(run: MemberLocalReadHandle): Promise<Owned> {
    const opened = await this.open(run),
      { backendId: _backendId, ...scope } = opened.remote.scope,
      state = this.states.get(address(scope));
    if (!state || state.role !== 'drive' || state.phase !== 'working' || !state.workRun)
      throw new NativeWorkError('cancelled');
    await this.refresh(state.workRun);
    this.check(state, 'send');
    return state;
  }
  async send(
    run: MemberLocalReadHandle,
    input: Omit<Parameters<NativeOwner['service']['send']>[1], 'selection'>,
  ) {
    const state = await this.liveDrive(run);
    this.check(state, 'send');
    return this.track(
      this.native.service.send(state.grant, {
        ...input,
        selection: this.workRun(state).value.selection,
      }),
    );
  }
}
