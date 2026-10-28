import { z } from 'zod';
import { canonicalPayload, isTerminalRunStatus, type ExecutionNodeRecord } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import { requireExecutionRunWriter } from './execution-run-protocol.js';
import type {
  NativeWorkAction,
  NativeWorkGrant,
  NativeWorkScope,
  NativeSessionSelection,
  NativeScopeCleanupAuthority,
} from './native-work-session-contract.js';
import {
  ExecutionRunError,
  executionRunScope,
  readExecutionRunState,
  type ExecutionRun,
  type ExecutionWorkspace,
  type ExecutionRunState,
} from './execution-run-state.js';

const id = z.string().min(1).max(200);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const locatorSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  runId: id,
});
const migrationOriginSchema = z.strictObject({
  scope: locatorSchema.extend({
    actorId: id,
    spaceId: id,
    generation: positive,
    segmentId: id,
  }),
  // Equality with the already validated B selection below is the whitelist.
  selection: z.unknown(),
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
  /** Read-only metadata from the SAME C owner. Issuance calls only after member/B
   * authorization; absent/unknown/inflight/failed facts refuse, never guess a neighbor.
   * This is neither migration permission nor physical drain evidence.
   */
  migrationOrigin?(query: ExecutionRunMigrationQuery): ExecutionRunMigrationOrigin;
  /** C's actual old-scope stop/flush/source-drain proof, not B's persisted settled label.
   * Undefined means still pending. Its closure/signal must track the real native owner.
   * Optional for old consumers: migration alone refuses when this port is absent.
   */
  migrationDrain?(previousScope: NativeWorkScope): ExecutionRunMigrationDrain | undefined;
}
export interface ExecutionRunMigrationDrain {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface ExecutionRunMigrationQuery {
  readonly requestId: string;
  readonly inputFingerprint: string;
  readonly scope: NativeWorkScope;
  readonly selection: NativeSessionSelection;
}
export interface ExecutionRunMigrationOrigin {
  readonly scope: NativeWorkScope;
  readonly selection: NativeSessionSelection;
}
/** Structurally matches C's frozen NativeRunMigrationGrant. Host-only, never deserialized. */
export interface ExecutionRunMigrationGrant {
  readonly requestId: string;
  readonly inputFingerprint: string;
  readonly previousScope: NativeWorkScope;
  readonly scope: NativeWorkScope;
  readonly selection: NativeSessionSelection;
  readonly signal: AbortSignal;
  assertCurrent(phase: 'prepare' | 'migrate'): void;
}
export interface OpenedExecutionRunMigration {
  readonly grant: ExecutionRunMigrationGrant;
  dispose(): void;
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
/** Borrowed from a genuine current drive grant. Only C may consume this for old-scope cleanup. */
export interface ExecutionUnadmittedCleanupAuthority extends NativeScopeCleanupAuthority {
  readonly signal: AbortSignal;
}

function denied(): never {
  throw new ExecutionRunError('run-authority-denied');
}
function synchronousValue<T>(value: T): T {
  if (
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof Reflect.get(value, 'then') === 'function'
  ) {
    void Promise.resolve(value).catch(() => undefined);
    return denied();
  }
  return value;
}
function synchronousAssertion(value: unknown): void {
  if (synchronousValue(value) !== undefined) return denied();
}
function fingerprint(run: ExecutionRun): string {
  return canonicalPayload({
    actorId: run.actorId,
    spaceId: run.spaceId,
    segmentId: run.segmentId,
    runId: run.attempt.id,
    generation: run.attempt.generation,
    payloadHash: run.attempt.payloadHash,
    contextRefs: run.attempt.contextRefs,
    expertVersionId: run.attempt.expertVersionId,
    entryNodeStatus: run.attempt.entryNodeStatus,
    selection: run.selection,
    workspace: run.workspace,
  });
}
interface OwnedAuthority {
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
  private readonly migrations = new WeakSet<object>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly unsubscribe: () => void;
  private fenced = false;
  private disposed = false;
  private closing: Promise<void> | undefined;
  private releaseFailed = false;
  private readonly ownerSignal: AbortSignal;

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
    this.ownerSignal = source.signal;
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
    state: ExecutionRunState;
  } {
    let node: ExecutionNodeRecord | undefined;
    try {
      if (requireWriter) requireExecutionRunWriter(synchronousValue(this.source.writerState()));
      node = synchronousValue(this.source.readNode(locator));
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
    if (!run || run.remote) return denied();
    return { node, run, current: state!.currentRunId === run.attempt.id, state: state! };
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
        synchronousAssertion(lease.assertCurrent(scope.spaceId));
        const latest = this.current(locator);
        if (fingerprint(latest.run) !== bound) return denied();
        synchronousAssertion(
          this.source.assertNodeAccess(lease.memberId, scope.spaceId, latest.node, action),
        );
        if (purpose === 'drive') {
          // This port checks controller/task permissions, not the Run's stop phase.
          synchronousAssertion(
            this.source.assertNodeAccess(lease.memberId, scope.spaceId, latest.node, 'send'),
          );
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
        synchronousAssertion(
          this.source.assertWorkspace(
            lease.memberId,
            scope.spaceId,
            latest.run.workspace,
            purpose === 'drive' && latest.run.workspace.kind === 'local'
              ? latest.run.workspace.access
              : 'read',
            latest.run.selection.configurationId,
          ),
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
      const owned: OwnedAuthority = { lease, controller, check, dispose };
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
  /** Eligibility for first-binding recovery only. Neither this nor a persisted
   * settled flag is physical absence evidence; A must obtain C's real drain.
   */
  unadmittedCleanup(currentDriveGrant: NativeWorkGrant): ExecutionUnadmittedCleanupAuthority {
    const source = this.source,
      ownerSignal = this.ownerSignal;
    const ports = {
      writerState: source.writerState,
      memberLease: source.memberLease,
      readNode: source.readNode,
      assertNodeAccess: source.assertNodeAccess,
      assertWorkspace: source.assertWorkspace,
      onChange: source.onChange,
    };
    const pair = () => {
      if (
        source.signal !== ownerSignal ||
        ownerSignal.aborted ||
        typeof this.unsubscribe !== 'function' ||
        Object.entries(ports).some(([name, method]) => Reflect.get(source, name) !== method)
      )
        return denied();
      this.assertGrant(currentDriveGrant, 'send');
      const current = this.current(currentDriveGrant.scope);
      const { run, node, state } = current;
      const scope = executionRunScope(node, run);
      const noAdmission = (item: ExecutionRun) =>
        !item.attempt.acknowledged &&
        item.attempt.sessionId === undefined &&
        item.attempt.executorRunId === undefined &&
        item.attempt.sessionDiscarded === undefined &&
        item.attempt.modelLabel === undefined &&
        item.dispatch === 'reserved' &&
        item.attempt.stopPhase === 'none';
      if (
        !current.current ||
        canonicalPayload(scope) !== canonicalPayload(currentDriveGrant.scope) ||
        run.attempt.status !== 'requested' ||
        run.resources !== 'held' ||
        !noAdmission(run) ||
        state.runs.length < 2 ||
        state.runs.some(
          (item) =>
            item.actorId !== scope.actorId ||
            item.spaceId !== scope.spaceId ||
            state.receipts.filter((receipt) => receipt.requestId === item.attempt.idempotencyKey)
              .length !== 1 ||
            !state.receipts.some(
              (receipt) =>
                receipt.requestId === item.attempt.idempotencyKey &&
                receipt.actorId === scope.actorId &&
                receipt.runId === item.attempt.id,
            ),
        ) ||
        state.runs
          .slice(0, -1)
          .some(
            (item) =>
              item.attempt.status !== 'failed' ||
              item.resources !== 'settled' ||
              !noAdmission(item),
          )
      )
        return denied();
      const previous = state.runs.at(-2);
      if (
        !previous ||
        previous.attempt.generation + 1 !== scope.generation ||
        previous.segmentId === scope.segmentId
      )
        return denied();
      return { node, scope: executionRunScope(node, previous) };
    };
    let initial: ReturnType<typeof pair>;
    try {
      initial = pair();
    } catch {
      return denied();
    }
    const bound = canonicalPayload(initial.node),
      scope = Object.freeze({ ...initial.scope });
    return Object.freeze({
      scope,
      signal: currentDriveGrant.signal,
      assertCurrent: (): undefined => {
        try {
          const current = pair();
          if (
            canonicalPayload(current.node) !== bound ||
            canonicalPayload(current.scope) !== canonicalPayload(scope)
          )
            return denied();
          return undefined;
        } catch {
          return denied();
        }
      },
    });
  }
  private migrationCurrent(locator: ExecutionRunLocator) {
    const current = this.current(locator);
    const receipt = current.state.receipts.find(
      (item) =>
        item.requestId === current.run.attempt.idempotencyKey &&
        item.actorId === current.run.actorId &&
        item.runId === current.run.attempt.id,
    );
    if (
      !current.current ||
      current.state.runs.length < 2 ||
      current.run.resources !== 'held' ||
      current.run.attempt.status !== 'requested' ||
      current.run.attempt.acknowledged ||
      current.run.attempt.sessionId !== undefined ||
      current.run.attempt.stopPhase !== 'none' ||
      !receipt
    )
      return denied();
    return {
      ...current,
      receipt,
      scope: executionRunScope(current.node, current.run),
      requestId: current.run.attempt.idempotencyKey,
    };
  }
  private migrationPair(locator: ExecutionRunLocator, rawOrigin: unknown) {
    const current = this.migrationCurrent(locator);
    const parsed = migrationOriginSchema.safeParse(rawOrigin);
    if (!parsed.success) return denied();
    const previousIndex = current.state.runs.findIndex(
      (run) =>
        canonicalPayload(executionRunScope(current.node, run)) ===
        canonicalPayload(parsed.data.scope),
    );
    if (previousIndex < 0 || previousIndex >= current.state.runs.length - 1) return denied();
    const history = current.state.runs.slice(previousIndex);
    const previous = history[0]!;
    if (
      canonicalPayload(previous.selection) !== canonicalPayload(parsed.data.selection) ||
      history.some(
        (run) =>
          run.remote || run.actorId !== current.run.actorId || run.spaceId !== current.run.spaceId,
      ) ||
      history
        .slice(0, -1)
        .some((run) => !isTerminalRunStatus(run.attempt.status) || run.resources !== 'settled') ||
      history
        .slice(1, -1)
        .some(
          (run) =>
            run.attempt.acknowledged ||
            run.attempt.sessionId !== undefined ||
            run.attempt.executorRunId !== undefined ||
            run.attempt.sessionDiscarded !== undefined ||
            run.dispatch !== 'reserved',
        )
    )
      return denied();
    return {
      ...current,
      previous,
      history,
      previousScope: executionRunScope(current.node, previous),
    };
  }
  /** Only a new, already durable attempt supplies a migration. No raw scope pair,
   * selection, idempotency key, old snapshot or drive/read grant is accepted as input.
   */
  openMigration(request: MemberRequest, rawLocator: unknown): Promise<OpenedExecutionRunMigration> {
    if (this.fenced || this.disposed || this.source.signal.aborted)
      return Promise.reject(new ExecutionRunError('run-authority-denied'));
    const parsed = locatorSchema.safeParse(rawLocator);
    if (!parsed.success) return Promise.reject(new ExecutionRunError('run-validation'));
    if (this.owned.size + this.pending.size >= 256)
      return Promise.reject(new ExecutionRunError('run-capacity'));
    const work = Promise.resolve().then(() => this.migrationNow(request, parsed.data));
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }
  private async migrationNow(
    request: MemberRequest,
    locator: ExecutionRunLocator,
  ): Promise<OpenedExecutionRunMigration> {
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
        lease.signal.aborted ||
        typeof lease.assertCurrent !== 'function' ||
        typeof lease.release !== 'function'
      )
        return denied();
      const candidate = this.migrationCurrent(locator);
      const assertAccess = (pair: ReturnType<typeof this.migrationCurrent>) => {
        if (lease.memberId !== pair.run.actorId) return denied();
        lease.assertCurrent(pair.run.spaceId);
        this.source.assertNodeAccess(lease.memberId, pair.run.spaceId, pair.node, 'send');
        this.source.assertWorkspace(
          lease.memberId,
          pair.run.spaceId,
          pair.run.workspace,
          pair.run.workspace.kind === 'local' ? pair.run.workspace.access : 'read',
          pair.run.selection.configurationId,
        );
      };
      assertAccess(candidate);
      const originProducer = this.source.migrationOrigin;
      if (typeof originProducer !== 'function') return denied();
      const query: ExecutionRunMigrationQuery = Object.freeze({
        requestId: candidate.requestId,
        inputFingerprint: candidate.run.attempt.payloadHash,
        scope: candidate.scope,
        selection: Object.freeze(structuredClone(candidate.run.selection)),
      });
      const initial = this.migrationPair(locator, originProducer.call(this.source, query));
      // A reentrant metadata reader may have observed/mutated a different B target.
      // Do not bind an origin found for a changed key, input, scope or configuration.
      if (
        initial.requestId !== query.requestId ||
        initial.run.attempt.payloadHash !== query.inputFingerprint ||
        canonicalPayload(initial.scope) !== canonicalPayload(query.scope) ||
        canonicalPayload(initial.run.selection) !== canonicalPayload(query.selection)
      )
        return denied();
      const origin: ExecutionRunMigrationOrigin = Object.freeze({
        scope: initial.previousScope,
        selection: Object.freeze(structuredClone(initial.previous.selection)),
      });
      const snapshot = (pair: ReturnType<typeof this.migrationPair>) =>
        canonicalPayload([pair.requestId, pair.scope, pair.receipt, pair.history]);
      const bound = snapshot(initial);
      const controller = new AbortController();
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let drain: ExecutionRunMigrationDrain | undefined;
      let drainProducer: ExecutionRunAuthoritySource['migrationDrain'];
      const check = (phase: 'prepare' | 'migrate') => {
        if (
          disposed ||
          this.fenced ||
          this.disposed ||
          this.source.signal.aborted ||
          this.source.migrationOrigin !== originProducer ||
          controller.signal.aborted ||
          lease.signal.aborted ||
          drain?.signal.aborted ||
          Date.now() >= lease.expiresAt
        )
          return denied();
        // The lookup is deliberately NOT repeated inside C's own migration slot.
        // B history stays live; C independently rechecks its current/replay and drain.
        const latest = this.migrationPair(locator, origin);
        if (snapshot(latest) !== bound) return denied();
        assertAccess(latest);
        if (phase === 'prepare') return;
        const producer = this.source.migrationDrain;
        if (typeof producer !== 'function') {
          if (drain) return denied();
          throw new ExecutionRunError('run-authority-unavailable');
        }
        const current = producer.call(this.source, latest.previousScope);
        if (!current) {
          if (drain) return denied();
          throw new ExecutionRunError('run-migration-pending');
        }
        if (
          !(current.signal instanceof AbortSignal) ||
          current.signal.aborted ||
          typeof current.assertCurrent !== 'function'
        )
          return denied();
        if (drain && (drainProducer !== producer || drain.signal !== current.signal))
          return denied();
        current.assertCurrent();
        if (drain) drain.assertCurrent();
        else {
          // Only bind a real ready epoch AFTER C has performed authorized preparation.
          drain = current;
          drainProducer = producer;
          drain.signal.addEventListener('abort', onRevoked, { once: true });
          if (drain.signal.aborted) return denied();
        }
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        lease.signal.removeEventListener('abort', onRevoked);
        drain?.signal.removeEventListener('abort', onRevoked);
        this.owned.delete(owned);
        controller.abort();
        release();
      };
      const onRevoked = () => dispose();
      ownedDispose = dispose;
      const grant: ExecutionRunMigrationGrant = Object.freeze({
        requestId: initial.requestId,
        inputFingerprint: initial.run.attempt.payloadHash,
        previousScope: initial.previousScope,
        scope: initial.scope,
        selection: Object.freeze(structuredClone(initial.run.selection)),
        signal: controller.signal,
        assertCurrent(this: ExecutionRunMigrationGrant, ...args: readonly unknown[]) {
          // C calls this method on the exact issued object. Copying its closure must not
          // authorize a different scope/selection carried by a reconstructed object.
          if (this !== grant) return denied();
          // Neither a NativeWorkAction nor a zero-argument snapshot is a migration phase.
          if (args.length !== 1 || !['prepare', 'migrate'].includes(args[0] as string))
            return denied();
          const phase = args[0] as 'prepare' | 'migrate';
          try {
            check(phase);
          } catch (error) {
            // No ready C proof yet blocks mapping advancement, not the cleanup needed to
            // establish it. Once bound, never silently adopt a replacement resource epoch.
            if (
              phase === 'migrate' &&
              !drain &&
              error instanceof ExecutionRunError &&
              ['run-migration-pending', 'run-authority-unavailable'].includes(error.code)
            ) {
              try {
                check('prepare');
              } catch {
                dispose();
                return denied();
              }
              throw error;
            }
            dispose();
            return denied();
          }
        },
      });
      const owned: OwnedAuthority = {
        lease,
        controller,
        check: () => check(drain ? 'migrate' : 'prepare'),
        dispose,
      };
      check('prepare');
      this.owned.add(owned);
      this.migrations.add(grant);
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
      check('prepare');
      return Object.freeze({ grant, dispose });
    } catch {
      if (ownedDispose) ownedDispose();
      else release();
      return denied();
    }
  }
  assertMigration(grant: ExecutionRunMigrationGrant, phase: 'prepare' | 'migrate'): void {
    if (!this.migrations.has(grant)) return denied();
    grant.assertCurrent(phase);
  }
  private makeCleanup(
    locator: ExecutionRunLocator,
    run: ExecutionRun,
    settledOnly = false,
  ): ExecutionRunCleanupAuthority {
    const initial = this.current(locator);
    const scope = executionRunScope(initial.node, run);
    const bound = fingerprint(run);
    const authority = Object.freeze({
      scope,
      assertCurrent: (kind: 'failed' | 'stop-pending' | 'stopped' | 'cleanup') => {
        if (this.disposed || !['failed', 'stop-pending', 'stopped', 'cleanup'].includes(kind))
          return denied();
        if (settledOnly && kind !== 'cleanup') return denied();
        const latest = this.current(locator, false);
        if (!latest.current || fingerprint(latest.run) !== bound) return denied();
        if (
          settledOnly &&
          (latest.run.resources !== 'settled' || !isTerminalRunStatus(latest.run.attempt.status))
        )
          return denied();
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
  /** Host-only recovery after fresh member and exact workflow authorization.
   * The persisted terminal/settled facts permit rechecking physical cleanup;
   * they are not a native drain certificate. This cannot record failure/stop,
   * drive a session or submit a product. The old held-Run hook stays separate.
   */
  cleanupAfterSettlement(rawLocator: unknown): ExecutionRunCleanupAuthority {
    if (this.disposed || this.fenced || this.source.signal.aborted) return denied();
    const parsed = locatorSchema.safeParse(rawLocator);
    if (!parsed.success) return denied();
    const current = this.current(parsed.data);
    if (
      !current.current ||
      current.run.resources !== 'settled' ||
      !isTerminalRunStatus(current.run.attempt.status)
    )
      return denied();
    return this.makeCleanup(parsed.data, current.run, true);
  }
  /** Host-only recovery of a receipt-bound historical reservation, after A's
   * fresh member/intent authorization. Both terminal Runs stay fixed across C's
   * real cleanup; this capability itself never certifies physical drain.
   */
  cleanupSettledHistoricalReservation(
    rawLocator: unknown,
    expectedCurrentRunId: string,
  ): ExecutionRunCleanupAuthority {
    const parsed = locatorSchema.safeParse(rawLocator);
    const expected = id.safeParse(expectedCurrentRunId);
    if (!parsed.success || !expected.success || parsed.data.runId === expected.data)
      return denied();
    const signal = this.ownerSignal;
    const readNode = this.source.readNode;
    const writerState = this.source.writerState;
    const active = () => {
      if (
        this.disposed ||
        this.fenced ||
        signal.aborted ||
        this.source.signal !== signal ||
        this.source.readNode !== readNode ||
        this.source.writerState !== writerState
      )
        return denied();
    };
    const pair = () => {
      active();
      const old = this.current(parsed.data);
      active();
      const current = old.state.runs.find((run) => run.attempt.id === expected.data);
      if (
        old.current ||
        old.state.currentRunId !== expected.data ||
        !current ||
        old.run.resources !== 'settled' ||
        current.resources !== 'settled' ||
        !isTerminalRunStatus(old.run.attempt.status) ||
        !isTerminalRunStatus(current.attempt.status) ||
        old.run.actorId !== current.actorId ||
        old.run.spaceId !== current.spaceId
      )
        return denied();
      return { old, current };
    };
    const snapshot = ({ old, current }: ReturnType<typeof pair>) =>
      canonicalPayload([
        old.state.version,
        executionRunScope(old.node, old.run),
        old.run,
        old.state.currentRunId,
        current,
      ]);
    let initial: ReturnType<typeof pair>;
    try {
      initial = pair();
    } catch {
      return denied();
    }
    const bound = snapshot(initial);
    let invalid = false;
    const authority: ExecutionRunCleanupAuthority = Object.freeze({
      scope: executionRunScope(initial.old.node, initial.old.run),
      assertCurrent(this: ExecutionRunCleanupAuthority, ...args: readonly unknown[]) {
        if (this !== authority || args.length !== 1 || args[0] !== 'cleanup' || invalid)
          return denied();
        try {
          if (snapshot(pair()) !== bound) return denied();
        } catch {
          invalid = true;
          return denied();
        }
      },
    });
    this.cleanups.add(authority);
    return authority;
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
