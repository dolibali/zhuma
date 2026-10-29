import { symbols, type Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { NativeWorkError } from './native-work-session-contract.js';

const original = (value: object) => Reflect.get(value, symbols.original) ?? value;
/** Original durable workspace account only. The enclosing Run/directory grant
 * supplies permission; a workspace record or matching cwd is never that grant. */
export function nativeWorkspaceAttachment(
  ctx: Context,
  workspaceId: string,
  cwd: string,
  assertCurrent: () => void,
) {
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 200)
    throw new NativeWorkError('configuration-mismatch');
  const registry = ctx.get('workspaceRegistry'),
    workspace = registry?.get(WorkspaceId(workspaceId));
  if (!registry || !workspace || workspace.path !== cwd)
    throw new NativeWorkError('configuration-mismatch');
  const registryIdentity = original(registry),
    workspaceIdentity = original(workspace),
    createdAt = workspace.createdAt;
  let attached: string | undefined;
  const check = () => {
    assertCurrent();
    const latestRegistry = ctx.get('workspaceRegistry'),
      latest = latestRegistry?.get(WorkspaceId(workspaceId));
    if (
      !latestRegistry ||
      original(latestRegistry) !== registryIdentity ||
      !latest ||
      original(latest) !== workspaceIdentity ||
      latest.id !== workspaceId ||
      latest.createdAt !== createdAt ||
      latest.path !== cwd ||
      (attached !== undefined && !latest.sessionIds.includes(SessionId(attached)))
    )
      throw new NativeWorkError('configuration-mismatch');
  };
  check();
  return {
    check,
    async attach(nativeSessionId: string): Promise<void> {
      check();
      if (attached !== undefined && attached !== nativeSessionId)
        throw new NativeWorkError('configuration-mismatch');
      if ((await workspace.status()) !== 'ok') throw new NativeWorkError('unavailable');
      check();
      // Public SDK reads the real stored/live session header and validates its
      // canonical cwd, then commits its original workspace account idempotently.
      await workspace.attachSession(SessionId(nativeSessionId));
      check();
      if (!workspace.sessionIds.includes(SessionId(nativeSessionId)))
        throw new NativeWorkError('configuration-mismatch');
      attached = nativeSessionId;
    },
  };
}
