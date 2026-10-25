import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent';
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-tools';
import {
  NativeWorkError,
  type NativeHistoryEvent,
  type NativeMessageMode,
  type NativeSessionBinding,
  type NativeSessionMessage,
  type NativeWorkFrame,
  type NativeWorkGrant,
  type NativeWorkRuntime,
} from './native-work-session-contract.js';

const MAX_FRAME_BYTES = 262_144;
const MAX_BUFFER_BYTES = 524_288;
const MAX_BUFFER_FRAMES = 128;
const STOP_MS = 5_000;

interface LiveSession {
  readonly handle: AgentHandle;
  readonly grant: NativeWorkGrant;
  readonly binding: NativeSessionBinding;
  readonly revoke: () => void;
}

export interface NativeDshComposition {
  /** Already-authorized task goal and bounded fixed-reference catalog, not source bodies. */
  readonly context: string;
  /** Actual scoped tool names. Empty means no tools; absence never enables defaults. */
  readonly toolAllowlist: readonly string[];
}

export interface NativeDshOptions {
  /** Host-owned scoped composition, before native publication; never drives the Agent. */
  compose(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): NativeDshComposition | Promise<NativeDshComposition>;
}

function current(grant: NativeWorkGrant): void {
  if (grant.signal.aborted) throw new NativeWorkError('cancelled');
  grant.assertCurrent('open');
}

function identified(message: NativeSessionMessage): UserMessage {
  return Object.freeze({
    id: MessageId(message.id),
    role: 'user',
    content: Object.freeze([{ type: 'text' as const, text: message.text }]),
    source: Object.freeze({ kind: 'user' as const }),
  });
}

function textOf(message: UserMessage): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** Public DSH registry adapter. No child process, replacement factory, or transcript cache. */
export class DshNativeWorkRuntime implements NativeWorkRuntime {
  private readonly live = new Map<string, LiveSession>();
  private readonly connecting = new Map<
    string,
    { readonly promise: Promise<void>; readonly abort: AbortController }
  >();
  private readonly lifetime = new AbortController();

  constructor(
    private readonly ctx: Context,
    private readonly options: NativeDshOptions,
  ) {}

  async connect(
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    allowCreate: boolean,
  ): Promise<void> {
    current(grant);
    if (this.lifetime.signal.aborted) throw new NativeWorkError('unavailable');
    const live = this.live.get(binding.nativeSessionId);
    if (live) {
      this.agent(binding.nativeSessionId);
      return;
    }
    const prior = this.connecting.get(binding.nativeSessionId);
    if (prior) {
      await prior.promise;
      current(grant);
      return;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([grant.signal, abort.signal, this.lifetime.signal]);
    const promise = this.attach(binding, grant, signal, allowCreate);
    this.connecting.set(binding.nativeSessionId, { promise, abort });
    try {
      await promise;
    } finally {
      if (this.connecting.get(binding.nativeSessionId)?.promise === promise)
        this.connecting.delete(binding.nativeSessionId);
    }
  }

  private async attach(
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    signal: AbortSignal,
    allowCreate: boolean,
  ): Promise<void> {
    const id = SessionId(binding.nativeSessionId);
    // Never adopt another consumer's same-id handle or global owner session.
    if (this.ctx.agents.get(id)) throw new NativeWorkError('unavailable');
    const stored = await this.ctx.sessionPersistence.stat(id, { signal });
    signal.throwIfAborted();
    current(grant);
    if (!stored && !allowCreate) throw new NativeWorkError('delivery-unknown');
    const setup: AgentSetup = async (agentCtx) => {
      current(grant);
      const composition = await this.options.compose(agentCtx, structuredClone(binding), grant);
      signal.throwIfAborted();
      current(grant);
      if (
        typeof composition.context !== 'string' ||
        composition.context.length > 20_000 ||
        composition.toolAllowlist.length > 100
      )
        throw new NativeWorkError('invalid-request');
      agentCtx.tools.restrict({ allow: [...composition.toolAllowlist] });
      agentCtx.systemPrompt.context({
        name: 'zhuma-work',
        order: 10,
        text: composition.context,
        interpolate: false,
        required: true,
      });
      agentCtx.on('agent/pre-step', async (_payload, next) => {
        current(grant);
        grant.assertCurrent('send');
        const result = await next();
        current(grant);
        return result;
      });
      agentCtx.on('tools/pre-execute', async (_exec, next) => {
        current(grant);
        grant.assertCurrent('send');
        return next();
      });
      agentCtx.on('agent/request', async (_payload, next) => {
        current(grant);
        grant.assertCurrent('send');
        const config = await next();
        current(grant);
        if (
          config.provider !== binding.selection.provider ||
          config.model !== binding.selection.model
        )
          throw new NativeWorkError('configuration-mismatch');
        return config;
      });
      return { commit: () => current(grant) };
    };
    const { configurationId: _configurationId, reasoningEffort, ...selection } = binding.selection;
    const agentOptions = {
      ...selection,
      ...(reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    };
    const handle = stored
      ? await this.ctx.agents.resume({ resumeSessionId: id, agentOptions, setup, signal })
      : await this.ctx.agents.create({ sessionId: id, agentOptions, setup, signal });
    if (signal.aborted) {
      await handle.dispose();
      throw new NativeWorkError('cancelled');
    }
    try {
      current(grant);
    } catch (error) {
      await handle.dispose();
      throw error;
    }
    if (
      handle.agent.id !== id ||
      handle.agent.options.provider !== binding.selection.provider ||
      handle.agent.options.model !== binding.selection.model
    ) {
      await handle.dispose();
      throw new NativeWorkError('configuration-mismatch');
    }
    const revoke = () => {
      // Revocation cannot wake parked input or grant authority to a late frame.
      handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true });
      void handle.agent
        .whenIdle()
        .then(() => this.disconnect(binding.nativeSessionId))
        .catch(() => undefined);
    };
    this.live.set(binding.nativeSessionId, {
      handle,
      binding: structuredClone(binding),
      grant,
      revoke,
    });
    grant.signal.addEventListener('abort', revoke, { once: true });
    if (grant.signal.aborted) revoke();
  }

