import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import { createExecutionApi, ExecutionError, type ExecutionApi } from './ExecutionApi.js';

/** Same-origin member Fetch routes preserve HTTP failures that SDK RPC flattens. */
export function createExecutionHttpApi(
  fetcher: typeof fetch = globalThis.fetch,
  onUnauthenticated: () => void = () => undefined,
): ExecutionApi {
  const rpc: ClientConnectionRpc = {
    async call(channel, endpoint, payload, callerSignal) {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000);
      signal.throwIfAborted();
      const rpcId = crypto.randomUUID();
      const response = await fetcher(`${channel}/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
        signal,
      });
      signal.throwIfAborted();
      if (!response.ok) {
        const code =
          response.status === 401
            ? 'unauthenticated'
            : response.status === 403
              ? 'untrusted-request'
              : 'unavailable';
        const message =
          code === 'unauthenticated'
            ? '登录已失效，请重新登录。'
            : code === 'untrusted-request'
              ? '当前入口无法处理请求，请重新打开工作台。'
              : '执行服务暂不可用，请重试。';
        throw new ExecutionError(code, message, { status: response.status });
      }
      const envelope: unknown = await response.json();
      signal.throwIfAborted();
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        !('type' in envelope) ||
        envelope.type !== 'server-response' ||
        !('rpcId' in envelope) ||
        envelope.rpcId !== rpcId ||
        !('result' in envelope)
      ) {
        throw new ExecutionError('validation', '执行服务返回的数据不完整。');
      }
      const result = envelope.result;
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true && 'value' in result) return { ok: true, value: result.value };
        if (
          result.ok === false &&
          'error' in result &&
          result.error &&
          typeof result.error === 'object' &&
          'code' in result.error &&
          typeof result.error.code === 'string' &&
          'message' in result.error &&
          typeof result.error.message === 'string' &&
          'details' in result.error &&
          result.error.details &&
          typeof result.error.details === 'object' &&
          !Array.isArray(result.error.details)
        ) {
          return {
            ok: false,
            error: {
              code: result.error.code,
              message: result.error.message,
              details: { ...result.error.details },
            },
          };
        }
      }
      throw new ExecutionError('validation', '执行服务返回的数据不完整。');
    },
  };
  const api = createExecutionApi(rpc);
  async function observed<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await request;
    } catch (error) {
      if (!signal?.aborted && error instanceof ExecutionError && error.code === 'unauthenticated')
        onUnauthenticated();
      throw error;
    }
  }
  return {
    startPlan: (draft, signal) => observed(api.startPlan(draft, signal), signal),
    inbox: (signal) => observed(api.inbox(signal), signal),
    submit: (draft, signal) => observed(api.submit(draft, signal), signal),
    ballot: (draft, signal) => observed(api.ballot(draft, signal), signal),
  };
}
