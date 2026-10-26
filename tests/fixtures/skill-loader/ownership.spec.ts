import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import {
  provideWorkingDirectoryFixture,
  unsupportedInbox,
} from '@deepseek-ai/dsh-agent-loop-testkit';
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent';
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import Skills from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';

function agent(ctx: Context, id: string): Agent {
  return {
    ctx,
    id: SessionId(id),
    options: {},
    session: Session.create(SessionId(id)),
    inbox: unsupportedInbox(),
    status: 'idle',
    send() {},
    followup() {},
    steer() {},
    inject() {
      throw new Error('unexpected direct inject');
    },
    cancel() {},
    runMaintenance: (task) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  };
}
function candidate(name: string) {
  return {
    name,
    description: 'late',
    source: 'runtime',
    provider: 'async-provider',
    rank: 1,
    locator: 1,
    invocation: { modelInvocable: true, userInvocable: true },
  };
}
async function fixture(order: 'parent-first' | 'local-first', empty = false) {
  const ctx = new Context();
  provideWorkingDirectoryFixture(ctx, '/workspace');
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(Skills);
  ctx.skills.register({
    name: 'private-secret',
    description: 'PRIVATE_DESCRIPTION',
    content: 'PRIVATE_BODY',
    source: 'runtime',
  });
  if (order === 'parent-first') await ctx.plugin(ToolSkill);
  const caller = agent(ctx, 'local-agent');
  const scope = createScope(ctx, caller);
  Object.defineProperty(caller, 'ctx', { value: scope.ctx, configurable: true });
  const isolated = scope.ctx.isolate('skills');
  await isolated.plugin(Skills);
  if (!empty) {
    isolated.get('skills')!.register({
      name: 'selected-skill',
      description: 'SELECTED_DESCRIPTION',
      content: 'SELECTED_BODY',
      source: 'runtime',
    });
    isolated.get('skills')!.register({
      name: 'user-only',
      description: 'USER_ONLY_DESCRIPTION',
      content: 'USER_ONLY_BODY',
      source: 'runtime',
      invocation: { modelInvocable: false, userInvocable: true },
    });
    isolated.get('skills')!.register({
      name: 'model-only',
      description: 'MODEL_ONLY_DESCRIPTION',
      content: 'MODEL_ONLY_BODY',
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: false },
    });
  }
  const loader = await isolated.plugin(ToolSkill);
  if (order === 'local-first') await ctx.plugin(ToolSkill);
  const step = async (text: string) => {
    const messages = [
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
    ];
    return agentEvents(ctx, caller).waterfall(
      'agent/pre-step',
      { messages, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    );
  };
  const execute = (name: string) =>
    ctx.tools.execute({
      name: 'skill',
      arguments: { name },
      agent: caller,
      callId: ToolCallId(name),
      signal: new AbortController().signal,
    });
  return { ctx, caller, scope, isolated, loader, step, execute };
}

