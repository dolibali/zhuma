import { randomUUID } from 'node:crypto';
import { symbols, type Context } from '@deepseek-ai/cordis';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { z } from 'zod';
import {
  KnowledgeLibrariesRequestSchema,
  KnowledgeListRequestSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeReadRequestSchema,
  KnowledgeDraftsRequestSchema,
  KnowledgeDraftRequestSchema,
  KnowledgeSaveDraftRequestSchema,
  KnowledgePublishRequestSchema,
  REMOTE_RUN_PROTOCOL_VERSION,
  remoteRunResponseSchema,
  remoteBackendInfoSchema,
} from '@zhuma/agent-core';
import { MemberWorkbenchCommandSchema, MemberWorkbenchPlanSchema } from './member-workbench-dto.js';
import {
  identityRegistrationSchema,
  identityPasswordChangeSchema,
  identityTeamCreationSchema,
  identityTeamMembersSchema,
  identityTeamMemberCommandSchema,
} from './identity-member-lifecycle.js';
import { MEMBER_LOCAL_REMOTE_METHODS } from './host-remote-run-http.js';
import { MEMBER_COOKIE_NAME } from './member-session.js';
import { taskProgressQuerySchema } from './execution-task-progress-contract.js';
import { projectArtifactsQuerySchema } from './execution-project-artifacts-contract.js';
import { executionMemberRequestSchemas } from './execution-service.js';
import { EXECUTION_BODY_BYTE_LIMIT } from './execution-plugin.js';
import { hostRunOptionsQuerySchema } from './host-run-options.js';

/** The existing execution carrier's legal text/draft budget, not a file stream. */
export const SHARED_BACKEND_BODY_BYTE_LIMIT = EXECUTION_BODY_BYTE_LIMIT;

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
const empty = z.strictObject({});
export const SHARED_BACKEND_OPERATIONS = [
  'identity.login',
  'identity.session',
  'identity.logout',
  'identity.register',
  'identity.password',
  'identity.teams.read',
  'identity.teams.create',
  'identity.members.read',
  'identity.members.change',
  'member.snapshot',
  'member.command',
  'member.plan',
  'knowledge.libraries',
  'knowledge.list',
  'knowledge.search',
  'knowledge.read',
  'knowledge.drafts',
  'knowledge.draft',
  'knowledge.save-draft',
  'knowledge.propose-draft',
  'knowledge.publish',
  'execution.inbox',
  'execution.startable',
  'execution.task-progress',
  'execution.project-artifacts',
  'execution.start-plan',
  'execution.submit',
  'execution.ballot',
  'execution.revision',
  'execution.upstream-content',
  'execution.draft',
  'execution.local-run-options',
] as const;
export type SharedBackendOperation = (typeof SHARED_BACKEND_OPERATIONS)[number];
export const sharedBackendRequestSchema = z.strictObject({
  connectionId: z.uuid(),
  operation: z.enum(SHARED_BACKEND_OPERATIONS),
  payload: z.unknown(),
  rpcId: z.uuid().optional(),
});
export const sharedBackendSelectionSchema = z.strictObject({
  requestId: z.uuid(),
  expectedConnectionId: z.uuid().nullable(),
  origin: z.string().max(2048).nullable(),
});
export interface SharedBackendStatus {
  readonly origin: string | null;
  readonly connectionId: string | null;
  readonly backendId: string | null;
  readonly actorId: string | null;
}
export interface SharedBackendResponse {
  readonly connectionId: string;
  readonly status: number;
  readonly body: unknown;
}
export type SharedBackendRequest = z.infer<typeof sharedBackendRequestSchema>;
export type SharedBackendSelection = z.infer<typeof sharedBackendSelectionSchema>;
export class SharedBackendError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'changed'
      | 'unavailable'
      | 'identity-changed'
      | 'invalid-response'
      | 'native-busy',
  ) {
    super('共享服务连接未就绪。');
  }
}
function originOf(value: string): string {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw Error();
    return url.origin;
  } catch {
    throw new SharedBackendError('invalid');
  }
}
const privateSchema = z
  .strictObject({
    version: z.literal(1),
    origin: z.string().nullable(),
    connectionId: z.uuid(),
    requestId: z.uuid(),
    authRevision: z.uuid(),
    authAttempt: z.uuid(),
    cookie: z
      .string()
      .regex(/^zhuma-member=[A-Za-z0-9._-]+$/u)
      .max(4096)
      .nullable(),
    backendId: z.uuid().nullable(),
    actorId: id.nullable(),
  })
  .refine(
    (row) =>
      (row.origin !== null || row.cookie === null) &&
      (row.cookie === null
        ? row.backendId === null && row.actorId === null
        : row.backendId !== null && row.actorId !== null),
  );
