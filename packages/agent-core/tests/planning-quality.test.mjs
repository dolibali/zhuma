import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlanningContext,
  PLANNING_BUDGET,
  parsePlanningResult,
  planningPrompt,
  WorkbenchSchema,
  PlanProposalSchema,
} from '../dist/index.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { planningScenarios } from '../../../tests/fixtures/planning-scenarios.mjs';

const result = (task) => ({
  summary: '可编辑提案',
  questions: [],
  assumptions: [],
  workflows: task.workflows,
});
const asset = (id, name, kind = 'skill') => ({
  id,
  name,
  kind,
  description: name,
  content: `使用 ${name} 的资源定义。`,
  available: true,
});

for (const scenario of planningScenarios) {
  test(`planning retrieval contract: ${scenario.id}`, () => {
    const { state, task, node } = fixture();
    task.title = scenario.goal;
    task.goal = scenario.goal;
    node.skillIds = [];
    state.assets = [
      asset('unrelated', '咖啡烘焙温度'),
      asset('relevant', scenario.resource, scenario.kind),
    ];
    const context = buildPlanningContext(state, task, '');
    assert.deepEqual(
      context.assets.map((a) => a.id),
      ['relevant'],
    );
    assert.equal(context.assets[0].selection, 'related');
    assert.deepEqual(context.currentWorkflows, task.workflows);
    assert.equal(context.task.ownerId, 'chen');
    assert.deepEqual(
      context.participants.map((p) => p.id),
      ['chen', 'qa'],
    );
    assert.equal(context.selection.executionAuthorization, 'unknown');
  });
}

test('planning context: 100 large resources fit without dropping bound definitions or changing a nested baseline', () => {
  const { state, task, node } = fixture();
  const long = 'API 资料与接口字段。'.repeat(500);
  state.assets = Array.from({ length: 99 }, (_, i) => ({
    ...asset(`a-${i}`, `API 资料 ${i}`),
    description: long,
    content: long,
  }));
  state.assets.push({ ...asset('api-skill', '保留人工绑定'), content: long });
  const proposal = {
    id: 'proposal',
    taskId: task.id,
    baseRevision: state.revision,
    model: 'contract-only',
    result: {
      ...result(task),
      workflows: [
        ...task.workflows,
        {
          id: 'child',
          name: '嵌套工作',
          parentNodeId: node.id,
          nodes: [{ ...node, id: 'child-node' }],
        },
      ],
    },
  };
  WorkbenchSchema.parse(state);
  PlanProposalSchema.parse(proposal);
  const before = structuredClone({ state, proposal });
  const context = buildPlanningContext(state, task, 'API 调整', proposal);
  assert.equal(context.assets[0].id, 'api-skill');
  assert.equal(context.assets[0].selection, 'bound');
  assert(context.assets.some((a) => a.excerpted));
  assert(context.assets.length <= PLANNING_BUDGET.assets);
  assert(JSON.stringify(context).length <= PLANNING_BUDGET.contextChars);
  assert.deepEqual(context.currentWorkflows, proposal.result.workflows);
  assert.deepEqual({ state, proposal }, before);
  const reversed = buildPlanningContext(
    { ...state, assets: [...state.assets].reverse() },
    task,
    'API 调整',
    proposal,
  );
  assert.deepEqual(reversed.assets, context.assets);
});

test('planning context: removing a tool or changing selected people changes only authorized candidates and keeps unknown facts unknown', () => {
  const { state, task, node } = fixture();
  node.skillIds = [];
  task.goal = '整理公开市场数据';
  state.assets = [asset('market', '公开市场数据', 'mcp')];
  state.tasks.push({
    ...structuredClone(task),
    id: 'other',
    title: 'OTHER_TASK_SENTINEL',
    status: 'ready',
  });
  state.projects.push({ id: 'other-project', name: 'OTHER_PROJECT_SENTINEL', description: '' });
  assert.equal(buildPlanningContext(state, task, '').assets[0].id, 'market');
  state.assets[0].available = false;
  state.participants.find((p) => p.id === 'qa').available = false;
  const context = buildPlanningContext(state, task, '');
  assert.deepEqual(context.assets, []);
  assert.deepEqual(
    context.participants.map((p) => p.id),
    ['chen'],
  );
  assert.equal(context.participants[0].runtimeAvailability, 'unknown');
  assert.equal(context.participants[0].liveWorkload, 'unknown');
  assert.equal('assignedWork' in context.participants[0], false);
  assert.doesNotMatch(
    JSON.stringify(context),
    /OTHER_TASK_SENTINEL|OTHER_PROJECT_SENTINEL|其他成员/,
  );
});

test('planning context: current unavailable binding is reported without exposing its definition', () => {
  const { state, task } = fixture();
  state.assets[0].available = false;
  const context = buildPlanningContext(state, task, '');
  assert.deepEqual(context.assets, []);
  assert.deepEqual(context.selection.unavailableBindingIds, ['api-skill']);
  assert.deepEqual(context.currentWorkflows, task.workflows);
});

