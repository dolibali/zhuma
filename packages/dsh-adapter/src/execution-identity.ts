import type { IncomingHttpHeaders } from 'node:http';

/** Fields that would let a request choose its actor. `directoryMemberId` is not one of them. */
const ACTOR_FIELDS = new Set(['actorId', 'memberId', 'reviewerId']);

/**
 * Same shape as B-ID0a's `MemberRequest`. This branch does not import that
 * module. A passes the headers from the call that hit `/zhuma-exec`.
 */
export interface MemberRequest {
  readonly headers: IncomingHttpHeaders;
}

/**
 * Same shape as B-ID0a's `MemberResolution`. Success is only `ok: true`.
 * `untrusted-request` is a 403 with no member.
 */
export type MemberResolution =
  | { readonly ok: true; readonly memberId: string; readonly spaceIds: readonly string[] }
  | { readonly ok: false; readonly status: 401; readonly code: 'unauthenticated' }
  | { readonly ok: false; readonly status: 403; readonly code: 'untrusted-request' };

/**
 * Same shape as B-ID0a's `MemberResolver`. A wires `memberResolver(ctx)`
 * into the execution plugin. `resolveMember` stays on that branch.
 */
export interface MemberResolver {
  resolve(request: MemberRequest): Promise<MemberResolution>;
}

export type ActorResolution =
  | { readonly ok: true; readonly actorId: string; readonly spaceIds: readonly string[] }
  | {
      readonly ok: false;
      readonly code: 'unauthenticated' | 'untrusted-request' | 'not-in-directory';
    };

/** Nested actor-field walks stop here and the caller returns `validation`. */
export const ACTOR_FIELD_DEPTH_LIMIT = 32;

export type ActorFieldScan = 'clean' | 'present' | 'too-deep';

export function scanActorField(value: unknown): ActorFieldScan {
  const seen = new Set<unknown>();
  const visit = (current: unknown, depth: number): ActorFieldScan => {
    if (depth > ACTOR_FIELD_DEPTH_LIMIT) return 'too-deep';
    if (current === null || typeof current !== 'object') return 'clean';
    if (seen.has(current)) return 'clean';
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) {
        const found = visit(item, depth + 1);
        if (found !== 'clean') return found;
      }
      return 'clean';
    }
    for (const [key, child] of Object.entries(current)) {
      if (ACTOR_FIELDS.has(key)) return 'present';
      const found = visit(child, depth + 1);
      if (found !== 'clean') return found;
    }
    return 'clean';
  };
  return visit(value, 0);
}

export function containsActorField(value: unknown): boolean {
  return scanActorField(value) === 'present';
}

function directoryHas(directoryMemberIds: readonly string[], memberId: string): boolean {
  return directoryMemberIds.includes(memberId);
}

/**
 * Multi-member actor. The only source is a successful resolver result.
 * An owner principal is never mapped to a bound member here.
 * `untrusted-request` stays that code and carries no member.
 */
export function resolveActor(
  resolution: MemberResolution | undefined,
  directoryMemberIds: readonly string[],
): ActorResolution {
  if (resolution == null || typeof resolution !== 'object' || resolution.ok !== true) {
    if (
      resolution != null &&
      typeof resolution === 'object' &&
      'ok' in resolution &&
      resolution.ok === false &&
      resolution.code === 'untrusted-request'
    ) {
      return { ok: false, code: 'untrusted-request' };
    }
    return { ok: false, code: 'unauthenticated' };
  }
  const memberId = resolution.memberId.trim();
  if (memberId === '' || resolution.spaceIds.some((spaceId) => typeof spaceId !== 'string')) {
    return { ok: false, code: 'unauthenticated' };
  }
  if (!directoryHas(directoryMemberIds, memberId)) return { ok: false, code: 'not-in-directory' };
  return { ok: true, actorId: memberId, spaceIds: resolution.spaceIds };
}