  private agent(sessionId: string): Agent {
    const live = this.live.get(sessionId);
    if (!live) throw new NativeWorkError('not-started');
    current(live.grant);
    if (this.ctx.agents.get(SessionId(sessionId)) !== live.handle.agent)
      throw new NativeWorkError('unavailable');
    return live.handle.agent;
  }

  isConnected(sessionId: string): boolean {
    return this.live.has(sessionId);
  }
  status(sessionId: string) {
    return this.agent(sessionId).status;
  }
  pending(sessionId: string) {
    const inbox = this.agent(sessionId).inbox;
    return [
      ...inbox.nextTurn.map((message) => ({
        id: message.id,
        text: textOf(message),
        target: 'next-turn' as const,
      })),
      ...inbox.nextStep.map((message) => ({
        id: message.id,
        text: textOf(message),
        target: 'next-step' as const,
      })),
    ];
  }

  send(sessionId: string, message: NativeSessionMessage, mode: NativeMessageMode): void {
    const agent = this.agent(sessionId);
    const input = identified(message);
    if (mode === 'queue') agent.send(input, 'next-turn', false);
    else if (mode === 'steer') {
      if (agent.status !== 'running') throw new NativeWorkError('not-pending');
      agent.steer(input);
    } else agent.followup(input);
  }

