import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalPayload,
  type RemoteWorkflowCandidate,
  type RemoteWorkflowView,
  type RemoteWorkflowTarget,
} from '@zhuma/agent-core';
import {
  MemberLocalExecutionProtocol,
  MemberLocalProtocolError,
  type MemberLocalAcceptInput,
  type MemberLocalAcceptedRun,
  type MemberLocalReadHandle,
  type MemberLocalWorkflowInput,
} from './member-local-execution-protocol.js';
import {
  MemberLocalReviewProtocol,
  type MemberLocalReviewAcceptInput,
  type MemberLocalAcceptedReview,
  type MemberLocalReviewReadHandle,
} from './member-local-review-protocol.js';
import { MemberLocalExecutionOwner } from './member-local-execution-owner.js';
import { NativeWorkError } from './native-work-session-contract.js';
import {
  NativeWorkflowConsumerLifetime,
  type NativeWorkflowAdmission,
} from './native-work-session-auto-lifetime.js';

type Work = Extract<RemoteWorkflowCandidate, { kind: 'work' }>;
type Review = Extract<RemoteWorkflowCandidate, { kind: 'review' }>;
export interface NativeMemberWorkflowPreparation<Candidate extends RemoteWorkflowCandidate> {
  readonly requestId: string;
  readonly candidate: Candidate;
  readonly workflow: RemoteWorkflowView;
  readonly signal: AbortSignal;
}
export interface NativeMemberWorkflowHooks {
  /** A reuses its original workspace/knowledge prepare here. No Agent starts. */
  prepareWork(input: NativeMemberWorkflowPreparation<Work>): Promise<MemberLocalAcceptInput>;
  /** A binds that exact request/actual accepted handle before the original start. */
  workAccepted?(
    input: NativeMemberWorkflowPreparation<Work>,
    run: MemberLocalAcceptedRun,
  ): void | Promise<void>;
  prepareReview?(
    input: NativeMemberWorkflowPreparation<Review>,
  ): Promise<MemberLocalReviewAcceptInput>;
  reviewAccepted?(
    input: NativeMemberWorkflowPreparation<Review>,
    run: MemberLocalAcceptedReview,
  ): void | Promise<void>;
}
export interface NativeMemberWorkflowConsumerOptions {
  readonly protocol: MemberLocalExecutionProtocol;
  readonly native: MemberLocalExecutionOwner;
  readonly review?: MemberLocalReviewProtocol;
  readonly hooks: NativeMemberWorkflowHooks;
  readonly signal: AbortSignal;
  readonly pollMs?: number;
}
type Pending =
  | {
      readonly kind: 'work';
      readonly requestId: string;
      readonly candidate: Work;
      run?: MemberLocalAcceptedRun;
      recovered?: MemberLocalReadHandle;
    }
  | {
      readonly kind: 'review';
      readonly requestId: string;
      readonly candidate: Review;
      run?: MemberLocalAcceptedReview;
      recovered?: MemberLocalReviewReadHandle;
    };
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);
const key = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

/** Explicitly enabled member-side consumer. D owns every intent, candidate,
 * generation, Run and ballot. This adds no model loop or durable domain state. */
