import type { Context, Fiber } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver';
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials';
import {
  applyIdentity,
  identityInject,
  type IdentityImport,
  type IdentityInitializationOptions,
} from './identity-session.js';
import { configureDeploymentMode, type IdentityExecutionOptions } from './member-session.js';
import { createHostDirectoryLifecycle } from './host-directory-lifecycle.js';
import { openWorkbench, inject as workbenchInject } from './workbench-plugin.js';
import { WORKBENCH_HTTP_LIMITS } from './workbench-http.js';
import { createHostMemberDirectory } from './host-member-directory.js';
import { defaultMemberTemplates } from './member-template-catalog.js';
import { mergeDefaultMemberEngineeringSkills } from './member-engineering-skill-catalog.js';

declare const ZHUMA_PUBLIC_MEMBER_TEMPLATES: unknown;
declare const ZHUMA_PUBLIC_ENGINEERING_SKILLS: unknown;
import { openMemberWorkbenchOperations } from './member-workbench-operation.js';
import { apply as applyExecution, inject as executionInject } from './execution-plugin.js';
import { openHostRunHttp } from './host-run-http.js';
import { openHostRemoteRunHttp } from './host-remote-run-http.js';
import { openHostSessionAdmission } from './host-session-admission.js';
import type { ExecutionService } from './execution-service.js';
import { openHostRunOwner } from './host-run-owner.js';
import { openHostWorkflowHttp } from './host-workflow-http.js';
import { openHostWorkspaceApprovalHttp } from './host-workspace-approval-http.js';
import { hostLocalExecutionSchema } from './host-run-workspaces.js';
import { hostTeamCatalogGrantsSchema } from './host-team-catalog.js';
import { openHostLocalSetup } from './host-local-setup.js';
import { openHostLocalSetupHttp } from './host-local-setup-http.js';
import { nativeWorkSessionInject } from './native-work-session-storage.js';
import { enableMemberWeb } from './member-web-transport.js';
import { openMemberWebEntry } from './member-web-entry.js';
import { openIdentityMemberHttp } from './identity-member-http.js';
import { openHostKnowledge } from './host-knowledge.js';
import { openHostMemberAssets } from './host-member-assets.js';
import { mountHostSharedBackend } from './host-shared-backend-http.js';
import { openHostMemberLocalOptionsHttp } from './host-member-local-options-http.js';
import {
  createHostNativeOwnerLifecycle,
  HostNativeOpenRefusal,
  type HostNativeChild,
} from './host-native-owner-lifecycle.js';
import { HostSharedBackend, SharedBackendError } from './host-shared-backend.js';
import { openHostMemberNativeOwner } from './host-member-native-owner.js';
import { openHostMemberNativeHttp, type HostMemberNativeOwner } from './host-member-native-http.js';
import type {
  IdentityMemberLifecycleHandle,
  IdentityMemberLifecycleOptions,
} from './identity-member-lifecycle.js';
import {
  applySpaceDirectory,
  spaceDirectoryFor,
  type OpenedSpaceDirectoryHandle,
  type SpaceDirectoryImport,
} from './space-directory.js';
export { spaceDirectoryFor } from './space-directory.js';
export { workbenchDomainSpec } from './workbench-plugin.js';
// Consumers of the distributed Host must use its installed identity module graph.
export { openExecutionMemberLease } from './member-session.js';

const bootstrapRecordKey = z.string().refine((key) => {
  try {
    parseCredentialKey(key);
    return true;
  } catch {
    return false;
  }
}, '需要合法的私有凭据记录地址。');

