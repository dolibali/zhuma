import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_STATUSES } from '@zhuma/agent-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { row, unknown } from './task-progress-fixture.mjs';
import { taskBoardColumn } from '../dist/workbench/task-board.js';
import { TaskBoard } from '../dist/workbench/TaskBoard.js';

const statuses = (patch) => ({
  ...Object.fromEntries(NODE_STATUSES.map((status) => [status, 0])),
  ...patch,
});
const present = (patch) =>
  row({
    expectedNodes: 1,
    acceptedNodes: 0,
    assigneeCounts: { human: 1, expert: 0 },
    resources: { authorHeld: 0, reviewHeld: 0, stopRequested: 0 },
    humanReady: 0,
    ...patch,
  });

test('board projection uses authoritative progress and keeps unknown/cancelled distinct from accepted', () => {
  const task = { status: 'ready' };
  const ready = (data) => ({ state: 'ready', row: data });
  assert.equal(taskBoardColumn({ status: 'draft' }, false, undefined), 'planning');
  for (const progress of [
    undefined,
    { state: 'loading' },
    { state: 'error', message: 'unavailable' },
    ready(unknown()),
  ])
    assert.equal(taskBoardColumn(task, true, progress), 'unknown');
  assert.equal(taskBoardColumn(task, true, ready(row())), 'review');
  assert.equal(taskBoardColumn(task, true, ready(row({ facts: 'not-started' }))), 'attention');
  const counts = { ...row().byStatus, 'in-review': 0 };
  assert.equal(taskBoardColumn(task, true, ready(row({ byStatus: counts }))), 'running');
  assert.equal(
    taskBoardColumn(task, true, ready(row({ byStatus: { ...counts, 'needs-revision': 1 } }))),
    'attention',
  );
  for (const delivery of ['cancelled', 'mixed-terminal', 'all-accepted'])
    assert.equal(taskBoardColumn(task, true, ready(row({ delivery }))), 'ended');
  // Editing a next draft never overwrites the previous confirmed plan's facts.
  const draft = { status: 'draft' };
  assert.equal(taskBoardColumn(draft, true, ready(row())), 'review');
  assert.equal(taskBoardColumn(draft, true, ready(row({ byStatus: counts }))), 'running');
  assert.equal(taskBoardColumn(draft, true, ready(row({ delivery: 'all-accepted' }))), 'ended');
  assert.equal(taskBoardColumn(draft, true, undefined), 'unknown');
  assert.equal(taskBoardColumn(draft, false, ready(row())), 'planning');
});

test('board projection: a human node waiting to deliver is in progress, without moving other stages', () => {
  const task = { status: 'ready' };
  const progress = (data) => ({ state: 'ready', row: data });
  const delivering = present({
    byStatus: statuses({ ready: 1 }),
    humanReady: 1,
  });
  assert.equal(taskBoardColumn(task, true, progress(delivering)), 'running');
  assert.equal(
    taskBoardColumn(
      task,
      true,
      progress(
        present({
          expectedNodes: 2,
          assigneeCounts: { human: 1, expert: 1 },
          byStatus: statuses({ ready: 1, blocked: 1 }),
          humanReady: 1,
        }),
      ),
    ),
    'running',
    'a ready human still counts when an expert sibling is only blocked',
  );
  assert.equal(
    taskBoardColumn(
      task,
      true,
      progress(
        present({
          assigneeCounts: { human: 0, expert: 1 },
          byStatus: statuses({ ready: 1 }),
          humanReady: 0,
        }),
      ),
    ),
    'attention',
  );
  assert.equal(
    taskBoardColumn(task, true, progress(present({ byStatus: statuses({ blocked: 1 }) }))),
    'attention',
  );
  assert.equal(
    taskBoardColumn(task, true, progress(present({ byStatus: statuses({ running: 1 }) }))),
    'running',
  );
  assert.equal(taskBoardColumn(task, true, progress(row({ facts: 'not-started' }))), 'attention');
  for (const status of ['needs-revision', 'waiting-for-input', 'failed'])
    assert.equal(
      taskBoardColumn(task, true, progress(present({ byStatus: statuses({ [status]: 1 }) }))),
      'attention',
    );
  assert.equal(
    taskBoardColumn(
      task,
      true,
      progress(
        present({
          expectedNodes: 2,
          assigneeCounts: { human: 2, expert: 0 },
          byStatus: statuses({ ready: 1, 'needs-revision': 1 }),
          humanReady: 1,
        }),
      ),
    ),
    'attention',
  );
  assert.equal(
    taskBoardColumn(
      task,
      true,
      progress(
        present({
          expectedNodes: 2,
          assigneeCounts: { human: 2, expert: 0 },
          byStatus: statuses({ ready: 1, 'in-review': 1 }),
          humanReady: 1,
        }),
      ),
    ),
    'review',
  );
  for (const delivery of ['cancelled', 'mixed-terminal', 'all-accepted'])
    assert.equal(taskBoardColumn(task, true, progress(row({ delivery }))), 'ended');
  assert.equal(taskBoardColumn({ status: 'draft' }, false, undefined), 'planning');
  assert.equal(taskBoardColumn(task, false, progress(delivering)), 'unknown');
  assert.equal(taskBoardColumn(task, true, undefined), 'unknown');
  assert.equal(taskBoardColumn(task, true, { state: 'loading' }), 'unknown');
  assert.equal(taskBoardColumn(task, true, progress(unknown())), 'unknown');
});

test('board SSR contract renders the supplied task snapshot without commands or draggable states', () => {
  const { state } = fixture();
  const html = renderToStaticMarkup(
    createElement(TaskBoard, {
      tasks: state.tasks,
      projects: state.projects,
      participants: state.participants,
      progress: () => undefined,
      confirmed: () => false,
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

test('board SSR probe: a ready human delivery sits in 进行中, and an unstarted plan stays in 待处理', () => {
  const { state } = fixture();
  const task = state.tasks[0];
  const board = (data) =>
    renderToStaticMarkup(
      createElement(TaskBoard, {
        tasks: [task],
        projects: state.projects,
        participants: state.participants,
        progress: () => ({ state: 'ready', row: data }),
        confirmed: () => true,
        openTask: () => {
          throw new Error('Rendering must not start a command');
        },
      }),
    );
  const column = (html, label) => {
    const match = html.match(
      new RegExp(`<section[^>]*aria-label="${label} (\\d+) 项"[^>]*>([\\s\\S]*?)</section>`),
    );
    assert.ok(match, label);
    return { count: Number(match[1]), body: match[2] };
  };
  const delivering = board(
    present({
      byStatus: statuses({ ready: 1 }),
      humanReady: 1,
    }),
  );
  const running = column(delivering, '进行中');
  assert.equal(running.count, 1);
  assert.ok(running.body.includes(task.title));
  assert.equal(column(delivering, '待处理').count, 0);
  assert.equal(column(delivering, '待评审').count, 0);
  assert.equal(column(delivering, '待核实').count, 0);
  const waiting = board(row({ facts: 'not-started' }));
  const attention = column(waiting, '待处理');
  assert.equal(attention.count, 1);
  assert.ok(attention.body.includes(task.title));
  assert.equal(column(waiting, '进行中').count, 0);
});
