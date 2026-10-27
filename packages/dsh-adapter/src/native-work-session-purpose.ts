import { canonicalPayload } from '@zhuma/agent-core';
import {
  executionReviewScopeSchema,
  type ExecutionReviewScope,
} from './execution-review-contract.js';
import type {
  NativeSessionSelection,
  NativeWorkAction,
  NativeWorkGrant,
  NativeWorkScope,
  NativeScopeCleanupAuthority,
} from './native-work-session-contract.js';
import {
  nativeSelectionSchema,
  nativeWorkSessionKey,
  nativeScopeKey,
} from './native-work-session-record.js';
import {
  NativeReviewError,
  nativeReviewContextFromScope,
  nativeReviewSessionKey,
  nativeReviewScopeKey,
  type NativeReviewContext,
  type NativeReviewReadLease,
} from './native-work-session-review-contract.js';

const grantOwners = new WeakMap<NativeWorkGrant, NativeSessionPurpose>();
const scopeOwners = new WeakMap<NativeWorkScope, NativeSessionPurpose>();
const cleanupOwners = new WeakMap<object, NativeSessionPurpose>();
const reviewAssertions = new WeakSet<NativeWorkGrant['assertCurrent']>();
const reviewSignals = new WeakSet<AbortSignal>();
let checkingGrant: NativeWorkGrant | undefined;

/** Synchronous receiver provenance. A bound/forwarding method must not use the
 * original review capability to qualify another object through author routing. */
export function invokeNativeWorkGrantAssertion(
  grant: NativeWorkGrant,
  action: NativeWorkAction,
): void {
  const previous = checkingGrant;
  checkingGrant = grant;
  try {
    grant.assertCurrent(action);
  } finally {
    checkingGrant = previous;
  }
}
export function assertNativeScopePurposeOwner(
  scope: NativeWorkScope,
  purpose?: NativeSessionPurpose,
): void {
  const owner = scopeOwners.get(scope);
  if (owner && owner !== purpose) throw new NativeReviewError('review-authority-denied');
}
/** A routed review capability cannot be replayed through another service/runtime. */
export function assertNativePurposeOwner(
  grant: NativeWorkGrant,
  purpose?: NativeSessionPurpose,
): void {
  const owner = grantOwners.get(grant);
  if (owner && owner !== purpose) throw new NativeReviewError('review-authority-denied');
  // Unknown objects are not allowed to erase a known review role by copying
  // only its scope, signal or assertion. These observations grant no authority.
  if (
    !owner &&
    (scopeOwners.has(grant.scope) ||
      reviewSignals.has(grant.signal) ||
      reviewAssertions.has(grant.assertCurrent))
  )
    throw new NativeReviewError('review-authority-denied');
}

/** C Host port, not a D DTO or grant issuer. Production must adapt the real D
 * identity registry; the SDK PoC explicitly supplies a synthetic resolver. */
export interface NativeReviewPorts {
  /** Cleanup only. Host must first validate the original in D's genuine cleanup
   * issuer; an object's own assertCurrent or copied scope is not that validation.
   * No member/drive/read grant or model selection is requested by this port. */
  authorizeCleanup?(original: object): ExecutionReviewScope;
  authorize(
    original: object,
    action: NativeWorkAction,
  ): {
    readonly scope: ExecutionReviewScope;
    readonly selection: NativeSessionSelection;
    readonly signal: AbortSignal;
  };
  readTarget(
    original: object,
    query: { readonly resourceRef: string; readonly offset: number; readonly length: number },
    signal: AbortSignal,
  ): Promise<NativeReviewReadLease>;
  unavailableRequired(original: object): readonly {
    readonly resourceRef: string;
    readonly code: 'review-unsupported-material' | 'review-unavailable';
  }[];
}

/** Ephemeral original-owner routing metadata. Neither parsed scope nor matching
 * JSON can register a purpose: every entry is bound to the resolver's original
 * object and requalified on every action. No authority/content is persisted here. */
export class NativeSessionPurpose {
  private readonly scopes = new WeakMap<NativeWorkScope, NativeReviewContext>();
  private readonly originals = new WeakMap<
    NativeWorkGrant,
    { readonly original: object; readonly selection: NativeSessionSelection }
  >();
  private readonly grants = new WeakMap<object, NativeWorkGrant>();
  private readonly authorize: NativeReviewPorts['authorize'];
  private readonly readTarget: NativeReviewPorts['readTarget'];
  private readonly unavailableRequired: NativeReviewPorts['unavailableRequired'];
  private readonly authorizeCleanup: NativeReviewPorts['authorizeCleanup'];
  constructor(readonly ports: NativeReviewPorts) {
    this.authorize = ports.authorize;
    this.readTarget = ports.readTarget;
    this.unavailableRequired = ports.unavailableRequired;
    this.authorizeCleanup = ports.authorizeCleanup;
  }

