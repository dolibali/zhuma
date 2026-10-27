import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import {
  WORKSPACE_APPROVAL_LIMITS as limits,
  WorkspaceApprovalError,
  workspaceApprovalCommandSchema,
  workspaceApprovalIdentitySchema,
  workspaceApprovalStateSchema,
  workspaceApprovalPolicySchema,
  type WorkspaceApprovalCommand,
  type WorkspaceApprovalHostSource,
  type WorkspaceApprovalIdentity,
  type WorkspaceApprovalMutation,
  type WorkspaceApprovalOutcome,
  type WorkspaceApprovalOwner,
  type WorkspaceApprovalQualification,
  type WorkspaceApprovalRow,
  type WorkspaceApprovalRun,
  type WorkspaceApprovalState,
} from './execution-workspace-approval-contract.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const fail = (code: string): never => {
  throw new WorkspaceApprovalError(code);
};
const outcome = <T>(value: T): WorkspaceApprovalOutcome<T> => ({ ok: true, value });
const scopeSchema = z.strictObject({
  spaceId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
});
export const workspaceApprovalId = (
  actorId: string,
  spaceId: string,
  projectId: string,
  workspaceId: string,
) => `approval_${hash([actorId, spaceId, projectId, workspaceId])}`;
export const workspaceApprovalFingerprint = (actorId: string, command: WorkspaceApprovalCommand) =>
  hash({ actorId, command });
export interface WorkspaceApprovalMember {
  readonly actorId: string;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  release(): void;
}
/** D passes closures over the ALREADY opened execution domain and queue. A
 * never receives this writer or supplies member identities in JSON. */
