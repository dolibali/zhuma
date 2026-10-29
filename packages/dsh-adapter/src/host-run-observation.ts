import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  NativeWorkError,
  type NativeSessionBinding,
  type NativeWorkGrant,
} from './native-work-session-contract.js';
import { NATIVE_WORK_LIMITS } from './native-work-session.js';

export interface HostNativeClaim {
  readonly nativeSessionId: string;
  readonly nativeAgentId: string;
  readonly messageId: string;
  readonly sequence: number;
}

/** Install inside unpublished C compose, before Factory publication/wakeup.
 * These are bounded correlation facts, not Run authority or transcript copies.
 */
export function observeHostNativeRun(
  ctx: Context,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
) {
  if (canonicalPayload(binding.scope) !== canonicalPayload(grant.scope))
    throw new NativeWorkError('scope-mismatch');
  const lifetime = new AbortController();
  const claims = new Map<string, HostNativeClaim>();
  const listeners = new Set<(claim: HostNativeClaim) => void>();
  const failures = new Set<() => void>();
  const stops: (() => unknown)[] = [];
  let published: Agent | undefined;
  let failed = false;
  function fault() {
    if (failed || lifetime.signal.aborted) return;
    failed = true;
    for (const listener of failures) {
      try {
        const pending: unknown = listener();
        void Promise.resolve(pending).catch(() => close());
      } catch {
        close();
        return;
      }
    }
  }
  function close() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    published = undefined;
    claims.clear();
    listeners.clear();
    failures.clear();
    grant.signal.removeEventListener('abort', close);
    for (const stop of stops.splice(0)) stop();
  }
  function detach() {
    published = undefined;
    for (const stop of stops.splice(0)) stop();
  }
  const matches = (agent: Agent) =>
    agent.id === binding.nativeAgentId && agent.session.id === binding.nativeSessionId;
  stops.push(
    ctx.on(
      'agent/created',
      ({ agent }) => {
        if (!lifetime.signal.aborted && matches(agent)) {
          try {
            if (ctx.agents.get(agent.id) === agent) published = agent;
          } catch {
            close();
          }
        }
        // Serial initialization must never wait on its own queued work.
        return undefined;
      },
      { global: true },
    ),
    ctx.on(
      'agent/disposed',
      ({ agent }) => {
        if (agent === published) {
          fault();
          // Fast fixed-result retirement may precede send() returning its
          // receipt. Keep only bounded actual claims for that receipt join.
          detach();
        }
      },
      { global: true },
    ),
    ctx.on(
      'agent/error',
      ({ agent }) => {
        // Only the real instance matters; raw error text may contain private
        // content and must never enter this correlation/Run metadata bridge.
        if (agent === published) fault();
      },
      { global: true },
    ),
    ctx.on(
      'session/event',
      (session, event) => {
        if (
          lifetime.signal.aborted ||
          !published ||
          session.id !== binding.nativeSessionId ||
          event.type !== 'user/message'
        )
          return;
        const messageId = event.data.id;
        if (claims.has(messageId)) return;
        if (claims.size >= NATIVE_WORK_LIMITS.receipts) {
          close();
          return;
        }
        const claim = Object.freeze({
          nativeSessionId: binding.nativeSessionId,
          nativeAgentId: binding.nativeAgentId,
          messageId,
          sequence: event.seq,
        });
        claims.set(messageId, claim);
        for (const listener of listeners) {
          try {
            // The owner tracks its persistence job; it cannot hold SDK append
            // or Factory initialization waiting for a model or its own close.
            const pending: unknown = listener(claim);
            void Promise.resolve(pending).catch(() => close());
          } catch {
            close();
            return;
          }
        }
      },
      { global: true },
    ),
  );
  grant.signal.addEventListener('abort', close, { once: true });
  if (grant.signal.aborted) close();
  ctx.effect(() => detach);
  return {
    signal: lifetime.signal,
    claimFor(messageId: string): HostNativeClaim | undefined {
      return lifetime.signal.aborted ? undefined : claims.get(messageId);
    },
    onClaim(listener: (claim: HostNativeClaim) => void): () => void {
      if (!lifetime.signal.aborted) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onFault(listener: () => void): () => void {
      if (!lifetime.signal.aborted) failures.add(listener);
      return () => {
        failures.delete(listener);
      };
    },
    close,
  };
}
