import type { NativeResultSnapshot } from './native-work-session-result-contract.js';
import type { NativeWorkResultIntent } from './native-work-session-result-intent.js';

/** Host-internal seam. Never deserialize a grant from a Client or model request. */
export interface NativeWorkScope {
  readonly actorId: string;
  readonly spaceId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly runId: string;
  readonly generation: number;
  readonly segmentId: string;
}

export type NativeWorkAction = 'open' | 'send' | 'queue' | 'stop' | 'history' | 'follow';

/**
 * B issues this after resolving the member and the current Execution Run.
 * `assertCurrent` synchronously rechecks the exact actor/space/node/Run/segment
 * and requested action; `signal` aborts when that authority is revoked.
 * Neither method may merely inspect the request's claimed identity.
 */
export interface NativeWorkGrant {
  readonly scope: NativeWorkScope;
  readonly signal: AbortSignal;
  assertCurrent(action: NativeWorkAction): void;
}

export interface NativeSessionSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly maxTokens: number;
  /** Immutable version of the Host's scoped prompt/tool/resource composition. */
  readonly configurationId: string;
}

export type NativeMessageMode = 'followup' | 'steer' | 'queue';
export interface NativeMessageReceipt {
  readonly requestId: string;
  readonly messageId: string;
  readonly fingerprint: string;
  readonly mode: NativeMessageMode;
  /** Received/claimed are native facts; neither asserts model adoption. */
  readonly status: 'reserved' | 'received' | 'claimed' | 'discarded' | 'unknown';
}

/** Metadata only. The transcript and pending message bodies remain in DSH. */
export interface NativeSessionBinding {
  readonly schemaVersion: 1;
  readonly scope: NativeWorkScope;
  readonly nativeSessionId: string;
  readonly nativeAgentId: string;
  readonly selection: NativeSessionSelection;
  readonly receipts: readonly NativeMessageReceipt[];
  /** Aggregate reservation counters only; tool content/provenance stays in DSH. */
  readonly inputReadBudget?:
    { readonly attempts: number; readonly chargedBytes: number } | undefined;
  /** Versioned metadata only. Result content remains exclusively in the native log. */
  readonly resultIntent?: NativeWorkResultIntent | undefined;
}

/** One atomic mapping row; prior bindings are metadata, never transcript copies. */
export interface NativeSessionLineage {
  readonly schemaVersion: 2;
  /** Total segments, including current. Matches prior.length + 1. */
  readonly version: number;
  readonly current: NativeSessionBinding;
  readonly prior: readonly {
    readonly binding: NativeSessionBinding;
    readonly migration: {
      readonly requestId: string;
      readonly inputFingerprint: string;
      readonly fingerprint: string;
    };
  }[];
}
export type NativeWorkSessionRecord = NativeSessionBinding | NativeSessionLineage;

/** Issued from D's durable old/new Run pair, not derived from a drive/read grant.
 * assertCurrent rechecks old terminal/resource-settled and exact new current
 * scope/selection/input fingerprint plus live permission. Never a JSON DTO.
 */
export interface NativeRunMigrationGrant {
  readonly requestId: string;
  readonly inputFingerprint: string;
  readonly previousScope: NativeWorkScope;
  readonly scope: NativeWorkScope;
  readonly selection: NativeSessionSelection;
  readonly signal: AbortSignal;
  assertCurrent(phase: 'prepare' | 'migrate'): void;
}
/** D supplies these current persisted facts only after member/node authorization.
 * This observation is neither a permission nor a native readiness certificate.
 */
export type NativeMigrationOriginRequest = Pick<
  NativeRunMigrationGrant,
  'requestId' | 'inputFingerprint' | 'scope' | 'selection'
