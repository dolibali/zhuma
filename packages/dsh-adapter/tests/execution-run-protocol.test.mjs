import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  executionRunGlobalSchema,
  requireExecutionRunWriter,
  prepareExecutionRunWriter,
  assertExecutionRunStoreCompatibility,
  enableExecutionRunWriter,
} from '../dist/execution-run-protocol.js';
import { beginExecutionRun } from '../dist/execution-run-state.js';
import { records, command, available } from './execution-run-fixture.mjs';

test('contract: no native begin without a stored writer barrier, malformed or future barriers refuse', () => {
  const row = records()[0];
  assert.throws(
    () =>
      beginExecutionRun(row, command(row), [row], {
        ...available,
        writerState: { schemaVersion: 1 },
      }),
    { code: 'run-writer-unavailable' },
  );
  for (const value of [
    null,
    undefined,
    { schemaVersion: 1, nativeExecutionWriter: 2 },
    { schemaVersion: 2, nativeExecutionWriter: 1 },
  ]) {
    assert.throws(() => requireExecutionRunWriter(value), { code: 'run-writer-incompatible' });
  }
  assertExecutionRunStoreCompatibility({ schemaVersion: 1 }, [row]);
  assert.throws(
    () =>
      assertExecutionRunStoreCompatibility({ schemaVersion: 1 }, [
        { ...row, nativeExecution: undefined },
      ]),
    { code: 'run-writer-unavailable' },
  );
  const barrier = prepareExecutionRunWriter({ schemaVersion: 1 });
  assert.deepEqual(prepareExecutionRunWriter(barrier), barrier);
  requireExecutionRunWriter(barrier);
});

test('contract: explicit marker enable is durable/idempotent; failure and a stale reader cannot dispatch a Run', async () => {
  const row = records()[0];
  let global = { schemaVersion: 1 },
    writes = 0,
    dispatches = 0;
  const start = () => {
    beginExecutionRun(row, command(row), [row], { ...available, writerState: global });
    dispatches++;
  };
  await assert.rejects(
    enableExecutionRunWriter(
      () => global,
      async () => {
        throw Error('PRIVATE_DISK_PATH');
      },
      [row],
    ),
    { code: 'run-writer-unavailable', message: '当前执行存储不能用于本地运行。' },
  );
  assert.throws(start, { code: 'run-writer-unavailable' });
  assert.equal(dispatches, 0);
  await assert.rejects(
    enableExecutionRunWriter(
      () => global,
      async () => {},
      [row],
    ),
    { code: 'run-writer-unavailable' },
  );
  await enableExecutionRunWriter(
    () => global,
    async (next) => {
      writes++;
      global = structuredClone(next);
    },
    [row],
  );
  await enableExecutionRunWriter(
    () => global,
    async () => {
      writes++;
    },
    [row],
  );
  assert.equal(writes, 1);
  start();
  assert.equal(dispatches, 1);
});

async function bytes(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await bytes(path)));
    else
      result.push([
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
for (const includeNativeRow of [false, true])
  test(`real DSH JSON: durable writer barrier refuses old strict Host reopen without changing data (native row=${includeNativeRow})`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-run-writer-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const ctx = new Context();
    const fibers = [];
    async function load(plugin, config) {
      const fiber = ctx.plugin(plugin, config);
      fibers.push(fiber);
      await fiber;
    }
    t.after(async () => {
      for (const fiber of fibers.toReversed()) await fiber.dispose();
    });
    await load(Storage);
    await load(JsonStorage, { root: directory });
    await load(Domain, { backend: 'json' });
    const base = {
      name: 'zhuma_execution',
      version: 1,
      tables: { nodes: { valueSchema: z.unknown() }, plans: { valueSchema: z.unknown() } },
    };
    const modern = {
      ...base,
      global: { schema: executionRunGlobalSchema, initial: { schemaVersion: 1 } },
    };
    const legacy = {
      ...base,
      global: {
        schema: z.strictObject({ schemaVersion: z.literal(1) }),
        initial: { schemaVersion: 1 },
      },
    };
    let domain = await ctx.storageDomain.open(modern);
    const row = records()[0];
    const receipt = { idempotencyKey: 'start', fingerprint: 'old-plan', nodeIds: [row.nodeId] };
    await domain.table('nodes').put('existing-node', row);
    await domain.table('plans').put('existing-plan', receipt);
    assert.throws(() => requireExecutionRunWriter(domain.global.get()), {
      code: 'run-writer-unavailable',
    });
    await domain.global.set(prepareExecutionRunWriter(domain.global.get()));
    const expected = includeNativeRow
      ? beginExecutionRun(row, command(row), [row], {
          ...available,
          writerState: domain.global.get(),
        }).record
      : row;
    if (includeNativeRow) await domain.table('nodes').put('existing-node', expected);
    await domain.close();
    const childBefore = await bytes(directory);
    const child = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./execution-run-reopen-process.mjs', import.meta.url)),
      directory,
    ]);
    const restored = JSON.parse(child.stdout.split('\n').find((line) => line.startsWith('{')));
    assert.deepEqual(restored, {
      kind: 'read-only-run-reopen',
      runId: includeNativeRow ? 'run-1' : null,
      generation: includeNativeRow ? 1 : null,
      status: includeNativeRow ? 'requested' : null,
      resources: includeNativeRow ? 'held' : null,
    });
    assert.deepEqual(
      await bytes(directory),
      childBefore,
      'new process read is byte-for-byte zero-write',
    );
    const before = await bytes(directory);
    await assert.rejects(ctx.storageDomain.open(legacy), { code: 'invalid-record' });
    assert.deepEqual(
      await bytes(directory),
      before,
      'old writer refusal leaves every stored byte intact',
    );
    domain = await ctx.storageDomain.open(modern);
    requireExecutionRunWriter(domain.global.get());
    assert.deepEqual(domain.table('nodes').get('existing-node'), expected);
    assert.deepEqual(domain.table('plans').get('existing-plan'), receipt);
    await domain.close();
  });
