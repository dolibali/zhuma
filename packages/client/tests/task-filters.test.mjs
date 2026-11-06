import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import {
  createTaskFilterStore,
  emptyTaskFilters,
  taskFilterCandidates,
  taskFiltersForNavigation,
} from '../dist/workbench/task-filters.js';
import { taskBoardColumn } from '../dist/workbench/task-board.js';
import { row } from './task-progress-fixture.mjs';

test('task filters combine project, participant and search with stable recent-update ordering without changing source', () => {
  const { task } = fixture();
  const tasks = [
    { ...task, id: 'b', title: 'API Beta', updatedAt: '2026-10-29T10:00:00Z' },
    { ...task, id: 'a', title: 'API Alpha', updatedAt: '2026-10-29T10:00:00Z' },
    { ...task, id: 'old', title: 'API old', updatedAt: '2026-10-28T10:00:00Z' },
    { ...task, id: 'other', projectId: 'other', title: 'API other' },
    {
      ...task,
      id: 'outside',
      participantIds: ['outside'],
      ownerId: 'outside',
      title: 'API outside',
    },
  ];
  const before = structuredClone(tasks);
  const filters = {
    ...emptyTaskFilters,
    projectId: task.projectId,
    participantId: 'chen',
    search: ' api ',
  };
  assert.deepEqual(
    taskFilterCandidates(tasks, filters).map((item) => item.id),
    ['a', 'b', 'old'],
  );
  assert.deepEqual(tasks, before);
  assert.deepEqual(
    taskFilterCandidates(tasks, { ...filters, stage: 'review' }),
    taskFilterCandidates(tasks, filters),
    'Stage must not hide plans from progress loading',
  );
  assert.equal(taskBoardColumn(task, true, { state: 'loading' }), 'unknown');
  assert.equal(taskBoardColumn(task, true, { state: 'ready', row: row() }), 'running');
  assert.equal(
    taskBoardColumn(task, true, {
      state: 'ready',
      row: row({
        byStatus: { ...row().byStatus, running: 0 },
        resources: { authorHeld: 0, reviewHeld: 1, stopRequested: 0 },
        workflow: 'inactive',
      }),
    }),
    'review',
  );
  assert.equal(
    taskBoardColumn(task, true, { state: 'ready', row: row({ delivery: 'cancelled' }) }),
    'ended',
  );
});

test('opening tasks from the active project lists only that project, including an empty one', () => {
  const { task } = fixture();
  const tasks = [
    {
      ...task,
      id: 'a1',
      projectId: 'project-a',
      title: '门户甲',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      ...task,
      id: 'a2',
      projectId: 'project-a',
      title: '门户乙',
      updatedAt: '2026-10-03T00:00:00.000Z',
    },
    {
      ...task,
      id: 'a3',
      projectId: 'project-a',
      title: '门户丙',
      updatedAt: '2026-10-02T00:00:00.000Z',
    },
    {
      ...task,
      id: 'other',
      projectId: 'project-b',
      title: '门户其他',
      updatedAt: '2026-10-04T00:00:00.000Z',
    },
  ];
  const before = structuredClone(tasks);
  const emptyProject = taskFiltersForNavigation(emptyTaskFilters, 'tasks', 'empty-project');
  assert.equal(emptyProject.projectId, 'empty-project');
  assert.deepEqual(taskFilterCandidates(tasks, emptyProject), []);
  const projectA = taskFiltersForNavigation(
    { ...emptyTaskFilters, participantId: 'chen', search: '门户' },
    'tasks',
    'project-a',
  );
  assert.equal(projectA.participantId, 'chen');
  assert.equal(projectA.search, '门户');
  assert.deepEqual(
    taskFilterCandidates(tasks, projectA).map((item) => item.id),
    ['a2', 'a3', 'a1'],
  );
  assert.equal(taskFiltersForNavigation(emptyTaskFilters, 'tasks', null), emptyTaskFilters);
  const explicit = { ...emptyTaskFilters, projectId: 'project-b', view: 'board' };
  assert.equal(taskFiltersForNavigation(explicit, 'tasks', null), explicit);
  assert.equal(taskFiltersForNavigation(explicit, 'projects', 'project-a'), explicit);
  assert.deepEqual(
    taskFilterCandidates(tasks, explicit).map((item) => item.id),
    ['other'],
  );
  assert.equal(taskFiltersForNavigation(projectA, 'tasks', 'project-a'), projectA);
  assert.deepEqual(tasks, before);
});

test('task view preferences isolate both account and space and ignore corrupt or unavailable storage', () => {
  const data = new Map();
  const store = createTaskFilterStore(() => ({
    getItem: (key) => data.get(key),
    setItem: (key, value) => data.set(key, value),
  }));
  const scope = { accountId: 'ann', spaceId: 'north' };
  const filters = {
    ...emptyTaskFilters,
    participantId: 'expert',
    stage: 'review',
    search: 'API',
    view: 'board',
  };
  store.save(scope, filters);
  assert.deepEqual(store.read(scope), filters);
  assert.deepEqual(store.read({ ...scope, accountId: 'bob' }), emptyTaskFilters);
  assert.deepEqual(store.read({ ...scope, spaceId: 'south' }), emptyTaskFilters);
  data.set([...data.keys()][0], '{corrupt');
  assert.deepEqual(store.read(scope), emptyTaskFilters);
  const unavailable = createTaskFilterStore(() => {
    throw Error('disabled');
  });
  assert.deepEqual(unavailable.read(scope), emptyTaskFilters);
  assert.doesNotThrow(() => unavailable.save(scope, filters));
});
