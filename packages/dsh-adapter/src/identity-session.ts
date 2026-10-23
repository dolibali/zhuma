/**
 * Member sessions beside the single DSH owner peer.
 *
 * The published Connection admits every browser cookie as `browserPeer`
 * (`principal.kind === 'owner'`). This module does not replace that admission.
 * It registers a prefix route on `ctx.webServer`, stores its signing secret in
 * `ctx.credentials`, and opens a `zhuma_identity` storage domain. A valid
 * member cookie becomes a `zhuma-member` Peer from `ctx.connection.createPeer`.
 * Product multi-member mode does not map a DSH owner cookie to an account.
 * `ownerAccountId` authenticates only an isolated host that imported exactly
 * one account and named it. A browser field named actor, actorId, or memberId
 * is refused and is never the account.
 * `applyIdentity` writes accounts only from an explicit `{id, passwordHash}`
 * import. With no import it writes no seed and stores no password.
 *
 * Space membership is enforced here. `remoteAccess.decide` allows every owner
 * principal before policy conditions run, so a policy alone cannot isolate
 * spaces from the host owner.
 */
import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { PeerScope, Principal } from '@deepseek-ai/dsh-client-connection';
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  createLoginFailureTable,
  loginClientAddress,
  type LoginFailureTable,
} from './login-limiter.js';
import {
  deploymentMode,
  installMemberResolver,
  memberCookieHeader,
  memberCookiePresent,
  memberCredential,
  memberSessionId,
  resolveMember,
  uninstallMemberResolver,
} from './member-session.js';

const PREFIX = '/zhuma-id';
const MAX_BODY_BYTES = 64 * 1024;
// After the 413 bytes are written, keep reading and discard the rest so the
// peer can finish uploading and read the response. There is no Connection: close.
// The socket is destroyed only when this cap or BODY_DISCARD_MS is hit, and
// only after the 413 has flushed and BODY_READ_WINDOW_MS has elapsed.
const BODY_DISCARD_LIMIT = 32 * 1024 * 1024;
const BODY_DISCARD_MS = 5_000;
const BODY_READ_WINDOW_MS = 500;
const SECRET_KEY = 'zhuma-identity/member-session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ACTOR_FIELDS = ['actor', 'actorId', 'memberId'] as const;
const READ_ACTION = 'zhuma-id/read-space';
const WRITE_ACTION = 'zhuma-id/write-space';

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
  importComplete: z.boolean().default(false),
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
  global: { schema: GlobalSchema, initial: { ownerAccountId: '', importComplete: false } },
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

/** Process-wide cap. The libuv pool is shared. */
const PASSWORD_HASH_CONCURRENCY = 4;
/** Logins waiting for a hash slot. The next arrival is refused, not queued. */
const PASSWORD_HASH_QUEUE_LIMIT = 32;
let passwordHashActive = 0;
const passwordHashWaiters: Array<() => void> = [];

class PasswordHashBusyError extends Error {}

function passwordHashSaturated(): boolean {
  return passwordHashWaiters.length >= PASSWORD_HASH_QUEUE_LIMIT;
}

function releasePasswordHashSlot(): void {
  const next = passwordHashWaiters.shift();
  if (next !== undefined) {
    next();
    return;
  }
  passwordHashActive -= 1;
}

function withPasswordHashSlot<T>(work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      try {
        work().then(resolve, reject).finally(releasePasswordHashSlot);
      } catch (error) {
        releasePasswordHashSlot();
        reject(error);
      }
    };
    if (passwordHashActive < PASSWORD_HASH_CONCURRENCY) {
      passwordHashActive += 1;
      run();
      return;
    }
    if (passwordHashWaiters.length >= PASSWORD_HASH_QUEUE_LIMIT) {
      reject(new PasswordHashBusyError());
      return;
    }
    passwordHashWaiters.push(run);
  });
}

/** Random verifier so an unknown account still runs scrypt. */
const DUMMY_VERIFIER = parseVerifier(hashPassword(randomBytes(32).toString('base64url')));
if (DUMMY_VERIFIER === undefined) throw new Error('identity dummy verifier was not created');

interface PasswordHashProbe {
  note(): void;
  hold?(): Promise<void> | void;
  done?(): void;
}

/** Tests can `ctx.provide('zhumaIdentityHashProbe', { note })`. Hosts omit it. */
function passwordHashProbeOf(ctx: Context): PasswordHashProbe | undefined {
  const probe = ctx.get('zhumaIdentityHashProbe', false) as PasswordHashProbe | undefined;
  if (probe === undefined || typeof probe.note !== 'function') return undefined;
  return probe;
}

