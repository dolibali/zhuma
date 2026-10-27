import type { MemberSpace } from './api.js';
export interface LocalSetupPack {
  readonly id: string;
  readonly version: '1.0.0';
  readonly name: string;
  readonly role: string;
}
export type LocalSetupSnapshot =
  | {
      readonly kind: 'unconfigured' | 'recovery-required';
      readonly packs: readonly LocalSetupPack[];
    }
  | {
      readonly kind: 'configured';
      readonly packs: readonly LocalSetupPack[];
      readonly createdTeam?: MemberSpace;
    }
  | {
      readonly kind: 'pending';
      readonly requestId: string;
      readonly packs: readonly LocalSetupPack[];
    };
export interface LocalSetupInput {
  readonly requestId: string;
  readonly accountId: string;
  readonly password: string;
  readonly teamName: string;
  readonly packIds: readonly string[];
}
export interface LocalSetupApi {
  status(signal: AbortSignal): Promise<LocalSetupSnapshot>;
  initialize(input: LocalSetupInput, signal: AbortSignal): Promise<LocalSetupSnapshot>;
}
const messages = {
  'untrusted-request': '请在本机 Zhuma 的首次设置入口操作。',
  'invalid-input': '请检查账号、密码、团队名称和专家选择。',
  conflict: '本次填写与先前设置不同，请使用首次填写的内容继续。',
  'recovery-required': '现有初始化记录需要核实，请保留数据并联系管理员。',
  unavailable: '暂时无法完成设置，请检查连接后重试。',
  'invalid-response': '设置服务返回不完整，请重新检查状态。',
  'body-too-large': '设置内容过长，请缩短后重试。',
  'body-timeout': '提交超时，请重新检查状态后继续。',
} as const;
export class LocalSetupApiError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'LocalSetupApiError';
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function snapshot(raw: unknown): LocalSetupSnapshot {
  if (
    !record(raw) ||
    (raw.kind !== 'unconfigured' &&
      raw.kind !== 'pending' &&
      raw.kind !== 'configured' &&
      raw.kind !== 'recovery-required') ||
    !Array.isArray(raw.packs) ||
    raw.packs.length > 4 ||
    (raw.kind === 'pending' &&
      (typeof raw.requestId !== 'string' || !/^[\w-]{1,100}$/u.test(raw.requestId)))
  )
    throw new LocalSetupApiError('invalid-response');
  const seen = new Set<string>();
  const packs = raw.packs.map((pack: unknown): LocalSetupPack => {
    if (
      !record(pack) ||
      typeof pack.id !== 'string' ||
      !/^zhuma-[\w-]{1,80}$/u.test(pack.id) ||
      seen.has(pack.id) ||
      pack.version !== '1.0.0' ||
      typeof pack.name !== 'string' ||
      !pack.name ||
      pack.name.length > 160 ||
      typeof pack.role !== 'string' ||
      pack.role.length > 1000
    )
      throw new LocalSetupApiError('invalid-response');
    seen.add(pack.id);
    return Object.freeze({ id: pack.id, version: pack.version, name: pack.name, role: pack.role });
  });
  let createdTeam: MemberSpace | undefined;
  if (raw.createdTeam !== undefined) {
    const team = raw.createdTeam;
    if (
      raw.kind !== 'configured' ||
      !record(team) ||
      typeof team.id !== 'string' ||
      !/^[\w-]{1,100}$/u.test(team.id) ||
      team.kind !== 'team' ||
      typeof team.name !== 'string' ||
      !team.name ||
      team.name.length > 160
    )
      throw new LocalSetupApiError('invalid-response');
    createdTeam = Object.freeze({ id: team.id, kind: 'team', name: team.name });
  }
  return Object.freeze({
    kind: raw.kind,
    ...(raw.kind === 'pending' ? { requestId: raw.requestId } : {}),
    ...(createdTeam ? { createdTeam } : {}),
    packs: Object.freeze(packs),
  }) as LocalSetupSnapshot;
}
/** Same-origin SDK owner transport; no product member, actor override or verifier in this API. */
export function createLocalSetupApi(fetcher: typeof fetch = globalThis.fetch): LocalSetupApi {
  async function call(
    endpoint: 'status' | 'initialize',
    signal: AbortSignal,
    input?: LocalSetupInput,
  ) {
    try {
      signal.throwIfAborted();
      const response = await fetcher(`/api/zhuma-local-setup/${endpoint}`, {
        method: endpoint === 'status' ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: {
          accept: 'application/json',
          ...(input ? { 'content-type': 'application/json' } : {}),
        },
        ...(input
          ? {
              body: JSON.stringify({
                requestId: input.requestId,
                accountId: input.accountId,
                password: input.password,
                teamName: input.teamName,
                packIds: input.packIds,
              }),
            }
          : {}),
      });
      signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalSetupApiError('untrusted-request');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new LocalSetupApiError(response.ok ? 'invalid-response' : 'unavailable');
      }
      signal.throwIfAborted();
      if (!response.ok) {
        const code = record(body) && record(body.error) ? body.error.code : undefined;
        throw new LocalSetupApiError(
          typeof code === 'string' && Object.hasOwn(messages, code)
            ? (code as keyof typeof messages)
            : 'unavailable',
        );
      }
      if (!record(body) || body.version !== 1 || body.ok !== true)
        throw new LocalSetupApiError('invalid-response');
      return snapshot(body.value);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof LocalSetupApiError) throw error;
      throw new LocalSetupApiError('unavailable');
    }
  }
  return {
    status: (signal) => call('status', signal),
    initialize: (input, signal) => call('initialize', signal, input),
  };
}
