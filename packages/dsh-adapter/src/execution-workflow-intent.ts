import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalPayload, type ExecutionNodeRecord } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import type { BeginRunRequest, ExecutionResult, PlanReceipt } from './execution-service.js';
import { readExecutionRunState, type ExecutionRun } from './execution-run-state.js';
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
  private readonly operations = new Set<Promise<unknown>>();
  private readonly retained = new Set<WorkflowMember>();
  private readonly released = new WeakSet<WorkflowMember>();
  /** Same-Host fence + original queue barrier proves these reservations never
   * acquired a Run. This evidence intentionally does not survive a cold start. */
  private readonly cancelled = new Set<string>();
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
    const found: {
      reservation: WorkflowStartReservation;
      node: ExecutionNodeRecord;
      run: ExecutionRun;
    }[] = [];
    for (const reservation of intent.starts) {
      const node = facts.nodes.find((item) => item.nodeId === reservation.nodeId);
      if (!node) return fail('workflow-incompatible');
      const state = readExecutionRunState(node);
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
    let drained = active.length === 0;
    if (drained)
      for (const { node, run } of bound) {
        try {
          member.assertDrained(node, run);
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
    });
  }
  private replay(intent: WorkflowExecutionIntent, requestId: string, fingerprint: string) {
    const prior = intent.commandReceipts.find((item) => item.requestId === requestId);
    if (!prior) return false;
    if (prior.fingerprint !== fingerprint) return fail('workflow-idempotency-mismatch');
    return true;
  }
  private async write(
    location: WorkflowLocation,
    facts: WorkflowFacts,
    intent: WorkflowExecutionIntent,
  ) {
    if (!facts.receipt) return fail('workflow-plan-incomplete');
    if (
      intent.starts.length >
      facts.receipt.nodeIds.length *
        Math.min(intent.generation, WORKFLOW_EXECUTION_LIMITS.commandReceipts)
    )
      return fail('workflow-capacity');
    const checked = workflowExecutionIntentSchema.safeParse(intent);
    if (!checked.success) return fail('workflow-capacity');
    await this.source.write(location, { ...facts.receipt, workflowExecution: checked.data });
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
        if (!current || current.intentId !== input.intentId) return fail('workflow-not-found');
        this.owner(location, member, current);
        const fingerprint = hash({ kind: 'resume', memberId: member.memberId, ...input });
        if (this.replay(current, input.requestId, fingerprint))
          return ok(this.view(location, member, 'replayed'));
        if (current.generation !== input.generation) return fail('workflow-stale-generation');
        if (current.version !== input.expectedVersion) return fail('workflow-conflict');
        if (current.status === 'completed') return fail('workflow-completed');
        const bound = this.bound(facts, current);
        if (bound.some(({ run }) => run.resources !== 'settled'))
          return fail('workflow-recovery-required');
        for (const { node, run } of bound) member.assertDrained(node, run);
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
        if (old) {
          this.fence(old);
          this.rememberCancelled(current, bound);
        }
        const next = {
          ...current,
          generation: current.generation + 1,
          version: current.version + 1,
          status: 'running' as const,
        };
        next.commandReceipts = this.receipt(next, 'resume', input.requestId, fingerprint);
        member.facts(true);
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
      const before = this.intent(member.facts(true));
      if (!before || before.intentId !== input.intentId) return fail('workflow-not-found');
      this.owner(location, member, before);
      if (before.generation !== input.generation) return fail('workflow-stale-generation');
      const arm = this.arms.get(keyOf(location));
      if (arm && arm.generation === input.generation) this.fence(arm);
      return this.source.enqueue(async () => {
        const facts = member.facts(true),
          current = this.intent(facts);
        if (!current || current.intentId !== input.intentId) return fail('workflow-not-found');
        this.owner(location, member, current);
        if (current.generation !== input.generation) return fail('workflow-stale-generation');
        const fingerprint = hash({ kind: 'stop', memberId: member.memberId, ...input });
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
        return ok(
          Object.freeze({
            view: this.view(location, member),
            tickets: Object.freeze(tickets),
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
          }),
        );
      }),
    );
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
      input.composition.payload.tools.kind !== intent.defaults.tools ||
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
