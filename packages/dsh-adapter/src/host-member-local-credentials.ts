import { symbols, type Context } from '@deepseek-ai/cordis';
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import {
  MemberLocalSecretError,
  type MemberLocalPrivateStore,
} from './member-local-execution-secrets.js';

/** Thin adapter over the original private SDK provider. Never enumerates or
 * reads model credentials, browser cookies, profiles or unrelated records. */
export function createMemberLocalPrivateStore(
  ctx: Context,
  signal: AbortSignal,
): MemberLocalPrivateStore {
  const provider = ctx.get('credentials');
  const original = (value: unknown): unknown =>
    value && typeof value === 'object' ? (Reflect.get(value, symbols.original) ?? value) : value;
  const identity = original(provider);
  const current = () => {
    if (signal.aborted) throw new MemberLocalSecretError('cancelled');
    ctx.fiber.assertActive();
    const live = ctx.get('credentials');
    if (!provider || !live || original(live) !== identity)
      throw new MemberLocalSecretError('unavailable');
    return live;
  };
  const address = (slot: string) => {
    const match = /^zhuma\.member-local\.(device|accept|run-pointer)\.([a-f0-9]{64})$/u.exec(slot);
    if (!match) throw new MemberLocalSecretError('invalid');
    return credentialKey('zhuma-workbench', `member-local-${match[1]}-${match[2]}`);
  };
  const payload = (record: CredentialRecord | undefined): unknown => {
    if (record === undefined) return undefined;
    if (record.kind !== 'grant' || record.payload === undefined)
      throw new MemberLocalSecretError('unavailable');
    return record.payload;
  };
  const run = async (operation: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  };
  return {
    read: (slot) =>
      run(async () => {
        const key = address(slot);
        const record = await current().readRecord(key);
        current();
        return payload(record);
      }),
    modify: (slot, update) =>
      run(async () => {
        const key = address(slot);
        const record = await current().modifyRecord(key, async (record) => {
          current();
          const next = update(payload(record));
          return next === undefined ? undefined : { kind: 'grant', payload: next };
        });
        current();
        // Only the provider's durable post-update value is returned. Never expose
        // an uncommitted candidate or implement a separate read/write lock.
        return payload(record);
      }),
  };
}
