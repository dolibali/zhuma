import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client';
import { ExecutionError } from '../execution/ExecutionApi.js';
import type { RegisterWorkspaceDirectory } from './workspace-approvals.js';

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
      if (ctx.get('uiWorkspace') !== picker || ctx.get('workspaces') !== workspaces)
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
