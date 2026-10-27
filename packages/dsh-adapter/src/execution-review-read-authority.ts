import { canonicalPayload } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import {
  executionReviewScopeSchema,
  type ExecutionReviewScope,
} from './execution-review-contract.js';

declare const reviewReadBrand: unique symbol;
/** Read-only Host capability; never a native drive, author, or workflow grant. */
export interface ExecutionReviewReadGrant {
  readonly [reviewReadBrand]: true;
  readonly purpose: 'review-target';
  readonly scope: ExecutionReviewScope;
  readonly signal: AbortSignal;
  assertCurrent(action: 'read-target'): void;
}
export interface OpenedExecutionReviewRead {
  readonly grant: ExecutionReviewReadGrant;
  dispose(): void;
}
export interface ExecutionReviewReadLocator {
  readonly spaceId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly runId: string;
}
export class ExecutionReviewReadError extends Error {
  constructor(
    readonly code: 'review-authority-denied' | 'review-target-changed' | 'review-capacity',
  ) {
    super('固定评审内容的读取权限不可用。');
    this.name = 'ExecutionReviewReadError';
  }
}
/** The existing Service supplies these original member/node/change facts.
 * This owns only process-local read capabilities, never business state or identity. */
export interface ExecutionReviewReadAuthoritySource {
  readonly signal: AbortSignal;
  memberLease(original: MemberRequest): Promise<ExecutionMemberLease>;
  resolve(locator: ExecutionReviewReadLocator): {
    readonly scope: ExecutionReviewScope;
    readonly version: number;
  };
  assertCurrent(scope: ExecutionReviewScope, version: number): void;
  onChange(recheck: () => void): () => void;
}
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
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export class ExecutionReviewReadAuthorities {
  private readonly grants = new WeakMap<
    ExecutionReviewReadGrant,
    { check(): void; dispose(): void }
  >();
  private readonly live = new Set<() => void>();
  private pending = 0;
  private poisoned = false;
  constructor(private readonly source: ExecutionReviewReadAuthoritySource) {}

  private poison(): void {
    if (this.poisoned) return;
    this.poisoned = true;
    for (const close of [...this.live]) close();
  }

  async open(
    original: MemberRequest,
    locator: ExecutionReviewReadLocator,
  ): Promise<OpenedExecutionReviewRead> {
    if (this.poisoned || this.source.signal.aborted) return denied();
    if (this.live.size + this.pending >= 256) throw new ExecutionReviewReadError('review-capacity');
    this.pending++;
    let lease: ExecutionMemberLease | undefined;
    let dispose: (() => void) | undefined;
    try {
      lease = await this.source.memberLease(original);
      if (
        !lease ||
        this.poisoned ||
        this.source.signal.aborted ||
        lease.signal.aborted ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= Date.now()
      )
        return denied();
      synchronous(lease.assertCurrent(locator.spaceId));
      const resolved = this.source.resolve(locator);
      const scope = freeze(executionReviewScopeSchema.parse(resolved.scope));
      if (
        scope.actorId !== lease.memberId ||
        Object.entries(locator).some(([key, value]) => Reflect.get(scope, key) !== value)
      )
        return denied();
      const expected = canonicalPayload(scope),
        controller = new AbortController();
      const member = lease;
      let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
      let released = false;
      const check = () => {
        if (
          released ||
          this.poisoned ||
          controller.signal.aborted ||
          this.source.signal.aborted ||
          member.signal.aborted ||
          member.expiresAt <= Date.now()
        )
          return denied();
        synchronous(member.assertCurrent(scope.spaceId));
        if (canonicalPayload(scope) !== expected) return denied();
        synchronous(this.source.assertCurrent(scope, resolved.version));
      };
      const issuer = this;
      const grant = Object.freeze({
        purpose: 'review-target' as const,
        scope,
        signal: controller.signal,
        assertCurrent(this: ExecutionReviewReadGrant, action: 'read-target') {
          if (action !== 'read-target' || !issuer.grants.has(this)) return denied();
          issuer.assertGrant(this);
        },
      }) as ExecutionReviewReadGrant;
      dispose = () => {
        if (released) return;
        released = true;
        controller.abort();
        if (timer) clearTimeout(timer);
        this.source.signal.removeEventListener('abort', dispose!);
        member.signal.removeEventListener('abort', dispose!);
        this.grants.delete(grant);
        this.live.delete(dispose!);
        try {
          stop?.();
        } catch {
          this.poison();
        }
        try {
          synchronous(member.release());
        } catch {
          this.poison();
        }
      };
      const close = dispose;
      this.grants.set(grant, { check, dispose: close });
      this.live.add(close);
      this.source.signal.addEventListener('abort', close, { once: true });
      member.signal.addEventListener('abort', close, { once: true });
      const recheck = () => {
        try {
          check();
        } catch {
          close();
        }
      };
      stop = this.source.onChange(recheck);
      if (released) {
        stop();
        return denied();
      }
      const expire = () => {
        if (member.expiresAt <= Date.now()) close();
        else {
          timer = setTimeout(expire, Math.min(member.expiresAt - Date.now(), 2_147_483_647));
          timer.unref();
        }
      };
      check();
      expire();
      check();
      return { grant, dispose: close };
    } catch (error) {
      if (dispose) dispose();
      else {
        try {
          synchronous(lease?.release());
        } catch {
          this.poison();
        }
      }
      if (error instanceof ExecutionReviewReadError) throw error;
      return denied();
    } finally {
      this.pending--;
    }
  }

  assertGrant(grant: ExecutionReviewReadGrant): void {
    const owned = this.grants.get(grant);
    if (!owned) return denied();
    try {
      owned.check();
    } catch (error) {
      owned.dispose();
      throw error instanceof ExecutionReviewReadError
        ? error
        : new ExecutionReviewReadError('review-authority-denied');
    }
  }
}
