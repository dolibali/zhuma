import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalPayload,
  REMOTE_WORKFLOW_LIMITS,
  remoteWorkflowIntentSchema,
  remoteWorkflowViewSchema,
  type ExecutionNodeRecord,
  type RemoteRunRequest,
  type RemoteRunErrorCode,
  type RemoteRunView,
  type RemoteWorkflowTarget,
  type RemoteWorkflowRef,
  type RemoteWorkflowBinding,
  type RemoteWorkflowIntent,
  type RemoteWorkflowView,
  type RemoteWorkflowCandidate,
  type RemoteAcceptRequest,
  type RemoteReviewAcceptRequest,
  type RemoteReviewView,
} from '@zhuma/agent-core';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import { readExecutionReviewState } from './execution-review-state.js';
import type { MemberRequest } from './member-session.js';
import type { BeginRunRequest, ExecutionResult, PlanReceipt } from './execution-service.js';
import { readExecutionRunState, type ExecutionRun } from './execution-run-state.js';
import { effectiveWorkflowToolKind } from './execution-workflow-tools.js';
import {
  workflowReviewCandidates,
  workflowReviewResources,
  workflowReviewOccupied,
  workflowReviewAttention,
  type WorkflowReviewResource,
} from './execution-workflow-reviews.js';
import {
  ExecutionWorkflowError,
  WORKFLOW_EXECUTION_LIMITS,
  workflowClaimSchema,
  workflowControlSchema,
  workflowExecutionIntentSchema,
  workflowLocationSchema,
  workflowResumeSchema,
  workflowStartSchema,
  type WorkflowExecutionClaim,
  type WorkflowExecutionIntent,
  type WorkflowExecutionView,
  type WorkflowLocation,
  type WorkflowStartReservation,
  type WorkflowStartTicket,
} from './execution-workflow-contract.js';

export interface WorkflowFacts {
  readonly receipt: PlanReceipt | undefined;
  readonly nodes: readonly ExecutionNodeRecord[];
  readonly availableExpertIds: readonly string[];
}
/** Created only by the original ExecutionService's installed member issuer. */
export interface WorkflowMember {
  readonly memberId: string;
  readonly signal: AbortSignal;
  facts(requireStarted: boolean): WorkflowFacts;
  initialize(requestId: string): Promise<void>;
  /** Existing original C/Host scope-drain proof, never the persisted label alone. */
  assertDrained(node: ExecutionNodeRecord, run: ExecutionRun): void;
  assertReviewDrained?(review: WorkflowReviewResource): void;
  release(): void;
}
export interface WorkflowIntentSource {
  readonly signal: AbortSignal;
  enqueue<T>(work: () => Promise<ExecutionResult<T>>): Promise<ExecutionResult<T>>;
  open(request: MemberRequest, location: WorkflowLocation): Promise<WorkflowMember>;
  write(location: WorkflowLocation, receipt: PlanReceipt): Promise<void>;
  /** Existing durable-node and Host identity/directory notifications only. */
  watch(listener: () => void): () => void;
}
interface Arm {
  readonly location: WorkflowLocation;
  readonly intentId: string;
  readonly generation: number;
  readonly request: MemberRequest;
  readonly member: WorkflowMember;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly tickets: Set<TicketState>;
  readonly listeners: Set<() => void>;
  readonly blocked: Map<string, number>;
  epoch: number;
  fenced: boolean;
  stop(): void;
}
interface TicketState {
  readonly arm: Arm;
  readonly reservation: WorkflowStartReservation;
  readonly ticket: WorkflowStartTicket;
  readonly controller: AbortController;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const keyOf = (location: WorkflowLocation) => canonicalPayload(location);
const locationOf = (input: WorkflowLocation): WorkflowLocation =>
  workflowLocationSchema.parse({
    spaceId: input.spaceId,
    taskId: input.taskId,
    planId: input.planId,
    revision: input.revision,
  });
const fail = (code: string): never => {
  throw new ExecutionWorkflowError(code);
};
const ok = <T>(value: T): ExecutionResult<T> => ({ ok: true, value });
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

/** Capability/lifetime bookkeeping only. All durable facts and writes stay in
 * the original plan/node tables and original ExecutionService queue.
 */
export class ExecutionWorkflowIntents {
  private readonly arms = new Map<string, Arm>();
  private readonly tickets = new WeakMap<object, TicketState>();
  private readonly claims = new WeakMap<object, Arm>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly retained = new Set<WorkflowMember>();
  private readonly released = new WeakSet<WorkflowMember>();
  /** Same-Host fence + original queue barrier proves these reservations never
   * acquired a Run. This evidence intentionally does not survive a cold start. */
  private readonly cancelled = new Set<string>();
  private readonly preparations = new Map<string, { active: number; failed: boolean }>();
  private cleanupFailed = false;
  constructor(private readonly source: WorkflowIntentSource) {}

