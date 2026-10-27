import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { canonicalPayload } from '@zhuma/agent-core';
import type { NativeSessionBinding, NativeWorkGrant } from './native-work-session-contract.js';
import { NativeWorkError } from './native-work-session-contract.js';
import { NATIVE_WORK_LIMITS } from './native-work-session.js';

export interface NativeReviewMessageClaim {
  readonly nativeSessionId: string;
  readonly nativeAgentId: string;
  readonly messageId: string;
  readonly sequence: number;
}

/** Created in unpublished compose. Only actual SDK instance/session events are
 * correlated here; callbacks are wakeups, never D authority or fixed results. */
export function observeNativeReview(
  ctx: Context,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  callbacks: {
    claim(value: NativeReviewMessageClaim): void;
    idle(): void;
    fault(kind: 'error' | 'disposed'): void;
  },
) {
  if (canonicalPayload(binding.scope) !== canonicalPayload(grant.scope))
    throw new NativeWorkError('scope-mismatch');
  const lifetime = new AbortController();
  const claims = new Map<string, NativeReviewMessageClaim>();
  const stops: (() => unknown)[] = [];
  let published: Agent | undefined;
  let detached = false;
  const current = (agent: Agent) =>
    !lifetime.signal.aborted &&
    !detached &&
    agent === published &&
    agent.id === binding.nativeAgentId &&
    agent.session.id === binding.nativeSessionId &&
    ctx.agents.get(agent.id) === agent;
  const invoke = (callback: () => void) => {
    try {
      const result: unknown = callback();
      void Promise.resolve(result).catch(() => close());
    } catch {
      close();
    }
  };
  function close() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    published = undefined;
    claims.clear();
    grant.signal.removeEventListener('abort', close);
    for (const stop of stops.splice(0)) stop();
  }
  function detach() {
    detached = true;
    published = undefined;
    for (const stop of stops.splice(0)) stop();
  }
  stops.push(
    ctx.on(
      'agent/created',
      ({ agent }) => {
        if (
          !lifetime.signal.aborted &&
          agent.id === binding.nativeAgentId &&
          agent.session.id === binding.nativeSessionId &&
          ctx.agents.get(agent.id) === agent
        )
          published = agent;
        return undefined;
      },
      { global: true },
    ),
    ctx.on(
      'session/event',
      (session, event) => {
        if (
          !published ||
          !current(published) ||
          session !== published.session ||
          event.type !== 'user/message'
        )
          return;
        const messageId = event.data.id;
        if (claims.has(messageId)) return;
        if (claims.size >= NATIVE_WORK_LIMITS.receipts) {
          invoke(() => callbacks.fault('error'));
          close();
          return;
        }
        const value = Object.freeze({
          nativeSessionId: binding.nativeSessionId,
          nativeAgentId: binding.nativeAgentId,
          messageId,
          sequence: event.seq,
        });
        claims.set(messageId, value);
        invoke(() => callbacks.claim(value));
      },
      { global: true },
    ),
    ctx.on(
      'agent/status',
      ({ agent, status }) => {
        if (current(agent) && status === 'idle') invoke(callbacks.idle);
      },
      { global: true },
    ),
    ctx.on(
      'agent/error',
      ({ agent }) => {
        if (current(agent)) invoke(() => callbacks.fault('error'));
      },
      { global: true },
    ),
    ctx.on(
      'agent/disposed',
      ({ agent }) => {
        if (agent !== published || lifetime.signal.aborted) return;
        // Expected fixed-result retirement also disposes this Agent. It is only
        // a wakeup for the original issuer; absence must never certify failure/drain.
        invoke(() => callbacks.fault('disposed'));
        // A fast fixed retirement can precede send() returning its receipt.
        // Keep bounded actual claim correlations until the bridge joins that
        // receipt or explicitly releases the state, without observing new work.
        detach();
      },
      { global: true },
    ),
  );
  grant.signal.addEventListener('abort', close, { once: true });
  if (grant.signal.aborted) close();
  ctx.effect(() => detach);
  return {
    signal: lifetime.signal,
    claimFor(messageId: string) {
      return lifetime.signal.aborted ? undefined : claims.get(messageId);
    },
    close,
  };
}
