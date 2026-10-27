import { canonicalPayload } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import {
  executionReviewScopeSchema,
  type ExecutionReviewScope,
} from './execution-review-contract.js';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import type { NativeSessionSelection, NativeWorkAction } from './native-work-session-contract.js';
import { nativeSelectionSchema } from './native-work-session-record.js';
import {
  ExecutionReviewReadAuthorities,
  ExecutionReviewReadError,
  type ExecutionReviewReadLocator,
  type ExecutionReviewReadGrant,
} from './execution-review-read-authority.js';

declare const driveBrand: unique symbol;
declare const cleanupBrand: unique symbol;
export interface ExecutionReviewDriveGrant {
  readonly [driveBrand]: true;
  readonly purpose: 'independent-review-drive';
  readonly scope: ExecutionReviewScope;
  readonly selection: NativeSessionSelection;
  readonly signal: AbortSignal;
  assertCurrent(action: NativeWorkAction): void;
}
export interface ExecutionReviewCleanupAuthority {
  readonly [cleanupBrand]: true;
  readonly scope: ExecutionReviewScope;
  /** Original review retirement only. Never failed/stopped events, a vote or drain proof. */
  assertCurrent(kind: 'cleanup'): void;
}
export interface OpenedExecutionReviewDrive {
  readonly grant: ExecutionReviewDriveGrant;
  readonly cleanup: ExecutionReviewCleanupAuthority;
  dispose(): void;
}
export interface ExecutionReviewDriveAuthoritySource {
  readonly signal: AbortSignal;
  memberLease(original: MemberRequest): Promise<ExecutionMemberLease>;
  /** Current admitted original scope and real model/resource-qualified selection. */
  resolve(locator: ExecutionReviewReadLocator): {
    readonly scope: ExecutionReviewScope;
    readonly selection: NativeSessionSelection;
  };
  assertCurrent(
    scope: ExecutionReviewScope,
    selection: NativeSessionSelection,
    action: NativeWorkAction,
  ): undefined;
  /** Checks the exact original persisted scope/configuration, retaining no driving rights. */
  assertCleanup(scope: ExecutionReviewScope, selection: NativeSessionSelection): undefined;
  /** Host-internal cold reconstruction, only after an original durable terminal
   * or stop request. It issues retirement authority, never a drain certificate. */
  assertCleanupAfterCommit(
    scope: ExecutionReviewScope,
    selection: NativeSessionSelection,
  ): undefined;
  onChange(recheck: () => void): () => void;
}
const actions = new Set<NativeWorkAction>(['open', 'send', 'queue', 'stop', 'history', 'follow']);
function denied(): never {
  throw new ExecutionReviewReadError('review-authority-denied');
}
function synchronous(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => undefined);
    denied();
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Separate issuer identity. Reuse the original bounded member-lease retainer,
 * including expiry/abort/poison cleanup, without exposing its internal read grant.
 * There is deliberately no constructor or promotion operation accepting a read grant. */
export class ExecutionReviewDriveAuthorities {
  private readonly retainer: ExecutionReviewReadAuthorities;
  private readonly selections = new WeakMap<ExecutionReviewScope, NativeSessionSelection>();
  private readonly grants = new WeakMap<
    ExecutionReviewDriveGrant,
    {
      readonly read: ExecutionReviewReadGrant;
      readonly dispose: () => void;
    }
  >();
  private readonly cleanups = new WeakMap<
    ExecutionReviewCleanupAuthority,
    NativeSessionSelection
  >();
  private readonly resolve: ExecutionReviewDriveAuthoritySource['resolve'];
  private readonly current: ExecutionReviewDriveAuthoritySource['assertCurrent'];
  private readonly cleanup: ExecutionReviewDriveAuthoritySource['assertCleanup'];
  private readonly cleanupIssue: ExecutionReviewDriveAuthoritySource['assertCleanupAfterCommit'];
  constructor(source: ExecutionReviewDriveAuthoritySource) {
    this.resolve = source.resolve.bind(source);
    this.current = source.assertCurrent.bind(source);
    this.cleanup = source.assertCleanup.bind(source);
    this.cleanupIssue = source.assertCleanupAfterCommit.bind(source);
    const signal = source.signal;
    this.retainer = new ExecutionReviewReadAuthorities(
      Object.freeze({
        signal,
        memberLease: source.memberLease.bind(source),
        onChange: source.onChange.bind(source),
        resolve: (locator: ExecutionReviewReadLocator) => {
          const facts = this.resolve(locator);
          // Binding revision, not mutable Node/attempt event version. Every use
          // below compares the complete scope and fixed selection instead.
          return { scope: facts.scope, version: 1 };
        },
        assertCurrent: (scope: ExecutionReviewScope) => {
          const fresh = this.resolve(scope);
          if (canonicalPayload(fresh.scope) !== canonicalPayload(scope)) return denied();
          const selected = nativeSelectionSchema.parse(fresh.selection);
          let expected = this.selections.get(scope);
          if (!expected) {
            expected = Object.freeze(selected);
            this.selections.set(scope, expected);
          }
          if (canonicalPayload(expected) !== canonicalPayload(selected)) return denied();
          synchronous(this.current(scope, expected, 'history'));
        },
      }),
    );
  }

