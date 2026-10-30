import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixedFilesHost } from './member-fixed-files-fixture.mjs';
import { definition } from './member-template-fixture.mjs';
import { memberAssetDefinitionId } from '@zhuma/agent-core';
import { request, signal, taskInput, projectCommand } from './member-workbench-fixture.mjs';

const project = (refs, id = 'project-one') => ({
  id,
  name: '接口项目',
  description: '',
  ...(refs === undefined ? {} : { fileRefs: refs }),
});
async function recover(h, input) {
  const locator = join(h.root, 'fixed-files-locator.json');
  await writeFile(locator, JSON.stringify(input));
  await h.close();
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [new URL('./member-fixed-files-process.mjs', import.meta.url).pathname, h.root, locator],
    { timeout: 15000, env: { PATH: process.env.PATH } },
  );
  return JSON.parse(stdout);
}

test('member fixed files: original commands inherit once, preserve omitted updates, distinguish explicit empty and freeze the AppliedPlan', async (t) => {
  const h = await fixedFilesHost(t),
    old = await h.publishFile('Chosen v1');
  await h.command({ type: 'create-project', project: project([old.reference]) });
  await h.command({ type: 'create-task', task: taskInput() });
  const newer = await h.publishFile('Latest v2', { prior: old });
  await h.command({ type: 'update-project', project: project([newer.reference]) });
  await h.command({ type: 'update-task', task: taskInput({ title: '保留原资料' }) });
  assert.deepEqual(h.workbench.snapshot().tasks[0].fileRefs, [old.reference]);
  await h.command({ type: 'create-task', task: taskInput({ id: 'explicit-empty', fileRefs: [] }) });
  assert.deepEqual(
    h.workbench.snapshot().tasks.find((task) => task.id === 'explicit-empty').fileRefs,
    [],
  );
  await h.command({ type: 'update-task', task: taskInput({ fileRefs: [] }) });
  assert.deepEqual(
    h.workbench.snapshot().tasks.find((task) => task.id === 'task-one').fileRefs,
    [],
  );
  await h.command({ type: 'update-task', task: taskInput({ fileRefs: [old.reference] }) });
  await h.command({ type: 'confirm-task', taskId: 'task-one' });
  const applied = h.workbench.snapshot().appliedPlans[0];
  assert.deepEqual(applied.task.fileRefs, [old.reference]);
  await h.command({ type: 'update-project', project: project([]) });
  assert.deepEqual(h.workbench.snapshot().appliedPlans[0], applied);
  const actual = await recover(h, {
    planId: applied.id,
    reference: old.reference,
    text: 'Chosen v1',
  });
  assert.deepEqual(actual, { fixedOldVersion: true, actualBytes: true, replayWithoutWrite: true });
});

test('member fixed files: actual create ACK loss then changed project defaults and new-process raw omitted-body replay keep the original selected source', async (t) => {
  let loseAck = false;
  const h = await fixedFilesHost(t, {
    afterWrite: async (next) => {
      if (loseAck && next.tasks.length) {
        loseAck = false;
        throw Error('CONTRACT_LOST_ACK');
      }
    },
  });
  const old = await h.publishFile('Before ACK loss');
  await h.command({ type: 'create-project', project: project([old.reference]) });
  const original = request(h.workbench.snapshot().revision, {
    type: 'create-task',
    task: taskInput(),
  });
  loseAck = true;
  await assert.rejects(h.member().command(original, signal()), /CONTRACT_LOST_ACK/u);
  assert.deepEqual(h.workbench.snapshot().tasks[0].fileRefs, [old.reference]);
  const newer = await h.publishFile('New project default', { prior: old });
  await h.command({ type: 'update-project', project: project([newer.reference]) });
  const before = h.workbench.snapshot();
  await h.member().command(original, signal());
  assert.deepEqual(h.workbench.snapshot(), before);
  const recovered = await recover(h, {
    request: original,
    taskId: 'task-one',
    reference: old.reference,
    text: 'Before ACK loss',
  });
  assert.equal(recovered.replayWithoutWrite, true);
});

test('member fixed files: a legacy omitted create replay and omitted update stay omitted after project defaults are introduced', async (t) => {
  const h = await fixedFilesHost(t);
  await h.command(projectCommand());
  const original = request(h.workbench.snapshot().revision, {
    type: 'create-task',
    task: taskInput(),
  });
  await h.member().command(original, signal());
  const file = await h.publishFile('Later project default');
  await h.command({ type: 'update-project', project: project([file.reference]) });
  const before = h.workbench.snapshot();
  await h.member().command(original, signal());
  assert.deepEqual(h.workbench.snapshot(), before);
  await h.command({ type: 'update-task', task: taskInput({ title: '仍不引用' }) });
  assert.equal(Object.hasOwn(h.workbench.snapshot().tasks[0], 'fileRefs'), false);
});

