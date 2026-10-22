import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyWorkbench,
  applyWorkbenchCommand,
  validateWorkTask,
  parsePlanningResult,
  planningPrompt,
  createExecutionHandoff,
  WorkbenchSchema,
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
  const handoff = createExecutionHandoff(
    { taskId: task.id, planId: next.appliedPlans[0].id, revision: 1 },
    next,
  );
  assert.deepEqual(handoff.task.workflows[0].nodes[0].reviewerIds, ['qa']);
  assert.equal(handoff.participants.length, 2);
  assert.equal(handoff.assets.length, 1);
  assert.throws(
    () => createExecutionHandoff({ taskId: task.id, planId: 'missing', revision: 1 }, state),
    /指定的已确认/,
  );
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
  const handoff = createExecutionHandoff(
    { taskId: task.id, planId: confirmed.appliedPlans[0].id, revision: 1 },
    draft,
  );
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

test('applied plan: exact v1 survives a v2 draft and confirmation; wrong task/id/revision fail closed', () => {
  const { state, task } = fixture();
  const v1 = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  const ref = { taskId: task.id, planId: v1.appliedPlans[0].id, revision: 1 };
  const draft = applyWorkbenchCommand(v1, {
    type: 'save-task',
    task: {
      ...task,
      title: '第二版',
      ownerId: 'outside',
      participantIds: [...task.participantIds, 'outside'],
    },
  });
  assert.equal(draft.tasks[0].status, 'draft');
  assert.equal(createExecutionHandoff(ref, draft).task.ownerId, 'chen');
  const v2 = applyWorkbenchCommand(draft, {
    type: 'save-task',
    task: { ...draft.tasks[0], status: 'ready' },
  });
  assert.equal(createExecutionHandoff(ref, v2).task.title, task.title);
  assert.equal(
    createExecutionHandoff({ taskId: task.id, planId: v2.appliedPlans[1].id, revision: 2 }, v2).task
      .ownerId,
    'outside',
  );
  for (const bad of [
    { ...ref, taskId: 'another-task' },
    { ...ref, planId: 'missing' },
    { ...ref, revision: 2 },
  ])
    assert.throws(() => createExecutionHandoff(bad, v2), { code: 'plan-not-found' });
  assert.throws(() => createExecutionHandoff({ taskId: task.id }, v2), {
    code: 'plan-reference-required',
  });
});

test('ownership: legacy state loads without assigning the first person and requires explicit confirmation', () => {
  const { state, task } = fixture();
  const old = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  delete old.tasks[0].ownerId;
  delete old.appliedPlans[0].task.ownerId;
  const loaded = WorkbenchSchema.parse(old);
  assert.equal(loaded.tasks[0].ownerId, null);
  assert.equal(loaded.appliedPlans[0].task.ownerId, null);
  const ref = { taskId: task.id, planId: loaded.appliedPlans[0].id, revision: 1 };
  assert.equal(createExecutionHandoff(ref, loaded).task.ownerId, null);
  const draft = applyWorkbenchCommand(loaded, {
    type: 'save-task',
    task: { ...loaded.tasks[0], status: 'draft' },
  });
  assert.throws(
    () =>
      applyWorkbenchCommand(draft, {
        type: 'save-task',
        task: { ...draft.tasks[0], status: 'ready' },
      }),
    /负责人/,
  );
  const confirmed = applyWorkbenchCommand(draft, {
    type: 'save-task',
    task: { ...draft.tasks[0], status: 'ready', ownerId: 'chen' },
  });
  assert.equal(confirmed.appliedPlans[1].task.ownerId, 'chen');
  assert.equal(createExecutionHandoff(ref, confirmed).task.ownerId, null);
});

test('ownership: experts, outsiders and unavailable owners cannot confirm a task', () => {
  const { state, task } = fixture();
  for (const ownerId of ['qa', 'outside'])
    assert.throws(
      () =>
        applyWorkbenchCommand(state, {
          type: 'save-task',
          task: { ...task, ownerId, status: 'ready' },
        }),
      /真人成员/,
    );
  state.participants[0].available = false;
  assert.match(validateWorkTask({ ...task, status: 'ready' }, state).join(), /负责人当前不可用/);
});

test('planning: a legacy task can receive a proposal without AI choosing its human owner', () => {
  const { state, task } = fixture();
  task.ownerId = null;
  const result = {
    summary: '确认前选择负责人',
    questions: [],
    assumptions: [],
    workflows: task.workflows,
  };
  assert.equal(parsePlanningResult(JSON.stringify(result), state, task).workflows.length, 1);
  assert.equal(JSON.parse(planningPrompt(state, task, '').input).context.task.ownerId, null);
  assert.equal(task.ownerId, null);
  assert.throws(
    () => applyWorkbenchCommand(state, { type: 'save-task', task: { ...task, status: 'ready' } }),
    /负责人/,
  );
});
