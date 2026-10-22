import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  createExecutionHandoff,
  createNodeHandoffs,
  readNodeHandoff,
} from '../dist/index.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function confirmed() {
  const { state, task } = fixture();
  const next = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  return { state: next, plan: createExecutionHandoff(next.tasks[0], next) };
}

test('A/B handoff: human has no engine/expert; resource refs bind the frozen plan version', () => {
  const { state, plan } = confirmed();
  state.assets[0].content = 'Changed catalog';
  state.participants[0].name = 'Changed directory';
  const [handoff] = createNodeHandoffs(plan);
  assert.equal(readNodeHandoff(handoff).ok, true);
  assert.equal(handoff.assignee.kind, 'human');
  assert.equal('engine' in handoff, false);
  assert.equal('expertRef' in handoff, false);
  assert.equal(handoff.workflowVersionId, plan.id);
  assert.equal(handoff.revision, plan.revision);
  assert.deepEqual(handoff.skillRefs, [{ id: 'api-skill', version: plan.id }]);
  assert.equal(handoff.inputNote, plan.task.workflows[0].nodes[0].input);
  assert.equal(handoff.expectedOutput, plan.task.workflows[0].nodes[0].output);
  assert.deepEqual(handoff.inputRefs, []);
  handoff.reviewerIds.push('mutated-return');
  assert.deepEqual(createNodeHandoffs(plan)[0].reviewerIds, ['qa']);
});

test('A/B handoff: expert identity must resolve to the same frozen expert definition', () => {
  const { state, task, node } = fixture();
  node.assigneeId = 'qa';
  node.reviewerIds = ['chen'];
  state.assets.push({ ...state.assets[0], id: 'docs-mcp', kind: 'mcp' });
  node.mcpIds = ['docs-mcp'];
  const next = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  const plan = createExecutionHandoff(next.tasks[0], next);
  const [handoff] = createNodeHandoffs(plan);
  assert.equal(readNodeHandoff(handoff).ok, true);
  assert.deepEqual(handoff.assignee, { id: 'qa', kind: 'expert' });
  assert.deepEqual(handoff.expertRef, { id: 'qa', version: plan.id });
  assert.deepEqual(handoff.mcpRefs, [{ id: 'docs-mcp', version: plan.id }]);
});

test('A/B handoff: nested drafts cannot be silently flattened into independent runnable nodes', () => {
  const { plan } = confirmed();
  const node = plan.task.workflows[0].nodes[0];
  plan.task.workflows.push({
    id: 'child',
    name: 'child',
    parentNodeId: node.id,
    nodes: [{ ...node, id: 'child-node' }],
  });
  assert.throws(() => createNodeHandoffs(plan), { code: 'child-task-required' });
});

test('A/B handoff: mismatched task, incomplete snapshot and self review fail before dispatch', () => {
  const { plan } = confirmed();
  assert.throws(() => createNodeHandoffs({ ...plan, taskId: 'different' }), {
    code: 'invalid-handoff',
  });
  assert.throws(() => createNodeHandoffs({ ...plan, assets: [] }), { code: 'invalid-handoff' });
  plan.task.workflows[0].nodes[0].reviewerIds = ['chen'];
  assert.throws(() => createNodeHandoffs(plan), { code: 'invalid-handoff' });
});
