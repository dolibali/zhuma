import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  executionRunGlobalSchema,
  prepareExecutionRunWriter,
  prepareExecutionReviewWriter,
  requireWorkspaceApprovalWriter,
  enableWorkspaceApprovalWriter,
} from '../dist/execution-run-protocol.js';
import { approvalHost, approvalCommand } from './execution-workspace-approval-fixture.mjs';
import { open, checked } from './execution-service-run-fixture.mjs';

test('workspace approval protocol: strict barrier implies native writer and all current writer upgrades preserve it', async () => {
  assert.equal(
    executionRunGlobalSchema.safeParse({ schemaVersion: 1, workspaceApprovalWriter: 1 }).success,
    false,
  );
  const global = {
    schemaVersion: 1,
    nativeExecutionWriter: 1,
    nativeReviewWriter: 1,
    workspaceApprovalWriter: 1,
  };
  requireWorkspaceApprovalWriter(global);
  assert.deepEqual(prepareExecutionRunWriter(global), global);
  assert.deepEqual(prepareExecutionReviewWriter(global), global);
  await enableWorkspaceApprovalWriter(
    () => global,
    () => assert.fail('passive repeat'),
    [],
  );
  await assert.rejects(
    enableWorkspaceApprovalWriter(
      () => ({ schemaVersion: 1 }),
      async () => {},
      [],
    ),
    { code: 'run-writer-unavailable' },
  );
});

test('workspace approval protocol: actual published JSON old strict native/review reader refuses without losing the new table', async (t) => {
  const h = await approvalHost(t);
  checked(await h.owner.approve(h.request, approvalCommand()));
  await h.close();
  const file = join(h.root, 'zhuma_execution.json'),
    before = await readFile(file),
    ctx = new Context(),
    fibers = [];
  try {
    for (const [plugin, config] of [
      [Storage],
      [JsonStorage, { root: h.root }],
      [Domain, { backend: 'json' }],
    ]) {
      const fiber = ctx.plugin(plugin, config);
      fibers.push(fiber);
      await fiber;
    }
    // The frozen pre-approval native/review writer's exact strict global shape.
    const oldSchema = z
      .strictObject({
        schemaVersion: z.literal(1),
        nativeExecutionWriter: z.literal(1).optional(),
        nativeReviewWriter: z.literal(1).optional(),
      })
      .refine((value) => value.nativeReviewWriter !== 1 || value.nativeExecutionWriter === 1);
    await assert.rejects(
      ctx.storageDomain.open({
        name: 'zhuma_execution',
        version: 1,
        global: { schema: oldSchema, initial: { schemaVersion: 1 } },
        tables: { nodes: { valueSchema: z.unknown() }, plans: { valueSchema: z.unknown() } },
      }),
      { code: 'invalid-record' },
    );
    assert.deepEqual(await readFile(file), before);
    assert.equal(before.includes(Buffer.from('workspace_approvals')), true);
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
});

test('workspace approval protocol: actual stored rows without their compatibility marker refuse startup unchanged', async (t) => {
  const h = await approvalHost(t);
  checked(await h.owner.approve(h.request, approvalCommand()));
  // Explicit malformed-domain fixture; product never removes this marker.
  await h.domain.global.set({ schemaVersion: 1, nativeExecutionWriter: 1 });
  await h.close();
  const file = join(h.root, 'zhuma_execution.json'),
    before = await readFile(file);
  await assert.rejects(open(h.root, { seed: false, workbench: h.readWorkbench() }));
  assert.deepEqual(await readFile(file), before);
});