>;
export interface NativeMigrationOrigin {
  readonly scope: NativeWorkScope;
  /** Frozen selection of the actual old binding, not the new requested selection. */
  readonly selection: NativeSessionSelection;
}
/** Read-only, process-local evidence of actual native cleanup, not Run authority. */
export interface NativeMigrationDrain {
  readonly signal: AbortSignal;
  readonly basis: 'flushed-and-closed' | 'absent-unadmitted';
  assertCurrent(): void;
}
/** A adapts D's original cleanup capability through that manager's identity check.
 * This never grants history, driving, migration or product submission.
 */
export interface NativeScopeCleanupAuthority {
  readonly scope: NativeWorkScope;
  assertCurrent(): undefined;
}
export type NativeScopeCleanupResult =
  | { readonly status: 'pending' }
  | {
      readonly status: 'retired';
      readonly binding: NativeBindingReference | undefined;
      readonly drain: NativeMigrationDrain;
    };
export type NativeBindingReference = Pick<
  NativeSessionBinding,
  'scope' | 'nativeSessionId' | 'nativeAgentId' | 'selection'
>;
export type NativeRunMigrationResult =
  | { readonly status: 'pending' }
  | {
      readonly status: 'migrated' | 'replayed';
      readonly previous: NativeBindingReference;
      readonly next: NativeBindingReference;
    };

/** Process-local capability, never a model argument or a persistent read ledger. */
export interface NativeInputReadReservation {
  readonly id: string;
  readonly maximumBytes: number;
}

export interface NativeWorkStorage {
  read(key: string): NativeWorkSessionRecord | undefined;
  write(key: string, binding: NativeWorkSessionRecord): Promise<void>;
}

export interface NativeSessionMessage {
  readonly id: string;
  readonly text: string;
}

export interface NativeHistoryEvent {
  readonly seq: number;
  readonly time: number;
  readonly type: string;
  readonly data: unknown;
}

export type NativeWorkFrame =
  | { readonly type: 'event'; readonly event: NativeHistoryEvent }
  | { readonly type: 'assistant-stream'; readonly frame: unknown }
  | { readonly type: 'status'; readonly status: 'idle' | 'running' }
  | { readonly type: 'gap'; readonly after: number };

/** Read-only cut of the official inbox; received never means adopted by the model. */
export interface NativeInboxSnapshot {
  readonly asOfSeq: number;
  /** Exact native user/message facts at this same cut; not proof of model adoption. */
  readonly claimedMessageIds: readonly string[];
  readonly items: readonly {
    readonly id: string;
    readonly text: string;
    readonly target: 'next-turn' | 'next-step';
  }[];
}

/** Process-local visible prefix, never a durable message or a native stream replay. */
export interface NativeAssistantSnapshot {
  readonly type: 'snapshot';
  readonly revision: number;
  readonly activeAttempt?: {
    readonly attemptId: string;
    readonly startedAfterSeq: number;
    readonly nextIndex: number;
    readonly text: string;
    readonly toolNames: readonly string[];
  };
}

/** Whitelisted presentation only. No raw events, reasoning, tool arguments or replay data. */
export const NATIVE_TURN_END_KINDS = Object.freeze([
  'completed',
  'blocked',
  'max-tokens',
  'error',
  'aborted',
  'interrupted',
  'forked',
] as const);
export type NativeTurnEndKind = (typeof NATIVE_TURN_END_KINDS)[number] | 'unknown';
export type NativeConversationFrame =
  | {
      readonly type: 'turn-end';
      readonly seq: number;
      readonly time: number;
      readonly turn: number;
      readonly reason: { readonly kind: NativeTurnEndKind };
    }
  | {
      readonly type: 'message';
      readonly seq: number;
      readonly time: number;
      readonly messageKey: string;
      readonly role: 'user' | 'assistant';
      readonly id: string;
      readonly text: string;
      readonly interrupted?: true;
    }
  | {
      readonly type: 'assistant-stream';
      readonly frame:
        | NativeAssistantSnapshot
        | { readonly type: 'start'; readonly attemptId: string; readonly revision: number }
        | {
            readonly type: 'chunk';
            readonly attemptId: string;
            readonly revision: number;
            readonly index: number;
            readonly text?: string;
            readonly toolName?: string;
          }
        | {
            readonly type: 'end';
            readonly attemptId: string;
            readonly revision: number;
            readonly index: number;
            readonly outcome:
              | {
                  readonly kind: 'committed';
                  readonly eventType: 'assistant/message' | 'assistant/attempt';
                  readonly seq: number;
                  readonly messageKey: string;
                }
              | { readonly kind: 'abandoned' };
          };
    }
  | { readonly type: 'status'; readonly status: 'idle' | 'running' }
  | { readonly type: 'gap'; readonly after: number };

