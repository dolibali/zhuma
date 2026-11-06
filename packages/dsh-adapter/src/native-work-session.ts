import { createHash, randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  NativeSessionPurpose,
  assertNativePurposeOwner,
  assertNativeScopePurposeOwner,
  invokeNativeWorkGrantAssertion,
} from './native-work-session-purpose.js';
import {
  NativeReviewError,
  nativeReviewRecordSchema,
  nativeReviewScopeKey,
  nativeReviewSessionKey,
  nativeReviewIntentSchema,
  NATIVE_REVIEW_LIMITS,
  type NativeReviewContext,
  type NativeReviewRecord,
  type NativeReviewSnapshot,
} from './native-work-session-review-contract.js';
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
  type NativeMigrationOriginRequest,
  type NativeMigrationOrigin,
  type NativeScopeCleanupAuthority,
  type NativeScopeCleanupResult,
  type NativeWorkSessionRecord,
} from './native-work-session-contract.js';
import { NativeReleasedConversationController } from './native-work-session-conversation.js';
import type { NativeConversationPrefix } from './native-work-session-conversation-contract.js';
import { publicNativeHistoryPage } from './native-work-session-history-view.js';
import { publicNativeResultEvent } from './native-work-session-public-result.js';

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
const MAX_OWNER_SCOPES = 4096;

const retirementStages = [
  'cleanup-authority',
  'cleanup-purpose',
  'cleanup-capacity',
  'cleanup-call',
  'cleanup-binding',
  'cleanup-native-ready',
  'cleanup-native-retire',
  'cleanup-scope-idle',
  'cleanup-input-source',
  'cleanup-binding-check',
  'cleanup-proof',
  'runtime-owner',
  'runtime-source-identity',
  'runtime-connect',
  'runtime-agent-idle',
  'runtime-handle-dispose',
  'runtime-dispose-join',
  'runtime-registry',
  'runtime-writer-open',
  'runtime-writer-flush',
  'runtime-writer-close',
  'runtime-identity',
  'runtime-epoch',
  'runtime-barrier',
] as const;
export type NativeRetirementStage = (typeof retirementStages)[number];
type RetirementPhase = 'wait' | 'done' | 'error' | 'pending';
interface RetirementDiagnostic {
  record(stage: NativeRetirementStage, phase: RetirementPhase, error?: unknown): void;
  attach(runtime: NativeWorkRuntime, sessionId: string): void;
  close(): void;
}
const quietRetirement: RetirementDiagnostic = {
  record() {},
  attach() {},
  close() {},
};
// Private observation only: no grant, binding, proof, queue or persisted state.
const retirementObservers = new WeakMap<
  NativeWorkRuntime,
  Map<string, Set<RetirementDiagnostic>>
>();
const retirementCodes = new Set([
  'invalid-request',
  'scope-mismatch',
  'capacity',
  'unavailable',
  'cancelled',
  'input-read-busy',
  'not-started',
  'binding-state-invalid',
  'migration-not-ready',
  'migration-unknown',
  'migration-conflict',
  'configuration-mismatch',
  'persistence-not-found',
]);
function createRetirementDiagnostic(scope?: NativeWorkScope): RetirementDiagnostic {
  try {
    if (process.env.ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT !== '1') return quietRetirement;
    // Invalid input cannot supply a trustworthy scope. Use a fixed opaque sentinel,
    // never inspect/stringify the rejected object or invoke its accessors again.
    const correlation = createHash('sha256')
      .update(canonicalPayload(scope ?? { scope: 'unavailable' }))
      .digest('hex')
      .slice(0, 16);
    const seen = new Set<string>(),
      remove: (() => void)[] = [];
    const diagnostic: RetirementDiagnostic = {
      record(stage, phase, error) {
        try {
          if (
            !retirementStages.includes(stage) ||
            !['wait', 'done', 'error', 'pending'].includes(phase)
          )
            return;
          const key = `${stage}-${phase}`;
          if (seen.has(key)) return;
          seen.add(key);
          let code = phase === 'error' ? 'unexpected-error' : 'none';
          if (phase === 'error') {
            const candidate = error instanceof NativeWorkError ? error.code : error;
            if (typeof candidate === 'string' && retirementCodes.has(candidate)) code = candidate;
          }
          writeSync(
            1,
            `${JSON.stringify({ event: 'zhuma-native-retire-stage', correlation, stage: key, code })}\n`,
          );
        } catch {
          /* Diagnostic failure never changes the original operation. */
        }
      },
      attach(runtime, sessionId) {
        try {
          let sessions = retirementObservers.get(runtime);
          if (!sessions) retirementObservers.set(runtime, (sessions = new Map()));
          let observers = sessions.get(sessionId);
          if (!observers) sessions.set(sessionId, (observers = new Set()));
          if (observers.has(diagnostic)) return;
          observers.add(diagnostic);
          remove.push(() => {
            observers.delete(diagnostic);
            if (!observers.size && sessions.get(sessionId) === observers)
              sessions.delete(sessionId);
            if (!sessions.size && retirementObservers.get(runtime) === sessions)
              retirementObservers.delete(runtime);
          });
        } catch {
          /* No observation is preferable to changing cleanup. */
        }
      },
      close() {
        for (const release of remove.splice(0)) {
          try {
            release();
          } catch {
            /* Observation is not ownership. */
          }
        }
      },
    };
    return diagnostic;
  } catch {
    return quietRetirement;
  }
}
/** C-internal observer bridge; deliberately absent from public package exports. */
export function traceNativeRetirementStage(
  runtime: NativeWorkRuntime,
  sessionId: string,
  stage: NativeRetirementStage,
  phase: RetirementPhase,
  error?: unknown,
): void {
  try {
    for (const observer of retirementObservers.get(runtime)?.get(sessionId) ?? [])
      observer.record(stage, phase, error);
  } catch {
    /* Never turn a diagnostic into authority or a new failure. */
  }
}
function observeRetirementPromise<T>(
  diagnostic: RetirementDiagnostic,
  stage: NativeRetirementStage,
  operation: () => Promise<T>,
): Promise<T> {
  if (diagnostic === quietRetirement) return operation();
  diagnostic.record(stage, 'wait');
  let promise: Promise<T>;
  try {
    promise = operation();
  } catch (error) {
    diagnostic.record(stage, 'error', error);
    throw error;
  }
  try {
    void promise.then(
      () => diagnostic.record(stage, 'done'),
      (error: unknown) => diagnostic.record(stage, 'error', error),
    );
  } catch {
    /* The original await still owns this exact value. */
  }
  return promise;
}

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
  nativeConversationSession,
  preserveNativeConversation,
} from './native-work-session-record.js';
export { nativeWorkSessionKey } from './native-work-session-record.js';
import {
  inspectNativeMigration,
  appendNativeMigration,
  nativeMigrationOrigin,
} from './native-work-session-migration.js';
import { NativeConversationProjection } from './native-work-session-view.js';
import {
  nativeResultCutSchema,
  type NativeResultCut,
  type NativeResultSnapshot,
} from './native-work-session-result-contract.js';
import {
  nativeWorkResultIntentSchema,
  type NativeWorkResultIntent,
} from './native-work-session-result-intent.js';

