import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import {
  canonicalPayload,
  REMOTE_RUN_LIMITS,
  remoteNativeFixedReviewFactsSchema,
  remoteReviewResultDeclarationSchema,
  type RemoteReviewView,
} from '@zhuma/agent-core';
import {
  MemberLocalReviewProtocol,
  type MemberLocalAcceptedReview,
  type MemberLocalReviewReadHandle,
  type MemberLocalReviewStopInput,
} from './member-local-review-protocol.js';
import type { NativeReviewPorts } from './native-work-session-purpose.js';
import {
  type NativeWorkAction,
  type NativeWorkGrant,
  type NativeSessionBinding,
  type NativeSessionSelection,
} from './native-work-session-contract.js';
import type { openNativeWorkSessions } from './native-work-session-storage.js';
import type { NativeDshComposition } from './native-work-session-dsh.js';
import { executionReviewCompositionRequest } from './execution-review-composition.js';
import {
  nativeReviewContextFromScope,
  NativeReviewError,
  type NativeFixedReviewRef,
} from './native-work-session-review-contract.js';
import {
  nativeFixedReviewIssuer,
  type NativeFixedReviewIssuer,
} from './native-work-session-result.js';
import { observeNativeReview } from './native-work-session-review-observation.js';
import {
  retainNativeReviewResources,
  type NativeReviewResourceClosure,
} from './native-work-session-review-closure.js';
import {
  registerExecutionResourceScope,
  EXECUTION_RESOURCE_SOURCE_VERSION,
  type ExecutionMcpConnectionLease,
  type FrozenMcpResource,
} from './execution-run-resources.js';

type NativeOwner = Awaited<ReturnType<typeof openNativeWorkSessions>>;
type Phase =
  'dispatching' | 'working' | 'fixed' | 'submitted' | 'retiring' | 'retired' | 'recovery-required';
interface OwnedReview {
  readonly run: MemberLocalAcceptedReview;
  readonly abort: AbortController;
  view: RemoteReviewView;
  phase: Phase;
  deadline: number;
  cleanupDeadline: number;
  grant?: NativeWorkGrant;
  binding?: NativeSessionBinding;
  receipt?: RemoteReviewView['receipt'];
  failure?: RemoteReviewView['failure'];
  dispatch?: Promise<void>;
  events: Promise<unknown>;
  messageId?: string;
  accepted: boolean;
  received: boolean;
  collection?: Promise<void>;
  retirement?: Promise<void>;
  renewing?: Promise<void>;
  resources?: NativeReviewResourceClosure;
  observation?: ReturnType<typeof observeNativeReview>;
  timer?: ReturnType<typeof setTimeout>;
  resultRequestId: string;
}
export interface MemberLocalReviewView {
  readonly phase: Phase;
  readonly remote: RemoteReviewView;
  readonly native: ReturnType<NativeOwner['service']['open']> | undefined;
  readonly binding?: NativeSessionBinding;
  readonly receipt?: RemoteReviewView['receipt'];
  readonly failure?: RemoteReviewView['failure'];
}
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);

/** Review-purpose routing over the SAME MemberLocalExecutionOwner native service,
 * runtime and result owner. This controller never opens a native owner/factory. */