  cleanupAuthority(original: unknown): NativeScopeCleanupAuthority {
    if (!original || typeof original !== 'object')
      throw new NativeReviewError('review-authority-denied');
    const owner = cleanupOwners.get(original);
    if (owner && owner !== this) throw new NativeReviewError('review-authority-denied');
    const resolve = () => {
      if (
        typeof this.authorizeCleanup !== 'function' ||
        this.ports.authorizeCleanup !== this.authorizeCleanup
      )
        throw new NativeReviewError('review-authority-denied');
      let value: unknown;
      try {
        value = this.authorizeCleanup.call(this.ports, original);
        if (value && typeof value === 'object' && 'then' in value) {
          void Promise.resolve(value).catch(() => undefined);
          throw new NativeReviewError('review-authority-denied');
        }
        return nativeReviewContextFromScope(executionReviewScopeSchema.parse(value));
      } catch {
        throw new NativeReviewError('review-authority-denied');
      }
    };
    const context = resolve(),
      identity = canonicalPayload(context);
    cleanupOwners.set(original, this);
    const scope = this.bindScope(Object.freeze({ ...context.scope }), context);
    return Object.freeze({
      scope,
      assertCurrent: () => {
        if (canonicalPayload(resolve()) !== identity)
          throw new NativeReviewError('review-target-changed');
        return undefined;
      },
    });
  }

  reviewGrant(original: unknown): NativeWorkGrant {
    if (!original || typeof original !== 'object')
      throw new NativeReviewError('review-authority-denied');
    const current = this.resolve(original, 'open');
    const prior = this.grants.get(original);
    if (prior) {
      prior.assertCurrent('open');
      return prior;
    }
    const context = nativeReviewContextFromScope(current.scope);
    const selection = Object.freeze(nativeSelectionSchema.parse(current.selection));
    const identity = canonicalPayload({ context, selection });
    const scope = this.bindScope(Object.freeze({ ...context.scope }), context);
    const purpose = this,
      signal = AbortSignal.any([current.signal]);
    const grant: NativeWorkGrant = Object.freeze({
      scope,
      signal,
      assertCurrent(this: NativeWorkGrant, action: NativeWorkAction) {
        if (this !== grant || (checkingGrant !== undefined && checkingGrant !== grant))
          throw new NativeReviewError('review-authority-denied');
        const fresh = purpose.resolve(original, action);
        if (
          fresh.signal !== current.signal ||
          canonicalPayload({
            context: nativeReviewContextFromScope(fresh.scope),
            selection: nativeSelectionSchema.parse(fresh.selection),
          }) !== identity
        )
          throw new NativeReviewError('review-target-changed');
      },
    });
    this.grants.set(original, grant);
    this.originals.set(grant, Object.freeze({ original, selection }));
    grantOwners.set(grant, this);
    reviewAssertions.add(grant.assertCurrent);
    reviewSignals.add(signal);
    return grant;
  }
  private resolve(original: object, action: NativeWorkAction) {
    if (
      this.ports.authorize !== this.authorize ||
      this.ports.readTarget !== this.readTarget ||
      this.ports.unavailableRequired !== this.unavailableRequired
    )
      throw new NativeReviewError('review-authority-denied');
    try {
      const value = this.authorize.call(this.ports, original, action);
      if (!(value?.signal instanceof AbortSignal))
        throw new NativeReviewError('review-authority-denied');
      if (value.signal.aborted) throw new NativeReviewError('cancelled');
      const context = nativeReviewContextFromScope(value.scope);
      return {
        scope: { ...context.scope, review: context.review },
        selection: nativeSelectionSchema.parse(value.selection),
        signal: value.signal,
      };
    } catch (error) {
      if (error instanceof NativeReviewError) throw error;
      throw new NativeReviewError('review-authority-denied');
    }
  }
  /** Identity observation only; no source, action or metadata is authorized. */
  owns(grant: NativeWorkGrant): boolean {
    return this.originals.has(grant);
  }
  access(grant: NativeWorkGrant) {
    const access = this.originals.get(grant);
    if (!access) throw new NativeReviewError('review-authority-denied');
    // One real fresh action checks the same original scope, selection, signal
    // and port identities. The returned fields are only its frozen metadata;
    // this does not cache that authorization for another operation or await.
    invokeNativeWorkGrantAssertion(grant, 'open');
    if (grant.signal.aborted) throw new NativeReviewError('cancelled');
    return access;
  }
  original(grant: NativeWorkGrant): object {
    return this.access(grant).original;
  }
  selection(grant: NativeWorkGrant): NativeSessionSelection {
    return this.access(grant).selection;
  }
  context(scope: NativeWorkScope): NativeReviewContext | undefined {
    assertNativeScopePurposeOwner(scope, this);
    const context = this.scopes.get(scope);
    if (context && canonicalPayload(scope) !== canonicalPayload(context.scope))
      throw new NativeReviewError('review-target-changed');
    return context;
  }
  bindScope(scope: NativeWorkScope, context: NativeReviewContext): NativeWorkScope {
    assertNativeScopePurposeOwner(scope, this);
    if (canonicalPayload(scope) !== canonicalPayload(context.scope))
      throw new NativeReviewError('review-target-changed');
    this.scopes.set(scope, structuredClone(context));
    scopeOwners.set(scope, this);
    return scope;
  }
  cloneScope(scope: NativeWorkScope): NativeWorkScope {
    const context = this.context(scope),
      clone = structuredClone(scope);
    return context ? this.bindScope(Object.freeze(clone), context) : clone;
  }
  key(scope: NativeWorkScope): string {
    const context = this.context(scope);
    return context ? nativeReviewSessionKey(context) : nativeWorkSessionKey(scope);
  }
  address(scope: NativeWorkScope): string {
    const context = this.context(scope);
    return context ? nativeReviewScopeKey(context) : nativeScopeKey(scope);
  }
}
