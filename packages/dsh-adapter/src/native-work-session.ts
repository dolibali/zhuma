import { createHash, randomUUID } from 'node:crypto';
import {
  NativeWorkError,
  type NativeMessageMode,
  type NativeMessageReceipt,
  type NativeSessionBinding,
  type NativeSessionSelection,
  type NativeWorkAction,
  type NativeWorkGrant,
  type NativeWorkRuntime,
  type NativeWorkScope,
  type NativeWorkStorage,
  type NativeInputReadReservation,
  type NativeRunMigrationGrant,
  type NativeRunMigrationResult,
  type NativeBindingReference,
  type NativeMigrationDrain,
} from './native-work-session-contract.js';

export const NATIVE_WORK_LIMITS = Object.freeze({
  messageChars: 16_384,
  receipts: 256,
  historyEvents: 100,
});
export const NATIVE_INPUT_READ_LIMITS = Object.freeze({
  attempts: 16,
  bytes: 65_536,
  pageBytes: 24_576,
});

// Native persistence locking alone is not a same-process, cross-Host I/O
// fence. Keep only an ephemeral owner/drain, never content or authority facts.
const activeInputReads = new Map<
  string,
  { readonly owner: NativeWorkRuntime; readonly drain: Promise<void> }
>();
export function assertNativeInputReadOwner(sessionId: string, runtime: NativeWorkRuntime): void {
  const active = activeInputReads.get(sessionId);
  if (active && active.owner !== runtime) throw new NativeWorkError('input-read-busy');
}

import {
  nativeWorkSessionKey,
  nativeScopeKey,
  currentBinding,
  bindingForScope,
  readNativeRecord,
  nativeMigrationDataSchema,
  nativeScopeSchema,
  migrationFingerprint,
  validMigrationPair,
  NATIVE_LINEAGE_LIMITS,
} from './native-work-session-record.js';
export { nativeWorkSessionKey } from './native-work-session-record.js';
import { inspectNativeMigration, appendNativeMigration } from './native-work-session-migration.js';

function sameScope(a: NativeWorkScope, b: NativeWorkScope): boolean {
  return (
    nativeWorkSessionKey(a) === nativeWorkSessionKey(b) &&
    a.runId === b.runId &&
    a.generation === b.generation &&
    a.segmentId === b.segmentId
  );
}

function sameSelection(a: NativeSessionSelection, b: NativeSessionSelection): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.reasoningEffort === b.reasoningEffort &&
    a.maxTokens === b.maxTokens &&
    a.configurationId === b.configurationId
  );
}

function check(grant: NativeWorkGrant, action: NativeWorkAction): void {
  if (grant.signal.aborted) throw new NativeWorkError('cancelled');
  const s = grant.scope;
  if (
    [s.actorId, s.spaceId, s.taskId, s.planId, s.nodeId, s.runId, s.segmentId].some(
      (value) => typeof value !== 'string' || value.length === 0 || value.length > 200,
    ) ||
    !Number.isSafeInteger(s.revision) ||
    s.revision < 1 ||
    !Number.isSafeInteger(s.generation) ||
    s.generation < 1
  )
    throw new NativeWorkError('invalid-request');
  grant.assertCurrent(action);
}

function textInput(value: string): void {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > NATIVE_WORK_LIMITS.messageChars
  )
    throw new NativeWorkError('invalid-request');
}

/**
 * A single Host service. This owns mappings/receipts, never Execution Run state,
 * the AgentLoop, or transcript bodies. A supplies transport; B supplies grants.
 */
