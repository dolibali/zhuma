/**
 * Shared member-session resolution for `/zhuma-id` and later product entries.
 *
 * A DSH owner cookie is not a product member. The host picks
 * `legacy-single-user` or `multi-member` with `configureDeploymentMode`
 * before `applyIdentity`. Only `legacy-single-user` maps an owner cookie, and
 * only when the import names exactly one account. Multi-member mode returns
 * 401 when the member cookie is missing, deleted, expired, revoked, or forged.
 * Snapshot, command, plan, preview-import, and resource-files stay closed
 * for every other mode. `import-package` is a command on that same command
 * route, so it stays closed with them.
 *
 * The cookie Path is `/` so `/api/zhuma-exec/*` receives it. HttpOnly and
 * SameSite=Strict stay. Secure waits for a TLS listener.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import { spaceDirectoryFor, type SpaceDirectory } from './space-directory.js';

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

/** Host-only publication backed by the current real directory, never a DTO. */
export interface ExecutionMemberDirectoryBinding {
  readonly directory: SpaceDirectory & { readonly signal: AbortSignal };
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface IdentityExecutionOptions {
  currentDirectoryBinding(): ExecutionMemberDirectoryBinding | undefined;
}

interface ExecutionMemberSource extends IdentityExecutionOptions {
  accountExists(memberId: string): boolean;
  /** Observe the same authoritative facts after their durable changes. */
  onChange(recheck: () => void): () => void;
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
  readonly execution?: ExecutionMemberSource;
}

interface InstalledResolver {
  readonly source: MemberResolverSource;
  readonly lifetime: AbortController;
  leases: number;
}

const installed = new WeakMap<object, InstalledResolver>();

/** Explicit host setup. This is not inferred from whether a resolver is installed. */
export type DeploymentMode = 'legacy-single-user' | 'multi-member';

const deploymentModes = new WeakMap<object, DeploymentMode>();

export type IdentityAccessMode = 'unmounted' | 'single-user' | 'multi-member';

export type LegacyOwnerRouteDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 401 | 404;
      readonly code: 'deployment-mode-unset' | 'not-found';
    };

/**
 * Exact `/api/zhuma/*` routes that still belong to the DSH owner carrier.
 * `preview-import` and `resource-files` are the asset-import reads.
 * `import-package` is not its own route; it is a `command` payload and is
 * listed separately so a host cannot leave that write on the owner path.
 */
export const LEGACY_OWNER_ROUTES = [
  'snapshot',
  'command',
  'plan',
  'preview-import',
  'resource-files',
] as const;

export const LEGACY_OWNER_PACKAGE_COMMANDS = ['import-package'] as const;

export type LegacyOwnerRoute = (typeof LEGACY_OWNER_ROUTES)[number];
export type LegacyOwnerPackageCommand = (typeof LEGACY_OWNER_PACKAGE_COMMANDS)[number];

/**
 * Cordis gives each plugin a child context. The host root is the object both
 * the identity plugin and a later execution plugin can see.
 */
function resolverHost(ctx: object): object {
  const root = (ctx as { root?: unknown }).root;
  return typeof root === 'object' && root !== null ? root : ctx;
}

export function installMemberResolver(ctx: object, source: MemberResolverSource): () => void {
  const host = resolverHost(ctx);
  const previous = installed.get(host);
  const current: InstalledResolver = { source, lifetime: new AbortController(), leases: 0 };
  installed.set(host, current);
  previous?.lifetime.abort();
  // Installation identity also distinguishes a remount of the same source object.
  return () => {
    if (installed.get(host) === current) installed.delete(host);
    current.lifetime.abort();
  };
}

export function uninstallMemberResolver(ctx: object): void {
  const host = resolverHost(ctx);
  const current = installed.get(host);
  installed.delete(host);
  current?.lifetime.abort();
}

const EXECUTION_MEMBER_LEASE_LIMIT = 256;

interface MemberLeaseState {
  readonly host: object;
  readonly owner: InstalledResolver;
  readonly execution: ExecutionMemberSource;
  readonly headers: IncomingHttpHeaders;
  readonly binding: ExecutionMemberDirectoryBinding;
  readonly spaces: Set<string>;
}

/** Constant failure text: never project the request, cookie, or source errors. */
function leaseDenied(): Error {
  return new Error('execution member lease unavailable');
}

