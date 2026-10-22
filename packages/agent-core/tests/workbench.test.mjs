import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyWorkbench,
  applyWorkbenchCommand,
  validateWorkTask,
  parsePlanningResult,
  planningPrompt,
  createExecutionHandoff,
} from '../dist/index.js';

import { fixture } from '../../../tests/fixtures/workbench.mjs';

test('workbench: humans need no engine/model; reviewed definition crosses handoff unchanged', () => {
  const { state, task } = fixture();
  const next = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  assert.equal(next.revision, 1);
  assert.equal(state.revision, 0);
  const handoff = createExecutionHandoff(next.tasks[0], next);
  assert.deepEqual(handoff.task.workflows[0].nodes[0].reviewerIds, ['qa']);
  assert.equal(handoff.participants.length, 2);
  assert.equal(handoff.assets.length, 1);
  assert.throws(() => createExecutionHandoff(task, state), /先确认/);
});

test('workbench: dependency and hierarchy cycles, self-review and removed assignees are refused', () => {
  const { state, task, node } = fixture();
  node.dependsOn = [node.id];
  assert.match(validateWorkTask(task, state).join(), /循环/);
  node.dependsOn = [];
  node.reviewerIds = ['chen'];
  assert.match(validateWorkTask(task, state).join(), /评审自己/);
  task.participantIds = ['qa'];
  assert.match(validateWorkTask(task, state).join(), /未参与/);
  task.workflows[0].parentNodeId = node.id;
  assert.match(validateWorkTask(task, state).join(), /工作树不能包含循环/);
});

test('workbench: multi-reviewers and nested workflows validate, unavailable assets block confirmation', () => {
  const { state, task, node } = fixture();
  task.participantIds.push('outside');
  node.reviewerIds.push('outside');
  const child = { ...node, id: 'child', reviewerIds: [], reviewRequired: false };
  task.workflows.push({
    id: 'child-flow',
    name: '细化接口',
    parentNodeId: node.id,
    nodes: [child],
  });
  assert.deepEqual(validateWorkTask(task, state), []);
  state.assets[0].available = false;
  task.status = 'ready';
  assert.match(validateWorkTask(task, state).join(), /不可用/);
});

test('planning contract: only eligible participants and available asset definitions enter prompt', () => {
  const { state, task } = fixture();
  state.assets.push({ ...state.assets[0], id: 'disabled', available: false });
  const prompt = planningPrompt(state, task, '让质量专家做评审');
  const context = JSON.parse(prompt.input).context;
  assert.deepEqual(
    context.participants.map((p) => p.id),
    ['chen', 'qa'],
  );
  assert.deepEqual(
    context.assets.map((a) => a.id),
    ['api-skill'],
  );
  assert.equal(context.instruction, '让质量专家做评审');
  assert.match(prompt.system, /不能编造/);
});

test('planning contract: hallucinated IDs, missing outputs, invalid graphs and extra fields fail closed', () => {
  const { state, task } = fixture();
  const result = {
    summary: '按接口与测试能力分工',
    assumptions: [],
    questions: [],
    workflows: task.workflows,
  };
  assert.equal(parsePlanningResult(JSON.stringify(result), state, task).workflows.length, 1);
  const invalid = structuredClone(result);
  invalid.workflows[0].nodes[0].assigneeId = 'invented';
  assert.throws(() => parsePlanningResult(JSON.stringify(invalid), state, task), /未参与/);
  invalid.workflows[0].nodes[0].assigneeId = 'chen';
  invalid.workflows[0].nodes[0].mcpIds = ['made-up-mcp'];
  assert.throws(() => parsePlanningResult(JSON.stringify(invalid), state, task), /mcp/);
  assert.throws(
    () => parsePlanningResult(JSON.stringify({ ...result, autoExecute: true }), state, task),
    /字段/,
  );
  assert.throws(() => parsePlanningResult('not json', state, task), /JSON/);
  assert.throws(
    () => parsePlanningResult(JSON.stringify({ ...result, workflows: [] }), state, task),
    /根工作流/,
  );
  assert.equal(
    parsePlanningResult(
      JSON.stringify({ ...result, workflows: [], questions: ['使用哪种身份源？'] }),
      state,
      task,
    ).questions.length,
    1,
  );
});

test('applied plan: later drafts, catalog edits and returned payloads cannot rewrite handoff', () => {
  const { state, task } = fixture();
  const confirmed = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  assert.equal(confirmed.appliedPlans[0].revision, 1);
  const draft = applyWorkbenchCommand(confirmed, {
    type: 'save-task',
    task: { ...task, title: '新版草稿' },
  });
  draft.participants[0].name = '新名称';
  draft.assets[0].content = '新的方法';
  assert.equal(draft.appliedPlans[0].task.title, task.title);
  const handoff = createExecutionHandoff(confirmed.tasks[0], draft);
  assert.equal(handoff.participants[0].name, '陈宁');
  handoff.participants[0].name = 'mutated';
  assert.equal(draft.appliedPlans[0].participants[0].name, '陈宁');
  const v2 = applyWorkbenchCommand(draft, {
    type: 'save-task',
    task: { ...draft.tasks[0], status: 'ready' },
  });
  assert.deepEqual(
    v2.appliedPlans.map((p) => p.revision),
    [1, 2],
  );
  assert.throws(
    () => applyWorkbenchCommand(v2, { type: 'save-task', task: v2.tasks[0] }),
    /编辑草稿/,
  );
});

test('drafts may leave review assignments incomplete; confirmation still enforces the gate', () => {
  const { state, task, node } = fixture();
  node.reviewerIds = [];
  const draft = applyWorkbenchCommand(state, { type: 'save-task', task });
  assert.equal(draft.tasks[0].status, 'draft');
  assert.throws(
    () => applyWorkbenchCommand(draft, { type: 'save-task', task: { ...task, status: 'ready' } }),
    /评审人/,
  );
});
