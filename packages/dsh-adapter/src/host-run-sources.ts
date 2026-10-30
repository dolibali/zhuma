import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { ExecutionRunHostPorts } from './execution-service.js';
import { ExecutionRunError } from './execution-run-state.js';
import { openExecutionMemberLease } from './member-session.js';
import type { createHostDirectoryLifecycle } from './host-directory-lifecycle.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import {
  NativeWorkError,
  type NativeScopeCleanupResult,
  type NativeWorkScope,
} from './native-work-session-contract.js';
import { nativeScopeKey } from './native-work-session-record.js';
import type { createHostRunResourceSource } from './host-run-resource-source.js';
import type { createHostRunWorkspaces } from './host-run-workspaces.js';

export interface HostRunSources {
  readonly directory: Pick<
    ReturnType<typeof createHostDirectoryLifecycle>,
    'currentDirectoryBinding' | 'currentDirectory'
  >;
  readonly configuration: Pick<
    ExecutionRunHostPorts,
    'assertConfiguration' | 'assertWorkspace' | 'assertReviewConfiguration'
  >;
  readonly native: Pick<NativeWorkSessionService, 'migrationOrigin' | 'migrationDrain'>;
  readonly signal: AbortSignal;
  readonly resources?: Pick<
    ReturnType<typeof createHostRunResourceSource>,
    'prepareResourceCatalog' | 'prepareInitialResourceCatalog' | 'prepareReviewResourceCatalog'
  >;
  readonly workspaces?: Pick<ReturnType<typeof createHostRunWorkspaces>, 'onChange'>;
  readonly retirementDrain?: NonNullable<ExecutionRunHostPorts['migrationDrain']>;
  readonly prepareProjectKnowledge?: ExecutionRunHostPorts['prepareProjectKnowledge'];
  readonly teamAssets?: Required<
    Pick<ExecutionRunHostPorts, 'prepareTeamAssetFiles' | 'qualifyTeamAssetFile'>
  >;
}

type Retired = Extract<NativeScopeCleanupResult, { status: 'retired' }>;
/** Ephemeral references to original C cleanup certificates, never persisted proof labels. */
export function createHostRunRetirements(owner: NativeWorkSessionService, signal: AbortSignal) {
  const entries = new Map<
    string,
    {
      owner: NativeWorkSessionService;
      scope: NativeWorkScope;
      result: Retired;
      drain: Retired['drain'];
      signal: AbortSignal;
      assertCurrent: Retired['drain']['assertCurrent'];
    }
  >();
  const active = () => {
    if (signal.aborted) throw new ExecutionRunError('run-authority-unavailable');
  };
  const verify = (entry: {
    result: Retired;
    drain: Retired['drain'];
    signal: AbortSignal;
    assertCurrent: Retired['drain']['assertCurrent'];
  }) => {
    active();
    const drain = entry.drain;
    if (
      entry.result.drain !== drain ||
      !(entry.signal instanceof AbortSignal) ||
      entry.signal.aborted ||
      drain.signal !== entry.signal ||
      typeof entry.assertCurrent !== 'function' ||
      drain.assertCurrent !== entry.assertCurrent
    )
      throw new ExecutionRunError('run-authority-unavailable');
    const result: unknown = entry.assertCurrent.call(drain);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new ExecutionRunError('run-authority-unavailable');
    }
    active();
  };
  return {
    remember(scope: NativeWorkScope, result: NativeScopeCleanupResult) {
      active();
      if (result.status !== 'retired') return;
      const key = nativeScopeKey(scope);
      if (result.binding && nativeScopeKey(result.binding.scope) !== key)
        throw new ExecutionRunError('run-scope-mismatch');
      const entry = {
        owner,
        scope: Object.freeze(structuredClone(scope)),
        result,
        drain: result.drain,
        signal: result.drain.signal,
        assertCurrent: result.drain.assertCurrent,
      };
      verify(entry);
      // Same bound as the original native owner's scope ledger. Do not evict a
      // still-current certificate or invent one if either owner is at capacity.
      if (entries.has(key) || entries.size < 4096) entries.set(key, entry);
    },
    read(scope: NativeWorkScope) {
      active();
      const key = nativeScopeKey(scope),
        entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.owner !== owner || nativeScopeKey(entry.scope) !== key)
        throw new ExecutionRunError('run-scope-mismatch');
      verify(entry);
      if (entries.get(key) !== entry) throw new ExecutionRunError('run-authority-unavailable');
      return entry.drain;
    },
    clear() {
      entries.clear();
    },
  };
}