/** The only driver is the public DSH AgentRegistry/Agent implementation. */
export interface NativeWorkRuntime {
  readResultSnapshot?(
    binding: NativeSessionBinding,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<NativeResultSnapshot>;
  connect(
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    allowCreate: boolean,
  ): Promise<void>;
  isConnected(sessionId: string): boolean;
  status(sessionId: string): 'idle' | 'running';
  pending(sessionId: string): readonly {
    readonly id: string;
    readonly text: string;
    readonly target: 'next-turn' | 'next-step';
  }[];
  readInbox(
    sessionId: string,
    signal: AbortSignal,
    allowAbsent: boolean,
    assertCurrent: () => void,
  ): Promise<NativeInboxSnapshot>;
  messageStatus(
    sessionId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<'received' | 'claimed' | 'discarded' | 'absent'>;
  send(sessionId: string, message: NativeSessionMessage, mode: NativeMessageMode): void;
  edit(sessionId: string, messageId: string, text: string): boolean;
  remove(sessionId: string, messageId: string): boolean;
  reorder(sessionId: string, messageIds: readonly string[]): void;
  stop(sessionId: string, signal: AbortSignal): Promise<'stopped' | 'pending'>;
  flush(sessionId: string): Promise<void>;
  history(
    sessionId: string,
    after: number,
    limit: number,
    signal: AbortSignal,
    allowAbsent?: boolean,
  ): Promise<readonly NativeHistoryEvent[]>;
  /** UI-only durable history, projected before the original public byte budget. */
  conversationHistory?(
    sessionId: string,
    after: number,
    limit: number,
    signal: AbortSignal,
    allowAbsent?: boolean,
  ): Promise<readonly NativeHistoryEvent[]>;
  follow(
    sessionId: string,
    after: number,
    signal: AbortSignal,
    allowAbsent?: boolean,
    assertCurrent?: () => void,
    expectedScope?: NativeWorkScope,
  ): AsyncIterable<NativeWorkFrame>;
  disconnect(sessionId: string): Promise<void>;
  /** Independent cleanup authority is checked by the service, not an expired old drive grant.
   * A cancelled caller wait must not abandon native disposal/flush/source drain.
   */
  retire(
    sessionId: string,
    signal: AbortSignal,
    allowAbsent?: boolean,
  ): Promise<NativeMigrationDrain>;
  /** Read-only: migration-not-ready is an uncertified cold/pending epoch;
   * known ownership, identity or cleanup failures remain unavailable.
   */
  migrationDrain(sessionId: string): NativeMigrationDrain;
}

export class NativeWorkError extends Error {
  constructor(
    readonly code:
      | 'invalid-request'
      | 'scope-mismatch'
      | 'not-started'
      | 'configuration-mismatch'
      | 'idempotency-mismatch'
      | 'capacity'
      | 'delivery-unknown'
      | 'read-timeout'
      | 'input-read-busy'
      | 'input-read-budget-exceeded'
      | 'input-context-unavailable'
      | 'input-required-unavailable'
      | 'completion-pending'
      | 'input-pending'
      | 'binding-state-invalid'
      | 'migration-conflict'
      | 'migration-not-ready'
      | 'migration-unknown'
      | 'unavailable'
      | 'not-pending'
      | 'cancelled',
  ) {
    super(code);
    this.name = 'NativeWorkError';
  }
}
