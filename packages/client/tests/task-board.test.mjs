import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_STATUSES } from '@zhuma/agent-core';
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
    workflow: null,
    nodeStatuses: null,
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
    'running',
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
    'running',
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
          workflow: 'inactive',
          nodeStatuses: [
            { nodeId: 'human', status: 'ready', authorHeld: 0, assignee: 'human' },
            { nodeId: 'expert', status: 'blocked', authorHeld: 0, assignee: 'expert' },
          ],
        }),
      ),
    ),
    'running',
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
          workflow: 'requires-resume',
          nodeStatuses: [{ nodeId: 'expert', status: 'ready', authorHeld: 0, assignee: 'expert' }],
        }),
      ),
    ),
    'attention',
  );
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
