import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';

export const CODEARTS_PROFILE_ID = 'zhuma-codearts';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const profileSchema = z.strictObject({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  loginHint: z.string().optional(),
  runtime: z.string().optional(),
  catalogId: z.string().optional(),
});
export interface CodeArtsAcpProfile {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly loginHint?: string;
  readonly runtime?: string;
  readonly catalogId?: string;
}
export interface CodeArtsLaunchArtifact {
  readonly path: string;
  readonly sha256: string;
}
export interface CodeArtsProfileRegistration {
  /** Process-local identity, never serialize it as authority. */
  readonly generation: object;
  readonly profileId: typeof CODEARTS_PROFILE_ID;
  readonly profile: Readonly<CodeArtsAcpProfile>;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  /** Pass the complete actual current registry config, including env/argv. */
  matches(profileId: string, profile: unknown): boolean;
  guardForProfile(profileId: string, profile: unknown): (() => boolean) | undefined;
  revoke(): void;
}
export class CodeArtsRegistrationError extends Error {
  constructor() {
    super('CodeArts launch registration rejected');
    this.name = 'CodeArtsRegistrationError';
  }
}

function stamp(path: string): string {
  const value = statSync(path, { bigint: true });
  if (!value.isFile()) throw new CodeArtsRegistrationError();
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
}

/** Explicit producer operation; performs file verification, never launches a CLI/model. */
export async function createCodeArtsProfileRegistration(input: {
  readonly node: CodeArtsLaunchArtifact;
  readonly adapter: CodeArtsLaunchArtifact;
  readonly launcher: CodeArtsLaunchArtifact;
  readonly signal: AbortSignal;
}): Promise<CodeArtsProfileRegistration> {
  const verified: { path: string; stamp: string }[] = [];
  try {
    input.signal.throwIfAborted();
    for (const artifact of [input.node, input.adapter, input.launcher]) {
      if (!isAbsolute(artifact.path) || !digest.safeParse(artifact.sha256).success)
        throw new CodeArtsRegistrationError();
      const path = await realpath(artifact.path);
      const before = stamp(path);
      const hash = createHash('sha256');
      const stream = createReadStream(path, { signal: input.signal });
      for await (const chunk of stream) hash.update(chunk);
      if (hash.digest('hex') !== artifact.sha256 || before !== stamp(path))
        throw new CodeArtsRegistrationError();
      verified.push({ path, stamp: before });
    }
    input.signal.throwIfAborted();
  } catch {
    throw new CodeArtsRegistrationError();
  }
  const [node, adapter, launcher] = verified;
  if (!node || !adapter || !launcher) throw new CodeArtsRegistrationError();
  const profile = Object.freeze({
    name: 'CodeArts',
    loginHint: '在码道 CLI 完成登录并信任工作目录后，再检查连接。',
    command: node.path,
    args: Object.freeze([adapter.path, '--codearts-command', launcher.path]),
    env: Object.freeze({ ELECTRON_RUN_AS_NODE: '1' }),
  });
  const expected = canonicalPayload(profile);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const revoke = (): void => lifetime.abort();
  const isCurrent = (): boolean => {
    if (signal.aborted) return false;
    try {
      if (verified.every((file) => stamp(file.path) === file.stamp)) return true;
    } catch {
      /* revoke below */
    }
    revoke();
    return false;
  };
  const matches = (profileId: string, actual: unknown): boolean => {
    if (profileId !== CODEARTS_PROFILE_ID || !isCurrent()) return false;
    const parsed = profileSchema.safeParse(actual);
    if (parsed.success && canonicalPayload(parsed.data) === expected) return true;
    // A changed/removed current profile permanently retires this generation.
    revoke();
    return false;
  };
  return Object.freeze({
    generation: Object.freeze(Object.create(null) as object),
    profileId: CODEARTS_PROFILE_ID,
    profile,
    signal,
    isCurrent,
    matches,
    guardForProfile(profileId: string, actual: unknown): (() => boolean) | undefined {
      return matches(profileId, actual) ? () => isCurrent() : undefined;
    },
    revoke,
  });
}

/** One Host producer; replacing/disposal revokes all previously handed-out guards. */
export class CodeArtsProfileRegistrationProducer {
  #revision = 0;
  #current: CodeArtsProfileRegistration | undefined;
  async prepare(
    input: Parameters<typeof createCodeArtsProfileRegistration>[0],
  ): Promise<CodeArtsProfileRegistration> {
    const revision = ++this.#revision;
    this.#current?.revoke();
    this.#current = undefined;
    const registration = await createCodeArtsProfileRegistration(input);
    if (revision !== this.#revision || input.signal.aborted) {
      registration.revoke();
      throw new CodeArtsRegistrationError();
    }
    this.#current = registration;
    return registration;
  }
  guardForProfile(profileId: string, profile: unknown): (() => boolean) | undefined {
    return this.#current?.guardForProfile(profileId, profile);
  }
  dispose(): void {
    this.#revision++;
    this.#current?.revoke();
    this.#current = undefined;
  }
}
