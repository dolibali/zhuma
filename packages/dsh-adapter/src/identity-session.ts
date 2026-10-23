/**
 * Member sessions beside the single DSH owner peer.
 *
 * The published Connection admits every browser cookie as `browserPeer`
 * (`principal.kind === 'owner'`). This module does not replace that admission.
 * It registers a prefix route on `ctx.webServer`, stores its signing secret in
 * `ctx.credentials`, and opens a `zhuma_identity` storage domain. A valid
 * member cookie becomes a `zhuma-member` Peer from `ctx.connection.createPeer`.
 * A request with no member cookie can still be the host owner, but only when
 * the import set `ownerAccountId` to an account that was stored. With no
 * import, or an import that omits that field, the DSH cookie is not a product
 * account. A browser field named
 * actor, actorId, or memberId is refused and is never the account.
 * `applyIdentity` writes accounts only from an explicit `{id, passwordHash}`
 * import. With no import it writes no seed and stores no password.
 *
 * Space membership is enforced here. `remoteAccess.decide` allows every owner
 * principal before policy conditions run, so a policy alone cannot isolate
 * spaces from the host owner.
 */
import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { PeerScope, Principal } from '@deepseek-ai/dsh-client-connection';
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

const PREFIX = '/zhuma-id';
const MAX_BODY_BYTES = 64 * 1024;
const COOKIE_NAME = 'zhuma-member';
const SECRET_KEY = 'zhuma-identity/member-session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_FAILURE_WINDOW_MS = 60_000;
const ACTOR_FIELDS = ['actor', 'actorId', 'memberId'] as const;
const READ_ACTION = 'zhuma-id/read-space';
const WRITE_ACTION = 'zhuma-id/write-space';

export const OWNER_ACCOUNT_ID = 'lin';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const VERIFIER_PATTERN = /^scrypt\$16384\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{64})$/;

const AccountSchema = z.object({
  id: z.string().min(1),
  passwordHash: z.string().regex(VERIFIER_PATTERN),
});
const SessionSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  expiresAt: z.number().int(),
});
const NoteSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  ownerId: z.string().min(1),
  teamMemberIds: z.array(z.string()),
  text: z.string(),
});
const GlobalSchema = z.object({
  ownerAccountId: z.string(),
});
const LoginSchema = z.strictObject({
  accountId: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});
const WriteSchema = z.strictObject({
  text: z.string().max(4000),
});
const ImportSchema = z.strictObject({
  accounts: z.array(AccountSchema.strict()),
  ownerAccountId: z.string().min(1).optional(),
  notes: z.array(NoteSchema.strict()).optional(),
});

/** Explicit account import. `passwordHash` is a verifier, never a password. */
export interface IdentityImport {
  readonly accounts: readonly { readonly id: string; readonly passwordHash: string }[];
  readonly ownerAccountId?: string;
  readonly notes?: readonly {
    readonly id: string;
    readonly spaceId: string;
    readonly ownerId: string;
    readonly teamMemberIds: readonly string[];
    readonly text: string;
  }[];
}

export const identityDomainSpec = defineDomain({
  name: 'zhuma_identity',
  version: 1,
  global: { schema: GlobalSchema, initial: { ownerAccountId: '' } },
  tables: {
    accounts: { valueSchema: AccountSchema },
    sessions: { valueSchema: SessionSchema },
    notes: { valueSchema: NoteSchema },
  },
});

type AccountRecord = z.infer<typeof AccountSchema>;
type SessionRecord = z.infer<typeof SessionSchema>;
type NoteRecord = z.infer<typeof NoteSchema>;
type IdentityDomain = Domain<typeof identityDomainSpec>;

