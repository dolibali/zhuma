import { canonicalPayload } from '@zhuma/agent-core';
import type { ExecutionResult, ExecutionService, StopRunRequest } from './execution-service.js';
import type { MemberRequest } from './member-session.js';
import { readExecutionRunState } from './execution-run-state.js';
import {
  WORKFLOW_EXECUTION_LIMITS,
  workflowControlSchema,
  type WorkflowExecutionClaim,
  type WorkflowExecutionView,
  type WorkflowLocation,
  type WorkflowStartTicket,
} from './execution-workflow-contract.js';

/** A supplies this private port over its ORIGINAL Run owner. Never expose tickets in JSON. */
export interface NativeWorkflowRunPort {
  beginWorkflowRun(
    original: MemberRequest,
    ticket: WorkflowStartTicket,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
  stop(
    original: MemberRequest,
    command: StopRunRequest,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
}

type Execution = Pick<
  ExecutionService,
  'claimWorkflowExecution' | 'readWorkflowExecution' | 'stopWorkflowExecution' | 'readRunNode'
>;
interface Arm {
  readonly key: string;
  readonly original: MemberRequest;
  readonly location: WorkflowLocation;
  readonly intentId: string;
  readonly generation: number;
  readonly seen: Set<string>;
  readonly tickets: Set<WorkflowStartTicket>;
  readonly starts: Set<Promise<void>>;
  attached: Promise<void>;
  claim?: WorkflowExecutionClaim;
  unsubscribe?: () => void;
  stopAbort?: () => void;
  pumping?: Promise<void>;
  dirty: boolean;
  fenced: boolean;
}
class BridgeError extends Error {
  constructor(readonly code: string) {
    super('工作流原生执行桥操作未完成。');
    this.name = 'NativeWorkflowBridgeError';
  }
}
const failure = (code: string): ExecutionResult<never> => ({
  ok: false,
  error: { code, message: '工作流原生执行操作未完成。', details: {} },
});
const locationKey = (location: WorkflowLocation) => canonicalPayload(location);
const armKey = (view: WorkflowExecutionView) =>
  canonicalPayload({
    location: view.location,
    intentId: view.intent?.intentId,
    generation: view.intent?.generation,
  });
const busy = (result: ExecutionResult<unknown>) =>
  !result.ok && ['run-workspace-busy', 'run-capacity'].includes(result.error.code);
const owners = new WeakMap<Execution, object>();

/** Event-driven admission only. D owns facts/tickets/queue; A owns Agents, events and drain. */
export function createNativeWorkflowBridge(options: {
  readonly execution: Execution;
  readonly runs: NativeWorkflowRunPort;
  readonly signal: AbortSignal;
  /** Same genuine claim, forwarded by A to the original independent review owner. */
  readonly consumeClaim?: (original: MemberRequest, claim: WorkflowExecutionClaim) => void;
}) {
  const { execution, runs, signal, consumeClaim } = options;
  if (owners.has(execution)) throw new BridgeError('workflow-owner-unavailable');
  const identity = {};
  owners.set(execution, identity);
  const lifetime = new AbortController();
  const arms = new Map<string, Arm>();
  const jobs = new Set<Promise<unknown>>();
  const drains = new Map<string, Promise<ExecutionResult<WorkflowExecutionView>>>();
  const errors = new Map<string, BridgeError>();
  // Only obligations observed from the original loaded workflow views. This
  // is a lifecycle fence, never another plan/Run authority or persistence store.
  const obligations = new Map<string, { location: string; intentId: string; generation: number }>();
  let controls = 0;
  let fenced = false;
  let closing: Promise<void> | undefined;
  function cleanupFailure(code: string) {
    if (!errors.has(code)) errors.set(code, new BridgeError(code));
  }
  function remember(view: WorkflowExecutionView): void {
    if (!view.intent) return;
    const location = locationKey(view.location),
      intent = view.intent;
    for (const [key, old] of obligations) {
      if (
        old.location === location &&
        old.intentId === intent.intentId &&
        old.generation <= intent.generation
      )
        obligations.delete(key);
    }
    if (
      view.activeRunIds.length ||
      view.reviewResources?.some((review) => review.resources !== 'settled') ||
      !['paused', 'completed'].includes(view.state) ||
      !['paused', 'completed'].includes(intent.status)
    ) {
      obligations.set(armKey(view), {
        location,
        intentId: intent.intentId,
        generation: intent.generation,
      });
    }
  }

  function own<T>(work: Promise<T>): Promise<T> {
    jobs.add(work);
    void work.finally(() => jobs.delete(work)).catch(() => undefined);
    return work;
  }
  function active() {
    if (fenced || signal.aborted) throw new BridgeError('workflow-authority-denied');
  }
  function forget(arm: Arm) {
    if (arm.fenced && !arm.pumping && !arm.starts.size && arms.get(arm.key) === arm)
      arms.delete(arm.key);
  }
  function dispose(ticket: WorkflowStartTicket) {
    try {
      ticket.dispose();
    } catch {
      cleanupFailure('workflow-ticket-cleanup-failed');
    }
  }
  function fenceArm(arm: Arm) {
    if (arm.fenced) return;
    arm.fenced = true;
    arm.dirty = false;
    try {
      arm.unsubscribe?.();
      arm.stopAbort?.();
      arm.claim?.fence();
    } catch {
      cleanupFailure('workflow-owner-cleanup-failed');
    }
    for (const ticket of arm.tickets) dispose(ticket);
    forget(arm);
  }
  function current(arm: Arm) {
    active();
    if (arm.fenced || arms.get(arm.key) !== arm) throw new BridgeError('workflow-authority-denied');
    arm.claim?.check();
  }
  function launch(arm: Arm, ticket: WorkflowStartTicket) {
    if (arm.seen.has(ticket.reservation.requestId)) {
      if (!arm.tickets.has(ticket)) dispose(ticket);
      return;
    }
    if (arm.seen.size >= WORKFLOW_EXECUTION_LIMITS.starts)
      throw new BridgeError('workflow-capacity');
    arm.seen.add(ticket.reservation.requestId);
    arm.tickets.add(ticket);
    const work = Promise.resolve()
      .then(async () => {
        current(arm);
        ticket.check();
        // Admission cancellation only. The committed Run retains A's original
        // authority/lifetime, not this permit's disposable signal.
        const wait = AbortSignal.any([signal, lifetime.signal, ticket.signal]);
        const result = await runs.beginWorkflowRun(arm.original, ticket, wait);
        if (busy(result) && !arm.fenced) {
          arm.claim?.check();
          // D may already have yielded this genuine permit before returning busy.
          if (!ticket.signal.aborted) ticket.deferBusy();
          arm.seen.delete(ticket.reservation.requestId);
        }
        // Every non-busy outcome keeps the original ID in seen, including an
        // unknown receipt/exception. Only D can issue a different reservation.
      })
      .catch(() => {
        // A still owns any committed/uncertain effect and its actual cleanup.
        // Do not resend, manufacture a terminal event or clear a reservation.
      })
      .finally(() => {
        dispose(ticket);
        arm.tickets.delete(ticket);
        arm.starts.delete(work);
        forget(arm);
      });
    arm.starts.add(work);
    own(work);
  }
  function consume(arm: Arm, claim: WorkflowExecutionClaim) {
    try {
      consumeCurrent(arm, claim);
    } catch (error) {
      for (const ticket of claim.tickets) dispose(ticket);
      try {
        claim.fence();
      } catch {
        cleanupFailure('workflow-owner-cleanup-failed');
      }
      throw error;
    }
  }
  function consumeCurrent(arm: Arm, claim: WorkflowExecutionClaim) {
    current(arm);
    claim.check();
    if (
      armKey(claim.view) !== arm.key ||
      (arm.claim && arm.claim.signal !== claim.signal) ||
      claim.tickets.length > WORKFLOW_EXECUTION_LIMITS.concurrent
    )
      throw new BridgeError('workflow-authority-denied');
    remember(claim.view);
    if (!arm.claim) {
      arm.claim = claim;
      arm.unsubscribe = claim.onChange(() => kick(arm));
      const abort = () => fenceArm(arm);
      claim.signal.addEventListener('abort', abort, { once: true });
      arm.stopAbort = () => claim.signal.removeEventListener('abort', abort);
      if (claim.signal.aborted) abort();
    }
    if (claim.view.state !== 'running' || claim.view.requiresResume) {
      fenceArm(arm);
      for (const ticket of claim.tickets) dispose(ticket);
      return;
    }
    if (options.consumeClaim !== consumeClaim) throw new BridgeError('workflow-owner-unavailable');
    if (consumeClaim) {
      // The review owner retains its own pending/refused scopes. Its bounded
      // capacity or initialization refusal cannot cancel unrelated author tickets.
      try {
        const result: unknown = consumeClaim(arm.original, claim);
        if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
      } catch {}
      current(arm);
    }
    for (const ticket of claim.tickets) {
      current(arm);
      ticket.check();
      if (
        locationKey(ticket.location) !== locationKey(arm.location) ||
        ticket.reservation.intentId !== arm.intentId ||
        ticket.reservation.generation !== arm.generation
      )
        throw new BridgeError('workflow-start-ticket-invalid');
      launch(arm, ticket);
    }
  }
  function kick(arm: Arm) {
    if (fenced || arm.fenced || signal.aborted) return;
    arm.dirty = true;
    if (arm.pumping) return;
    const work = Promise.resolve()
      .then(async () => {
        // One claim per coalesced wakeup; starts run independently so a busy
        // workspace cannot hold the remaining permits behind its preparation.
        arm.dirty = false;
        current(arm);
        const result = await execution.claimWorkflowExecution(arm.original, {
          ...arm.location,
          intentId: arm.intentId,
          generation: arm.generation,
        });
        if (result.ok) consume(arm, result.value);
      })
      .catch(() => fenceArm(arm))
      .finally(() => {
        delete arm.pumping;
        forget(arm);
        if (arm.dirty && !arm.fenced && !fenced) kick(arm);
      });
    arm.pumping = work;
    own(work);
  }

  async function attach(original: MemberRequest, view: WorkflowExecutionView): Promise<void> {
    active();
    remember(view);
    if (!view.intent || view.requiresResume || view.state !== 'running') return;
    const key = armKey(view);
    const previous = arms.get(key);
    if (previous) return previous.attached;
    if (arms.size >= WORKFLOW_EXECUTION_LIMITS.owners) throw new BridgeError('workflow-capacity');
    const arm: Arm = {
      key,
      original,
      location: Object.freeze({ ...view.location }),
      intentId: view.intent.intentId,
      generation: view.intent.generation,
      seen: new Set(),
      tickets: new Set(),
      starts: new Set(),
      attached: Promise.resolve(),
      dirty: false,
      fenced: false,
    };
    arms.set(key, arm);
    arm.attached = own(
      Promise.resolve()
        .then(async () => {
          current(arm);
          const claimed = await execution.claimWorkflowExecution(original, {
            ...arm.location,
            intentId: arm.intentId,
            generation: arm.generation,
          });
          if (!claimed.ok) throw new BridgeError(claimed.error.code);
          consume(arm, claimed.value);
          // Close the subscribe/dispatch gap with one fresh fact observation.
          kick(arm);
        })
        .catch((error: unknown) => {
          fenceArm(arm);
          throw error;
        }),
    );
    return arm.attached;
  }

  async function drainStopped(
    original: MemberRequest,
    stopped: WorkflowExecutionView,
    requestId: string,
  ): Promise<ExecutionResult<WorkflowExecutionView>> {
    const affected = [...arms.values()].filter(
      (arm) =>
        locationKey(arm.location) === locationKey(stopped.location) &&
        arm.intentId === stopped.intent?.intentId &&
        arm.generation === stopped.intent?.generation,
    );
    for (const arm of affected) fenceArm(arm);
    await Promise.allSettled(affected.map((arm) => arm.attached));
    while (affected.some((arm) => arm.pumping || arm.starts.size))
      await Promise.allSettled(
        affected.flatMap((arm) => [...arm.starts, ...(arm.pumping ? [arm.pumping] : [])]),
      );
    const fresh = await readStopped(original, stopped);
    if (!fresh.ok) return fresh;
    const view = fresh.value;
    const intent = view.intent;
    if (!intent || intent.intentId !== stopped.intent?.intentId)
      return failure('workflow-not-found');
    if (view.activeRunIds.length > WORKFLOW_EXECUTION_LIMITS.starts)
      return failure('workflow-capacity');
    const commands: StopRunRequest[] = [];
    for (const runId of view.activeRunIds) {
      const reservation = intent.starts.find((item) => item.newRunId === runId);
      if (!reservation) return failure('workflow-recovery-required');
      const node = execution.readRunNode({ ...view.location, nodeId: reservation.nodeId });
      const state = node && readExecutionRunState(node);
      const run = state?.runs.find((item) => item.attempt.id === runId);
      if (!node || !state || !run) return failure('workflow-recovery-required');
      commands.push({
        ...view.location,
        nodeId: node.nodeId,
        requestId,
        runId,
        generation: run.attempt.generation,
        segmentId: run.segmentId,
        expectedNodeVersion: node.command.version,
        expectedRunVersion: state.version,
      });
    }
    let refused: ExecutionResult<never> | undefined;
    for (let index = 0; index < commands.length; index += WORKFLOW_EXECUTION_LIMITS.concurrent) {
      const results = await Promise.allSettled(
        commands
          .slice(index, index + WORKFLOW_EXECUTION_LIMITS.concurrent)
          .map((command) => Promise.resolve().then(() => runs.stop(original, command, signal))),
      );
      for (const result of results) {
        if (result.status === 'rejected') refused ??= failure('workflow-recovery-required');
        else if (!result.value.ok) refused ??= result.value;
      }
    }
    if (refused) return refused;
    return readStopped(original, stopped);
  }
  async function readStopped(
    original: MemberRequest,
    stopped: WorkflowExecutionView,
  ): Promise<ExecutionResult<WorkflowExecutionView>> {
    const fresh = await execution.readWorkflowExecution(original, stopped.location);
    if (!fresh.ok) return fresh;
    remember(fresh.value);
    if (
      !fresh.value.intent ||
      fresh.value.intent.intentId !== stopped.intent?.intentId ||
      locationKey(fresh.value.location) !== locationKey(stopped.location)
    )
      return failure('workflow-not-found');
    if (fresh.value.intent.generation !== stopped.intent?.generation)
      return failure('workflow-stale-generation');
    return fresh;
  }
  function stop(
    original: MemberRequest,
    raw: unknown,
  ): Promise<ExecutionResult<WorkflowExecutionView>> {
    active();
    if (controls >= WORKFLOW_EXECUTION_LIMITS.owners)
      return Promise.resolve(failure('workflow-capacity'));
    const parsed = workflowControlSchema.safeParse(raw);
    if (!parsed.success) return Promise.resolve(failure('workflow-validation'));
    controls++;
    return own(
      Promise.resolve()
        .then(async () => {
          // D authenticates, revokes genuine tickets and commits its queue barrier
          // before C can touch any other caller's retained native work.
          const stopped = await execution.stopWorkflowExecution(original, parsed.data);
          if (!stopped.ok) return stopped;
          const key = armKey(stopped.value);
          let work = drains.get(key);
          if (!work) {
            work = own(drainStopped(original, stopped.value, parsed.data.requestId));
            drains.set(key, work);
            const owned = work;
            void owned
              .finally(() => {
                if (drains.get(key) === owned) drains.delete(key);
              })
              .catch(() => undefined);
          }
          const drained = await work;
          if (!drained.ok) return drained;
          // Every caller gets its own fresh authorization after a shared drain.
          return readStopped(original, stopped.value);
        })
        .finally(() => {
          controls--;
        }),
    );
  }
  function fence() {
    if (fenced) return;
    fenced = true;
    lifetime.abort();
    signal.removeEventListener('abort', fence);
    for (const arm of [...arms.values()]) fenceArm(arm);
  }
  signal.addEventListener('abort', fence, { once: true });
  if (signal.aborted) fence();
  return {
    canSwitchBackend(): boolean {
      return (
        !closing &&
        controls === 0 &&
        !jobs.size &&
        !drains.size &&
        !errors.size &&
        !obligations.size &&
        [...arms.values()].every(
          (arm) =>
            arm.fenced &&
            !arm.claim &&
            !arm.pumping &&
            !arm.dirty &&
            !arm.starts.size &&
            !arm.tickets.size,
        )
      );
    },
    attach,
    stop,
    fence,
    /** A calls fence -> original Run owner.close -> this join. No replacement drain. */
    close(): Promise<void> {
      if (closing) return closing;
      fence();
      closing = (async () => {
        while (jobs.size) await Promise.allSettled([...jobs]);
        if (errors.size)
          throw new AggregateError(errors.values(), 'Workflow bridge cleanup failed.');
        if (owners.get(execution) === identity) owners.delete(execution);
      })();
      return closing;
    },
  };
}
