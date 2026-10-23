import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  ProjectSchema,
  WorkbenchSchema,
  planningPrompt,
} from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

test('project definitions: legacy snapshots stay byte-shaped; defaults and references do not rewrite existing work', () => {
  const { state, task } = fixture();
  const legacy = structuredClone(state.projects[0]);
  assert.deepEqual(WorkbenchSchema.parse(state).projects[0], legacy);
  const confirmed = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  const priorTasks = structuredClone(confirmed.tasks);
  const priorPlans = structuredClone(confirmed.appliedPlans);
  const next = applyWorkbenchCommand(confirmed, {
    type: 'save-project',
    project: {
      ...legacy,
      defaultParticipantIds: ['outside'],
      assetIds: ['api-skill'],
      references: [{ id: 'requirements', name: '需求', url: 'https://example.com/requirements' }],
    },
  });
  assert.deepEqual(next.tasks, priorTasks);
  assert.deepEqual(next.appliedPlans, priorPlans);
  assert.deepEqual(next.participants, state.participants);
  assert.deepEqual(next.assets, state.assets);
  assert.equal(next.projects[0].id, 'project');
  assert.equal('spaceId' in next.projects[0], false);
});

test('project definitions: dangling/duplicate IDs and unsafe reference links fail before writes', () => {
  const { state } = fixture();
  for (const patch of [
    { defaultParticipantIds: ['missing'] },
    { defaultParticipantIds: ['chen', 'chen'] },
    { assetIds: ['missing'] },
    { assetIds: ['api-skill', 'api-skill'] },
    {
      references: ['a', 'b'].map(() => ({ id: 'same', name: '说明', url: 'https://example.com' })),
    },
  ]) {
    assert.throws(
      () =>
        applyWorkbenchCommand(state, {
          type: 'save-project',
          project: { ...state.projects[0], ...patch },
        }),
      { code: 'project-reference' },
    );
    assert.equal(state.revision, 0);
  }
  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/source',
    'https://user:password@example.com',
    'data:text/html,example',
    'not a URL',
  ])
    assert.equal(
      ProjectSchema.safeParse({
        ...state.projects[0],
        references: [{ id: 'ref', name: '参考', url }],
      }).success,
      false,
    );
  assert.equal(
    ProjectSchema.safeParse({ ...state.projects[0], spaceId: 'project' }).success,
    false,
  );
});

test('project planning: declared assets enter budgeted context, links stay unfetched and defaults do not expand task participants', () => {
  const { state, task } = fixture();
  state.assets.push(
    { ...state.assets[0], id: 'unrelated', name: 'XYZ', description: '', content: 'XYZ' },
    { ...state.assets[0], id: 'disabled', available: false },
  );
  Object.assign(state.projects[0], {
    defaultParticipantIds: ['outside'],
    assetIds: ['unrelated', 'disabled'],
    references: [{ id: 'ref', name: '参考', url: 'https://example.com/reference' }],
  });
  const { context } = JSON.parse(planningPrompt(state, task, '').input);
  assert.ok(context.assets.some((a) => a.id === 'unrelated' && a.selection === 'bound'));
  assert.deepEqual(
    context.participants.map((p) => p.id),
    ['chen', 'qa'],
  );
  assert.ok(context.selection.unavailableBindingIds.includes('disabled'));
  assert.equal(context.selection.projectReferenceContentsFetched, false);
  assert.equal(context.project.references[0].url, 'https://example.com/reference');
  assert.equal(context.selection.executionAuthorization, 'unknown');
});
