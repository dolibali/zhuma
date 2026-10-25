import { z } from 'zod';
import { canonicalPayload, isTerminalRunStatus, type ExecutionNodeRecord } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import { requireExecutionRunWriter } from './execution-run-protocol.js';
import type {
  NativeWorkAction,
  NativeWorkGrant,
  NativeWorkScope,
} from './native-work-session-contract.js';
import {
  ExecutionRunError,
  executionRunScope,
  readExecutionRunState,
  type ExecutionRun,
  type ExecutionWorkspace,
} from './execution-run-state.js';

const id = z.string().min(1).max(200);
const locatorSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  nodeId: id,
  runId: id,
});
export type ExecutionRunLocator = z.infer<typeof locatorSchema>;

/** B mints this from the original MemberRequest and live private resolver/session facts.
 * A MemberResolution snapshot, browser payload, or preconfigured member id cannot implement it.
 */
export interface ExecutionMemberLease {
  readonly memberId: string;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
  assertCurrent(spaceId: string): void;
  release(): void;
}
export interface ExecutionRunAuthoritySource {
  /** Current persisted execution global, including the old-Host writer barrier. */
  writerState(): unknown;
  /** Must do the existing Host/Origin/cookie checks, including session/source lifetime. */
  memberLease(request: MemberRequest): Promise<ExecutionMemberLease>;
  /** Current node fact from B's one execution owner. Never a caller's cached record. */
  readNode(locator: ExecutionRunLocator): ExecutionNodeRecord | undefined;
  /** Current task/assignee/read access; throws on unknown/unavailable facts. */
  assertNodeAccess(
    memberId: string,
    spaceId: string,
    node: ExecutionNodeRecord,
    action: NativeWorkAction,
  ): void;
  /** True Host-selected capability, including device/root/generation and current access. */
  assertWorkspace(
    memberId: string,
    spaceId: string,
    workspace: ExecutionWorkspace,
    access: 'read' | 'write',
    configurationId: string,
  ): void;
  /** Post-durable domain changes AND resolver/directory replacement/unmount invalidation. */
  onChange(recheck: () => void): () => void;
  readonly signal: AbortSignal;
}
export interface ExecutionRunCleanupAuthority {
  readonly scope: NativeWorkScope;
  /** This cannot drive a model or submit a product. Only native cleanup facts may use it. */
  assertCurrent(kind: 'failed' | 'stop-pending' | 'stopped' | 'cleanup'): void;
}
export interface OpenedExecutionRunAuthority {
  readonly grant: NativeWorkGrant;
  /** Created with driving authority, retained internally when that member logs out. */
  readonly cleanup?: ExecutionRunCleanupAuthority;
  dispose(): void;
}

function denied(): never {
  throw new ExecutionRunError('run-authority-denied');
}
function fingerprint(run: ExecutionRun): string {
  return canonicalPayload({
    actorId: run.actorId,
    spaceId: run.spaceId,
    segmentId: run.segmentId,
    runId: run.attempt.id,
    generation: run.attempt.generation,
    selection: run.selection,
    workspace: run.workspace,
  });
}
interface OwnedAuthority {
  readonly grant: NativeWorkGrant;
  readonly lease: ExecutionMemberLease;
  readonly controller: AbortController;
  readonly check: (action: NativeWorkAction) => void;
  readonly dispose: () => void;
}

/** Host-only capability manager, not an HTTP service or a second execution state owner.
 * Required B source ports fail closed until actually wired. UI request abort never enters
 * these lifetime signals: closing a view must not cancel an admitted native Run.
 */
export class ExecutionRunAuthorities {
  private readonly owned = new Set<OwnedAuthority>();
  private readonly grants = new WeakSet<object>();
  private readonly cleanups = new WeakSet<object>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly unsubscribe: () => void;
  private fenced = false;
  private disposed = false;
  private closing: Promise<void> | undefined;
  private releaseFailed = false;

  constructor(private readonly source: ExecutionRunAuthoritySource) {
    if (
      !source ||
      [
        'writerState',
        'memberLease',
        'readNode',
        'assertNodeAccess',
        'assertWorkspace',
        'onChange',
      ].some((key) => typeof (source as unknown as Record<string, unknown>)[key] !== 'function') ||
      !(source.signal instanceof AbortSignal)
    )
      throw new ExecutionRunError('run-authority-unavailable');
    this.unsubscribe = source.onChange(() => this.recheck());
    source.signal.addEventListener('abort', this.onSourceAbort, { once: true });
    if (source.signal.aborted) this.fence();
  }
  private readonly onSourceAbort = () => this.fence();

