export interface LoginCredentials {
  readonly accountId: string;
  readonly password: string;
}

/** Directory facts returned by the member session, never inferred from project contents. */
export interface MemberSpace {
  readonly id: string;
  readonly kind: 'personal' | 'team';
  readonly name: string;
}

export interface MemberSession {
  readonly accountId: string;
  readonly principal: { readonly kind: 'zhuma-member'; readonly memberId: string };
  readonly peerId: string;
  readonly spaces: readonly MemberSpace[];
}

export interface IdentityApi {
  login(credentials: LoginCredentials, signal?: AbortSignal): Promise<{ accountId: string }>;
  session(signal?: AbortSignal): Promise<MemberSession>;
  logout(signal?: AbortSignal): Promise<{ accountId: string }>;
}

const failureMessages = {
  unauthenticated: '登录已失效，请重新登录。',
  'invalid-login': '账号或密码不正确，请重新输入。',
  'login-rate-limited': '尝试次数过多，请稍后重试。',
  unavailable: '暂时无法连接登录服务，请重试。',
  'untrusted-request': '当前入口无法登录，请从工作台入口重新打开。',
  'invalid-response': '登录服务返回的数据不完整，请重试。',
  'member-session-required': '请使用成员账号登录。',
  'session-changed': '账号已发生变化，请重新登录。',
  'request-rejected': '登录请求未被接受，请重新输入。',
  'space-unavailable': '此空间已不可访问，请选择其他空间。',
} as const;
export type IdentityFailure = keyof typeof failureMessages;

/** Only fixed public messages reach the UI; response bodies may contain private details. */
export class IdentityApiError extends Error {
  constructor(readonly code: IdentityFailure) {
    super(failureMessages[code]);
    this.name = 'IdentityApiError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function accountReply(value: unknown): { accountId: string } {
  if (!record(value) || value.ok !== true || !text(value.accountId))
    throw new IdentityApiError('invalid-response');
  return { accountId: value.accountId };
}

/** Narrow the server reply; no cookie, verifier, actor override or space inference is exposed. */
function sessionReply(value: unknown): MemberSession {
  const { accountId } = accountReply(value);
  if (!record(value) || !record(value.principal)) throw new IdentityApiError('invalid-response');
  if (value.principal.kind === 'owner') throw new IdentityApiError('member-session-required');
  if (
    value.principal.kind !== 'zhuma-member' ||
    value.principal.memberId !== accountId ||
    !text(value.peerId)
  )
    throw new IdentityApiError('invalid-response');
  if (!Array.isArray(value.spaces)) throw new IdentityApiError('invalid-response');
  const ids = new Set<string>();
  const spaces = value.spaces.map((space: unknown): MemberSpace => {
    if (
      !record(space) ||
      !text(space.id) ||
      !text(space.name) ||
      (space.kind !== 'personal' && space.kind !== 'team') ||
      ids.has(space.id)
    )
      throw new IdentityApiError('invalid-response');
    ids.add(space.id);
    return Object.freeze({ id: space.id, kind: space.kind, name: space.name });
  });
  return Object.freeze({
    accountId,
    principal: Object.freeze({ kind: 'zhuma-member', memberId: accountId }),
    peerId: value.peerId,
    spaces: Object.freeze(spaces),
  });
}

/** Same-origin member HTTP routes, separate from the owner RPC transport. */
export function createIdentityApi(fetcher: typeof fetch = globalThis.fetch): IdentityApi {
  async function call(
    endpoint: 'login' | 'session' | 'logout',
    payload?: LoginCredentials | Record<string, never>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetcher(`/zhuma-id/${endpoint}`, {
        method: payload === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        if (response.status === 401)
          throw new IdentityApiError(endpoint === 'login' ? 'invalid-login' : 'unauthenticated');
        if (response.status === 429) throw new IdentityApiError('login-rate-limited');
        if (response.status === 403) throw new IdentityApiError('untrusted-request');
        throw new IdentityApiError(
          response.status >= 500 || response.status === 404 ? 'unavailable' : 'request-rejected',
        );
      }
      try {
        return await response.json();
      } catch {
        throw new IdentityApiError('invalid-response');
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof IdentityApiError) throw error;
      throw new IdentityApiError('unavailable');
    }
  }
  return {
    async login(credentials, signal) {
      // Pick fields explicitly: JS callers cannot smuggle an actor or member id into the body.
      return accountReply(
        await call(
          'login',
          { accountId: credentials.accountId, password: credentials.password },
          signal,
        ),
      );
    },
    async session(signal) {
      return sessionReply(await call('session', undefined, signal));
    },
    async logout(signal) {
      return accountReply(await call('logout', {}, signal));
    },
  };
}
