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
import { localWorkspace } from './execution-run-fixture.mjs';

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

async function nativeApprovalHost(t) {
  const h = await approvalHost(t, { seed: true });
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin({ workspace: localWorkspace })));
  const table = h.domain.table('nodes');
  const [key, value] = [...table.entries()].find(([, node]) => node.nodeId === 'produce');
  return { ...h, table, key, value };
}

test('workspace approval protocol: official records are deeply sealed and returned metadata cannot alter a later snapshot', async (t) => {
  const h = await nativeApprovalHost(t);
  const first = h.owner.snapshot();
  assert.equal(first.runs.length, 1);
  assert.equal(Object.isFrozen(h.value), true);
  assert.equal(Object.isFrozen(h.value.nativeExecution.runs[0].composition.payload), true);
  assert.throws(() => {
    h.value.nativeExecution.schemaVersion = 99;
  }, TypeError);
  first.runs[0].workspace.grantId = 'caller-rewrite';
  first.runs[0].scope.runId = 'caller-rewrite';
  assert.notEqual(h.owner.snapshot().runs[0].workspace.grantId, 'caller-rewrite');
  assert.equal(h.owner.snapshot().runs[0].scope.runId, 'run-1');
});

test('workspace approval protocol: same-key replacement, deletion, new corrupt history and repair are observed after a warm snapshot', async (t) => {
  const h = await nativeApprovalHost(t);
  h.owner.snapshot();
  const next = structuredClone(h.value);
  next.nativeExecution.runs[0].workspace.grantId = 'replacement-grant';
  await h.table.put(h.key, next);
  assert.equal(h.owner.snapshot().runs[0].workspace.grantId, 'replacement-grant');
  const corrupt = structuredClone(next);
  corrupt.nativeExecution.runs[0].composition.payload.firstMessage.text += 'corrupt history';
  await h.table.put(h.key, corrupt);
  assert.throws(() => h.owner.snapshot(), { code: 'run-state-invalid' });
  await h.table.put(h.key, structuredClone(next));
  assert.equal(h.owner.snapshot().runs[0].workspace.grantId, 'replacement-grant');
  await h.table.delete(h.key);
  assert.deepEqual(h.owner.snapshot().runs, []);
  await h.table.put('new-history', structuredClone(corrupt));
  assert.throws(() => h.owner.snapshot(), { code: 'run-state-invalid' });
});

test('workspace approval protocol: mutable and shallow-frozen generic records are revalidated after same-object mutation', async (t) => {
  const h = await nativeApprovalHost(t);
  h.owner.snapshot();
  for (const shallow of [false, true]) {
    const mutable = structuredClone(h.value);
    if (shallow) Object.freeze(mutable);
    h.service.storage.listNodes = () => [mutable];
    assert.equal(h.owner.snapshot().runs.length, 1);
    mutable.nativeExecution.runs[0].composition.payload.firstMessage.text += 'changed';
    assert.throws(() => h.owner.snapshot(), { code: 'run-state-invalid' });
  }
});

test('workspace approval protocol: replacing the storage source cannot hide changed history behind a warm validation', async (t) => {
  const h = await nativeApprovalHost(t);
  h.owner.snapshot();
  const original = h.service.storage.listNodes;
  const changed = structuredClone(h.value);
  changed.nativeExecution.schemaVersion = 99;
  h.service.storage.listNodes = () => [changed];
  assert.throws(() => h.owner.snapshot(), { code: 'run-state-invalid' });
  h.service.storage.listNodes = original;
  assert.equal(h.owner.snapshot().runs.length, 1);
});

test('workspace approval protocol: fresh table membership, global barriers and observed-run capacity remain checked', async (t) => {
  const h = await nativeApprovalHost(t);
  h.owner.snapshot();
  const original = h.service.storage.listNodes;
  h.service.storage.listNodes = () => Array.from({ length: 4097 }, () => h.value);
  assert.throws(() => h.owner.snapshot(), { code: 'workspace-approval-capacity' });
  h.service.storage.listNodes = original;
  assert.equal(h.owner.snapshot().runs.length, 1);
  await h.domain.global.set({ schemaVersion: 1 });
  assert.throws(() => h.owner.snapshot(), { code: 'run-writer-unavailable' });
});