async function passwordMatches(
  stored: string | undefined,
  password: string,
  probe: PasswordHashProbe | undefined,
): Promise<boolean> {
  const parsed = parseVerifier(stored) ?? DUMMY_VERIFIER;
  if (parsed === undefined) return false;
  const actual = await withPasswordHashSlot(async () => {
    probe?.note();
    try {
      await probe?.hold?.();
      return await deriveKey(password, parsed.salt);
    } finally {
      probe?.done?.();
    }
  });
  const matches = actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
  return matches && stored !== undefined && parseVerifier(stored) !== undefined;
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
  if (parsed.data.ownerAccountId !== undefined && parsed.data.accounts.length !== 1) {
    throw new Error('identity import was rejected: ownerAccountId requires exactly one account');
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
  // The marker is the last write. A domain that already finished is never
  // overwritten. A domain that stopped midway is continued from this import.
  if (domain.global.get().importComplete) return;
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
  await domain.global.set({
    ownerAccountId: imported.ownerAccountId ?? '',
    importComplete: true,
  });
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
  const body = JSON.stringify({ ok: false, error: { code: 'body-too-large' } });
  const headers = {
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    'content-type': 'application/json; charset=utf-8',
  };
  // Do not set Connection: close, and do not res.end() while a live peer may
  // still be uploading. Node finishes the socket when the response ends, and
  // a chunked upload still in progress is then a parse error and ECONNRESET
  // before the client reads the 413. Write the bytes now; end the response
  // only after the request body ends. A socket-less fixture has no peer.
  if (req.socket === undefined || req.socket === null || req.readableEnded === true) {
    res.writeHead(413, headers);
    res.end(body);
    return;
  }
  res.writeHead(413, headers);
  let responseFlushed = false;
  const flushedWait: Array<() => void> = [];
  const whenFlushed = (fn: () => void) => {
    if (responseFlushed) fn();
    else flushedWait.push(fn);
  };
  res.on('error', () => {});
  res.write(body, () => {
    responseFlushed = true;
    const waiting = flushedWait.splice(0);
    for (const fn of waiting) fn();
  });
  drainRejectedBody(req, res, whenFlushed);
}

function drainRejectedBody(
  req: IncomingMessage,
  res: ServerResponse,
  whenFlushed: (fn: () => void) => void,
): void {
  let discarded = 0;
  let settled = false;
  let readWindow: ReturnType<typeof setTimeout> | undefined;
  const detach = () => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
  };
  const done = () => {
    if (settled) return;
    settled = true;
    clearTimeout(discardTimer);
    if (readWindow !== undefined) clearTimeout(readWindow);
    detach();
  };
  const destroySocket = () => {
    const socket = req.socket;
    if (socket === null || socket === undefined || socket.destroyed) return;
    socket.on('error', () => {});
    socket.destroy();
  };
  // Cap and timer are the slowloris bound. The cut waits until the 413 is
  // flushed, then BODY_READ_WINDOW_MS, so the client can read it first.
  const cut = () => {
    if (settled) return;
    settled = true;
    clearTimeout(discardTimer);
    detach();
    req.pause();
    whenFlushed(() => {
      readWindow = setTimeout(destroySocket, BODY_READ_WINDOW_MS);
    });
  };
  const onData = (chunk: Buffer | string) => {
    discarded += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (discarded > BODY_DISCARD_LIMIT) cut();
  };
  const onEnd = () => {
    if (settled) return;
    done();
    if (!res.writableEnded) res.end();
  };
  const onError = () => {
    done();
  };
  const discardTimer = setTimeout(cut, BODY_DISCARD_MS);
  req.on('error', onError);
  req.on('data', onData);
  req.on('end', onEnd);
  if (req.readableEnded === true) {
    onEnd();
    return;
  }
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

function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = header(req.headers, 'content-length');
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return Promise.reject(new BodyTooLargeError());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const finish = (error: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) {
        // Stop parsing before the 413 is written. failTooLarge resumes the
        // request and discards the rest. `for await` is not used here: its
        // return() destroys the request, and the socket closes before the
        // response is flushed.
        req.pause();
        reject(error);
        return;
      }
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        finish(new BodyTooLargeError());
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      if (chunks.length === 0) {
        finish(undefined, undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        finish(undefined, undefined);
        return;
      }
      try {
        finish(undefined, JSON.parse(text) as unknown);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('identity body was not json'));
      }
    };
    const onError = (error: Error) => {
      finish(error);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
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

function spaceIdsFor(domain: IdentityDomain, accountId: string): readonly string[] {
  const ids = new Set<string>();
  for (const [, note] of domain.table('notes').entries()) {
    if (allowsAccount(note, accountId)) ids.add(note.spaceId);
  }
  return [...ids].sort();
}

/** Explicit only: one imported account, and `ownerAccountId` names that account. */
function explicitSingleUser(domain: IdentityDomain): string | undefined {
  if (domain.table('accounts').size !== 1) return undefined;
  const ownerAccountId = domain.global.get().ownerAccountId;
  if (ownerAccountId.length === 0) return undefined;
  if (domain.table('accounts').get(ownerAccountId) === undefined) return undefined;
  return ownerAccountId;
}

/** Mount an explicit account import, member cookies, and space checks. */
export async function applyIdentity(ctx: Context, imported?: IdentityImport): Promise<void> {
  const mode = deploymentMode(ctx);
  if (mode === undefined) {
    throw new Error('identity startup refused: deployment mode is not configured');
  }
  const domain = await ctx.storageDomain.open(identityDomainSpec);
  const attempts = createLoginFailureTable();
  try {
    const { credentials, webServer, remoteAccess } = seams(ctx);
    const secret = await signingSecret(credentials);
    await seedIfEmpty(domain, readImport(imported));
    ctx.effect(() => {
      installMemberResolver(ctx, {
        secret,
        requestRejection: (headers) => ctx.connection.requestRejection({ headers }),
        findSession: (sessionId) => domain.table('sessions').get(sessionId),
        spaceIdsFor: (accountId) => spaceIdsFor(domain, accountId),
        singleUserAccountId: () =>
          mode === 'legacy-single-user' ? explicitSingleUser(domain) : undefined,
        admitOwner: (headers) => {
          const admission = ctx.connection.admit({ headers });
          return 'peer' in admission && admission.peer.principal.kind === 'owner';
        },
      });
      const disposePolicy = remoteAccess.registerPolicy('zhuma-member', memberPolicy(domain));
      const disposeRoute = webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => handle(ctx, domain, secret, remoteAccess, attempts, req, res),
      });
      return async () => {
        uninstallMemberResolver(ctx);
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
  attempts: LoginFailureTable,
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
      const address = loginClientAddress(req);
      if (passwordHashSaturated()) {
        fail(res, 503, 'login-unavailable');
        return;
      }
      const account = domain.table('accounts').get(parsed.data.accountId);
      if (attempts.reserve(address, parsed.data.accountId) === 'limited') {
        fail(res, 429, 'login-rate-limited');
        return;
      }
      let passwordOk = false;
      try {
        passwordOk = await passwordMatches(
          account?.passwordHash,
          parsed.data.password,
          passwordHashProbeOf(ctx),
        );
      } catch (error) {
        if (error instanceof PasswordHashBusyError) {
          fail(res, 503, 'login-unavailable');
          return;
        }
        throw error;
      }
      if (account === undefined || !passwordOk) {
        fail(res, 401, 'invalid-login');
        return;
      }
      attempts.clear(address, parsed.data.accountId);
      await purgeExpiredSessions(domain);
      const sessionId = randomUUID();
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const session: SessionRecord = { id: sessionId, accountId: account.id, expiresAt };
      await domain.table('sessions').put(sessionId, session);
      send(
        res,
        200,
        { ok: true, accountId: account.id },
        memberCookieHeader(
          memberCredential(secret, sessionId, expiresAt),
          Math.floor(SESSION_TTL_MS / 1000),
        ),
      );
      return;
    }

    const resolution = await resolveMember(ctx, { headers: req.headers });
    if (!resolution.ok) {
      fail(res, resolution.status, resolution.code);
      return;
    }
    const cookieValue = header(req.headers, 'cookie');
    let actor: Actor;
    if (memberCookiePresent(cookieValue)) {
      const peer = ctx.connection.createPeer({ principal: memberPrincipal(resolution.memberId) });
      memberPeer = peer;
      const principal = peer.principal as { kind: string; memberId?: string };
      actor = { accountId: resolution.memberId, principal, peerId: peer.id, memberPeer: peer };
    } else {
      const admission = ctx.connection.admit({ headers: req.headers });
      if (!('peer' in admission) || admission.peer.principal.kind !== 'owner') {
        fail(res, 401, 'unauthenticated');
        return;
      }
      actor = {
        accountId: resolution.memberId,
        principal: admission.peer.principal,
        peerId: admission.peer.id,
      };
    }
    if (route.name === 'logout') {
      if (method !== 'POST') {
        fail(res, 405, 'method-not-allowed');
        return;
      }
      const sessionId = memberSessionId(cookieValue);
      if (sessionId === undefined) {
        fail(res, 401, 'member-session-required');
        return;
      }
      await domain.table('sessions').delete(sessionId);
      send(res, 200, { ok: true, accountId: actor.accountId }, memberCookieHeader('', 0));
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
