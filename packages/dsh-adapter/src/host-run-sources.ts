import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { ExecutionRunHostPorts } from './execution-service.js';
import { ExecutionRunError } from './execution-run-state.js';
import { openExecutionMemberLease } from './member-session.js';
import type { createHostDirectoryLifecycle } from './host-directory-lifecycle.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import { NativeWorkError } from './native-work-session-contract.js';
import type { createHostRunResourceSource } from './host-run-resource-source.js';

export interface HostRunSources {
  readonly directory: Pick<
    ReturnType<typeof createHostDirectoryLifecycle>,
    'currentDirectoryBinding' | 'currentDirectory'
  >;
  readonly configuration: Pick<ExecutionRunHostPorts, 'assertConfiguration' | 'assertWorkspace'>;
  readonly native: Pick<NativeWorkSessionService, 'migrationOrigin' | 'migrationDrain'>;
  readonly signal: AbortSignal;
  readonly resources?: Pick<
    ReturnType<typeof createHostRunResourceSource>,
    'prepareResourceCatalog'
  >;
}

/** Combine original Host producers. This does not install a writer or drive native work. */
export function createHostRunSources(ctx: Context, sources: HostRunSources): ExecutionRunHostPorts {
  const active = () => {
    if (sources.signal.aborted) throw new ExecutionRunError('run-authority-unavailable');
  };
  return {
    signal: sources.signal,
    prepareResourceCatalog(request, command) {
      active();
      if (!sources.resources) throw new ExecutionRunError('run-authority-unavailable');
      // D owns the whole promise, including release of a late qualification.
      return sources.resources.prepareResourceCatalog(request, command);
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
        },
        { global: true },
      );
      let stopModel: (() => unknown) | undefined;
      try {
        stopModel = ctx.on('llm/adapters-updated', recheck, { global: true });
        active();
      } catch (error) {
        stopDomain();
        stopModel?.();
        throw error;
      }
      return () => {
        try {
          stopDomain();
        } finally {
          stopModel?.();
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
        if (error instanceof NativeWorkError && error.code === 'migration-not-ready')
          return undefined;
        throw error;
      }
    },
  };
}
