import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  CodeArtsProfileRegistrationProducer,
  type CodeArtsProfileRegistration,
  CODEARTS_PROFILE_ID,
} from './executors/codearts/registration.js';
import { describeCodeArtsRoutingCapability } from './executors/codearts/routing-metadata.js';
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
  currentRoutingCapability():
    | {
        readonly provider: string;
        readonly capability: ReturnType<typeof describeCodeArtsRoutingCapability>;
      }
    | undefined;
}
const record = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);

/** The Loader's original persisted/volatile entry is the full profile source.
 * Its public options are read only in this Host closure, never sent to Client.
 * No probe cache, name heuristic or reconstructed configuration is accepted. */
function currentProfile(ctx: Context): unknown {
  if (!ctx.get('dshAcp')) return undefined;
  const loader: unknown = ctx.get('loader');
  if (!record(loader) || typeof loader.entries !== 'function') return undefined;
  const rows: unknown = Reflect.apply(loader.entries, loader, []);
  if (!rows || typeof Reflect.get(Object(rows), Symbol.iterator) !== 'function') return undefined;
  let count = 0,
    found: unknown,
    matches = 0;
  for (const entry of rows as Iterable<unknown>) {
    if (++count > 512) return undefined;
    if (
      !record(entry) ||
      !record(entry.options) ||
      entry.options.id !== 'dsh-acp-adapter' ||
      entry.options.name !== '@zaimokuza/dsh-acp-adapter'
    )
      continue;
    matches++;
    const config = entry.options.config;
    if (!record(config) || !record(config.agents)) continue;
    found = config.agents[CODEARTS_PROFILE_ID];
  }
  return matches === 1 ? found : undefined;
}

/** The product Loader makes the ORIGINAL ACP plugin depend on this service.
 * Only successful original producer.prepare grants a guard. Empty or stale
 * artifacts keep original settings available with no CodeArts handoff/route. */
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
  } catch {
    producer.dispose();
    lifetime.signal.throwIfAborted();
    // Upgrading changes the artifact: retain the normal settings/reconfigure
    // path, but never recover an old guard or declare this generation ready.
    ctx.logger.warn('CodeArts launch artifacts changed; configure CodeArts again.');
  }
  lifetime.signal.throwIfAborted();
  const policy: HostCodeArtsPolicy = Object.freeze({
    guardForProfile(id: string, profile: unknown) {
      if (lifetime.signal.aborted) return undefined;
      return producer.guardForProfile(id, profile);
    },
    currentRoutingCapability() {
      if (lifetime.signal.aborted || !registration?.isCurrent()) return undefined;
      const profile = currentProfile(ctx);
      if (!record(profile)) return undefined;
      const guard = producer.guardForProfile(CODEARTS_PROFILE_ID, profile);
      if (!guard?.()) return undefined;
      return Object.freeze({
        provider: `acp-${CODEARTS_PROFILE_ID}`,
        capability: describeCodeArtsRoutingCapability(),
      });
    },
  });
  const unprovide = ctx.provide('acpNativeToolHandoffPolicy', policy);
  ctx.effect(() => () => {
    lifetime.abort();
    registration?.revoke();
    producer.dispose();
    unprovide();
  });
}

/** A passive route declaration is never vendor/model/authentication readiness. */
export function readPreparedCodeArtsRoute(ctx: Context) {
  const policy: unknown = ctx.get('acpNativeToolHandoffPolicy');
  if (!record(policy) || typeof policy.currentRoutingCapability !== 'function') return undefined;
  const value: unknown = Reflect.apply(policy.currentRoutingCapability, policy, []),
    declared = describeCodeArtsRoutingCapability();
  if (
    !record(value) ||
    value.provider !== `acp-${CODEARTS_PROFILE_ID}` ||
    !record(value.capability)
  )
    return undefined;
  const capability = value.capability;
  if (
    Object.keys(capability).length !== Object.keys(declared).length ||
    Object.entries(declared).some(([key, field]) => capability[key] !== field)
  )
    return undefined;
  return { provider: value.provider, capability: declared };
}
