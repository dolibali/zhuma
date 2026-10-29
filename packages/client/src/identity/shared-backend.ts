import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';

export interface SharedBackendStatus {
  readonly origin: string | null;
  readonly connectionId: string | null;
  readonly backendId: string | null;
  readonly actorId: string | null;
}
export interface SharedBackendSnapshot {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly selection: SharedBackendStatus | undefined;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);
function nullableUuid(value: unknown): string | null {
  if (value === null || (typeof value === 'string' && uuid.test(value))) return value;
  throw new TypeError('共享服务返回无效。');
}
function status(raw: unknown): SharedBackendStatus {
  if (
    !object(raw) ||
    Object.keys(raw).length !== 4 ||
    !['origin', 'connectionId', 'backendId', 'actorId'].every((key) => key in raw) ||
    !(raw.origin === null || typeof raw.origin === 'string') ||
    ![raw.connectionId, raw.backendId].every(
      (value) => value === null || (typeof value === 'string' && uuid.test(value)),
    ) ||
    !(
      raw.actorId === null ||
      (typeof raw.actorId === 'string' && /^[\w-]{1,100}$/u.test(raw.actorId))
    )
  )
    throw new TypeError('共享服务返回无效。');
  if (raw.origin !== null) {
    const url = new URL(raw.origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== raw.origin ||
      raw.connectionId === null
    )
      throw new TypeError('共享服务返回无效。');
  } else if (raw.actorId !== null || raw.backendId !== null)
    throw new TypeError('共享服务返回无效。');
  if ((raw.actorId === null) !== (raw.backendId === null))
    throw new TypeError('共享服务返回无效。');
  return {
    origin: raw.origin,
    connectionId: nullableUuid(raw.connectionId),
    backendId: nullableUuid(raw.backendId),
    actorId: raw.actorId,
  };
}
const targets = {
  '/zhuma-id/login': ['POST', 'identity.login'],
  '/zhuma-id/session': ['GET', 'identity.session'],
  '/zhuma-id/logout': ['POST', 'identity.logout'],
  '/zhuma-id/register': ['POST', 'identity.register'],
  '/zhuma-id/password': ['POST', 'identity.password'],
  '/api/zhuma-member/snapshot': ['POST', 'member.snapshot'],
  '/api/zhuma-member/command': ['POST', 'member.command'],
  '/api/zhuma-member/plan': ['POST', 'member.plan'],
  '/api/zhuma-member/local-run-options': ['POST', 'execution.local-run-options'],
  '/api/zhuma-member/local-review-options': ['POST', 'execution.local-review-options'],
  '/api/zhuma-knowledge/libraries': ['POST', 'knowledge.libraries'],
  '/api/zhuma-knowledge/list': ['POST', 'knowledge.list'],
  '/api/zhuma-knowledge/search': ['POST', 'knowledge.search'],
  '/api/zhuma-knowledge/read': ['POST', 'knowledge.read'],
  '/api/zhuma-knowledge/drafts': ['POST', 'knowledge.drafts'],
  '/api/zhuma-knowledge/draft': ['POST', 'knowledge.draft'],
  '/api/zhuma-knowledge/save-draft': ['POST', 'knowledge.save-draft'],
  '/api/zhuma-knowledge/propose-draft': ['POST', 'knowledge.propose-draft'],
  '/api/zhuma-knowledge/publish': ['POST', 'knowledge.publish'],
  '/api/zhuma-knowledge/project-links': ['POST', 'knowledge.project-links'],
  '/api/zhuma-knowledge/save-project-links': ['POST', 'knowledge.save-project-links'],
  '/api/zhuma-exec/inbox': ['POST', 'execution.inbox'],
  '/api/zhuma-exec/startable': ['POST', 'execution.startable'],
  '/api/zhuma-exec/task-progress': ['POST', 'execution.task-progress'],
  '/api/zhuma-exec/project-artifacts': ['POST', 'execution.project-artifacts'],
  '/api/zhuma-exec/start-plan': ['POST', 'execution.start-plan'],
  '/api/zhuma-exec/submit': ['POST', 'execution.submit'],
  '/api/zhuma-exec/ballot': ['POST', 'execution.ballot'],
  '/api/zhuma-exec/revision': ['POST', 'execution.revision'],
  '/api/zhuma-exec/review-outcome': ['POST', 'execution.review-outcome'],
  '/api/zhuma-exec/upstream-content': ['POST', 'execution.upstream-content'],
  '/api/zhuma-exec/draft': ['POST', 'execution.draft'],
} as const;
function target(path: string, method: string): readonly [string, string] {
  if (path === '/zhuma-id/teams')
    return [method, method === 'GET' ? 'identity.teams.read' : 'identity.teams.create'];
  if (path === '/zhuma-id/team-members')
    return [method, method === 'GET' ? 'identity.members.read' : 'identity.members.change'];
  const entry = Object.entries(targets).find(([key]) => key === path)?.[1];
  if (!entry || entry[0] !== method) throw new TypeError('此共享服务操作尚未接入。');
  return entry;
}
/** Renderer keeps public connection metadata only. The original local owner
 * Connection authorizes proxy setup; remote Cookie/headers never enter here. */