  edit(sessionId: string, messageId: string, text: string): boolean {
    const agent = this.agent(sessionId);
    const old = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(
      (message) => message.id === messageId,
    );
    return old === undefined
      ? false
      : agent.inbox.replace(old.id, identified({ id: old.id, text }));
  }
  remove(sessionId: string, messageId: string): boolean {
    return this.agent(sessionId).inbox.remove(MessageId(messageId));
  }
  reorder(sessionId: string, messageIds: readonly string[]): void {
    const agent = this.agent(sessionId);
    const pending = agent.inbox.nextTurn;
    if (
      messageIds.length !== pending.length ||
      new Set(messageIds).size !== pending.length ||
      messageIds.some((id) => !pending.some((message) => message.id === id))
    )
      throw new NativeWorkError('not-pending');
    const byId = new Map(pending.map((message) => [message.id as string, message]));
    // One native durable splice, not remove/reinsert commands that claim cancellation.
    agent.inbox.splice(
      'next-turn',
      0,
      pending.length,
      messageIds.map((id) => byId.get(id)!),
    );
  }
  async stop(sessionId: string, signal: AbortSignal): Promise<'stopped' | 'pending'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), STOP_MS);
    });
    try {
      const settled = (async () => {
        const connecting = this.connecting.get(sessionId);
        if (connecting) {
          connecting.abort.abort();
          await connecting.promise.catch(() => undefined);
        }
        const live = this.live.get(sessionId);
        if (!live) return connecting ? ('stopped' as const) : ('pending' as const);
        live.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
        await live.handle.agent.whenIdle();
        await this.flush(sessionId);
        signal.throwIfAborted();
        return 'stopped' as const;
      })();
      return await Promise.race([settled, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async flush(sessionId: string): Promise<void> {
    const agent = this.live.get(sessionId)?.handle.agent;
    if (agent && !(await this.ctx.sessions.flush(agent.session)))
      throw new NativeWorkError('unavailable');
  }

  async history(
    sessionId: string,
    after: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly NativeHistoryEvent[]> {
    signal.throwIfAborted();
    await this.flush(sessionId);
    signal.throwIfAborted();
    const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'read', { signal });
    try {
      const result = await handle.read(after + 1, limit, { signal });
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(result.events)) > MAX_FRAME_BYTES)
        throw new NativeWorkError('capacity');
      return result.events;
    } finally {
      await handle.close();
    }
  }

  async messageStatus(
    sessionId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<'received' | 'claimed' | 'discarded' | 'absent'> {
    const pending = this.pending(sessionId);
    if (pending.some((message) => message.id === messageId)) return 'received';
    let after = -1;
    const queues: Record<string, string[]> = { 'next-turn': [], 'next-step': [] };
    let status: 'received' | 'claimed' | 'discarded' | 'absent' = 'absent';
    // Bounded reconciliation. Exhaustion is unknown, never permission to resend.
    for (let page = 0; page < 100; page++) {
      const events = await this.history(sessionId, after, 100, signal);
      for (const event of events) {
        const data = event.data as {
          readonly id?: string;
          readonly inserted?: readonly { readonly id?: string }[];
          readonly outcome?: string;
          readonly target?: string;
          readonly start?: number;
          readonly removedCount?: number;
        };
        if (event.type === 'user/message' && data.id === messageId) return 'claimed';
        if (
          event.type === 'agent/inbox/spliced' &&
          data.target !== undefined &&
          data.start !== undefined
        ) {
          const queue = queues[data.target];
          if (queue === undefined) continue;
          const inserted = (data.inserted ?? []).flatMap((item) =>
            item.id === undefined ? [] : [item.id],
          );
          const removed = queue.splice(data.start, data.removedCount ?? 0, ...inserted);
          if (inserted.includes(messageId)) status = 'received';
          else if (removed.includes(messageId))
            status = data.outcome === 'canceled' ? 'discarded' : 'claimed';
        }
      }
      if (events.length < 100) return status;
      after = events.at(-1)!.seq;
    }
    throw new NativeWorkError('delivery-unknown');
  }

  async *follow(
    sessionId: string,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<NativeWorkFrame> {
    signal.throwIfAborted();
    const queue: { readonly value: NativeWorkFrame; readonly bytes: number }[] = [];
    let bufferedBytes = 0;
    let overflow = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const push = (value: NativeWorkFrame) => {
      if (overflow || signal.aborted) return;
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (
        bytes > MAX_FRAME_BYTES ||
        queue.length >= MAX_BUFFER_FRAMES ||
        bufferedBytes + bytes > MAX_BUFFER_BYTES
      ) {
        overflow = true;
        queue.length = 0;
        bufferedBytes = 0;
        notify();
        return;
      }
      queue.push({ value, bytes });
      bufferedBytes += bytes;
      notify();
    };
    const stopEvent = this.ctx.on(
      'session/event',
      (session, event) => {
        if (session.id === sessionId) push({ type: 'event', event });
      },
      { global: true },
    );
    const stopStream = this.ctx.on(
      'agent/assistant-stream',
      ({ agent, frame }) => {
        if (agent.id === sessionId) push({ type: 'assistant-stream', frame });
      },
      { global: true },
    );
    const stopStatus = this.ctx.on(
      'agent/status',
      ({ agent, status }) => {
        if (agent.id === sessionId) push({ type: 'status', status });
      },
      { global: true },
    );
    const onAbort = () => notify();
    signal.addEventListener('abort', onAbort, { once: true });
    let cursor = after;
    try {
      // Subscribe first, then native durable history. The seq cursor drops overlap.
      for (;;) {
        const events = await this.history(sessionId, cursor, 100, signal);
        for (const event of events) {
          if (signal.aborted) return;
          cursor = event.seq;
          yield { type: 'event', event };
        }
        if (events.length < 100) break;
      }
      while (!signal.aborted) {
        if (overflow) {
          yield { type: 'gap', after: cursor };
          return;
        }
        const item = queue.shift();
        if (!item) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (signal.aborted) notify();
          });
          continue;
        }
        bufferedBytes -= item.bytes;
        if (item.value.type === 'event') {
          if (item.value.event.seq <= cursor) continue;
          cursor = item.value.event.seq;
        }
        yield item.value;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      stopStatus();
      stopStream();
      stopEvent();
      queue.length = 0;
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    live.grant.signal.removeEventListener('abort', live.revoke);
    await live.handle.dispose();
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.connecting.values()].map((value) => value.promise));
    const outcomes = await Promise.allSettled(
      [...this.live.keys()].map((id) => this.disconnect(id)),
    );
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new NativeWorkError('unavailable');
  }
}