  private intent(facts: WorkflowFacts): WorkflowExecutionIntent | undefined {
    const raw = facts.receipt?.workflowExecution;
    if (raw === undefined) return undefined;
    const parsed = workflowExecutionIntentSchema.safeParse(raw);
    if (!parsed.success) return fail('workflow-incompatible');
    if (parsed.data.starts.some((item) => !facts.receipt!.nodeIds.includes(item.nodeId)))
      return fail('workflow-incompatible');
    return parsed.data;
  }
  private owner(
    location: WorkflowLocation,
    member: WorkflowMember,
    intent: WorkflowExecutionIntent,
  ) {
    if (intent.actorId !== member.memberId || intent.spaceId !== location.spaceId)
      return fail('workflow-authority-denied');
  }
  private current(arm: Arm) {
    if (
      this.source.signal.aborted ||
      arm.signal.aborted ||
      this.arms.get(keyOf(arm.location)) !== arm
    )
      return fail('workflow-authority-denied');
    const facts = arm.member.facts(true);
    const intent = this.intent(facts);
    if (intent) this.owner(arm.location, arm.member, intent);
    if (
      !intent ||
      intent.intentId !== arm.intentId ||
      intent.generation !== arm.generation ||
      intent.actorId !== arm.member.memberId ||
      intent.spaceId !== arm.location.spaceId ||
      intent.status !== 'running'
    )
      return fail('workflow-not-running');
    if (intent.starts.some((item) => this.preparations.get(item.requestId)?.failed))
      return fail('workflow-recovery-required');
    for (const { reservation, node, run } of this.bound(facts, intent))
      if (reservation.generation < intent.generation) arm.member.assertDrained(node, run);
    return { facts, intent };
  }
  private release(member: WorkflowMember) {
    if (this.released.has(member)) return;
    this.released.add(member);
    this.retained.delete(member);
    try {
      const result: unknown = member.release();
      if (result !== undefined) {
        this.cleanupFailed = true;
        const drain = Promise.resolve(result);
        this.operations.add(drain);
        void drain.finally(() => this.operations.delete(drain)).catch(() => undefined);
      }
    } catch {
      this.cleanupFailed = true;
    }
  }
  private fence(arm: Arm) {
    if (arm.fenced) return;
    arm.fenced = true;
    if (!arm.controller.signal.aborted) arm.controller.abort();
    arm.stop();
    for (const state of [...arm.tickets]) this.disposeTicket(state);
    arm.listeners.clear();
    if (this.arms.get(keyOf(arm.location)) === arm) this.arms.delete(keyOf(arm.location));
    if (this.retained.has(arm.member)) this.release(arm.member);
  }
  private arm(
    request: MemberRequest,
    member: WorkflowMember,
    location: WorkflowLocation,
    intent: WorkflowExecutionIntent,
  ) {
    if (this.arms.size >= WORKFLOW_EXECUTION_LIMITS.owners) return fail('workflow-capacity');
    const previous = this.arms.get(keyOf(location));
    if (previous) this.fence(previous);
    const controller = new AbortController();
    const arm: Arm = {
      location: freeze(structuredClone(location)),
      intentId: intent.intentId,
      generation: intent.generation,
      request,
      member,
      controller,
      signal: AbortSignal.any([controller.signal, member.signal, this.source.signal]),
      tickets: new Set(),
      listeners: new Set(),
      blocked: new Map(),
      epoch: 0,
      fenced: false,
      stop() {},
    };
    this.retained.add(member);
    this.arms.set(keyOf(location), arm);
    const changed = () => {
      try {
        this.current(arm);
      } catch {
        this.fence(arm);
        return;
      }
      arm.epoch++;
      for (const listener of [...arm.listeners]) {
        try {
          listener();
        } catch {
          /* A wakeup cannot undo durable facts. */
        }
      }
    };
    const unsubscribe = this.source.watch(changed);
    const aborted = () => this.fence(arm);
    arm.signal.addEventListener('abort', aborted, { once: true });
    arm.stop = () => {
      unsubscribe();
      arm.signal.removeEventListener('abort', aborted);
    };
    try {
      this.current(arm);
    } catch {
      this.fence(arm);
    }
  }
  private bound(facts: WorkflowFacts, intent: WorkflowExecutionIntent) {
    const states = new Map<ExecutionNodeRecord, ReturnType<typeof readExecutionRunState>>();
    const found: {
      reservation: WorkflowStartReservation;
      node: ExecutionNodeRecord;
      run: ExecutionRun;
    }[] = [];
    for (const reservation of intent.starts) {
      const node = facts.nodes.find((item) => item.nodeId === reservation.nodeId);
      if (!node) return fail('workflow-incompatible');
      if (!states.has(node)) states.set(node, readExecutionRunState(node));
      const state = states.get(node);
      const receipt = state?.receipts.find((item) => item.requestId === reservation.requestId);
      if (!receipt) {
        if (
          state?.runs.some(
            (run) =>
              run.attempt.id === reservation.newRunId || run.segmentId === reservation.newSegmentId,
          )
        )
          return fail('workflow-recovery-required');
        continue;
      }
      const run = state!.runs.find((item) => item.attempt.id === receipt.runId);
      if (
        !run ||
        run.attempt.id !== reservation.newRunId ||
        run.segmentId !== reservation.newSegmentId ||
        run.actorId !== intent.actorId ||
        run.spaceId !== intent.spaceId
      )
        return fail('workflow-recovery-required');
      found.push({ reservation, node, run });
    }
    return found;
  }
  private view(
    location: WorkflowLocation,
    member: WorkflowMember,
    disposition: WorkflowExecutionView['disposition'] = 'unchanged',
  ): WorkflowExecutionView {
    const facts = member.facts(true);
    const intent = this.intent(facts);
    if (intent) this.owner(location, member, intent);
    const arm = this.arms.get(keyOf(location));
    let live = false;
    if (arm) {
      try {
        this.current(arm);
        live = true;
      } catch {
        this.fence(arm);
      }
    }
    const bound = intent ? this.bound(facts, intent) : [];
    const active = bound.filter(({ run }) => run.resources === 'held');
    const reviews = workflowReviewResources(facts.nodes);
    const reviewAttention = workflowReviewAttention(
      facts.nodes,
      intent,
      member.assertReviewDrained?.bind(member),
    );
    let drained =
      active.length === 0 &&
      !reviews.some((review) => review.resources === 'held') &&
      !intent?.starts.some((item) => this.preparations.has(item.requestId));
    if (drained)
      for (const { node, run } of bound) {
        try {
          member.assertDrained(node, run);
        } catch {
          drained = false;
          break;
        }
      }
    if (drained)
      for (const review of reviews) {
        try {
          if (!member.assertReviewDrained) throw new Error('Review drain unavailable.');
          member.assertReviewDrained(review);
        } catch {
          drained = false;
          break;
        }
      }
    const unknown = intent?.starts.some(
      (item) =>
        !this.cancelled.has(item.requestId) &&
        !bound.some(({ reservation }) => reservation.requestId === item.requestId),
    );
    const complete =
      !unknown &&
      drained &&
      facts.nodes.length > 0 &&
      facts.nodes.every(
        (node) =>
          node.command.status === 'completed' &&
          !!node.acceptedArtifactVersionId &&
          !readExecutionRunState(node)?.runs.some((run) => run.resources !== 'settled'),
      );
    const requiresResume = intent?.status === 'running' && !live && !complete;
    const state: WorkflowExecutionView['state'] = !intent
      ? 'inactive'
      : complete
        ? 'completed'
        : intent.status === 'stopping'
          ? !drained || unknown
            ? 'stopping'
            : 'paused'
          : requiresResume
            ? 'requires-resume'
            : 'running';
    return freeze({
      disposition,
      location: structuredClone(location),
      intent: intent && structuredClone(intent),
      state,
      requiresResume,
      activeRunIds: active.map(({ run }) => run.attempt.id),
      ...(reviewAttention.length ? { reviewAttention } : {}),
      ...(reviews.length
        ? {
            reviewResources: reviews.map(({ scope, version, status, resources, stopPhase }) => ({
              scope,
              version,
              status,
              resources,
              stopPhase,
            })),
          }
        : {}),
    });
  }
  private replay(intent: WorkflowExecutionIntent, requestId: string, fingerprint: string) {
    const prior = intent.commandReceipts.find((item) => item.requestId === requestId);
    if (!prior) return false;
    if (prior.fingerprint !== fingerprint) return fail('workflow-idempotency-mismatch');
    return true;
  }
  private prepareWrite(facts: WorkflowFacts, intent: WorkflowExecutionIntent): PlanReceipt {
    if (!facts.receipt) return fail('workflow-plan-incomplete');
    if (
      intent.starts.length >
      facts.receipt.nodeIds.length *
        Math.min(intent.generation, WORKFLOW_EXECUTION_LIMITS.commandReceipts)
    )
      return fail('workflow-capacity');
    const checked = workflowExecutionIntentSchema.safeParse(intent);
    if (!checked.success) return fail('workflow-capacity');
    return { ...facts.receipt, workflowExecution: checked.data };
  }
  private async write(
    location: WorkflowLocation,
    facts: WorkflowFacts,
    intent: WorkflowExecutionIntent,
  ) {
    await this.source.write(location, this.prepareWrite(facts, intent));
  }
  private receipt(
    intent: WorkflowExecutionIntent,
    kind: 'start' | 'resume' | 'stop',
    requestId: string,
    fingerprint: string,
  ) {
    // Reserve the last receipt for a real Stop: capacity cannot create a
    // successfully armed generation which cannot durably record its stop.
    if (
      intent.commandReceipts.length >=
      WORKFLOW_EXECUTION_LIMITS.commandReceipts - (kind === 'stop' ? 0 : 1)
    )
      return fail('workflow-capacity');
    return [
      ...intent.commandReceipts,
      { kind, requestId, fingerprint, generation: intent.generation },
    ];
  }
  private operate<S extends z.ZodType<WorkflowLocation>, T>(
    request: MemberRequest,
    raw: unknown,
    schema: S,
    work: (input: z.output<S>, member: WorkflowMember) => Promise<ExecutionResult<T>>,
  ): Promise<ExecutionResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      return Promise.resolve({
        ok: false,
        error: { code: 'workflow-validation', message: '工作流执行操作未完成。', details: {} },
      });
    if (this.operations.size >= 128 || this.source.signal.aborted)
      return Promise.resolve({
        ok: false,
        error: { code: 'workflow-capacity', message: '工作流执行操作未完成。', details: {} },
      });
    const operation = Promise.resolve().then(async () => {
      let member: WorkflowMember | undefined;
      try {
        member = await this.source.open(request, locationOf(parsed.data));
        if (this.source.signal.aborted) return fail('workflow-authority-denied');
        return await work(parsed.data, member);
      } catch (error) {
        return {
          ok: false as const,
          error: {
            code: error instanceof ExecutionWorkflowError ? error.code : 'workflow-unavailable',
            message: '工作流执行操作未完成。',
            details: {},
          },
        };
      } finally {
        if (member && !this.retained.has(member)) this.release(member);
      }
    });
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }
  start(request: MemberRequest, raw: unknown) {
    return this.operate(request, raw, workflowStartSchema, (input, member) =>
      this.source.enqueue(async () => {
        const location = locationOf(input);
        let facts = member.facts(false);
        if (facts.receipt?.remoteWorkflows?.length) return fail('workflow-already-started');
        const fingerprint = hash({ kind: 'start', memberId: member.memberId, ...input });
        const current = this.intent(facts);
        if (current) {
          if (!this.replay(current, input.requestId, fingerprint))
            return fail('workflow-already-started');
          return ok(this.view(location, member, 'replayed'));
        }
        if (this.arms.size >= WORKFLOW_EXECUTION_LIMITS.owners) return fail('workflow-capacity');
        if (!facts.receipt) {
          await member.initialize(input.requestId);
          facts = member.facts(true);
        }
        const intent: WorkflowExecutionIntent = {
          schemaVersion: 1,
          intentId: randomUUID(),
          actorId: member.memberId,
          spaceId: location.spaceId,
          generation: 1,
          version: 1,
          status: 'running',
          defaults: input.defaults,
          budget: input.budget,
          starts: [],
          commandReceipts: [
            { requestId: input.requestId, kind: 'start', fingerprint, generation: 1 },
          ],
        };
        member.facts(true);
        await this.write(location, facts, intent);
        try {
          this.arm(request, member, location, intent);
        } catch {
          /* Durable intent remains resumable, never silently armed. */
        }
        return ok(this.view(location, member, 'applied'));
      }),
    );
  }
  read(request: MemberRequest, raw: unknown) {
    return this.operate(request, raw, workflowLocationSchema, (location, member) =>
      this.source.enqueue(async () => ok(this.view(location, member))),
    );
  }
  resume(request: MemberRequest, raw: unknown) {
    return this.operate(request, raw, workflowResumeSchema, (input, member) =>
      this.source.enqueue(async () => {
        const location = locationOf(input);
        const facts = member.facts(true),
          current = this.intent(facts);
        if (facts.receipt?.remoteWorkflows?.length) return fail('workflow-already-started');
        if (!current || current.intentId !== input.intentId) return fail('workflow-not-found');
        this.owner(location, member, current);
        const fingerprint = hash({ kind: 'resume', memberId: member.memberId, ...input });
        if (this.replay(current, input.requestId, fingerprint))
          return ok(this.view(location, member, 'replayed'));
        if (current.generation !== input.generation) return fail('workflow-stale-generation');
        if (current.version !== input.expectedVersion) return fail('workflow-conflict');
        if (current.status === 'completed') return fail('workflow-completed');
        const bound = this.bound(facts, current);
        const reviews = workflowReviewResources(facts.nodes);
        if (
          bound.some(({ run }) => run.resources !== 'settled') ||
          reviews.some((review) => review.resources !== 'settled')
        )
          return fail('workflow-recovery-required');
        if (current.starts.some((item) => this.preparations.has(item.requestId)))
          return fail('workflow-recovery-required');
        for (const { node, run } of bound) member.assertDrained(node, run);
        for (const review of reviews) {
          if (!member.assertReviewDrained) return fail('workflow-recovery-required');
          member.assertReviewDrained(review);
        }
        if (
          workflowReviewAttention(facts.nodes, current, member.assertReviewDrained?.bind(member))
            .length
        )
          return fail('workflow-review-attention-required');
        const old = this.arms.get(keyOf(location));
        // No absence inference for an unbound reservation after an owner was lost.
        if (
          !old &&
          current.starts.some(
            (item) =>
              !this.cancelled.has(item.requestId) &&
              !bound.some(({ reservation }) => reservation.requestId === item.requestId),
          )
        )
          return fail('workflow-recovery-required');
        const next = {
          ...current,
          generation: current.generation + 1,
          version: current.version + 1,
          status: 'running' as const,
        };
        next.commandReceipts = this.receipt(next, 'resume', input.requestId, fingerprint);
        this.prepareWrite(facts, next);
        member.facts(true);
        if (old) {
          this.fence(old);
          this.rememberCancelled(current, bound);
        }
        await this.write(location, facts, next);
        try {
          this.arm(request, member, location, next);
        } catch {
          /* Same durable/resume boundary as start. */
        }
        return ok(this.view(location, member, 'applied'));
      }),
    );
  }
  stop(request: MemberRequest, raw: unknown) {
    return this.operate(request, raw, workflowControlSchema, async (input, member) => {
      const location = locationOf(input);
      const beforeFacts = member.facts(true);
      const before = this.intent(beforeFacts);
      if (!before || before.intentId !== input.intentId) return fail('workflow-not-found');
      this.owner(location, member, before);
      if (before.generation !== input.generation) return fail('workflow-stale-generation');
      const fingerprint = hash({ kind: 'stop', memberId: member.memberId, ...input });
      // Refusals knowable now must not revoke an unrelated live capability.
      // A valid Stop still fences before waiting for the original queue below.
      if (!this.replay(before, input.requestId, fingerprint) && before.status === 'running') {
        const next = { ...before, status: 'stopping' as const, version: before.version + 1 };
        next.commandReceipts = this.receipt(next, 'stop', input.requestId, fingerprint);
        this.prepareWrite(beforeFacts, next);
      }
      const arm = this.arms.get(keyOf(location));
      if (arm && arm.generation === input.generation) this.fence(arm);
      return this.source.enqueue(async () => {
        const facts = member.facts(true),
          current = this.intent(facts);
        if (!current || current.intentId !== input.intentId) return fail('workflow-not-found');
        this.owner(location, member, current);
        if (current.generation !== input.generation) return fail('workflow-stale-generation');
        if (this.replay(current, input.requestId, fingerprint))
          return ok(this.view(location, member, 'replayed'));
        if (current.status !== 'running') return ok(this.view(location, member));
        const next = { ...current, status: 'stopping' as const, version: current.version + 1 };
        next.commandReceipts = this.receipt(next, 'stop', input.requestId, fingerprint);
        member.facts(true);
        await this.write(location, facts, next);
        // All prior node puts completed before this original queue turn; every
        // later put must now fail the revoked genuine ticket's final check.
        if (arm) this.rememberCancelled(next, this.bound(facts, next));
        return ok(this.view(location, member, 'applied'));
      });
    });
  }
  claim(request: MemberRequest, raw: unknown): Promise<ExecutionResult<WorkflowExecutionClaim>> {
    return this.operate(request, raw, workflowClaimSchema, (input, member) =>
      this.source.enqueue(async () => {
        const location = locationOf(input);
        const arm = this.arms.get(keyOf(location));
        if (
          !arm ||
          arm.request !== request ||
          arm.intentId !== input.intentId ||
          arm.generation !== input.generation
        )
          return fail('workflow-authority-denied');
        member.facts(true);
        let { facts, intent } = this.current(arm);
        const bound = this.bound(facts, intent);
        const active = bound.filter(({ run }) => run.resources === 'held');
        let slots =
          intent.budget.concurrent -
          active.length -
          workflowReviewOccupied(facts.nodes, intent) -
          [...arm.tickets].filter(
            (state) =>
              !bound.some(
                ({ reservation }) => reservation.requestId === state.reservation.requestId,
              ),
          ).length;
        const selected: WorkflowStartReservation[] = [];
        const additions: WorkflowStartReservation[] = [];
        for (const node of facts.nodes) {
          if (slots <= 0) break;
          if (
            node.command.status !== 'ready' ||
            node.command.upstreamAffected ||
            node.handoff.assignee.kind !== 'expert' ||
            !node.handoff.expertRef ||
            !facts.availableExpertIds.includes(node.handoff.assignee.id) ||
            readExecutionRunState(node)?.runs.length
          )
            continue;
          if (
            node.handoff.dependencyNodeIds.some((id) => {
              const predecessor = facts.nodes.find((item) => item.nodeId === id);
              return (
                predecessor?.command.status !== 'completed' ||
                !predecessor.acceptedArtifactVersionId ||
                !node.handoff.inputRefs.some(
                  (ref) =>
                    ref.sourceNodeId === id &&
                    ref.artifactVersionId === predecessor.acceptedArtifactVersionId,
                )
              );
            })
          )
            continue;
          const existing = intent.starts.find(
            (item) => item.nodeId === node.nodeId && item.generation === intent.generation,
          );
          if (
            existing &&
            (arm.blocked.get(existing.requestId) === arm.epoch ||
              [...arm.tickets].some((state) => state.reservation.requestId === existing.requestId))
          )
            continue;
          const reservation = existing ?? {
            intentId: intent.intentId,
            generation: intent.generation,
            nodeId: node.nodeId,
            expectedNodeVersion: node.command.version,
            expectedRunVersion: readExecutionRunState(node)?.version ?? 0,
            requestId: randomUUID(),
            newRunId: randomUUID(),
            newSegmentId: randomUUID(),
            expertId: node.handoff.assignee.id,
            expertVersionId: node.handoff.expertRef.version,
            inputsFingerprint: hash(node.handoff.inputRefs),
          };
          if (
            reservation.expectedNodeVersion !== node.command.version ||
            reservation.inputsFingerprint !== hash(node.handoff.inputRefs)
          )
            continue;
          selected.push(reservation);
          if (!existing) additions.push(reservation);
          slots--;
        }
        if (additions.length) {
          intent = {
            ...intent,
            version: intent.version + 1,
            starts: [...intent.starts, ...additions],
          };
          this.current(arm);
          await this.write(location, facts, intent);
          ({ facts, intent } = this.current(arm));
        }
        const tickets = selected.map((reservation) => this.ticket(arm, reservation));
        const claim: WorkflowExecutionClaim = Object.freeze({
          view: this.view(location, member),
          tickets: Object.freeze(tickets),
          reviewCandidates: freeze(
            workflowReviewCandidates(
              facts.nodes,
              intent,
              facts.availableExpertIds,
              member.assertReviewDrained?.bind(member),
            ).slice(0, Math.max(0, slots)),
          ),
          signal: arm.signal,
          check: () => {
            this.current(arm);
            return undefined;
          },
          onChange: (listener: () => void) => {
            this.current(arm);
            arm.listeners.add(listener);
            return () => {
              arm.listeners.delete(listener);
            };
          },
          fence: () => this.fence(arm),
        });
        this.claims.set(claim, arm);
        return ok(claim);
      }),
    );
  }
  /** Original claim identity plus retained request/arm, never caller .check(). */
  assertClaimCurrent(request: MemberRequest, claim: WorkflowExecutionClaim) {
    const arm = this.claims.get(claim);
    if (!arm || arm.request !== request) return fail('workflow-authority-denied');
    return this.current(arm);
  }
  assertClaim(request: MemberRequest, claim: WorkflowExecutionClaim) {
    const arm = this.claims.get(claim);
    if (!arm || arm.request !== request) return fail('workflow-authority-denied');
    const current = this.current(arm);
    const bound = this.bound(current.facts, current.intent);
    const occupied =
      bound.filter(({ run }) => run.resources === 'held').length +
      workflowReviewOccupied(current.facts.nodes, current.intent) +
      [...arm.tickets].filter(
        ({ reservation }) =>
          !bound.some(({ reservation: item }) => item.requestId === reservation.requestId),
      ).length;
    return { ...current, availableSlots: current.intent.budget.concurrent - occupied };
  }
  private ticket(arm: Arm, reservation: WorkflowStartReservation): WorkflowStartTicket {
    const controller = new AbortController();
    let state!: TicketState;
    const ticket = Object.freeze({
      location: arm.location,
      reservation: freeze(structuredClone(reservation)),
      defaults: freeze(structuredClone(this.current(arm).intent.defaults)),
      signal: AbortSignal.any([controller.signal, arm.signal]),
      check: () => {
        this.assertTicket(state);
        return undefined;
      },
      deferBusy: () => {
        arm.blocked.set(reservation.requestId, arm.epoch);
        this.disposeTicket(state);
      },
      dispose: () => this.disposeTicket(state),
    }) as WorkflowStartTicket;
    state = { arm, reservation, ticket, controller };
    this.tickets.set(ticket, state);
    arm.tickets.add(state);
    return ticket;
  }
  private disposeTicket(state: TicketState) {
    state.controller.abort();
    state.arm.tickets.delete(state);
  }
  private assertTicket(state: TicketState) {
    if (!state || state.ticket.signal.aborted || !state.arm.tickets.has(state))
      return fail('workflow-start-ticket-invalid');
    const { facts, intent } = this.current(state.arm);
    const reservation = intent.starts.find(
      (item) => item.requestId === state.reservation.requestId,
    );
    const node = facts.nodes.find((item) => item.nodeId === state.reservation.nodeId);
    if (
      !reservation ||
      canonicalPayload(reservation) !== canonicalPayload(state.reservation) ||
      !node ||
      reservation.generation !== intent.generation ||
      node.handoff.assignee.kind !== 'expert' ||
      node.handoff.assignee.id !== reservation.expertId ||
      !facts.availableExpertIds.includes(reservation.expertId) ||
      node.handoff.expertRef?.version !== reservation.expertVersionId ||
      hash(node.handoff.inputRefs) !== reservation.inputsFingerprint
    )
      return fail('workflow-start-ticket-invalid');
    return { node, intent, reservation };
  }
  /** Called from the original startRun queue, including immediately before node put. */
  assertBegin(input: BeginRunRequest, memberId: string, ticket?: WorkflowStartTicket): undefined {
    const location = locationOf(input);
    const state = ticket && this.tickets.get(ticket);
    if (ticket !== undefined && !state) return fail('workflow-start-ticket-invalid');
    if (!state) return undefined; // The Service separately blocks persisted reservation IDs without a ticket.
    const { intent, node, reservation } = this.assertTicket(state);
    const { configurationId: _configurationId, ...model } = input.selection;
    if (
      memberId !== intent.actorId ||
      keyOf(location) !== keyOf(state.arm.location) ||
      input.nodeId !== reservation.nodeId ||
      input.requestId !== reservation.requestId ||
      input.newRunId !== reservation.newRunId ||
      input.newSegmentId !== reservation.newSegmentId ||
      input.expectedNodeVersion !== reservation.expectedNodeVersion ||
      input.expectedRunVersion !== reservation.expectedRunVersion ||
      input.mode !== 'begin' ||
      canonicalPayload(model) !== canonicalPayload(intent.defaults.model) ||
      canonicalPayload(input.workspace) !== canonicalPayload(intent.defaults.workspace) ||
      input.composition.payload.tools.kind !==
        effectiveWorkflowToolKind(intent.defaults.tools, node.handoff.inputRefs) ||
      input.composition.payload.executor.kind !== 'plan-expert' ||
      input.composition.payload.executor.ref.id !== reservation.expertId ||
      input.composition.payload.executor.ref.version !== reservation.expertVersionId
    )
      return fail('workflow-defaults-mismatch');
    const prior = readExecutionRunState(node)?.receipts.find(
      (item) => item.requestId === reservation.requestId,
    );
    if (!prior && node.command.version !== reservation.expectedNodeVersion)
      return fail('workflow-conflict');
    return undefined;
  }
  /** Internal Service seam: validate BEFORE any private resource provider. */
  preparing(
    request: MemberRequest,
    input: BeginRunRequest,
    ticket: WorkflowStartTicket,
  ): AbortSignal {
    const state = this.tickets.get(ticket);
    if (!state || state.arm.request !== request) return fail('workflow-start-ticket-invalid');
    this.assertBegin(input, state.arm.member.memberId, ticket);
    return ticket.signal;
  }
  /** Own the original qualification's real end, including late metadata release.
   * A close failure stays unresolved; its settled Promise is not drain proof. */
  trackPreparation(
    ticket: WorkflowStartTicket,
    operation: Promise<unknown>,
    cleanupFailed: () => boolean,
  ) {
    const state = this.tickets.get(ticket);
    if (!state) return fail('workflow-start-ticket-invalid');
    const id = state.reservation.requestId;
    const entry = this.preparations.get(id) ?? { active: 0, failed: false };
    entry.active++;
    this.preparations.set(id, entry);
    const ended = () => {
      entry.active--;
      entry.failed ||= cleanupFailed();
      if (entry.failed) this.fence(state.arm);
      if (!entry.active && !entry.failed) this.preparations.delete(id);
    };
    void operation.then(ended, ended);
  }
  deferBusy(ticket: WorkflowStartTicket | undefined) {
    if (ticket && this.tickets.has(ticket)) ticket.deferBusy();
  }
  private rememberCancelled(
    intent: WorkflowExecutionIntent,
    bound: readonly { reservation: WorkflowStartReservation }[],
  ) {
    for (const item of intent.starts) {
      if (
        this.cancelled.size >=
        WORKFLOW_EXECUTION_LIMITS.starts * WORKFLOW_EXECUTION_LIMITS.owners
      )
        break;
      if (!bound.some(({ reservation }) => reservation.requestId === item.requestId))
        this.cancelled.add(item.requestId);
    }
  }
  async close() {
    for (const arm of [...this.arms.values()]) this.fence(arm);
    while (this.operations.size) await Promise.allSettled([...this.operations]);
    if (this.cleanupFailed) return fail('workflow-cleanup-failed');
  }
}

