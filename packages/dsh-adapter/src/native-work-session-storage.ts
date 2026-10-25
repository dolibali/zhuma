import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { NativeWorkSessionService } from './native-work-session.js';
import { DshNativeWorkRuntime, type NativeDshOptions } from './native-work-session-dsh.js';
import type { NativeSessionBinding, NativeWorkStorage } from './native-work-session-contract.js';

const id = z.string().min(1).max(200);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
export const nativeWorkSessionBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.strictObject({
    actorId: id,
    spaceId: id,
    taskId: id,
    planId: id,
    revision: positive,
    nodeId: id,
    runId: id,
    generation: positive,
    segmentId: id,
  }),
  nativeSessionId: id,
  nativeAgentId: id,
  selection: z.strictObject({
    provider: id,
    model: id,
    reasoningEffort: id.optional(),
    maxTokens: positive.max(65_536),
    configurationId: id,
  }),
  receipts: z
    .array(
      z.strictObject({
        requestId: id,
        messageId: id,
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.enum(['followup', 'steer', 'queue']),
        status: z.enum(['reserved', 'received', 'claimed', 'discarded', 'unknown']),
      }),
    )
    .max(256),
  inputReadBudget: z
    .strictObject({
      attempts: z.number().int().min(0).max(16),
      chargedBytes: z.number().int().min(0).max(65_536),
    })
    .optional(),
});

export const nativeWorkSessionDomainSpec = {
  name: 'zhuma_native_work_sessions',
  version: 1,
  global: {
    schema: z.strictObject({ schemaVersion: z.literal(1) }),
    initial: { schemaVersion: 1 as const },
  },
  tables: { bindings: { valueSchema: nativeWorkSessionBindingSchema } },
};

export const nativeWorkSessionInject = [
  'storageDomain',
  'agents',
  'sessions',
  'sessionPersistence',
  'tools',
  'systemPrompt',
] as const;

/** A mounts this once at Host lifetime; callers never open a second mapping domain. */
export async function openNativeWorkSessions(ctx: Context, options: NativeDshOptions) {
  const runtime = new DshNativeWorkRuntime(ctx, options);
  const domain = await ctx.storageDomain.open(nativeWorkSessionDomainSpec);
  const bindings = domain.table('bindings');
  const storage: NativeWorkStorage = {
    read: (key) => {
      const value = bindings.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    write: async (key, value: NativeSessionBinding) => {
      await bindings.put(key, nativeWorkSessionBindingSchema.parse(structuredClone(value)));
    },
  };
  const service = new NativeWorkSessionService(storage, runtime);
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      const drain = service.sealInputReads();
      try {
        await runtime.close();
      } finally {
        // Tool scope disposal retains the native persistence handle until the
        // actual source promise settles. Do not release metadata before it.
        await drain;
        await domain.close();
      }
    })());
  ctx.effect(() => close);
  return { service, runtime, close };
}