/** Combine original Host producers. This does not install a writer or drive native work. */
export function createHostRunSources(
  ctx: Context,
  sources: HostRunSources,
): ExecutionRunHostPorts & {
  prepareInitialResourceCatalog: NonNullable<
    HostRunSources['resources']
  >['prepareInitialResourceCatalog'];
  prepareReviewResourceCatalog: NonNullable<
    HostRunSources['resources']
  >['prepareReviewResourceCatalog'];
} {
  const active = () => {
    if (sources.signal.aborted) throw new ExecutionRunError('run-authority-unavailable');
  };
  return {
    signal: sources.signal,
    ...(sources.teamAssets
      ? {
          async prepareTeamAssetFiles(
            ...args: Parameters<NonNullable<ExecutionRunHostPorts['prepareTeamAssetFiles']>>
          ) {
            active();
            const value = await sources.teamAssets!.prepareTeamAssetFiles(...args);
            active();
            return value;
          },
          async qualifyTeamAssetFile(
            ...args: Parameters<NonNullable<ExecutionRunHostPorts['qualifyTeamAssetFile']>>
          ) {
            active();
            const value = await sources.teamAssets!.qualifyTeamAssetFile(...args);
            active();
            return value;
          },
        }
      : {}),
    ...(sources.prepareProjectKnowledge
      ? {
          async prepareProjectKnowledge(
            ...args: Parameters<NonNullable<ExecutionRunHostPorts['prepareProjectKnowledge']>>
          ) {
            active();
            const snapshot = await sources.prepareProjectKnowledge!(...args);
            active();
            return snapshot;
          },
        }
      : {}),
    prepareInitialResourceCatalog(request, locator, wait) {
      active();
      if (!sources.resources) throw new ExecutionRunError('run-authority-unavailable');
      // The original qualification may complete after cancellation. D owns the
      // whole promise and must release it; no native composition is fabricated.
      return sources.resources.prepareInitialResourceCatalog(request, locator, wait);
    },
    prepareResourceCatalog(request, command) {
      active();
      if (!sources.resources) throw new ExecutionRunError('run-authority-unavailable');
      // D owns the whole promise, including release of a late qualification.
      return sources.resources.prepareResourceCatalog(request, command);
    },
    prepareReviewResourceCatalog(request, query, wait) {
      active();
      if (!sources.resources) throw new ExecutionRunError('run-authority-unavailable');
      // Forward the original qualification promise unchanged. The D owner
      // retains late resolution, current-source checks and actual release.
      return sources.resources.prepareReviewResourceCatalog(request, query, wait);
    },
    memberLease(request) {
      active();
      return openExecutionMemberLease(ctx, request);
    },
    assertProjectSpace(projectId, spaceId) {
      active();
      const binding = sources.directory.currentDirectoryBinding();
      const directory = sources.directory.currentDirectory();
      if (!binding || !directory || binding.directory !== directory || !binding.isCurrent())
        throw new ExecutionRunError('run-authority-unavailable');
      const lookup = directory.spaceForProjectNow(projectId);
      active();
      if (!binding.isCurrent()) throw new ExecutionRunError('run-authority-unavailable');
      if (!lookup.ok || lookup.spaceId !== spaceId)
        throw new ExecutionRunError('run-authority-denied');
      return undefined;
    },
    assertConfiguration(...args) {
      active();
      const result = sources.configuration.assertConfiguration(...args);
      active();
      return result;
    },
    ...(sources.configuration.assertReviewConfiguration
      ? {
          assertReviewConfiguration(
            ...args: Parameters<NonNullable<ExecutionRunHostPorts['assertReviewConfiguration']>>
          ) {
            active();
            const result = sources.configuration.assertReviewConfiguration!(...args);
            active();
            return result;
          },
        }
      : {}),
    assertWorkspace(...args) {
      active();
      const result = sources.configuration.assertWorkspace(...args);
      active();
      return result;
    },
    onChange(recheck) {
      active();
      const stopDomain = ctx.on(
        'domain/changed',
        (event) => {
          if (event.domain === 'zhuma_workbench' || event.domain === 'zhuma_spaces') recheck();
          if (event.domain === 'workspace')
            setImmediate(() => {
              if (!sources.signal.aborted) recheck();
            });
        },
        { global: true },
      );
      let stopModel: (() => unknown) | undefined;
      let stopWorkspace: (() => void) | undefined;
      try {
        stopWorkspace = sources.workspaces?.onChange(recheck);
        stopModel = ctx.on('llm/adapters-updated', recheck, { global: true });
        active();
      } catch (error) {
        stopDomain();
        stopModel?.();
        stopWorkspace?.();
        throw error;
      }
      return () => {
        try {
          stopDomain();
        } finally {
          stopModel?.();
          stopWorkspace?.();
        }
      };
    },
    migrationOrigin(query) {
      active();
      const result = sources.native.migrationOrigin(query);
      active();
      return result;
    },
    migrationDrain(scope) {
      active();
      try {
        const result = sources.native.migrationDrain(scope);
        active();
        return result;
      } catch (error) {
        active();
        if (
          error instanceof NativeWorkError &&
          ['migration-not-ready', 'not-started'].includes(error.code)
        ) {
          const retired = sources.retirementDrain?.(scope);
          active();
          if (retired) return retired;
        }
        if (error instanceof NativeWorkError && error.code === 'migration-not-ready')
          return undefined;
        throw error;
      }
    },
  };
}