export class NativeWorkSessionService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly stopEpochs = new Map<string, number>();
  private readonly retiredScopes = new Set<string>();
  private readonly unknownMigrations = new Set<string>();
  private readonly migrating = new Map<
    string,
    {
      readonly requestId: string;
      readonly fingerprint: string;
      readonly work: Promise<NativeRunMigrationResult>;
    }
  >();
  private readonly scopeEpochs = new Map<string, number>();
  private readonly scopeActivity = new Map<string, Set<Promise<unknown>>>();
  private readonly prepared = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly signal: AbortSignal;
      readonly epoch: number;
      readonly native: NativeMigrationDrain;
      readonly binding: NativeBindingReference;
      readonly digest: string;
    }
  >();
  private inputReadsSealed = false;
  private readonly inputReadDrains = new Map<string, Promise<void>>();
  private readonly inputReadReservations = new WeakMap<
    NativeInputReadReservation,
    {
      readonly key: string;
      readonly scope: NativeWorkScope;
      readonly epoch: number;
      readonly release: () => void;
    }
  >();
  constructor(
    private readonly storage: NativeWorkStorage,
    private readonly runtime: NativeWorkRuntime,
  ) {}

  private touchScope(scope: NativeWorkScope): void {
    const key = nativeScopeKey(scope);
    this.scopeEpochs.set(key, (this.scopeEpochs.get(key) ?? 0) + 1);
    this.prepared.get(key)?.controller.abort();
  }
  private trackScope<T>(scope: NativeWorkScope, work: Promise<T>): Promise<T> {
    const key = nativeScopeKey(scope);
    let active = this.scopeActivity.get(key);
    if (!active) this.scopeActivity.set(key, (active = new Set()));
    active.add(work);
    void work
      .finally(() => {
        active.delete(work);
        if (!active.size) this.scopeActivity.delete(key);
      })
      .catch(() => undefined);
    return work;
  }
  private async whenScopeIdle(scope: NativeWorkScope): Promise<void> {
    while (this.scopeActivity.get(nativeScopeKey(scope))?.size)
      await Promise.allSettled(this.scopeActivity.get(nativeScopeKey(scope))!);
  }

  private serial<T>(
    grant: NativeWorkGrant,
    action: NativeWorkAction,
    operation: (verify: () => void) => Promise<T>,
  ): Promise<T> {
    check(grant, action);
    this.touchScope(grant.scope);
    const key = nativeWorkSessionKey(grant.scope);
    const scope = structuredClone(grant.scope);
    const epoch = this.stopEpochs.get(key) ?? 0;
    const verify = () => {
      check(grant, action);
      if (!sameScope(scope, grant.scope)) throw new NativeWorkError('scope-mismatch');
      if ((this.stopEpochs.get(key) ?? 0) !== epoch) throw new NativeWorkError('cancelled');
    };
    return this.trackScope(
      scope,
      this.enqueueKey(key, () => {
        verify();
        return operation(verify);
      }),
    );
  }

  private enqueueKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => {
        return operation();
      });
    this.locks.set(key, next);
    void next
      .finally(() => {
        if (this.locks.get(key) === next) {
          this.locks.delete(key);
          if (!this.inputReadDrains.has(key)) this.stopEpochs.delete(key);
        }
      })
      .catch(() => undefined);
    return next;
  }

  /** Reserve before any source I/O. Unknown outcomes retain the conservative charge. */
  reserveInputRead(grant: NativeWorkGrant): Promise<NativeInputReadReservation> {
    return this.serial(grant, 'send', async (verify) => {
      if (this.inputReadsSealed) throw new NativeWorkError('unavailable');
      const binding = this.required(grant, 'send');
      assertNativeInputReadOwner(binding.nativeSessionId, this.runtime);
      const key = nativeWorkSessionKey(grant.scope);
      const budget = binding.inputReadBudget ?? { attempts: 0, chargedBytes: 0 };
      if (
        !Number.isSafeInteger(budget.attempts) ||
        !Number.isSafeInteger(budget.chargedBytes) ||
        budget.attempts < 0 ||
        budget.chargedBytes < 0 ||
        budget.attempts >= NATIVE_INPUT_READ_LIMITS.attempts ||
        budget.chargedBytes >= NATIVE_INPUT_READ_LIMITS.bytes
      )
        throw new NativeWorkError('input-read-budget-exceeded');
      if (this.inputReadDrains.has(key) || activeInputReads.has(binding.nativeSessionId))
        throw new NativeWorkError('input-read-busy');
      const maximumBytes = Math.min(
        NATIVE_INPUT_READ_LIMITS.pageBytes,
        NATIVE_INPUT_READ_LIMITS.bytes - budget.chargedBytes,
      );
      const next = {
        ...binding,
        inputReadBudget: {
          attempts: budget.attempts + 1,
          chargedBytes: budget.chargedBytes + maximumBytes,
        },
      };
      const reservation = Object.freeze({ id: randomUUID(), maximumBytes });
      let resolveDrain!: () => void;
      const drain = {
        promise: new Promise<void>((resolve) => {
          resolveDrain = resolve;
        }),
        resolve: () => resolveDrain(),
      };
      this.inputReadDrains.set(key, drain.promise);
      const active = { owner: this.runtime, drain: drain.promise };
      activeInputReads.set(binding.nativeSessionId, active);
      const issued = {
        key,
        scope: structuredClone(grant.scope),
        epoch: this.stopEpochs.get(key) ?? 0,
        release: () => {
          if (this.inputReadDrains.get(key) === drain.promise) this.inputReadDrains.delete(key);
          if (activeInputReads.get(binding.nativeSessionId) === active)
            activeInputReads.delete(binding.nativeSessionId);
          drain.resolve();
        },
      };
      try {
        // Claim the ephemeral slot synchronously before the first persistence
        // await, so a second Host cannot pass its own independent queue.
        await this.writeBinding(grant, 'send', next);
        verify();
        if (this.inputReadsSealed) throw new NativeWorkError('unavailable');
        this.inputReadReservations.set(reservation, issued);
        return reservation;
      } catch (error) {
        issued.release();
        throw error;
      }
    });
  }

  /** Call only when the underlying read settles; omitting bytes never refunds. */
  finishInputRead(
    grant: NativeWorkGrant,
    reservation: NativeInputReadReservation,
    usedBytes?: number,
  ): Promise<void> {
    const issued = this.inputReadReservations.get(reservation);
    if (!issued) return Promise.reject(new NativeWorkError('invalid-request'));
    return this.enqueueKey(issued.key, async () => {
      if (this.inputReadReservations.get(reservation) !== issued)
        throw new NativeWorkError('invalid-request');
      try {
        if (usedBytes === undefined) return;
        if (
          !Number.isSafeInteger(usedBytes) ||
          usedBytes < 0 ||
          usedBytes > reservation.maximumBytes
        )
          throw new NativeWorkError('invalid-request');
        check(grant, 'send');
        if (!sameScope(grant.scope, issued.scope)) throw new NativeWorkError('scope-mismatch');
        if ((this.stopEpochs.get(issued.key) ?? 0) !== issued.epoch) return;
        const binding = this.required(grant, 'send');
        const budget = binding.inputReadBudget;
        if (!budget || budget.chargedBytes < reservation.maximumBytes)
          throw new NativeWorkError('invalid-request');
        await this.writeBinding(grant, 'send', {
          ...binding,
          inputReadBudget: {
            attempts: budget.attempts,
            chargedBytes: budget.chargedBytes - (reservation.maximumBytes - usedBytes),
          },
        });
      } finally {
        this.inputReadReservations.delete(reservation);
        issued.release();
      }
    });
  }

  /** Actual source-Promise drain, not the logical tool wait or native driver idle. */
  async whenInputReadsIdle(scope?: NativeWorkScope): Promise<void> {
    if (scope) {
      const key = nativeWorkSessionKey(scope);
      while (this.inputReadDrains.has(key)) await this.inputReadDrains.get(key);
    } else {
      while (this.inputReadDrains.size) await Promise.all(this.inputReadDrains.values());
    }
  }

  sealInputReads(): Promise<void> {
    this.inputReadsSealed = true;
    for (const prepared of this.prepared.values()) prepared.controller.abort();
    return this.whenInputReadsIdle();
  }

  /** Pure readiness observation for D. Own migration metadata slots are not
   * external scope activity; a send/queue/source/restore always invalidates it. */
  migrationDrain(scope: NativeWorkScope): NativeMigrationDrain {
    if (!nativeScopeSchema.safeParse(scope).success) throw new NativeWorkError('invalid-request');
    const record = this.storage.read(nativeWorkSessionKey(scope));
    if (!record) throw new NativeWorkError('not-started');
    const binding = bindingForScope(readNativeRecord(record), scope);
    if (!binding) throw new NativeWorkError('scope-mismatch');
    const key = nativeScopeKey(scope),
      prepared = this.prepared.get(key);
    if (!prepared) {
      // A pending/cold certificate is distinct from a known native ownership or
      // cleanup failure, including physical failure after a caller timed out.
      try {
        this.runtime.migrationDrain(binding.nativeSessionId);
      } catch (error) {
        if (!(error instanceof NativeWorkError) || error.code !== 'migration-not-ready')
          throw error;
      }
      throw new NativeWorkError('migration-not-ready');
    }
    const signal = prepared.signal;
    const assertCurrent = () => {
      try {
        if (
          signal.aborted ||
          this.inputReadsSealed ||
          this.prepared.get(key) !== prepared ||
          (this.scopeEpochs.get(key) ?? 0) !== prepared.epoch ||
          this.scopeActivity.get(key)?.size ||
          activeInputReads.has(prepared.binding.nativeSessionId)
        )
          throw new NativeWorkError('unavailable');
        const stored = this.storage.read(nativeWorkSessionKey(scope));
        const binding = stored && bindingForScope(readNativeRecord(stored), scope);
        if (
          !binding ||
          createHash('sha256').update(JSON.stringify(binding)).digest('hex') !== prepared.digest
        )
          throw new NativeWorkError('unavailable');
        prepared.native.assertCurrent();
      } catch {
        prepared.controller.abort();
        throw new NativeWorkError('unavailable');
      }
    };
    assertCurrent();
    return Object.freeze({ signal, basis: prepared.native.basis, assertCurrent });
  }

  private migrationAuthority(authority: NativeRunMigrationGrant) {
    const get = () =>
      nativeMigrationDataSchema.safeParse({
        requestId: authority?.requestId,
        inputFingerprint: authority?.inputFingerprint,
        previousScope: authority?.previousScope,
        scope: authority?.scope,
        selection: authority?.selection,
      });
    const parsed = get();
    if (
      !parsed.success ||
      !(authority?.signal instanceof AbortSignal) ||
      typeof authority?.assertCurrent !== 'function'
    )
      throw new NativeWorkError('invalid-request');
    const data = parsed.data,
      body = JSON.stringify(data),
      signal = authority.signal,
      method = authority.assertCurrent;
    if (!validMigrationPair(data.previousScope, data.scope))
      throw new NativeWorkError('scope-mismatch');
    const key = nativeWorkSessionKey(data.scope);
    const verify = (phase: 'prepare' | 'migrate') => {
      if (this.inputReadsSealed || signal.aborted) throw new NativeWorkError('cancelled');
      if (this.unknownMigrations.has(key)) throw new NativeWorkError('migration-unknown');
      const latest = get();
      if (
        !latest.success ||
        authority.signal !== signal ||
        authority.assertCurrent !== method ||
        JSON.stringify(latest.data) !== body
      )
        throw new NativeWorkError('scope-mismatch');
      authority.assertCurrent(phase);
    };
    verify('prepare');
    return { data, key, signal, verify };
  }

  /** Cleanup phase only. No mapping write, Agent creation/resume, tool or model. */
  async prepareMigration(
    authority: NativeRunMigrationGrant,
  ): Promise<
    | { readonly status: 'pending' }
    | { readonly status: 'prepared'; readonly drain: NativeMigrationDrain }
  > {
    const { data, key, signal, verify } = this.migrationAuthority(authority);
    const stored = this.storage.read(key);
    if (!stored) throw new NativeWorkError('not-started');
    const record = readNativeRecord(stored);
    inspectNativeMigration(record, data);
    const previous = bindingForScope(record, data.previousScope);
    if (!previous) throw new NativeWorkError('scope-mismatch');
    try {
      const drain = this.migrationDrain(data.previousScope);
      verify('prepare');
      return { status: 'prepared', drain };
    } catch (error) {
      if (
        !(error instanceof NativeWorkError) ||
        !['unavailable', 'migration-not-ready'].includes(error.code)
      )
        throw error;
    }
    this.retiredScopes.add(nativeScopeKey(data.previousScope));
    if (this.locks.has(key)) this.stopEpochs.set(key, (this.stopEpochs.get(key) ?? 0) + 1);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 5_000);
    const bounded = AbortSignal.any([signal, timeout.signal]);
    let abort!: () => void;
    const interrupted = new Promise<{ readonly status: 'pending' }>((resolve, reject) => {
      abort = () =>
        signal.aborted ? reject(new NativeWorkError('cancelled')) : resolve({ status: 'pending' });
      bounded.addEventListener('abort', abort, { once: true });
    });
    const work = (async () => {
      // Wait outside the mapping queue: an in-flight source must be able to
      // settle/refund in that same queue. Retire owns late physical cleanup.
      const [native] = await Promise.all([
        this.runtime.retire(previous.nativeSessionId, bounded, previous.receipts.length === 0),
        this.whenScopeIdle(data.previousScope),
        this.whenInputReadsIdle(data.previousScope),
      ]);
      if (bounded.aborted) throw new NativeWorkError('cancelled');
      verify('prepare');
      const latest = this.storage.read(key);
      const binding = latest && bindingForScope(readNativeRecord(latest), data.previousScope);
      if (!binding || binding.nativeSessionId !== previous.nativeSessionId)
        throw new NativeWorkError('scope-mismatch');
      this.prepared.get(nativeScopeKey(data.previousScope))?.controller.abort();
      const controller = new AbortController();
      this.prepared.set(nativeScopeKey(data.previousScope), {
        controller,
        signal: AbortSignal.any([controller.signal, native.signal]),
        epoch: this.scopeEpochs.get(nativeScopeKey(data.previousScope)) ?? 0,
        native,
        binding: {
          scope: binding.scope,
          nativeSessionId: binding.nativeSessionId,
          nativeAgentId: binding.nativeAgentId,
          selection: binding.selection,
        },
        digest: createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
      });
      return { status: 'prepared' as const, drain: this.migrationDrain(data.previousScope) };
    })();
    try {
      if (bounded.aborted) abort();
      return await Promise.race([
        interrupted,
        work.catch((error) => {
          if (timeout.signal.aborted && !signal.aborted) return { status: 'pending' as const };
          throw error;
        }),
      ]);
    } finally {
      clearTimeout(timer);
      bounded.removeEventListener('abort', abort);
    }
  }

  migrate(authority: NativeRunMigrationGrant): Promise<NativeRunMigrationResult> {
    const { data, key, verify } = this.migrationAuthority(authority);
    const fingerprint = migrationFingerprint(
      data.previousScope,
      data.scope,
      data.selection,
      data.inputFingerprint,
    );
    const prior = this.migrating.get(key);
    if (prior) {
      if (prior.requestId !== data.requestId)
        return Promise.reject(new NativeWorkError('migration-conflict'));
      if (prior.fingerprint !== fingerprint)
        return Promise.reject(new NativeWorkError('idempotency-mismatch'));
      return prior.work.then((result) => {
        verify(result.status === 'pending' ? 'prepare' : 'migrate');
        return structuredClone(result);
      });
    }
    const work = this.performMigration(authority);
    const owned = { requestId: data.requestId, fingerprint, work };
    this.migrating.set(key, owned);
    void work
      .finally(() => {
        if (this.migrating.get(key) === owned) this.migrating.delete(key);
      })
      .catch(() => undefined);
    return work.then((result) => structuredClone(result));
  }

  private async performMigration(
    authority: NativeRunMigrationGrant,
  ): Promise<NativeRunMigrationResult> {
    const { data, key, verify } = this.migrationAuthority(authority);
    const prepared = await this.prepareMigration(authority);
    if (prepared.status === 'pending') return prepared;
    verify('migrate');
    prepared.drain.assertCurrent();
    return this.enqueueKey(key, async () => {
      verify('migrate');
      prepared.drain.assertCurrent();
      const stored = this.storage.read(key);
      if (!stored) throw new NativeWorkError('not-started');
      const record = readNativeRecord(stored);
      const replay = inspectNativeMigration(record, data);
      if (replay) return replay;
      const next = appendNativeMigration(record, data);
      verify('migrate');
      // Once admitted, await durability. Never call a possible committed put
      // "pending/no change" or roll back to the old binding on an unknown error.
      try {
        await this.storage.write(key, next.record);
      } catch {
        this.unknownMigrations.add(key);
        throw new NativeWorkError('migration-unknown');
      }
      verify('migrate');
      prepared.drain.assertCurrent();
      return next.result;
    });
  }

  private read(grant: NativeWorkGrant, action: NativeWorkAction): NativeSessionBinding | undefined {
    check(grant, action);
    const key = nativeWorkSessionKey(grant.scope);
    if (['send', 'queue'].includes(action)) {
      if (this.unknownMigrations.has(key)) throw new NativeWorkError('migration-unknown');
      if (this.retiredScopes.has(nativeScopeKey(grant.scope)))
        throw new NativeWorkError('scope-mismatch');
    }
    const stored = this.storage.read(key);
    if (stored === undefined) return undefined;
    const record = readNativeRecord(stored);
    const value = ['open', 'history', 'follow'].includes(action)
      ? bindingForScope(record, grant.scope)
      : currentBinding(record);
    if (value === undefined || !sameScope(value.scope, grant.scope))
      throw new NativeWorkError('scope-mismatch');
    return structuredClone(value);
  }

  private async writeBinding(
    grant: NativeWorkGrant,
    action: NativeWorkAction,
    binding: NativeSessionBinding,
  ): Promise<void> {
    check(grant, action);
    const key = nativeWorkSessionKey(grant.scope);
    if (this.unknownMigrations.has(key)) throw new NativeWorkError('migration-unknown');
    const stored = this.storage.read(key);
    if (!stored) throw new NativeWorkError('not-started');
    const record = readNativeRecord(stored);
    const current = currentBinding(record);
    if (
      !sameScope(current.scope, binding.scope) ||
      current.nativeSessionId !== binding.nativeSessionId ||
      current.nativeAgentId !== binding.nativeAgentId
    )
      throw new NativeWorkError('scope-mismatch');
    const next = record.schemaVersion === 1 ? binding : { ...record, current: binding };
    if (Buffer.byteLength(JSON.stringify(next)) > NATIVE_LINEAGE_LIMITS.bytes)
      throw new NativeWorkError('capacity');
    await this.storage.write(key, next);
  }

  private required(grant: NativeWorkGrant, action: NativeWorkAction): NativeSessionBinding {
    const value = this.read(grant, action);
    if (!value) throw new NativeWorkError('not-started');
    return value;
  }

  /** Read-only navigation: never creates, resumes, wakes or replays native work. */
  open(grant: NativeWorkGrant) {
    const binding = this.read(grant, 'open');
    return binding === undefined
      ? undefined
      : {
          binding,
          status: this.runtime.isConnected(binding.nativeSessionId)
            ? this.runtime.status(binding.nativeSessionId)
            : ('detached' as const),
        };
  }

  /** Explicit first start or subsequent turn. The same locator always uses the same native id. */
  send(
    grant: NativeWorkGrant,
    request: {
      readonly requestId: string;
      readonly text: string;
      readonly mode: NativeMessageMode;
      readonly selection: NativeSessionSelection;
    },
  ): Promise<NativeMessageReceipt> {
    const input = structuredClone(request);
    textInput(input.text);
    if (
      typeof input.requestId !== 'string' ||
      input.requestId.length < 1 ||
      input.requestId.length > 200 ||
      !['followup', 'steer', 'queue'].includes(input.mode)
    )
      throw new NativeWorkError('invalid-request');
    const action = input.mode === 'queue' ? 'queue' : 'send';
    return this.serial(grant, action, async (verify) => {
      let binding = this.read(grant, action);
      if (!binding) {
        const selection = input.selection;
        if (
          [selection.provider, selection.model, selection.configurationId].some(
            (value) => typeof value !== 'string' || value.trim() === '' || value.length > 200,
          ) ||
          !Number.isSafeInteger(selection.maxTokens) ||
          selection.maxTokens < 1 ||
          selection.maxTokens > 65_536
        )
          throw new NativeWorkError('invalid-request');
        const sessionId = `zhuma-work-${randomUUID()}`;
        binding = {
          schemaVersion: 1,
          scope: structuredClone(grant.scope),
          nativeSessionId: sessionId,
          nativeAgentId: sessionId,
          selection,
          receipts: [],
        };
        verify();
        await this.storage.write(nativeWorkSessionKey(grant.scope), binding);
      }
      verify();
      if (!sameSelection(binding.selection, input.selection))
        throw new NativeWorkError('configuration-mismatch');
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([input.mode, input.text]))
        .digest('hex');
      const prior = binding.receipts.find((receipt) => receipt.requestId === input.requestId);
      if (prior && prior.fingerprint !== fingerprint)
        throw new NativeWorkError('idempotency-mismatch');
      if (!prior && binding.receipts.length >= NATIVE_WORK_LIMITS.receipts)
        throw new NativeWorkError('capacity');
      await this.runtime.connect(binding, grant, binding.receipts.length === 0);
      verify();
      if (prior) {
        // A crash between native append and metadata acknowledgement must never resend.
        const nativeStatus = await this.runtime.messageStatus(
          binding.nativeSessionId,
          prior.messageId,
          grant.signal,
        );
        verify();
        const receipt: NativeMessageReceipt = {
          ...prior,
          status: nativeStatus === 'absent' ? 'unknown' : nativeStatus,
        };
        await this.saveReceipt(grant, action, binding, receipt);
        verify();
        return structuredClone(receipt);
      }
      const receipt: NativeMessageReceipt = {
        requestId: input.requestId,
        messageId: randomUUID(),
        fingerprint,
        mode: input.mode,
        status: 'reserved',
      };
      binding = await this.saveReceipt(grant, action, binding, receipt);
      verify();
      this.runtime.send(
        binding.nativeSessionId,
        { id: receipt.messageId, text: input.text },
        input.mode,
      );
      await this.runtime.flush(binding.nativeSessionId);
      verify();
      const received = { ...receipt, status: 'received' as const };
      await this.saveReceipt(grant, action, binding, received);
      verify();
      return structuredClone(received);
    });
  }

  private async saveReceipt(
    grant: NativeWorkGrant,
    action: NativeWorkAction,
    binding: NativeSessionBinding,
    receipt: NativeMessageReceipt,
  ): Promise<NativeSessionBinding> {
    const next = {
      ...binding,
      receipts: [
        ...binding.receipts.filter((item) => item.requestId !== receipt.requestId),
        receipt,
      ],
    };
    check(grant, action);
    await this.writeBinding(grant, action, next);
    return next;
  }

  /** Native queue bodies are read from DSH, never copied to the mapping store. */
  queue(grant: NativeWorkGrant) {
    const binding = this.required(grant, 'queue');
    if (!this.runtime.isConnected(binding.nativeSessionId))
      return { attached: false as const, items: [] };
    return {
      attached: true as const,
      items: structuredClone(this.runtime.pending(binding.nativeSessionId)),
    };
  }

  updateQueue(
    grant: NativeWorkGrant,
    update:
      | { readonly kind: 'edit'; readonly messageId: string; readonly text: string }
      | { readonly kind: 'remove'; readonly messageId: string }
      | { readonly kind: 'reorder'; readonly messageIds: readonly string[] },
  ) {
    const input = structuredClone(update);
    if (input.kind === 'edit') textInput(input.text);
    return this.serial(grant, 'queue', async (verify) => {
      const binding = this.required(grant, 'queue');
      await this.runtime.connect(binding, grant, false);
      verify();
      if (input.kind === 'reorder') this.runtime.reorder(binding.nativeSessionId, input.messageIds);
      else if (
        !(input.kind === 'edit'
          ? this.runtime.edit(binding.nativeSessionId, input.messageId, input.text)
          : this.runtime.remove(binding.nativeSessionId, input.messageId))
      )
        throw new NativeWorkError('not-pending');
      await this.runtime.flush(binding.nativeSessionId);
      verify();
      return { accepted: true as const };
    });
  }

  /** Does not hold the mutation lock while a cooperative native cancellation drains. */
  async stop(grant: NativeWorkGrant) {
    check(grant, 'stop');
    const key = nativeWorkSessionKey(grant.scope);
    if (this.locks.has(key) || this.inputReadDrains.has(key))
      this.stopEpochs.set(key, (this.stopEpochs.get(key) ?? 0) + 1);
    const binding = this.required(grant, 'stop');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), 5_000);
    });
    try {
      const result = await Promise.race([
        (async () => {
          const stopped = await this.runtime.stop(binding.nativeSessionId, grant.signal);
          if (stopped === 'stopped') await this.whenInputReadsIdle(grant.scope);
          return stopped;
        })(),
        pending,
      ]);
      check(grant, 'stop');
      return { status: result };
    } finally {
      clearTimeout(timer);
    }
  }

  async history(
    grant: NativeWorkGrant,
    after = -1,
    limit = NATIVE_WORK_LIMITS.historyEvents,
    signal: AbortSignal = grant.signal,
  ) {
    const binding = this.required(grant, 'history');
    if (
      !Number.isSafeInteger(after) ||
      after < -1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > NATIVE_WORK_LIMITS.historyEvents
    )
      throw new NativeWorkError('invalid-request');
    const combined = AbortSignal.any([grant.signal, signal]);
    const events = await this.runtime.history(
      binding.nativeSessionId,
      after,
      limit,
      combined,
      binding.receipts.length === 0,
    );
    combined.throwIfAborted();
    check(grant, 'history');
    return { binding, events: structuredClone(events) };
  }

  async *follow(grant: NativeWorkGrant, after = -1, signal: AbortSignal = grant.signal) {
    const binding = this.required(grant, 'follow');
    if (!Number.isSafeInteger(after) || after < -1) throw new NativeWorkError('invalid-request');
    const combined = AbortSignal.any([grant.signal, signal]);
    for await (const frame of this.runtime.follow(
      binding.nativeSessionId,
      after,
      combined,
      binding.receipts.length === 0,
    )) {
      if (combined.aborted) return;
      check(grant, 'follow');
      yield {
        scope: structuredClone(binding.scope),
        nativeSessionId: binding.nativeSessionId,
        ...structuredClone(frame),
      };
    }
  }
}
