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

import { nativeWorkSessionRecordSchema } from './native-work-session-record.js';
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
    write: async (key, value: NativeWorkSessionRecord) => {
      await bindings.put(key, nativeWorkSessionRecordSchema.parse(structuredClone(value)));
    },
  };
  const service = new NativeWorkSessionService(storage, runtime);
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
