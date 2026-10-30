import type { Context, Fiber } from '@deepseek-ai/cordis';
import { WorkbenchError } from '@zhuma/agent-core';
import type { KnowledgeService } from './knowledge-service.js';
import type { OpenedWorkbench } from './workbench-plugin.js';
import type { MemberWorkbenchMountOptions } from './member-workbench-http.js';
import type { WorkbenchHttpLimits } from './workbench-http.js';
import { openMemberAssetHttp } from './member-asset-http.js';
import { TeamAssetCatalogService } from './team-asset-catalog.js';
import { TeamAssetFileBytes } from './team-asset-file.js';
import { TeamAssetFileService } from './team-asset-file-service.js';
import { openTeamAssetFileHttp } from './team-asset-file-http.js';
import type {} from '@deepseek-ai/dsh-attachment';

/** One member facade over the original opened Workbench and attachment owner.
 * Its catalog shares the original KnowledgeService; it owns no fact database. */
export function openHostMemberAssets(
  ctx: Context,
  options: {
    readonly workbench: OpenedWorkbench;
    readonly member: Omit<MemberWorkbenchMountOptions, 'workbench'>;
    readonly knowledge: () => Pick<KnowledgeService, 'libraries' | 'list'> | undefined;
    readonly limits: WorkbenchHttpLimits;
  },
) {
  let closed = false;
  let files: TeamAssetFileService | undefined;
  let closing: Promise<void> | undefined;
  const cleanups = new Set<Promise<void>>();
  let cleanupFailed = false;
  const assets = options.workbench.openMemberAssets(ctx, options.member);
  const catalog = new TeamAssetCatalogService(() => {
    const knowledge = options.knowledge();
    return closed || !knowledge ? undefined : { assets, knowledge };
  });
  let http: ReturnType<typeof openMemberAssetHttp> | undefined;
  let fileHttp: ReturnType<typeof openTeamAssetFileHttp> | undefined;
  let mount: Fiber | undefined;
  const closeFiles = (owner: TeamAssetFileService) => {
    const operation = owner.close();
    cleanups.add(operation);
    void operation.then(
      () => cleanups.delete(operation),
      () => {
        cleanupFailed = true;
        cleanups.delete(operation);
      },
    );
    return operation;
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    const originalFiles = files;
    files = undefined;
    return (closing = (async () => {
      const errors: unknown[] = [];
      const collect = async (jobs: readonly (void | Promise<unknown>)[]) => {
        const results = await Promise.allSettled(jobs);
        errors.push(
          ...results.flatMap((value) => (value.status === 'rejected' ? [value.reason] : [])),
        );
      };
      // Fence and drain metadata/binary handlers, then readers, then authority.
      // Disposing Cordis alone is not used as proof of a finalizer's success.
      await collect([http?.close(), fileHttp?.close()]);
      await collect([
        catalog.close(),
        ...(originalFiles ? [closeFiles(originalFiles)] : []),
        mount?.dispose(),
      ]);
      while (cleanups.size) await collect([...cleanups]);
      await collect([assets.close()]);
      if (errors.length || cleanupFailed)
        throw new AggregateError(errors, 'Member assets close failed.');
    })());
  };
  ctx.effect(() => close);
  try {
    http = openMemberAssetHttp(
      ctx,
      () => (closed ? undefined : { assets, catalog }),
      options.limits,
    );
    fileHttp = openTeamAssetFileHttp(ctx, () => (closed || cleanupFailed ? undefined : files));
    mount = ctx.plugin({
      name: 'zhuma-member-asset-files',
      inject: ['attachments'],
      apply(child: Context) {
        if (closed) return;
        const owner = new TeamAssetFileService(new TeamAssetFileBytes(child.attachments), assets);
        files = owner;
        child.effect(() => () => {
          if (files === owner) files = undefined;
          return closeFiles(owner);
        });
      },
    });
    void Promise.resolve(mount).catch(() =>
      ctx.logger.error('Zhuma member asset files are unavailable; metadata remains independent.'),
    );
  } catch (error) {
    // A partial mount must fence already-registered callbacks immediately.
    void close().catch(() => ctx.logger.error('Zhuma member asset rollback is incomplete.'));
    throw error;
  }
  return {
    close,
    publishedDefinitions(spaceId: string) {
      if (closed || cleanupFailed)
        throw new WorkbenchError('asset-unavailable', '资产服务暂不可用。');
      return assets.publishedDefinitions(spaceId);
    },
    /** Host-private readers for the separately authorized Run byte seam. */
    currentFiles: () => (closed || cleanupFailed ? undefined : files),
    currentAuthority: () => (closed ? undefined : assets),
  };
}