export const Config = z.strictObject({
  deploymentMode: z.enum(['legacy-single-user', 'multi-member']),
  // Only private DSH credential record addresses, never inline seed/account data.
  identityBootstrapKey: bootstrapRecordKey.optional(),
  spaceDirectoryBootstrapKey: bootstrapRecordKey.optional(),
  localExecution: hostLocalExecutionSchema.optional(),
  teamCatalog: hostTeamCatalogGrantsSchema.optional(),
  localSetup: z.boolean().optional(),
  memberWeb: z.boolean().optional(),
  remoteExecution: z.boolean().optional(),
  remoteFileUploads: z.literal(true).optional(),
  remoteIndependentReviews: z.literal(true).optional(),
  bodyBytes: z
    .number()
    .int()
    .min(1024)
    .max(300 * 1024 * 1024)
    .default(WORKBENCH_HTTP_LIMITS.bodyBytes),
  bodyTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(WORKBENCH_HTTP_LIMITS.bodyTimeoutMs),
});
export type WorkbenchHostConfig = z.infer<typeof Config>;
// The existing desktop owner composition need not provide an HTTP listener.
// Required identity services belong to the child scope when identity is selected.
export const inject = workbenchInject;
interface IdentityMountConfig {
  readonly bootstrapKey?: string | undefined;
  readonly executionOptions?: IdentityExecutionOptions | undefined;
  readonly initialization?: IdentityInitializationOptions | undefined;
  readonly lifecycle?: IdentityMemberLifecycleOptions | undefined;
}
export const identityPlugin = {
  inject: [...identityInject],
  async apply(ctx: Context, config: IdentityMountConfig = {}): Promise<void> {
    let imported: IdentityImport | undefined;
    if (config.bootstrapKey !== undefined) {
      const record = await ctx.credentials.readRecord(parseCredentialKey(config.bootstrapKey));
      if (record?.kind !== 'grant' || record.payload === undefined || record.payload === null)
        throw new Error('Identity bootstrap record is unavailable.');
      // B validates the opaque payload before it is ever used as import data.
      imported = record.payload as IdentityImport;
    }
    await applyIdentity(
      ctx,
      imported,
      config.executionOptions,
      config.initialization,
      config.lifecycle,
    );
  },
};

export const executionPlugin = { inject: [...executionInject], apply: applyExecution };

// Native services are an independent child: their absence must not prevent
// manual member work, and can never silently select a different executor.
export const nativeRunPlugin = {
  inject: [...nativeWorkSessionInject, 'llm', 'workingDirectory'],
  apply(ctx: Context, config: { open(ctx: Context): Promise<void> }) {
    return config.open(ctx);
  },
};

interface DirectoryMountConfig {
  bootstrapKey?: string | undefined;
  publish(directory: OpenedSpaceDirectoryHandle): () => void;
  allowPendingInitialization?: boolean;
}
function nativeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** The same producer instance is used by identity and execution in this Host bundle. */
export const spaceDirectoryPlugin = {
  inject: ['storageDomain', 'credentials'],
  async apply(ctx: Context, config: DirectoryMountConfig): Promise<void> {
    let imported: SpaceDirectoryImport | undefined;
    if (config.bootstrapKey !== undefined) {
      const record = await ctx.credentials.readRecord(parseCredentialKey(config.bootstrapKey));
      if (record?.kind !== 'grant' || record.payload === undefined || record.payload === null)
        throw new Error('Space directory bootstrap record is unavailable.');
      imported = record.payload as SpaceDirectoryImport;
    }
    // B validates, persists and registers the directory; A only owns startup and scope.
    await applySpaceDirectory(
      ctx,
      imported,
      config.allowPendingInitialization ? { allowPendingInitialization: true } : undefined,
    );
    const directory = spaceDirectoryFor(ctx);
    if (!directory) throw new Error('Space directory did not become available.');
    const unpublish = config.publish(directory);
    ctx.effect(() => unpublish);
  },
};

