import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import { createIdentityApi, IdentityApiError, type MemberSession } from '../identity/api.js';
import { createExecutionApi, ExecutionError, type ExecutionApi } from './ExecutionApi.js';
import { createExecutionFilesApi, FILE_LIMITS } from './files.js';

export interface MemberExecutionScope {
  readonly spaceId: string;
  onUnavailable(): void;
  /** Optional view-generation fence. It grants no server permissions. */
  isCurrent?(): boolean;
}

/** Same-origin member Fetch routes preserve HTTP failures that SDK RPC flattens. */
export function createExecutionHttpApi(
  fetcher: typeof fetch = globalThis.fetch,
  onUnauthenticated: () => void = () => undefined,
  expectedActorId?: string,
  scope?: MemberExecutionScope,
): ExecutionApi {
  if (scope && !expectedActorId)
    throw new ExecutionError('validation', '成员空间必须绑定当前账号。');
  const identity = createIdentityApi(fetcher);
  function requireCurrent(signal: AbortSignal) {
    signal.throwIfAborted();
    if (scope?.isCurrent?.() === false) throw new DOMException('Space view changed', 'AbortError');
  }
  type Inspection = {
    promise: Promise<MemberSession>;
    abort: AbortController;
    consumers: Set<object>;
  };
  // Share only an in-flight read within this API instance, never a positive authorization cache.
  let inspection: Inspection | undefined;
  async function inspect(signal: AbortSignal): Promise<MemberSession> {
    signal.throwIfAborted();
    if (!inspection) {
      const abort = new AbortController();
      const entry: Inspection = {
        promise: identity.session(abort.signal),
        abort,
        consumers: new Set(),
      };
      entry.promise = entry.promise.finally(() => {
        if (inspection === entry) inspection = undefined;
      });
      inspection = entry;
    }
    const entry = inspection;
    const consumer = {};
    entry.consumers.add(consumer);
    let aborted: (() => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
    });
    try {
      signal.throwIfAborted();
      return await Promise.race([entry.promise, cancellation]);
    } finally {
      if (aborted) signal.removeEventListener('abort', aborted);
      entry.consumers.delete(consumer);
      if (!entry.consumers.size) {
        if (inspection === entry) inspection = undefined;
        entry.abort.abort();
      }
    }
  }
  async function verifySpace(signal: AbortSignal, callerSignal?: AbortSignal) {
    if (!scope) return;
    try {
      const session = await inspect(signal);
      signal.throwIfAborted();
      if (expectedActorId !== undefined && session.accountId !== expectedActorId)
        throw new ExecutionError('unauthenticated', '账号已发生变化，请重新登录。');
      if (!session.spaces.some(({ id }) => id === scope.spaceId))
        throw new ExecutionError('space-unavailable', '此空间已不可访问，请重新选择。');
    } catch (error) {
      if (scope?.isCurrent?.() === false)
        throw new DOMException('Space view changed', 'AbortError');
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (error instanceof ExecutionError) throw error;
      if (
        error instanceof IdentityApiError &&
        ['unauthenticated', 'member-session-required', 'session-changed'].includes(error.code)
      )
        throw new ExecutionError('unauthenticated', '登录已失效，请重新登录。');
      throw new ExecutionError('scope-unavailable', '暂时无法确认空间权限，请重新连接。');
    }
  }
  const rpc: ClientConnectionRpc = {
    async call(channel, endpoint, payload, callerSignal) {
      const fileSubmit =
        endpoint === 'zhuma-exec/submit' &&
        payload &&
        typeof payload === 'object' &&
        'files' in payload &&
        Array.isArray(payload.files) &&
        payload.files.length > 0;
      const timeout = fileSubmit ? FILE_LIMITS.operationMs : 10_000;
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout);
      requireCurrent(signal);
      if (scope) await verifySpace(signal, callerSignal);
      requireCurrent(signal);
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
      requireCurrent(signal);
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
      requireCurrent(signal);
      if (endpoint === 'zhuma-exec/project-artifacts' || endpoint === 'zhuma-exec/task-progress') {
        await verifySpace(signal, callerSignal);
        requireCurrent(signal);
      }
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
  const api = createExecutionApi(rpc, scope?.spaceId);
  const projectArtifacts = api.projectArtifacts;
  const taskProgress = api.taskProgress;
  async function observed<T>(
    request: Promise<T>,
    signal?: AbortSignal,
    closeOnFailure = false,
  ): Promise<T> {
    try {
      return await request;
    } catch (error) {
      if (scope?.isCurrent?.() === false)
        throw new DOMException('Space view changed', 'AbortError');
      if (!signal?.aborted && error instanceof ExecutionError && error.code === 'unauthenticated')
        onUnauthenticated();
      else if (
        !signal?.aborted &&
        (closeOnFailure ||
          (error instanceof ExecutionError &&
            ['scope-mismatch', 'space-unavailable', 'scope-unavailable'].includes(error.code)))
      )
        scope?.onUnavailable();
      throw error;
    }
  }
  function memberRead<T extends { readonly actorId: string }>(
    request: Promise<T>,
    signal?: AbortSignal,
    closeOnFailure = true,
  ): Promise<T> {
    return observed(
      request.then((value) => {
        signal?.throwIfAborted();
        if (expectedActorId !== undefined && value.actorId !== expectedActorId) {
          throw new ExecutionError('unauthenticated', '账号已发生变化，请重新登录。');
        }
        return value;
      }),
      signal,
      closeOnFailure,
    );
  }
  return {
    ...(taskProgress
      ? {
          taskProgress: {
            read: (
              query: Parameters<NonNullable<ExecutionApi['taskProgress']>['read']>[0],
              signal: AbortSignal,
            ) => memberRead(taskProgress.read(query, signal), signal, false),
          },
        }
      : {}),
    ...(projectArtifacts
      ? {
          projectArtifacts: {
            list: (
              query: Parameters<NonNullable<ExecutionApi['projectArtifacts']>['list']>[0],
              signal: AbortSignal,
            ) => observed(projectArtifacts.list(query, signal), signal),
            content: (
              query: Parameters<NonNullable<ExecutionApi['projectArtifacts']>['content']>[0],
              signal: AbortSignal,
            ) => observed(projectArtifacts.content(query, signal), signal),
          },
        }
      : {}),
    ...(scope && expectedActorId
      ? {
          files: createExecutionFilesApi(fetcher, scope.spaceId, {
            async authorize(signal, caller) {
              requireCurrent(signal);
              await verifySpace(signal, caller);
              requireCurrent(signal);
            },
            current: requireCurrent,
            observed: (request, signal) => observed(request, signal),
          }),
        }
      : {}),
    startable: (signal) => memberRead(api.startable(signal), signal),
    startPlan: (draft, signal) => observed(api.startPlan(draft, signal), signal),
    inbox: (signal) => memberRead(api.inbox(signal), signal),
    submit: (draft, signal) => observed(api.submit(draft, signal), signal),
    ballot: (draft, signal) => observed(api.ballot(draft, signal), signal),
    revision: (query, signal) => observed(api.revision(query, signal), signal),
    upstreamContent: (query, signal) =>
      memberRead(api.upstreamContent(query, signal), signal, false),
    readDeliveryDraft: (query, signal) => observed(api.readDeliveryDraft(query, signal), signal),
    saveDeliveryDraft: (draft, signal) => observed(api.saveDeliveryDraft(draft, signal), signal),
  };
}
