import {
  KnowledgeLibrariesRequestSchema,
  KnowledgeLibrariesValueSchema,
  KnowledgeListRequestSchema,
  KnowledgeListValueSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeSearchValueSchema,
  KnowledgeReadRequestSchema,
  KnowledgeReadValueSchema,
  KnowledgeErrorCodeSchema,
  type KnowledgeLibrariesRequest,
  type KnowledgeLibrariesValue,
  type KnowledgeListRequest,
  type KnowledgeListValue,
  type KnowledgeSearchRequest,
  type KnowledgeSearchValue,
  type KnowledgeReadRequest,
  type KnowledgeReadValue,
  type KnowledgeErrorCode,
} from '@zhuma/agent-core';

export interface KnowledgeApi {
  libraries(
    input: KnowledgeLibrariesRequest,
    signal: AbortSignal,
  ): Promise<KnowledgeLibrariesValue>;
  list(input: KnowledgeListRequest, signal: AbortSignal): Promise<KnowledgeListValue>;
  search(input: KnowledgeSearchRequest, signal: AbortSignal): Promise<KnowledgeSearchValue>;
  read(input: KnowledgeReadRequest, signal: AbortSignal): Promise<KnowledgeReadValue>;
}
export interface KnowledgeApiScope {
  readonly actorId: string;
  readonly spaceId: string;
  isCurrent(): boolean;
  onUnauthenticated(): void;
}
const messages: Record<KnowledgeErrorCode | 'invalid-response', string> = {
  invalid: '请检查知识请求内容。',
  'not-found': '该内容不存在或当前账号不可访问。',
  conflict: '该内容已更新，请重新读取。',
  unavailable: '知识服务暂不可用，请重试。',
  limit: '已超过当前知识读取范围，请缩小范围。',
  cancelled: '操作已取消。',
  unauthenticated: '登录已失效，请重新登录。',
  forbidden: '当前空间已不可访问。',
  'invalid-response': '知识返回内容与当前请求不一致，请重新读取。',
};
export class KnowledgeClientError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'KnowledgeClientError';
  }
}
const record = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);

/** Product member HTTP only. Scope hints and UI lifetimes never grant server authority. */
export function createKnowledgeApi(
  scope: KnowledgeApiScope,
  fetcher: typeof fetch = globalThis.fetch,
): KnowledgeApi {
  function current(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!scope.isCurrent()) throw new DOMException('Knowledge view changed', 'AbortError');
  }
  async function call<T extends { actorId: string; spaceId: string }>(
    endpoint: string,
    payload: { spaceId: string },
    schema: { parse(raw: unknown): T },
    signal: AbortSignal,
  ): Promise<T> {
    current(signal);
    if (payload.spaceId !== scope.spaceId) throw new KnowledgeClientError('forbidden');
    const rpcId = crypto.randomUUID();
    try {
      const response = await fetcher(`/api/zhuma-knowledge/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: `zhuma-knowledge/${endpoint}`,
          payload,
        }),
        signal,
      });
      current(signal);
      if (response.status === 401) {
        scope.onUnauthenticated();
        throw new KnowledgeClientError('unauthenticated');
      }
      const envelope: unknown = await response.json();
      current(signal);
      if (
        !record(envelope) ||
        envelope.type !== 'server-response' ||
        envelope.rpcId !== rpcId ||
        !record(envelope.result)
      )
        throw new KnowledgeClientError('invalid-response');
      if (envelope.result.ok !== true) {
        const error = envelope.result.error;
        const code = KnowledgeErrorCodeSchema.safeParse(record(error) ? error.code : undefined);
        throw new KnowledgeClientError(code.success ? code.data : 'unavailable');
      }
      if (!response.ok) throw new KnowledgeClientError('invalid-response');
      const value = schema.parse(envelope.result.value);
      if (value.actorId !== scope.actorId || value.spaceId !== scope.spaceId)
        throw new KnowledgeClientError('invalid-response');
      return value;
    } catch (error) {
      current(signal);
      throw error instanceof KnowledgeClientError
        ? error
        : new KnowledgeClientError('invalid-response');
    }
  }
  return {
    libraries: (input, signal) =>
      call(
        'libraries',
        KnowledgeLibrariesRequestSchema.parse(input),
        KnowledgeLibrariesValueSchema,
        signal,
      ),
    async list(input, signal) {
      const request = KnowledgeListRequestSchema.parse(input);
      const value = await call('list', request, KnowledgeListValueSchema, signal);
      if (value.libraryId !== request.libraryId) throw new KnowledgeClientError('invalid-response');
      return value;
    },
    async search(input, signal) {
      const request = KnowledgeSearchRequestSchema.parse(input);
      const value = await call('search', request, KnowledgeSearchValueSchema, signal);
      if (
        value.query !== request.query ||
        JSON.stringify(value.libraryIds) !== JSON.stringify(request.libraryIds)
      )
        throw new KnowledgeClientError('invalid-response');
      return value;
    },
    async read(input, signal) {
      const request = KnowledgeReadRequestSchema.parse(input);
      const value = await call('read', request, KnowledgeReadValueSchema, signal);
      const ref = value.reference;
      if (
        ref.spaceId !== request.spaceId ||
        ref.libraryId !== request.libraryId ||
        ref.pageId !== request.pageId ||
        ref.version !== request.version ||
        (request.checksum !== undefined && request.checksum !== ref.checksum) ||
        value.part !== request.part
      )
        throw new KnowledgeClientError('invalid-response');
      return value;
    },
  };
}
