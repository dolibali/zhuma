import {
  KnowledgeLibrariesRequestSchema,
  KnowledgeLibrariesValueSchema,
  KnowledgeListRequestSchema,
  KnowledgeListValueSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeSearchValueSchema,
  KnowledgeReadRequestSchema,
  KnowledgeReadValueSchema,
  KnowledgeDraftsRequestSchema,
  KnowledgeDraftsValueSchema,
  KnowledgeDraftRequestSchema,
  KnowledgeDraftValueSchema,
  KnowledgeSaveDraftRequestSchema,
  KnowledgePublishRequestSchema,
  KnowledgeWriteValueSchema,
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
  type KnowledgeDraftsRequest,
  type KnowledgeDraftsValue,
  type KnowledgeDraftRequest,
  type KnowledgeDraftValue,
  type KnowledgeSaveDraftRequest,
  type KnowledgePublishRequest,
  type KnowledgeWriteValue,
} from '@zhuma/agent-core';

export interface KnowledgeApi {
  libraries(
    input: KnowledgeLibrariesRequest,
    signal: AbortSignal,
  ): Promise<KnowledgeLibrariesValue>;
  list(input: KnowledgeListRequest, signal: AbortSignal): Promise<KnowledgeListValue>;
  search(input: KnowledgeSearchRequest, signal: AbortSignal): Promise<KnowledgeSearchValue>;
  read(input: KnowledgeReadRequest, signal: AbortSignal): Promise<KnowledgeReadValue>;
  drafts(input: KnowledgeDraftsRequest, signal: AbortSignal): Promise<KnowledgeDraftsValue>;
  draft(input: KnowledgeDraftRequest, signal: AbortSignal): Promise<KnowledgeDraftValue>;
  saveDraft(input: KnowledgeSaveDraftRequest, signal: AbortSignal): Promise<KnowledgeWriteValue>;
  publish(input: KnowledgePublishRequest, signal: AbortSignal): Promise<KnowledgeWriteValue>;
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
      let response: Response;
      try {
        response = await fetcher(`/api/zhuma-knowledge/${endpoint}`, {
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
      } catch {
        current(signal);
        throw new KnowledgeClientError('unavailable');
      }
      current(signal);
      if (response.status === 401) {
        scope.onUnauthenticated();
        throw new KnowledgeClientError('unauthenticated');
      }
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch (error) {
        current(signal);
        throw new KnowledgeClientError(
          error instanceof SyntaxError ? 'invalid-response' : 'unavailable',
        );
      }
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
    async drafts(input, signal) {
      const request = KnowledgeDraftsRequestSchema.parse(input);
      const value = await call('drafts', request, KnowledgeDraftsValueSchema, signal);
      if (
        value.libraryId !== request.libraryId ||
        value.pages.some(
          (page) =>
            page.spaceId !== scope.spaceId ||
            page.libraryId !== request.libraryId ||
            page.ownerActorId !== scope.actorId,
        )
      )
        throw new KnowledgeClientError('invalid-response');
      return value;
    },
    async draft(input, signal) {
      const request = KnowledgeDraftRequestSchema.parse(input);
      const value = await call('draft', request, KnowledgeDraftValueSchema, signal);
      if (
        value.libraryId !== request.libraryId ||
        value.pageId !== request.pageId ||
        (value.published &&
          (value.published.spaceId !== request.spaceId ||
            value.published.libraryId !== request.libraryId ||
            value.published.pageId !== request.pageId))
      )
        throw new KnowledgeClientError('invalid-response');
      return value;
    },
    async saveDraft(input, signal) {
      const request = KnowledgeSaveDraftRequestSchema.parse(input);
      const value = await call('save-draft', request, KnowledgeWriteValueSchema, signal);
      if (
        value.libraryId !== request.libraryId ||
        value.pageId !== request.pageId ||
        value.operation !== 'save-draft'
      )
        throw new KnowledgeClientError('invalid-response');
      return value;
    },
    async publish(input, signal) {
      const request = KnowledgePublishRequestSchema.parse(input);
      const value = await call('publish', request, KnowledgeWriteValueSchema, signal);
      const ref = value.reference;
      if (
        value.libraryId !== request.libraryId ||
        value.pageId !== request.pageId ||
        value.operation !== 'publish' ||
        !ref ||
        ref.spaceId !== request.spaceId ||
        ref.libraryId !== request.libraryId ||
        ref.pageId !== request.pageId
      )
        throw new KnowledgeClientError('invalid-response');
      return value;
    },
  };
}