export interface WorkspaceApprovalServiceSource {
  readonly signal: AbortSignal;
  read(): unknown;
  write(state: WorkspaceApprovalState): Promise<void>;
  assertCompatible(hasState: boolean): void;
  enableWriter(): Promise<void>;
  enqueue<T>(
    work: () => Promise<WorkspaceApprovalOutcome<T>>,
  ): Promise<WorkspaceApprovalOutcome<T>>;
  member(
    original: MemberRequest,
    scope: { spaceId: string; projectId: string },
  ): Promise<WorkspaceApprovalMember>;
  runs(): readonly WorkspaceApprovalRun[];
  assertDrained(run: WorkspaceApprovalRun): undefined;
  notify(): void;
}
function readState(source: WorkspaceApprovalServiceSource): WorkspaceApprovalState | undefined {
  const raw = source.read();
  source.assertCompatible(raw !== undefined);
  if (raw === undefined) return undefined;
  const parsed = workspaceApprovalStateSchema.safeParse(raw);
  if (!parsed.success) return fail('workspace-approval-incompatible');
  for (const row of parsed.data.approvals)
    if (
      row.id !==
      workspaceApprovalId(row.actorId, row.spaceId, row.projectId, row.identity.workspaceId)
    )
      return fail('workspace-approval-incompatible');
  return parsed.data;
}
function normalized(raw: unknown, operation: 'approve' | 'revoke'): WorkspaceApprovalCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.hasOwn(raw, 'operation'))
    return fail('workspace-approval-validation');
  const parsed = workspaceApprovalCommandSchema.safeParse({ ...raw, operation });
  if (!parsed.success) return fail('workspace-approval-validation');
  if (parsed.data.operation === 'approve') {
    const publish = parsed.data.publish.slice().sort((a, b) => {
      const x = `${a.kind}:${a.path}`,
        y = `${b.kind}:${b.path}`;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return { ...parsed.data, publish };
  }
  return parsed.data;
}
function identities(runs: readonly WorkspaceApprovalRun[]) {
  return runs.map(({ resources: _resources, ...value }) => canonicalPayload(value)).sort();
}

/** Original domain owner. This class stores approvals and receipts, never IO
 * grants, agents or another execution state machine. */
export class ExecutionWorkspaceApprovals {
  private readonly lifetime = new AbortController();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private poisoned = false;
  private readonly stopSource: () => void;
  private readonly hostSignal: AbortSignal;
  private readonly prepare: WorkspaceApprovalHostSource['prepare'];
  readonly owner: WorkspaceApprovalOwner;
  constructor(
    private readonly source: WorkspaceApprovalServiceSource,
    private readonly host: WorkspaceApprovalHostSource,
  ) {
    if (
      !host ||
      !(host.signal instanceof AbortSignal) ||
      host.signal.aborted ||
      typeof host.prepare !== 'function'
    )
      fail('workspace-approval-unavailable');
    this.hostSignal = host.signal;
    this.prepare = host.prepare;
    readState(source);
    const stop = () => this.fence();
    source.signal.addEventListener('abort', stop, { once: true });
    host.signal.addEventListener('abort', stop, { once: true });
    this.stopSource = () => {
      source.signal.removeEventListener('abort', stop);
      this.hostSignal.removeEventListener('abort', stop);
    };
    this.owner = Object.freeze({
      list: (original, scope, wait) => this.list(original, scope, wait),
      approve: (original, command, wait) => this.mutate(original, command, 'approve', wait),
      revoke: (original, command, wait) => this.mutate(original, command, 'revoke', wait),
      snapshot: () => {
        this.active();
        return structuredClone({ state: readState(source), runs: this.runs() });
      },
      onChange: (listener) => {
        this.active();
        if (typeof listener !== 'function' || this.listeners.size >= 256)
          return fail('workspace-approval-capacity');
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    } satisfies WorkspaceApprovalOwner);
    if (source.signal.aborted) this.fence();
  }
  private active() {
    if (
      this.closed ||
      this.poisoned ||
      this.lifetime.signal.aborted ||
      this.source.signal.aborted ||
      this.host.signal !== this.hostSignal ||
      this.hostSignal.aborted ||
      this.host.prepare !== this.prepare
    )
      return fail('workspace-approval-unavailable');
  }
  private runs(): readonly WorkspaceApprovalRun[] {
    const runs = this.source.runs();
    if (runs.length > limits.observedRuns) return fail('workspace-approval-capacity');
    return structuredClone(runs);
  }
  private notify() {
    for (const listener of [() => this.source.notify(), ...this.listeners]) {
      try {
        const value: unknown = listener();
        if (value !== undefined) void Promise.resolve(value).catch(() => undefined);
      } catch {
        /* Notifications cannot undo the durable approval/tombstone. */
      }
    }
  }
  private invoke<T>(
    wait: AbortSignal | undefined,
    work: (signal: AbortSignal, cleanup: (() => unknown)[]) => Promise<WorkspaceApprovalOutcome<T>>,
  ): Promise<WorkspaceApprovalOutcome<T>> {
    if (wait !== undefined && !(wait instanceof AbortSignal))
      return Promise.resolve({
        ok: false,
        error: { code: 'workspace-approval-validation', message: '工作区授权操作未完成。' },
      });
    if (this.jobs.size >= limits.concurrent)
      return Promise.resolve({
        ok: false,
        error: { code: 'workspace-approval-capacity', message: '工作区授权操作未完成。' },
      });
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.source.signal,
      this.hostSignal,
      ...(wait ? [wait] : []),
    ]);
    const job = Promise.resolve().then(async (): Promise<WorkspaceApprovalOutcome<T>> => {
      const cleanup: (() => unknown)[] = [];
      let result: WorkspaceApprovalOutcome<T>;
      try {
        this.active();
        if (signal.aborted) fail('workspace-approval-cancelled');
        result = await work(signal, cleanup);
      } catch (error) {
        result = {
          ok: false,
          error: {
            code:
              error instanceof WorkspaceApprovalError
                ? error.code
                : 'workspace-approval-unavailable',
            message: '工作区授权操作未完成。',
          },
        };
      }
      for (const release of cleanup.reverse()) {
        try {
          const value = release();
          if (value !== undefined) {
            await Promise.resolve(value);
            this.poisoned = true;
          }
        } catch {
          this.poisoned = true;
        }
      }
      if (this.poisoned) {
        this.lifetime.abort();
        this.notify();
      }
      return result; // Never claim that an accepted durable put was rolled back.
    });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return job;
  }
  private async member(
    original: MemberRequest,
    scope: { spaceId: string; projectId: string },
    signal: AbortSignal,
    cleanup: (() => unknown)[],
  ) {
    const member = await this.source.member(original, scope);
    const { actorId, signal: memberSignal, assertCurrent, release } = member;
    if (typeof release === 'function') cleanup.push(() => release.call(member));
    else this.poisoned = true;
    if (
      typeof assertCurrent !== 'function' ||
      typeof release !== 'function' ||
      !(memberSignal instanceof AbortSignal)
    )
      return fail('workspace-approval-unauthenticated');
    const check = () => {
      this.active();
      if (signal.aborted || memberSignal.aborted) fail('workspace-approval-cancelled');
      if (
        member.actorId !== actorId ||
        member.signal !== memberSignal ||
        member.assertCurrent !== assertCurrent ||
        member.release !== release
      )
        fail('workspace-approval-unauthenticated');
      const value: unknown = assertCurrent.call(member);
      if (value !== undefined) {
        cleanup.push(() => value);
        fail('workspace-approval-unauthenticated');
      }
    };
    check();
    return { actorId, check };
  }
  private list(
    original: MemberRequest,
    raw: unknown,
    wait?: AbortSignal,
  ): Promise<WorkspaceApprovalOutcome<readonly WorkspaceApprovalRow[]>> {
    const parsed = scopeSchema.safeParse(raw);
    if (!parsed.success)
      return Promise.resolve({
        ok: false,
        error: { code: 'workspace-approval-validation', message: '工作区授权操作未完成。' },
      });
    return this.invoke(wait, async (signal, cleanup) => {
      const member = await this.member(original, parsed.data, signal, cleanup);
      return this.source.enqueue(async () => {
        member.check();
        const state = readState(this.source);
        return outcome(
          structuredClone(
            state?.approvals.filter(
              (row) =>
                row.actorId === member.actorId &&
                row.spaceId === parsed.data.spaceId &&
                row.projectId === parsed.data.projectId,
            ) ?? [],
          ),
        );
      });
    });
  }
  private mutate(
    original: MemberRequest,
    raw: unknown,
    operation: 'approve' | 'revoke',
    wait?: AbortSignal,
  ): Promise<WorkspaceApprovalOutcome<WorkspaceApprovalMutation>> {
    let command: WorkspaceApprovalCommand;
    try {
      command = normalized(raw, operation);
    } catch {
      return Promise.resolve({
        ok: false,
        error: { code: 'workspace-approval-validation', message: '工作区授权操作未完成。' },
      });
    }
    return this.invoke(wait, async (signal, cleanup) => {
      const member = await this.member(original, command, signal, cleanup);
      const fingerprint = workspaceApprovalFingerprint(member.actorId, command);
      const id =
        command.operation === 'approve'
          ? workspaceApprovalId(
              member.actorId,
              command.spaceId,
              command.projectId,
              command.workspaceId,
            )
          : command.approvalId;
      const current = () => {
        member.check();
        const state = readState(this.source),
          row = state?.approvals.find((row) => row.id === id);
        if (
          row &&
          (row.actorId !== member.actorId ||
            row.spaceId !== command.spaceId ||
            row.projectId !== command.projectId)
        )
          return fail('workspace-approval-not-found');
        const receiptRow = state?.approvals.find(
          (item) =>
            item.actorId === member.actorId &&
            item.receipts.some((receipt) => receipt.requestId === command.requestId),
        );
        const receipt = receiptRow?.receipts.find((item) => item.requestId === command.requestId);
        if (receipt && (receiptRow?.id !== row?.id || receipt.fingerprint !== fingerprint))
          return fail('workspace-approval-idempotency-mismatch');
        if (receipt)
          return {
            state,
            row: row!,
            replay: { disposition: 'replayed' as const, receipt, current: row! },
          };
        if (command.operation === 'revoke' && !row) return fail('workspace-approval-not-found');
        if ((row?.generation ?? 0) !== command.expectedGeneration)
          return fail('workspace-approval-conflict');
        return { state, row, replay: undefined };
      };
      const initial = await this.source.enqueue(async () => outcome(current()));
      if (!initial.ok) return initial;
      if (initial.value.replay) return outcome(structuredClone(initial.value.replay));
      const runs = command.operation === 'approve' ? this.runs() : [],
        runFingerprint = canonicalPayload(identities(runs));
      const qualification = await this.prepare.call(
        this.host,
        original,
        structuredClone({
          actorId: member.actorId,
          command,
          existing: initial.value.row,
          snapshot: initial.value.state,
          runs,
          commandFingerprint: fingerprint,
        }),
        signal,
      );
      const captured = this.qualification(qualification, fingerprint, command, cleanup);
      const checkRuns = () => {
        if (command.operation !== 'approve') return;
        const fresh = this.runs();
        if (canonicalPayload(identities(fresh)) !== runFingerprint)
          return fail('workspace-approval-conflict');
        for (const scope of captured.conflicts) {
          const run = fresh.find(
            (item) => canonicalPayload(item.scope) === canonicalPayload(scope),
          );
          if (!run) return fail('workspace-approval-source-changed');
          if (run.resources === 'held') return fail('workspace-approval-busy');
          const value: unknown = this.source.assertDrained(run);
          if (value !== undefined) {
            cleanup.push(() => value);
            return fail('workspace-approval-recovery-required');
          }
        }
      };
      return this.source.enqueue<WorkspaceApprovalMutation>(async () => {
        const latest = current();
        if (latest.replay) return outcome(structuredClone(latest.replay));
        captured.check();
        member.check();
        checkRuns();
        const { state, mutation } = this.propose(
          latest.state,
          latest.row,
          member.actorId,
          command,
          fingerprint,
          captured.identity,
        );
        await this.source.enableWriter(); // Safe compatibility-marker-only crash prefix.
        const rechecked = current();
        if (rechecked.replay) return outcome(structuredClone(rechecked.replay));
        captured.check();
        checkRuns();
        member.check();
        if (canonicalPayload(rechecked.state ?? null) !== canonicalPayload(latest.state ?? null))
          return fail('workspace-approval-conflict');
        try {
          await this.source.write(structuredClone(state));
        } catch {
          // A lost durable-put reply does not create a second authorization.
          const stored = readState(this.source);
          if (canonicalPayload(stored ?? null) !== canonicalPayload(state))
            return fail('workspace-approval-unavailable');
        }
        this.notify();
        return outcome(structuredClone(mutation));
      });
    });
  }
  private qualification(
    lease: WorkspaceApprovalQualification,
    fingerprint: string,
    command: WorkspaceApprovalCommand,
    cleanup: (() => unknown)[],
  ) {
    const signal = lease?.signal,
      assert = lease?.assertCurrent,
      release = lease?.release;
    if (typeof release === 'function') cleanup.push(() => release.call(lease));
    else this.poisoned = true;
    if (
      !(signal instanceof AbortSignal) ||
      typeof assert !== 'function' ||
      typeof release !== 'function'
    )
      return fail('workspace-approval-unavailable');
    const identity =
      command.operation === 'approve'
        ? workspaceApprovalIdentitySchema.parse(lease.identity)
        : undefined;
    if (
      !Array.isArray(lease.conflictingRunScopes) ||
      lease.conflictingRunScopes.length > limits.observedRuns
    )
      return fail('workspace-approval-unavailable');
    const conflicts = structuredClone(lease.conflictingRunScopes);
    const facts = canonicalPayload({
      identity: lease.identity ?? null,
      conflicts,
      fingerprint: lease.commandFingerprint,
    });
    const unchanged = () => {
      this.active();
      if (
        signal.aborted ||
        lease.signal !== signal ||
        lease.assertCurrent !== assert ||
        lease.release !== release ||
        lease.commandFingerprint !== fingerprint ||
        (command.operation === 'approve' && identity?.workspaceId !== command.workspaceId) ||
        canonicalPayload({
          identity: lease.identity ?? null,
          conflicts: lease.conflictingRunScopes,
          fingerprint: lease.commandFingerprint,
        }) !== facts
      )
        return fail('workspace-approval-source-changed');
    };
    const check = () => {
      unchanged();
      const value: unknown = assert.call(lease);
      if (value !== undefined) {
        cleanup.push(() => value);
        return fail('workspace-approval-unavailable');
      }
      unchanged();
    };
    check();
    return { identity, conflicts, check };
  }
  private propose(
    previous: WorkspaceApprovalState | undefined,
    row: WorkspaceApprovalRow | undefined,
    actorId: string,
    command: WorkspaceApprovalCommand,
    fingerprint: string,
    identity: WorkspaceApprovalIdentity | undefined,
  ) {
    if (
      command.expectedGeneration >=
      Number.MAX_SAFE_INTEGER - (command.operation === 'approve' ? 1 : 0)
    )
      return fail('workspace-approval-capacity');
    if (
      command.operation === 'approve' &&
      row &&
      canonicalPayload(row.identity) !== canonicalPayload(identity)
    )
      return fail('workspace-approval-source-changed');
    const generation = command.expectedGeneration + 1,
      status = command.operation === 'approve' ? ('approved' as const) : ('revoked' as const);
    const receipt = {
      requestId: command.requestId,
      fingerprint,
      expectedGeneration: command.expectedGeneration,
      generation,
      status,
    };
    const next: WorkspaceApprovalRow = {
      id:
        row?.id ??
        workspaceApprovalId(actorId, command.spaceId, command.projectId, identity!.workspaceId),
      actorId,
      spaceId: command.spaceId,
      projectId: command.projectId,
      identity: identity ?? row!.identity,
      generation,
      status,
      ...(command.operation === 'approve'
        ? {
            policy: workspaceApprovalPolicySchema.parse({
              access: command.access,
              publish: command.publish,
            }),
          }
        : {}),
      receipts: [...(row?.receipts ?? []), receipt].slice(-limits.receipts),
    };
    const candidate = {
      schemaVersion: 1 as const,
      deviceId: previous?.deviceId ?? randomUUID(),
      approvals: row
        ? previous!.approvals.map((item) => (item.id === row.id ? next : item))
        : [...(previous?.approvals ?? []), next],
    };
    const parsed = workspaceApprovalStateSchema.safeParse(candidate);
    // Tombstone receipt growth must also preserve every remaining active
    // approval's revocation allowance. A revoke spends only its own reserve.
    const reserve =
      candidate.approvals.filter((item) => item.status === 'approved').length *
      limits.revokeReserveBytes;
    if (
      !parsed.success ||
      Buffer.byteLength(JSON.stringify(candidate)) + reserve > limits.stateBytes
    )
      return fail('workspace-approval-capacity');
    return {
      state: parsed.data,
      mutation: { disposition: 'applied' as const, receipt, current: next },
    };
  }
  fence(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.notify();
  }
  async close(): Promise<void> {
    this.fence();
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    this.closed = true;
    this.stopSource();
    this.listeners.clear();
    if (this.poisoned) fail('workspace-approval-cleanup-failed');
  }
}
