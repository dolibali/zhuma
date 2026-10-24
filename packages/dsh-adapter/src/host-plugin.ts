import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials';
import { applyIdentity, identityInject, type IdentityImport } from './identity-session.js';
import { configureDeploymentMode } from './member-session.js';
import { openWorkbench, inject as workbenchInject } from './workbench-plugin.js';
import { WORKBENCH_HTTP_LIMITS } from './workbench-http.js';

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

/** Official Host composition. A mode is never inferred from identity's presence. */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const config = Config.parse(rawConfig);
  configureDeploymentMode(ctx, config.deploymentMode);
  // Registers fail-closed streaming gates before the first asynchronous domain open.
  // The returned snapshot closure stays Host-internal for the later S1b consumer.
  await openWorkbench(ctx, config);
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
}