/** Official Host composition; no seed or missing facts can become inferred authority. */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const config = Config.parse(rawConfig);
  if (config.localSetup && config.deploymentMode !== 'multi-member')
    throw new Error('Local member setup requires explicit multi-member mode.');
  if (config.memberWeb && config.deploymentMode !== 'multi-member')
    throw new Error('Member Web requires explicit multi-member mode.');
  if (config.remoteExecution && config.deploymentMode !== 'multi-member')
    throw new Error('Remote execution requires explicit multi-member mode.');
  if (config.remoteFileUploads && !config.remoteExecution)
    throw new Error('Remote file uploads require the explicit shared execution backend.');
  if (config.remoteIndependentReviews && !config.remoteFileUploads)
    throw new Error('Independent shared review requires the original file/resource backend.');
  configureDeploymentMode(ctx, config.deploymentMode);
  if (config.memberWeb) {
    enableMemberWeb(ctx);
    openMemberWebEntry(ctx);
  }
  // Public boot presentation only. Authorization continues to use the Host's own configuration.
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({
      kind: 'global',
      name: '__ZHUMA_WORKBENCH_BOOT__',
      value: {
        version: 1,
        deploymentMode: config.deploymentMode,
        ...(config.localSetup ? { localSetup: true } : {}),
        ...(config.localSetup && !config.remoteExecution && config.deploymentMode === 'multi-member'
          ? { sharedBackend: true }
          : {}),
      },
    });
  });
  // Registers fail-closed streaming gates before the first asynchronous domain open.
  // The same clone-producing closure is shared with execution; no second workbench domain.
  let closed = false;
  const directoryLifecycle = createHostDirectoryLifecycle(() => spaceDirectoryFor(ctx));
  const memberDirectory = createHostMemberDirectory(ctx);
  let memberOpening: Promise<{ close(): Promise<void> } | undefined> | undefined;
  let knowledge: ReturnType<typeof openHostKnowledge> | undefined;
  let memberAssets: ReturnType<typeof openHostMemberAssets> | undefined;
  let identityMembers: IdentityMemberLifecycleHandle | undefined;
  const identityHttp =
    config.deploymentMode === 'multi-member'
      ? openIdentityMemberHttp(ctx, () => (closed ? undefined : identityMembers))
      : undefined;
  let remoteExecution: ExecutionService | undefined;
  const remoteHttp = config.remoteExecution
    ? openHostRemoteRunHttp(ctx, () => (closed ? undefined : remoteExecution))
    : undefined;
  let runOwner: Awaited<ReturnType<typeof openHostRunOwner>> | undefined;
  let sharedBackend: HostSharedBackend | undefined;
  let memberNative: HostMemberNativeOwner | undefined;
  let nativeLifecycle: ReturnType<typeof createHostNativeOwnerLifecycle> | undefined;
  let executionMount: Fiber | undefined;
  let executionChild: HostNativeChild | undefined;
  let nativeGeneration = 0;
  const sharedMount =
    config.deploymentMode === 'multi-member' && config.localSetup && !config.remoteExecution
      ? mountHostSharedBackend(ctx, {
          publish(owner) {
            sharedBackend = owner;
            return () => {
              if (sharedBackend === owner) sharedBackend = undefined;
              void nativeLifecycle
                ?.close()
                .catch(() => ctx.logger.error('Zhuma native owner cleanup is incomplete.'));
            };
          },
          selection: {
            prepare: () => {
              if (!nativeLifecycle) throw new SharedBackendError('unavailable');
              return nativeLifecycle.prepare();
            },
          },
        })
      : undefined;
  const currentRunOwner = () =>
    closed || runsClosed || (nativeLifecycle && !nativeLifecycle.current()) ? undefined : runOwner;
  const memberNativeHttp = sharedMount
    ? openHostMemberNativeHttp(
        ctx,
        () => {
          const active = nativeLifecycle?.current();
          return memberNative && active?.lookupNativeSession === memberNative.lookupNativeSession
            ? memberNative
            : undefined;
        },
        { source: currentRunOwner, backend: () => sharedBackend },
      )
    : undefined;
  const memberLocalOptionsHttp = config.remoteExecution
    ? openHostMemberLocalOptionsHttp(ctx, () => currentRunOwner()?.memberLocalOptions)
    : undefined;
  const memberLocalReviewOptionsHttp = config.remoteExecution
    ? openHostMemberLocalOptionsHttp(
        ctx,
        () => currentRunOwner()?.memberLocalReviewOptions,
        'local-review-options',
      )
    : undefined;
  let runOpening: ReturnType<typeof openHostRunOwner> | undefined;
  let runHttp: ReturnType<typeof openHostRunHttp> | undefined;
  let workflowHttp: ReturnType<typeof openHostWorkflowHttp> | undefined;
  let workspaceApprovalHttp: ReturnType<typeof openHostWorkspaceApprovalHttp> | undefined;
  let localSetup: ReturnType<typeof openHostLocalSetup> | undefined;
  let localSetupHttp: ReturnType<typeof openHostLocalSetupHttp> | undefined;
  let runClosing: Promise<void> | undefined;
  let runsClosed = false;
  const sessionAdmission =
    config.deploymentMode === 'multi-member'
      ? openHostSessionAdmission(ctx, () =>
          closed || runsClosed ? undefined : nativeLifecycle ? nativeLifecycle.current() : runOwner,
        )
      : undefined;
  let runLifetime = new AbortController();
  function closeRunBridge(): Promise<void> {
    if (runClosing) return runClosing;
    runsClosed = true;
    remoteExecution = undefined;
    runLifetime.abort();
    const owner = runOwner;
    runOwner = undefined;
    // Start physical cleanup before awaiting HTTP commands that may be waiting
    // on native reads/sends. Both paths retain the same actual close promise.
    const nativeClose = nativeLifecycle
      ? nativeLifecycle.close()
      : executionChild
        ? executionChild.close().then(() => executionChild?.dispose())
        : (owner?.close() ??
          runOpening?.then(
            (opened) => opened.close(),
            (error: unknown) => {
              // The opener only reports this after its actual native close succeeds.
              if (error instanceof DOMException && error.name === 'AbortError') return;
              throw error;
            },
          ));
    const httpClose = runHttp?.close();
    const remoteClose = remoteHttp?.close();
    const localOptionsClose = memberLocalOptionsHttp?.close();
    const localReviewOptionsClose = memberLocalReviewOptionsHttp?.close();
    const workflowClose = workflowHttp?.close();
    const workspaceClose = workspaceApprovalHttp?.close();
    const memberNativeClose = memberNativeHttp?.close();
    return (runClosing = Promise.allSettled([
      nativeClose,
      httpClose,
      remoteClose,
      localOptionsClose,
      localReviewOptionsClose,
      workflowClose,
      workspaceClose,
      memberNativeClose,
    ]).then((results) => {
      const failed = results.filter((item) => item.status === 'rejected');
      if (failed.length)
        throw new AggregateError(
          failed.map((item) => item.reason),
          'Run bridge close failed.',
        );
    }));
  }
  const beforeClose = async () => {
    closed = true;
    sessionAdmission?.close();
    const identityClosing = identityHttp?.close();
    const assetClosing = memberAssets?.close();
    const knowledgeClosing = knowledge?.close();
    localSetup?.close();
    const setupClosing = localSetupHttp?.close();
    const runs = closeRunBridge();
    directoryLifecycle.close();
    try {
      const member = await memberOpening;
      await member?.close();
    } finally {
      // Keep the shared Workbench facts available until native cleanup has
      // committed through the original execution owner.
      try {
        const results = await Promise.allSettled([setupClosing, assetClosing]);
        const errors = results.flatMap((value) =>
          value.status === 'rejected' ? [value.reason] : [],
        );
        if (errors.length) throw new AggregateError(errors, 'Member setup/assets close failed.');
      } finally {
        try {
          await identityClosing;
        } finally {
          try {
            await knowledgeClosing;
          } finally {
            await runs;
          }
        }
      }
    }
  };
  const workbench = await openWorkbench(ctx, config, { beforeClose });
  if (config.localSetup) {
    localSetup = openHostLocalSetup({
      workbench,
      directory: directoryLifecycle.currentDirectory,
      ...(config.teamCatalog === undefined ? {} : { configuredCatalog: config.teamCatalog }),
    });
    localSetupHttp = openHostLocalSetupHttp(ctx, () =>
      closed ? undefined : localSetup?.operations,
    );
  }
  const identitySelected =
    config.deploymentMode === 'multi-member' || config.identityBootstrapKey !== undefined;
  if (identitySelected || config.spaceDirectoryBootstrapKey !== undefined) {
    try {
      await ctx.plugin(spaceDirectoryPlugin, {
        bootstrapKey: config.spaceDirectoryBootstrapKey,
        publish: directoryLifecycle.publish,
        ...(config.localSetup ? { allowPendingInitialization: true } : {}),
      });
    } catch {
      ctx.logger.error('Zhuma space directory is unavailable; member space access remains closed.');
    }
  }
  if (closed) return;
  if (identitySelected) {
    try {
      await ctx.plugin(identityPlugin, {
        bootstrapKey: config.identityBootstrapKey,
        executionOptions: { currentDirectoryBinding: directoryLifecycle.currentDirectoryBinding },
        ...(localSetup ? { initialization: localSetup.initialization } : {}),
        ...(config.deploymentMode === 'multi-member'
          ? {
              lifecycle: {
                publish(handle: IdentityMemberLifecycleHandle) {
                  identityMembers = handle;
                  return () => {
                    if (identityMembers === handle) identityMembers = undefined;
                  };
                },
                reservedAccountIds: () =>
                  workbench
                    .readWorkbench()
                    .participants.filter((item) => item.kind === 'expert')
                    .map((item) => item.id),
              },
            }
          : {}),
      });
    } catch {
      // The independent fence stays mounted; Cordis retains the identity child's FAILED status.
      ctx.logger.error(
        'Zhuma identity is unavailable; the configured owner-route policy remains in force.',
      );
    }
  }
  if (closed) return;
  if (config.deploymentMode === 'multi-member') {
    workspaceApprovalHttp = openHostWorkspaceApprovalHttp(ctx, {
      current: () => currentRunOwner()?.workspaceApprovalOperations,
      limits: { bodyBytes: config.bodyBytes, bodyTimeoutMs: config.bodyTimeoutMs },
    });
    workflowHttp = openHostWorkflowHttp(ctx, {
      current: () => currentRunOwner()?.workflowOperations,
      limits: { bodyBytes: config.bodyBytes, bodyTimeoutMs: config.bodyTimeoutMs },
    });
    runHttp = openHostRunHttp(ctx, {
      current: () => currentRunOwner()?.operations,
      limits: { bodyBytes: config.bodyBytes, bodyTimeoutMs: config.bodyTimeoutMs },
    });
    // Member commands share the opened workbench. Only their durable intent
    // journal is separate; failure to open it leaves a read-only projection.
    memberOpening = (async () => {
      let operations: Awaited<ReturnType<typeof openMemberWorkbenchOperations>> | undefined;
      try {
        operations = await openMemberWorkbenchOperations(ctx.storageDomain);
      } catch {
        ctx.logger.error('Zhuma member operations are unavailable; editing remains closed.');
      }
      if (closed) {
        await operations?.close();
        return undefined;
      }
      let http: ReturnType<typeof workbench.openMemberWorkbench>;
      let assets: ReturnType<typeof openHostMemberAssets> | undefined;
      try {
        await localSetup?.restore();
        const configuredCatalog =
          config.teamCatalog?.length && !localSetup?.hasSetup()
            ? await workbench.openTeamCatalog({
                grants: config.teamCatalog,
                directory: directoryLifecycle.currentDirectory,
              })
            : undefined;
        // Only the explicitly enabled shared member backend supplies defaults.
        // Startup uses the original immutable importer; catalog reads never write.
        const defaultCatalog =
          config.remoteExecution && config.memberWeb
            ? await workbench.openTeamCatalog({
                grants: [],
                directory: directoryLifecycle.currentDirectory,
                defaultForTeams: true,
              })
            : undefined;
        const resourceCatalog = localSetup
          ? async (spaceId: string) =>
              localSetup!.hasSetup()
                ? localSetup!.catalog(spaceId)
                : configuredCatalog
                  ? configuredCatalog(spaceId)
                  : { experts: [], assets: [] }
          : configuredCatalog;
        const templates =
          typeof ZHUMA_PUBLIC_MEMBER_TEMPLATES === 'undefined'
            ? []
            : defaultMemberTemplates(ZHUMA_PUBLIC_MEMBER_TEMPLATES);
        const catalog = async (spaceId: string) => {
          const selected = (await resourceCatalog?.(spaceId)) ?? { experts: [], assets: [] };
          // Explicit selections contain at least one pack. Never concatenate
          // defaults or recover from a failed/corrupt explicit source.
          const resources = selected.experts.length
            ? selected
            : ((await defaultCatalog?.(spaceId)) ?? selected);
          const assets =
            typeof ZHUMA_PUBLIC_ENGINEERING_SKILLS === 'undefined'
              ? resources.assets
              : mergeDefaultMemberEngineeringSkills(
                  resources.assets,
                  ZHUMA_PUBLIC_ENGINEERING_SKILLS,
                );
          const published = memberAssets?.publishedDefinitions(spaceId) ?? {
            experts: [],
            assets: [],
          };
          return {
            experts: [...resources.experts, ...published.experts],
            assets: [...assets, ...templates, ...published.assets],
          };
        };
        if (closed) {
          await operations?.close();
          return undefined;
        }
        const memberOptions: Parameters<typeof workbench.openMemberWorkbench>[1] = {
          directory: memberDirectory,
          writer: () => {
            const current = directoryLifecycle.currentDirectory();
            if (!current) return undefined;
            return { assignProjectSpace: current.assignProjectSpace.bind(current) };
          },
          model: workbench.planningModel,
          catalog,
          ...(operations ? { operations: operations.journal } : {}),
        };
        assets = openHostMemberAssets(ctx, {
          workbench,
          member: memberOptions,
          knowledge: () => knowledge?.catalogSource(),
          limits: { bodyBytes: config.bodyBytes, bodyTimeoutMs: config.bodyTimeoutMs },
          ...(config.remoteExecution
            ? { execution: () => (closed || runsClosed ? undefined : remoteExecution) }
            : {}),
        });
        http = workbench.openMemberWorkbench(ctx, memberOptions);
        memberAssets = assets;
      } catch (error) {
        await assets?.close();
        await operations?.close();
        throw error;
      }
      let closing: Promise<void> | undefined;
      return {
        close() {
          return (closing ??= (async () => {
            try {
              await http.close();
            } finally {
              try {
                if (memberAssets === assets) memberAssets = undefined;
                await assets?.close();
              } finally {
                await operations?.close();
              }
            }
          })());
        },
      };
    })();
    await memberOpening;
    if (closed) return;
    const knowledgeOwner = openHostKnowledge(
      ctx,
      directoryLifecycle.currentDirectory,
      workbench.readWorkbench,
    );
    knowledge = knowledgeOwner;
    // Each original execution child is opened once and disposed before another
    // native namespace is mounted. Reopen uses the SAME original domains.
    async function openLocalChild(): Promise<HostNativeChild> {
      if (closed || runsClosed || executionMount) throw new SharedBackendError('unavailable');
      const generation = ++nativeGeneration;
      const lifetime = new AbortController();
      runLifetime = lifetime;
      const ready = nativeDeferred<Awaited<ReturnType<typeof openHostRunOwner>>>();
      lifetime.signal.addEventListener(
        'abort',
        () => ready.reject(new DOMException('Native startup cancelled', 'AbortError')),
        { once: true },
      );
      let nativeMount: Fiber | undefined;
      let localOpening: ReturnType<typeof openHostRunOwner> | undefined;
      let nativeFailedAndDisposed = false;
      const mount = ctx.plugin(executionPlugin, {
        readWorkbench: workbench.readWorkbench,
        ...(config.deploymentMode === 'multi-member' ? { memberDirectory } : {}),
        publishRunService(service) {
          nativeMount = ctx.plugin(nativeRunPlugin, {
            async open(nativeCtx: Context) {
              if (closed || runsClosed || lifetime.signal.aborted)
                throw new SharedBackendError('unavailable');
              localOpening = openHostRunOwner(nativeCtx, {
                execution: service,
                directory: directoryLifecycle,
                signal: lifetime.signal,
                readWorkbench: workbench.readWorkbench,
                prepareProjectKnowledge: knowledgeOwner.projectSnapshot,
                ...(memberAssets ? { teamAssets: memberAssets.runSources } : {}),
                skillPolicies: workbench.createRunSkillPolicies(service),
                localExecution: config.localExecution,
                remoteOnly: config.remoteExecution === true,
              });
              runOpening = localOpening;
              const opened = await localOpening;
              if (
                closed ||
                runsClosed ||
                lifetime.signal.aborted ||
                generation !== nativeGeneration
              ) {
                await opened.close();
                throw new SharedBackendError('unavailable');
              }
              try {
                if (config.remoteExecution) {
                  await service.enableRemoteRuns({
                    ...(config.remoteFileUploads ? { fileUploads: true } : {}),
                    ...(config.remoteIndependentReviews ? { independentReviews: true } : {}),
                  });
                  if (closed || runsClosed || lifetime.signal.aborted)
                    throw new SharedBackendError('unavailable');
                  remoteExecution = service;
                }
                runOwner = opened;
                nativeCtx.effect(() => () => {
                  if (runOwner === opened) runOwner = undefined;
                  if (remoteExecution === service) remoteExecution = undefined;
                  return opened.close();
                });
                ready.resolve(opened);
              } catch (error) {
                await opened.close();
                throw error;
              }
            },
          });
          void Promise.resolve(nativeMount).catch(ready.reject);
          return async () => {
            lifetime.abort();
            if (remoteExecution === service) remoteExecution = undefined;
            try {
              await (await localOpening)?.close();
            } catch (error) {
              if (!nativeFailedAndDisposed) throw error;
            }
          };
        },
        projectSpaces: {
          async spaceForProject(projectId: string) {
            const binding = directoryLifecycle.currentDirectoryBinding();
            if (!binding) return { ok: false as const, reason: 'unavailable' as const };
            const result = await binding.directory.spaceForProject(projectId);
            if (!binding.isCurrent()) return { ok: false as const, reason: 'unavailable' as const };
            return result;
          },
        },
      });
      executionMount = mount;
      try {
        await mount;
        const opened = await ready.promise;
        let disposing: Promise<void> | undefined;
        const child: HostNativeChild = {
          lookupNativeSession: opened.lookupNativeSession,
          canSwitchBackend: opened.canSwitchBackend,
          async close() {
            await opened.close();
            if (runOwner === opened) runOwner = undefined;
          },
          dispose() {
            return (disposing ??= (async () => {
              await nativeMount?.dispose();
              await mount.dispose();
              if (executionMount === mount) executionMount = undefined;
              if (executionChild === child) executionChild = undefined;
            })());
          },
        };
        executionChild = child;
        return child;
      } catch (error) {
        // Dispose native effects before the original execution metadata closes.
        await nativeMount?.dispose();
        nativeFailedAndDisposed = true;
        if (closed || runsClosed || lifetime.signal.aborted) {
          await mount.dispose();
          if (executionMount === mount) executionMount = undefined;
          throw error;
        }
        // No native owner was published, hence no Run was admitted. Keep the
        // original manual domain/routes after the failed native child really
        // disposed, but do not certify Session classification or switching.
        const manual: HostNativeChild = {
          canSwitchBackend: () => false,
          lookupNativeSession: () => {
            throw new SharedBackendError('unavailable');
          },
          close: async () => {},
          async dispose() {
            await mount.dispose();
            if (executionMount === mount) executionMount = undefined;
            if (executionChild === manual) executionChild = undefined;
          },
        };
        executionChild = manual;
        return manual;
      }
    }
    async function openRemoteChild(): Promise<HostNativeChild> {
      if (!sharedBackend || closed || runsClosed) throw new SharedBackendError('unavailable');
      const owner = sharedBackend;
      const ready = nativeDeferred<HostMemberNativeOwner>();
      const mount = ctx.plugin(nativeRunPlugin, {
        async open(nativeCtx: Context) {
          const opened = await openHostMemberNativeOwner(nativeCtx, owner);
          nativeCtx.effect(() => () => opened.close());
          ready.resolve(opened);
        },
      });
      void Promise.resolve(mount).catch(ready.reject);
      try {
        await mount;
        const opened = await ready.promise;
        memberNative = opened;
        return {
          lookupNativeSession: opened.lookupNativeSession,
          canSwitchBackend: opened.canSwitchBackend,
          async close() {
            await opened.close();
            if (memberNative === opened) memberNative = undefined;
          },
          dispose: () => mount.dispose(),
        };
      } catch (error) {
        await mount.dispose();
        throw new HostNativeOpenRefusal(error);
      }
    }
    try {
      if (sharedMount) {
        await sharedMount;
        if (!sharedBackend) throw new SharedBackendError('unavailable');
        nativeLifecycle = createHostNativeOwnerLifecycle({
          backend: sharedBackend,
          openLocal: openLocalChild,
          openRemote: openRemoteChild,
          failed: () =>
            ctx.logger.error(
              'Zhuma native owner transition is incomplete; native access remains closed.',
            ),
        });
        void nativeLifecycle
          .start()
          .catch(() =>
            ctx.logger.error(
              'Zhuma native services are unavailable; manual work remains available.',
            ),
          );
      } else {
        const opening = openLocalChild();
        void opening.catch(() =>
          ctx.logger.error('Zhuma native services are unavailable; manual work remains available.'),
        );
        // Manual execution and uploads must remain available even when the
        // optional native SDK dependency set never becomes ready.
        await executionMount;
      }
    } catch {
      ctx.logger.error('Zhuma native Run services are unavailable; manual work remains available.');
    }
  }
}
