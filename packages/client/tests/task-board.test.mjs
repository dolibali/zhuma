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
  taskBoardColumns,
  visibleTaskBoardColumns,
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
  assert.equal(taskBoardColumn(task, true, ready(row())), 'running');
  assert.equal(taskBoardColumn(task, true, ready(row({ facts: 'not-started' }))), 'attention');
  const idle = {
    byStatus: { ...row().byStatus, running: 0 },
    resources: { authorHeld: 0, reviewHeld: 1, stopRequested: 0 },
    workflow: 'inactive',
  };
  assert.equal(taskBoardColumn(task, true, ready(row(idle))), 'review');
  const counts = { ...row().byStatus, 'in-review': 0 };
  assert.equal(taskBoardColumn(task, true, ready(row({ byStatus: counts }))), 'running');
  assert.equal(
    taskBoardColumn(
      task,
      true,
      ready(
        row({
          byStatus: { ...counts, running: 0, 'needs-revision': 1, completed: 4 },
          resources: { authorHeld: 0, reviewHeld: 0, stopRequested: 0 },
          workflow: 'inactive',
        }),
      ),
    ),
    'attention',
  );
  const quiet = { authorHeld: 0, reviewHeld: 0, stopRequested: 0 };
  const queued = {
    byStatus: { ...row().byStatus, running: 0, 'in-review': 0, completed: 1, ready: 3, blocked: 1 },
    resources: quiet,
    workflow: 'running',
    nodeStatuses: [
      { nodeId: 'first', status: 'ready', authorHeld: 0, assignee: 'expert' },
      { nodeId: 'second', status: 'ready', authorHeld: 0, assignee: 'expert' },
      { nodeId: 'human', status: 'ready', authorHeld: 0, assignee: 'human' },
      { nodeId: 'join', status: 'blocked', authorHeld: 0, assignee: 'expert' },
      { nodeId: 'done', status: 'completed', authorHeld: 0, assignee: 'expert' },
    ],
  };
  assert.equal(taskBoardColumn(task, true, ready(row(queued))), 'running');
  assert.equal(
    taskBoardColumn(
      task,
      true,
      ready(
        row({
          ...queued,
          nodeStatuses: queued.nodeStatuses.map((node) =>
            node.assignee === 'expert' && node.status === 'ready'
              ? { ...node, status: 'completed', assignee: 'expert' }
              : node,
          ),
          workflow: 'running',
        }),
      ),
    ),
    'attention',
  );
  assert.equal(
    taskBoardColumn(
      task,
      true,
      ready(
        row({
          byStatus: {
            ...row().byStatus,
            running: 0,
            'in-review': 0,
            completed: 0,
            ready: 3,
            blocked: 2,
          },
          resources: quiet,
          workflow: 'requires-resume',
          nodeStatuses: [
            { nodeId: 'first', status: 'ready', authorHeld: 0, assignee: 'expert' },
            { nodeId: 'second', status: 'ready', authorHeld: 0, assignee: 'expert' },
            { nodeId: 'human', status: 'ready', authorHeld: 0, assignee: 'human' },
            { nodeId: 'join', status: 'blocked', authorHeld: 0, assignee: 'expert' },
            { nodeId: 'later', status: 'blocked', authorHeld: 0, assignee: 'expert' },
          ],
        }),
      ),
    ),
    'attention',
  );
  assert.equal(
    taskBoardColumn(
      task,
      true,
      ready(
        row({
          byStatus: {
            ...row().byStatus,
            running: 0,
            'in-review': 0,
            completed: 0,
            ready: 2,
            blocked: 3,
          },
          resources: { authorHeld: 1, reviewHeld: 0, stopRequested: 0 },
          workflow: 'requires-resume',
          nodeStatuses: [
            { nodeId: 'first', status: 'ready', authorHeld: 1, assignee: 'expert' },
            { nodeId: 'human', status: 'ready', authorHeld: 0, assignee: 'human' },
            { nodeId: 'b1', status: 'blocked', authorHeld: 0, assignee: 'expert' },
            { nodeId: 'b2', status: 'blocked', authorHeld: 0, assignee: 'expert' },
            { nodeId: 'b3', status: 'blocked', authorHeld: 0, assignee: 'expert' },
          ],
        }),
      ),
    ),
    'running',
  );
  for (const delivery of ['cancelled', 'mixed-terminal', 'all-accepted'])
    assert.equal(taskBoardColumn(task, true, ready(row({ delivery }))), 'ended');
  // Editing a next draft never overwrites the previous confirmed plan's facts.
  const draft = { status: 'draft' };
  assert.equal(taskBoardColumn(draft, true, ready(row())), 'running');
  assert.equal(taskBoardColumn(draft, true, ready(row(idle))), 'review');
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

test('visible board columns keep pipeline order and add 待核实 only when unknown is occupied', () => {
  const ids = (columns) => columns.map((column) => column.id);
  const pipeline = ['planning', 'attention', 'running', 'review', 'ended'];
  assert.deepEqual(ids(taskBoardColumns), [...pipeline, 'unknown']);
  assert.deepEqual(ids(visibleTaskBoardColumns([])), pipeline);
  assert.deepEqual(ids(visibleTaskBoardColumns(['ended', 'planning'])), pipeline);
  assert.deepEqual(ids(visibleTaskBoardColumns(['unknown', 'unknown'])), [...pipeline, 'unknown']);
  assert.deepEqual(ids(visibleTaskBoardColumns(['review', 'unknown'])), [...pipeline, 'unknown']);
  assert.equal(visibleTaskBoardColumns(['unknown']).at(-1).label, '待核实');
  assert.deepEqual(ids(taskBoardColumns), [...pipeline, 'unknown']);
});

test('board hides an empty 待核实 column and shows it after 已结束 when a task projects there', () => {
  const { state, task } = fixture();
  const markup = (tasks, confirmed, progress = () => undefined) =>
    renderToStaticMarkup(
      createElement(TaskBoard, {
        tasks,
        projects: state.projects,
        participants: state.participants,
        progress,
        confirmed,
        openTask: () => {
          throw new Error('Rendering must not start a command');
        },
      }),
    );
  const pipeline = ['规划中', '待处理', '进行中', '待评审', '已结束'];
  const hidden = markup(state.tasks, () => false);
  assert.equal(hidden.includes('待核实'), false);
  assert.match(hidden, /grid-template-columns:repeat\(5, minmax\(210px, 1fr\)\)/);
  assert.ok(hidden.includes('draggable="true"'));
  assert.ok(hidden.includes('暂无任务'));
  let at = 0;
  for (const label of pipeline) {
    const next = hidden.indexOf(`aria-label="${label} `, at);
    assert.ok(next > at, label);
    at = next;
  }

  const pending = { ...task, id: 'pending', title: '接口核对', status: 'ready' };
  const shown = markup([task, pending], () => false);
  assert.match(shown, /aria-label="待核实 1 项"/);
  assert.match(shown, /grid-template-columns:repeat\(6, minmax\(210px, 1fr\)\)/);
  assert.ok(shown.indexOf('aria-label="已结束') < shown.indexOf('aria-label="待核实'));
  assert.ok(shown.includes('接口核对'));
  assert.ok(shown.includes(task.title));
  for (const label of pipeline) assert.ok(shown.includes(`aria-label="${label} `));

  const verified = markup(
    [task],
    () => true,
    () => ({ state: 'ready', row: unknown() }),
  );
  assert.match(verified, /aria-label="待核实 1 项"/);
  assert.ok(verified.includes(task.title));
  assert.equal(/onMoveTask|save-task/.test(verified), false);
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
