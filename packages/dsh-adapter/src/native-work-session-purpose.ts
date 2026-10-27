import { canonicalPayload } from '@zhuma/agent-core';
import type { ExecutionReviewScope } from './execution-review-contract.js';
import type {
  NativeSessionSelection,
  NativeWorkAction,
  NativeWorkGrant,
  NativeWorkScope,
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
/** A routed review capability cannot be replayed through another service/runtime. */
export function assertNativePurposeOwner(
  grant: NativeWorkGrant,
  purpose?: NativeSessionPurpose,
): void {
  const owner = grantOwners.get(grant);
  if (owner && owner !== purpose) throw new NativeReviewError('review-authority-denied');
}

/** C Host port, not a D DTO or grant issuer. Production must adapt the real D
 * identity registry; the SDK PoC explicitly supplies a synthetic resolver. */
export interface NativeReviewPorts {
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
  private readonly originals = new WeakMap<NativeWorkGrant, object>();
  private readonly grants = new WeakMap<object, NativeWorkGrant>();
  private readonly authorize: NativeReviewPorts['authorize'];
  private readonly readTarget: NativeReviewPorts['readTarget'];
  private readonly unavailableRequired: NativeReviewPorts['unavailableRequired'];
  constructor(readonly ports: NativeReviewPorts) {
    this.authorize = ports.authorize;
    this.readTarget = ports.readTarget;
    this.unavailableRequired = ports.unavailableRequired;
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
    const selection = nativeSelectionSchema.parse(current.selection);
    const identity = canonicalPayload({ context, selection });
    const scope = this.bindScope(Object.freeze({ ...context.scope }), context);
    const grant: NativeWorkGrant = Object.freeze({
      scope,
      signal: current.signal,
      assertCurrent: (action: NativeWorkAction) => {
        const fresh = this.resolve(original, action);
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
    this.originals.set(grant, original);
    grantOwners.set(grant, this);
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
  original(grant: NativeWorkGrant): object {
    const original = this.originals.get(grant);
    if (!original) throw new NativeReviewError('review-authority-denied');
    grant.assertCurrent('open');
    return original;
  }
  selection(grant: NativeWorkGrant): NativeSessionSelection {
    return nativeSelectionSchema.parse(this.resolve(this.original(grant), 'open').selection);
  }
  context(scope: NativeWorkScope): NativeReviewContext | undefined {
    const context = this.scopes.get(scope);
    if (context && canonicalPayload(scope) !== canonicalPayload(context.scope))
      throw new NativeReviewError('review-target-changed');
    return context;
  }
  bindScope(scope: NativeWorkScope, context: NativeReviewContext): NativeWorkScope {
    if (canonicalPayload(scope) !== canonicalPayload(context.scope))
      throw new NativeReviewError('review-target-changed');
    this.scopes.set(scope, structuredClone(context));
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
