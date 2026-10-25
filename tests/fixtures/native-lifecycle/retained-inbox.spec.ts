// Copied beside the fixed upstream tests by verify-native-lifecycle.mjs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { MockAdapter, textResponse } from './mock-adapter.ts';

function pending(text = 'pending') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'zhuma-retention-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function boot(root: string) {
  const ctx = new Context();
  const adapter = new MockAdapter([textResponse('unexpected generation')]);
  onTestFinished(() => ctx.fiber.dispose());
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(JsonlSessionPersistence, { root });
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(['mock'], adapter);
  return { ctx, adapter };
}
const agentOptions = { provider: 'mock', model: 'mock' };

it.each([false, true])(
  'only explicit retention survives stop, dispose and reopen: %s',
  async (retain) => {
    const root = directory();
    const first = await boot(root);
    expect(first.ctx.agents.lifecycleCapabilities.retainPendingInboxOnDispose).toBe(true);
    const id = SessionId(`retain-${retain}`);
    const handle = await first.ctx.agents.create({
      sessionId: id,
      agentOptions,
      retainPendingInboxOnDispose: retain,
    });
    const message = pending();
    handle.agent.send(message, 'next-turn', false);
    handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await handle.agent.whenIdle();
    expect(handle.agent.inbox.nextTurn.map((item) => item.id)).toEqual([message.id]);
    await handle.dispose();
    await first.ctx.fiber.dispose();
    const second = await boot(root);
    const restored = await second.ctx.agents.resume({
      resumeSessionId: id,
      agentOptions,
      retainPendingInboxOnDispose: retain,
    });
    expect(restored.agent.inbox.nextTurn.map((item) => item.id)).toEqual(
      retain ? [message.id] : [],
    );
    expect(second.adapter.requests).toHaveLength(0);
  },
);

it('explicit clear still durably removes input from a retained lifecycle', async () => {
  const root = directory();
  const first = await boot(root);
  const id = SessionId('retain-clear');
  const handle = await first.ctx.agents.create({
    sessionId: id,
    agentOptions,
    retainPendingInboxOnDispose: true,
  });
  handle.agent.send(pending(), 'next-turn', false);
  handle.agent.inbox.clear();
  await handle.dispose();
  await first.ctx.fiber.dispose();
  const second = await boot(root);
  const restored = await second.ctx.agents.resume({
    resumeSessionId: id,
    agentOptions,
    retainPendingInboxOnDispose: true,
  });
  expect(restored.agent.inbox.nextTurn).toEqual([]);
  expect(second.adapter.requests).toHaveLength(0);
});

it.each(['handle', 'host'] as const)(
  'seals a latched wake before %s disposal without losing pending input',
  async (owner) => {
    const root = directory();
    const first = await boot(root);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    let requests = 0;
    first.ctx.on('agent/request', async (_event, next) => {
      ++requests;
      entered.resolve();
      await release.promise;
      return next();
    });
    const id = SessionId(`retain-wake-${owner}`);
    const handle = await first.ctx.agents.create({
      sessionId: id,
      agentOptions,
      retainPendingInboxOnDispose: true,
    });
    handle.agent.followup(pending('running'));
    await entered.promise;
    handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    const queued = pending('latched');
    handle.agent.followup(queued);
    const cancelling = Promise.withResolvers<void>();
    const cancel = handle.agent.cancel.bind(handle.agent);
    vi.spyOn(handle.agent, 'cancel').mockImplementation((cause, options) => {
      cancel(cause, options);
      if (cause.kind === 'disposed') cancelling.resolve();
    });
    const disposal = owner === 'handle' ? handle.dispose() : first.ctx.fiber.dispose();
    await cancelling.promise;
    expect(() => handle.agent.followup(pending('late'))).toThrow('lifecycle is disposed');
    release.resolve();
    await disposal;
    expect(requests).toBe(1);
    await first.ctx.fiber.dispose();
    const second = await boot(root);
    const restored = await second.ctx.agents.resume({
      resumeSessionId: id,
      agentOptions,
      retainPendingInboxOnDispose: true,
    });
    expect(restored.agent.inbox.nextTurn.map((item) => item.id)).toEqual([queued.id]);
    expect(second.adapter.requests).toHaveLength(0);
  },
);

it('opt-in does not retain an unpublished failed setup lifecycle', async () => {
  const first = await boot(directory());
  let unpublished: Agent | undefined;
  await expect(
    first.ctx.agents.create({
      sessionId: SessionId('retain-setup-failed'),
      agentOptions,
      retainPendingInboxOnDispose: true,
      setup: (_ctx, agent) => {
        unpublished = agent;
        agent.send(pending(), 'next-turn', false);
        throw new Error('setup failed');
      },
    }),
  ).rejects.toThrow('setup failed');
  expect(
    unpublished?.session
      .snapshotEvents()
      .some((event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'),
  ).toBe(true);
  expect(first.adapter.requests).toHaveLength(0);
});

it('an unsupported factory rejects opt-in before invoking either write path', async () => {
  const ctx = new Context();
  onTestFinished(() => ctx.fiber.dispose());
  await mountAgentLoopTestDependencies(ctx);
  let calls = 0;
  ctx.agents.setFactory({
    async createAgent() {
      ++calls;
      throw new Error('unexpected create');
    },
    async resume() {
      ++calls;
      throw new Error('unexpected resume');
    },
  });
  expect(ctx.agents.lifecycleCapabilities.retainPendingInboxOnDispose).toBe(false);
  await expect(
    ctx.agents.create({ sessionId: SessionId('unsupported'), retainPendingInboxOnDispose: true }),
  ).rejects.toThrow('does not support retainPendingInboxOnDispose');
  await expect(
    ctx.agents.resume({
      resumeSessionId: SessionId('unsupported'),
      retainPendingInboxOnDispose: true,
    }),
  ).rejects.toThrow('does not support retainPendingInboxOnDispose');
  expect(calls).toBe(0);
});
