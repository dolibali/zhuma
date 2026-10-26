// Copied to the isolated SDK root. Every runtime import is an ordinary emitted
// package entry; no source aliases, module hooks, or replacement Agent factory.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { Context } from './vendor/cordis/lib/index.js';
import AgentRegistry from './packages/core/agent/lib/index.js';
import AgentLoop from './packages/core/agent-loop/lib/index.js';
import LlmRuntime, { LlmAdapter, createUserMessage } from './packages/llm/llm/lib/index.js';
import SessionStore, { SessionId } from './packages/core/session/lib/index.js';
import SessionProjections from './packages/session/session-projection/lib/index.js';
import SystemPrompt from './packages/core/system-prompt/lib/index.js';
import Tools from './packages/core/tools/lib/index.js';
import Skills, { SkillRegistry } from './packages/skill/skill/lib/index.js';
import { scopeOf } from './packages/core/scope/lib/index.js';
import { bindSkillRegistry } from './packages/skill/tool-skill/lib/index.js';

const before = process.argv[2] === 'before';
const ctx = new Context();
let modelCalls = 0;
let handle;
class LocalAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }
  async *stream() {
    modelCalls++;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'compiled scope accepted' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'compiled scope accepted' },
    };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
try {
  for (const plugin of [
    LlmRuntime,
    SessionStore,
    SessionProjections,
    SystemPrompt,
    Tools,
    AgentRegistry,
    AgentLoop,
    Skills,
  ])
    await ctx.plugin(plugin);
  ctx.llm.registerAdapter(['compiled-scope-local'], new LocalAdapter());
  let originalContext;
  let originalRegistry;
  const create = () =>
    ctx.agents.create({
      sessionId: SessionId('compiled-skill-scope'),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'compiled-scope-local', model: 'local-script' },
      async setup(agentCtx, agent) {
        assert.equal(agent.ctx, agentCtx);
        assert.equal(Reflect.get(scopeOf(agentCtx), 'ctx'), agentCtx);
        originalContext = agentCtx;
        const isolated = agentCtx.isolate('skills');
        await isolated.plugin(Skills);
        originalRegistry = isolated.get('skills');
        assert.ok(originalRegistry instanceof SkillRegistry);
        bindSkillRegistry(agentCtx, originalRegistry);
      },
    });
  if (before) {
    await assert.rejects(create, { message: 'skill registry requires its current Agent scope' });
    assert.equal(ctx.agents.get(SessionId('compiled-skill-scope')), undefined);
    assert.equal(ctx.sessions.get(SessionId('compiled-skill-scope')), undefined);
    assert.equal(modelCalls, 0);
    console.log(JSON.stringify({ rejectedBeforeModel: true, modelCalls, sourceAliases: false }));
  } else {
    handle = await create();
    assert.equal(handle.agent.ctx, originalContext);
    assert.equal(ctx.agents.get(handle.agent.id), handle.agent);
    assert.equal(bindSkillRegistry(originalContext, originalRegistry), undefined);
    const wrongContexts = [ctx, ctx.extend(), originalContext.extend()];
    for (const candidate of wrongContexts)
      assert.throws(() => bindSkillRegistry(candidate, originalRegistry), {
        message: 'skill registry requires its current Agent scope',
      });
    assert.throws(() => bindSkillRegistry(originalContext, {}), {
      message: 'skill registry is unavailable',
    });
    handle.agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'check' }] }),
    );
    await handle.agent.whenIdle();
    const deadline = Date.now() + 5000;
    while ((modelCalls !== 1 || handle.agent.status !== 'idle') && Date.now() < deadline)
      await setTimeout(5);
    assert.equal(modelCalls, 1);
    assert.equal(handle.agent.status, 'idle');
    assert.ok(
      JSON.stringify(handle.agent.session.snapshotEvents()).includes('compiled scope accepted'),
    );
    await handle.dispose();
    handle = undefined;
    assert.throws(() => bindSkillRegistry(originalContext, originalRegistry));
    console.log(
      JSON.stringify({
        originalFactoryAndScope: true,
        boundRegistry: true,
        wrongContextsRejected: wrongContexts.length,
        invalidRegistryRejected: true,
        retiredScopeRejected: true,
        modelCalls,
        sourceAliases: false,
      }),
    );
  }
} finally {
  await handle?.dispose();
  await ctx.fiber.dispose();
}