interface SecretPayload {
  readonly version: 1;
  readonly secret: string;
}
interface GrantRecord {
  readonly kind: string;
  readonly payload?: unknown;
}
interface CredentialsLike {
  modifyRecord(
    key: string,
    mutate: (current: GrantRecord | undefined) => Promise<GrantRecord | undefined>,
  ): Promise<GrantRecord | undefined>;
}
interface WebRoute {
  readonly kind: 'prefix';
  readonly path: string;
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}
interface WebServerLike {
  register(route: WebRoute): () => void;
}
interface AccessRequest {
  readonly principal: { readonly kind: string; readonly memberId?: string };
  readonly action: string;
  readonly resources: readonly { readonly kind: 'global' }[];
  readonly args?: Readonly<Record<string, unknown>>;
}
interface RemoteAccessLike {
  registerPolicy(
    kind: string,
    policy: {
      bindings(principal: { readonly kind: string; readonly memberId?: string }): readonly {
        readonly role: {
          readonly name: string;
          readonly resource: 'global';
          readonly actions: readonly string[];
        };
        readonly resource: { readonly kind: 'global' };
        condition?(request: {
          readonly action: string;
          readonly resource: { readonly kind: 'global' };
          readonly args?: Readonly<Record<string, unknown>>;
        }): { readonly kind: 'allow' } | { readonly kind: 'deny'; readonly reason: string };
      }[];
    },
  ): () => void;
  decide(
    request: AccessRequest,
  ): { readonly kind: 'allow' } | { readonly kind: 'deny'; readonly reason: string };
}
interface HostSeams {
  readonly credentials: CredentialsLike;
  readonly webServer: WebServerLike;
  readonly remoteAccess: RemoteAccessLike;
}
interface Actor {
  readonly accountId: string;
  readonly principal: { readonly kind: string; readonly memberId?: string };
  readonly peerId: string;
  readonly memberPeer?: PeerScope;
}
type IdentityRoute =
  | { readonly name: 'login' | 'logout' | 'session' }
  | { readonly name: 'space'; readonly spaceId: string }
  | { readonly name: 'note'; readonly noteId: string };

export const identityInject = [
  'connection',
  'storageDomain',
  'credentials',
  'webServer',
  'remoteAccess',
] as const;

