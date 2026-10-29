import type { SharedBackendClient } from '../identity/shared-backend.js';
import { ExecutionError } from '../execution/ExecutionApi.js';

const endpoints = new Set([
  'options',
  'begin',
  'read',
  'history',
  'inbox',
  'observe',
  'send',
  'stop',
  'review-options',
  'review-start',
  'review-read',
  'review-stop',
  'review-session',
  'review-recover',
  'review-session-stop',
  'workflow-options',
  'workflow-read',
  'workflow-start',
  'workflow-resume',
  'workflow-stop',
]);
/** Local transport selection only. Original remote identity/business calls use
 * their fixed proxy; native calls stay on this device's SDK owner HTTP. */
export function createMemberNativeClient(
  backend: SharedBackendClient,
  localFetch: typeof fetch = globalThis.fetch,
) {
  function scoped(actorId: string, spaceId: string, historicalRunId?: string) {
    const chosen = backend.getSnapshot().selection;
    const current = () => {
      const now = backend.getSnapshot();
      if (now.phase !== 'ready' || !chosen || now.selection?.connectionId !== chosen.connectionId)
        throw new DOMException('Backend changed', 'AbortError');
    };
    async function invoke(
      endpoint: string,
      query: unknown,
      rpcId: string,
      signal?: AbortSignal | null,
    ) {
      current();
      signal?.throwIfAborted();
      const response = await localFetch(`/api/zhuma-member-native/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: `zhuma-member-native/${endpoint}`,
          payload: { connectionId: chosen!.connectionId, actorId, spaceId, query },
        }),
      });
      try {
        current();
        signal?.throwIfAborted();
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      return response;
    }
    return {
      fetcher: (async (input, init) => {
        if (
          typeof input !== 'string' ||
          (!input.startsWith('/api/zhuma-run/') &&
            !input.startsWith('/api/zhuma-review/') &&
            !input.startsWith('/api/zhuma-workflow/'))
        )
          return backend.fetcher(input, init);
        current();
        const review = input.startsWith('/api/zhuma-review/');
        const workflow = input.startsWith('/api/zhuma-workflow/');
        const prefix = review ? 'review' : workflow ? 'workflow' : 'run';
        const name = input.slice(`/api/zhuma-${prefix}/`.length);
        const endpoint = prefix === 'run' ? name : `${prefix}-${name}`;
        if (!endpoints.has(endpoint) || init?.method !== 'POST' || typeof init.body !== 'string')
          throw new TypeError('Unsupported native request');
        const wire: unknown = JSON.parse(init.body);
        if (
          !wire ||
          typeof wire !== 'object' ||
          Array.isArray(wire) ||
          Object.keys(wire).length !== 4 ||
          !('type' in wire) ||
          wire.type !== 'client-request' ||
          !('method' in wire) ||
          wire.method !== `zhuma-${prefix}/${name}` ||
          !('rpcId' in wire) ||
          typeof wire.rpcId !== 'string' ||
          !('payload' in wire)
        )
          throw new TypeError('Invalid native request');
        const query =
          endpoint === 'options' &&
          historicalRunId &&
          wire.payload &&
          typeof wire.payload === 'object' &&
          !Array.isArray(wire.payload)
            ? { ...wire.payload, runId: historicalRunId }
            : wire.payload;
        if (!chosen?.origin)
          return backend.fetcher(input, {
            ...init,
            body: JSON.stringify({ ...wire, payload: query }),
          });
        return invoke(endpoint, query, wire.rpcId, init.signal);
      }) as typeof fetch,
      async lookup(sessionId: string, signal: AbortSignal) {
        const rpcId = crypto.randomUUID();
        const response = await invoke('lookup', { sessionId }, rpcId, signal);
        if (!response.ok)
          throw new ExecutionError('unavailable', '工作会话暂不可用，请重新连接后重试。');
        const wire: unknown = await response.json();
        current();
        signal.throwIfAborted();
        if (
          !wire ||
          typeof wire !== 'object' ||
          !('type' in wire) ||
          wire.type !== 'server-response' ||
          !('rpcId' in wire) ||
          wire.rpcId !== rpcId ||
          !('result' in wire)
        )
          throw new ExecutionError('validation', '会话定位未通过校验。');
        const result = wire.result;
        if (
          !result ||
          typeof result !== 'object' ||
          !('ok' in result) ||
          result.ok !== true ||
          !('value' in result)
        )
          throw new ExecutionError('unavailable', '工作会话暂不可用，请刷新。');
        return result.value;
      },
    };
  }
  return { scoped };
}
export type MemberNativeClient = ReturnType<typeof createMemberNativeClient>;