const originRequestSchema = nativeMigrationDataSchema.omit({ previousScope: true });

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
  if (Object.hasOwn(s, 'review')) throw new NativeWorkError('invalid-request');
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
  invokeNativeWorkGrantAssertion(grant, action);
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
  readonly conversation: NativeReleasedConversationController;
  private readonly workReadFences = new Map<string, AbortController>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly stopEpochs = new Map<string, number>();
  private readonly retiredScopes = new Set<string>();
  // Owner-local admission observations, not permission facts or a second registry.
  private readonly nativeAdmissions = new Set<string>();
  private readonly cleanupLifetime = new AbortController();
  private readonly cleanupFailures = new Set<string>();
  private readonly cleanups = new Map<
    string,
    Promise<Extract<NativeScopeCleanupResult, { status: 'retired' }>>
  >();
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
  private observeNativeAdmission(scope: NativeWorkScope): void {
    const address = this.scopeKey(scope);
    if (!this.nativeAdmissions.has(address) && this.nativeAdmissions.size >= MAX_OWNER_SCOPES)
      throw new NativeWorkError('capacity');
    this.nativeAdmissions.add(address);
  }
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
    private readonly review?: {
      readonly purpose: NativeSessionPurpose;
      readonly read: (key: string) => unknown;
      readonly write: (key: string, record: NativeReviewRecord) => Promise<void>;
      readonly enable: () => Promise<void>;
    },
  ) {
    this.conversation = new NativeReleasedConversationController(
      {
        signal: this.cleanupLifetime.signal,
        read: (scope) => this.conversationRecord(scope),
        serial: (scope, verify, work) =>
          this.enqueueKey(nativeWorkSessionKey(scope), async () => {
            verify();
            return work();
          }),
        write: async (scope, record, verify) => {
          verify();
          const parsed = readNativeRecord(record);
          if (Buffer.byteLength(JSON.stringify(parsed)) > NATIVE_LINEAGE_LIMITS.bytes)
            throw new NativeWorkError('capacity');
          verify();
          await this.storage.write(nativeWorkSessionKey(scope), parsed);
          verify();
        },
        admit: (scope) => {
          const binding = bindingForScope(this.conversationRecord(scope), scope);
          if (!binding) throw new NativeWorkError('scope-mismatch');
          this.workReadFences.get(binding.nativeSessionId)?.abort();
          this.touchScope(scope);
          this.retiredScopes.add(this.scopeKey(scope));
        },
      },
      runtime,
    );
  }

  private conversationRecord(scope: NativeWorkScope): NativeWorkSessionRecord {
    assertNativeScopePurposeOwner(scope, this.review?.purpose);
    const key = nativeWorkSessionKey(scope);
    if (this.unknownMigrations.has(key)) throw new NativeWorkError('migration-unknown');
    const stored = this.storage.read(key);
    if (!stored) throw new NativeWorkError('not-started');
    const record = readNativeRecord(stored);
    if (!bindingForScope(record, scope)) throw new NativeWorkError('scope-mismatch');
    return record;
  }
  private workReadSignal(binding: NativeSessionBinding): AbortSignal {
    let controller = this.workReadFences.get(binding.nativeSessionId);
    if (!controller) {
      if (this.workReadFences.size >= MAX_OWNER_SCOPES) throw new NativeWorkError('capacity');
      this.workReadFences.set(binding.nativeSessionId, (controller = new AbortController()));
    }
    return controller.signal;
  }
  private assertConversationMigration(record: NativeWorkSessionRecord): void {
    if (
      record.conversation?.sessions.some(
        (entry) =>
          entry.phase !== 'settled' ||
          entry.receipts.some((r) => r.status === 'reserved' || r.status === 'unknown'),
      )
    )
      throw new NativeWorkError('migration-not-ready');
  }

  /** The sealed original Work prefix only, authorized through original history. */
  conversationPrefix(grant: NativeWorkGrant): NativeConversationPrefix | undefined {
    const binding = this.required(grant, 'history');
    if (this.isReviewPurpose(grant)) return undefined;
    return nativeConversationSession(this.conversationRecord(grant.scope), binding.nativeSessionId)
      ?.prefix;
  }
  async readOriginalPrefix(
    grant: NativeWorkGrant,
    signal: AbortSignal,
  ): Promise<NativeResultSnapshot> {
    const binding = this.required(grant, 'history'),
      prefix = this.conversationPrefix(grant);
    if (!prefix || !this.runtime.readPrefixSnapshot) throw new NativeWorkError('unavailable');
    const identity = JSON.stringify(prefix);
    const verify = () => {
      this.check(grant, 'history');
      if (JSON.stringify(this.conversationPrefix(grant)) !== identity)
        throw new NativeWorkError('scope-mismatch');
    };
    const snapshot = await this.runtime.readPrefixSnapshot(
      binding,
      prefix,
      AbortSignal.any([signal, grant.signal]),
      verify,
    );
    verify();
    return snapshot;
  }

  private check(grant: NativeWorkGrant, action: NativeWorkAction): void {
    assertNativePurposeOwner(grant, this.review?.purpose);
    check(grant, action);
  }
  private sessionKey(scope: NativeWorkScope): string {
    const context = this.review?.purpose.context(scope);
    if (!context || !this.review) return nativeWorkSessionKey(scope);
    const legacyKey = this.review.purpose.key(scope),
      scopedKey = nativeReviewScopeKey(context);
    if (this.review.read(scopedKey) !== undefined) return scopedKey;
    const legacy = this.review.read(legacyKey);
    // Keep the original record/key stable for its already-issued drain. A
    // different review Run uses the existing scope key in the same table.
    if (legacy === undefined) return legacyKey;
    const previous = nativeReviewRecordSchema.parse(legacy).context;
    if (nativeReviewSessionKey(previous) !== legacyKey) throw new NativeWorkError('scope-mismatch');
    return nativeReviewScopeKey(previous) === scopedKey ? legacyKey : scopedKey;
  }
  private scopeKey(scope: NativeWorkScope): string {
    return this.review?.purpose.address(scope) ?? nativeScopeKey(scope);
  }
  private cloneScope(scope: NativeWorkScope): NativeWorkScope {
    return this.review?.purpose.cloneScope(scope) ?? structuredClone(scope);
  }
  private sameScope(a: NativeWorkScope, b: NativeWorkScope): boolean {
    return this.scopeKey(a) === this.scopeKey(b);
  }
  /** Original object identity is checked by the configured Host authority port. */
  reviewGrant(original: unknown): NativeWorkGrant {
    if (!this.review) throw new NativeReviewError('review-unavailable');
    return this.review.purpose.reviewGrant(original);
  }
  reviewContext(grant: NativeWorkGrant): NativeReviewContext | undefined {
    this.check(grant, 'open');
    return this.review?.purpose.context(grant.scope);
  }
  /** Role observation only; this grants no operation or source access. */
  isReviewPurpose(grant: NativeWorkGrant): boolean {
    return (
      !!grant &&
      typeof grant === 'object' &&
      this.review?.purpose.context(grant.scope) !== undefined
    );
  }
  reviewAccess(grant: NativeWorkGrant) {
    if (!this.review?.purpose.owns(grant)) throw new NativeReviewError('review-authority-denied');
    this.check(grant, 'send');
    const context = this.review?.purpose.context(grant.scope);
    if (!this.review || !context) throw new NativeReviewError('review-authority-denied');
    const record = this.readReviewRecord(grant.scope, context);
    const binding = record && bindingForScope(record.binding, grant.scope);
    if (binding) this.review.purpose.bindScope(binding.scope, context);
    if (record && (!binding || !this.sameScope(binding.scope, grant.scope)))
      throw new NativeWorkError('scope-mismatch');
    // Keep send before the storage read and a fresh open check after it. This
    // one synchronous metadata entry never retains authorization across awaits.
    const access = this.review.purpose.access(grant);
    const clonedBinding = binding && structuredClone(binding);
    if (clonedBinding) this.review.purpose.bindScope(clonedBinding.scope, context);
    return {
      context,
      original: access.original,
      ports: this.review.purpose.ports,
      selection: access.selection,
      binding: clonedBinding,
    };
  }
  reviewIntent(grant: NativeWorkGrant) {
    return this.reviewRecord(grant).reviewIntent;
  }
  private completionPending(grant: NativeWorkGrant, binding: NativeSessionBinding): boolean {
    return (
      binding.resultIntent !== undefined ||
      (this.review?.purpose.context(grant.scope) !== undefined &&
        this.reviewRecord(grant).reviewIntent !== undefined)
    );
  }
  async readReviewSnapshot(
    grant: NativeWorkGrant,
    signal: AbortSignal,
  ): Promise<NativeReviewSnapshot> {
    this.reviewAccess(grant);
    const snapshot = await this.readResultSnapshot(grant, signal);
    if (
      !('sourceBytes' in snapshot) ||
      typeof snapshot.sourceBytes !== 'number' ||
      !Number.isSafeInteger(snapshot.sourceBytes) ||
      snapshot.sourceBytes < 0 ||
      snapshot.sourceBytes > NATIVE_REVIEW_LIMITS.scanBytes
    )
      throw new NativeReviewError('review-unavailable');
    snapshot.check();
    return { ...snapshot, sourceBytes: snapshot.sourceBytes };
  }

  declareReviewIntent(
    grant: NativeWorkGrant,
    raw: unknown,
    validate: (snapshot: NativeResultSnapshot) => undefined,
  ): Promise<void> {
    const intent = nativeReviewIntentSchema.parse(raw);
    if (intent.cut) throw new NativeReviewError('invalid-arguments');
    return this.serial(grant, 'send', async (verify) => {
      const record = this.reviewRecord(grant);
      if (record.reviewIntent) throw new NativeReviewError('review-result-rejected');
      const snapshot = await this.readResultSnapshot(grant, grant.signal);
      verify();
      if (snapshot.hasPending) throw new NativeReviewError('review-input-pending');
      if (validate(snapshot) !== undefined) throw new NativeReviewError('review-result-rejected');
      snapshot.check();
      await this.writeReview(grant, { ...record, reviewIntent: intent });
      verify();
      snapshot.check();
    });
  }
  clearReviewIntent(grant: NativeWorkGrant, intentId: string): Promise<void> {
    return this.serial(grant, 'send', async (verify) => {
      const record = this.reviewRecord(grant);
      if (!record.reviewIntent) return;
      if (record.reviewIntent.intentId !== intentId || record.reviewIntent.cut)
        throw new NativeReviewError('review-result-rejected');
      const { reviewIntent: _intent, ...next } = record;
      await this.writeReview(grant, next);
      verify();
    });
  }
  sealReviewIntent(
    grant: NativeWorkGrant,
    intentId: string,
    raw: unknown,
    assertSource: () => undefined,
  ): Promise<void> {
    const cut = nativeResultCutSchema.parse(raw);
    return this.serial(grant, 'send', async (verify) => {
      const record = this.reviewRecord(grant);
      if (
        record.reviewIntent?.intentId !== intentId ||
        (record.reviewIntent.cut && JSON.stringify(record.reviewIntent.cut) !== JSON.stringify(cut))
      )
        throw new NativeReviewError('review-result-rejected');
      if (assertSource() !== undefined) throw new NativeReviewError('review-result-rejected');
      if (!record.reviewIntent.cut)
        await this.writeReview(grant, { ...record, reviewIntent: { ...record.reviewIntent, cut } });
      verify();
      if (assertSource() !== undefined) throw new NativeReviewError('review-result-rejected');
    });
  }

  /** Same admission/drain slots as author input reads; the review row alone owns
   * its conservative byte/attempt charge. release waits for the source promise. */
  reserveReviewRead(grant: NativeWorkGrant, length: number) {
    return this.serial(grant, 'send', async (verify) => {
      if (this.inputReadsSealed) throw new NativeReviewError('review-unavailable');
      const record = this.reviewRecord(grant),
        binding = currentBinding(record.binding);
      if (record.reviewIntent) throw new NativeReviewError('review-result-rejected');
      const budget = record.readBudget ?? { attempts: 0, chargedBytes: 0 };
      if (!Number.isSafeInteger(length) || length < 1 || length > NATIVE_REVIEW_LIMITS.pageBytes)
        throw new NativeReviewError('review-range-invalid');
      if (
        budget.attempts >= NATIVE_REVIEW_LIMITS.reads ||
        budget.chargedBytes + length > NATIVE_REVIEW_LIMITS.readBytes
      )
        throw new NativeReviewError('review-read-budget-exceeded');
      const key = this.sessionKey(grant.scope);
      assertNativeInputReadOwner(binding.nativeSessionId, this.runtime);
      if (this.inputReadDrains.has(key) || activeInputReads.has(binding.nativeSessionId))
        throw new NativeReviewError('review-capacity');
      let resolveDrain!: () => void;
      const drain = {
        promise: new Promise<void>((resolve) => {
          resolveDrain = resolve;
        }),
        resolve: () => resolveDrain(),
      };
      const active = { owner: this.runtime, drain: drain.promise };
      this.inputReadDrains.set(key, drain.promise);
      activeInputReads.set(binding.nativeSessionId, active);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (this.inputReadDrains.get(key) === drain.promise) this.inputReadDrains.delete(key);
        if (activeInputReads.get(binding.nativeSessionId) === active)
          activeInputReads.delete(binding.nativeSessionId);
        drain.resolve();
      };
      try {
        await this.writeReview(grant, {
          ...record,
          readBudget: { attempts: budget.attempts + 1, chargedBytes: budget.chargedBytes + length },
        });
        verify();
        if (this.inputReadsSealed) throw new NativeReviewError('review-unavailable');
        return {
          release,
          check: () => {
            if (released) throw new NativeReviewError('cancelled');
            verify();
          },
        };
      } catch (error) {
        release();
        throw error;
      }
    });
  }
  private reviewRecord(grant: NativeWorkGrant): NativeReviewRecord {
    this.check(grant, 'open');
    const context = this.review?.purpose.context(grant.scope);
    if (!context || !this.review) throw new NativeReviewError('review-authority-denied');
    const record = this.readReviewRecord(grant.scope, context);
    if (!record) throw new NativeWorkError('not-started');
    return record;
  }
  private readReviewRecord(
    scope: NativeWorkScope,
    context: NativeReviewContext,
  ): NativeReviewRecord | undefined {
    const raw = this.review!.read(this.sessionKey(scope));
    if (raw === undefined) return undefined;
    const record = nativeReviewRecordSchema.parse(raw);
    if (JSON.stringify(record.context) !== JSON.stringify(context))
      throw new NativeReviewError('review-target-changed');
    return record;
  }
  private async writeReview(grant: NativeWorkGrant, record: unknown): Promise<void> {
    this.check(grant, 'send');
    if (!this.review) throw new NativeReviewError('review-unavailable');
    const parsed = nativeReviewRecordSchema.parse(record);
    if (JSON.stringify(parsed.context) !== JSON.stringify(this.review.purpose.context(grant.scope)))
      throw new NativeReviewError('review-target-changed');
    await this.review.enable();
    this.check(grant, 'send');
    await this.review.write(this.sessionKey(grant.scope), parsed);
    this.check(grant, 'send');
  }

  private touchScope(scope: NativeWorkScope): void {
    const key = this.scopeKey(scope);
    this.scopeEpochs.set(key, (this.scopeEpochs.get(key) ?? 0) + 1);
    this.prepared.get(key)?.controller.abort();
  }
  private trackScope<T>(scope: NativeWorkScope, work: Promise<T>): Promise<T> {
    const key = this.scopeKey(scope);
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
    while (this.scopeActivity.get(this.scopeKey(scope))?.size)
      await Promise.allSettled(this.scopeActivity.get(this.scopeKey(scope))!);
  }

  private serial<T>(
    grant: NativeWorkGrant,
    action: NativeWorkAction,
    operation: (verify: () => void) => Promise<T>,
  ): Promise<T> {
    this.check(grant, action);
    this.touchScope(grant.scope);
    if (this.retiredScopes.has(this.scopeKey(grant.scope)))
      return Promise.reject(new NativeWorkError('scope-mismatch'));
    const key = this.sessionKey(grant.scope);
    const scope = this.cloneScope(grant.scope);
    const epoch = this.stopEpochs.get(key) ?? 0;
    const verify = () => {
      this.check(grant, action);
      if (!this.sameScope(scope, grant.scope)) throw new NativeWorkError('scope-mismatch');
      if (this.retiredScopes.has(this.scopeKey(scope))) throw new NativeWorkError('cancelled');
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
      if (this.completionPending(grant, binding)) throw new NativeWorkError('completion-pending');
      assertNativeInputReadOwner(binding.nativeSessionId, this.runtime);
      const key = this.sessionKey(grant.scope);
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
        scope: this.cloneScope(grant.scope),
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
        this.check(grant, 'send');
        if (!this.sameScope(grant.scope, issued.scope)) throw new NativeWorkError('scope-mismatch');
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
      const key = this.sessionKey(scope);
      while (this.inputReadDrains.has(key)) await this.inputReadDrains.get(key);
    } else {
      while (this.inputReadDrains.size) await Promise.all(this.inputReadDrains.values());
    }
  }

  sealInputReads(): Promise<void> {
    this.inputReadsSealed = true;
    this.cleanupLifetime.abort();
    for (const prepared of this.prepared.values()) prepared.controller.abort();
    return this.whenInputReadsIdle();
  }

  /** Host-only cleanup after D authorization, independent of an expired member lease.
   * The wait signal controls only this caller's wait, never the owned physical work.
   */
  async retireForCleanup(
    authority: NativeScopeCleanupAuthority,
    waitSignal: AbortSignal,
  ): Promise<NativeScopeCleanupResult> {
    let parsed: ReturnType<typeof nativeScopeSchema.safeParse>;
    try {
      parsed = nativeScopeSchema.safeParse(authority?.scope);
    } catch (error) {
      const rejected = createRetirementDiagnostic();
      rejected.record('cleanup-authority', 'wait');
      rejected.record('cleanup-authority', 'error', error);
      throw error;
    }
    const diagnostic = createRetirementDiagnostic(parsed.success ? parsed.data : undefined);
    diagnostic.record('cleanup-authority', 'wait');
    if (
      !parsed.success ||
      typeof authority?.assertCurrent !== 'function' ||
      !(waitSignal instanceof AbortSignal)
    ) {
      diagnostic.record('cleanup-authority', 'error', 'invalid-request');
      throw new NativeWorkError('invalid-request');
    }
    diagnostic.record('cleanup-purpose', 'wait');
    try {
      assertNativeScopePurposeOwner(authority.scope, this.review?.purpose);
    } catch (error) {
      diagnostic.record('cleanup-purpose', 'error', error);
      throw error;
    }
    diagnostic.record('cleanup-purpose', 'done');
    const scope = this.review?.purpose.context(authority.scope)
        ? this.cloneScope(authority.scope)
        : parsed.data,
      address = this.scopeKey(scope),
      method = authority.assertCurrent;
    const verify = () => {
      if (this.inputReadsSealed) {
        diagnostic.record('cleanup-authority', 'error', 'unavailable');
        throw new NativeWorkError('unavailable');
      }
      if (authority.assertCurrent !== method || !this.sameScope(scope, authority.scope)) {
        diagnostic.record('cleanup-authority', 'error', 'scope-mismatch');
        throw new NativeWorkError('scope-mismatch');
      }
      try {
        const result: unknown = authority.assertCurrent();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined);
          throw new NativeWorkError('unavailable');
        }
      } catch {
        diagnostic.record('cleanup-authority', 'error', 'unavailable');
        throw new NativeWorkError('unavailable');
      }
      diagnostic.record('cleanup-authority', 'done');
    };
    verify();
    if (!this.review?.purpose.context(scope)) {
      diagnostic.record('cleanup-binding', 'wait');
      try {
        const stored = this.storage.read(this.sessionKey(scope));
        if (stored) {
          const record = readNativeRecord(stored),
            binding = bindingForScope(record, scope);
          const chat = binding && nativeConversationSession(record, binding.nativeSessionId);
          if (chat && chat.phase !== 'settled') return { status: 'pending' };
        }
        diagnostic.record('cleanup-binding', 'done');
      } catch (error) {
        diagnostic.record('cleanup-binding', 'error', error);
        throw error;
      }
    }
    if (!this.retiredScopes.has(address) && this.retiredScopes.size >= MAX_OWNER_SCOPES) {
      diagnostic.record('cleanup-capacity', 'error', 'capacity');
      throw new NativeWorkError('capacity');
    }
    this.retiredScopes.add(address);
    diagnostic.record('cleanup-call', 'wait');
    let work = this.cleanups.get(address);
    if (!work) {
      if (this.cleanups.size >= 256) {
        diagnostic.record('cleanup-capacity', 'error', 'capacity');
        throw new NativeWorkError('capacity');
      }
      work = this.retireScope(scope, diagnostic);
      this.cleanups.set(address, work);
      const owned = work;
      void owned.then(
        () => {
          this.cleanupFailures.delete(address);
          if (this.cleanups.get(address) === owned) this.cleanups.delete(address);
          diagnostic.close();
        },
        (error: unknown) => {
          diagnostic.record('cleanup-call', 'error', error);
          this.cleanupFailures.add(address);
          if (this.cleanups.get(address) === owned) this.cleanups.delete(address);
          diagnostic.close();
        },
      );
    }
    let interrupt!: () => void;
    const pending = new Promise<{ readonly status: 'pending' }>((resolve) => {
      interrupt = () => resolve({ status: 'pending' });
      waitSignal.addEventListener('abort', interrupt, { once: true });
    });
    const timer = setTimeout(interrupt, 5_000);
    try {
      if (waitSignal.aborted) interrupt();
      const result = await Promise.race([pending, work]);
      verify();
      if (result.status === 'retired') result.drain.assertCurrent();
      diagnostic.record('cleanup-call', result.status === 'retired' ? 'done' : 'pending');
      return result;
    } finally {
      clearTimeout(timer);
      waitSignal.removeEventListener('abort', interrupt);
    }
  }

  /** Cold or warm review cleanup after the Host validates D's original cleanup
   * capability. Never opens an Agent or reissues drive/read authority. */
  async retireReviewForCleanup(
    original: unknown,
    waitSignal: AbortSignal,
  ): Promise<NativeScopeCleanupResult> {
    if (!this.review) throw new NativeReviewError('review-unavailable');
    return this.retireForCleanup(this.review.purpose.cleanupAuthority(original), waitSignal);
  }

  /** Global close seals new admissions first, then waits for every owned retirement. */
  async whenRetirementsIdle(): Promise<void> {
    while (this.cleanups.size) await Promise.allSettled([...this.cleanups.values()]);
    if (this.cleanupFailures.size) throw new NativeWorkError('unavailable');
  }

  private async retireScope(
    scope: NativeWorkScope,
    diagnostic: RetirementDiagnostic,
  ): Promise<Extract<NativeScopeCleanupResult, { status: 'retired' }>> {
    const key = this.sessionKey(scope),
      address = this.scopeKey(scope),
      context = this.review?.purpose.context(scope);
    const find = () => {
      diagnostic.record('cleanup-binding', 'wait');
      try {
        const stored = context ? this.review!.read(key) : this.storage.read(key);
        if (stored === undefined) {
          diagnostic.record('cleanup-binding', 'done');
          return undefined;
        }
        let record;
        if (context) {
          const review = nativeReviewRecordSchema.parse(stored);
          if (nativeReviewScopeKey(review.context) !== address)
            throw new NativeWorkError('scope-mismatch');
          record = review.binding;
        } else record = readNativeRecord(stored);
        const binding = bindingForScope(record, scope);
        if (binding && context) this.review!.purpose.bindScope(binding.scope, context);
        diagnostic.record('cleanup-binding', 'done');
        return binding;
      } catch (error) {
        diagnostic.record('cleanup-binding', 'error', error);
        throw error;
      }
    };
    // The owned runtime retirement itself keeps physical cleanup after a wait abort.
    const control = new AbortController();
    const before = find();
    if (before) diagnostic.attach(this.runtime, before.nativeSessionId);
    const retire = (binding: NativeSessionBinding) => {
      diagnostic.record('cleanup-native-ready', 'wait');
      try {
        const ready = this.runtime.migrationDrain(binding.nativeSessionId);
        ready.assertCurrent();
        diagnostic.record('cleanup-native-ready', 'done');
        return Promise.resolve(ready);
      } catch (error) {
        diagnostic.record('cleanup-native-ready', 'error', error);
        /* A cold/unprepared writer needs the actual retire barrier. */
      }
      return observeRetirementPromise(diagnostic, 'cleanup-native-retire', () =>
        this.runtime.retire(binding.nativeSessionId, control.signal, binding.receipts.length === 0),
      );
    };
    const early = before && retire(before);
    if (early) void early.catch(() => undefined);
    await observeRetirementPromise(diagnostic, 'cleanup-scope-idle', () =>
      this.whenScopeIdle(scope),
    );
    const binding = find();
    if (!binding) {
      if (before || this.nativeAdmissions.has(address)) {
        diagnostic.record('cleanup-binding-check', 'error', 'unavailable');
        throw new NativeWorkError('unavailable');
      }
      const drain = Object.freeze({
        signal: this.cleanupLifetime.signal,
        basis: 'absent-unadmitted' as const,
        assertCurrent: () => {
          if (
            this.cleanupLifetime.signal.aborted ||
            this.scopeActivity.get(address)?.size ||
            this.nativeAdmissions.has(address) ||
            find()
          )
            throw new NativeWorkError('unavailable');
        },
      });
      return { status: 'retired', binding: undefined, drain };
    }
    if (before && before.nativeSessionId !== binding.nativeSessionId) {
      diagnostic.record('cleanup-binding-check', 'error', 'scope-mismatch');
      throw new NativeWorkError('scope-mismatch');
    }
    if (!before) diagnostic.attach(this.runtime, binding.nativeSessionId);
    diagnostic.record('cleanup-input-source', 'wait');
    while (activeInputReads.has(binding.nativeSessionId)) {
      const active = activeInputReads.get(binding.nativeSessionId)!;
      if (active.owner !== this.runtime) {
        diagnostic.record('cleanup-input-source', 'error', 'input-read-busy');
        throw new NativeWorkError('input-read-busy');
      }
      await active.drain;
    }
    diagnostic.record('cleanup-input-source', 'done');
    const native = await (early ?? retire(binding));
    const digest = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
    const assertCurrent = () => {
      diagnostic.record('cleanup-proof', 'wait');
      try {
        const latest = find();
        if (
          this.cleanupLifetime.signal.aborted ||
          this.scopeActivity.get(address)?.size ||
          activeInputReads.has(binding.nativeSessionId) ||
          !latest ||
          createHash('sha256').update(JSON.stringify(latest)).digest('hex') !== digest
        )
          throw new NativeWorkError('unavailable');
        native.assertCurrent();
        diagnostic.record('cleanup-proof', 'done');
      } catch (error) {
        diagnostic.record('cleanup-proof', 'error', error);
        throw error;
      }
    };
    return {
      status: 'retired',
      binding: {
        scope: this.cloneScope(binding.scope),
        nativeSessionId: binding.nativeSessionId,
        nativeAgentId: binding.nativeAgentId,
        selection: structuredClone(binding.selection),
      },
      drain: Object.freeze({
        signal: AbortSignal.any([this.cleanupLifetime.signal, native.signal]),
        basis: native.basis,
        assertCurrent,
      }),
    };
  }

  /** Host-only observation after D authorizes the original member/current node.
   * D pins this origin once; C's canonical migration still checks the actual row
   * and physical barrier. Never invoke from that migration's own metadata slot.
   */
  migrationOrigin(input: NativeMigrationOriginRequest): NativeMigrationOrigin {
    const parsed = originRequestSchema.safeParse(input);
    if (!parsed.success) throw new NativeWorkError('invalid-request');
    if (this.inputReadsSealed) throw new NativeWorkError('unavailable');
    const data = parsed.data,
      key = this.sessionKey(data.scope);
    if (this.unknownMigrations.has(key)) throw new NativeWorkError('migration-unknown');
    if (this.migrating.has(key) || this.locks.has(key) || this.inputReadDrains.has(key))
      throw new NativeWorkError('unavailable');
    const stored = this.storage.read(key);
    if (stored === undefined) throw new NativeWorkError('not-started');
    const record = readNativeRecord(stored),
      origin = nativeMigrationOrigin(record, data),
      previous = bindingForScope(record, origin.scope);
    if (!previous) throw new NativeWorkError('binding-state-invalid');
    for (const binding of new Set([previous, currentBinding(record)])) {
      if (
        this.scopeActivity.get(this.scopeKey(binding.scope))?.size ||
        activeInputReads.has(binding.nativeSessionId) ||
        (this.runtime.isConnected(binding.nativeSessionId) &&
          this.runtime.status(binding.nativeSessionId) !== 'idle')
      )
        throw new NativeWorkError('unavailable');
      try {
        this.runtime.migrationDrain(binding.nativeSessionId).assertCurrent();
      } catch (error) {
        // A cold/never-prepared binding may be observed without inventing a
        // ready certificate. An owned pending preparation must finish first.
        if (!(error instanceof NativeWorkError) || error.code !== 'migration-not-ready')
          throw error;
        if (this.retiredScopes.has(this.scopeKey(binding.scope)))
          throw new NativeWorkError('unavailable');
      }
    }
    return origin;
  }

  /** Pure readiness observation for D. Own migration metadata slots are not
   * external scope activity; a send/queue/source/restore always invalidates it. */
  migrationDrain(scope: NativeWorkScope): NativeMigrationDrain {
    if (!nativeScopeSchema.safeParse(scope).success) throw new NativeWorkError('invalid-request');
    const record = this.storage.read(this.sessionKey(scope));
    if (!record) throw new NativeWorkError('not-started');
    const binding = bindingForScope(readNativeRecord(record), scope);
    if (!binding) throw new NativeWorkError('scope-mismatch');
    const key = this.scopeKey(scope),
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
        const stored = this.storage.read(this.sessionKey(scope));
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
    const key = this.sessionKey(data.scope);
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
    this.assertConversationMigration(record);
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
    this.retiredScopes.add(this.scopeKey(data.previousScope));
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
      this.prepared.get(this.scopeKey(data.previousScope))?.controller.abort();
      const controller = new AbortController();
      this.prepared.set(this.scopeKey(data.previousScope), {
        controller,
        signal: AbortSignal.any([controller.signal, native.signal]),
        epoch: this.scopeEpochs.get(this.scopeKey(data.previousScope)) ?? 0,
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
      this.assertConversationMigration(record);
      const replay = inspectNativeMigration(record, data);
      if (replay) return replay;
      const next = appendNativeMigration(record, data);
      const preserved = preserveNativeConversation(record, next.record);
      if (Buffer.byteLength(JSON.stringify(preserved)) > NATIVE_LINEAGE_LIMITS.bytes)
        throw new NativeWorkError('capacity');
      readNativeRecord(preserved);
      verify('migrate');
      // Once admitted, await durability. Never call a possible committed put
      // "pending/no change" or roll back to the old binding on an unknown error.
      try {
        await this.storage.write(key, preserved);
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
    this.check(grant, action);
    const key = this.sessionKey(grant.scope);
    if (['send', 'queue'].includes(action)) {
      if (this.unknownMigrations.has(key)) throw new NativeWorkError('migration-unknown');
      if (this.retiredScopes.has(this.scopeKey(grant.scope)))
        throw new NativeWorkError('scope-mismatch');
    }
    const context = this.review?.purpose.context(grant.scope);
    const stored = context ? this.review?.read(key) : this.storage.read(key);
    if (stored === undefined) return undefined;
    const record = context ? this.reviewRecord(grant).binding : readNativeRecord(stored);
    const value = ['open', 'history', 'follow'].includes(action)
      ? bindingForScope(record, grant.scope)
      : currentBinding(record);
    if (value && context) this.review?.purpose.bindScope(value.scope, context);
    if (value === undefined || !this.sameScope(value.scope, grant.scope))
      throw new NativeWorkError('scope-mismatch');
    // Persisted ownership survives a Host restart; the old Work purpose never
    // regains drive merely because this process has no warm retiredScopes set.
    if (
      ['send', 'queue'].includes(action) &&
      nativeConversationSession(record, value.nativeSessionId)
    )
      throw new NativeWorkError('scope-mismatch');
    const clone = structuredClone(value);
    if (context) this.review?.purpose.bindScope(clone.scope, context);
    return clone;
  }

  private async writeBinding(
    grant: NativeWorkGrant,
    action: NativeWorkAction,
    binding: NativeSessionBinding,
  ): Promise<void> {
    this.check(grant, action);
    const key = this.sessionKey(grant.scope);
    const context = this.review?.purpose.context(grant.scope);
    if (context) {
      const record = this.reviewRecord(grant),
        current = currentBinding(record.binding);
      if (
        !sameScope(current.scope, binding.scope) ||
        current.nativeSessionId !== binding.nativeSessionId ||
        current.nativeAgentId !== binding.nativeAgentId
      )
        throw new NativeWorkError('scope-mismatch');
      await this.writeReview(grant, {
        ...record,
        binding:
          record.binding.schemaVersion === 1 ? binding : { ...record.binding, current: binding },
      });
      return;
    }
    if (this.unknownMigrations.has(key)) throw new NativeWorkError('migration-unknown');
    const stored = this.storage.read(key);
    if (!stored) throw new NativeWorkError('not-started');
    const record = readNativeRecord(stored);
    const current = currentBinding(record);
    if (
      !this.sameScope(current.scope, binding.scope) ||
      current.nativeSessionId !== binding.nativeSessionId ||
      current.nativeAgentId !== binding.nativeAgentId
    )
      throw new NativeWorkError('scope-mismatch');
    const next = preserveNativeConversation(
      record,
      record.schemaVersion === 1 ? binding : { ...record, current: binding },
    );
    if (Buffer.byteLength(JSON.stringify(next)) > NATIVE_LINEAGE_LIMITS.bytes)
      throw new NativeWorkError('capacity');
    await this.storage.write(key, next);
  }

  private required(grant: NativeWorkGrant, action: NativeWorkAction): NativeSessionBinding {
    const value = this.read(grant, action);
    if (!value) throw new NativeWorkError('not-started');
    return value;
  }

  /** Authenticated binding metadata; reading it does not query the live Agent's status. */
  readBinding(grant: NativeWorkGrant): NativeSessionBinding | undefined {
    return this.read(grant, 'open');
  }

  /** Read-only navigation: never creates, resumes, wakes or replays native work. */
  open(grant: NativeWorkGrant) {
    const binding = this.readBinding(grant);
    return binding === undefined
      ? undefined
      : {
          binding,
          status:
            (this.isReviewPurpose(grant) ||
              !nativeConversationSession(
                this.conversationRecord(grant.scope),
                binding.nativeSessionId,
              )) &&
            this.runtime.isConnected(binding.nativeSessionId)
              ? this.runtime.status(binding.nativeSessionId)
              : ('detached' as const),
        };
  }

  /** Host-only same-owner check; never accepts a serialized runtime identity. */
  ownsResultRuntime(runtime: NativeWorkRuntime): boolean {
    return runtime === this.runtime;
  }

  readResultSnapshot(grant: NativeWorkGrant, signal: AbortSignal): Promise<NativeResultSnapshot> {
    const binding = this.required(grant, 'history');
    if (this.conversationPrefix(grant)) return this.readOriginalPrefix(grant, signal);
    if (!this.runtime.readResultSnapshot) throw new NativeWorkError('unavailable');
    const verify = () => {
      const fresh = this.required(grant, 'history');
      if (
        !this.sameScope(fresh.scope, binding.scope) ||
        !sameSelection(fresh.selection, binding.selection) ||
        fresh.nativeSessionId !== binding.nativeSessionId ||
        fresh.nativeAgentId !== binding.nativeAgentId
      )
        throw new NativeWorkError('scope-mismatch');
    };
    return this.runtime.readResultSnapshot(
      binding,
      AbortSignal.any([signal, grant.signal]),
      verify,
    );
  }

  /** Queued with sends: accepted input cannot race behind a completion declaration. */
  declareResultIntent(
    grant: NativeWorkGrant,
    raw: NativeWorkResultIntent,
    validate: (snapshot: NativeResultSnapshot) => undefined,
  ): Promise<NativeSessionBinding> {
    const intent = nativeWorkResultIntentSchema.parse(raw);
    if (intent.cut) throw new NativeWorkError('invalid-request');
    return this.serial(grant, 'send', async (verify) => {
      const binding = this.required(grant, 'send');
      if (this.completionPending(grant, binding)) throw new NativeWorkError('completion-pending');
      const snapshot = await this.readResultSnapshot(grant, grant.signal);
      verify();
      if (snapshot.hasPending) throw new NativeWorkError('input-pending');
      if (validate(snapshot) !== undefined) throw new NativeWorkError('invalid-request');
      snapshot.check();
      const next = { ...binding, resultIntent: intent };
      await this.writeBinding(grant, 'send', next);
      verify();
      snapshot.check();
      return structuredClone(next);
    });
  }

  sealResultIntent(
    grant: NativeWorkGrant,
    intentId: string,
    raw: NativeResultCut,
    assertSource: () => undefined,
  ): Promise<NativeSessionBinding> {
    const cut = nativeResultCutSchema.parse(raw);
    return this.serial(grant, 'send', async (verify) => {
      const binding = this.required(grant, 'send');
      if (binding.resultIntent?.intentId !== intentId) throw new NativeWorkError('scope-mismatch');
      if (
        binding.resultIntent.cut &&
        JSON.stringify(binding.resultIntent.cut) !== JSON.stringify(cut)
      )
        throw new NativeWorkError('idempotency-mismatch');
      if (assertSource() !== undefined) throw new NativeWorkError('invalid-request');
      const next = { ...binding, resultIntent: { ...binding.resultIntent, cut } };
      // Recovery requalifies the original cut; identical facts need no durable rewrite.
      if (!binding.resultIntent.cut) await this.writeBinding(grant, 'send', next);
      verify();
      if (assertSource() !== undefined) throw new NativeWorkError('invalid-request');
      return structuredClone(next);
    });
  }

  /** Match an already sealed cut with history authority only. This never seals
   * a new cut, writes metadata, creates an Agent or issues a result/drain proof;
   * the original result owner must separately requalify its actual SDK source. */
  readSealedResultIntent(
    grant: NativeWorkGrant,
    intentId: string,
    raw: NativeResultCut,
    assertSource: () => undefined,
  ): Promise<NativeSessionBinding> {
    const cut = nativeResultCutSchema.parse(raw);
    return this.serial(grant, 'history', async (verify) => {
      const binding = this.required(grant, 'history');
      if (binding.resultIntent?.intentId !== intentId || !binding.resultIntent.cut)
        throw new NativeWorkError('scope-mismatch');
      if (JSON.stringify(binding.resultIntent.cut) !== JSON.stringify(cut))
        throw new NativeWorkError('idempotency-mismatch');
      if (assertSource() !== undefined) throw new NativeWorkError('invalid-request');
      verify();
      const current = this.required(grant, 'history');
      if (JSON.stringify(current) !== JSON.stringify(binding))
        throw new NativeWorkError('scope-mismatch');
      return structuredClone(current);
    });
  }

  clearResultIntent(grant: NativeWorkGrant, intentId: string): Promise<void> {
    return this.serial(grant, 'send', async (verify) => {
      const binding = this.required(grant, 'send');
      if (!binding.resultIntent) return;
      if (binding.resultIntent.intentId !== intentId || binding.resultIntent.cut)
        throw new NativeWorkError('scope-mismatch');
      const { resultIntent: _intent, ...next } = binding;
      await this.writeBinding(grant, 'send', next);
      verify();
    });
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
          scope: this.cloneScope(grant.scope),
          nativeSessionId: sessionId,
          nativeAgentId: sessionId,
          selection,
          receipts: [],
        };
        verify();
        const context = this.review?.purpose.context(grant.scope);
        if (context)
          await this.writeReview(grant, { schemaVersion: 3, role: 'review', context, binding });
        else await this.storage.write(this.sessionKey(grant.scope), binding);
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
      if (this.completionPending(grant, binding)) {
        if (!prior) throw new NativeWorkError('completion-pending');
        // An acknowledged retry remains readable and never wakes the sealed writer.
        const snapshot = await this.readResultSnapshot(grant, grant.signal);
        verify();
        snapshot.check();
        const claimed = snapshot.events.some(
          (event) =>
            event.type === 'user/message' &&
            event.data !== null &&
            typeof event.data === 'object' &&
            'id' in event.data &&
            event.data.id === prior.messageId,
        );
        return {
          ...prior,
          status: snapshot.pendingMessageIds.includes(prior.messageId)
            ? 'received'
            : claimed
              ? 'claimed'
              : 'unknown',
        };
      }
      if (!prior && binding.receipts.length >= NATIVE_WORK_LIMITS.receipts)
        throw new NativeWorkError('capacity');
      this.observeNativeAdmission(binding.scope);
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
        { id: receipt.messageId, text: input.text, rpcId: input.requestId },
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
    this.check(grant, action);
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
      if (this.completionPending(grant, binding)) throw new NativeWorkError('completion-pending');
      this.observeNativeAdmission(binding.scope);
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
    this.check(grant, 'stop');
    const key = this.sessionKey(grant.scope);
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
      this.check(grant, 'stop');
      return { status: result };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Raw Host-internal history retains its original capacity rejection. */
  history(
    grant: NativeWorkGrant,
    after = -1,
    limit: number = NATIVE_WORK_LIMITS.historyEvents,
    signal: AbortSignal = grant.signal,
  ) {
    return this.readHistory(grant, after, limit, signal, false);
  }

  /** Read-only UI history; this cannot create, resume or drive a native Agent. */
  conversationHistory(
    grant: NativeWorkGrant,
    after = -1,
    limit: number = NATIVE_WORK_LIMITS.historyEvents,
    signal: AbortSignal = grant.signal,
  ) {
    return this.readHistory(grant, after, limit, signal, true);
  }

  private async readHistory(
    grant: NativeWorkGrant,
    after = -1,
    limit: number = NATIVE_WORK_LIMITS.historyEvents,
    signal: AbortSignal,
    presentation: boolean,
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
    const prefix = this.conversationPrefix(grant);
    if (prefix) {
      const snapshot = await this.readOriginalPrefix(grant, signal);
      snapshot.check();
      const raw = snapshot.events.filter((event) => event.seq > after).slice(0, limit);
      const events = presentation ? publicNativeHistoryPage(raw) : raw.map(publicNativeResultEvent);
      if (Buffer.byteLength(JSON.stringify(events)) > 262_144)
        throw new NativeWorkError('capacity');
      this.check(grant, 'history');
      return { binding, events: structuredClone(events) };
    }
    const combined = AbortSignal.any([grant.signal, signal, this.workReadSignal(binding)]);
    const read = presentation ? this.runtime.conversationHistory : this.runtime.history;
    if (!read) throw new NativeWorkError('unavailable');
    const events = await read.call(
      this.runtime,
      binding.nativeSessionId,
      after,
      limit,
      combined,
      binding.receipts.length === 0,
    );
    combined.throwIfAborted();
    this.check(grant, 'history');
    return { binding, events: structuredClone(events) };
  }

  /** Reads the official durable inbox without creating, resuming or waking an Agent. */
  async readInbox(grant: NativeWorkGrant, signal: AbortSignal = grant.signal) {
    const binding = this.required(grant, 'history');
    if (this.conversationPrefix(grant)) {
      const snapshot = await this.readOriginalPrefix(grant, signal);
      const claimed = new Set(
        snapshot.events.flatMap((event) => {
          const data = event.data;
          if (
            event.type !== 'user/message' ||
            !data ||
            typeof data !== 'object' ||
            !('id' in data) ||
            typeof data.id !== 'string' ||
            !('source' in data) ||
            !data.source ||
            typeof data.source !== 'object' ||
            !('kind' in data.source) ||
            data.source.kind !== 'user'
          )
            return [];
          return [data.id];
        }),
      );
      snapshot.check();
      if (snapshot.hasPending) throw new NativeWorkError('input-pending');
      return {
        binding,
        asOfSeq: snapshot.asOfSeq,
        items: [],
        receipts: binding.receipts.map((receipt) => ({
          requestId: receipt.requestId,
          messageId: receipt.messageId,
          mode: receipt.mode,
          status: claimed.has(receipt.messageId) ? ('claimed' as const) : ('unknown' as const),
        })),
      };
    }
    const combined = AbortSignal.any([grant.signal, signal, this.workReadSignal(binding)]);
    const verify = () => {
      combined.throwIfAborted();
      const fresh = this.required(grant, 'history');
      if (
        fresh.nativeSessionId !== binding.nativeSessionId ||
        fresh.nativeAgentId !== binding.nativeAgentId ||
        !this.sameScope(fresh.scope, binding.scope) ||
        !sameSelection(fresh.selection, binding.selection)
      )
        throw new NativeWorkError('scope-mismatch');
      return fresh;
    };
    const snapshot = await this.runtime.readInbox(
      binding.nativeSessionId,
      combined,
      binding.receipts.length === 0,
      verify,
    );
    const fresh = verify();
    const claimed = new Set(snapshot.claimedMessageIds);
    const pending = new Set(snapshot.items.map((item) => item.id));
    return {
      binding: fresh,
      asOfSeq: snapshot.asOfSeq,
      receipts: fresh.receipts.map((receipt) => ({
        requestId: receipt.requestId,
        messageId: receipt.messageId,
        mode: receipt.mode,
        status: pending.has(receipt.messageId)
          ? ('received' as const)
          : claimed.has(receipt.messageId)
            ? ('claimed' as const)
            : ('unknown' as const),
      })),
      items: snapshot.items.flatMap((item) => {
        const receipt = fresh.receipts.find((entry) => entry.messageId === item.id);
        return receipt
          ? [
              {
                ...item,
                requestId: receipt.requestId,
                mode: receipt.mode,
                status: 'received' as const,
              },
            ]
          : [];
      }),
    };
  }

  /** Public presentation whitelist; raw native history/follow remain Host-internal. */
  async *observe(grant: NativeWorkGrant, after = -1, signal: AbortSignal = grant.signal) {
    const binding = this.required(grant, 'follow');
    const projection = new NativeConversationProjection(binding.nativeSessionId, after);
    for await (const item of this.follow(grant, after, signal)) {
      this.check(grant, 'follow');
      const frame = projection.push(item);
      if (!frame) continue;
      this.check(grant, 'follow');
      yield {
        scope: structuredClone(binding.scope),
        nativeSessionId: binding.nativeSessionId,
        ...frame,
      };
      if (frame.type === 'gap') return;
    }
  }

  async *follow(grant: NativeWorkGrant, after = -1, signal: AbortSignal = grant.signal) {
    const binding = this.required(grant, 'follow');
    if (!Number.isSafeInteger(after) || after < -1) throw new NativeWorkError('invalid-request');
    const prefix = this.conversationPrefix(grant);
    if (prefix) {
      const snapshot = await this.readOriginalPrefix(grant, signal);
      for (const event of snapshot.events.filter((event) => event.seq > after)) {
        this.check(grant, 'follow');
        snapshot.check();
        signal.throwIfAborted();
        yield {
          scope: structuredClone(binding.scope),
          nativeSessionId: binding.nativeSessionId,
          type: 'event' as const,
          event: structuredClone(publicNativeResultEvent(event)),
        };
      }
      return;
    }
    const combined = AbortSignal.any([grant.signal, signal, this.workReadSignal(binding)]);
    const verify = () => {
      combined.throwIfAborted();
      const fresh = this.required(grant, 'follow');
      if (
        fresh.nativeSessionId !== binding.nativeSessionId ||
        fresh.nativeAgentId !== binding.nativeAgentId ||
        !this.sameScope(fresh.scope, binding.scope) ||
        !sameSelection(fresh.selection, binding.selection)
      )
        throw new NativeWorkError('scope-mismatch');
    };
    for await (const frame of this.runtime.follow(
      binding.nativeSessionId,
      after,
      combined,
      binding.receipts.length === 0,
      () => this.check(grant, 'follow'),
      binding.scope,
    )) {
      if (combined.aborted) return;
      // Re-read the binding at the opening cut; ordinary native frames retain
      // the original current-grant check without parsing all receipts per chunk.
      if (
        frame.type === 'assistant-stream' &&
        frame.frame !== null &&
        typeof frame.frame === 'object' &&
        'type' in frame.frame &&
        frame.frame.type === 'snapshot'
      )
        verify();
      else this.check(grant, 'follow');
      yield {
        scope: structuredClone(binding.scope),
        nativeSessionId: binding.nativeSessionId,
        ...structuredClone(frame),
      };
    }
  }
}