class CurrentMemberLease implements ExecutionMemberLease {
  readonly memberId: string;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  #state: MemberLeaseState | undefined;
  #lifetime: AbortSignal | undefined;
  #disposeChange: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #invalidate = () => this.release();
  readonly #recheck = () => {
    try {
      this.#check();
    } catch {
      this.release();
    }
  };

  constructor(state: MemberLeaseState, memberId: string, expiresAt: number) {
    this.#state = state;
    this.memberId = memberId;
    this.expiresAt = expiresAt;
    this.signal = this.#controller.signal;
    state.owner.leases++;
    Object.freeze(this);
  }

  start(): this {
    try {
      const state = this.#check();
      const directory = spaceDirectoryFor(state.host);
      if (!directory) throw leaseDenied();
      // Native composition avoids strong per-lease listeners on shared signals.
      this.#lifetime = AbortSignal.any([
        state.owner.lifetime.signal,
        state.binding.signal,
        directory.signal,
      ]);
      this.#lifetime.addEventListener('abort', this.#invalidate, { once: true });
      const dispose = state.execution.onChange(this.#recheck);
      // A source may invalidate synchronously while registering the observer.
      if (this.#state === undefined) dispose();
      else this.#disposeChange = dispose;
      this.#check();
      this.#scheduleExpiry();
      this.#check();
      return this;
    } catch {
      this.release();
      throw leaseDenied();
    }
  }

  assertCurrent(spaceId: string): void {
    try {
      const state = this.#check();
      this.#checkSpace(state, spaceId);
      state.spaces.add(spaceId);
    } catch {
      this.release();
      throw leaseDenied();
    }
  }

  #checkSpace(state: MemberLeaseState, spaceId: string): void {
    const directory = state.binding.directory;
    if (!directory.space(spaceId) || !directory.isMember(spaceId, this.memberId)) {
      throw leaseDenied();
    }
  }

  #check(): MemberLeaseState {
    const state = this.#state;
    if (state === undefined || Date.now() >= this.expiresAt) throw leaseDenied();
    const { owner, binding, execution } = state;
    const directory = spaceDirectoryFor(state.host);
    const current = execution.currentDirectoryBinding();
    if (
      installed.get(state.host) !== owner ||
      owner.lifetime.signal.aborted ||
      owner.source.execution !== execution ||
      directory !== binding.directory ||
      directory.signal.aborted ||
      binding.signal.aborted ||
      !binding.isCurrent() ||
      current?.directory !== binding.directory ||
      current.signal !== binding.signal ||
      !current.isCurrent()
    ) {
      throw leaseDenied();
    }
    const member = decideMember(owner.source, state.headers);
    if (
      !member.ok ||
      member.memberId !== this.memberId ||
      !execution.accountExists(this.memberId)
    ) {
      throw leaseDenied();
    }
    for (const space of state.spaces) this.#checkSpace(state, space);
    return state;
  }

  #scheduleExpiry(): void {
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) {
      this.release();
      return;
    }
    this.#timer = setTimeout(
      () => {
        // Long deadlines and backward clock changes still use one expiry task.
        if (Date.now() < this.expiresAt) this.#scheduleExpiry();
        else this.release();
      },
      Math.min(remaining, 2_147_483_647),
    );
    this.#timer.unref();
  }

  release(): void {
    const state = this.#state;
    if (state === undefined) return;
    // Drop request/source/directory references before invoking external callbacks.
    this.#state = undefined;
    state.owner.leases--;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#lifetime?.removeEventListener('abort', this.#invalidate);
    this.#lifetime = undefined;
    const dispose = this.#disposeChange;
    this.#disposeChange = undefined;
    try {
      dispose?.();
    } catch {
      // A failing producer cleanup must not expose source errors or revive the lease.
    }
    this.#controller.abort();
  }
}

/** Issue from the original member cookie and installed source; never owner fallback. */
export async function openExecutionMemberLease(
  ctx: object,
  request: MemberRequest,
): Promise<ExecutionMemberLease> {
  try {
    const host = resolverHost(ctx);
    const owner = installed.get(host);
    const execution = owner?.source.execution;
    if (!owner || !execution || owner.leases >= EXECUTION_MEMBER_LEASE_LIMIT) {
      throw leaseDenied();
    }
    const headers: IncomingHttpHeaders = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ]),
    );
    const cookie = readMemberCookie(headerValue(headers, 'cookie'));
    if (cookie === undefined) throw leaseDenied();
    const member = decideMember(owner.source, headers);
    const binding = execution.currentDirectoryBinding();
    if (!member.ok || binding === undefined) throw leaseDenied();
    return new CurrentMemberLease(
      { host, owner, execution, headers, binding, spaces: new Set() },
      member.memberId,
      cookie.expiresAt,
    ).start();
  } catch {
    throw leaseDenied();
  }
}

export function configureDeploymentMode(ctx: object, mode: DeploymentMode): void {
  if (mode !== 'legacy-single-user' && mode !== 'multi-member') {
    throw new Error('identity startup refused: deployment mode is not configured');
  }
  const host = resolverHost(ctx);
  const current = deploymentModes.get(host);
  if (current !== undefined && current !== mode) {
    throw new Error('identity startup refused: deployment mode is already configured');
  }
  deploymentModes.set(host, mode);
}

export function deploymentMode(ctx: object): DeploymentMode | undefined {
  return deploymentModes.get(resolverHost(ctx));
}

/**
 * Old owner routes named by `LEGACY_OWNER_ROUTES`, including the
 * `import-package` command carried on `command`.
 * `legacy-single-user` keeps them. Any other state denies them, including
 * multi-member while identity is absent, failing, or between dispose and remount.
 * The decision does not read cookies. Callers must run it before JSON parsing,
 * ZIP extraction, file reads, and package persistence.
 */
export function authorizeLegacyOwnerRoutes(ctx: object): LegacyOwnerRouteDecision {
  const mode = deploymentMode(ctx);
  if (mode === 'legacy-single-user') return { ok: true };
  if (mode === 'multi-member') return { ok: false, status: 404, code: 'not-found' };
  return { ok: false, status: 401, code: 'deployment-mode-unset' };
}

/** Reads the configured mode. It does not look at the resolver map. */
export function identityAccessMode(ctx: object): IdentityAccessMode {
  const mode = deploymentMode(ctx);
  if (mode === 'legacy-single-user') return 'single-user';
  if (mode === 'multi-member') return 'multi-member';
  throw new Error('identity startup refused: deployment mode is not configured');
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
