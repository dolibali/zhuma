// Separate OS process, real DSH JSON backend. No model, identity, or execution.
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  executionRunGlobalSchema,
  assertExecutionRunStoreCompatibility,
} from '../../dist/execution-run-protocol.js';
import { readExecutionRunState } from '../../dist/execution-run-state.js';
import { readExecutionReviewState } from '../../dist/execution-review-state.js';

const ctx = new Context(),
  fibers = [],
  mode = process.argv[3];
try {
  for (const [plugin, config] of [
    [Storage],
    [JsonStorage, { root: process.argv[2] }],
    [Domain, { backend: 'json' }],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  }
  const old = z.strictObject({
    schemaVersion: z.literal(1),
    nativeExecutionWriter: z.literal(1).optional(),
  });
  try {
    const domain = await ctx.storageDomain.open({
      name: 'zhuma_execution',
      version: 1,
      global: {
        schema: mode === 'modern' ? executionRunGlobalSchema : old,
        initial: { schemaVersion: 1 },
      },
      tables: { nodes: { valueSchema: z.unknown() }, plans: { valueSchema: z.unknown() } },
    });
    try {
      const nodes = [...domain.table('nodes').entries()].map(([, node]) => node);
      assertExecutionRunStoreCompatibility(domain.global.get(), nodes);
      console.log(
        JSON.stringify({
          mode,
          reviews: nodes.reduce(
            (n, node) => n + (readExecutionReviewState(node)?.attempts.length ?? 0),
            0,
          ),
          authorRuns: nodes.reduce(
            (n, node) => n + (readExecutionRunState(node)?.runs.length ?? 0),
            0,
          ),
        }),
      );
    } finally {
      await domain.close();
    }
  } catch (error) {
    if (mode !== 'old-native-aware' || error.code !== 'invalid-record') throw error;
    console.log(JSON.stringify({ mode, refused: error.code }));
  }
} finally {
  for (const fiber of fibers.toReversed()) await fiber.dispose();
}
