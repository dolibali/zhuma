import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskView, VIEW_MODES } from '@zhuma/client';

const task = { id: 't-1', title: 'Example', status: 'running', planRevision: 2 };

test('all views refer to the same task and plan', () => {
  for (const view of VIEW_MODES) {
    const model = createTaskView(task, view);
    assert.equal(model.taskId, task.id);
    assert.equal(model.planRevision, 2);
    assert.equal(model.status, 'running');
  }
});
test('switching view does not mutate task facts', () => {
  const before = structuredClone(task);
  createTaskView(task, 'compose');
  assert.deepEqual(task, before);
});
test('interrupted is not displayed as completed', () => {
  assert.equal(createTaskView({ ...task, status: 'interrupted' }, 'run').statusLabel, '中断待核对');
});
