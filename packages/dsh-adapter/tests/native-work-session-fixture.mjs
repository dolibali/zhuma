/** Real published DSH runtime/storage; only model responses and Run grants are contracts. */
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { join } from 'node:path';
import { openNativeWorkSessions } from '../dist/native-work-session-storage.js';

export const scope = Object.freeze({
  actorId: 'member-a',
  spaceId: 'team-a',
  taskId: 'task-a',
  planId: 'plan-a',
  revision: 1,
  nodeId: 'node-a',
  runId: 'run-a',
  generation: 1,
  segmentId: 'segment-a',
});
export const selection = Object.freeze({
  provider: 'contract',
  model: 'contract-model',
  maxTokens: 1000,
  configurationId: 'task-tools-v1',
});
export const message = (requestId, text, mode = 'followup') => ({
  requestId,
  text,
  mode,
  selection,
});

export function grant(partial = {}) {
  const abort = new AbortController();
  let allowed = true;
  return {
    scope: { ...scope, ...partial },
    signal: abort.signal,
    assertCurrent() {
      if (!allowed) throw Error('contract-currentness-rejected');
    },
    deny() {
      allowed = false;
    },
    revoke() {
      allowed = false;
      abort.abort();
    },
  };
}

export class ScriptedAdapter extends LlmAdapter {
  requests = [];
  constructor(script = []) {
    super();
    this.script = [...script];
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }
  async *stream(options) {
    this.requests.push(options);
    const entry = this.script.shift();
    if (entry === undefined) throw Error('contract response exhausted');
    if (typeof entry === 'function') {
      yield* await entry(options);
      return;
    }
    yield* response(entry);
  }
}
export function response(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

export async function boot(
  root,
  adapter = new ScriptedAdapter(),
  compose,
  runtimeOptions = {},
  reviewPorts,
  backendId,
) {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await ctx.plugin(Prompt);
    await ctx.plugin(Tools);
    await ctx.plugin(Agents);
    await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(Loop, { agents: [] });
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root: join(root, 'domains') });
    await ctx.plugin(Domain, { backend: 'json' });
    ctx.llm.registerAdapter(['contract'], adapter);
    const work = await openNativeWorkSessions(
      ctx,
      {
        workingDirectory: () => ({ kind: 'text-only' }),
        ...runtimeOptions,
        compose:
          compose ??
          (() => ({
            context:
              'Synthetic task goal. Catalog: accepted-v1, accepted-v2, accepted-v3. Read selected fixed inputs only.',
            toolAllowlist: [],
          })),
      },
      reviewPorts,
      backendId,
    );
    return { ctx, ...work, adapter, close: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export async function allHistory(service, current) {
  const result = [];
  for (;;) {
    const { events } = await service.history(current, result.at(-1)?.seq ?? -1);
    result.push(...events);
    if (events.length < 100) return result;
  }
}
