export interface RegistrationInput {
  readonly requestId: string;
  readonly accountId: string;
  readonly password: string;
}
export type RegisterAccount = (
  input: RegistrationInput,
  signal: AbortSignal,
) => Promise<{ accountId: string; personalSpaceId: string; disposition: 'created' | 'replayed' }>;
export interface MemberTeam {
  readonly id: string;
  readonly name: string;
  readonly role: 'administrator' | 'member';
}
export interface TeamMembers {
  readonly spaceId: string;
  readonly administratorId: string | null;
  readonly accountIds: readonly string[];
}
const messages: Readonly<Record<string, string>> = {
  validation: '请检查账号、密码和输入内容。',
  conflict: '该账号或操作已存在；如果刚刚注册，请尝试登录。',
  'recovery-required': '上次操作尚未完成，请使用相同内容重试或联系管理员。',
  'quota-exceeded': '当前数量已达到上限。',
  'untrusted-request': '当前入口不可信，请从工作台重新打开。',
  unauthenticated: '登录已失效，请重新登录。',
  'not-found': '该账号或团队不可访问，请刷新。',
  forbidden: '没有权限执行此操作。',
  'invalid-login': '当前密码不正确，请重试。',
  'rate-limited': '操作过于频繁，请稍后重试。',
  unavailable: '服务暂不可用；操作结果未确认，请重新连接后检查。',
};
export class IdentityLifecycleError extends Error {
  constructor(readonly code: string) {
    super(messages[code] ?? messages.unavailable);
    this.name = 'IdentityLifecycleError';
  }
}
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !keys.includes(key))
  )
    throw new IdentityLifecycleError('unavailable');
  return raw as Record<string, unknown>;
}
function id(raw: unknown, max = 100): string {
  if (typeof raw !== 'string' || raw.length > max || !/^[\w-]+$/u.test(raw))
    throw new IdentityLifecycleError('unavailable');
  return raw;
}
function disposition(raw: unknown): 'created' | 'replayed' {
  if (raw !== 'created' && raw !== 'replayed') throw new IdentityLifecycleError('unavailable');
  return raw;
}
export function createIdentityLifecycleApi(fetcher: typeof fetch = globalThis.fetch) {
  async function call<T>(
    path: string,
    method: 'GET' | 'POST',
    input: unknown,
    signal: AbortSignal,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    signal.throwIfAborted();
    try {
      const response = await fetcher('/zhuma-id/' + path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: input === undefined ? {} : { 'content-type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal,
      });
      const envelope = object(await response.json(), ['ok', 'value', 'error']);
      if (!response.ok || envelope.ok !== true)
        throw new IdentityLifecycleError(
          typeof envelope.error === 'string' ? envelope.error : 'unavailable',
        );
      return parse(envelope.value);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof IdentityLifecycleError
        ? error
        : new IdentityLifecycleError('unavailable');
    }
  }
  const register: RegisterAccount = (input, signal) =>
    call(
      'register',
      'POST',
      { requestId: input.requestId, accountId: input.accountId, password: input.password },
      signal,
      (raw) => {
        const value = object(raw, ['accountId', 'personalSpaceId', 'disposition']);
        const accountId = id(value.accountId, 64);
        if (accountId !== input.accountId) throw new IdentityLifecycleError('unavailable');
        return {
          accountId,
          personalSpaceId: id(value.personalSpaceId),
          disposition: disposition(value.disposition),
        };
      },
    );
  return {
    register,
    teams: (signal: AbortSignal) =>
      call('teams', 'GET', undefined, signal, (raw) => {
        const value = object(raw, ['accountId', 'teams']);
        if (!Array.isArray(value.teams)) throw new IdentityLifecycleError('unavailable');
        const teams: MemberTeam[] = value.teams.map((raw) => {
          const row = object(raw, ['id', 'name', 'role']);
          if (
            typeof row.name !== 'string' ||
            !row.name.trim() ||
            (row.role !== 'administrator' && row.role !== 'member')
          )
            throw new IdentityLifecycleError('unavailable');
          return { id: id(row.id), name: row.name, role: row.role };
        });
        if (new Set(teams.map((team) => team.id)).size !== teams.length)
          throw new IdentityLifecycleError('unavailable');
        return { accountId: id(value.accountId, 64), teams };
      }),
    createTeam: (input: { requestId: string; name: string }, signal: AbortSignal) =>
      call('teams', 'POST', { requestId: input.requestId, name: input.name }, signal, (raw) => {
        const value = object(raw, ['spaceId', 'disposition']);
        return { spaceId: id(value.spaceId), disposition: disposition(value.disposition) };
      }),
    members: (spaceId: string, signal: AbortSignal) =>
      call(
        'team-members?' + new URLSearchParams({ spaceId }),
        'GET',
        undefined,
        signal,
        (raw): TeamMembers => {
          const value = object(raw, ['spaceId', 'administratorId', 'accountIds']);
          if (value.spaceId !== spaceId || !Array.isArray(value.accountIds))
            throw new IdentityLifecycleError('unavailable');
          const accountIds = value.accountIds.map((value) => id(value, 64));
          if (new Set(accountIds).size !== accountIds.length)
            throw new IdentityLifecycleError('unavailable');
          return {
            spaceId,
            administratorId: value.administratorId === null ? null : id(value.administratorId, 64),
            accountIds,
          };
        },
      ),
    setMember: (
      input: { requestId: string; spaceId: string; accountId: string; action: 'add' | 'remove' },
      signal: AbortSignal,
    ) =>
      call(
        'team-members',
        'POST',
        {
          requestId: input.requestId,
          spaceId: input.spaceId,
          accountId: input.accountId,
          action: input.action,
        },
        signal,
        (raw) => {
          const value = object(raw, ['spaceId', 'accountId', 'disposition']);
          if (
            value.spaceId !== input.spaceId ||
            value.accountId !== input.accountId ||
            (value.disposition !== 'applied' && value.disposition !== 'replayed')
          )
            throw new IdentityLifecycleError('unavailable');
          return {
            spaceId: input.spaceId,
            accountId: input.accountId,
            disposition: value.disposition,
          };
        },
      ),
    changePassword: (input: { oldPassword: string; newPassword: string }, signal: AbortSignal) =>
      call(
        'password',
        'POST',
        { oldPassword: input.oldPassword, newPassword: input.newPassword },
        signal,
        (raw) => {
          if (object(raw, ['reauthenticate']).reauthenticate !== true)
            throw new IdentityLifecycleError('unavailable');
          return { reauthenticate: true as const };
        },
      ),
  };
}
