import {
  canonicalPayload,
  remoteRunViewSchema,
  type RemoteRunView,
  type RemoteRunMigration,
} from '@zhuma/agent-core';
import { ExecutionRunError } from './execution-run-state.js';
import type {
  OpenedExecutionRunMigration,
  ExecutionRunMigrationGrant,
} from './execution-run-authority.js';
import {
  nativeScopeSchema,
  nativeSelectionSchema,
  nativeWorkSessionKey,
  validMigrationPair,
} from './native-work-session-record.js';
import type {
  NativeWorkGrant,
  NativeWorkScope,
  NativeSessionSelection,
  NativeMigrationOriginRequest,
  NativeMigrationOrigin,
  NativeMigrationDrain,
} from './native-work-session-contract.js';

/** Installed by C's actual local owner. assertGrant must verify its private
 * current accepted handle and fresh backend deadline, never a deserialized read handle. */
export interface RemoteRunMigrationSource {
  readonly signal: AbortSignal;
  assertGrant(grant: NativeWorkGrant): undefined;
  current(grant: NativeWorkGrant): {
    readonly view: RemoteRunView;
    readonly selection: NativeSessionSelection;
  };
  migrationOrigin(query: NativeMigrationOriginRequest): NativeMigrationOrigin;
  migrationDrain(previousScope: NativeWorkScope): NativeMigrationDrain | undefined;
}
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);
function denied(): never {
  throw new ExecutionRunError('run-authority-denied');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function synchronous(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => undefined);
    denied();
  }
}

/** Private local qualification of D's original durable remote Run lineage.
 * No new store or HTTP operation. Native origin is metadata; migrate separately
 * requires the original SDK/source drain, just like the original local lane. */
