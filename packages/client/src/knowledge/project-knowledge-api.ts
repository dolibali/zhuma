import {
  canonicalPayload,
  KnowledgeProjectLinksRequestSchema,
  KnowledgeProjectLinksValueSchema,
  KnowledgeSaveProjectLinksRequestSchema,
  KnowledgeProjectLinksWriteValueSchema,
  KnowledgeErrorCodeSchema,
  type KnowledgeProjectLinksRequest,
  type KnowledgeProjectLinksValue,
  type KnowledgeSaveProjectLinksRequest,
  type KnowledgeProjectLinksWriteValue,
} from '@zhuma/agent-core';
import {
  createKnowledgeApi,
  KnowledgeClientError,
  type KnowledgeApi,
  type KnowledgeApiScope,
} from './api.js';

export interface ProjectKnowledgeApi extends Pick<KnowledgeApi, 'libraries' | 'list' | 'read'> {
  projectLinks(
    input: KnowledgeProjectLinksRequest,
    signal: AbortSignal,
  ): Promise<KnowledgeProjectLinksValue>;
  saveProjectLinks(
    input: KnowledgeSaveProjectLinksRequest,
    signal: AbortSignal,
  ): Promise<KnowledgeProjectLinksWriteValue>;
}
export interface ProjectKnowledgePanelProps {
  readonly scope: {
    readonly actorId: string;
    readonly spaceId: string;
    readonly projectId: string;
  };
  readonly api: ProjectKnowledgeApi;
  isCurrent(): boolean;
  onDirtyChange(dirty: boolean): void;
}
const record = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);

/** Fixed member operations only. Scope checks are presentation fences, not grants. */
export function createProjectKnowledgeApi(
  scope: KnowledgeApiScope,
  fetcher: typeof fetch = globalThis.fetch,
): ProjectKnowledgeApi {
  const knowledge = createKnowledgeApi(scope, fetcher);
  function current(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!scope.isCurrent()) throw new DOMException('Project knowledge changed', 'AbortError');
  }
  async function call<T extends { actorId: string; spaceId: string; projectId: string }>(
    endpoint: 'project-links' | 'save-project-links',
    query: KnowledgeProjectLinksRequest | KnowledgeSaveProjectLinksRequest,
    schema: { parse(value: unknown): T },
    signal: AbortSignal,
  ): Promise<T> {
    current(signal);
    if (query.spaceId !== scope.spaceId) throw new KnowledgeClientError('forbidden');
    const rpcId = crypto.randomUUID();
    try {
      let response: Response;
      try {
        response = await fetcher(`/api/zhuma-knowledge/${endpoint}`, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method: `zhuma-knowledge/${endpoint}`,
            payload: query,
          }),
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
      if (
        value.actorId !== scope.actorId ||
        value.spaceId !== scope.spaceId ||
        value.projectId !== query.projectId
      )
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
    libraries: knowledge.libraries,
    list: knowledge.list,
    read: knowledge.read,
    async projectLinks(input, signal) {
      const parsed = KnowledgeProjectLinksRequestSchema.safeParse(input);
      if (!parsed.success) throw new KnowledgeClientError('invalid');
      const value = await call(
        'project-links',
        parsed.data,
        KnowledgeProjectLinksValueSchema,
        signal,
      );
      if (
        value.snapshot.spaceId !== value.spaceId ||
        value.snapshot.projectId !== value.projectId ||
        value.snapshot.relationshipVersion !== value.relationshipVersion ||
        canonicalPayload(value.snapshot.links) !==
          canonicalPayload(value.links.map(({ reference, required }) => ({ reference, required })))
      )
        throw new KnowledgeClientError('invalid-response');
      return value;
    },
    async saveProjectLinks(input, signal) {
      const parsed = KnowledgeSaveProjectLinksRequestSchema.safeParse(input);
      if (!parsed.success) throw new KnowledgeClientError('invalid');
      return call('save-project-links', parsed.data, KnowledgeProjectLinksWriteValueSchema, signal);
    },
  };
}