export class MemberLocalExecutionReview {
  private readonly states = new Map<string, OwnedReview>();
  private readonly originals = new WeakMap<object, OwnedReview>();
  private readonly grants = new WeakMap<NativeWorkGrant, OwnedReview>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private native?: NativeOwner;
  private issuer?: NativeFixedReviewIssuer;
  private closing?: Promise<void>;
  private stopReady?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      readonly protocol: MemberLocalReviewProtocol;
      assertModel(selection: NativeSessionSelection, signal: AbortSignal): void | Promise<void>;
      openMcp?(
        resource: FrozenMcpResource,
        signal: AbortSignal,
      ): Promise<ExecutionMcpConnectionLease>;
    },
  ) {}
  private state(original: object): OwnedReview {
    const state = this.originals.get(original);
    if (!state || this.states.get(canonicalPayload(state.view.scope)) !== state)
      throw new NativeReviewError('review-authority-denied');
    this.options.protocol.assertReadHandle(state.run);
    return state;
  }
  private current(state: OwnedReview, action: NativeWorkAction): undefined {
    if (
      this.lifetime.signal.aborted ||
      state.abort.signal.aborted ||
      performance.now() >= state.deadline ||
      state.view.stopRequested ||
      state.view.authority !== 'drive' ||
      !['dispatching', 'working'].includes(state.phase)
    )
      throw new NativeReviewError('cancelled');
    if (!['open', 'history', 'follow', 'send', 'queue'].includes(action))
      throw new NativeReviewError('review-authority-denied');
    return undefined;
  }
  readonly reviewPorts: NativeReviewPorts = {
    authorize: (original, action) => {
      const state = this.state(original);
      this.options.protocol.assertStartHandle(state.run);
      this.current(state, action);
      return {
        scope: state.run.composition.payload.scope,
        selection: executionReviewCompositionRequest(state.run.composition).selection,
        signal: state.abort.signal,
      };
    },
    authorizeCleanup: (original) => {
      const state = this.state(original);
      if (performance.now() >= state.cleanupDeadline) throw new NativeReviewError('cancelled');
      return state.run.composition.payload.scope;
    },
    unavailableRequired: (original) => {
      const state = this.state(original);
      this.current(state, 'send');
      return state.run.composition.payload.targetResources
        .filter((item) => item.kind === 'external-reference')
        .map(({ resourceRef }) => ({ resourceRef, code: 'review-unsupported-material' as const }));
    },
    readTarget: async (original, query, wait) => {
      const state = this.state(original);
      // A fast first tool must join the same real send/receipt/admission.
      await state.dispatch;
      this.current(state, 'send');
      if (!state.accepted || !state.binding) throw new NativeReviewError('review-unavailable');
      const value = await this.options.protocol.command(
        state.run,
        { operation: 'input-read', payload: query },
        wait,
        { waitForSourceSettlement: true },
      );
      this.current(state, 'send');
      this.options.protocol.assertReadBinding(state.run, state.binding);
      const context = nativeReviewContextFromScope(state.run.composition.payload.scope);
      if (
        !same(value.source.context, context) ||
        value.source.nativeSessionId !== state.binding.nativeSessionId ||
        value.source.nativeAgentId !== state.binding.nativeAgentId ||
        value.source.configurationId !== state.binding.selection.configurationId
      )
        throw new NativeReviewError('review-target-changed');
      let released = false;
      return Object.freeze({
        source: value.source,
        range: value.range,
        bytes: Buffer.from(value.base64, 'base64'),
        encoding: value.encoding,
        signal: AbortSignal.any([state.abort.signal, wait]),
        check: () => {
          if (released || wait.aborted) throw new NativeReviewError('cancelled');
          this.current(state, 'send');
        },
        release: () => {
          released = true;
        },
      });
    },
  };
  bindNative(native: NativeOwner): void {
    if (this.native || this.lifetime.signal.aborted)
      throw new NativeReviewError('review-unavailable');
    this.native = native;
    this.issuer = nativeFixedReviewIssuer(native.service, native.runtime);
    if (!this.issuer.onReviewReady) throw new NativeReviewError('review-unavailable');
    this.stopReady = this.issuer.onReviewReady((grant, ref) => {
      const state = this.grants.get(grant);
      if (state) void this.collect(state, ref).catch((error) => this.refuse(state, error));
    });
    this.heartbeat = setInterval(() => {
      for (const state of this.states.values()) {
        if (!['working', 'dispatching'].includes(state.phase) || state.collection || state.renewing)
          continue;
        const work = state.events.then(async () => {
          this.current(state, 'open');
          const before = performance.now();
          this.update(
            state,
            await this.options.protocol.command(state.run, { operation: 'renew', payload: {} }),
            before,
          );
        });
        state.events = work;
        state.renewing = this.track(
          work.finally(() => {
            delete state.renewing;
          }),
        );
        void state.renewing.catch(() => this.fence(state));
      }
    }, REMOTE_RUN_LIMITS.renewAfterMs);
    this.heartbeat.unref();
  }
  owns(grant: NativeWorkGrant): boolean {
    return this.grants.has(grant);
  }
  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return job;
  }
  private nativeOwner(): NativeOwner {
    if (!this.native || !this.issuer) throw new NativeReviewError('review-unavailable');
    return this.native;
  }
  private update(state: OwnedReview, value: RemoteReviewView, before: number): void {
    if (
      !same(value.scope, state.run.value.scope) ||
      value.deviceId !== this.options.protocol.deviceId ||
      value.permit.id !== state.run.value.permit.id ||
      value.cleanup.id !== state.run.value.cleanup.id ||
      value.nextSequence < state.view.nextSequence
    )
      throw new NativeReviewError('review-target-changed');
    state.view = structuredClone(value);
    if (value.failure) state.failure = structuredClone(value.failure);
    state.deadline =
      before + Math.min(REMOTE_RUN_LIMITS.driveTtlMs, value.permit.expiresAt - value.serverTime);
    state.cleanupDeadline =
      before + Math.min(REMOTE_RUN_LIMITS.cleanupTtlMs, value.cleanup.expiresAt - value.serverTime);
    if (state.timer) clearTimeout(state.timer);
    if (value.authority === 'drive' && !value.stopRequested) {
      state.timer = setTimeout(
        () => this.fence(state),
        Math.max(1, state.deadline - performance.now()),
      );
      state.timer.unref();
    }
  }
  async compose(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): Promise<NativeDshComposition> {
    const state = this.grants.get(grant);
    if (!state) throw new NativeReviewError('review-authority-denied');
    this.current(state, 'send');
    this.options.protocol.assertReadBinding(state.run, binding);
    state.binding = binding;
    const snapshot = state.run.composition;
    const tools = this.issuer!.registerNativeReviewTools(ctx, binding, grant, () => {
      this.current(state, 'send');
      state.resources?.assertLive();
      return undefined;
    });
    const adopted = await registerExecutionResourceScope(ctx, snapshot.payload.resources, grant, {
      sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
      signal: state.abort.signal,
      assertCurrent: () => this.current(state, 'send'),
      openMcp: (resource, signal) => {
        this.current(state, 'send');
        if (!this.options.openMcp) throw new NativeReviewError('review-unavailable');
        return this.options.openMcp(resource, signal);
      },
    });
    // Retain disposal before ready/assertions can fail; normal SDK scope disposal
    // does not revoke the separate continuing member/Run authority.
    state.resources = retainNativeReviewResources(
      {
        ...adopted,
        scope: snapshot.payload.scope,
        configurationId: snapshot.configurationId,
        signal: state.abort.signal,
        assertCurrent: () => {
          this.current(state, 'send');
          if (adopted.signal.aborted) throw new NativeReviewError('review-unavailable');
          return undefined;
        },
      },
      snapshot.payload.scope,
      snapshot.configurationId,
    );
    await adopted.ready;
    state.resources.assertLive();
    if (!same([...tools.toolAllowlist, ...adopted.toolAllowlist], snapshot.payload.toolAllowlist))
      throw new NativeReviewError('review-unavailable');
    state.observation = observeNativeReview(ctx, binding, grant, {
      claim: () => {
        if (state.received) void this.accept(state).catch(() => this.fence(state));
      },
      idle: () => {
        void this.collect(state).catch((error) => this.refuse(state, error));
      },
      fault: (kind) => {
        if (kind === 'error') this.fence(state);
        else void this.collect(state).catch((error) => this.refuse(state, error));
      },
    });
    return { context: snapshot.payload.context, toolAllowlist: snapshot.payload.toolAllowlist };
  }
  async start(run: MemberLocalAcceptedReview): Promise<MemberLocalReviewView> {
    this.nativeOwner();
    this.options.protocol.assertStartHandle(run);
    const before = performance.now(),
      view = await this.options.protocol.status(run),
      key = canonicalPayload(view.scope),
      existing = this.states.get(key);
    if (existing) {
      if (existing.run !== run) throw new NativeReviewError('review-authority-denied');
      return this.read(run);
    }
    if (
      this.lifetime.signal.aborted ||
      view.authority !== 'drive' ||
      view.runStatus !== 'requested' ||
      view.resources !== 'held' ||
      view.stopRequested ||
      [...this.states.values()].filter((state) => !['submitted', 'retired'].includes(state.phase))
        .length >= REMOTE_RUN_LIMITS.activeAuthorities
    )
      throw new NativeReviewError('review-unavailable');
    const state: OwnedReview = {
      run,
      view,
      abort: new AbortController(),
      phase: 'dispatching',
      deadline: before,
      cleanupDeadline: before,
      events: Promise.resolve(),
      accepted: false,
      received: false,
      resultRequestId: randomUUID(),
    };
    this.states.set(key, state);
    this.originals.set(run, state);
    this.update(state, view, before);
    state.grant = this.native!.service.reviewGrant(run);
    this.grants.set(state.grant, state);
    state.dispatch = this.track(this.dispatch(state));
    try {
      await state.dispatch;
    } catch (error) {
      this.fence(state);
      throw error;
    }
    return this.read(run);
  }
  private async dispatch(state: OwnedReview): Promise<void> {
    const { firstMessage, selection } = executionReviewCompositionRequest(state.run.composition),
      grant = state.grant!;
    await this.options.assertModel(selection, grant.signal);
    this.current(state, 'send');
    if (this.native!.service.open(grant)) throw new NativeReviewError('review-target-changed');
    const receipt = await this.native!.service.send(grant, {
      requestId: randomUUID(),
      text: firstMessage.text,
      mode: firstMessage.mode,
      selection,
    });
    this.current(state, 'send');
    const binding = this.native!.service.readBinding(grant);
    if (
      !binding ||
      !['received', 'claimed'].includes(receipt.status) ||
      receipt.fingerprint !== firstMessage.inputFingerprint
    )
      throw new NativeReviewError('review-unavailable');
    state.binding = binding;
    state.messageId = receipt.messageId;
    await this.event(state, 'received');
    state.received = true;
    state.phase = 'working';
    await this.accept(state);
  }
  private event(state: OwnedReview, kind: 'received' | 'accepted'): Promise<void> {
    const job = state.events.then(async () => {
      this.current(state, 'send');
      const before = performance.now(),
        binding = state.binding!;
      this.update(
        state,
        await this.options.protocol.command(state.run, {
          operation: 'event',
          payload: {
            event: {
              kind,
              sequence: state.view.nextSequence,
              nativeSessionId: binding.nativeSessionId,
              nativeAgentId: binding.nativeAgentId,
            },
          },
        }),
        before,
      );
    });
    state.events = job;
    return this.track(job);
  }
  private async accept(state: OwnedReview): Promise<void> {
    if (
      state.accepted ||
      !state.received ||
      !state.messageId ||
      !state.observation?.claimFor(state.messageId)
    )
      return;
    // All admission observations serialize through the original event chain.
    const job = state.events.then(async () => {
      if (state.accepted) return;
      this.current(state, 'send');
      const binding = state.binding!,
        before = performance.now();
      this.update(
        state,
        await this.options.protocol.command(state.run, {
          operation: 'event',
          payload: {
            event: {
              kind: 'accepted',
              sequence: state.view.nextSequence,
              nativeSessionId: binding.nativeSessionId,
              nativeAgentId: binding.nativeAgentId,
            },
          },
        }),
        before,
      );
      state.accepted = true;
    });
    state.events = job;
    await this.track(job);
    void this.collect(state).catch((error) => this.refuse(state, error));
  }
  private refuse(state: OwnedReview, error: unknown): void {
    // An unknown transport outcome after seal retains the original fixed cut.
    // It is never rewritten as a model failure or an automatic fresh attempt.
    if (state.phase === 'fixed' || state.view.result) return;
    const code =
      error instanceof NativeReviewError
        ? (
            [
              'review-read-required',
              'review-unsupported-material',
              'review-read-budget-exceeded',
              'review-result-rejected',
              'output-too-large',
            ] as const
          ).find((code) => code === error.code)
        : undefined;
    if (!code) {
      this.fence(state);
      return;
    }
    const work = state.events.then(async () => {
      this.current(state, 'send');
      const before = performance.now();
      this.update(
        state,
        await this.options.protocol.command(state.run, {
          operation: 'event',
          payload: {
            event: {
              kind: 'failed',
              sequence: state.view.nextSequence,
              resourcesSettled: false,
              failure: {
                code,
                resourceRefs: [],
              },
            },
          },
        }),
        before,
      );
    });
    state.events = work;
    void this.track(work)
      .catch(() => undefined)
      .finally(() => this.fence(state));
  }
  private collect(state: OwnedReview, ref?: NativeFixedReviewRef): Promise<void> {
    if (state.collection) return state.collection;
    if (!state.accepted || !state.grant || state.abort.signal.aborted || state.phase !== 'working')
      return Promise.resolve();
    const work = (async () => {
      await state.events;
      this.current(state, 'send');
      const prepared = ref
        ? { status: 'ready' as const, ref }
        : await this.issuer!.prepareFixedReview(state.grant!, state.abort.signal);
      if (prepared.status !== 'ready') return;
      await state.resources?.close();
      state.resources?.assertClosed();
      this.issuer!.assertFixedReview(state.grant!, prepared.ref);
      const lease = await this.issuer!.readFixedReview(
        state.grant!,
        prepared.ref,
        state.abort.signal,
      );
      let fixed;
      try {
        lease.check();
        fixed = remoteNativeFixedReviewFactsSchema.parse({
          source: lease.source,
          content: lease.content,
          readManifest: lease.readManifest,
          readManifestDigest: lease.readManifestDigest,
          digest: lease.digest,
          provenanceFingerprint: lease.provenanceFingerprint,
        });
      } finally {
        lease.release();
      }
      const result = remoteReviewResultDeclarationSchema.parse({
        requestId: state.resultRequestId,
        source: fixed.source,
        digest: fixed.digest,
        readManifestDigest: fixed.readManifestDigest,
        provenanceFingerprint: fixed.provenanceFingerprint,
      });
      // The original SDK cut is now physically fixed. An unknown seal/commit
      // reply must remain recoverable, including during a Host shutdown.
      state.phase = 'fixed';
      let before = performance.now();
      this.update(
        state,
        await this.options.protocol.command(state.run, {
          operation: 'event',
          payload: {
            event: {
              kind: 'sealed',
              sequence: state.view.nextSequence,
              idle: true,
              flushed: true,
              resourcesSettled: true,
              result,
            },
          },
        }),
        before,
      );
      try {
        const committed = await this.options.protocol.command(state.run, {
          operation: 'submit-result',
          requestId: state.resultRequestId,
          payload: { result, fixed },
        });
        state.receipt = committed.receipt;
      } catch (error) {
        // Read the original receipt/refusal before interpreting a lost reply.
        const known = await this.options.protocol.command(state.run, {
          operation: 'result-status',
          payload: { resultRequestId: state.resultRequestId },
        });
        if (known.status === 'committed') state.receipt = known.receipt;
        else if (known.status !== 'needs-attention') throw error;
      }
      before = performance.now();
      this.update(state, await this.options.protocol.status(state.run), before);
      await this.retire(state);
      if (state.view.resources === 'settled' && state.receipt) state.phase = 'submitted';
    })();
    state.collection = this.track(
      work.finally(() => {
        delete state.collection;
      }),
    );
    return state.collection;
  }
  private fence(state: OwnedReview): void {
    if (['submitted', 'retired'].includes(state.phase) || state.retirement) return;
    state.phase = 'recovery-required';
    state.abort.abort();
    if (state.timer) clearTimeout(state.timer);
    const work = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      this.retire(state),
    );
    state.retirement = this.track(
      work.finally(() => {
        delete state.retirement;
      }),
    );
    void state.retirement.catch(() => undefined);
  }
  private async retire(state: OwnedReview): Promise<void> {
    state.phase = 'retiring';
    try {
      await state.events.catch(() => undefined);
      const retired = await this.native!.service.retireReviewForCleanup(
        state.run,
        AbortSignal.timeout(Math.max(1, Math.ceil(state.cleanupDeadline - performance.now()))),
      );
      if (retired.status !== 'retired') return;
      await state.resources?.close();
      state.resources?.assertClosed();
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
      if (!evidence) throw new NativeReviewError('review-unavailable');
      const before = performance.now();
      this.update(
        state,
        await this.options.protocol.command(state.run, {
          operation: 'cleanup',
          payload: {
            observation: { kind: 'drained', sequence: state.view.nextSequence, evidence },
          },
        }),
        before,
      );
      if (state.view.resources === 'settled') {
        state.phase = state.receipt ? 'submitted' : 'retired';
        state.abort.abort();
        state.observation?.close();
      }
    } finally {
      if (state.phase === 'retiring') state.phase = 'recovery-required';
    }
  }
  read(run: MemberLocalReviewReadHandle): MemberLocalReviewView {
    const state = this.state(run);
    let native;
    if (state.grant && !state.abort.signal.aborted) {
      try {
        native = this.native!.service.open(state.grant);
      } catch {
        /* cleanup retains its separate identity */
      }
    }
    return {
      phase: state.phase,
      remote: structuredClone(state.view),
      native,
      ...(state.binding ? { binding: structuredClone(state.binding) } : {}),
      ...(state.receipt ? { receipt: structuredClone(state.receipt) } : {}),
      ...(state.failure ? { failure: structuredClone(state.failure) } : {}),
    };
  }
  async stop(
    run: MemberLocalAcceptedReview,
    input: MemberLocalReviewStopInput,
    wait?: AbortSignal,
  ): Promise<MemberLocalReviewView> {
    let state = this.originals.get(run);
    if (!state) {
      // A may receive a genuine accept after closing admission. It must hand
      // this exact handle here BEFORE closing the same native owner.
      this.options.protocol.assertStartHandle(run);
      const sampled =
        performance.now() - Math.max(0, this.options.protocol.serverTime - run.value.serverTime);
      state = {
        run,
        view: run.value,
        abort: new AbortController(),
        phase: 'recovery-required',
        deadline: sampled,
        cleanupDeadline: sampled,
        events: Promise.resolve(),
        accepted: false,
        received: false,
        resultRequestId: randomUUID(),
      };
      this.states.set(canonicalPayload(run.value.scope), state);
      this.originals.set(run, state);
      this.update(state, run.value, sampled);
    }
    const stopping = this.track(this.options.protocol.stop(run, input, wait));
    this.fence(state);
    await stopping;
    await state.retirement;
    return this.read(run);
  }
  canSwitchBackend(): boolean {
    return (
      !this.lifetime.signal.aborted &&
      !this.closing &&
      !this.jobs.size &&
      this.options.protocol.canSwitchBackend() &&
      [...this.states.values()].every(
        (s) =>
          ['submitted', 'retired'].includes(s.phase) &&
          s.view.resources === 'settled' &&
          !s.collection &&
          !s.retirement,
      )
    );
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.stopReady?.();
      for (const state of this.states.values()) {
        // A sealed reviewer has already physically retired. Ordinary shutdown
        // retains its commit obligation; only explicit Stop may cancel it.
        if (state.phase !== 'fixed') this.fence(state);
      }
      while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    })());
  }
}
