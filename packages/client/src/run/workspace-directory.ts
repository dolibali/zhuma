import { symbols, type Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client';
import { ExecutionError } from '../execution/ExecutionApi.js';
import type { RegisterWorkspaceDirectory } from './workspace-approvals.js';

const original = (value: unknown): unknown =>
  value && typeof value === 'object' ? (Reflect.get(value, symbols.original) ?? value) : value;

export interface LocalWorkspaceDirectory {
  /** Current official local registry only; a row is never execution authority. */
  read(
    signal: AbortSignal,
    assertCurrentMember: () => Promise<void>,
  ): Promise<
    readonly {
      readonly id: string;
      readonly title: string;
      readonly path: string;
      readonly sessionIds: readonly string[];
    }[]
  >;
  /** Navigation only. Callers must first revalidate the exact authorized Run. */
  openSession?:
    | ((
        sessionId: string,
        signal: AbortSignal,
        assertCurrentMember: () => Promise<void>,
      ) => Promise<void>)
    | undefined;
}

/** Reads the same Host-backed source the official sidebar follows. Does not
 * create Workspaces/Sessions or connect/start an Agent. */
export function createLocalWorkspaceDirectory(ctx: Context): LocalWorkspaceDirectory {
  const read: LocalWorkspaceDirectory['read'] = async (signal, assertCurrentMember) => {
    signal.throwIfAborted();
    const workspaces = ctx.get('workspaces');
    if (!workspaces) throw new ExecutionError('unavailable', '本机工作区服务暂不可用。');
    await assertCurrentMember();
    signal.throwIfAborted();
    ctx.fiber.assertActive();
    if (original(ctx.get('workspaces')) !== original(workspaces))
      throw new DOMException('Workspace service changed', 'AbortError');
    const snapshot = workspaces.list.getSnapshot();
    if (snapshot.state === 'error')
      throw new ExecutionError('unavailable', '本机工作区读取失败，请在侧栏重新连接后重试。');
    if (snapshot.phase !== 'ready' || snapshot.state === 'loading')
      throw new ExecutionError('unavailable', '本机工作区正在同步，请稍后重试。');
    return snapshot.items.map((item) => ({
      id: item.workspaceId,
      title: item.title,
      path: item.path,
      sessionIds: [...item.sessionIds],
    }));
  };
  return {
    read,
    async openSession(sessionId, signal, assertCurrentMember) {
      const navigation = ctx.get('uiWorkspace');
      const source = ctx.get('workspaces');
      if (!navigation) throw new ExecutionError('unavailable', '本机工作区导航暂不可用。');
      const workspaces = await read(signal, assertCurrentMember);
      if (!workspaces.some((item) => item.sessionIds.includes(sessionId)))
        throw new ExecutionError('unavailable', '此会话尚未归入本机工作区，请刷新后重试。');
      await assertCurrentMember();
      signal.throwIfAborted();
      ctx.fiber.assertActive();
      if (
        original(ctx.get('uiWorkspace')) !== original(navigation) ||
        original(ctx.get('workspaces')) !== original(source)
      )
        throw new DOMException('Workspace navigation changed', 'AbortError');
      const latest = source?.list.getSnapshot();
      if (
        latest?.phase !== 'ready' ||
        latest.state !== 'idle' ||
        !latest.items.some((item) => item.sessionIds.some((id) => id === sessionId))
      )
        throw new ExecutionError('unavailable', '此会话所属的本机工作区已变化，请刷新后重试。');
      navigation.openSession(sessionId as Parameters<typeof navigation.openSession>[0]);
    },
  };
}

/** The original SDK opens the native picker and registers the directory. This
 * never starts a Session or turns the selected path into product authority. */
export function createWorkspaceDirectoryRegistrar(ctx: Context): RegisterWorkspaceDirectory {
  return async (signal, assertCurrentMember) => {
    signal.throwIfAborted();
    const picker = ctx.get('uiWorkspace'),
      workspaces = ctx.get('workspaces');
    if (!picker || !workspaces)
      throw new ExecutionError('unavailable', '本机目录选择器暂不可用，请刷新后重试。');
    const current = () => {
      signal.throwIfAborted();
      ctx.fiber.assertActive();
      if (
        original(ctx.get('uiWorkspace')) !== original(picker) ||
        original(ctx.get('workspaces')) !== original(workspaces)
      )
        throw new DOMException('Workspace service changed', 'AbortError');
    };
    const path = await picker.pickDirectory();
    current();
    if (path === null) return null;
    await assertCurrentMember();
    current();
    const registered = await workspaces.create({ path });
    current();
    return registered.workspaceId;
  };
}
