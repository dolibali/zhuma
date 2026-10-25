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

/** Stable task/workspace lookup; the complete Run is compared separately. */
export function nativeWorkSessionKey(scope: NativeWorkScope): string {
  return JSON.stringify([
    scope.actorId,
    scope.spaceId,
    scope.taskId,
    scope.planId,
    scope.revision,
    scope.nodeId,
  ]);
}

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

  private serial<T>(
    grant: NativeWorkGrant,
    action: NativeWorkAction,
    operation: (verify: () => void) => Promise<T>,
  ): Promise<T> {
    check(grant, action);
    const key = nativeWorkSessionKey(grant.scope);
    const scope = structuredClone(grant.scope);
    const epoch = this.stopEpochs.get(key) ?? 0;
    const verify = () => {
      check(grant, action);
      if (!sameScope(scope, grant.scope)) throw new NativeWorkError('scope-mismatch');
      if ((this.stopEpochs.get(key) ?? 0) !== epoch) throw new NativeWorkError('cancelled');
    };
    return this.enqueueKey(key, () => {
      verify();
      return operation(verify);
    });
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
        await this.storage.write(key, next);
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
        await this.storage.write(issued.key, {
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
    return this.whenInputReadsIdle();
  }

  private read(grant: NativeWorkGrant, action: NativeWorkAction): NativeSessionBinding | undefined {
    check(grant, action);
    const value = this.storage.read(nativeWorkSessionKey(grant.scope));
    if (value !== undefined && !sameScope(value.scope, grant.scope))
      throw new NativeWorkError('scope-mismatch');
    return value === undefined ? undefined : structuredClone(value);
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
    await this.storage.write(nativeWorkSessionKey(grant.scope), next);
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
    const events = await this.runtime.history(binding.nativeSessionId, after, limit, combined);
    combined.throwIfAborted();
    check(grant, 'history');
    return { binding, events: structuredClone(events) };
  }

  async *follow(grant: NativeWorkGrant, after = -1, signal: AbortSignal = grant.signal) {
    const binding = this.required(grant, 'follow');
    if (!Number.isSafeInteger(after) || after < -1) throw new NativeWorkError('invalid-request');
    const combined = AbortSignal.any([grant.signal, signal]);
    for await (const frame of this.runtime.follow(binding.nativeSessionId, after, combined)) {
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