interface ScryptVerifier {
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function scryptOptions(): { N: number; r: number; p: number; maxmem: number } {
  return { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 };
}

function parseVerifier(stored: string | undefined): ScryptVerifier | undefined {
  if (stored === undefined) return undefined;
  const match = VERIFIER_PATTERN.exec(stored);
  if (match === null) return undefined;
  return { salt: Buffer.from(match[1] ?? '', 'hex'), hash: Buffer.from(match[2] ?? '', 'hex') };
}

/** Salted scrypt verifier for an import. Not used on the request path. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, scryptOptions());
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, scryptOptions(), (error, derived) => {
      if (error !== null) reject(error);
      else resolve(derived);
    });
  });
}

/** Random verifier so an unknown account still runs scrypt. */
const DUMMY_VERIFIER = parseVerifier(hashPassword(randomBytes(32).toString('base64url')));
if (DUMMY_VERIFIER === undefined) throw new Error('identity dummy verifier was not created');

async function passwordMatches(stored: string | undefined, password: string): Promise<boolean> {
  const parsed = parseVerifier(stored) ?? DUMMY_VERIFIER;
  if (parsed === undefined) return false;
  const actual = await deriveKey(password, parsed.salt);
  const matches = actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
  return matches && stored !== undefined && parseVerifier(stored) !== undefined;
}

const loginFailures = new Map<string, { count: number; resetAt: number }>();

function clientAddress(req: IncomingMessage): string {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && address.length > 0 ? address : 'unknown';
}

function loginFailureKey(req: IncomingMessage, accountId: string): string {
  return `${clientAddress(req)}\0${accountId}`;
}

function loginLimited(req: IncomingMessage, accountId: string): boolean {
  const entry = loginFailures.get(loginFailureKey(req, accountId));
  return entry !== undefined && entry.resetAt > Date.now() && entry.count >= LOGIN_FAILURE_LIMIT;
}

function recordLoginFailure(req: IncomingMessage, accountId: string): void {
  const key = loginFailureKey(req, accountId);
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (entry === undefined || entry.resetAt <= now) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(req: IncomingMessage, accountId: string): void {
  loginFailures.delete(loginFailureKey(req, accountId));
}

function sign(secret: Buffer, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function isSecretPayload(value: unknown): value is SecretPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as { version?: unknown; secret?: unknown };
  return payload.version === 1 && typeof payload.secret === 'string' && payload.secret.length >= 32;
}

function seams(ctx: Context): HostSeams {
  const host = ctx as Context & Partial<HostSeams>;
  if (!host.credentials || !host.webServer || !host.remoteAccess) {
    throw new Error('identity session requires credentials, webServer, and remoteAccess');
  }
  return {
    credentials: host.credentials,
    webServer: host.webServer,
    remoteAccess: host.remoteAccess,
  };
}

async function signingSecret(credentials: CredentialsLike): Promise<Buffer> {
  const created: SecretPayload = { version: 1, secret: randomBytes(32).toString('base64url') };
  const record = await credentials.modifyRecord(SECRET_KEY, async (current) => {
    if (current?.kind === 'grant' && isSecretPayload(current.payload)) return undefined;
    return { kind: 'grant', payload: created };
  });
  if (record?.kind !== 'grant' || !isSecretPayload(record.payload)) {
    throw new Error('identity session signing secret was not stored');
  }
  return Buffer.from(record.payload.secret, 'base64url');
}

function readImport(value: unknown): IdentityImport | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('identity import was rejected');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => key !== 'accounts' && key !== 'ownerAccountId' && key !== 'notes',
  );
  if (unknown.length > 0) {
    throw new Error(`identity import was rejected: unknown key ${unknown.join(', ')}`);
  }
  if (!Object.hasOwn(record, 'accounts')) {
    throw new Error('identity import was rejected: accounts is required');
  }
  if (Array.isArray(record.accounts) && record.accounts.length === 0) {
    throw new Error('identity import was rejected: accounts is empty');
  }
  const parsed = ImportSchema.safeParse(record);
  if (!parsed.success) throw new Error('identity import was rejected');
  const accountIds = new Set<string>();
  for (const account of parsed.data.accounts) {
    if (accountIds.has(account.id)) {
      throw new Error(`identity import was rejected: duplicate account ${account.id}`);
    }
    accountIds.add(account.id);
  }
  if (parsed.data.ownerAccountId !== undefined && !accountIds.has(parsed.data.ownerAccountId)) {
    throw new Error('identity import was rejected: ownerAccountId is not an imported account');
  }
  const noteIds = new Set<string>();
  for (const note of parsed.data.notes ?? []) {
    if (noteIds.has(note.id)) {
      throw new Error(`identity import was rejected: duplicate note ${note.id}`);
    }
    noteIds.add(note.id);
    if (!accountIds.has(note.ownerId)) {
      throw new Error(
        `identity import was rejected: note ${note.id} owner is not an imported account`,
      );
    }
    for (const memberId of note.teamMemberIds) {
      if (!accountIds.has(memberId)) {
        throw new Error(
          `identity import was rejected: note ${note.id} member is not an imported account`,
        );
      }
    }
  }
  const imported: IdentityImport = { accounts: parsed.data.accounts };
  if (parsed.data.ownerAccountId !== undefined) {
    return {
      ...imported,
      ownerAccountId: parsed.data.ownerAccountId,
      ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
    };
  }
  if (parsed.data.notes !== undefined) return { ...imported, notes: parsed.data.notes };
  return imported;
}

async function seedIfEmpty(
  domain: IdentityDomain,
  imported: IdentityImport | undefined,
): Promise<void> {
  if (domain.table('accounts').size > 0) return;
  if (imported === undefined) return;
  for (const account of imported.accounts) {
    const value: AccountRecord = { id: account.id, passwordHash: account.passwordHash };
    await domain.table('accounts').put(account.id, value);
  }
  for (const note of imported.notes ?? []) {
    const value: NoteRecord = {
      id: note.id,
      spaceId: note.spaceId,
      ownerId: note.ownerId,
      teamMemberIds: [...note.teamMemberIds],
      text: note.text,
    };
    await domain.table('notes').put(note.id, value);
  }
  if (imported.ownerAccountId !== undefined) {
    await domain.global.set({ ownerAccountId: imported.ownerAccountId });
  }
}

function memberPrincipal(memberId: string): Principal {
  const principal: { readonly kind: 'zhuma-member'; readonly memberId: string } = {
    kind: 'zhuma-member',
    memberId,
  };
  return principal as unknown as Principal;
}

