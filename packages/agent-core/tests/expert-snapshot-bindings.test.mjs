/** Definition contracts only; no member authorization, connection or model execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  createExecutionHandoff,
  createNodeHandoffs,
  WorkbenchSchema,
} from '../dist/index.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function bound(role = 'reviewer') {
  const data = fixture();
  data.node.skillIds = [];
  data.node.mcpIds = [];
  if (role === 'executor') {
    data.node.assigneeId = 'qa';
    data.node.reviewerIds = ['chen'];
  }
  const expert = data.state.participants.find((item) => item.id === 'qa');
  expert.instructions = 'Use the frozen expert method';
  expert.resourceBindings = { skillIds: ['api-skill'], mcpIds: ['docs-mcp'] };
  data.state.assets.push({
    ...data.state.assets[0],
    id: 'docs-mcp',
    kind: 'mcp',
    content: 'Fixed MCP definition',
  });
  return { ...data, expert };
}
const confirm = ({ state, task }) =>
  applyWorkbenchCommand(state, { type: 'save-task', task: { ...task, status: 'ready' } });
const read = (state) =>
  createExecutionHandoff({ taskId: 'task', planId: 'task-v1', revision: 1 }, state);

for (const role of ['executor', 'reviewer']) {
  test(`expert snapshot: ${role} dependencies freeze even when they are not author node tools`, () => {
    const data = bound(role),
      state = confirm(data),
      plan = read(state);
    assert.deepEqual(plan.assets, data.state.assets);
    assert.deepEqual(
      plan.participants.find((item) => item.id === 'qa').resourceBindings,
      data.expert.resourceBindings,
    );
    const [handoff] = createNodeHandoffs(plan);
    assert.deepEqual(handoff.skillRefs, []);
    assert.deepEqual(handoff.mcpRefs, []);
    assert.deepEqual(
      data.node.skillIds,
      [],
      'Confirming does not add reviewer tools to the author node',
    );
  });
  test(`expert snapshot: ${role} missing, wrong-kind, disabled or duplicate dependencies block confirmation`, () => {
    for (const mutate of [
      (data) => {
        data.state.assets = [];
      },
      (data) => {
        data.state.assets[0].kind = 'mcp';
      },
      (data) => {
        data.state.assets[1].kind = 'skill';
      },
      (data) => {
        data.state.assets[0].available = false;
      },
      (data) => {
        data.state.assets[1].available = false;
      },
      (data) => {
        data.expert.resourceBindings.skillIds.push('api-skill');
      },
      (data) => {
        data.expert.resourceBindings.mcpIds.push('docs-mcp');
      },
    ]) {
      const data = bound(role);
      mutate(data);
      assert.equal(
        applyWorkbenchCommand(data.state, { type: 'save-task', task: data.task }).tasks[0].status,
        'draft',
      );
      assert.throws(() => confirm(data), { code: 'validation' });
      assert.equal(data.state.appliedPlans.length, 0);
    }
  });
}

test('expert snapshot: only actually assigned expert dependencies enter the frozen asset set, without duplicates', () => {
  const data = bound();
  data.node.skillIds = ['api-skill'];
  data.task.participantIds.push('unused');
  data.state.participants.push({
    ...data.expert,
    id: 'unused',
    resourceBindings: { skillIds: ['missing-unused'], mcpIds: [] },
  });
  data.state.assets.push({ ...data.state.assets[0], id: 'unrelated' });
  const state = confirm(data);
  assert.deepEqual(
    read(state).assets.map((item) => item.id),
    ['api-skill', 'docs-mcp'],
  );
  assert.equal(
    read(state).participants.some((item) => item.id === 'unused'),
    true,
  );
});

test('expert snapshot: live catalog edits and a later confirmation cannot change old source definitions', () => {
  const data = bound('executor'),
    first = confirm(data),
    before = read(first);
  first.assets[0].content = 'New Skill body';
  first.assets[1].content = 'New MCP body';
  first.participants.find((item) => item.id === 'qa').instructions = 'New expert method';
  const draft = applyWorkbenchCommand(first, { type: 'save-task', task: data.task });
  const second = applyWorkbenchCommand(draft, {
    type: 'save-task',
    task: { ...data.task, status: 'ready' },
  });
  assert.deepEqual(read(second), before);
  const newer = createExecutionHandoff({ taskId: 'task', planId: 'task-v2', revision: 2 }, second);
  assert.equal(newer.assets[0].content, 'New Skill body');
  assert.equal(newer.assets[1].content, 'New MCP body');
  newer.assets[0].content = 'Mutated read';
  assert.deepEqual(read(second), before);
});

test('expert snapshot: old incomplete snapshots remain readable and are never backfilled from live assets', () => {
  const data = bound(),
    state = confirm(data);
  state.appliedPlans[0].assets = [];
  const before = structuredClone(state.appliedPlans[0]);
  const reopened = WorkbenchSchema.parse(state);
  assert.deepEqual(read(reopened), before);
  assert.deepEqual(read(reopened).assets, []);
  assert.throws(() => createNodeHandoffs(read(reopened)), { code: 'invalid-handoff' });
  assert.deepEqual(reopened.appliedPlans[0], before);
  const legacy = bound();
  delete legacy.expert.resourceBindings;
  assert.equal(createNodeHandoffs(read(confirm(legacy))).length, 1);
});