export function createSharedBackendClient(
  rpc: ClientConnectionRpc,
  onConnectionChange: () => void,
  localFetch: typeof fetch = globalThis.fetch,
) {
  let snapshot: SharedBackendSnapshot = { phase: 'loading', selection: undefined };
  let sequence = 0,
    closed = false,
    loading: Promise<void> | undefined;
  let retry:
    { origin: string | null; expectedConnectionId: string | null; requestId: string } | undefined;
  const lifetime = new AbortController(),
    listeners = new Set<() => void>();
  const publish = (next: SharedBackendSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const current = (attempt: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (closed || sequence !== attempt)
      throw new DOMException('Shared backend changed', 'AbortError');
  };
  async function call(
    endpoint: 'status' | 'select' | 'request',
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await rpc.call(
      '/api',
      `zhuma-backend/${endpoint}`,
      payload,
      AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]),
    );
    if (!result.ok) {
      if (endpoint === 'select' && result.error.code === 'backend-native-busy') {
        const error = new Error('仍有工作在运行或等待清理，请先停止并确认结束后再切换服务。');
        error.name = 'SharedBackendNativeBusy';
        throw error;
      }
      if (endpoint === 'request' && result.error.code === 'backend-invalid-response')
        return { connectionId: snapshot.selection?.connectionId, status: 502, body: null };
      if (
        result.error.code === 'backend-changed' ||
        result.error.code === 'backend-identity-changed'
      ) {
        ++sequence;
        publish({ phase: 'error', selection: snapshot.selection });
        onConnectionChange();
        throw new DOMException('Shared backend changed', 'AbortError');
      }
      throw new TypeError('共享服务暂不可用，请检查连接。');
    }
    return result.value;
  }
  function accept(value: unknown) {
    const selection = status(value),
      changed =
        snapshot.selection !== undefined &&
        snapshot.selection.connectionId !== selection.connectionId;
    publish({ phase: 'ready', selection });
    if (changed) onConnectionChange();
  }
  function refresh(): Promise<void> {
    if (loading) return loading;
    const attempt = ++sequence;
    publish({ phase: 'loading', selection: snapshot.selection });
    const work = (async () => {
      try {
        const value = await call('status', {});
        current(attempt);
        accept(value);
      } catch (error) {
        current(attempt);
        publish({ phase: 'error', selection: snapshot.selection });
        throw error;
      }
    })();
    loading = work.finally(() => {
      if (loading === retained) loading = undefined;
    });
    const retained = loading;
    return retained;
  }
  const fetcher: typeof fetch = async (input, init) => {
    if (snapshot.phase === 'loading') await (loading ?? refresh());
    const attempt = sequence,
      selection = snapshot.selection;
    current(attempt, init?.signal ?? undefined);
    if (snapshot.phase !== 'ready' || !selection) throw new TypeError('共享服务暂不可用。');
    if (!selection.origin) {
      const response = await localFetch(input, init);
      current(attempt, init?.signal ?? undefined);
      return response;
    }
    if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//'))
      throw new TypeError('不支持的共享服务地址。');
    const url = new URL(input, 'http://zhuma.invalid'),
      method = init?.method ?? 'GET';
    if (!['GET', 'POST'].includes(method)) throw new TypeError('不支持的共享服务方法。');
    if (url.pathname === '/api/zhuma-exec/file' || url.pathname === '/api/zhuma-exec/upload-file') {
      const reading = url.pathname === '/api/zhuma-exec/file';
      if (
        !selection.connectionId ||
        url.hash ||
        (reading ? method !== 'GET' : method !== 'POST' || !!url.search)
      )
        throw new TypeError('文件请求无效。');
      const headers = new Headers();
      if (reading) {
        if (url.searchParams.has('connectionId')) throw new TypeError('文件请求无效。');
        url.searchParams.set('connectionId', selection.connectionId);
      } else {
        const original = new Headers(init?.headers);
        for (const name of [
          'content-type',
          'x-zhuma-file-name',
          'x-zhuma-file-type',
          'x-zhuma-file-size',
          'x-zhuma-file-sha256',
          'x-zhuma-space',
          'x-zhuma-task',
          'x-zhuma-plan',
          'x-zhuma-revision',
          'x-zhuma-node',
          'x-zhuma-idempotency-key',
        ]) {
          const value = original.get(name);
          if (value !== null) headers.set(name, value);
        }
        headers.set('x-zhuma-backend-connection', selection.connectionId);
      }
      const response = await localFetch(
        `/api/zhuma-backend/${reading ? 'file' : 'upload-file'}${url.search}`,
        {
          // The official local owner carrier requires Origin. Browser POST
          // supplies it naturally; the original remote file remains a GET.
          method: reading ? 'POST' : method,
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers,
          signal: AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : [])]),
          ...(!reading && init?.body ? { body: init.body } : {}),
        },
      );
      try {
        current(attempt, init?.signal ?? undefined);
        if (
          response.headers.get('x-zhuma-backend-connection') !== selection.connectionId &&
          response.ok
        )
          throw new TypeError('文件连接已发生变化，请重试。');
        return response;
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
    }
    const [, operation] = target(url.pathname, method);
    let payload: unknown =
      method === 'POST' ? JSON.parse(typeof init?.body === 'string' ? init.body : '') : {};
    let rpcId: string | undefined;
    if (url.search) {
      if (
        operation !== 'identity.members.read' ||
        [...url.searchParams.keys()].length !== 1 ||
        !url.searchParams.has('spaceId')
      )
        throw new TypeError('不支持的共享服务参数。');
      payload = { spaceId: url.searchParams.get('spaceId') };
    }
    if (url.pathname.startsWith('/api/')) {
      if (
        !object(payload) ||
        Object.keys(payload).length !== 4 ||
        payload.type !== 'client-request' ||
        payload.method !== url.pathname.slice('/api/'.length) ||
        typeof payload.rpcId !== 'string' ||
        !uuid.test(payload.rpcId) ||
        !('payload' in payload)
      )
        throw new TypeError('共享服务请求无效。');
      rpcId = payload.rpcId;
      payload = payload.payload;
    }
    const value = await call(
      'request',
      { connectionId: selection.connectionId, operation, payload, ...(rpcId ? { rpcId } : {}) },
      init?.signal ?? undefined,
    );
    current(attempt, init?.signal ?? undefined);
    if (
      !object(value) ||
      Object.keys(value).length !== 3 ||
      value.connectionId !== selection.connectionId ||
      !Number.isInteger(value.status) ||
      typeof value.status !== 'number' ||
      value.status < 200 ||
      value.status > 599 ||
      !('body' in value)
    )
      throw new TypeError('共享服务返回无效。');
    return Response.json(value.body, { status: value.status });
  };
  return {
    fetcher,
    refresh,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async select(origin: string | null, signal: AbortSignal) {
      const selection = snapshot.selection;
      if (snapshot.phase === 'loading' || !selection) throw new TypeError('请先重新读取连接。');
      if (!retry || retry.origin !== origin)
        retry = {
          origin,
          expectedConnectionId: selection.connectionId,
          requestId: crypto.randomUUID(),
        };
      const attempt = ++sequence;
      publish({ phase: 'loading', selection });
      try {
        const value = await call('select', retry, signal);
        current(attempt, signal);
        accept(value);
        retry = undefined;
      } catch (error) {
        current(attempt);
        publish({
          phase:
            error instanceof Error && error.name === 'SharedBackendNativeBusy' ? 'ready' : 'error',
          selection,
        });
        throw error;
      }
    },
    close() {
      closed = true;
      ++sequence;
      lifetime.abort();
      listeners.clear();
    },
  };
}
export type SharedBackendClient = ReturnType<typeof createSharedBackendClient>;
