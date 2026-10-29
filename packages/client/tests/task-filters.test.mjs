import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import {
  createTaskFilterStore,
  emptyTaskFilters,
  taskFilterCandidates,
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
  assert.equal(taskBoardColumn(task, true, { state: 'ready', row: row() }), 'review');
  assert.equal(
    taskBoardColumn(task, true, { state: 'ready', row: row({ delivery: 'cancelled' }) }),
    'ended',
  );
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