describe('Zhuma scoped skill loader ownership', () => {
  for (const order of ['parent-first', 'local-first'] as const) {
    it(`does not load parent private body with ${order}`, async () => {
      const f = await fixture(order);
      try {
        const decision = await f.step('/private-secret /selected-skill /user-only /model-only');
        const rendered = JSON.stringify(decision);
        expect(rendered).not.toContain('PRIVATE_BODY');
        expect(rendered).not.toContain('PRIVATE_DESCRIPTION');
        expect(rendered).toContain('SELECTED_BODY');
        expect(rendered).toContain('USER_ONLY_BODY');
        expect(rendered).not.toContain('USER_ONLY_DESCRIPTION');
        expect(rendered).not.toContain('MODEL_ONLY_BODY');
        expect(rendered).toContain('MODEL_ONLY_DESCRIPTION');
        expect((await f.execute('selected-skill')).isError).toBe(false);
        expect((await f.execute('private-secret')).isError).toBe(true);
        expect((await f.execute('user-only')).isError).toBe(true);
        expect((await f.execute('model-only')).isError).toBe(false);
        const foreign = agent(f.ctx, 'foreign');
        const messages = [];
        const other = await agentEvents(f.ctx, foreign).waterfall(
          'agent/pre-step',
          { messages, turn: 1, step: 1, signal: new AbortController().signal },
          () => Promise.resolve({ kind: 'enter' as const, messages }),
        );
        expect(JSON.stringify(other)).toContain('PRIVATE_DESCRIPTION');
        expect(JSON.stringify(other)).not.toContain('SELECTED_DESCRIPTION');
      } finally {
        await f.scope.dispose();
        await f.ctx.fiber.dispose();
      }
    });
    it(`keeps empty/MCP-only skill domains empty with ${order}`, async () => {
      const f = await fixture(order, true);
      try {
        const result = await f.step('/private-secret');
        expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY');
        expect(JSON.stringify(result)).not.toContain('PRIVATE_DESCRIPTION');
        expect((await f.execute('private-secret')).isError).toBe(true);
      } finally {
        await f.scope.dispose();
        await f.ctx.fiber.dispose();
      }
    });
  }
  it('separates registration identity from inherited tool restriction', async () => {
    const f = await fixture('parent-first');
    const key = {};
    const restricted = createScope(f.ctx, key);
    try {
      const registration = f.ctx.tools.getRegistered('skill', key);
      restricted.ctx.get('tools')!.restrict({ deny: ['skill'] });
      expect(f.ctx.tools.getRegistered('skill', key)).toBe(registration);
      expect(f.ctx.tools.get('skill', key)).toBeUndefined();
      expect(f.ctx.tools.schemas(key)).toEqual([]);
      const rendered = JSON.stringify(await f.step('/user-only /private-secret'));
      expect(rendered).toContain('USER_ONLY_BODY');
      expect(rendered).not.toContain('PRIVATE_BODY');
    } finally {
      await restricted.dispose();
      await f.scope.dispose();
      await f.ctx.fiber.dispose();
    }
  });
  it('leaves decisions unchanged when a different same-name tool owns the scope', async () => {
    const f = await fixture('parent-first');
    try {
      await f.loader.dispose();
      f.scope.ctx.get('tools')!.register(
        defineContentToolFixture({
          name: 'skill',
          description: 'shadow',
          parameters: {},
          execute: async () => [{ type: 'text', text: 'shadow' }],
        }),
      );
      const result = await f.step('/private-secret /user-only');
      expect(result.kind).toBe('enter');
      if (result.kind === 'enter') expect(result.messages).toHaveLength(1);
    } finally {
      await f.scope.dispose();
      await f.ctx.fiber.dispose();
    }
  });
  it('rejects an async body after its loader registration is replaced', async () => {
    const f = await fixture('parent-first', true);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.isolated.get('skills')!.registerProvider(() => ({
      name: 'async-provider',
      list: async () => [candidate('late-skill')],
      get: async () => {
        entered();
        await gate;
        return {
          ...candidate('late-skill'),
          content: 'LATE_BODY',
        };
      },
    }));
    try {
      const pending = f.execute('late-skill');
      await started;
      await f.loader.dispose();
      release();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('LATE_BODY');
    } finally {
      release();
      await f.scope.dispose();
      await f.ctx.fiber.dispose();
    }
  });
  it('rejects an async explicit injection after scope disposal without falling back', async () => {
    const f = await fixture('local-first', true);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.isolated.get('skills')!.registerProvider(() => ({
      name: 'async-provider',
      list: async () => [candidate('late-skill')],
      get: async (entry) => {
        entered();
        await gate;
        return { ...entry, content: 'LATE_BODY' };
      },
    }));
    try {
      const pending = f.step('/late-skill');
      const rejected = expect(pending).rejects.toThrow();
      await started;
      const disposing = f.scope.dispose();
      release();
      await rejected;
      await disposing;
    } finally {
      release();
      await f.scope.dispose();
      await f.ctx.fiber.dispose();
    }
  });
});
