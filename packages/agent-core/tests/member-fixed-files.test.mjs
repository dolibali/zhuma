import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MemberAssetFileReferencesSchema,
  MemberAssetFileSnapshotQuerySchema,
  ProjectSchema,
  WorkTaskSchema,
  applyWorkbenchCommand,
  createExecutionHandoff,
} from '../dist/index.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const reference = (patch = {}) => ({
  spaceId: 'north',
  assetId: randomUUID(),
  kind: 'file',
  versionId: randomUUID(),
  sha256: 'a'.repeat(64),
  ...patch,
});

test('fixed file contract: selections require complete same-space unique published-version identities and keep omission distinct from empty', () => {
  const ref = reference();
  assert.deepEqual(MemberAssetFileReferencesSchema.parse([ref]), [ref]);
  for (const refs of [
    [{ assetId: ref.assetId }],
    [{ ...ref, kind: 'skill' }],
    [ref, { ...ref, versionId: randomUUID() }],
    [ref, reference({ spaceId: 'south' })],
    Array.from({ length: 51 }, () => reference()),
  ])
    assert.equal(MemberAssetFileReferencesSchema.safeParse(refs).success, false);
  assert.equal(
    MemberAssetFileSnapshotQuerySchema.safeParse({ spaceId: 'south', references: [ref] }).success,
    false,
  );
  assert.equal(MemberAssetFileSnapshotQuerySchema.safeParse({ spaceId: 'north' }).success, false);
  const { state, task } = fixture();
  const project = state.projects[0];
  assert.equal(Object.hasOwn(ProjectSchema.parse(project), 'fileRefs'), false);
  assert.equal(Object.hasOwn(WorkTaskSchema.parse(task), 'fileRefs'), false);
  assert.equal(JSON.stringify(ProjectSchema.parse(project)), JSON.stringify(project));
  assert.equal(JSON.stringify(WorkTaskSchema.parse(task)), JSON.stringify(task));
  assert.deepEqual(WorkTaskSchema.parse({ ...task, fileRefs: [] }).fileRefs, []);
});

test('fixed file contract: the original AppliedPlan Task snapshot preserves exact selected versions independently of later project configuration', () => {
  const { state, task } = fixture(),
    ref = reference();
  const confirmed = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, fileRefs: [ref], status: 'ready' },
  });
  const plan = confirmed.appliedPlans[0];
  const updated = applyWorkbenchCommand(confirmed, {
    type: 'save-project',
    project: { ...state.projects[0], fileRefs: [reference()] },
  });
  assert.deepEqual(
    createExecutionHandoff({ taskId: task.id, planId: plan.id, revision: plan.revision }, updated)
      .task.fileRefs,
    [ref],
  );
  assert.deepEqual(updated.tasks[0].fileRefs, [ref]);
});
