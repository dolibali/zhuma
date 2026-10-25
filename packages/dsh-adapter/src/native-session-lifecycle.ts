import type {
  AgentHandle,
  AgentRegistry,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent';

/** Host-only lifecycle policy. This is never a member transport or model input. */
export interface NativeInboxRetentionOptions {
  readonly retainPendingInboxOnDispose?: boolean;
}
export type RetainedInboxCreateOptions = CreateAgentOptions & NativeInboxRetentionOptions;
export type RetainedInboxResumeOptions = ResumeAgentOptions & NativeInboxRetentionOptions;

/** Compatibility surface for the fixed SDK plus our explicit lifecycle capability patch. */
export interface RetainedInboxAgentRegistry extends AgentRegistry {
  readonly lifecycleCapabilities: Readonly<{ retainPendingInboxOnDispose: true }>;
  create(options: RetainedInboxCreateOptions): Promise<AgentHandle>;
  resume(options: RetainedInboxResumeOptions): Promise<AgentHandle>;
}

export class NativeInboxRetentionUnsupportedError extends Error {
  readonly code = 'native-inbox-retention-unsupported';
  constructor() {
    super('The active native runtime does not support retaining pending input on disposal.');
    this.name = 'NativeInboxRetentionUnsupportedError';
  }
}

/**
 * Inspect the real registered factory, without creating/resuming anything.
 * The patched registry rechecks support at each create/resume, so a factory
 * change after this check cannot turn an opted-in request into silent fallback.
 */
export function requireNativeInboxRetention(registry: AgentRegistry): RetainedInboxAgentRegistry {
  let supported = false;
  try {
    const capabilities: unknown = Reflect.get(registry, 'lifecycleCapabilities');
    supported =
      capabilities !== null &&
      typeof capabilities === 'object' &&
      Reflect.get(capabilities, 'retainPendingInboxOnDispose') === true;
  } catch {
    throw new NativeInboxRetentionUnsupportedError();
  }
  if (!supported) throw new NativeInboxRetentionUnsupportedError();
  return registry as RetainedInboxAgentRegistry;
}
