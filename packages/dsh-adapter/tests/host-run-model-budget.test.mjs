import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { readHostRunModels } from '../dist/host-run-models.js';

test('new model choices cap the application budget at 16k and respect original public adapter metadata', async (t) => {
  for (const [configured, context, expected] of [
    [256000, 1000000, 16384],
    [8192, 1000000, 8192],
    [32000, 8000, 8000],
    [undefined, 1000000, 4096],
  ]) {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    let resolutions = 0;
    ctx.provide('llm', {
      listProviders: () => [{ id: 'contract' }],
      listModels: async () => [{ provider: 'contract', id: 'model', name: 'Configured' }],
      resolveModelInfo: async (provider, model, signal) => {
        resolutions++;
        assert.equal(signal.aborted, false);
        return {
          provider,
          id: model,
          name: 'Configured',
          defaultMaxTokens: configured,
          context: { contextWindow: context },
        };
      },
      generate: () => assert.fail('Metadata cannot start inference'),
    });
    const choices = await readHostRunModels(ctx, new AbortController().signal);
    assert.equal(choices.kind, 'ready');
    assert.equal(choices.items[0].value.maxTokens, expected);
    assert.equal(resolutions, 1);
  }
});
test('public model resolution mismatch or timeout fails closed without calling a model', async (t) => {
  for (const mode of ['mismatch', 'timeout']) {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    ctx.provide('llm', {
      listProviders: () => [{ id: 'contract' }],
      listModels: async () => [{ provider: 'contract', id: 'model', name: 'Configured' }],
      resolveModelInfo: async () =>
        mode === 'timeout' ? new Promise(() => {}) : { provider: 'foreign', id: 'model' },
      generate: () => assert.fail('Metadata cannot start inference'),
    });
    const keepAlive = setInterval(() => {}, 10);
    try {
      assert.equal(
        (await readHostRunModels(ctx, new AbortController().signal, 25)).kind,
        'unavailable',
      );
    } finally {
      clearInterval(keepAlive);
    }
  }
});