  private current(
    locator: ExecutionRunLocator,
    requireWriter = true,
  ): {
    node: ExecutionNodeRecord;
    run: ExecutionRun;
    current: boolean;
  } {
    let node: ExecutionNodeRecord | undefined;
    try {
      if (requireWriter) requireExecutionRunWriter(this.source.writerState());
      node = this.source.readNode(locator);
    } catch {
      return denied();
    }
    if (
      !node ||
      node.taskId !== locator.taskId ||
      node.planId !== locator.planId ||
      node.revision !== locator.revision ||
      node.nodeId !== locator.nodeId
    )
      return denied();
    const state = readExecutionRunState(node);
    const run = state?.runs.find((r) => r.attempt.id === locator.runId);
    if (!run) return denied();
    return { node, run, current: state!.currentRunId === run.attempt.id };
  }
  open(
    request: MemberRequest,
    rawLocator: unknown,
    purpose: 'drive' | 'read',
  ): Promise<OpenedExecutionRunAuthority> {
    if (this.fenced || this.disposed || this.source.signal.aborted)
      return Promise.reject(new ExecutionRunError('run-authority-denied'));
    const parsed = locatorSchema.safeParse(rawLocator);
    if (!parsed.success || !['drive', 'read'].includes(purpose))
      return Promise.reject(new ExecutionRunError('run-validation'));
    if (this.owned.size + this.pending.size >= 256)
      return Promise.reject(new ExecutionRunError('run-capacity'));
    // Admit before the first awaited resolver call so final close can drain late leases.
    const work = Promise.resolve().then(() => this.openNow(request, parsed.data, purpose));
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }
  private async openNow(
    request: MemberRequest,
    locator: ExecutionRunLocator,
    purpose: 'drive' | 'read',
  ): Promise<OpenedExecutionRunAuthority> {
    let lease: ExecutionMemberLease;
    try {
      lease = await this.source.memberLease(request);
    } catch {
      return denied();
    }
    let released = false;
    let ownedDispose: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      try {
        lease.release();
      } catch {
        this.releaseFailed = true;
      }
    };
    try {
      if (
        this.fenced ||
        this.disposed ||
        this.source.signal.aborted ||
        !lease ||
        typeof lease.memberId !== 'string' ||
        !lease.memberId ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= Date.now() ||
        !(lease.signal instanceof AbortSignal) ||
        typeof lease.assertCurrent !== 'function' ||
        typeof lease.release !== 'function'
      )
        return denied();
      const initial = this.current(locator);
      const scope = executionRunScope(initial.node, initial.run);
      const bound = fingerprint(initial.run);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let disposed = false;
      const check = (action: NativeWorkAction) => {
        if (
          disposed ||
          this.fenced ||
          this.disposed ||
          this.source.signal.aborted ||
          controller.signal.aborted ||
          lease.signal.aborted ||
          Date.now() >= lease.expiresAt
        )
          return denied();
        if (!['open', 'send', 'queue', 'stop', 'history', 'follow'].includes(action))
          return denied();
        if (purpose === 'read' && ['send', 'queue', 'stop'].includes(action)) return denied();
        lease.assertCurrent(scope.spaceId);
        const latest = this.current(locator);
        if (fingerprint(latest.run) !== bound) return denied();
        this.source.assertNodeAccess(lease.memberId, scope.spaceId, latest.node, action);
        if (purpose === 'drive') {
          // This port checks controller/task permissions, not the Run's stop phase.
          this.source.assertNodeAccess(lease.memberId, scope.spaceId, latest.node, 'send');
          if (
            !latest.current ||
            latest.run.actorId !== lease.memberId ||
            isTerminalRunStatus(latest.run.attempt.status) ||
            latest.run.resources !== 'held'
          )
            return denied();
          if (['send', 'queue'].includes(action) && latest.run.attempt.stopPhase !== 'none')
            return denied();
        }
        this.source.assertWorkspace(
          lease.memberId,
          scope.spaceId,
          latest.run.workspace,
          purpose === 'drive' && latest.run.workspace.kind === 'local'
            ? latest.run.workspace.access
            : 'read',
          latest.run.selection.configurationId,
        );
      };
      const grant: NativeWorkGrant = Object.freeze({
        scope,
        signal: controller.signal,
        assertCurrent: (action: NativeWorkAction) => {
          try {
            check(action);
          } catch {
            // A denied send while stopping must not revoke the stop/cleanup wait.
            try {
              check('open');
            } catch {
              ownedDispose?.();
            }
            return denied();
          }
        },
      });
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        lease.signal.removeEventListener('abort', onRevoked);
        this.owned.delete(owned);
        controller.abort();
        release();
      };
      const onRevoked = () => dispose();
      const owned: OwnedAuthority = { grant, lease, controller, check, dispose };
      ownedDispose = dispose;
      check('open');
      this.owned.add(owned);
      this.grants.add(grant);
      // Expiration interrupts a model already awaiting I/O, not only its next tool gate.
      const expire = () => {
        if (disposed) return;
        const remaining = lease.expiresAt - Date.now();
        if (remaining <= 0) dispose();
        else {
          timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
          timer.unref();
        }
      };
      expire();
      lease.signal.addEventListener('abort', onRevoked, { once: true });
      if (lease.signal.aborted) dispose();
      grant.assertCurrent('open');
      const cleanup = purpose === 'drive' ? this.makeCleanup(locator, initial.run) : undefined;
      return Object.freeze({ grant, ...(cleanup ? { cleanup } : {}), dispose });
    } catch {
      if (ownedDispose) ownedDispose();
      else release();
      return denied();
    }
  }
  private makeCleanup(
    locator: ExecutionRunLocator,
    run: ExecutionRun,
  ): ExecutionRunCleanupAuthority {
    const initial = this.current(locator);
    const scope = executionRunScope(initial.node, run);
    const bound = fingerprint(run);
    const authority = Object.freeze({
      scope,
      assertCurrent: (kind: 'failed' | 'stop-pending' | 'stopped' | 'cleanup') => {
        if (this.disposed || !['failed', 'stop-pending', 'stopped', 'cleanup'].includes(kind))
          return denied();
        const latest = this.current(locator, false);
        if (!latest.current || fingerprint(latest.run) !== bound) return denied();
      },
    });
    this.cleanups.add(authority);
    return authority;
  }
  /** B-only post-commit hook. Read the already durable-backed Run before awaiting member
   * setup, so a member expiring after begin cannot strand its reserved resource claim.
   * It permits cleanup, never driving, history or product submission.
   */
  cleanupAfterCommit(rawLocator: unknown): ExecutionRunCleanupAuthority {
    if (this.disposed) return denied();
    const parsed = locatorSchema.safeParse(rawLocator);
    if (!parsed.success) return denied();
    const current = this.current(parsed.data);
    if (!current.current || current.run.resources !== 'held') return denied();
    return this.makeCleanup(parsed.data, current.run);
  }
  /** B checks object identity as well as the closure before accepting an internal event. */
  assertGrant(grant: NativeWorkGrant, action: NativeWorkAction): void {
    if (!this.grants.has(grant)) return denied();
    grant.assertCurrent(action);
  }
  assertCleanup(
    authority: ExecutionRunCleanupAuthority,
    kind: 'failed' | 'stop-pending' | 'stopped' | 'cleanup',
  ): void {
    if (!this.cleanups.has(authority)) return denied();
    authority.assertCurrent(kind);
  }
  /** Post-durable mutations are hints to re-read facts, never a separate permission cache. */
  recheck(): void {
    for (const owned of [...this.owned]) {
      try {
        owned.check('open');
      } catch {
        owned.dispose();
      }
    }
  }
  /** Fence issuance and driving first; internal cleanup remains possible until final close. */
  fence(): void {
    if (this.fenced) return;
    this.fenced = true;
    for (const owned of [...this.owned]) owned.dispose();
  }
  /** A calls after native idle/resource drain and B's cleanup commits, before storage close. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.fence();
    this.disposed = true;
    this.source.signal.removeEventListener('abort', this.onSourceAbort);
    try {
      this.unsubscribe();
    } catch {
      this.releaseFailed = true;
    }
    void Promise.allSettled([...this.pending]).then(() => {
      if (this.releaseFailed) reject(new ExecutionRunError('run-authority-unavailable'));
      else resolve();
    });
    return this.closing;
  }
}