  async open(
    original: MemberRequest,
    locator: ExecutionReviewReadLocator,
  ): Promise<OpenedExecutionReviewDrive> {
    // Always acquire a new genuine member lease from the original request.
    const retained = await this.retainer.open(original, locator);
    try {
      const { scope, signal } = retained.grant;
      const selection = this.selections.get(scope);
      if (!selection) return denied();
      synchronous(this.current(scope, selection, 'open'));
      const issuer = this;
      const grant = Object.freeze({
        purpose: 'independent-review-drive' as const,
        scope,
        selection,
        signal,
        assertCurrent(this: ExecutionReviewDriveGrant, action: NativeWorkAction) {
          issuer.assertGrant(this, action);
        },
      }) as ExecutionReviewDriveGrant;
      const cleanup = this.mintCleanup(scope, selection);
      this.grants.set(grant, { read: retained.grant, dispose: retained.dispose });
      this.assertGrant(grant, 'open');
      return { grant, cleanup, dispose: retained.dispose };
    } catch (error) {
      retained.dispose();
      if (error instanceof ExecutionReviewReadError) throw error;
      return denied();
    }
  }
  owns(grant: ExecutionReviewDriveGrant): boolean {
    return this.grants.has(grant);
  }
  /** Internal recovery from this original owner's persisted facts, not a Client
   * API. A must first reauthorize external actions and the complete workflow IDs. */
  cleanupAfterCommit(rawScope: ExecutionReviewScope): ExecutionReviewCleanupAuthority {
    try {
      const scope = freeze(executionReviewScopeSchema.parse(rawScope));
      const facts = this.resolve(scope);
      if (canonicalPayload(facts.scope) !== canonicalPayload(scope)) return denied();
      const selection = Object.freeze(nativeSelectionSchema.parse(facts.selection));
      synchronous(this.cleanupIssue(scope, selection));
      synchronous(this.cleanup(scope, selection));
      return this.mintCleanup(scope, selection);
    } catch (error) {
      if (error instanceof ExecutionReviewReadError) throw error;
      return denied();
    }
  }
  private mintCleanup(
    scope: ExecutionReviewScope,
    selection: NativeSessionSelection,
  ): ExecutionReviewCleanupAuthority {
    const issuer = this;
    const authority = Object.freeze({
      scope,
      assertCurrent(this: ExecutionReviewCleanupAuthority, kind: 'cleanup') {
        if (kind !== 'cleanup') return denied();
        issuer.assertCleanup(this);
      },
    }) as ExecutionReviewCleanupAuthority;
    this.cleanups.set(authority, selection);
    return authority;
  }
  assertGrant(grant: ExecutionReviewDriveGrant, action: NativeWorkAction): void {
    const owned = this.grants.get(grant);
    if (!owned || !actions.has(action)) return denied();
    // Issuer lookup precedes purported scope/selection/check fields.
    this.retainer.assertGrant(owned.read);
    try {
      synchronous(this.current(grant.scope, grant.selection, action));
    } catch (error) {
      // An unsupported action need not revoke read/finalization rights. A stale
      // target/member/configuration still closes through the retained history check.
      try {
        this.retainer.assertGrant(owned.read);
      } catch {
        owned.dispose();
      }
      if (error instanceof ExecutionReviewReadError) throw error;
      return denied();
    }
  }
  assertCleanup(authority: ExecutionReviewCleanupAuthority): void {
    const selection = this.cleanups.get(authority);
    if (!selection) return denied();
    try {
      synchronous(this.cleanup(authority.scope, selection));
    } catch (error) {
      if (error instanceof ExecutionReviewReadError) throw error;
      return denied();
    }
  }
}