async function purgeExpiredSessions(domain: IdentityDomain): Promise<void> {
  const now = Date.now();
  const stale: string[] = [];
  for (const [id, session] of domain.table('sessions').entries()) {
    if (session.expiresAt <= now) stale.push(id);
  }
  for (const id of stale) await domain.table('sessions').delete(id);
}

function allowsAccount(note: NoteRecord, accountId: string): boolean {
  return note.ownerId === accountId || note.teamMemberIds.includes(accountId);
}

function memberPolicy(domain: IdentityDomain) {
  const notes = domain.table('notes');
  return {
    bindings(principal: { readonly memberId?: string }) {
      return [
        {
          role: {
            name: 'space-note',
            resource: 'global' as const,
            actions: [READ_ACTION, WRITE_ACTION],
          },
          resource: { kind: 'global' as const },
          condition(request: { readonly args?: Readonly<Record<string, unknown>> }) {
            const memberId = principal.memberId;
            if (memberId === undefined) return { kind: 'deny' as const, reason: 'not-a-member' };
            const noteId = request.args?.noteId;
            if (typeof noteId === 'string') {
              const note = notes.get(noteId);
              if (!note) return { kind: 'deny' as const, reason: 'not-found' };
              return allowsAccount(note, memberId)
                ? { kind: 'allow' as const }
                : { kind: 'deny' as const, reason: 'not-a-member' };
            }
            const spaceId = request.args?.spaceId;
            if (typeof spaceId === 'string') {
              for (const [, note] of notes.entries()) {
                if (note.spaceId === spaceId && allowsAccount(note, memberId)) {
                  return { kind: 'allow' as const };
                }
              }
              return { kind: 'deny' as const, reason: 'not-a-member' };
            }
            return { kind: 'deny' as const, reason: 'not-found' };
          },
        },
      ];
    },
  };
}

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function hasActorField(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return ACTOR_FIELDS.some((field) => Object.hasOwn(value, field));
}

function queryHasActor(url: URL): boolean {
  return ACTOR_FIELDS.some((field) => url.searchParams.has(field));
}

function hasMemberCookie(cookieHeader: string | undefined): boolean {
  if (cookieHeader === undefined) return false;
  return cookieHeader.split(';').some((part) => part.trim().startsWith(`${COOKIE_NAME}=`));
}

