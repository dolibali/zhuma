import type { Context } from '@deepseek-ai/cordis';
import type { ExecutionResourceTool } from './execution-run-resource-snapshot.js';
import type { ExecutionResult, ExecutionService } from './execution-service.js';
import type { ExecutionReviewDriveGrant } from './execution-review-drive-authority.js';
import type { FrozenExecutionReviewComposition } from './execution-review-composition.js';
import type { ExecutionReviewScope } from './execution-review-contract.js';
import type { WorkflowExecutionClaim, WorkflowRunDefaults } from './execution-workflow-contract.js';
import type { WorkflowReviewCandidate } from './execution-workflow-reviews.js';
import type { MemberRequest } from './member-session.js';
import type {
  NativeSessionBinding,
  NativeWorkGrant,
  NativeWorkRuntime,
  NativeScopeCleanupResult,
} from './native-work-session-contract.js';
import type { NativeDshComposition } from './native-work-session-dsh.js';
import type { NativeReviewPorts } from './native-work-session-purpose.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  executionReviewCompositionRequest,
  readExecutionReviewComposition,
} from './execution-review-composition.js';
import { readExecutionReviewState } from './execution-review-state.js';
import { executionResourceToolNames } from './execution-run-resource-snapshot.js';
import { nativeReviewContextFromScope } from './native-work-session-review-contract.js';
import {
  nativeFixedReviewIssuer,
  type NativeFixedReviewIssuer,
} from './native-work-session-result.js';
import {
  observeNativeReview,
  type NativeReviewMessageClaim,
} from './native-work-session-review-observation.js';
import type { OpenedExecutionReviewDrive } from './execution-review-drive-authority.js';
import { NATIVE_REVIEW_LIMITS } from './native-work-session-review-contract.js';
import {
  retainNativeReviewResources,
  type NativeReviewResourceClosure,
} from './native-work-session-review-closure.js';

/** A installs resources in the same unpublished SDK Agent scope. These fields
 * bind the live adoption; their copied metadata alone never grants authority. */
export interface NativeReviewBridgeAdoption {
  readonly scope: ExecutionReviewScope;
  readonly configurationId: string;
  /** Continuous authority only; normal registration disposal must not abort it. */
  readonly signal: AbortSignal;
  readonly context: string;
  readonly toolAllowlist: readonly string[];
  readonly descriptors: readonly ExecutionResourceTool[];
  readonly ready: Promise<void>;
  assertCurrent(): undefined;
  drain(): Promise<void>;
  dispose(): Promise<void>;
}

/** Host-only callbacks over A's original model/resource producers. */
export interface NativeReviewBridgeHostPorts {
  prepareReview(
    original: MemberRequest,
    input: WorkflowReviewCandidate & { readonly model: WorkflowRunDefaults['model'] },
    wait: AbortSignal,
  ): Promise<FrozenExecutionReviewComposition>;
  adoptReviewResources(
    ctx: Context,
    input: {
      readonly original: MemberRequest;
      readonly composition: FrozenExecutionReviewComposition;
      readonly drive: ExecutionReviewDriveGrant;
      readonly binding: NativeSessionBinding;
      readonly grant: NativeWorkGrant;
    },
  ): Promise<NativeReviewBridgeAdoption>;
}

