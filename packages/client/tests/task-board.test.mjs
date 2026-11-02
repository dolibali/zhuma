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

test('board drag refuses every cross-column move, including planning drafts', () => {
  assert.equal(boardDragDecision('running', 'running', { reviewRequired: true }).type, 'same');
  assert.equal(boardDragDecision('planning', 'planning', { reviewRequired: false }).type, 'same');
  // running/review→ended have no client drag command — refuse (no fake stage).
  assert.equal(
    boardDragDecision('running', 'ended', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  assert.equal(
    boardDragDecision('running', 'ended', { reviewRequired: false }).type,
    'reject-no-authority',
  );
  assert.equal(
    boardDragDecision('review', 'ended', { reviewRequired: true }).type,
    'reject-no-authority',
  );
  assert.equal(
    boardDragDecision('review', 'attention', { reviewRequired: true }).type,
    'reject-no-authority',
  );
  assert.equal(
    boardDragDecision('attention', 'running', { reviewRequired: false }).type,
    'reject-no-authority',
  );
  assert.equal(
    boardDragDecision('attention', 'ended', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  // Dragging a planning card must not confirm the draft, whatever the target column is.
  assert.equal(
    boardDragDecision('planning', 'attention', { reviewRequired: false }).type,
    'reject-no-authority',
  );
  assert.equal(
    boardDragDecision('planning', 'running', { reviewRequired: true }).type,
    'reject-no-authority',
  );
  assert.equal(
    boardDragDecision('planning', 'running', { reviewRequired: false }).type,
    'reject-no-authority',
  );
  assert.equal(
    boardDragDecision('planning', 'ended', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  assert.equal(
    boardDragDecision('planning', 'ended', { reviewRequired: false }).type,
    'reject-no-authority',
  );
  // Faking the review column always bypasses submit-for-review.
  assert.equal(
    boardDragDecision('running', 'review', { reviewRequired: true }).type,
    'reject-bypass-review',
  );
  assert.equal(
    boardDragDecision('planning', 'review', { reviewRequired: false }).type,
    'reject-bypass-review',
  );
  assert.equal(
    boardDragDecision('unknown', 'attention', { reviewRequired: false }).type,
    'reject-no-authority',
  );
  const columns = ['planning', 'attention', 'running', 'review', 'ended', 'unknown'];
  for (const from of columns) {
    for (const to of columns) {
      for (const reviewRequired of [false, true]) {
        const type = boardDragDecision(from, to, { reviewRequired }).type;
        assert.notEqual(type, 'allow', `${from} → ${to} reviewRequired=${reviewRequired}`);
        if (from === to) assert.equal(type, 'same');
        else assert.notEqual(type, 'same');
      }
    }
  }
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

test('TaskBoard source has no session placements and drag does not confirm a plan', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/workbench/TaskBoard.tsx', import.meta.url), 'utf8');
  const page = await readFile(
    new URL('../src/workbench/WorkbenchPage.tsx', import.meta.url),
    'utf8',
  );
  const decision = await readFile(
    new URL('../src/workbench/task-board.ts', import.meta.url),
    'utf8',
  );
  assert.equal(/setPlacements|placements\[/.test(source), false);
  assert.equal(/onMoveTask|save-task|已确认计划/.test(source), false);
  assert.equal(/onMoveTask/.test(page), false);
  assert.equal(/type: 'allow'/.test(decision), false);
  assert.match(source, /taskBoardColumn\(/);
});
