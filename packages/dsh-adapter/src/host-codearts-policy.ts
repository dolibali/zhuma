import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  CodeArtsProfileRegistrationProducer,
  type CodeArtsProfileRegistration,
} from './executors/codearts/registration.js';
export { createCodeArtsProfileRegistration } from './executors/codearts/registration.js';

const artifact = z.strictObject({
  path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const Config = z.strictObject({
  artifacts: z.strictObject({ node: artifact, adapter: artifact, launcher: artifact }).optional(),
});
export const name = 'zhuma-codearts-policy';
export const inject: string[] = [];
export interface HostCodeArtsPolicy {
  guardForProfile(profileId: string, profile: unknown): (() => boolean) | undefined;
}

/** The product Loader makes the ORIGINAL ACP plugin depend on this service.
 * Only a successful original producer.prepare publishes it. Empty config
 * preserves ordinary ACP profiles without granting CodeArts native handoff. */
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const config = Config.parse(raw),
    lifetime = new AbortController(),
    producer = new CodeArtsProfileRegistrationProducer();
  let registration: CodeArtsProfileRegistration | undefined;
  ctx.effect(() => () => {
    lifetime.abort();
    producer.dispose();
  });
  try {
    if (config.artifacts)
      registration = await producer.prepare({ ...config.artifacts, signal: lifetime.signal });
    lifetime.signal.throwIfAborted();
    const policy: HostCodeArtsPolicy = Object.freeze({
      guardForProfile(id: string, profile: unknown) {
        if (lifetime.signal.aborted) return undefined;
        return producer.guardForProfile(id, profile);
      },
    });
    const unprovide = ctx.provide('acpNativeToolHandoffPolicy', policy);
    ctx.effect(() => () => {
      lifetime.abort();
      registration?.revoke();
      producer.dispose();
      unprovide();
    });
  } catch {
    lifetime.abort();
    producer.dispose();
    // Private executable paths and underlying filesystem errors stay private.
    throw new Error('CodeArts launch artifacts are unavailable or changed.');
  }
}