export interface NativeReviewBridge {
  /** Pure cached ownership observation; never closes or probes native IO. */
  canSwitchBackend(): boolean;
  readonly reviewPorts: NativeReviewPorts;
  /** Once, after A creates its original result owner, before consuming claims. */
  bindNative(service: NativeWorkSessionService, runtime: NativeWorkRuntime): void;
  /** Schedules bounded work; never holds the original claim/wakeup on a model. */
  consumeClaim(original: MemberRequest, claim: WorkflowExecutionClaim): void;
  compose(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): Promise<NativeDshComposition>;
  fence(): void;
  /** A must retain the original C owner when cleanup is pending or rejected. */
  closeBeforeNative(wait?: AbortSignal): Promise<{ readonly status: 'pending' | 'settled' }>;
  recoverStopped(
    scope: ExecutionReviewScope,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<{ status: 'pending' | 'settled' }>>;
  /** Explicit test/Host drain of already owned work, never a readiness claim. */
  whenIdle(): Promise<void>;
}

export interface NativeReviewBridgeOptions {
  readonly execution: ExecutionService;
  readonly host: NativeReviewBridgeHostPorts;
  readonly signal: AbortSignal;
}

export class NativeReviewBridgeError extends Error {
  constructor(
    readonly code:
      | 'review-bridge-unavailable'
      | 'review-bridge-capacity'
      | 'review-bridge-pending'
      | 'review-bridge-recovery-required',
  ) {
    super('原生评审尚未完成，请查看当前任务状态。');
    this.name = 'NativeReviewBridgeError';
  }
}
interface OwnedReview {
  readonly original: MemberRequest;
  readonly claim: WorkflowExecutionClaim;
  readonly candidate: WorkflowReviewCandidate;
  readonly abort: AbortController;
  composition?: FrozenExecutionReviewComposition;
  drive?: OpenedExecutionReviewDrive;
  grant?: NativeWorkGrant;
  binding?: NativeSessionBinding;
  receipt?: { readonly messageId: string };
  observation?: ReturnType<typeof observeNativeReview>;
  adoption?: NativeReviewBridgeAdoption;
  adopting?: Promise<NativeReviewBridgeAdoption>;
  resources?: NativeReviewResourceClosure;
  resourceClosing?: Promise<void>;
  removeRevocation?: () => void;
  accepted: boolean;
  events: Promise<void>;
  resultJob?: Promise<void>;
  resultDirty: boolean;
  cleanupJob?: Promise<boolean>;
  settled: boolean;
  reserved: boolean;
  released: boolean;
  starting: boolean;
  accepting?: Promise<void>;
  releasing?: Promise<void>;
}
const owners = new WeakSet<ExecutionService>();
const failure = (): never => {
  throw new NativeReviewBridgeError('review-bridge-unavailable');
};
function checked<T>(result: ExecutionResult<T>): T {
  if (!result.ok) return failure();
  return result.value;
}
function sync(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => undefined);
    failure();
  }
}

/** The original workflow wakeup supplies genuine claims. This owner retains
 * only bounded in-flight correlation, never another queue/Run/history store. */