test('member fixed files: template creation inherits only once and a lost ACK replay keeps the original fixed files after project defaults change', async (t) => {
  let loseAck = false;
  const h = await fixedFilesHost(t, {
    afterWrite: async (next) => {
      if (loseAck && next.tasks.length) {
        loseAck = false;
        throw Error('CONTRACT_TEMPLATE_ACK');
      }
    },
  });
  const old = await h.publishFile('Template chosen v1');
  await h.command({ type: 'create-project', project: project([old.reference]) });
  const template = structuredClone(definition);
  template.resources = [];
  for (const flow of template.workflows) for (const node of flow.nodes) node.skillIds = [];
  const created = await h.owner.command(
    h.requests.ann,
    {
      operation: 'create-draft',
      spaceId: 'north',
      assetId: randomUUID(),
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      dependencies: [],
      definition: {
        kind: 'template',
        name: '接口模板',
        description: '',
        content: JSON.stringify(template),
      },
    },
    signal(),
  );
  const published = await h.owner.command(
    h.requests.ann,
    {
      operation: 'publish',
      spaceId: 'north',
      assetId: created.asset.assetId,
      expectedVersion: created.asset.version,
      idempotencyKey: randomUUID(),
    },
    signal(),
  );
  const { workflows: _graph, ...task } = taskInput({ id: randomUUID() });
  const original = request(h.workbench.snapshot().revision, {
    type: 'instantiate-template',
    input: {
      templateId: memberAssetDefinitionId(published.reference),
      task,
      roleBindings: { author: 'ann', reviewer: 'bob' },
      resourceBindings: {},
    },
  });
  loseAck = true;
  await assert.rejects(h.member().command(original, signal()), /CONTRACT_TEMPLATE_ACK/u);
  const newer = await h.publishFile('Template project v2', { prior: old });
  await h.command({ type: 'update-project', project: project([newer.reference]) });
  const before = h.workbench.snapshot();
  await h.member().command(original, signal());
  assert.deepEqual(h.workbench.snapshot(), before);
  assert.deepEqual(before.tasks[0].fileRefs, [old.reference]);
  assert.deepEqual(before.tasks[0].templateSource.memberAsset, published.reference);
});

test('member fixed files: foreign scope, altered identity/hash, draft-only and duplicate-version selections refuse before original writes', async (t) => {
  const h = await fixedFilesHost(t),
    file = await h.publishFile('Fixed');
  const invalid = [
    [{ ...file.reference, spaceId: 'south' }],
    [{ ...file.reference, sha256: 'f'.repeat(64) }],
    [{ ...file.reference, versionId: randomUUID() }],
    [{ ...file.reference, kind: 'skill' }],
    [file.reference, { ...file.reference, versionId: randomUUID() }],
  ];
  for (const fileRefs of invalid) {
    const before = h.workbench.snapshot();
    await assert.rejects(h.command({ type: 'create-project', project: project(fileRefs) }));
    assert.deepEqual(h.workbench.snapshot(), before);
  }
  await h.command(projectCommand());
  for (const fileRefs of invalid) {
    const before = h.workbench.snapshot();
    await assert.rejects(h.command({ type: 'create-task', task: taskInput({ fileRefs }) }));
    assert.deepEqual(h.workbench.snapshot(), before);
  }
  const draft = await h.create();
  await assert.rejects(
    h.command({
      type: 'create-task',
      task: taskInput({
        fileRefs: [
          {
            ...file.reference,
            assetId: draft.input.assetId,
            versionId: randomUUID(),
          },
        ],
      }),
    }),
  );
  await assert.rejects(
    h.command({ type: 'create-task', task: taskInput({ fileRefs: [file.reference] }) }, 'dana'),
  );
  await h.command({ type: 'create-task', task: taskInput({ fileRefs: [file.reference] }) });
  const before = h.workbench.snapshot();
  await assert.rejects(
    h.command({ type: 'update-task', task: taskInput({ fileRefs: [] }) }, 'bob'),
    { code: 'forbidden' },
  );
  assert.deepEqual(h.workbench.snapshot(), before);
});

test('member fixed files: explicit metadata query never scans latest, does not read bytes and repeats actual personal owner/member authority', async (t) => {
  const h = await fixedFilesHost(t),
    old = await h.publishFile('Selected old');
  await h.publishFile('Unselected latest', { prior: old });
  await h.publishFile('Entirely unselected');
  let bodyReads = 0;
  const read = h.ctx.attachments.readFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.readFileStream = (...args) => {
    bodyReads++;
    return read(...args);
  };
  const snapshot = await h.owner.fileSnapshot(
    h.requests.ann,
    { spaceId: 'north', references: [old.reference] },
    signal(),
  );
  assert.deepEqual(
    snapshot.snapshot.files.map((item) => item.reference),
    [old.reference],
  );
  assert(!JSON.stringify(snapshot).includes('attachmentId'));
  const empty = await h.owner.fileSnapshot(
    h.requests.ann,
    { spaceId: 'north', references: [] },
    signal(),
  );
  assert.deepEqual(empty.snapshot.files, []);
  assert.equal(bodyReads, 0);
  await assert.rejects(h.owner.fileSnapshot(h.requests.ann, { spaceId: 'north' }, signal()), {
    code: 'asset-invalid',
  });
  await assert.rejects(
    h.owner.fileSnapshot(
      h.requests.dana,
      { spaceId: 'north', references: [old.reference] },
      signal(),
    ),
  );
  const personal = await h.publishFile('Personal file', { spaceId: 'personal-ann' });
  await h.command(
    { type: 'create-project', project: project([personal.reference], 'own-project') },
    'ann',
    'personal-ann',
  );
  h.personalOwners.set('personal-ann', 'bob');
  const before = h.workbench.snapshot();
  await assert.rejects(h.member().snapshot({ spaceId: 'personal-ann' }));
  await assert.rejects(
    h.command(
      { type: 'create-project', project: project([personal.reference], 'private-project') },
      'ann',
      'personal-ann',
    ),
  );
  assert.deepEqual(h.workbench.snapshot(), before);
});
