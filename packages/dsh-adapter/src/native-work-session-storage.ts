import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { NativeWorkSessionService } from './native-work-session.js';
import { DshNativeWorkRuntime, type NativeDshOptions } from './native-work-session-dsh.js';
import {
  NativeWorkError,
  type NativeWorkSessionRecord,
  type NativeWorkStorage,
} from './native-work-session-contract.js';

import { nativeWorkSessionRecordSchema, readNativeRecord } from './native-work-session-record.js';
import { NativeSessionPurpose, type NativeReviewPorts } from './native-work-session-purpose.js';
import {
  nativeReviewAwareRecordSchema,
  nativeReviewGlobalSchema,
  NATIVE_REVIEW_WRITER_MARKER,
} from './native-work-session-review-contract.js';
export { nativeWorkSessionBindingSchema } from './native-work-session-record.js';

export const nativeWorkSessionDomainSpec = {
  name: 'zhuma_native_work_sessions',
  version: 1,
  global: {
    schema: z.strictObject({ schemaVersion: z.literal(1) }),
    initial: { schemaVersion: 1 as const },
  },
  tables: { bindings: { valueSchema: nativeWorkSessionRecordSchema } },
};

export const nativeWorkSessionInject = [
  'storageDomain',
  'agents',
  'sessions',
  'sessionPersistence',
  'sessionProjections',
  'tools',
  'systemPrompt',
] as const;

// Same original domain/name/version/table. The old declaration above remains a
// strict legacy reader for compatibility checks, not a second opened store.
const reviewAwareDomainSpec = {
  ...nativeWorkSessionDomainSpec,
  global: {
    schema: nativeReviewGlobalSchema,
    initial: nativeReviewGlobalSchema.parse({ schemaVersion: 1 }),
  },
  tables: { bindings: { valueSchema: nativeReviewAwareRecordSchema } },
};

/** A mounts this once at Host lifetime; callers never open a second mapping domain. */
export async function openNativeWorkSessions(
  ctx: Context,
  options: NativeDshOptions,
  reviewPorts?: NativeReviewPorts,
) {
  const purpose = reviewPorts && new NativeSessionPurpose(reviewPorts);
  const runtime = new DshNativeWorkRuntime(ctx, options, purpose);
  const domain = await ctx.storageDomain.open(reviewAwareDomainSpec);
  const bindings = domain.table('bindings');
  const storage: NativeWorkStorage = {
    read: (key) => {
      const value = bindings.get(key);
      return value === undefined ? undefined : readNativeRecord(structuredClone(value));
    },
    write: async (key, value: NativeWorkSessionRecord) => {
      await bindings.put(key, nativeWorkSessionRecordSchema.parse(structuredClone(value)));
    },
  };
  let enabling: Promise<void> | undefined;
  const enable = (): Promise<void> => {
    if (domain.global.get().nativeReviewWriter === 1) return Promise.resolve();
    return (enabling ??= domain.global.set(NATIVE_REVIEW_WRITER_MARKER).catch((error: unknown) => {
      enabling = undefined;
      throw error;
    }));
  };
  const service = new NativeWorkSessionService(
    storage,
    runtime,
    purpose
      ? {
          purpose,
          read: (key) => structuredClone(bindings.get(key)),
          write: async (key, record) => {
            await bindings.put(key, nativeReviewAwareRecordSchema.parse(record));
          },
          enable,
        }
      : undefined,
  );
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      const drain = service.sealInputReads();
      try {
        let retirementFailed = false;
        try {
          await service.whenRetirementsIdle();
        } catch {
          retirementFailed = true;
        }
        await runtime.close();
        if (retirementFailed) throw new NativeWorkError('unavailable');
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