export class RemoteRunMigrationAuthorities {
  private closed = false;
  private readonly issued = new WeakSet<ExecutionRunMigrationGrant>();
  private readonly owned = new Set<() => void>();
  constructor(private readonly source: RemoteRunMigrationSource) {
    if (
      !(source?.signal instanceof AbortSignal) ||
      source.signal.aborted ||
      ['assertGrant', 'current', 'migrationOrigin', 'migrationDrain'].some(
        (key) => typeof Reflect.get(source, key) !== 'function',
      )
    )
      denied();
    source.signal.addEventListener('abort', () => this.close(), { once: true });
  }
  close(): void {
    this.closed = true;
    for (const dispose of this.owned) dispose();
  }
  open(driving: NativeWorkGrant): OpenedExecutionRunMigration {
    const source = this.source,
      assert = source.assertGrant,
      current = source.current,
      originProducer = source.migrationOrigin,
      drainProducer = source.migrationDrain,
      sourceSignal = source.signal;
    // Private issuer before inspecting purported grant scope/signal.
    synchronous(assert.call(source, driving));
    const drivingSignal = driving?.signal;
    if (!(drivingSignal instanceof AbortSignal) || drivingSignal.aborted) denied();
    const drivingScope = nativeScopeSchema.parse(driving.scope),
      controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sourceSignal, drivingSignal]);
    let disposed = false,
      drain: NativeMigrationDrain | undefined;
    const active = () => {
      if (
        disposed ||
        this.closed ||
        signal.aborted ||
        source.signal !== sourceSignal ||
        source.assertGrant !== assert ||
        source.current !== current ||
        source.migrationOrigin !== originProducer ||
        source.migrationDrain !== drainProducer ||
        driving.signal !== drivingSignal ||
        !same(driving.scope, drivingScope)
      )
        denied();
      synchronous(assert.call(source, driving));
    };
    const facts = () => {
      active();
      const raw = current.call(source, driving),
        view = remoteRunViewSchema.parse(raw.view),
        selection = nativeSelectionSchema.parse(raw.selection);
      active();
      const { backendId: _backend, ...scope } = view.scope;
      if (
        !same(scope, drivingScope) ||
        view.authority !== 'drive' ||
        view.resources !== 'held' ||
        view.runStatus !== 'requested' ||
        view.nextSequence !== 1 ||
        view.stopRequested ||
        !view.migration
      )
        denied();
      this.history(view, view.migration);
      return { view, selection, scope, migration: view.migration };
    };
    const initial = facts();
    const query: NativeMigrationOriginRequest = freeze({
      requestId: initial.migration.requestId,
      inputFingerprint: initial.migration.inputFingerprint,
      scope: structuredClone(initial.scope),
      selection: structuredClone(initial.selection),
    });
    // Only this initial pure lookup. Never repeat it inside C's own mapping slot.
    const origin = originProducer.call(source, query),
      previousScope = nativeScopeSchema.parse(origin.scope),
      previousSelection = nativeSelectionSchema.parse(origin.selection);
    const index = initial.migration.predecessors.findIndex((entry) => {
      const { backendId: _backend, ...scope } = entry.scope;
      return same(scope, previousScope) && same(entry.selection, previousSelection);
    });
    if (index < 0 || !validMigrationPair(previousScope, initial.scope)) denied();
    if (
      initial.migration.predecessors
        .slice(index + 1)
        .some(
          (entry) =>
            entry.dispatch !== 'reserved' ||
            entry.acknowledged ||
            entry.nativeSessionId !== undefined ||
            entry.nativeAgentId !== undefined ||
            entry.sessionDiscarded !== undefined,
        )
    )
      denied();
    const snapshot = (value: ReturnType<typeof facts>) =>
      canonicalPayload({
        scope: value.view.scope,
        deviceId: value.view.deviceId,
        permitId: value.view.permit.id,
        permitEpoch: value.view.permit.epoch,
        selection: value.selection,
        migration: value.migration,
      });
    const bound = snapshot(initial);
    const check = (phase: 'prepare' | 'migrate') => {
      if (snapshot(facts()) !== bound) denied();
      if (phase === 'prepare') return;
      const actual = drainProducer.call(source, previousScope);
      if (!actual) {
        if (drain) denied();
        throw new ExecutionRunError('run-migration-pending');
      }
      if (
        !(actual.signal instanceof AbortSignal) ||
        actual.signal.aborted ||
        typeof actual.assertCurrent !== 'function' ||
        !['flushed-and-closed', 'absent-unadmitted'].includes(actual.basis) ||
        (drain && (drain.signal !== actual.signal || drain.basis !== actual.basis))
      )
        denied();
      synchronous(actual.assertCurrent());
      if (drain) synchronous(drain.assertCurrent());
      else {
        drain = actual;
        drain.signal.addEventListener('abort', dispose, { once: true });
      }
      active();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.owned.delete(dispose);
      drivingSignal.removeEventListener('abort', dispose);
      sourceSignal.removeEventListener('abort', dispose);
      drain?.signal.removeEventListener('abort', dispose);
      controller.abort();
    };
    const grant: ExecutionRunMigrationGrant = Object.freeze({
      requestId: query.requestId,
      inputFingerprint: query.inputFingerprint,
      previousScope: freeze(structuredClone(previousScope)),
      scope: freeze(structuredClone(query.scope)),
      selection: freeze(structuredClone(query.selection)),
      signal,
      assertCurrent(this: ExecutionRunMigrationGrant, ...args: unknown[]) {
        if (
          this !== grant ||
          args.length !== 1 ||
          !['prepare', 'migrate'].includes(args[0] as string)
        )
          denied();
        const phase = args[0] as 'prepare' | 'migrate';
        try {
          check(phase);
        } catch (error) {
          // Pending original drain still allows the original authorized preparation.
          if (
            phase === 'migrate' &&
            !drain &&
            error instanceof ExecutionRunError &&
            error.code === 'run-migration-pending'
          ) {
            try {
              check('prepare');
            } catch {
              dispose();
              denied();
            }
            throw error;
          }
          dispose();
          denied();
        }
      },
    });
    try {
      check('prepare');
    } catch {
      dispose();
      denied();
    }
    this.owned.add(dispose);
    this.issued.add(grant);
    drivingSignal.addEventListener('abort', dispose, { once: true });
    sourceSignal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted) {
      dispose();
      denied();
    }
    return Object.freeze({ grant, dispose });
  }
  assertMigration(grant: ExecutionRunMigrationGrant, phase: 'prepare' | 'migrate'): void {
    if (!this.issued.has(grant)) denied();
    grant.assertCurrent(phase);
  }
  private history(view: RemoteRunView, migration: RemoteRunMigration): void {
    const ids = new Set<string>(),
      segments = new Set<string>();
    let generation = 0;
    const first = migration.predecessors[0]!;
    const { backendId: _backend, ...next } = view.scope;
    if (migration.predecessors.length !== next.generation - 1) denied();
    for (const [index, entry] of migration.predecessors.entries()) {
      const { backendId, ...scope } = entry.scope;
      if (
        backendId !== view.scope.backendId ||
        entry.deviceId !== view.deviceId ||
        entry.keyEpoch !== first.keyEpoch ||
        nativeWorkSessionKey(scope) !== nativeWorkSessionKey(next) ||
        entry.scope.generation !== index + 1 ||
        entry.scope.generation <= generation ||
        entry.scope.generation >= view.scope.generation ||
        ids.has(scope.runId) ||
        segments.has(scope.segmentId) ||
        !validMigrationPair(scope, next) ||
        entry.resources !== 'settled' ||
        !['completed', 'failed', 'cancelled'].includes(entry.runStatus)
      )
        denied();
      ids.add(scope.runId);
      segments.add(scope.segmentId);
      generation = scope.generation;
    }
  }
}
