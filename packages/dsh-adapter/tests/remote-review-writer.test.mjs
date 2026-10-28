/** Actual original Domain/JSON format barriers; no old packaged binary or model claim. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { join } from 'node:path';
import { reviewHost, ok, no } from './remote-review-fixture.mjs';
import {
  executionRunGlobalSchema,
  assertExecutionRunStoreCompatibility,
  prepareExecutionRunWriter,
} from '../dist/execution-run-protocol.js';
import { readExecutionReviewState } from '../dist/execution-review-state.js';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { open } from './execution-service-run-fixture.mjs';

test('remote review writer: actual pre-review strict Domain rejects the marker before business writes; disabled receiver cannot strip it', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  const global = h.domain.global.get();
  assert.equal(global.remoteExecutionReviewWriter, 1);
  assert.equal(global.nativeReviewWriter, 1);
  assert.equal(prepareExecutionRunWriter(global).remoteExecutionReviewWriter, 1);
  assert.throws(() =>
    assertExecutionRunStoreCompatibility({ ...global, remoteExecutionReviewWriter: undefined }, [
      h.read(),
    ]),
  );
  assert.throws(() =>
    assertExecutionRunStoreCompatibility({ ...global, remoteExecutionReviewWriter: 2 }, [h.read()]),
  );
  await h.close();
  const before = await businessHashes(h.root),
    ctx = new Context(),
    fibers = [];
  try {
    for (const [plugin, options] of [
      [Storage],
      [JsonStorage, { root: join(h.root, 'service') }],
      [Domain, { backend: 'json' }],
    ]) {
      const fiber = ctx.plugin(plugin, options);
      fibers.push(fiber);
      await fiber;
    }
    const oldGlobal = z.strictObject(
      Object.fromEntries(
        Object.entries(executionRunGlobalSchema.shape).filter(
          ([key]) => key !== 'remoteExecutionReviewWriter',
        ),
      ),
    );
    await assert.rejects(
      ctx.storageDomain.open({
        name: 'zhuma_execution',
        version: 1,
        global: { schema: oldGlobal, initial: { schemaVersion: 1 } },
        tables: {
          nodes: { valueSchema: z.unknown() },
          plans: { valueSchema: z.unknown() },
          workspace_approvals: { valueSchema: z.unknown() },
        },
      }),
    );
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
  assert.deepEqual(await businessHashes(h.root), before);
  const disabled = await open(join(h.root, 'service'), {
    seed: false,
    workbench: h.readWorkbench(),
  });
  try {
    disabled.resetCounts();
    await assert.rejects(
      disabled.service.enableRemoteRuns(),
      (error) => error.code === 'remote-protocol-unsupported',
    );
    assert.deepEqual(disabled.counters, { global: 0, nodes: 0, plans: 0 });
  } finally {
    await disabled.close();
  }
  assert.deepEqual(await businessHashes(h.root), before);
});

test('remote review writer: failed node keeps the acknowledged marker-only safe prefix, then the same request admits one original lane', async (t) => {
  const h = await reviewHost(t),
    body = h.accept();
  h.faults.node = true;
  no(await h.send(body));
  assert.equal(h.domain.global.get().remoteExecutionReviewWriter, 1);
  assert.equal(readExecutionReviewState(h.read()), undefined);
  h.faults.node = false;
  const accepted = ok(await h.send(body));
  assert.equal(accepted.disposition, 'accepted');
  assert.equal(readExecutionReviewState(h.read()).attempts.length, 1);
});

test('remote review writer: a lost node ACK cannot replay drive or reserve another native review', async (t) => {
  const h = await reviewHost(t),
    body = h.accept();
  h.faults.afterNodeWrite = () => {
    throw Error('LOST_ORIGINAL_NODE_ACK');
  };
  no(await h.send(body));
  h.faults.afterNodeWrite = undefined;
  const replay = ok(await h.send(body));
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.authority, 'recovery-required');
  assert.equal(readExecutionReviewState(h.read()).attempts.length, 1);
  assert.equal(h.calls.metadata, 1);
  assert.equal(h.read().rounds[0].ballots.length, 0);
});
