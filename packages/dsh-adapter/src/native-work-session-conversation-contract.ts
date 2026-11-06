import type {
  NativeReleasedConversationAuthorities,
  NativeReleasedConversationBackend,
} from './native-released-conversation-authority.js';
import {
  NativeWorkError,
  type NativeBindingReference,
  type NativeMessageReceipt,
  type NativeSessionBinding,
  type NativeWorkGrant,
  type NativeWorkAction,
  type NativeWorkScope,
  type NativeWorkSessionRecord,
} from './native-work-session-contract.js';

/** Append-only SDK prefix identity. No transcript or native path is stored here. */
export interface NativeConversationPrefix {
  readonly asOfSeq: number;
  readonly eventCount: number;
  readonly inheritedEventCount: number;
  readonly headerDigest: string;
  readonly eventsDigest: string;
}
export interface NativeConversationReceipt extends NativeMessageReceipt {
  readonly actorId: string;
  readonly backendId: string;
  readonly chatEpoch: number;
}
export interface NativeConversationSession {
  readonly origin: NativeBindingReference;
  readonly prefix: NativeConversationPrefix;
  readonly chatEpoch: number;
  readonly actorId: string;
  readonly backendId: string;
  readonly phase: 'reserved' | 'active' | 'retiring' | 'settled' | 'unknown';
  readonly receipts: readonly NativeConversationReceipt[];
}
/** The original mapping envelope only; each physical SID retains its own fence. */
export interface NativeConversationMetadata {
  readonly schemaVersion: 1;
  readonly sessions: readonly NativeConversationSession[];
}
export interface NativeConversationIssuerPorts {
  readonly backend: NativeReleasedConversationBackend;
  assertGrant: NativeReleasedConversationAuthorities['assertGrant'];
  assertReadGrant: NativeReleasedConversationAuthorities['assertReadGrant'];
}
/** Private closures over the same native owner and its original mapping lock. */
export interface NativeConversationMappingPorts {
  readonly signal: AbortSignal;
  read(scope: NativeWorkScope): NativeWorkSessionRecord;
  serial<T>(scope: NativeWorkScope, check: () => void, work: () => Promise<T>): Promise<T>;
  write(scope: NativeWorkScope, record: NativeWorkSessionRecord, check: () => void): Promise<void>;
  admit(scope: NativeWorkScope): void;
}
export interface NativeConversationRuntimeContext {
  readonly binding: NativeSessionBinding;
  readonly chatEpoch: number;
  readonly prefix: NativeConversationPrefix;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface NativeConversationReadSource {
  readonly persistence: symbol;
  readonly registry: object;
  readonly projection: object;
}

const leases = new WeakMap<NativeWorkGrant, NativeConversationRuntimeContext>();
const scopes = new WeakSet<object>();
const signals = new WeakSet<AbortSignal>();
const assertions = new WeakSet<NativeWorkGrant['assertCurrent']>();

/** C-internal factory; never exported from the package or handed to transport. */
export function nativeConversationRuntimeGrant(
  context: NativeConversationRuntimeContext,
): NativeWorkGrant {
  const scope = Object.freeze({ ...context.binding.scope });
  const signal = AbortSignal.any([context.signal]);
  const grant: NativeWorkGrant = Object.freeze({
    scope,
    signal,
    assertCurrent(this: NativeWorkGrant, action: NativeWorkAction) {
      if (this !== grant || action === 'queue' || signal.aborted)
        throw new NativeWorkError('scope-mismatch');
      context.assertCurrent();
    },
  });
  leases.set(grant, context);
  scopes.add(scope);
  signals.add(signal);
  assertions.add(grant.assertCurrent);
  return grant;
}
export const nativeConversationRuntimeContext = (grant: NativeWorkGrant) => leases.get(grant);

/** A private chat lease and its forwarded pieces never become Work authority. */
export function assertNotNativeConversationGrant(grant: NativeWorkGrant): void {
  if (
    leases.has(grant) ||
    scopes.has(grant.scope) ||
    signals.has(grant.signal) ||
    assertions.has(grant.assertCurrent)
  )
    throw new NativeWorkError('scope-mismatch');
}