type PrivateConnection = z.infer<typeof privateSchema>;
const slot = credentialKey('zhuma-workbench', 'shared-backend');
const original = (value: unknown): unknown =>
  value && typeof value === 'object' ? (Reflect.get(value, symbols.original) ?? value) : value;
const publicStatus = (row: PrivateConnection | undefined): SharedBackendStatus => ({
  origin: row?.origin ?? null,
  connectionId: row?.connectionId ?? null,
  backendId: row?.backendId ?? null,
  actorId: row?.actorId ?? null,
});
const descriptors = {
  'identity.login': {
    schema: z.strictObject({ accountId: id, password: z.string().min(1).max(200) }),
    path: '/zhuma-id/login',
    verb: 'POST',
    auth: true,
  },
  'identity.session': { schema: empty, path: '/zhuma-id/session', verb: 'GET', auth: false },
  'identity.logout': { schema: empty, path: '/zhuma-id/logout', verb: 'POST', auth: true },
  'identity.register': {
    schema: identityRegistrationSchema,
    path: '/zhuma-id/register',
    verb: 'POST',
    auth: false,
  },
  'identity.password': {
    schema: identityPasswordChangeSchema,
    path: '/zhuma-id/password',
    verb: 'POST',
    auth: true,
  },
  'identity.teams.read': { schema: empty, path: '/zhuma-id/teams', verb: 'GET', auth: false },
  'identity.teams.create': {
    schema: identityTeamCreationSchema,
    path: '/zhuma-id/teams',
    verb: 'POST',
    auth: false,
  },
  'identity.members.read': {
    schema: identityTeamMembersSchema,
    path: '/zhuma-id/team-members',
    verb: 'GET',
    auth: false,
  },
  'identity.members.change': {
    schema: identityTeamMemberCommandSchema,
    path: '/zhuma-id/team-members',
    verb: 'POST',
    auth: false,
  },
  'member.snapshot': {
    schema: z.strictObject({ spaceId: id }),
    path: '/api/zhuma-member/snapshot',
    verb: 'POST',
    auth: false,
  },
  'member.command': {
    schema: MemberWorkbenchCommandSchema,
    path: '/api/zhuma-member/command',
    verb: 'POST',
    auth: false,
  },
  'member.plan': {
    schema: MemberWorkbenchPlanSchema,
    path: '/api/zhuma-member/plan',
    verb: 'POST',
    auth: false,
  },
  'knowledge.libraries': {
    schema: KnowledgeLibrariesRequestSchema,
    path: '/api/zhuma-knowledge/libraries',
    verb: 'POST',
    auth: false,
  },
  'knowledge.list': {
    schema: KnowledgeListRequestSchema,
    path: '/api/zhuma-knowledge/list',
    verb: 'POST',
    auth: false,
  },
  'knowledge.search': {
    schema: KnowledgeSearchRequestSchema,
    path: '/api/zhuma-knowledge/search',
    verb: 'POST',
    auth: false,
  },
  'knowledge.read': {
    schema: KnowledgeReadRequestSchema,
    path: '/api/zhuma-knowledge/read',
    verb: 'POST',
    auth: false,
  },
  'knowledge.drafts': {
    schema: KnowledgeDraftsRequestSchema,
    path: '/api/zhuma-knowledge/drafts',
    verb: 'POST',
    auth: false,
  },
  'knowledge.draft': {
    schema: KnowledgeDraftRequestSchema,
    path: '/api/zhuma-knowledge/draft',
    verb: 'POST',
    auth: false,
  },
  'knowledge.save-draft': {
    schema: KnowledgeSaveDraftRequestSchema,
    path: '/api/zhuma-knowledge/save-draft',
    verb: 'POST',
    auth: false,
  },
  'knowledge.propose-draft': {
    schema: KnowledgeSaveDraftRequestSchema,
    path: '/api/zhuma-knowledge/propose-draft',
    verb: 'POST',
    auth: false,
  },
  'knowledge.publish': {
    schema: KnowledgePublishRequestSchema,
    path: '/api/zhuma-knowledge/publish',
    verb: 'POST',
    auth: false,
  },
  'execution.inbox': {
    schema: z.strictObject({ spaceId: id }),
    path: '/api/zhuma-exec/inbox',
    verb: 'POST',
    auth: false,
  },
  'execution.startable': {
    schema: z.strictObject({ spaceId: id }),
    path: '/api/zhuma-exec/startable',
    verb: 'POST',
    auth: false,
  },
  'execution.task-progress': {
    schema: taskProgressQuerySchema,
    path: '/api/zhuma-exec/task-progress',
    verb: 'POST',
    auth: false,
  },
  'execution.project-artifacts': {
    schema: projectArtifactsQuerySchema,
    path: '/api/zhuma-exec/project-artifacts',
    verb: 'POST',
    auth: false,
  },
  'execution.start-plan': {
    schema: executionMemberRequestSchemas.startPlan,
    path: '/api/zhuma-exec/start-plan',
    verb: 'POST',
    auth: false,
  },
  'execution.submit': {
    schema: executionMemberRequestSchemas.submit,
    path: '/api/zhuma-exec/submit',
    verb: 'POST',
    auth: false,
  },
  'execution.ballot': {
    schema: executionMemberRequestSchemas.ballot,
    path: '/api/zhuma-exec/ballot',
    verb: 'POST',
    auth: false,
  },
  'execution.revision': {
    schema: executionMemberRequestSchemas.revision,
    path: '/api/zhuma-exec/revision',
    verb: 'POST',
    auth: false,
  },
  'execution.upstream-content': {
    schema: executionMemberRequestSchemas.upstreamContent,
    path: '/api/zhuma-exec/upstream-content',
    verb: 'POST',
    auth: false,
  },
  'execution.draft': {
    schema: z.union([
      executionMemberRequestSchemas.draftRead,
      executionMemberRequestSchemas.draftWrite,
    ]),
    path: '/api/zhuma-exec/draft',
    verb: 'POST',
    auth: false,
  },
  'execution.local-run-options': {
    schema: hostRunOptionsQuerySchema,
    path: '/api/zhuma-member/local-run-options',
    verb: 'POST',
    auth: false,
  },
} as const;
const manualOperations = new Set<SharedBackendOperation>([
  'execution.start-plan',
  'execution.submit',
  'execution.ballot',
  'execution.revision',
  'execution.upstream-content',
  'execution.draft',
]);

