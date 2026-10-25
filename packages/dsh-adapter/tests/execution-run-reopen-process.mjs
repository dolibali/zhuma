/** Separate-process JSON read proof. No identity, native runtime, model or effect driver. */
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  executionRunGlobalSchema,
  requireExecutionRunWriter,
} from '../dist/execution-run-protocol.js';
import { readExecutionRunState } from '../dist/execution-run-state.js';

const ctx = new Context();
const fibers = [];
async function load(plugin, config) {
  const fiber = ctx.plugin(plugin, config);
  fibers.push(fiber);
  await fiber;
}
try {
  await load(Storage);
  await load(JsonStorage, { root: process.argv[2] });
  await load(Domain, { backend: 'json' });
  const domain = await ctx.storageDomain.open({
    name: 'zhuma_execution',
    version: 1,
    global: { schema: executionRunGlobalSchema, initial: { schemaVersion: 1 } },
    tables: { nodes: { valueSchema: z.unknown() }, plans: { valueSchema: z.unknown() } },
  });
  requireExecutionRunWriter(domain.global.get());
  const row = domain.table('nodes').get('existing-node');
  const state = readExecutionRunState(row);
  console.log(
    JSON.stringify({
      kind: 'read-only-run-reopen',
      runId: state?.currentRunId ?? null,
      generation: state?.runs.at(-1).attempt.generation ?? null,
      status: state?.runs.at(-1).attempt.status ?? null,
      resources: state?.runs.at(-1).resources ?? null,
    }),
  );
  await domain.close();
} finally {
  for (const fiber of fibers.toReversed()) await fiber.dispose();
}
