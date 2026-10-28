/** Actual Domain/JSON reader gates; member/native reports remain contract fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileHost, ok } from './remote-run-files-fixture.mjs';
import { open } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import {
  executionRunGlobalSchema,
  assertExecutionRunStoreCompatibility,
} from '../dist/execution-run-protocol.js';

test('remote file writer: actual pre-file strict global reader rejects the new format before domain mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-file-writer-'));
  const h = await fileHost(t, { root });
  let fibers = [];
  try {
    await h.begin();
    const global = structuredClone(h.domain.global.get());
    assert.equal(global.remoteExecutionFileWriter, 1);
    assert.throws(() =>
      assertExecutionRunStoreCompatibility({ ...global, remoteExecutionFileWriter: 2 }, [h.read()]),
    );
    await h.close();
    const before = await businessHashes(root);
    // Freeze the exact pre-file field inventory. Its strict decoder rejects the
    // new property before any table decoder, cleanup or writer can run.
    const shape = executionRunGlobalSchema.shape;
    const oldGlobal = z.strictObject({
      schemaVersion: shape.schemaVersion,
      nativeExecutionWriter: shape.nativeExecutionWriter,
      nativeReviewWriter: shape.nativeReviewWriter,
      workspaceApprovalWriter: shape.workspaceApprovalWriter,
      remoteExecutionWriter: shape.remoteExecutionWriter,
      remoteExecution: shape.remoteExecution,
    });
    const ctx = new Context();
    for (const [plugin, options] of [
      [Storage],
      [JsonStorage, { root: join(root, 'service') }],
      [Domain, { backend: 'json' }],
    ]) {
      const fiber = ctx.plugin(plugin, options);
      fibers.push(fiber);
      await fiber;
    }
    await assert.rejects(() =>
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
    for (const fiber of fibers.reverse()) await fiber.dispose();
    fibers = [];
    assert.deepEqual(await businessHashes(root), before);
    await assert.rejects(
      () => fileHost(t, { root, seed: false, enabled: false, identity: h.identity }),
      (error) => error.code === 'remote-protocol-unsupported',
    );
    assert.deepEqual(
      await businessHashes(root),
      before,
      'closing the file capability does not migrate, strip obligations or write',
    );
    const closedCapability = await open(join(root, 'service'), { seed: false });
    try {
      closedCapability.resetCounts();
      await assert.rejects(
        () => closedCapability.service.enableRemoteRuns(),
        (error) => error.code === 'remote-protocol-unsupported',
      );
      const info = await closedCapability.service.remoteRun(
        closedCapability.request,
        h.envelope('info', {}),
      );
      assert.equal(info.ok, false);
      assert.equal(info.error.code, 'remote-protocol-unsupported');
      assert.deepEqual(closedCapability.counters, { global: 0, nodes: 0, plans: 0 });
      const cleanup = h.signBody(
        h.envelope('cleanup', {
          scope: h.view.scope,
          permit: h.cleanup.public,
          observation: {
            kind: 'drained',
            sequence: h.view.nextSequence,
            evidence: {
              basis: 'flushed-and-closed',
              nativeSessionId: 'file-native',
              nativeAgentId: 'file-agent',
            },
          },
        }),
      );
      const cleaned = ok(
        await closedCapability.service.remoteRun({ headers: {} }, cleanup, h.cleanup.raw),
      );
      assert.equal(cleaned.resources, 'settled');
      assert.equal(cleaned.authority, 'cleanup-only');
      assert.equal(closedCapability.domain.global.get().remoteExecutionFileWriter, 1);
      assert.deepEqual(closedCapability.counters, { global: 0, nodes: 1, plans: 0 });
    } finally {
      await closedCapability.close();
    }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote file writer: new reader reopens an old pure-text store without migration writes or capability upgrade', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-text-reader-'));
  let first, second;
  try {
    first = await fileHost(t, { root, enabled: false });
    await first.close();
    const before = await businessHashes(root);
    second = await fileHost(t, { root, seed: false, enabled: false, identity: first.identity });
    const info = ok(await second.send(second.envelope('info', {})));
    assert.equal(info.operations.length, 13);
    assert.equal(second.domain.global.get().remoteExecutionFileWriter, undefined);
    assert.deepEqual(await businessHashes(root), before);
  } finally {
    await second?.close();
    await first?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote files: remote reservations share the original eight-slot upload quota and release only after the original drain', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('reserved');
  const slots = [];
  for (let index = 0; index < 8; index++)
    slots.push((await h.reserve(bytes, `publish-${index}`)).value);
  const selected = h.selector('ninth');
  const full = await h.send(
    h.scopeBody('publish-file', { ...selected, mode: 'reserve', maximumBytes: bytes.byteLength }),
  );
  assert.equal(full.ok, false);
  assert.equal(full.error.code, 'remote-quota');
  assert.equal(h.service.pendingUploads.size, 8);
  assert.equal(h.counts.saved, 0);
  ok(await h.send(h.scopeBody('abandon-file', { reservationId: slots[0].reservationId })));
  assert.equal(h.service.pendingUploads.size, 7);
  const next = ok(
    await h.send(
      h.scopeBody('publish-file', { ...selected, mode: 'reserve', maximumBytes: bytes.byteLength }),
    ),
  );
  assert.equal(next.status, 'reserved');
});