/** One exact original Credentials record, never a profile/cookie/token export.
 * The local owner authorizes settings/transport; only the remote member Cookie
 * authenticates product operations. No remote owner exchange or generic RPC. */
export class HostSharedBackend {
  private readonly lifetime = new AbortController();
  private readonly provider;
  private readonly providerIdentity;
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly nativeListeners = new Set<(kind: 'changed' | 'revoking') => void>();
  constructor(
    private readonly ctx: Context,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.provider = ctx.get('credentials');
    this.providerIdentity = original(this.provider);
  }
  private current() {
    this.lifetime.signal.throwIfAborted();
    this.ctx.fiber.assertActive();
    const provider = this.ctx.get('credentials');
    if (!provider || original(provider) !== this.providerIdentity)
      throw new SharedBackendError('unavailable');
    return provider;
  }
  private parse(record: unknown): PrivateConnection | undefined {
    if (record === undefined) return undefined;
    if (
      !record ||
      typeof record !== 'object' ||
      !('kind' in record) ||
      record.kind !== 'grant' ||
      !('payload' in record)
    )
      throw new SharedBackendError('unavailable');
    const result = privateSchema.safeParse(record.payload);
    if (
      !result.success ||
      (result.data.origin !== null && originOf(result.data.origin) !== result.data.origin)
    )
      throw new SharedBackendError('unavailable');
    return result.data;
  }
  private async read() {
    const row = await this.current().readRecord(slot);
    this.current();
    return this.parse(row);
  }
  private async modify(change: (current: PrivateConnection | undefined) => PrivateConnection) {
    const stored = await this.current().modifyRecord(slot, async (row) => {
      this.current();
      return { kind: 'grant', payload: privateSchema.parse(change(this.parse(row))) };
    });
    this.current();
    const result = this.parse(stored);
    if (!result) throw new SharedBackendError('unavailable');
    return result;
  }
  private async assertCurrent(expected: PrivateConnection, signal: AbortSignal, auth = false) {
    signal.throwIfAborted();
    const latest = await this.read();
    signal.throwIfAborted();
    if (
      !latest ||
      latest.connectionId !== expected.connectionId ||
      latest.authRevision !== expected.authRevision ||
      latest.origin !== expected.origin ||
      latest.cookie !== expected.cookie ||
      (auth && latest.authAttempt !== expected.authAttempt) ||
      latest.backendId !== expected.backendId ||
      latest.actorId !== expected.actorId
    )
      throw new SharedBackendError('changed');
  }
  async status(): Promise<SharedBackendStatus> {
    return publicStatus(await this.read());
  }
  /** Local lifecycle metadata only. Cookies and authentication revisions stay here. */
  async hasNativeAuthentication(): Promise<boolean> {
    const row = await this.read();
    return !!(row?.origin && row.cookie && row.actorId && row.backendId);
  }
  onNativeAuthenticationChanged(listener: (kind: 'changed' | 'revoking') => void) {
    this.nativeListeners.add(listener);
    return () => {
      this.nativeListeners.delete(listener);
    };
  }
  private nativeChanged(kind: 'changed' | 'revoking') {
    for (const listener of this.nativeListeners) listener(kind);
  }
  /** Host-only callback for C's existing private outgoing protocol. Never part
   * of the status/RPC result and never exports a cookie to the renderer. */
  async nativeConnection(signal: AbortSignal) {
    const row = await this.read();
    if (!row?.origin || !row.cookie || !row.actorId || !row.backendId)
      throw new SharedBackendError('unavailable');
    await this.assertCurrent(row, signal);
    return {
      origin: row.origin,
      backendId: row.backendId,
      actorId: row.actorId,
      connectionId: row.connectionId,
      authentication: async (active: AbortSignal): Promise<HeadersInit> => {
        await this.assertCurrent(row, active);
        return { cookie: row.cookie!, origin: row.origin! };
      },
    };
  }
  async select(
    raw: SharedBackendSelection,
    lifecycle?: {
      prepare(): Promise<{ committed(): Promise<void>; failed(): void }>;
    },
  ): Promise<SharedBackendStatus> {
    const input = sharedBackendSelectionSchema.parse(raw),
      origin = input.origin === null ? null : originOf(input.origin);
    const before = await this.read();
    if (before?.requestId === input.requestId) {
      if (before.origin !== origin) throw new SharedBackendError('changed');
      return publicStatus(before);
    }
    if ((before?.connectionId ?? null) !== input.expectedConnectionId)
      throw new SharedBackendError('changed');
    // The actual native lifecycle checks synchronously, gates new admission,
    // then drains/disposes the old child before this durable selection changes.
    const transition = await lifecycle?.prepare();
    let selected: SharedBackendStatus;
    try {
      selected = publicStatus(
        await this.modify((row) => {
          if (row?.requestId === input.requestId) {
            if (row.origin !== origin) throw new SharedBackendError('changed');
            return row;
          }
          if ((row?.connectionId ?? null) !== input.expectedConnectionId)
            throw new SharedBackendError('changed');
          return {
            version: 1,
            origin,
            connectionId: randomUUID(),
            requestId: input.requestId,
            authRevision: randomUUID(),
            authAttempt: randomUUID(),
            cookie: null,
            backendId: null,
            actorId: null,
          };
        }),
      );
    } catch (error) {
      transition?.failed();
      throw error;
    }
    await transition?.committed();
    return selected;
  }
  private async json(
    response: Response,
    signal: AbortSignal,
    maxBytes = 1024 * 1024,
  ): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new SharedBackendError('unavailable');
    const parts: Uint8Array[] = [];
    let size = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) throw new SharedBackendError('unavailable');
        parts.push(next.value);
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size)),
      );
    } catch {
      throw new SharedBackendError('invalid-response');
    }
  }
  private async info(row: PrivateConnection, signal: AbortSignal) {
    if (!row.origin || !row.cookie) throw new SharedBackendError('changed');
    const info = await this.probe(row, row.cookie, signal);
    if (info && (info.backendId !== row.backendId || info.actorId !== row.actorId))
      throw new SharedBackendError('identity-changed');
    return info;
  }
  private async probe(row: PrivateConnection, cookie: string, signal: AbortSignal, auth = false) {
    await this.assertCurrent(row, signal, auth);
    const rpcId = randomUUID(),
      method = MEMBER_LOCAL_REMOTE_METHODS.info;
    const response = await this.fetcher(`${row.origin}/api/${method}`, {
      method: 'POST',
      headers: { cookie, origin: row.origin!, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method,
        payload: {
          protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
          operation: 'info',
          requestId: randomUUID(),
          payload: {},
        },
      }),
      signal,
      redirect: 'error',
      cache: 'no-store',
    });
    await this.assertCurrent(row, signal, auth);
    if (response.status === 401) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SharedBackendError('unavailable');
    }
    const envelope = z
      .strictObject({ type: z.literal('server-response'), rpcId: z.uuid(), result: z.unknown() })
      .parse(await this.json(response, signal));
    await this.assertCurrent(row, signal, auth);
    if (envelope.rpcId !== rpcId) throw new SharedBackendError('identity-changed');
    const result = remoteRunResponseSchema('info').parse(envelope.result);
    if (!result.ok) throw new SharedBackendError('unavailable');
    return remoteBackendInfoSchema.parse(result.value);
  }
  private cookie(response: Response): string | undefined {
    const values = response.headers.getSetCookie();
    const own = values.filter((value) => value.startsWith(`${MEMBER_COOKIE_NAME}=`));
    if (own.length > 1) throw new SharedBackendError('unavailable');
    if (!own.length) return undefined;
    const value = own[0]!.split(';', 1)[0]!;
    if (!/^zhuma-member=[A-Za-z0-9._-]{1,4000}$/u.test(value))
      throw new SharedBackendError('unavailable');
    return value;
  }
  request(input: SharedBackendRequest, signal: AbortSignal): Promise<SharedBackendResponse> {
    const work = this.perform(
      input,
      AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(20_000)]),
    );
    this.jobs.add(work);
    void work.finally(() => this.jobs.delete(work)).catch(() => undefined);
    return work;
  }
  private async perform(
    raw: SharedBackendRequest,
    signal: AbortSignal,
  ): Promise<SharedBackendResponse> {
    const input = sharedBackendRequestSchema.parse(raw),
      entry = descriptors[input.operation],
      payload = entry.schema.parse(input.payload);
    const requestLimit = manualOperations.has(input.operation)
      ? EXECUTION_BODY_BYTE_LIMIT
      : 1200 * 1024;
    if (Buffer.byteLength(JSON.stringify(input)) > requestLimit)
      throw new SharedBackendError('invalid');
    const rpc = entry.path.startsWith('/api/');
    if (rpc !== (input.rpcId !== undefined)) throw new SharedBackendError('invalid');
    let row = await this.read();
    signal.throwIfAborted();
    if (!row?.origin || row.connectionId !== input.connectionId)
      throw new SharedBackendError('changed');
    if (input.operation === 'identity.logout' || input.operation === 'identity.password')
      this.nativeChanged('revoking');
    if (entry.auth)
      row = await this.modify((latest) => {
        if (
          !latest ||
          latest.connectionId !== row!.connectionId ||
          latest.authRevision !== row!.authRevision
        )
          throw new SharedBackendError('changed');
        return { ...latest, authAttempt: randomUUID() };
      });
    else if (
      row.cookie &&
      input.operation !== 'identity.register' &&
      !(await this.info(row, signal))
    ) {
      this.nativeChanged('revoking');
      return {
        connectionId: row.connectionId,
        status: 401,
        body: { ok: false, error: 'unauthenticated' },
      };
    }
    await this.assertCurrent(row, signal, entry.auth);
    const url = new URL(entry.path, row.origin!);
    if (input.operation === 'identity.members.read')
      url.searchParams.set('spaceId', identityTeamMembersSchema.parse(payload).spaceId);
    const body = rpc
      ? {
          type: 'client-request',
          rpcId: input.rpcId,
          method: entry.path.slice('/api/'.length),
          payload,
        }
      : payload;
    const response = await this.fetcher(url, {
      method: entry.verb,
      headers: {
        origin: row.origin!,
        accept: 'application/json',
        ...(row.cookie ? { cookie: row.cookie } : {}),
        ...(entry.verb === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(entry.verb === 'POST' ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    await this.assertCurrent(row, signal, entry.auth);
    if (
      response.status === 401 &&
      row.cookie &&
      !entry.auth &&
      input.operation !== 'identity.register'
    )
      this.nativeChanged('revoking');
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new SharedBackendError('unavailable');
    }
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json')
      throw new SharedBackendError('invalid-response');
    const value = await this.json(
      response,
      signal,
      manualOperations.has(input.operation) ? EXECUTION_BODY_BYTE_LIMIT : undefined,
    );
    await this.assertCurrent(row, signal, entry.auth);
    if (entry.auth && response.ok) {
      const logout =
        input.operation === 'identity.logout' || input.operation === 'identity.password';
      const cookie = logout ? null : this.cookie(response);
      if (cookie === undefined) throw new SharedBackendError('unavailable');
      // New login identity is read from the original product info endpoint. It
      // is not inferred from input account fields or any owner principal.
      let backendId: string | null = null,
        actorId: string | null = null;
      if (cookie) {
        const identity = await this.probe(row, cookie, signal, true);
        if (!identity) throw new SharedBackendError('unavailable');
        const replyActor =
          input.operation === 'identity.login'
            ? z.object({ ok: z.literal(true), accountId: id }).parse(value).accountId
            : z.object({ ok: z.literal(true), value: z.object({ accountId: id }) }).parse(value)
                .value.accountId;
        if (replyActor !== identity.actorId) throw new SharedBackendError('identity-changed');
        backendId = identity.backendId;
        actorId = identity.actorId;
      }
      const expected = row;
      row = await this.modify((latest) => {
        signal.throwIfAborted();
        if (
          !latest ||
          latest.connectionId !== expected.connectionId ||
          latest.authRevision !== expected.authRevision ||
          latest.authAttempt !== expected.authAttempt
        )
          throw new SharedBackendError('changed');
        return { ...latest, cookie, backendId, actorId, authRevision: randomUUID() };
      });
      this.nativeChanged('changed');
    }
    await this.assertCurrent(row, signal, entry.auth);
    return { connectionId: row.connectionId, status: response.status, body: value };
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    this.nativeListeners.clear();
    await Promise.allSettled([...this.jobs]);
  }
}
