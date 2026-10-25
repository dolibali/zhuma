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
}

export interface NativeWorkStorage {
  read(key: string): NativeSessionBinding | undefined;
  write(key: string, binding: NativeSessionBinding): Promise<void>;
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

/** The only driver is the public DSH AgentRegistry/Agent implementation. */
export interface NativeWorkRuntime {
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
  ): Promise<readonly NativeHistoryEvent[]>;
  follow(sessionId: string, after: number, signal: AbortSignal): AsyncIterable<NativeWorkFrame>;
  disconnect(sessionId: string): Promise<void>;
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
      | 'unavailable'
      | 'not-pending'
      | 'cancelled',
  ) {
    super(code);
    this.name = 'NativeWorkError';
  }
}
