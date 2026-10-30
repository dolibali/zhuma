import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { row, unknown } from './task-progress-fixture.mjs';
import {
  boardDragDecision,
  boardReviewRequired,
  taskBoardColumn,
} from '../dist/workbench/task-board.js';
import { TaskBoard } from '../dist/workbench/TaskBoard.js';

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

test('board drag rejects review-bypass drops and allows safe paths', () => {
  assert.equal(boardDragDecision('running', 'running', { reviewRequired: true }).type, 'same');
  assert.equal(
    boardDragDecision('running', 'ended', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  assert.equal(
    boardDragDecision('attention', 'ended', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  assert.equal(
    boardDragDecision('planning', 'ended', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  // Path does not require review → allow forward to ended.
  assert.equal(boardDragDecision('running', 'ended', { reviewRequired: false }).type, 'allow');
  assert.equal(boardDragDecision('attention', 'running', { reviewRequired: false }).type, 'allow');
  assert.equal(boardDragDecision('attention', 'running', { reviewRequired: true }).type, 'allow');
  // Faking the review column always bypasses submit-for-review.
  assert.equal(
    boardDragDecision('running', 'review', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  assert.equal(
    boardDragDecision('running', 'review', { reviewRequired: false }).type,
    'reject-bypass-review',
  );
  // Leave review only via accept or changes-requested.
  assert.equal(boardDragDecision('review', 'ended', { reviewRequired: true }).type, 'allow');
  assert.equal(boardDragDecision('review', 'attention', { reviewRequired: true }).type, 'allow');
  assert.equal(
    boardDragDecision('review', 'running', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  assert.equal(
    boardDragDecision('unknown', 'attention', { reviewRequired: false }).type,
    'reject-bypass-review',
  );
});

test('boardReviewRequired follows node flags and in-review progress', () => {
  const noReview = { workflows: [{ nodes: [{ reviewRequired: false }] }] };
  const needsReview = { workflows: [{ nodes: [{ reviewRequired: true }] }] };
  assert.equal(boardReviewRequired(noReview, undefined), false);
  assert.equal(boardReviewRequired(needsReview, undefined), true);
  const ready = (data) => ({ state: 'ready', row: data });
  assert.equal(boardReviewRequired(noReview, ready(row())), true); // in-review count > 0
  const counts = { ...row().byStatus, 'in-review': 0 };
  assert.equal(boardReviewRequired(noReview, ready(row({ byStatus: counts }))), false);
});

test('board SSR contract renders the supplied task snapshot without commands; cards may be draggable', () => {
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
  assert.ok(html.includes('draggable="true"'));
  assert.ok(!html.includes('产物全部已接受'));
});
