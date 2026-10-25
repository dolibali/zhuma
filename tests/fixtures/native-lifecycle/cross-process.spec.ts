// The verifier runs write/read in separate Vitest/Node processes on the same private disk.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { MockAdapter, textResponse } from './mock-adapter.ts';

it('retains the exact pending message across a real process boundary without a model request', async () => {
  const root = process.env.ZHUMA_RETENTION_TEST_ROOT;
  const mode = process.env.ZHUMA_RETENTION_TEST_MODE;
  if (!root || !['write', 'read'].includes(mode ?? ''))
    throw new Error('verifier-owned test scope required');
  const ctx = new Context();
  try {
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(JsonlSessionPersistence, { root });
    await ctx.plugin(AgentLoop, { agents: [] });
    const adapter = new MockAdapter([textResponse('unexpected request')]);
    ctx.llm.registerAdapter(['mock'], adapter);
    const id = SessionId('retention-process');
    const agentOptions = { provider: 'mock', model: 'mock' };
    if (mode === 'write') {
      const handle = await ctx.agents.create({
        sessionId: id,
        agentOptions,
        retainPendingInboxOnDispose: true,
      });
      const message = createUserMessage({
        content: [{ type: 'text', text: 'persist' }],
        source: { kind: 'user' },
      });
      handle.agent.send(message, 'next-turn', false);
      handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
      await handle.agent.whenIdle();
      writeFileSync(join(root, 'expected-message.json'), JSON.stringify({ id: message.id }));
    } else {
      const expected: unknown = JSON.parse(
        readFileSync(join(root, 'expected-message.json'), 'utf8'),
      );
      if (
        !expected ||
        typeof expected !== 'object' ||
        !('id' in expected) ||
        typeof expected.id !== 'string'
      )
        throw new Error('invalid fixture receipt');
      const handle = await ctx.agents.resume({
        resumeSessionId: id,
        agentOptions,
        retainPendingInboxOnDispose: true,
      });
      expect(handle.agent.inbox.nextTurn.map((message) => message.id)).toEqual([expected.id]);
    }
    expect(adapter.requests).toHaveLength(0);
  } finally {
    await ctx.fiber.dispose();
  }
});
