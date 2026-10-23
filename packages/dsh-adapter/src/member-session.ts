/**
 * Shared member-session resolution for `/zhuma-id` and later product entries.
 *
 * A DSH owner cookie is not a product member. The only exception is an import
 * that configures exactly one account as `ownerAccountId` (isolated local
 * single-user mode). Multi-member mode returns 401 when the member cookie is
 * missing, deleted, expired, revoked, or forged.
 *
 * The cookie Path is `/` so `/zhuma-exec` receives it. HttpOnly and
 * SameSite=Strict stay. Secure waits for a TLS listener.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const MEMBER_COOKIE_NAME = 'zhuma-member';
export const MEMBER_COOKIE_PATH = '/';

export interface MemberRequest {
  readonly headers: IncomingHttpHeaders;
}

export interface ResolvedMember {
  readonly memberId: string;
  readonly spaceIds: readonly string[];
}

export type MemberRejection =
  | { readonly ok: false; readonly status: 401; readonly code: 'unauthenticated' }
  | { readonly ok: false; readonly status: 403; readonly code: 'untrusted-request' };

export type MemberResolution = ({ readonly ok: true } & ResolvedMember) | MemberRejection;

/**
 * Injected into the execution plugin. `resolve` uses the same rules as
 * `/zhuma-id`: Host/Origin first, then a valid member cookie, and never an
 * automatic owner-to-member mapping.
 */
export interface MemberResolver {
  resolve(request: MemberRequest): Promise<MemberResolution>;
}

export interface MemberResolverSource {
  readonly secret: Buffer;
  requestRejection(headers: IncomingHttpHeaders): number | undefined;
  findSession(
    sessionId: string,
  ): { readonly accountId: string; readonly expiresAt: number } | undefined;
  spaceIdsFor(accountId: string): readonly string[];
  /** Set only when this host imported exactly one account and named it. */
  singleUserAccountId(): string | undefined;
  admitOwner(headers: IncomingHttpHeaders): boolean;
}

interface InstalledResolver {
  readonly source: MemberResolverSource;
}

const installed = new WeakMap<object, InstalledResolver>();

export type IdentityAccessMode = 'unmounted' | 'single-user' | 'multi-member';

/**
 * Cordis gives each plugin a child context. The host root is the object both
 * the identity plugin and a later execution plugin can see.
 */
function resolverHost(ctx: object): object {
  const root = (ctx as { root?: unknown }).root;
  return typeof root === 'object' && root !== null ? root : ctx;
}

export function installMemberResolver(ctx: object, source: MemberResolverSource): void {
  installed.set(resolverHost(ctx), { source });
}

export function uninstallMemberResolver(ctx: object): void {
  installed.delete(resolverHost(ctx));
}

/** `unmounted` leaves an isolated local host on its existing owner routes. */
export function identityAccessMode(ctx: object): IdentityAccessMode {
  const current = installed.get(resolverHost(ctx));
  if (current === undefined) return 'unmounted';
  return current.source.singleUserAccountId() !== undefined ? 'single-user' : 'multi-member';
}

export function memberResolver(ctx: object): MemberResolver {
  return { resolve: (request) => resolveMember(ctx, request) };
}

/** Resolve the product member for this host context. Unmounted contexts fail closed. */
export async function resolveMember(
  ctx: object,
  request: MemberRequest,
): Promise<MemberResolution> {
  const current = installed.get(resolverHost(ctx));
  if (current === undefined) return { ok: false, status: 401, code: 'unauthenticated' };
  return decideMember(current.source, request.headers);
}

export function memberCookieHeader(value: string, maxAge: number): string {
  return `${MEMBER_COOKIE_NAME}=${value}; Max-Age=${maxAge}; Path=${MEMBER_COOKIE_PATH}; HttpOnly; SameSite=Strict`;
}

export function memberCredential(secret: Buffer, sessionId: string, expiresAt: number): string {
  const signed = `${sessionId}.${expiresAt}`;
  return `${signed}.${sign(secret, signed)}`;
}

export function memberCookiePresent(cookieHeader: string | undefined): boolean {
  if (cookieHeader === undefined) return false;
  return cookieHeader.split(';').some((part) => part.trim().startsWith(`${MEMBER_COOKIE_NAME}=`));
}

/** Session id from a structurally valid member cookie, used to revoke the row. */
export function memberSessionId(cookieHeader: string | undefined): string | undefined {
  return readMemberCookie(cookieHeader)?.sessionId;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function sign(secret: Buffer, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function readMemberCookie(
  cookieHeader: string | undefined,
):
  | { readonly sessionId: string; readonly expiresAt: number; readonly signature: string }
  | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${MEMBER_COOKIE_NAME}=`)) continue;
    const pieces = trimmed.slice(MEMBER_COOKIE_NAME.length + 1).split('.');
    if (pieces.length !== 3) return undefined;
    const [sessionId, expires, signature] = pieces;
    if (sessionId === undefined || expires === undefined || signature === undefined)
      return undefined;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined;
    if (!/^[0-9]+$/.test(expires)) return undefined;
    const expiresAt = Number(expires);
    if (!Number.isSafeInteger(expiresAt)) return undefined;
    return { sessionId, expiresAt, signature };
  }
  return undefined;
}

function signatureMatches(
  secret: Buffer,
  sessionId: string,
  expiresAt: number,
  signature: string,
): boolean {
  const expected = sign(secret, `${sessionId}.${expiresAt}`);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function decideMember(
  source: MemberResolverSource,
  headers: IncomingHttpHeaders,
): MemberResolution {
  if (source.requestRejection(headers) === 403) {
    return { ok: false, status: 403, code: 'untrusted-request' };
  }
  const cookieHeader = headerValue(headers, 'cookie');
  if (memberCookiePresent(cookieHeader)) {
    const cookie = readMemberCookie(cookieHeader);
    if (
      cookie === undefined ||
      cookie.expiresAt <= Date.now() ||
      !signatureMatches(source.secret, cookie.sessionId, cookie.expiresAt, cookie.signature)
    ) {
      return { ok: false, status: 401, code: 'unauthenticated' };
    }
    const session = source.findSession(cookie.sessionId);
    if (session === undefined || session.expiresAt !== cookie.expiresAt) {
      return { ok: false, status: 401, code: 'unauthenticated' };
    }
    return {
      ok: true,
      memberId: session.accountId,
      spaceIds: source.spaceIdsFor(session.accountId),
    };
  }
  const singleUser = source.singleUserAccountId();
  if (singleUser !== undefined && source.admitOwner(headers)) {
    return { ok: true, memberId: singleUser, spaceIds: source.spaceIdsFor(singleUser) };
  }
  return { ok: false, status: 401, code: 'unauthenticated' };
}
