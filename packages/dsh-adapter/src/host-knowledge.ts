import type { Context } from '@deepseek-ai/cordis';
import type { Workbench } from '@zhuma/agent-core';
import type { ExecutionRunHostPorts } from './execution-service.js';
import {
  KnowledgeError,
  openKnowledgeService,
  type KnowledgeService,
} from './knowledge-service.js';
import { openKnowledgeHttp } from './knowledge-http.js';
import { spaceDirectoryFor, type OpenedSpaceDirectoryHandle } from './space-directory.js';

/** Independent child: absent knowledge providers cannot replace or block manual work. */
export function openHostKnowledge(
  ctx: Context,
  directory: () => OpenedSpaceDirectoryHandle | undefined,
  readWorkbench?: () => Workbench,
) {
  let closed = false;
  let owner: KnowledgeService | undefined;
  let opening: Promise<KnowledgeService> | undefined;
  let closing: Promise<void> | undefined;
  const http = openKnowledgeHttp(ctx, () => (closed ? undefined : owner));
  const mount = ctx.plugin({
    name: 'zhuma-knowledge-owner',
    inject: ['storageDomain', 'attachments'],
    async apply(child: Context) {
      if (closed) return;
      const original = directory();
      opening = openKnowledgeService(child, {
        ...(readWorkbench ? { readWorkbench } : {}),
        assertPersonalOwner(spaceId, actorId) {
          if (
            !original ||
            original.signal.aborted ||
            directory() !== original ||
            spaceDirectoryFor(child) !== original
          )
            throw new KnowledgeError('unavailable');
          const space = original.space(spaceId);
          if (!space || space.kind !== 'personal') throw new KnowledgeError('not-found');
          const account = original.administratorForSpace(spaceId);
          if (!account) throw new KnowledgeError('unavailable');
          if (account !== actorId) throw new KnowledgeError('not-found');
        },
      });
      const service = await opening;
      if (closed) {
        await service.close();
        return;
      }
      owner = service;
      child.effect(() => () => {
        if (owner === service) owner = undefined;
        return service.close();
      });
    },
  });
  void Promise.resolve(mount).catch(() =>
    ctx.logger.error('Zhuma knowledge is unavailable; member work remains independent.'),
  );
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      owner = undefined;
      const results = await Promise.allSettled([
        http.close(),
        opening?.then((service) => service.close()),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Knowledge close failed.');
    })());
  ctx.effect(() => close);
  const projectSnapshot: NonNullable<ExecutionRunHostPorts['prepareProjectKnowledge']> = async (
    request,
    query,
    signal,
  ) => {
    const service = owner;
    if (closed || !service || signal.aborted) throw new KnowledgeError('unavailable');
    // Use the same mounted service and original request. A failed or replaced
    // source cannot become an empty project snapshot for a new Run.
    const result = await service.projectSnapshot(request, query, signal);
    if (closed || owner !== service || signal.aborted) throw new KnowledgeError('unavailable');
    if (!result.ok) throw new KnowledgeError(result.error.code);
    return result.value;
  };
  // Host-private read projection of this exact mounted owner. Returning the
  // original object keeps its reference stable across catalog read checkpoints;
  // a closed/replaced owner never becomes a freshly fabricated read port.
  const catalogSource = (): Pick<KnowledgeService, 'libraries' | 'list'> | undefined =>
    closed ? undefined : owner;
  return { close, projectSnapshot, catalogSource };
}