export interface RemoteWorkflowFacts {
  readonly receipt: PlanReceipt;
  readonly nodes: readonly ExecutionNodeRecord[];
  readonly allNodes: readonly ExecutionNodeRecord[];
  readonly controlledNodeIds: readonly string[];
  readonly reviewNodeIds?: readonly string[];
  readonly availableExpertIds: readonly string[];
}
export interface RemoteWorkflowIntentSource {
  reviewCandidates?(
    lease: ExecutionMemberLease,
    target: RemoteWorkflowTarget,
    intent: RemoteWorkflowIntent,
  ): readonly Extract<RemoteWorkflowCandidate, { kind: 'review' }>[];
  reviewViews?(
    lease: ExecutionMemberLease,
    target: RemoteWorkflowTarget,
    intent: RemoteWorkflowIntent,
    sessionHash: string,
  ): readonly RemoteReviewView[];
  facts(lease: ExecutionMemberLease, target: RemoteWorkflowTarget): RemoteWorkflowFacts;
  beforeWrite(): Promise<void>;
  write(target: RemoteWorkflowTarget, receipt: PlanReceipt): Promise<void>;
  runView(node: ExecutionNodeRecord, run: ExecutionRun): RemoteRunView;
  stop(
    lease: ExecutionMemberLease,
    target: RemoteWorkflowTarget,
    intent: RemoteWorkflowIntent,
    requestId: string,
  ): Promise<void>;
  now(): number;
  deny(code: RemoteRunErrorCode): never;
}
type RemoteWorkflowCommand = Extract<
  RemoteRunRequest,
  {
    operation:
      'workflow-start' | 'workflow-status' | 'workflow-next' | 'workflow-resume' | 'workflow-stop';
  }
