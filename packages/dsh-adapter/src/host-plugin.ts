import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials';
import { applyIdentity, identityInject, type IdentityImport } from './identity-session.js';
import { configureDeploymentMode } from './member-session.js';
import { openWorkbench, inject as workbenchInject } from './workbench-plugin.js';
import { WORKBENCH_HTTP_LIMITS } from './workbench-http.js';
import { apply as applyExecution, inject as executionInject } from './execution-plugin.js';
import type { ProjectSpaceDirectory } from './project-space.js';

export const Config = z.strictObject({
  deploymentMode: z.enum(['legacy-single-user', 'multi-member']),
  // Configuration carries only a private record address, never account verifiers.
  identityBootstrapKey: z
    .string()
    .refine((key) => {
      try {
        parseCredentialKey(key);
        return true;
      } catch {
        return false;
      }
    }, '需要合法的私有凭据记录地址。')
    .optional(),
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
export const identityPlugin = {
  inject: [...identityInject],
  async apply(ctx: Context, bootstrapKey?: string): Promise<void> {
    let imported: IdentityImport | undefined;
    if (bootstrapKey !== undefined) {
      const record = await ctx.credentials.readRecord(parseCredentialKey(bootstrapKey));
      if (record?.kind !== 'grant' || record.payload === undefined || record.payload === null)
        throw new Error('Identity bootstrap record is unavailable.');
      // B validates the opaque payload before it is ever used as import data.
      imported = record.payload as IdentityImport;
    }
    await applyIdentity(ctx, imported);
  },
};

export const executionPlugin = { inject: [...executionInject], apply: applyExecution };

export interface WorkbenchHostDependencies {
  /** A trusted Host provider, never JSON configuration or client-supplied mappings. */
  readonly projectSpaces?: ProjectSpaceDirectory;
}

/** The formal directory producer can use this exact composition without reopening domains. */
export function createWorkbenchHost(dependencies: WorkbenchHostDependencies = {}) {
  return {
    Config,
    inject,
    apply: (ctx: Context, rawConfig: unknown) => mountHost(ctx, rawConfig, dependencies),
  };
}

/** Official Host entry. Missing directory facts remain missing; no project-id fallback. */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  await mountHost(ctx, rawConfig, {});
}

async function mountHost(
  ctx: Context,
  rawConfig: unknown,
  dependencies: WorkbenchHostDependencies,
): Promise<void> {
  const config = Config.parse(rawConfig);
  configureDeploymentMode(ctx, config.deploymentMode);
  // Registers fail-closed streaming gates before the first asynchronous domain open.
  // The same clone-producing closure is shared with execution; no second workbench domain.
  const workbench = await openWorkbench(ctx, config);
  if (config.deploymentMode === 'multi-member' || config.identityBootstrapKey !== undefined) {
    try {
      await ctx.plugin(identityPlugin, config.identityBootstrapKey);
    } catch {
      // The independent fence stays mounted; Cordis retains the identity child's FAILED status.
      ctx.logger.error(
        'Zhuma identity is unavailable; the configured owner-route policy remains in force.',
      );
    }
  }
  if (config.deploymentMode === 'multi-member') {
    // Even if identity failed, mount the member-gated routes. They reject absent
    // identity or directory facts; they never fall back to the owner principal.
    await ctx.plugin(executionPlugin, {
      readWorkbench: workbench.readWorkbench,
      ...(dependencies.projectSpaces === undefined
        ? {}
        : { projectSpaces: dependencies.projectSpaces }),
    });
  }
}
