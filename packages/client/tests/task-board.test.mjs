import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { row, unknown } from './task-progress-fixture.mjs';
import { taskBoardColumn } from '../dist/workbench/task-board.js';
import { TaskBoard } from '../dist/workbench/TaskBoard.js';

test('board projection uses authoritative progress and keeps unknown/cancelled distinct from accepted', () => {
  const task = { status: 'ready' };
  const ready = (data) => ({ state: 'ready', row: data });
  assert.equal(taskBoardColumn({ status: 'draft' }, ready(row())), 'planning');
  for (const progress of [
    undefined,
    { state: 'loading' },
    { state: 'error', message: 'unavailable' },
    ready(unknown()),
  ])
    assert.equal(taskBoardColumn(task, progress), 'unknown');
  assert.equal(taskBoardColumn(task, ready(row())), 'review');
  assert.equal(taskBoardColumn(task, ready(row({ facts: 'not-started' }))), 'attention');
  const counts = { ...row().byStatus, 'in-review': 0 };
  assert.equal(taskBoardColumn(task, ready(row({ byStatus: counts }))), 'running');
  assert.equal(
    taskBoardColumn(task, ready(row({ byStatus: { ...counts, 'needs-revision': 1 } }))),
    'attention',
  );
  for (const delivery of ['cancelled', 'mixed-terminal', 'all-accepted'])
    assert.equal(taskBoardColumn(task, ready(row({ delivery }))), 'ended');
});

test('board SSR contract renders the supplied task snapshot without commands or draggable states', () => {
  const { state } = fixture();
  const html = renderToStaticMarkup(
    createElement(TaskBoard, {
      tasks: state.tasks,
      projects: state.projects,
      participants: state.participants,
      progress: () => undefined,
      openTask: () => {
        throw new Error('Rendering must not start a command');
      },
    }),
  );
  for (const task of state.tasks) assert.ok(html.includes(task.title));
  assert.ok(html.includes('任务看板'));
  assert.ok(!html.includes('draggable="true"'));
  assert.ok(!html.includes('产物全部已接受'));
});