test('planning candidates: changing selected capability changes supporting resources; explicit IDs are searchable', () => {
  const { state, task, node } = fixture();
  node.skillIds = [];
  task.title = '改进体验';
  task.goal = '整理方案';
  task.participantIds = ['chen'];
  state.participants[0].role = '';
  state.assets = [asset('api-style', 'API'), asset('design-style', 'Figma')];
  assert.deepEqual(
    buildPlanningContext(state, task, '').assets.map((a) => a.id),
    ['api-style'],
  );
  state.participants[0].capabilities = ['Figma'];
  assert.deepEqual(
    buildPlanningContext(state, task, '').assets.map((a) => a.id),
    ['design-style'],
  );
  assert(
    buildPlanningContext(state, task, '使用 api-style').assets.some((a) => a.id === 'api-style'),
  );
});

test('planning budget: escaped Unicode excerpts fit, and an oversized manual baseline fails before truncation', () => {
  const { state, task, node } = fixture();
  const text = '\u0001😀'.repeat(2000);
  state.assets[0].content = text;
  state.assets[0].description = text;
  task.workflows[0].nodes = Array.from({ length: 10 }, (_, i) => ({
    ...node,
    id: `near-limit-${i}`,
    description: '现'.repeat(7800),
  }));
  const context = buildPlanningContext(state, task, '');
  assert(context.assets[0].excerpted);
  assert(JSON.stringify(context).length <= PLANNING_BUDGET.contextChars);
  assert(!/[\uD800-\uDBFF]$/u.test(context.assets[0].content));
  assert(
    context.assets[0].content.length + context.assets[0].description.length <
      PLANNING_BUDGET.assetExcerptChars,
  );
  assert.deepEqual(context.currentWorkflows, task.workflows);
  task.workflows[0].nodes = Array.from({ length: 15 }, (_, i) => ({
    ...node,
    id: `n-${i}`,
    description: '完整人工说明'.repeat(1300),
  }));
  const before = structuredClone(task);
  assert.throws(() => buildPlanningContext(state, task, ''), { code: 'context-limit' });
  assert.deepEqual(task, before);
});

test('planning hard constraints: omitted real resource IDs, missing handoff, self-review and excessive questions fail', () => {
  const { state, task } = fixture();
  state.assets.push(asset('hidden-real-id', '咖啡烘焙温度'));
  const prompt = planningPrompt(state, task, '');
  const valid = result(task);
  assert.equal(
    parsePlanningResult(JSON.stringify(valid), state, task, prompt.context).workflows.length,
    1,
  );
  for (const field of ['input', 'rationale', 'output']) {
    const bad = structuredClone(valid);
    bad.workflows[0].nodes[0][field] = ' ';
    assert.throws(() => parsePlanningResult(JSON.stringify(bad), state, task, prompt.context), {
      code: 'invalid-plan',
    });
  }
  const bad = structuredClone(valid);
  bad.workflows[0].nodes[0].skillIds = ['hidden-real-id'];
  assert.throws(
    () => parsePlanningResult(JSON.stringify(bad), state, task, prompt.context),
    /未提供/,
  );
  bad.workflows[0].nodes[0].skillIds = ['api-skill'];
  bad.workflows[0].nodes[0].reviewerIds = ['chen'];
  assert.throws(
    () => parsePlanningResult(JSON.stringify(bad), state, task, prompt.context),
    /评审自己/,
  );
  assert.throws(
    () =>
      parsePlanningResult(
        JSON.stringify({ ...valid, questions: ['1', '2', '3', '4'] }),
        state,
        task,
      ),
    /最多三个/,
  );
  assert.equal(JSON.parse(prompt.input).outputSchema.properties.questions.maxItems, 3);
});

test('planning structure: a small human task needs no tools or review; independent branches can converge', () => {
  const { state, task, node } = fixture();
  node.skillIds = [];
  node.reviewRequired = false;
  node.reviewerIds = [];
  assert.equal(
    parsePlanningResult(JSON.stringify(result(task)), state, task).workflows[0].nodes.length,
    1,
  );
  task.workflows[0].nodes = [
    { ...node, id: 'api', dependsOn: [], output: 'API 约定' },
    { ...node, id: 'ui', dependsOn: [], output: '界面原型' },
    {
      ...node,
      id: 'integration',
      dependsOn: ['api', 'ui'],
      input: 'API 约定和界面原型',
      reviewRequired: true,
      reviewerIds: ['qa'],
    },
  ];
  assert.deepEqual(
    parsePlanningResult(JSON.stringify(result(task)), state, task).workflows[0].nodes[2].dependsOn,
    ['api', 'ui'],
  );
});