>;
interface RemoteArm {
  readonly concurrent: number;
  readonly generation: number;
  readonly deviceId: string;
  readonly keyEpoch: number;
  readonly sessionHash: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}
/** Same plan rows and writer queue. This map contains expiring drive permission,
 * never jobs, delivery facts or a serializable replacement for the local tickets. */
export class RemoteWorkflowIntents {
  private readonly arms = new Map<string, RemoteArm>();
  private readonly preparations = new Map<string, Set<AbortController>>();
  private closed = false;
  constructor(private readonly source: RemoteWorkflowIntentSource) {}
  close(): void {
    this.closed = true;
    for (const id of new Set([...this.arms.keys(), ...this.preparations.keys()])) this.fence(id);
  }
  private fence(id: string, abortPreparations = true): void {
    const arm = this.arms.get(id);
    if (arm) clearTimeout(arm.timer);
    this.arms.delete(id);
    if (abortPreparations)
      for (const preparation of this.preparations.get(id) ?? []) preparation.abort();
  }
  private arm(intent: RemoteWorkflowIntent, sessionHash: string): void {
    this.fence(intent.intentId, false);
    const expiresAt = this.source.now() + REMOTE_WORKFLOW_LIMITS.armTtlMs;
    const timer = setTimeout(() => this.fence(intent.intentId), REMOTE_WORKFLOW_LIMITS.armTtlMs);
    timer.unref();
    this.arms.set(intent.intentId, {
      concurrent: intent.budget.concurrent,
      generation: intent.generation,
      deviceId: intent.deviceId,
      keyEpoch: intent.keyEpoch,
      sessionHash,
      expiresAt,
      timer,
    });
  }
  private live(intent: RemoteWorkflowIntent, sessionHash: string): RemoteArm | undefined {
    const arm = this.arms.get(intent.intentId);
    if (
      this.closed ||
      !arm ||
      arm.expiresAt <= this.source.now() ||
      arm.generation !== intent.generation ||
      arm.deviceId !== intent.deviceId ||
      arm.keyEpoch !== intent.keyEpoch ||
      arm.sessionHash !== sessionHash ||
      intent.status !== 'running'
    )
      return undefined;
    return arm;
  }
  private facts(lease: ExecutionMemberLease, target: RemoteWorkflowTarget): RemoteWorkflowFacts {
    if (this.closed) return this.source.deny('remote-unavailable');
    lease.assertCurrent(target.spaceId);
    const facts = this.source.facts(lease, target);
    if (facts.receipt.workflowExecution) return this.source.deny('remote-conflict');
    return facts;
  }
  private find(facts: RemoteWorkflowFacts, actorId: string): RemoteWorkflowIntent | undefined {
    const items = facts.receipt.remoteWorkflows ?? [];
    if (new Set(items.map((item) => item.actorId)).size !== items.length)
      return this.source.deny('remote-unavailable');
    return items.find((item) => item.actorId === actorId);
  }
  private exact(
    intent: RemoteWorkflowIntent | undefined,
    deviceId: string,
    keyEpoch: number,
    ref: RemoteWorkflowRef,
  ): RemoteWorkflowIntent {
    if (!intent || intent.intentId !== ref.intentId) return this.source.deny('remote-not-found');
    if (intent.deviceId !== deviceId || intent.keyEpoch !== keyEpoch)
      return this.source.deny('remote-device-mismatch');
    if (intent.generation !== ref.generation) return this.source.deny('remote-conflict');
    return intent;
  }
  private ownedRuns(facts: RemoteWorkflowFacts, intent: RemoteWorkflowIntent) {
    return facts.nodes.flatMap((node) =>
      (readExecutionRunState(node)?.runs ?? []).flatMap((run) =>
        run.remote?.workflow?.intentId === intent.intentId &&
        run.actorId === intent.actorId &&
        run.remote.deviceId === intent.deviceId
          ? [{ node, run }]
          : [],
      ),
    );
  }
  private occupied(facts: RemoteWorkflowFacts, deviceId: string): number {
    return facts.allNodes.reduce(
      (count, node) =>
        count +
        (readExecutionRunState(node)?.runs.filter(
          (run) => run.remote?.deviceId === deviceId && run.resources === 'held',
        ).length ?? 0) +
        (readExecutionReviewState(node)?.attempts.filter(
          (attempt) =>
            'remote' in attempt &&
            attempt.remote?.deviceId === deviceId &&
            attempt.resources === 'held',
        ).length ?? 0),
      0,
    );
  }
  private candidates(
    facts: RemoteWorkflowFacts,
    intent: RemoteWorkflowIntent,
    lease: ExecutionMemberLease,
    target: RemoteWorkflowTarget,
  ): RemoteWorkflowCandidate[] {
    const deviceBudget = Math.min(
      intent.budget.concurrent,
      ...[...this.arms.values()]
        .filter((arm) => arm.deviceId === intent.deviceId && arm.expiresAt > this.source.now())
        .map((arm) => arm.concurrent),
    );
    let slots = deviceBudget - this.occupied(facts, intent.deviceId);
    const result: RemoteWorkflowCandidate[] = [];
    for (const candidate of this.source.reviewCandidates?.(lease, target, intent) ?? []) {
      if (slots <= 0) break;
      if (!intent.nodeIds.includes(candidate.target.nodeId)) continue;
      result.push(candidate);
      slots--;
    }
    for (const node of facts.nodes) {
      if (slots <= 0) break;
      if (
        !intent.nodeIds.includes(node.nodeId) ||
        !facts.controlledNodeIds.includes(node.nodeId) ||
        node.command.upstreamAffected
      )
        continue;
      const state = readExecutionRunState(node),
        previous = state?.runs.at(-1);
      if (
        state?.runs.some((run) => run.resources !== 'settled') ||
        readExecutionReviewState(node)?.attempts.some((attempt) => attempt.resources !== 'settled')
      )
        continue;
      let mode: 'begin' | 'retry' | 'restart' = 'begin';
      if (node.command.status === 'failed' || node.command.status === 'cancelled') {
        if (
          !previous?.remote?.workflow ||
          previous.remote.workflow.intentId !== intent.intentId ||
          previous.remote.workflow.generation >= intent.generation
        )
          continue;
        mode = node.command.status === 'failed' ? 'retry' : 'restart';
      } else if (node.command.status !== 'ready' && node.command.status !== 'needs-revision')
        continue;
      if (
        node.handoff.dependencyNodeIds.some((id) => {
          const predecessor = facts.nodes.find((item) => item.nodeId === id);
          return (
            predecessor?.command.status !== 'completed' ||
            !predecessor.acceptedArtifactVersionId ||
            readExecutionRunState(predecessor)?.runs.some((run) => run.resources !== 'settled') ||
            readExecutionReviewState(predecessor)?.attempts.some(
              (review) => review.resources !== 'settled',
            ) ||
            !node.handoff.inputRefs.some(
              (ref) =>
                ref.sourceNodeId === id &&
                ref.artifactVersionId === predecessor.acceptedArtifactVersionId,
            )
          );
        })
      )
        continue;
      const repairs = (state?.runs ?? [])
        .filter((run) => run.remote?.workflow?.intentId === intent.intentId)
        .map((run) => run.remote!.workflow!.repairIndex);
      const repairIndex =
        node.command.status === 'needs-revision'
          ? Math.max(0, ...repairs) + 1
          : Math.max(0, ...repairs);
      if (repairIndex > intent.budget.automaticRevisions) continue;
      const executor: RemoteAcceptRequest['payload']['executor'] =
        node.handoff.assignee.kind === 'expert' && node.handoff.expertRef
          ? { kind: 'plan-expert', ref: node.handoff.expertRef }
          : { kind: 'builtin' };
      if (executor.kind === 'plan-expert' && !facts.availableExpertIds.includes(executor.ref.id))
        continue;
      result.push({
        kind: 'work',
        target: {
          spaceId: intent.spaceId,
          taskId: node.taskId,
          planId: node.planId,
          revision: node.revision,
          nodeId: node.nodeId,
        },
        expectedNodeVersion: node.command.version,
        expectedRunVersion: state?.version ?? 0,
        mode,
        executor,
        workflow: { intentId: intent.intentId, generation: intent.generation },
        repairIndex,
      });
      slots--;
    }
    return result;
  }
  private view(
    lease: ExecutionMemberLease,
    target: RemoteWorkflowTarget,
    intent: RemoteWorkflowIntent,
    sessionHash: string,
    disposition: 'applied' | 'replayed' | 'unchanged' = 'unchanged',
    next = false,
  ): RemoteWorkflowView {
    const facts = this.facts(lease, target),
      owned = this.ownedRuns(facts, intent);
    const activeWork = owned.map(({ node, run }) => this.source.runView(node, run));
    const activeReviews = [
      ...(this.source.reviewViews?.(lease, target, intent, sessionHash) ?? []),
    ];
    const held =
      owned.some(({ run }) => run.resources !== 'settled') ||
      activeReviews.some((review) => review.resources !== 'settled') ||
      !!this.preparations.get(intent.intentId)?.size;
    const complete =
      intent.nodeIds.length > 0 &&
      intent.nodeIds.every((id) => {
        const node = facts.nodes.find((item) => item.nodeId === id);
        return (
          node?.command.status === 'completed' &&
          !!node.acceptedArtifactVersionId &&
          !node.command.upstreamAffected
        );
      }) &&
      !held;
    const arm = this.live(intent, sessionHash);
    const requiresResume = intent.status === 'running' && !arm && !complete;
    const candidates = arm && next ? this.candidates(facts, intent, lease, target) : [];
    const state = complete
      ? 'completed'
      : intent.status === 'stopping'
        ? held
          ? 'stopping'
          : 'paused'
        : requiresResume
          ? 'requires-resume'
          : candidates.length
            ? 'running'
            : 'waiting';
    const attention = facts.nodes
      .filter(
        (node) =>
          intent.nodeIds.includes(node.nodeId) &&
          (node.command.upstreamAffected ||
            ['in-review', 'needs-revision', 'waiting-for-input', 'failed', 'cancelled'].includes(
              node.command.status,
            )),
      )
      .map((node) => ({
        nodeId: node.nodeId,
        code: node.command.upstreamAffected
          ? 'upstream-affected'
          : node.command.status === 'needs-revision' &&
              Math.max(
                0,
                ...(readExecutionRunState(node)?.runs ?? [])
                  .filter((run) => run.remote?.workflow?.intentId === intent.intentId)
                  .map((run) => run.remote!.workflow!.repairIndex),
              ) >= intent.budget.automaticRevisions
            ? 'rework-budget-exhausted'
            : node.command.status,
      }));
    lease.assertCurrent(target.spaceId);
    return remoteWorkflowViewSchema.parse({
      disposition,
      scope: {
        ...target,
        actorId: intent.actorId,
        deviceId: intent.deviceId,
        intentId: intent.intentId,
        generation: intent.generation,
      },
      intent,
      state,
      requiresResume,
      serverTime: this.source.now(),
      ...(arm ? { expiresAt: arm.expiresAt } : {}),
      activeWork,
      activeReviews,
      candidates,
      attention,
      revisions: intent.nodeIds.map((nodeId) => ({
        nodeId,
        used: Math.max(
          0,
          ...owned
            .filter((item) => item.node.nodeId === nodeId)
            .map(({ run }) => run.remote!.workflow!.repairIndex),
        ),
        limit: intent.budget.automaticRevisions,
      })),
    });
  }
  private replay(intent: RemoteWorkflowIntent, requestId: string, fingerprint: string): boolean {
    const receipt = intent.commandReceipts.find((item) => item.requestId === requestId);
    if (!receipt) return false;
    if (receipt.fingerprint !== fingerprint) return this.source.deny('remote-idempotency-mismatch');
    return true;
  }
  private reserveStop(intent: RemoteWorkflowIntent): void {
    // Validate both count and byte headroom using an exact-size terminal receipt.
    // Exhaustion is knowable before replacing/fencing a currently usable arm.
    if (
      !remoteWorkflowIntentSchema.safeParse({
        ...intent,
        status: 'stopping',
        version: intent.version + 1,
        commandReceipts: [
          ...intent.commandReceipts,
          {
            requestId: '00000000-0000-4000-8000-000000000000',
            kind: 'stop',
            fingerprint: '0'.repeat(64),
            generation: intent.generation,
          },
        ],
      }).success
    )
      return this.source.deny('remote-quota');
  }
  private async write(
    lease: ExecutionMemberLease,
    target: RemoteWorkflowTarget,
    next: RemoteWorkflowIntent,
  ): Promise<void> {
    const checked = remoteWorkflowIntentSchema.safeParse(next);
    if (!checked.success) return this.source.deny('remote-quota');
    if (next.status === 'running') this.reserveStop(next);
    await this.source.beforeWrite();
    const facts = this.facts(lease, target);
    const items = [
      ...(facts.receipt.remoteWorkflows ?? []).filter((item) => item.actorId !== lease.memberId),
      checked.data,
    ];
    if (items.length > REMOTE_WORKFLOW_LIMITS.intentsPerPlan)
      return this.source.deny('remote-quota');
    await this.source.write(target, { ...facts.receipt, remoteWorkflows: items });
    lease.assertCurrent(target.spaceId);
  }
  async command(
    body: RemoteWorkflowCommand,
    lease: ExecutionMemberLease,
    device: { deviceId: string; keyEpoch: number },
    sessionHash: string,
  ): Promise<RemoteWorkflowView> {
    const target = body.payload.target,
      facts = this.facts(lease, target),
      current = this.find(facts, lease.memberId);
    if (
      body.operation === 'workflow-status' &&
      !body.payload.workflow &&
      (!current || current.deviceId !== device.deviceId)
    )
      return remoteWorkflowViewSchema.parse({
        disposition: 'unchanged',
        scope: { ...target, actorId: lease.memberId, deviceId: device.deviceId },
        intent: null,
        state: 'inactive',
        requiresResume: false,
        serverTime: this.source.now(),
        activeWork: [],
        activeReviews: [],
        candidates: [],
        attention: [],
      });
    if (body.operation === 'workflow-start') {
      const fingerprint = hash({
        actorId: lease.memberId,
        deviceId: device.deviceId,
        kind: 'start',
        payload: body.payload,
      });
      if (current) {
        if (current.deviceId !== device.deviceId || current.keyEpoch !== device.keyEpoch)
          return this.source.deny('remote-device-mismatch');
        if (!this.replay(current, body.requestId, fingerprint))
          return this.source.deny('remote-conflict');
        return this.view(lease, target, current, sessionHash, 'replayed');
      }
      const nodeIds = [...new Set([...facts.controlledNodeIds, ...(facts.reviewNodeIds ?? [])])];
      if (!nodeIds.length) return this.source.deny('remote-forbidden');
      if (this.arms.size >= REMOTE_WORKFLOW_LIMITS.intentsPerPlan)
        return this.source.deny('remote-quota');
      const intent: RemoteWorkflowIntent = {
        schemaVersion: 1,
        intentId: randomUUID(),
        actorId: lease.memberId,
        spaceId: target.spaceId,
        deviceId: device.deviceId,
        keyEpoch: device.keyEpoch,
        generation: 1,
        version: 1,
        status: 'running',
        defaults: body.payload.defaults,
        budget: body.payload.budget,
        nodeIds,
        commandReceipts: [{ requestId: body.requestId, kind: 'start', fingerprint, generation: 1 }],
      };
      await this.write(lease, target, intent);
      this.facts(lease, target);
      this.arm(intent, sessionHash);
      return this.view(lease, target, intent, sessionHash, 'applied');
    }
    const ref = body.payload.workflow ?? current;
    if (!ref) return this.source.deny('remote-not-found');
    if (
      body.operation === 'workflow-resume' &&
      current &&
      current.intentId === ref.intentId &&
      current.deviceId === device.deviceId &&
      current.keyEpoch === device.keyEpoch
    ) {
      const fingerprint = hash({
        actorId: lease.memberId,
        deviceId: device.deviceId,
        kind: 'resume',
        payload: body.payload,
      });
      if (this.replay(current, body.requestId, fingerprint))
        return this.view(lease, target, current, sessionHash, 'replayed');
    }
    const intent = this.exact(current, device.deviceId, device.keyEpoch, ref);
    if (body.operation === 'workflow-status') return this.view(lease, target, intent, sessionHash);
    if (body.operation === 'workflow-next') {
      if (this.live(intent, sessionHash)) this.arm(intent, sessionHash);
      return this.view(lease, target, intent, sessionHash, 'unchanged', true);
    }
    const kind = body.operation === 'workflow-stop' ? 'stop' : 'resume';
    const fingerprint = hash({
      actorId: lease.memberId,
      deviceId: device.deviceId,
      kind,
      payload: body.payload,
    });
    const replayed = this.replay(intent, body.requestId, fingerprint);
    if (body.operation === 'workflow-stop') {
      this.fence(intent.intentId);
      const next: RemoteWorkflowIntent =
        replayed || intent.status === 'stopping'
          ? intent
          : {
              ...intent,
              status: 'stopping',
              version: intent.version + 1,
              commandReceipts: [
                ...intent.commandReceipts,
                {
                  requestId: body.requestId,
                  kind: 'stop',
                  fingerprint,
                  generation: intent.generation,
                },
              ],
            };
      if (next !== intent) await this.write(lease, target, next);
      await this.source.stop(lease, target, next, body.requestId);
      return this.view(lease, target, next, sessionHash, replayed ? 'replayed' : 'applied');
    }
    if (replayed) return this.view(lease, target, intent, sessionHash, 'replayed');
    if (body.payload.expectedVersion !== intent.version) return this.source.deny('remote-conflict');
    if (
      this.preparations.get(intent.intentId)?.size ||
      this.ownedRuns(facts, intent).some(({ run }) => run.resources !== 'settled') ||
      this.source
        .reviewViews?.(lease, target, intent, sessionHash)
        .some((review) => review.resources !== 'settled')
    )
      return this.source.deny('remote-resource-held');
    const next: RemoteWorkflowIntent = {
      ...intent,
      generation: intent.generation + 1,
      version: intent.version + 1,
      status: 'running',
      ...(body.payload.defaults ? { defaults: body.payload.defaults } : {}),
      commandReceipts: [
        ...intent.commandReceipts,
        {
          requestId: body.requestId,
          kind: 'resume',
          fingerprint,
          generation: intent.generation + 1,
        },
      ],
    };
    this.reserveStop(next);
    this.fence(intent.intentId);
    await this.write(lease, target, next);
    this.facts(lease, target);
    this.arm(next, sessionHash);
    return this.view(lease, target, next, sessionHash, 'applied');
  }
  preparing(
    body: RemoteAcceptRequest,
    lease: ExecutionMemberLease,
    sessionHash: string,
    keyEpoch: number,
  ): { readonly signal: AbortSignal; finish(cleanupConfirmed?: boolean): void } {
    const binding = this.assertAccept(body, lease, sessionHash, keyEpoch);
    return this.beginPreparation(binding);
  }
  private beginPreparation(binding: RemoteWorkflowBinding): {
    readonly signal: AbortSignal;
    finish(cleanupConfirmed?: boolean): void;
  } {
    const controller = new AbortController();
    const pending = this.preparations.get(binding.intentId) ?? new Set<AbortController>();
    pending.add(controller);
    this.preparations.set(binding.intentId, pending);
    return {
      signal: controller.signal,
      finish: (cleanupConfirmed = true) => {
        if (!cleanupConfirmed) {
          controller.abort();
          return;
        }
        pending.delete(controller);
        if (!pending.size) this.preparations.delete(binding.intentId);
      },
    };
  }
  preparingReview(
    body: RemoteReviewAcceptRequest,
    lease: ExecutionMemberLease,
    sessionHash: string,
    keyEpoch: number,
  ): { readonly signal: AbortSignal; finish(cleanupConfirmed?: boolean): void } {
    return this.beginPreparation(this.assertReviewAccept(body, lease, sessionHash, keyEpoch));
  }
  assertReviewAccept(
    body: RemoteReviewAcceptRequest,
    lease: ExecutionMemberLease,
    sessionHash: string,
    keyEpoch: number,
  ): RemoteWorkflowBinding {
    const ref = body.payload.workflow;
    if (!ref) return this.source.deny('remote-validation');
    const target = locationOf(body.payload.target),
      facts = this.facts(lease, target);
    const intent = this.exact(this.find(facts, lease.memberId), body.deviceId, keyEpoch, ref);
    if (!this.live(intent, sessionHash)) return this.source.deny('remote-recovery-required');
    if (
      canonicalPayload(body.payload.model) !== canonicalPayload(intent.defaults.model) ||
      (body.payload.capabilities.resources !== undefined &&
        body.payload.capabilities.resources !== intent.defaults.capabilities.resources)
    )
      return this.source.deny('remote-forbidden');
    const candidate = this.candidates(facts, intent, lease, target).find(
      (item) =>
        item.kind === 'review' &&
        canonicalPayload(item.target) === canonicalPayload(body.payload.target) &&
        item.reviewerRef.id === body.payload.reviewerRef.id,
    );
    if (
      !candidate ||
      candidate.kind !== 'review' ||
      candidate.expectedReviewVersion !== body.payload.expectedReviewVersion ||
      candidate.reviewerRef.version !== body.payload.reviewerRef.version
    )
      return this.source.deny('remote-conflict');
    return { ...ref, repairIndex: 0 };
  }
  assertAccept(
    body: RemoteAcceptRequest,
    lease: ExecutionMemberLease,
    sessionHash: string,
    keyEpoch: number,
  ): RemoteWorkflowBinding {
    const ref = body.payload.workflow;
    if (!ref) return this.source.deny('remote-validation');
    const target = locationOf(body.payload.target),
      facts = this.facts(lease, target);
    const intent = this.exact(this.find(facts, lease.memberId), body.deviceId, keyEpoch, ref);
    if (!this.live(intent, sessionHash)) return this.source.deny('remote-recovery-required');
    if (canonicalPayload(body.payload.model) !== canonicalPayload(intent.defaults.model))
      return this.source.deny('remote-forbidden');
    const selected = intent.defaults.workspace,
      actual = body.payload.workspace;
    if (
      selected.kind !== actual.kind ||
      (selected.kind === 'local' &&
        (actual.kind !== 'local' ||
          selected.rootId !== actual.rootId ||
          (selected.access === 'read' && actual.access !== 'read')))
    )
      return this.source.deny('remote-forbidden');
    const permitted = { ...intent.defaults.capabilities },
      offered = { ...body.payload.capabilities };
    for (const field of ['acceptedInput', 'acceptedFile', 'knowledge', 'resources'] as const) {
      if (offered[field] !== undefined && offered[field] !== permitted[field])
        return this.source.deny('remote-forbidden');
      delete offered[field];
      delete permitted[field];
    }
    if (
      offered.localTools.some(
        (tool) =>
          !permitted.localTools.some(
            (allowed) => canonicalPayload(allowed) === canonicalPayload(tool),
          ),
      ) ||
      canonicalPayload({ ...offered, localTools: [] }) !==
        canonicalPayload({ ...permitted, localTools: [] })
    )
      return this.source.deny('remote-forbidden');
    const candidate = this.candidates(facts, intent, lease, target).find(
      (item) => item.kind === 'work' && item.target.nodeId === body.payload.target.nodeId,
    );
    if (
      !candidate ||
      candidate.kind !== 'work' ||
      canonicalPayload(candidate.target) !== canonicalPayload(body.payload.target) ||
      candidate.expectedNodeVersion !== body.payload.expectedNodeVersion ||
      candidate.expectedRunVersion !== body.payload.expectedRunVersion ||
      candidate.mode !== body.payload.mode ||
      canonicalPayload(candidate.executor) !== canonicalPayload(body.payload.executor)
    )
      return this.source.deny('remote-conflict');
    return { ...ref, repairIndex: candidate.repairIndex };
  }
  assertExisting(
    lease: ExecutionMemberLease,
    scope: RemoteRunView['scope'],
    ref: RemoteWorkflowRef,
    deviceId: string,
    keyEpoch: number,
  ): void {
    const facts = this.facts(lease, locationOf(scope));
    const intent = this.exact(this.find(facts, lease.memberId), deviceId, keyEpoch, ref);
    if (intent.status !== 'running') return this.source.deny('remote-permit-revoked');
  }
}
