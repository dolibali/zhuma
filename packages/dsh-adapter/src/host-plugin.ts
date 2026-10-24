import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver';
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials';
import { applyIdentity, identityInject, type IdentityImport } from './identity-session.js';
import { configureDeploymentMode } from './member-session.js';
import { openWorkbench, inject as workbenchInject } from './workbench-plugin.js';
import { WORKBENCH_HTTP_LIMITS } from './workbench-http.js';
import { apply as applyExecution, inject as executionInject } from './execution-plugin.js';
import {
  applySpaceDirectory,
  spaceDirectoryFor,
  type OpenedSpaceDirectoryHandle,
  type SpaceDirectoryImport,
} from './space-directory.js';
export { spaceDirectoryFor } from './space-directory.js';

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

interface DirectoryMountConfig {
  bootstrapKey?: string | undefined;
  publish(directory: OpenedSpaceDirectoryHandle): () => void;
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
    await applySpaceDirectory(ctx, imported);
    const directory = spaceDirectoryFor(ctx);
    if (!directory) throw new Error('Space directory did not become available.');
    const unpublish = config.publish(directory);
    ctx.effect(() => unpublish);
  },
};

/** Official Host composition; no seed or missing facts can become inferred authority. */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const config = Config.parse(rawConfig);
  configureDeploymentMode(ctx, config.deploymentMode);
  // Public boot presentation only. Authorization continues to use the Host's own configuration.
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({
      kind: 'global',
      name: '__ZHUMA_WORKBENCH_BOOT__',
      value: { version: 1, deploymentMode: config.deploymentMode },
    });
  });
  // Registers fail-closed streaming gates before the first asynchronous domain open.
  // The same clone-producing closure is shared with execution; no second workbench domain.
  const workbench = await openWorkbench(ctx, config);
  let ownedDirectory: OpenedSpaceDirectoryHandle | undefined;
  const identitySelected =
    config.deploymentMode === 'multi-member' || config.identityBootstrapKey !== undefined;
  if (identitySelected || config.spaceDirectoryBootstrapKey !== undefined) {
    try {
      await ctx.plugin(spaceDirectoryPlugin, {
        bootstrapKey: config.spaceDirectoryBootstrapKey,
        publish(directory: OpenedSpaceDirectoryHandle) {
          ownedDirectory = directory;
          return () => {
            if (ownedDirectory === directory) ownedDirectory = undefined;
          };
        },
      });
    } catch {
      ctx.logger.error('Zhuma space directory is unavailable; member space access remains closed.');
    }
  }
  if (identitySelected) {
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
      projectSpaces: {
        async spaceForProject(projectId: string) {
          const current = ownedDirectory;
          if (!current || spaceDirectoryFor(ctx) !== current)
            return { ok: false as const, reason: 'unavailable' as const };
          const result = await current.spaceForProject(projectId);
          // Revocation/failed close removes the registration before the close awaits.
          // A lookup from a previous producer lifetime cannot authorize this request.
          if (ownedDirectory !== current || spaceDirectoryFor(ctx) !== current)
            return { ok: false as const, reason: 'unavailable' as const };
          return result;
        },
      },
    });
  }
}
