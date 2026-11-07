/** Decision contract only. It does not render, start a plan, or prove a browser. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedPlanAction } from '../dist/workbench/confirmed-plan-action.js';
import { row, unknown } from './task-progress-fixture.mjs';

const notStarted = {
  state: 'ready',
  row: row({
    facts: 'not-started',
    delivery: 'pending',
    expectedNodes: 1,
    acceptedNodes: 0,
    byStatus: Object.fromEntries(Object.keys(row().byStatus).map((status) => [status, 0])),
    assigneeCounts: { human: 1, expert: 0 },
    resources: { authorHeld: 0, reviewHeld: 0, stopRequested: 0 },
  }),
};

test('a confirmed plan offers start only when it has not started and the caller can start it', () => {
  assert.equal(confirmedPlanAction(notStarted, true), 'start');
  for (const progress of [
    undefined,
    { state: 'loading' },
    { state: 'error', message: '进度无法核实' },
    { state: 'ready', row: unknown() },
    { state: 'ready', row: row() },
    notStarted,
  ])
    assert.equal(confirmedPlanAction(progress, false), 'view');
  for (const progress of [
    undefined,
    { state: 'loading' },
    { state: 'error', message: '进度无法核实' },
    { state: 'ready', row: unknown() },
    { state: 'ready', row: row() },
  ])
    assert.equal(confirmedPlanAction(progress, true), 'view');
});