export class NativeMemberWorkflowConsumer {
  private life = new NativeWorkflowConsumerLifetime();
  private readonly cleanup = new AbortController();
  private readonly seen = new Set<string>();
  /** Exact original owner cleanup acknowledgments, never a workflow authority. */
  private readonly settledScopes = new Set<string>();
  private remote?: RemoteWorkflowView;
  private pending?: Pending;
  private blocked?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping?: Promise<void>;
  private reconciling?: Promise<ReturnType<NativeMemberWorkflowConsumer['view']>>;
  private recoveryTarget?: RemoteWorkflowTarget;
  private closing?: Promise<void>;
  private readonly pollMs: number;
  constructor(private readonly options: NativeMemberWorkflowConsumerOptions) {
    this.pollMs = options.pollMs ?? 1000;
    if (
      !Number.isSafeInteger(this.pollMs) ||
      this.pollMs < 250 ||
      this.pollMs > 5000 ||
      (options.review &&
        (options.review.backendId !== options.protocol.backendId ||
          options.review.actorId !== options.protocol.actorId ||
          options.review.deviceId !== options.protocol.deviceId))
    )
      throw new NativeWorkError('configuration-mismatch');
    options.signal.addEventListener(
      'abort',
      () => {
        void this.close().catch(() => undefined);
      },
      { once: true },
    );
    if (options.signal.aborted) this.life.fence();
  }
  view() {
    return {
      armed: this.life.armed,
      busy: this.life.busy || !!this.pending,
      ...(this.remote ? { remote: structuredClone(this.remote) } : {}),
      ...(this.blocked ? { blocked: this.blocked } : {}),
    };
  }
  async inspect(target: RemoteWorkflowTarget, signal?: AbortSignal) {
    this.remote = await this.options.protocol.workflowStatus({ target }, signal);
    if (
      this.remote.intent &&
      !this.life.armed &&
      (await this.options.protocol.pendingWorkflowAccept(this.control(), signal))
    )
      this.blocked = 'remote-recovery-required';
    return this.view();
  }
  /** Explicit unknown-ACK reconciliation only. No arm, accept replay or start. */
  recover(target: RemoteWorkflowTarget, signal?: AbortSignal) {
    if (this.reconciling)
      return same(target, this.recoveryTarget)
        ? this.reconciling
        : Promise.reject(new NativeWorkError('scope-mismatch'));
    this.recoveryTarget = structuredClone(target);
    const work = this.recoverNow(target, signal).finally(() => {
      if (this.reconciling === work) {
        delete this.reconciling;
        delete this.recoveryTarget;
      }
    });
    this.reconciling = work;
    return work;
  }
  private async recoverNow(target: RemoteWorkflowTarget, signal?: AbortSignal) {
    this.current();
    if (this.life.armed || this.pending || this.pumping) throw new NativeWorkError('unavailable');
    await this.inspect(target, signal);
    if (!this.remote?.intent) return this.view();
    const entry = await this.options.protocol.pendingWorkflowAccept(this.control(), signal);
    if (!entry) return this.view();
    if (entry.candidate.kind === 'review' && !this.options.review)
      throw new NativeWorkError('configuration-mismatch');
    this.pending =
      entry.candidate.kind === 'work'
        ? { kind: 'work', requestId: entry.requestId, candidate: entry.candidate }
        : { kind: 'review', requestId: entry.requestId, candidate: entry.candidate };
    await this.observePending();
    return this.view();
  }
  async start(
    requestId: string,
    input: MemberLocalWorkflowInput<'workflow-start'>,
    signal?: AbortSignal,
  ) {
    this.current();
    if (this.reconciling) throw new NativeWorkError('unavailable');
    const value = await this.options.protocol.workflowStart(requestId, input, signal);
    this.attach(value);
    return this.view();
  }
  async resume(
    requestId: string,
    input: MemberLocalWorkflowInput<'workflow-resume'>,
    signal?: AbortSignal,
  ) {
    this.current();
    if (this.reconciling || this.pending || !this.options.native.canSwitchBackend())
      throw new NativeWorkError('unavailable');
    await this.life.close(async () => {});
    const value = await this.options.protocol.workflowResume(requestId, input, signal);
    this.life = new NativeWorkflowConsumerLifetime();
    this.attach(value);
    return this.view();
  }
  private current() {
    if (this.closing || this.options.signal.aborted) throw new NativeWorkError('cancelled');
  }
  private attach(value: RemoteWorkflowView) {
    this.current();
    if (
      this.remote?.intent &&
      value.intent &&
      this.remote.intent.intentId !== value.intent.intentId
    )
      throw new NativeWorkError('scope-mismatch');
    this.remote = value;
    if (!value.intent || value.requiresResume || !['running', 'waiting'].includes(value.state))
      return;
    // Loading existing active/unknown work is never permission to create/resume an Agent.
    if (
      !this.life.armed &&
      [...value.activeWork, ...value.activeReviews].some((v) => v.resources !== 'settled')
    ) {
      this.blocked = 'remote-recovery-required';
      return;
    }
    this.life.arm();
    this.wake();
  }
  /** Coalesced fact refresh. It cannot arm a cold or stopped instance. */
  wake(): void {
    if (!this.life.armed || this.closing || this.pumping) return;
    if (this.timer) clearTimeout(this.timer);
    delete this.timer;
    const work = this.life
      .run((scope) => this.tick(scope))
      .catch((error: unknown) => {
        this.blocked =
          error instanceof MemberLocalProtocolError || error instanceof NativeWorkError
            ? error.code
            : 'unavailable';
      })
      .finally(() => {
        if (this.pumping === work) delete this.pumping;
        if (this.life.armed && !this.closing) {
          this.timer = setTimeout(() => this.wake(), this.pollMs);
          this.timer.unref();
        }
      });
    this.pumping = work;
  }
  private control() {
    const remote = this.remote;
    if (!remote?.intent) throw new NativeWorkError('unavailable');
    const { spaceId, taskId, planId, revision } = remote.scope;
    return {
      target: { spaceId, taskId, planId, revision },
      workflow: { intentId: remote.intent.intentId, generation: remote.intent.generation },
    };
  }
  private async tick(scope: NativeWorkflowAdmission) {
    scope.assertCurrent();
    const view = await this.options.protocol.workflowNext(this.control(), scope.signal);
    scope.assertCurrent();
    this.remote = view;
    if (this.pending) await this.observePending();
    if (!view.intent || view.requiresResume || !['running', 'waiting'].includes(view.state)) {
      this.life.fence();
      return;
    }
    if (this.pending) return;
    // Include native physical obligations and unknown accepts, not merely SDK idle.
    if (
      !this.options.native.canSwitchBackend() ||
      !this.options.protocol.canSwitchBackend() ||
      [...view.activeWork, ...view.activeReviews].some((v) => v.resources !== 'settled')
    )
      return;
    const candidate = view.candidates[0];
    if (!candidate) {
      delete this.blocked;
      return;
    }
    const fingerprint = key(candidate);
    if (this.seen.has(fingerprint)) {
      this.blocked = 'remote-recovery-required';
      return;
    }
    if (this.seen.size >= 1536) throw new NativeWorkError('capacity');
    if (
      candidate.kind === 'review' &&
      (!this.options.review || !this.options.hooks.prepareReview)
    ) {
      this.blocked = 'review-not-configured';
      return;
    }
    const requestId = randomUUID();
    const preparation = { requestId, candidate, workflow: view, signal: scope.signal };
    this.seen.add(fingerprint);
    if (candidate.kind === 'work') {
      const workInput = { ...preparation, candidate };
      const input = await this.options.hooks.prepareWork(workInput);
      scope.assertCurrent();
      if (
        !same(input.target, candidate.target) ||
        !same(input.workflow, candidate.workflow) ||
        input.mode !== candidate.mode ||
        input.expectedNodeVersion !== candidate.expectedNodeVersion ||
        input.expectedRunVersion !== candidate.expectedRunVersion ||
        !same(input.executor, candidate.executor) ||
        !same(input.model, view.intent.defaults.model)
      )
        throw new NativeWorkError('scope-mismatch');
      const prepared = await this.options.protocol.prepareAccept(requestId, input, scope.signal);
      await this.options.protocol.rememberWorkflowAccept(requestId, candidate, scope.signal);
      scope.assertCurrent();
      const pending: Extract<Pending, { kind: 'work' }> = { kind: 'work', requestId, candidate };
      this.pending = pending;
      const run = await prepared.send(scope.cleanupSignal);
      pending.run = run;
      if (!this.life.armed) {
        await this.retire(pending);
        return;
      }
      await this.options.hooks.workAccepted?.(workInput, run);
      scope.assertCurrent();
      await this.options.native.start(run);
    } else {
      const reviewInput = { ...preparation, candidate };
      const input = await this.options.hooks.prepareReview!(reviewInput);
      scope.assertCurrent();
      if (
        !same(input.target, candidate.target) ||
        !same(input.workflow, candidate.workflow) ||
        input.expectedReviewVersion !== candidate.expectedReviewVersion ||
        input.reviewerRef.id !== candidate.reviewerRef.id ||
        input.reviewerRef.version !== candidate.reviewerRef.version ||
        !same(input.model, view.intent.defaults.model)
      )
        throw new NativeWorkError('scope-mismatch');
      const prepared = await this.options.review!.prepareAccept(requestId, input, scope.signal);
      await this.options.protocol.rememberWorkflowAccept(requestId, candidate, scope.signal);
      scope.assertCurrent();
      const pending: Extract<Pending, { kind: 'review' }> = {
        kind: 'review',
        requestId,
        candidate,
      };
      this.pending = pending;
      const run = await prepared.send(scope.cleanupSignal);
      pending.run = run;
      if (!this.life.armed) {
        await this.retire(pending);
        return;
      }
      await this.options.hooks.reviewAccepted?.(reviewInput, run);
      scope.assertCurrent();
      await this.options.native.startReview(run);
    }
    delete this.blocked;
  }
  private async observePending() {
    const pending = this.pending!;
    if (!pending.run) {
      if (pending.recovered) {
        this.blocked = 'remote-recovery-required';
        return;
      }
      // Unknown accept: reconcile this exact durable original intent. This result
      // is cleanup/result authority only and MUST NOT enter native.start().
      if (pending.kind === 'work')
        pending.recovered = await this.options.protocol.recover(
          { target: pending.candidate.target, acceptRequestId: pending.requestId },
          this.cleanup.signal,
        );
      else
        pending.recovered = await this.options.review!.recover(
          {
            target: pending.candidate.target,
            acceptRequestId: pending.requestId,
            reviewerRef: {
              id: pending.candidate.reviewerRef.id,
              version: pending.candidate.reviewerRef.version,
            },
          },
          this.cleanup.signal,
        );
      this.blocked = 'remote-recovery-required';
      return;
    }
    const view =
      pending.kind === 'work'
        ? this.options.native.read(pending.run)
        : this.options.native.readReview(pending.run);
    if (view.remote.resources !== 'settled') return;
    if (
      view.phase === 'submitted' ||
      (view.remote.runStatus === 'completed' && view.remote.receipt)
    ) {
      await this.options.protocol.forgetWorkflowAccept(
        pending.candidate,
        pending.run.value.scope,
        this.cleanup.signal,
      );
      delete this.pending;
      delete this.blocked;
    } else {
      this.blocked = 'remote-recovery-required';
      this.life.fence();
    }
  }
  private async retire(pending: Pending) {
    if (pending.kind === 'work') {
      const run = pending.run ?? pending.recovered;
      if (!run) return;
      const value = await this.options.protocol.status(run).catch(() => run.value);
      if (value.resources === 'settled') return value;
      await this.options.native
        .stop(
          run,
          {
            requestId: randomUUID(),
            expectedNodeVersion: value.nodeVersion,
            expectedRunVersion: value.runVersion,
          },
          this.cleanup.signal,
        )
        .catch(() => undefined);
    } else {
      const run = pending.run;
      if (run) {
        const value = await this.options.review!.status(run).catch(() => run.value);
        if (value.resources === 'settled') return value;
        await this.options.native
          .stopReview(
            run,
            { requestId: randomUUID(), expectedAttemptVersion: value.attemptVersion },
            this.cleanup.signal,
          )
          .catch(() => undefined);
      } else if (pending.recovered) {
        const value = await this.options.review!.status(pending.recovered);
        if (value.resources === 'settled') return value;
        if (!value.stopRequested)
          await this.options.review!.stop(
            pending.recovered,
            { requestId: randomUUID(), expectedAttemptVersion: value.attemptVersion },
            this.cleanup.signal,
          );
        await this.options.native.recoverReview(pending.recovered, this.cleanup.signal);
      }
    }
  }
  /** Fence first; join every actually issued accept before shared Owner.close. */
  fence(): void {
    this.life.fence();
    if (this.timer) clearTimeout(this.timer);
  }
  async whenAdmissionsIdle(): Promise<void> {
    await this.life.whenIdle();
    if (this.reconciling) await this.reconciling.catch(() => undefined);
  }
  async stop(requestId: string, signal?: AbortSignal) {
    this.life.fence();
    if (this.timer) clearTimeout(this.timer);
    const command = this.options.protocol.workflowStop(requestId, this.control(), signal);
    // Actual local cleanup remains alive if the UI wait or current auth fails.
    const draining = this.close();
    void draining.catch(() => undefined);
    const remote = await command;
    this.remote = remote;
    return this.view();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.life.fence();
    if (this.timer) clearTimeout(this.timer);
    this.closing = this.life
      .close(async () => {
        if (this.reconciling) await this.reconciling.catch(() => undefined);
        if (this.pending && !this.pending.run && !this.pending.recovered)
          await this.observePending();
        const settled = this.pending ? await this.retire(this.pending) : undefined;
        // Joining admissions is not proof that native physical sources settled.
        if (this.pending) {
          for (;;) {
            const run = this.pending.run ?? this.pending.recovered;
            if (!run) throw new NativeWorkError('unavailable');
            const value = settled
              ? { remote: settled }
              : this.pending.kind === 'work'
                ? this.options.native.read(run as MemberLocalReadHandle)
                : this.options.native.readReview(run as MemberLocalReviewReadHandle);
            // Fresh business authentication may already be closed. Settlement
            // still comes only from the original owner's actual cleanup reply.
            if (value.remote.resources === 'settled') {
              const actual = value.remote,
                original = run.value;
              if (actual.scope && original.scope) {
                if (!same(actual.scope, original.scope) || actual.deviceId !== original.deviceId)
                  throw new NativeWorkError('scope-mismatch');
                this.settledScopes.add(
                  key({ kind: this.pending.kind, scope: actual.scope, deviceId: actual.deviceId }),
                );
              }
              await this.options.protocol.forgetWorkflowAccept(
                this.pending.candidate,
                original.scope,
                this.cleanup.signal,
              );
              delete this.pending;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      })
      .then(() => {
        this.cleanup.abort();
      });
    return this.closing;
  }
  canSwitchBackend(): boolean {
    const retired = (
      kind: 'work' | 'review',
      value: { resources: string; scope: unknown; deviceId: string },
    ) =>
      value.resources === 'settled' ||
      (!!value.scope &&
        !!value.deviceId &&
        this.settledScopes.has(key({ kind, scope: value.scope, deviceId: value.deviceId })));
    return (
      this.life.canSwitchBackend() &&
      !this.pending &&
      !this.pumping &&
      !this.reconciling &&
      (this.remote?.activeWork ?? []).every((value) => retired('work', value)) &&
      (this.remote?.activeReviews ?? []).every((value) => retired('review', value))
    );
  }
}