function readMemberCookie(
  cookieHeader: string | undefined,
):
  | { readonly sessionId: string; readonly expiresAt: number; readonly signature: string }
  | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${COOKIE_NAME}=`)) continue;
    const [sessionId, expires, signature] = trimmed.slice(COOKIE_NAME.length + 1).split('.');
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

function cookieHeader(value: string, maxAge: number): string {
  return `${COOKIE_NAME}=${value}; Max-Age=${maxAge}; Path=${PREFIX}; HttpOnly; SameSite=Strict`;
}

function send(res: ServerResponse, status: number, body: unknown, setCookie?: string): void {
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
  if (setCookie !== undefined) headers['set-cookie'] = setCookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, code: string, setCookie?: string): void {
  send(res, status, { ok: false, error: { code } }, setCookie);
}

function failTooLarge(req: IncomingMessage, res: ServerResponse): void {
  req.on('error', () => {});
  const body = JSON.stringify({ ok: false, error: { code: 'body-too-large' } });
  res.writeHead(413, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-length': String(Buffer.byteLength(body)),
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(body);
  const stop = () => {
    req.resume();
    req.destroy();
  };
  if (res.writableFinished === true) stop();
  else res.on('finish', stop);
  req.resume();
}

function permitted(
  res: ServerResponse,
  remoteAccess: RemoteAccessLike,
  actor: Actor,
  action: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const decision = remoteAccess.decide({
    principal: actor.principal,
    action,
    resources: [{ kind: 'global' }],
    args,
  });
  if (decision.kind === 'deny') {
    fail(res, 404, 'not-found');
    return false;
  }
  return true;
}

class BodyTooLargeError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = header(req.headers, 'content-length');
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  return JSON.parse(text) as unknown;
}

function matchRoute(pathname: string): IdentityRoute | undefined {
  if (!pathname.startsWith(`${PREFIX}/`)) return undefined;
  const rest = pathname.slice(PREFIX.length + 1);
  if (rest === 'login' || rest === 'logout' || rest === 'session') return { name: rest };
  const [head, id, extra] = rest.split('/');
  if (extra !== undefined || id === undefined || !/^[a-z0-9-]{1,64}$/.test(id)) return undefined;
  if (head === 'spaces') return { name: 'space', spaceId: id };
  if (head === 'notes') return { name: 'note', noteId: id };
  return undefined;
}

function visibleNotes(domain: IdentityDomain, spaceId: string, accountId: string): NoteRecord[] {
  const notes: NoteRecord[] = [];
  for (const [, note] of domain.table('notes').entries()) {
    if (note.spaceId === spaceId && allowsAccount(note, accountId)) notes.push(note);
  }
  return notes;
}

async function resolveActor(
  ctx: Context,
  domain: IdentityDomain,
  secret: Buffer,
  req: IncomingMessage,
): Promise<Actor | undefined> {
  const cookieHeaderValue = header(req.headers, 'cookie');
  if (hasMemberCookie(cookieHeaderValue)) {
    const cookie = readMemberCookie(cookieHeaderValue);
    if (cookie === undefined || cookie.expiresAt <= Date.now()) return undefined;
    if (!signatureMatches(secret, cookie.sessionId, cookie.expiresAt, cookie.signature))
      return undefined;
    const session: SessionRecord | undefined = domain.table('sessions').get(cookie.sessionId);
    if (session === undefined || session.expiresAt !== cookie.expiresAt) return undefined;
    const memberPeer = ctx.connection.createPeer({ principal: memberPrincipal(session.accountId) });
    const principal = memberPeer.principal as { kind: string; memberId?: string };
    return { accountId: session.accountId, principal, peerId: memberPeer.id, memberPeer };
  }
  const admission = ctx.connection.admit({ headers: req.headers });
  if (!('peer' in admission) || admission.peer.principal.kind !== 'owner') return undefined;
  const ownerAccountId = domain.global.get().ownerAccountId;
  if (ownerAccountId.length === 0 || domain.table('accounts').get(ownerAccountId) === undefined) {
    return undefined;
  }
  return {
    accountId: ownerAccountId,
    principal: admission.peer.principal,
    peerId: admission.peer.id,
  };
}

/** Mount an explicit account import, member cookies, and space checks. */
export async function applyIdentity(ctx: Context, imported?: IdentityImport): Promise<void> {
  const domain = await ctx.storageDomain.open(identityDomainSpec);
  try {
    const { credentials, webServer, remoteAccess } = seams(ctx);
    const secret = await signingSecret(credentials);
    await seedIfEmpty(domain, readImport(imported));
    ctx.effect(() => {
      const disposePolicy = remoteAccess.registerPolicy('zhuma-member', memberPolicy(domain));
      const disposeRoute = webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => handle(ctx, domain, secret, remoteAccess, req, res),
      });
      return async () => {
        disposeRoute();
        disposePolicy();
        await domain.close();
      };
    });
  } catch (error) {
    await domain.close();
    throw error;
  }
}

async function handle(
  ctx: Context,
  domain: IdentityDomain,
  secret: Buffer,
  remoteAccess: RemoteAccessLike,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let memberPeer: PeerScope | undefined;
  try {
    // requestRejection runs Connection's Host/Origin fence. 403 is untrusted.
    // 401 only means there is no DSH session; a member cookie is still checked.
    // isTrustedApiRequest is not exported by the published package.
    if (ctx.connection.requestRejection({ headers: req.headers }) === 403) {
      fail(res, 403, 'untrusted-request');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = matchRoute(url.pathname);
    if (route === undefined) {
      fail(res, 404, 'not-found');
      return;
    }
    if (queryHasActor(url)) {
      fail(res, 400, 'actor-from-body');
      return;
    }
    const method = req.method ?? 'GET';
    const needsBody = method === 'POST' || method === 'PUT';
    let payload: unknown;
    if (needsBody) {
      const mediaType = header(req.headers, 'content-type')?.split(';', 1)[0];
      if (mediaType !== 'application/json') {
        fail(res, 415, 'unsupported-media-type');
        return;
      }
      payload = await readJson(req);
      if (hasActorField(payload)) {
        fail(res, 400, 'actor-from-body');
        return;
      }
    }
    if (route.name === 'login') {
      if (method !== 'POST') {
        fail(res, 405, 'method-not-allowed');
        return;
      }
      const parsed = LoginSchema.safeParse(payload);
      if (!parsed.success) {
        fail(res, 400, 'validation');
        return;
      }
      const account = domain.table('accounts').get(parsed.data.accountId);
      if (loginLimited(req, parsed.data.accountId)) {
        fail(res, 429, 'login-rate-limited');
        return;
      }
      if (
        account === undefined ||
        !(await passwordMatches(account.passwordHash, parsed.data.password))
      ) {
        recordLoginFailure(req, parsed.data.accountId);
        fail(res, 401, 'invalid-login');
        return;
      }
      clearLoginFailures(req, parsed.data.accountId);
      await purgeExpiredSessions(domain);
      const sessionId = randomUUID();
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const session: SessionRecord = { id: sessionId, accountId: account.id, expiresAt };
      await domain.table('sessions').put(sessionId, session);
      const value = `${sessionId}.${expiresAt}.${sign(secret, `${sessionId}.${expiresAt}`)}`;
      send(
        res,
        200,
        { ok: true, accountId: account.id },
        cookieHeader(value, Math.floor(SESSION_TTL_MS / 1000)),
      );
      return;
    }

    const actor = await resolveActor(ctx, domain, secret, req);
    memberPeer = actor?.memberPeer;
    if (actor === undefined) {
      fail(res, 401, 'unauthenticated');
      return;
    }
    if (route.name === 'logout') {
      if (method !== 'POST') {
        fail(res, 405, 'method-not-allowed');
        return;
      }
      const cookie = readMemberCookie(header(req.headers, 'cookie'));
      if (cookie === undefined) {
        fail(res, 401, 'member-session-required');
        return;
      }
      await domain.table('sessions').delete(cookie.sessionId);
      send(res, 200, { ok: true, accountId: actor.accountId }, cookieHeader('', 0));
      return;
    }
    if (route.name === 'session') {
      if (method !== 'GET') {
        fail(res, 405, 'method-not-allowed');
        return;
      }
      send(res, 200, {
        ok: true,
        accountId: actor.accountId,
        principal: actor.principal,
        peerId: actor.peerId,
      });
      return;
    }

    if (route.name === 'space') {
      if (method !== 'GET') {
        fail(res, 405, 'method-not-allowed');
        return;
      }
      if (!permitted(res, remoteAccess, actor, READ_ACTION, { spaceId: route.spaceId })) return;
      const notes = visibleNotes(domain, route.spaceId, actor.accountId);
      if (notes.length === 0) {
        fail(res, 404, 'not-found');
        return;
      }
      send(res, 200, { ok: true, accountId: actor.accountId, spaceId: route.spaceId, notes });
      return;
    }
    if (route.name === 'note') {
      if (method !== 'GET' && method !== 'PUT') {
        fail(res, 405, 'method-not-allowed');
        return;
      }
      const action = method === 'PUT' ? WRITE_ACTION : READ_ACTION;
      if (!permitted(res, remoteAccess, actor, action, { noteId: route.noteId })) return;
      const note = domain.table('notes').get(route.noteId);
      if (note === undefined || !allowsAccount(note, actor.accountId)) {
        fail(res, 404, 'not-found');
        return;
      }
      if (method === 'GET') {
        send(res, 200, { ok: true, accountId: actor.accountId, note });
        return;
      }
      const parsed = WriteSchema.safeParse(payload);
      if (!parsed.success) {
        fail(res, 400, 'validation');
        return;
      }
      const next: NoteRecord = { ...note, text: parsed.data.text };
      await domain.table('notes').put(note.id, next);
      send(res, 200, { ok: true, accountId: actor.accountId, note: next });
      return;
    }
    fail(res, 404, 'not-found');
  } catch (error) {
    if (res.headersSent === true) return;
    if (error instanceof BodyTooLargeError) {
      failTooLarge(req, res);
      return;
    }
    fail(
      res,
      error instanceof SyntaxError ? 400 : 500,
      error instanceof SyntaxError ? 'validation' : 'unavailable',
    );
  } finally {
    await memberPeer?.dispose();
  }
}
