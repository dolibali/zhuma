import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_PLANNING_FIELDS,
  comparePlanningWorkflows,
  validateLocalPlanningChange,
  planningPrompt,
  PlanRequestSchema,
} from '../dist/index.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const scope = (nodeId, fields = [...LOCAL_PLANNING_FIELDS]) => ({ nodeId, fields });

test('assignment-only scope protects target reviews, resources, instructions and output', () => {
  const { task } = nested();
  const after = structuredClone(task.workflows);
  after[0].nodes[0].assigneeId = 'qa';
  validateLocalPlanningChange(task.workflows, after, scope('node-1', ['assigneeId', 'rationale']));
  for (const field of ['skillIds', 'reviewerIds', 'reviewRequired', 'output', 'description']) {
    const candidate = structuredClone(after);
    candidate[0].nodes[0][field] = field.endsWith('Ids')
      ? []
      : field === 'reviewRequired'
        ? false
        : '未授权修改';
    assert.throws(
      () =>
        validateLocalPlanningChange(
          task.workflows,
          candidate,
          scope('node-1', ['assigneeId', 'rationale']),
        ),
      (e) => e.code === 'invalid-plan',
    );
  }
  for (const fields of [[], ['assigneeId', 'assigneeId'], ['dependsOn'], ['position']])
    assert.equal(
      PlanRequestSchema.safeParse({
        requestId: crypto.randomUUID(),
        taskId: task.id,
        expectedRevision: 0,
        instruction: '',
        adjustment: scope('node-1', fields),
      }).success,
      false,
    );
});

function nested() {
  const { state, task, node } = fixture();
  task.workflows[0].nodes.push({
    ...structuredClone(node),
    id: 'manual',
    title: '人工配置',
    dependsOn: ['node-1'],
    position: { x: 500, y: 300 },
  });
  task.workflows.push({
    id: 'child',
    name: '下层工作流',
    parentNodeId: 'manual',
    nodes: [{ ...structuredClone(node), id: 'child-node' }],
  });
  return { state, task };
}

test('local planning contract: target configuration may change while the full manual hierarchy stays byte-equivalent', () => {
  const { task } = nested();
  const before = structuredClone(task.workflows);
  const next = structuredClone(before);
  next[0].nodes[0].title = '补齐登录接口';
  next[0].nodes[0].input = '用户补充的需求';
  next[0].nodes[0].output = '更新接口说明';
  validateLocalPlanningChange(before, next, scope('node-1'));
  assert.deepEqual(task.workflows, before);
  const diff = comparePlanningWorkflows(before, next);
  assert.equal(diff.nodes.length, 1);
  assert.deepEqual(diff.nodes[0].fields, ['title', 'input', 'output']);
  assert.equal(diff.workflows.length, 0);
});

test('local planning contract: foreign assignment, reviews, resources and nested manual changes are rejected, including topology and layout', () => {
  const { task } = nested();
  const changes = [
    (w) => (w[0].nodes[1].assigneeId = 'qa'),
    (w) => (w[0].nodes[1].reviewRequired = false),
    (w) => (w[0].nodes[1].reviewerIds = []),
    (w) => (w[0].nodes[1].skillIds = []),
    (w) => (w[0].nodes[1].output = '不应覆盖人工交付'),
    (w) => (w[1].nodes[0].description = '越界'),
    (w) => (w[1].parentNodeId = 'node-1'),
    (w) => (w[0].nodes[0].position.x += 20),
    (w) => (w[0].nodes[0].dependsOn = ['manual']),
    (w) => w[0].nodes.reverse(),
    (w) => w.reverse(),
    (w) => w[0].nodes.pop(),
    (w) => w[0].nodes.push({ ...w[0].nodes[0], id: 'extra' }),
    (w) => (w[0].name = '不能重命名工作流'),
  ];
  for (const change of changes) {
    const candidate = structuredClone(task.workflows);
    change(candidate);
    assert.throws(
      () => validateLocalPlanningChange(task.workflows, candidate, scope('node-1')),
      (e) => e.code === 'invalid-plan',
    );
  }
  assert.throws(
    () => validateLocalPlanningChange(task.workflows, task.workflows, scope('absent')),
    (e) => e.code === 'invalid-scope',
  );
});

test('planning diff contract: additions, deletions, metadata, dependencies and pure ordering/layout changes remain visible', () => {
  const { task } = nested();
  const after = structuredClone(task.workflows);
  after[0].nodes[0].dependsOn = ['manual'];
  after[0].nodes[0].position = { x: 10, y: 30 };
  after[0].nodes.reverse();
  after[1].name = '重命名';
  after[1].parentNodeId = 'node-1';
  after[1].nodes = [{ ...after[1].nodes[0], id: 'replacement' }];
  after.reverse();
  const diff = comparePlanningWorkflows(task.workflows, after);
  assert.equal(diff.orderChanged, true);
  assert.deepEqual(diff.nodes.find((n) => n.kind === 'changed').fields, ['dependsOn', 'position']);
  assert.ok(diff.nodes.some((n) => n.kind === 'removed' && n.before.id === 'child-node'));
  assert.ok(diff.nodes.some((n) => n.kind === 'added' && n.after.id === 'replacement'));
  assert.deepEqual(
    diff.workflows.find((w) => w.kind === 'changed' && w.after.id === 'child').fields,
    ['name', 'parentNodeId', 'nodeOrder'],
  );
  assert.equal(
    comparePlanningWorkflows(task.workflows, structuredClone(task.workflows)).changed,
    false,
  );
});

test('local planning contract: scope is an explicit request field against the unapplied proposal, never inferred from natural language', () => {
  const { state, task } = nested();
  const prompt = planningPrompt(state, task, '只改第一个节点');
  assert.equal(JSON.parse(prompt.input).adjustment, undefined);
  assert.throws(
    () => planningPrompt(state, task, '', undefined, scope('new-node')),
    (e) => e.code === 'invalid-scope',
  );
  const result = {
    summary: '草案',
    assumptions: [],
    questions: [],
    workflows: structuredClone(task.workflows),
  };
  result.workflows[0].nodes.push({ ...result.workflows[0].nodes[0], id: 'new-node' });
  const proposal = {
    id: crypto.randomUUID(),
    taskId: task.id,
    baseRevision: 0,
    model: 'contract',
    result,
  };
  const local = JSON.parse(
    planningPrompt(state, task, '调整此节点', proposal, scope('new-node')).input,
  );
  assert.equal(local.adjustment.nodeId, 'new-node');
  assert.ok(!local.adjustment.fields.includes('dependsOn'));
  assert.ok(!local.adjustment.fields.includes('position'));
  assert.deepEqual(local.context.currentWorkflows, result.workflows);
  assert.equal(
    PlanRequestSchema.safeParse({
      requestId: crypto.randomUUID(),
      taskId: task.id,
      expectedRevision: 0,
      instruction: '',
      adjustment: scope(''),
    }).success,
    false,
  );
});