export function createNativeReviewBridge(options: NativeReviewBridgeOptions): NativeReviewBridge {
  const { execution, host, signal } = options;
  const prepareHost = host.prepareReview,
    adoptHost = host.adoptReviewResources;
  if (owners.has(execution)) return failure();
  owners.add(execution);
  const states = new Map<string, OwnedReview>();
  const seen = new Set<string>();
  const byGrant = new WeakMap<NativeWorkGrant, OwnedReview>();
  const jobs = new Set<Promise<unknown>>();
  const cleanupWait = new AbortController();
  let native:
    | {
        service: NativeWorkSessionService;
        runtime: NativeWorkRuntime;
        issuer: NativeFixedReviewIssuer;
      }
    | undefined;
  let unsubscribeReady: (() => void) | undefined;
  let fenced = false;
  let cleanupSealed = false;
  let closing: Promise<{ readonly status: 'pending' | 'settled' }> | undefined;
  function own<T>(job: Promise<T>): Promise<T> {
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => undefined);
    return job;
  }
  const bound = () => native ?? failure();
  function current(state: OwnedReview) {
    if (fenced || signal.aborted || state.abort.signal.aborted || state.released) return failure();
    sync(state.claim.check());
    if (state.drive) execution.assertExpertReviewDriveGrant(state.drive.grant, 'send');
  }
  function facts(state: OwnedReview) {
    if (!state.drive) return failure();
    const scope = state.drive.grant.scope;
    const node = execution.readRunNode(scope);
    const attempt =
      node &&
      readExecutionReviewState(node)?.attempts.find((item) => item.scope.runId === scope.runId);
    if (
      !attempt ||
      attempt.status === 'prepared' ||
      canonicalPayload(attempt.scope) !== canonicalPayload(scope)
    )
      return failure();
    if (host.prepareReview !== prepareHost || host.adoptReviewResources !== adoptHost)
      return failure();
    return { scope, attempt };
  }
  function closeResources(state: OwnedReview): Promise<void> {
    if (state.resourceClosing) return state.resourceClosing;
    const work = own(
      Promise.resolve().then(async () => {
        // Opening and closing keep the same original obligation even if the
        // caller stopped waiting. A failed open has no invented empty handle.
        if (state.adopting) await state.adopting;
        if (state.resources) {
          await state.resources.close();
          state.resources.assertClosed();
        }
      }),
    );
    state.resourceClosing = work;
    void work.then(() => scheduleResult(state)).catch(() => undefined);
    return work;
  }
  async function waitOwned(work: Promise<void>, wait: AbortSignal): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop!: () => void;
    try {
      return await Promise.race([
        work.then(() => true),
        new Promise<false>((resolve) => {
          stop = () => resolve(false);
          timer = setTimeout(stop, NATIVE_REVIEW_LIMITS.waitMs);
          wait.addEventListener('abort', stop, { once: true });
          if (wait.aborted) stop();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      wait.removeEventListener('abort', stop);
    }
  }
  function resultState(grant: NativeWorkGrant): OwnedReview {
    const issuer = bound().issuer;
    // This view authenticates the original grant before consulting a phase.
    const phase = issuer.reviewCollectionPhase?.(grant) ?? failure();
    const state = byGrant.get(grant) ?? failure();
    current(state);
    const resources = state.resources ?? failure();
    if (phase === 'unstarted') resources.assertLive();
    else resources.assertAuthority();
    current(state);
    return state;
  }
  function retainedReview(scope: ExecutionReviewScope, requestId: string): OwnedReview | undefined {
    return [...states.values()].find((state) => {
      const known = state.drive?.grant.scope ?? state.composition?.payload.scope;
      if (known) return canonicalPayload(known) === canonicalPayload(scope);
      return (
        state.candidate.requestId === requestId &&
        state.claim.view.intent?.actorId === scope.actorId &&
        canonicalPayload(state.candidate.target) === canonicalPayload(scope.review.target) &&
        state.candidate.reviewerRef.id === scope.review.principal.reviewerRef.id &&
        state.candidate.reviewerRef.version === scope.review.principal.reviewerRef.version
      );
    });
  }
  function preparingReview(state: OwnedReview, scope: ExecutionReviewScope): boolean {
    const known = state.drive?.grant.scope ?? state.composition?.payload.scope;
    // A retained start without a drive is not a cold process or an empty resource scope.
    return (
      !known ||
      canonicalPayload(known) !== canonicalPayload(scope) ||
      (state.starting && !state.adopting)
    );
  }
  async function retireWithResources(
    original: Parameters<ExecutionService['assertExpertReviewCleanupAuthority']>[0],
    wait: AbortSignal,
  ): Promise<NativeScopeCleanupResult> {
    // Cleanup authority is checked before reading its purported scope. It does
    // not acquire a new driving/member/phase qualification after revocation.
    execution.assertExpertReviewCleanupAuthority(original);
    const node = execution.readRunNode(original.scope),
      requestId =
        node &&
        readExecutionReviewState(node)?.receipts.find(
          (receipt) => receipt.runId === original.scope.runId,
        )?.requestId;
    if (!requestId) return failure();
    // This immutable receipt identity correlates ownership; it grants no new
    // operation and does not cache member/source/drain authorization.
    let state = retainedReview(original.scope, requestId);
    if (state && preparingReview(state, original.scope)) return { status: 'pending' };
    const retired = await bound().service.retireReviewForCleanup(original, wait);
    if (retired.status === 'pending') return retired;
    // A cold owner still needs the original C binding and physical retirement.
    // Recheck retained starts after that await before qualifying any resource barrier.
    state = retainedReview(original.scope, requestId);
    if (state) {
      if (preparingReview(state, original.scope)) return { status: 'pending' };
      if (!(await waitOwned(closeResources(state), wait))) return { status: 'pending' };
      state.resources?.assertClosed();
    }
    const raw = retired.drain,
      assert = raw.assertCurrent,
      signal = raw.signal;
    const drain = Object.freeze({
      basis: raw.basis,
      signal,
      assertCurrent() {
        if (raw.assertCurrent !== assert || raw.signal !== signal) return failure();
        assert.call(raw);
        const retained = retainedReview(original.scope, requestId);
        if (retained && retained !== state) return failure();
        state?.resources?.assertClosed();
      },
    });
    drain.assertCurrent();
    return { ...retired, drain };
  }
  function release(state: OwnedReview): Promise<void> {
    if (state.released) return Promise.resolve();
    if (state.releasing) return state.releasing;
    const work = Promise.resolve().then(async () => {
      // A failed resource disposal remains retained and prevents false close success.
      await closeResources(state);
      state.observation?.close();
      state.removeRevocation?.();
      state.drive?.dispose();
      state.released = true;
      state.abort.abort();
      states.delete(state.candidate.requestId);
    });
    state.releasing = work;
    void work
      .finally(() => {
        delete state.releasing;
      })
      .catch(() => undefined);
    return work;
  }
  function cleanup(state: OwnedReview): Promise<boolean> {
    if (state.released) return Promise.resolve(true);
    if (state.starting) return Promise.resolve(false);
    if (state.cleanupJob) return state.cleanupJob;
    const job = own(
      Promise.resolve()
        .then(async () => {
          if (!state.drive) {
            if (state.reserved) {
              const snapshot = state.composition;
              if (
                !state.claim.signal.aborted ||
                !snapshot ||
                state.grant ||
                state.adopting ||
                state.adoption ||
                state.resources ||
                state.binding ||
                state.receipt ||
                state.observation
              )
                return false;
              const scope = snapshot.payload.scope,
                node = execution.readRunNode(scope),
                review = node && readExecutionReviewState(node),
                attempt = review?.attempts.find((item) => item.scope.runId === scope.runId),
                receipt = review?.receipts.find(
                  (item) => item.requestId === state.candidate.requestId,
                );
              if (
                !attempt ||
                attempt.status !== 'prepared' ||
                attempt.version !== 1 ||
                attempt.dispatch !== 'reserved' ||
                attempt.resources !== 'held' ||
                Object.hasOwn(attempt, 'composition') ||
                Object.hasOwn(attempt, 'nativeSessionId') ||
                Object.hasOwn(attempt, 'nativeAgentId') ||
                node?.ownerId !== scope.actorId ||
                scope.actorId !== state.claim.view.intent?.actorId ||
                canonicalPayload(attempt.scope) !== canonicalPayload(scope) ||
                attempt.configurationId !== snapshot.configurationId ||
                receipt?.runId !== scope.runId ||
                canonicalPayload(state.candidate.target) !== canonicalPayload(scope.review.target)
              )
                return false;
              // Release process-local metadata only. D's Stop/queue proof gates
              // a new generation; this neither changes the marker nor proves drain.
            }
            await release(state);
            return true;
          }
          const result = await execution.retireExpertReviewForCleanup(
            state.drive.cleanup,
            cleanupWait.signal,
          );
          if (!result.ok || result.value.status !== 'settled') return false;
          execution.assertExpertReviewDrained(state.drive.grant.scope);
          state.settled = true;
          await release(state);
          return true;
        })
        .catch(() => false),
    );
    state.cleanupJob = job;
    void job
      .finally(() => {
        delete state.cleanupJob;
      })
      .catch(() => undefined);
    return job;
  }
  function event(state: OwnedReview, kind: 'received' | 'accepted' | 'idle') {
    const job = state.events.then(async () => {
      current(state);
      const { scope, attempt } = facts(state),
        binding = state.binding ?? failure();
      const result = checked(
        await execution.recordNativeReviewEvent(state.drive!.grant, {
          scope,
          sequence: attempt.lastEventSequence + 1,
          kind,
          ...(kind === 'idle'
            ? {}
            : { nativeSessionId: binding.nativeSessionId, nativeAgentId: binding.nativeAgentId }),
        }),
      );
      if (kind === 'accepted') {
        if (result.attempt.status !== 'running') return failure();
        state.accepted = true;
      }
    });
    state.events = job;
    own(job);
    return job;
  }
  function accepted(state: OwnedReview, claim: NativeReviewMessageClaim) {
    if (!state.receipt || !state.binding || state.accepted || state.accepting || state.released)
      return;
    if (
      claim.messageId !== state.receipt.messageId ||
      claim.nativeSessionId !== state.binding.nativeSessionId ||
      claim.nativeAgentId !== state.binding.nativeAgentId
    )
      return;
    state.accepting = own(
      event(state, 'accepted')
        .then(() => scheduleResult(state))
        .catch(async () => {
          await cleanup(state);
        }),
    );
    void state.accepting
      .finally(() => {
        delete state.accepting;
      })
      .catch(() => undefined);
  }
  function scheduleResult(state: OwnedReview) {
    if (state.released || fenced) return;
    state.resultDirty = true;
    if (state.resultJob) return;
    const job = own(
      Promise.resolve()
        .then(async () => {
          state.resultDirty = false;
          await state.events;
          if (!state.accepted || !state.drive || !state.grant) return;
          current(state);
          const { scope } = facts(state);
          const command = {
            spaceId: scope.spaceId,
            taskId: scope.taskId,
            planId: scope.planId,
            revision: scope.revision,
            nodeId: scope.nodeId,
            runId: scope.runId,
            requestId: `${state.candidate.requestId}:result`,
          };
          let submitted = await execution.submitNativeFixedReview(
            state.original,
            command,
            state.drive.grant,
            state.abort.signal,
          );
          if (!submitted.ok) {
            // A durable ballot may precede a lost reply/outbox failure. Only
            // the original D receipt qualifies this one bounded historical
            // retry; it cannot read C again or resend the model.
            const history = await execution.confirmNativeFixedReview(state.original, command);
            if (history.ok && history.value.status === 'confirmed') {
              submitted = await execution.submitNativeFixedReview(
                state.original,
                command,
                state.drive.grant,
              );
            }
          }
          const outcome = checked(submitted);
          if (outcome.status === 'pending') return;
          // Completion/attention may revoke driving before this continuation runs.
          // Only D's actual cleanup view can release this retained scope.
          if (outcome.cleanup === 'settled') {
            execution.assertExpertReviewDrained(scope);
            state.settled = true;
            await release(state);
          } else await cleanup(state);
        })
        .catch(async () => {
          await cleanup(state);
        }),
    );
    state.resultJob = job;
    void job
      .finally(() => {
        delete state.resultJob;
        if (state.resultDirty && !state.released && !fenced) scheduleResult(state);
      })
      .catch(() => undefined);
  }
  async function start(state: OwnedReview) {
    let failed = false;
    try {
      current(state);
      const model = state.claim.view.intent?.defaults.model ?? failure();
      const snapshot = readExecutionReviewComposition(
        await host.prepareReview(state.original, { ...state.candidate, model }, state.abort.signal),
      );
      current(state);
      state.composition = snapshot;
      const prepared = checked(
        await execution.prepareExpertReview(
          state.original,
          {
            ...state.candidate,
            configurationId: snapshot.configurationId,
          },
          state.claim,
        ),
      );
      state.reserved = true;
      seen.add(state.candidate.requestId);
      // An unknown pre-existing reservation is not permission to resend a model.
      if (prepared.disposition !== 'applied') return;
      current(state);
      const scope = prepared.attempt.scope;
      const locator = {
        spaceId: scope.spaceId,
        taskId: scope.taskId,
        planId: scope.planId,
        revision: scope.revision,
        nodeId: scope.nodeId,
        runId: scope.runId,
      };
      const admitted = checked(
        await execution.admitExpertReview(state.original, {
          ...locator,
          expectedAttemptVersion: prepared.attempt.version,
          composition: snapshot,
        }),
      );
      if (admitted.disposition !== 'applied') return;
      current(state);
      state.drive = checked(await execution.openExpertReviewDrive(state.original, locator));
      const revoke = () => {
        void cleanup(state);
      };
      state.drive.grant.signal.addEventListener('abort', revoke, { once: true });
      state.removeRevocation = () => state.drive?.grant.signal.removeEventListener('abort', revoke);
      current(state);
      state.grant = bound().service.reviewGrant(state.drive.grant);
      byGrant.set(state.grant, state);
      const projected = executionReviewCompositionRequest(snapshot);
      const receipt = await bound().service.send(state.grant, {
        requestId: state.candidate.requestId,
        text: projected.firstMessage.text,
        mode: projected.firstMessage.mode,
        selection: projected.selection,
      });
      current(state);
      state.binding = bound().service.readBinding(state.grant) ?? failure();
      if (
        !['received', 'claimed'].includes(receipt.status) ||
        receipt.fingerprint !== projected.firstMessage.inputFingerprint
      )
        return failure();
      state.receipt = receipt;
      await event(state, 'received');
      const claim = state.observation?.claimFor(receipt.messageId);
      if (claim) accepted(state, claim);
      // Subscribe at bindNative first, then one original-owner probe. This
      // closes an early-ready edge without polling or replaying all history.
      scheduleResult(state);
    } catch {
      failed = true;
    } finally {
      state.starting = false;
      if (failed || state.abort.signal.aborted || fenced) await cleanup(state);
    }
  }
  const reviewPorts: NativeReviewPorts = {
    authorize(original, action) {
      execution.assertExpertReviewDriveGrant(original as ExecutionReviewDriveGrant, action);
      const grant = original as ExecutionReviewDriveGrant;
      return { scope: grant.scope, selection: grant.selection, signal: grant.signal };
    },
    authorizeCleanup(original) {
      execution.assertExpertReviewCleanupAuthority(
        original as Parameters<ExecutionService['assertExpertReviewCleanupAuthority']>[0],
      );
      return (original as Parameters<ExecutionService['assertExpertReviewCleanupAuthority']>[0])
        .scope;
    },
    unavailableRequired(original) {
      execution.assertExpertReviewDriveGrant(original as ExecutionReviewDriveGrant, 'send');
      return execution
        .listExpertReviewResources(original as ExecutionReviewDriveGrant)
        .filter((item) => item.kind === 'external-reference')
        .map(({ resourceRef }) => ({ resourceRef, code: 'review-unsupported-material' as const }));
    },
    async readTarget(original, query, wait) {
      execution.assertExpertReviewDriveGrant(original as ExecutionReviewDriveGrant, 'send');
      const actual = await execution.readExpertReviewResource(
        original as ExecutionReviewDriveGrant,
        query,
        wait,
      );
      try {
        const grant = bound().service.reviewGrant(original),
          binding = bound().service.readBinding(grant) ?? failure();
        return {
          source: {
            context: nativeReviewContextFromScope(actual.scope),
            nativeSessionId: binding.nativeSessionId,
            nativeAgentId: binding.nativeAgentId,
            configurationId: binding.selection.configurationId,
            resourceRef: actual.resource.resourceRef,
            resourceFingerprint: actual.resource.resourceFingerprint,
          },
          bytes: actual.bytes,
          range: actual.range,
          encoding: actual.encoding,
          signal: actual.signal,
          check: () => actual.check(),
          release: () => actual.release(),
        };
      } catch (error) {
        actual.release();
        throw error;
      }
    },
  };
  const bridge: NativeReviewBridge = {
    canSwitchBackend() {
      return (
        !closing &&
        !jobs.size &&
        [...states.values()].every(
          (state) =>
            state.settled &&
            state.released &&
            !state.starting &&
            !state.accepting &&
            !state.resultJob &&
            !state.cleanupJob &&
            !state.resourceClosing &&
            !state.releasing,
        )
      );
    },
    reviewPorts,
    bindNative(service, runtime) {
      if (native || fenced || !service.ownsResultRuntime(runtime)) return failure();
      const issuer = nativeFixedReviewIssuer(service, runtime);
      if (
        typeof issuer.onReviewReady !== 'function' ||
        typeof issuer.reviewCollectionPhase !== 'function'
      )
        return failure();
      native = { service, runtime, issuer };
      unsubscribeReady = issuer.onReviewReady((grant) => {
        const state = byGrant.get(grant);
        if (state) scheduleResult(state);
      });
      const qualified: NativeFixedReviewIssuer = Object.freeze<NativeFixedReviewIssuer>({
        registerNativeReviewTools: issuer.registerNativeReviewTools,
        async prepareFixedReview(grant, wait) {
          const state = resultState(grant);
          const prepared = await issuer.prepareFixedReview(grant, wait);
          if (prepared.status === 'pending') {
            resultState(grant);
            return prepared;
          }
          resultState(grant);
          if (!(await waitOwned(closeResources(state), wait)))
            return { status: 'pending', reason: 'draining' };
          state.resources!.assertClosed();
          resultState(grant);
          issuer.assertFixedReview(grant, prepared.ref);
          return prepared;
        },
        assertFixedReview(grant, ref) {
          issuer.assertFixedReview(grant, ref);
          resultState(grant).resources!.assertClosed();
          return undefined;
        },
        async readFixedReview(grant, ref, wait) {
          qualified.assertFixedReview(grant, ref);
          const lease = await issuer.readFixedReview(grant, ref, wait);
          const check = lease.check,
            release = lease.release,
            sourceSignal = lease.signal;
          try {
            qualified.assertFixedReview(grant, ref);
            const state = resultState(grant);
            return Object.freeze({
              ...lease,
              signal: AbortSignal.any([sourceSignal, state.adoption!.signal]),
              check() {
                if (
                  lease.check !== check ||
                  lease.release !== release ||
                  lease.signal !== sourceSignal
                )
                  return failure();
                qualified.assertFixedReview(grant, ref);
                check.call(lease);
              },
              release() {
                release.call(lease);
              },
            });
          } catch (error) {
            release.call(lease);
            throw error;
          }
        },
      });
      execution.installNativeReviewPorts({
        issuer: qualified,
        grantFor: (original) => service.reviewGrant(original),
        retireForCleanup: retireWithResources,
      });
    },
    consumeClaim(original, claim) {
      if (fenced || signal.aborted) return failure();
      bound();
      sync(execution.assertWorkflowExecutionClaim(original, claim));
      if (
        claim.signal.aborted ||
        claim.view.state !== 'running' ||
        claim.view.requiresResume ||
        !claim.view.intent
      )
        return;
      const candidates = claim.reviewCandidates ?? [];
      if (candidates.length > 4 || seen.size >= 4096)
        throw new NativeReviewBridgeError('review-bridge-capacity');
      for (const candidate of candidates) {
        if (seen.has(candidate.requestId) || states.has(candidate.requestId)) continue;
        if (states.size >= 64) throw new NativeReviewBridgeError('review-bridge-capacity');
        const state: OwnedReview = {
          original,
          claim,
          candidate: structuredClone(candidate),
          abort: new AbortController(),
          accepted: false,
          events: Promise.resolve(),
          resultDirty: false,
          settled: false,
          reserved: false,
          released: false,
          starting: true,
        };
        const abort = () => {
          state.abort.abort();
          void cleanup(state);
        };
        claim.signal.addEventListener('abort', abort, { once: true });
        state.abort.signal.addEventListener(
          'abort',
          () => claim.signal.removeEventListener('abort', abort),
          { once: true },
        );
        states.set(candidate.requestId, state);
        own(start(state));
      }
      for (const state of states.values()) {
        if (state.drive?.grant.signal.aborted) void cleanup(state);
      }
    },
    async compose(ctx, binding, grant) {
      const state = byGrant.get(grant) ?? failure();
      current(state);
      const snapshot = state.composition ?? failure(),
        drive = state.drive?.grant ?? failure();
      if (
        canonicalPayload(bound().service.reviewContext(grant)) !==
        canonicalPayload(nativeReviewContextFromScope(drive.scope))
      )
        return failure();
      if (canonicalPayload(binding.selection) !== canonicalPayload(drive.selection))
        return failure();
      state.binding = binding;
      state.observation?.close();
      state.observation = observeNativeReview(ctx, binding, grant, {
        claim: (value) => accepted(state, value),
        idle: () => {
          if (state.accepted) {
            own(
              event(state, 'idle')
                .then(() => scheduleResult(state))
                .catch(() => cleanup(state)),
            );
          } else scheduleResult(state);
        },
        fault: (kind) => {
          if (kind === 'error') void cleanup(state);
          else scheduleResult(state);
        },
      });
      const registered = bound().issuer.registerNativeReviewTools(ctx, binding, grant, () => {
        current(state);
        (state.resources ?? failure()).assertLive();
        current(state);
        return undefined;
      });
      if (state.adopting) return failure();
      state.adopting = Promise.resolve().then(async () => {
        const adopted = await host.adoptReviewResources(ctx, {
          original: state.original,
          composition: snapshot,
          drive,
          binding,
          grant,
        });
        state.resources = retainNativeReviewResources(
          adopted,
          drive.scope,
          snapshot.configurationId,
        );
        state.adoption = adopted;
        return adopted;
      });
      const adopted = await state.adopting;
      const sourceSignal = adopted.signal,
        sourceAssert = adopted.assertCurrent,
        sourceReady = adopted.ready,
        sourceDrain = adopted.drain,
        sourceDispose = adopted.dispose;
      if (
        !(sourceSignal instanceof AbortSignal) ||
        typeof sourceAssert !== 'function' ||
        !sourceReady ||
        typeof sourceReady.then !== 'function' ||
        typeof sourceDrain !== 'function' ||
        typeof sourceDispose !== 'function'
      )
        return failure();
      const validate = () => {
        current(state);
        state.resources!.assertLive();
        if (
          adopted.signal !== sourceSignal ||
          sourceSignal.aborted ||
          adopted.assertCurrent !== sourceAssert ||
          adopted.ready !== sourceReady ||
          adopted.drain !== sourceDrain ||
          adopted.dispose !== sourceDispose ||
          canonicalPayload(adopted.scope) !== canonicalPayload(drive.scope) ||
          adopted.configurationId !== snapshot.configurationId
        )
          return failure();
        sync(sourceAssert.call(adopted));
        if (sourceSignal.aborted) return failure();
        current(state);
      };
      validate();
      await sourceReady;
      validate();
      const expected = executionResourceToolNames(snapshot.payload.resources);
      if (
        canonicalPayload(adopted.toolAllowlist) !== canonicalPayload(expected) ||
        canonicalPayload(adopted.descriptors.map((tool) => tool.name)) !==
          canonicalPayload(expected)
      )
        return failure();
      const tools = [...registered.toolAllowlist, ...adopted.toolAllowlist];
      if (canonicalPayload(tools) !== canonicalPayload(snapshot.payload.toolAllowlist))
        return failure();
      const revoked = () => {
        void cleanup(state);
      };
      adopted.signal.addEventListener('abort', revoked, { once: true });
      validate();
      ctx.effect(() => () => adopted.signal.removeEventListener('abort', revoked));
      return {
        context: `${executionReviewCompositionRequest(snapshot).context}\n${registered.context}\n${adopted.context}`,
        toolAllowlist: tools,
      };
    },
    fence() {
      if (fenced) return;
      fenced = true;
      unsubscribeReady?.();
      for (const state of states.values()) {
        state.abort.abort();
        void cleanup(state);
      }
    },
    closeBeforeNative(wait = cleanupWait.signal) {
      bridge.fence();
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          await bridge.whenIdle();
          const results = await Promise.all([...states.values()].map(cleanup));
          if (results.some((result) => !result) || states.size || jobs.size)
            return { status: 'pending' as const };
          cleanupSealed = true;
          signal.removeEventListener('abort', abort);
          return { status: 'settled' as const };
        });
        void closing
          .finally(() => {
            closing = undefined;
          })
          .catch(() => undefined);
      }
      if (wait.aborted) return Promise.resolve({ status: 'pending' as const });
      const owned = closing;
      return new Promise((resolve, reject) => {
        const stop = () => {
          wait.removeEventListener('abort', stop);
          resolve({ status: 'pending' });
        };
        wait.addEventListener('abort', stop, { once: true });
        void owned.then(
          (result) => {
            wait.removeEventListener('abort', stop);
            resolve(result);
          },
          (error: unknown) => {
            wait.removeEventListener('abort', stop);
            reject(error);
          },
        );
      });
    },
    recoverStopped(scope, wait = cleanupWait.signal) {
      bound();
      if (cleanupSealed)
        return Promise.resolve({
          ok: false,
          error: {
            code: 'review-bridge-unavailable',
            message: '原生评审清理入口已关闭。',
            details: {},
          },
        });
      // Only D's committed Stop and original cleanup capability authorize recovery.
      // Missing in-memory correlation is neither a refusal nor a drain certificate.
      return own(
        execution.recoverStoppedWorkflowReviewCleanup(scope, wait).then(async (result) => {
          if (result.ok && result.value.status === 'settled') {
            execution.assertExpertReviewDrained(scope);
            for (const state of states.values()) {
              if (
                state.drive &&
                canonicalPayload(state.drive.grant.scope) === canonicalPayload(scope)
              ) {
                state.settled = true;
                await release(state);
              }
            }
          }
          return result;
        }),
      );
    },
    async whenIdle() {
      while (jobs.size) await Promise.allSettled([...jobs]);
    },
  };
  const abort = () => bridge.fence();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return bridge;
}
