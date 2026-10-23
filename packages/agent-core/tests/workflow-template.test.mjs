import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  AssetSchema,
  CommandRequestSchema,
  WorkbenchSchema,
  applyWorkbenchCommand,
  captureWorkflowTemplate,
  instantiateWorkflowTemplate,
  parseWorkflowTemplate,
  resolveTemplateBindings,
  templateBindingGaps,
  validateWorkTask,
} from '../dist/index.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function setup() {
  const { state, task, node } = fixture();
  task.participantIds.push('outside');
  node.reviewerIds.push('outside');
  state.participants[0].instructions = 'PERSONAL_INSTRUCTIONS_NOT_FOR_TEMPLATE';
  task.workflows[0].nodes.push({
    ...structuredClone(node),
    id: 'parallel',
    title: '独立界面实现',
    dependsOn: [],
  });
  task.workflows[0].nodes.push({
    ...structuredClone(node),
    id: 'join',
    title: '集成验证',
    dependsOn: [node.id, 'parallel'],
  });
  task.workflows.push({
    id: 'child',
    name: '接口细化',
    parentNodeId: node.id,
    nodes: [{ ...structuredClone(node), id: 'nested' }],
  });
  const definition = captureWorkflowTemplate(task, state);
  const template = {
    id: 'template',
    name: '接口与界面交付',
    kind: 'template',
    description: '结构化工作流',
    content: JSON.stringify(definition),
    available: true,
  };
  state.assets.push(template);
  const input = {
    templateId: template.id,
    task: {
      id: randomUUID(),
      projectId: task.projectId,
      title: '复用工作流',
      goal: '实现新的目标',
      participantIds: task.participantIds,
      ownerId: 'chen',
      updatedAt: task.updatedAt,
    },
    roleBindings: Object.fromEntries(
      definition.roles.map((r, i) => [r.id, ['chen', 'qa', 'outside'][i]]),
    ),
    resourceBindings: Object.fromEntries(
      definition.resources.map((r) => [r.id, r.suggestedAssetId]),
    ),
  };
  return { state, task, node, definition, template, input };
}

test('template capture: preserves parallel/nested work and all reviewers, strips personal identity/instructions and rationale', () => {
  const { definition, task } = setup();
  const root = definition.workflows[0];
  assert.equal(root.nodes[0].reviewerIds.length, 2);
  assert.equal(root.nodes[0].reviewRequired, true);
  assert.equal(root.nodes[0].rationale, '');
  assert.deepEqual(root.nodes[2].dependsOn, [root.nodes[0].id, root.nodes[1].id]);
  assert.equal(definition.workflows[1].parentNodeId, root.nodes[0].id);
  assert.doesNotMatch(
    JSON.stringify(definition),
    /PERSONAL_INSTRUCTIONS_NOT_FOR_TEMPLATE|陈宁|质量专家|其他成员/,
  );
  assert(!('ownerId' in definition));
  assert(!('taskId' in definition));
  assert.notEqual(root.id, task.workflows[0].id);
});

test('template definition editing preserves role preferences and missing catalog hints, with distinct role captions', () => {
  const { state, task, input, definition } = setup();
  for (const p of state.participants) p.role = '同名角色';
  const captured = captureWorkflowTemplate(task, state, {
    rolePreferences: { chen: 'any', qa: 'expert' },
  });
  assert.equal(new Set(captured.roles.map((r) => r.name)).size, captured.roles.length);
  assert.equal(captured.roles[0].preferredKind, 'any');
  assert.equal(captured.roles[1].preferredKind, 'expert');
  const pending = instantiateWorkflowTemplate(state, {
    ...input,
    roleBindings: {},
    resourceBindings: {},
  });
  const gap = pending.templateSource.pendingAssets[0];
  const result = captureWorkflowTemplate(pending, state, {
    resourceHints: { [gap.id]: 'external-skill-catalog-id' },
  });
  assert.equal(result.resources[0].suggestedAssetId, 'external-skill-catalog-id');
  assert.equal(result.resources[0].name, definition.resources[0].name);
  assert.equal(
    templateBindingGaps(pending).participants.length,
    pending.templateSource.pendingParticipants.length,
  );
  const before = structuredClone(pending);
  pending.workflows
    .flatMap((w) => w.nodes)
    .forEach((n) => {
      n.skillIds = [];
    });
  assert.deepEqual(templateBindingGaps(pending).assets, []);
  assert.deepEqual(pending.templateSource, before.templateSource);
});

test('template instance: new identities and immutable source, no source mutation or shared graph objects', () => {
  const { state, input, template, definition } = setup();
  const before = structuredClone(state);
  const first = instantiateWorkflowTemplate(state, input);
  const second = instantiateWorkflowTemplate(state, {
    ...input,
    task: { ...input.task, id: randomUUID() },
  });
  const root = first.workflows[0];
  assert.equal(first.status, 'draft');
  assert.equal(first.ownerId, 'chen');
  assert.deepEqual(root.nodes[0].reviewerIds, ['qa', 'outside']);
  assert.deepEqual(root.nodes[2].dependsOn, [root.nodes[0].id, root.nodes[1].id]);
  assert.equal(first.workflows[1].parentNodeId, root.nodes[0].id);
  assert.notEqual(first.id, second.id);
  assert.notEqual(root.id, second.workflows[0].id);
  assert.notEqual(root.nodes[0].id, second.workflows[0].nodes[0].id);
  assert.deepEqual(first.templateSource.definition, definition);
  assert.equal(first.templateSource.assetId, template.id);
  assert.deepEqual(state, before);
  state.assets.find((a) => a.id === template.id).content = 'later text';
  assert.deepEqual(first.templateSource.definition, definition);
  root.nodes[0].title = '只改实例';
  assert.notEqual(first.templateSource.definition.workflows[0].nodes[0].title, '只改实例');
});

test('template gaps: persist explicit placeholders without dropping review/resources, block confirmation until mapped', () => {
  const { state, input } = setup();
  const command = {
    type: 'instantiate-template',
    input: { ...input, roleBindings: {}, resourceBindings: {} },
  };
  const created = applyWorkbenchCommand(state, command);
  const task = created.tasks.find((t) => t.id === input.task.id);
  assert.deepEqual(validateWorkTask(task, created), []);
  assert.equal(task.workflows[0].nodes[0].reviewerIds.length, 2);
  assert.equal(task.workflows[0].nodes[0].reviewRequired, true);
  assert.equal(task.workflows[0].nodes[0].skillIds.length, 1);
  assert.equal(task.participantIds.length, 3);
  assert(task.templateSource.pendingParticipants.every((p) => !task.participantIds.includes(p.id)));
  assert.throws(
    () => applyWorkbenchCommand(created, { type: 'save-task', task: { ...task, status: 'ready' } }),
    /绑定角色|绑定资源/,
  );
  const roles = Object.fromEntries(
    task.templateSource.pendingParticipants.map((p, i) => [p.id, ['chen', 'qa', 'outside'][i]]),
  );
  const resources = Object.fromEntries(
    task.templateSource.pendingAssets.map((a) => [a.id, 'api-skill']),
  );
  const resolved = resolveTemplateBindings(task, created, roles, resources);
  assert.deepEqual(resolved.templateSource, task.templateSource);
  assert.deepEqual(
    resolved.workflows.map((w) => w.id),
    task.workflows.map((w) => w.id),
  );
  const confirmed = applyWorkbenchCommand(created, {
    type: 'save-task',
    task: { ...resolved, status: 'ready' },
  });
  assert.equal(confirmed.appliedPlans.at(-1).task.id, task.id);
  assert.deepEqual(confirmed.appliedPlans.at(-1).task.templateSource, task.templateSource);
});

test('template mapping: outside/disabled identities, wrong resource kind, self/duplicate reviews and collisions are rejected', () => {
  const { state, input, definition } = setup();
  const assignee = definition.workflows[0].nodes[0].assigneeId;
  const [reviewer, secondReviewer] = definition.workflows[0].nodes[0].reviewerIds;
  assert.throws(
    () =>
      instantiateWorkflowTemplate(state, {
        ...input,
        task: { ...input.task, participantIds: ['chen'] },
      }),
    /已参与/,
  );
  assert.throws(
    () =>
      instantiateWorkflowTemplate(state, {
        ...input,
        roleBindings: { ...input.roleBindings, [reviewer]: 'chen' },
      }),
    /评审自己/,
  );
  assert.throws(
    () =>
      instantiateWorkflowTemplate(state, {
        ...input,
        roleBindings: { ...input.roleBindings, [secondReviewer]: 'qa' },
      }),
    /评审人不能重复/,
  );
  state.participants.find((p) => p.id === 'qa').available = false;
  assert.throws(() => instantiateWorkflowTemplate(state, input), /可用成员/);
  state.participants.find((p) => p.id === 'qa').available = true;
  const pending = instantiateWorkflowTemplate(state, {
    ...input,
    roleBindings: {},
    resourceBindings: {},
  });
  const maps = Object.fromEntries(
    pending.templateSource.pendingParticipants.map((p, i) => [p.id, i === 0 ? 'chen' : 'qa']),
  );
  assert.throws(() => resolveTemplateBindings(pending, state, maps, {}), /评审人不能重复/);
  assert.throws(
    () =>
      instantiateWorkflowTemplate(state, {
        ...input,
        resourceBindings: { [definition.resources[0].id]: 'template' },
      }),
    /同类型/,
  );
  state.participants.push({ ...state.participants[0], id: `${input.task.id}-p-0` });
  assert.throws(
    () => instantiateWorkflowTemplate(state, { ...input, roleBindings: { [assignee]: null } }),
    /占位标识冲突/,
  );
});

test('template source cannot be forged or changed through generic task save; completed manual edits survive later gap resolution', () => {
  const { state, input } = setup();
  const task = instantiateWorkflowTemplate(state, {
    ...input,
    roleBindings: {},
    resourceBindings: {},
  });
  assert.throws(() => applyWorkbenchCommand(state, { type: 'save-task', task }), /来源快照/);
  const created = applyWorkbenchCommand(state, {
    type: 'instantiate-template',
    input: { ...input, roleBindings: {}, resourceBindings: {} },
  });
  const manual = structuredClone(created.tasks.at(-1));
  manual.workflows[0].nodes[0].assigneeId = 'outside';
  manual.workflows[0].nodes[0].description = '人工改过的说明';
  const mapped = resolveTemplateBindings(
    manual,
    created,
    { [manual.templateSource.pendingParticipants[0].id]: 'chen' },
    {},
  );
  assert.equal(mapped.workflows[0].nodes[0].assigneeId, 'outside');
  assert.equal(mapped.workflows[0].nodes[0].description, '人工改过的说明');
  const tampered = structuredClone(manual);
  tampered.templateSource.definition.workflows[0].name = '伪造来源';
  assert.throws(
    () => applyWorkbenchCommand(created, { type: 'save-task', task: tampered }),
    /来源快照/,
  );
});

test('template schema: old text remains readable, structured content over 8KB is supported and bad graphs do not instantiate', () => {
  const { state, input, definition, template } = setup();
  assert.throws(() => parseWorkflowTemplate('原先的文字模板'), { code: 'template-legacy' });
  AssetSchema.parse({ ...template, content: '原先的文字模板' });
  assert.throws(() => AssetSchema.parse({ ...template, kind: 'mcp', content: 'x'.repeat(8001) }));
  assert.throws(() =>
    AssetSchema.parse({ ...template, kind: 'skill', content: 'x'.repeat(60001) }),
  );
  const long = structuredClone(definition);
  long.workflows[0].nodes.forEach((n) => (n.description = 'x'.repeat(4000)));
  const content = JSON.stringify(long);
  assert(content.length > 8000);
  AssetSchema.parse({ ...template, content });
  parseWorkflowTemplate(content);
  for (const mutate of [
    (d) => (d.workflows[0].nodes[0].dependsOn = [d.workflows[0].nodes[2].id]),
    (d) => (d.workflows[0].nodes[0].assigneeId = 'unknown-role'),
    (d) => (d.plugins = ['executable-code']),
  ]) {
    const bad = structuredClone(definition);
    mutate(bad);
    assert.throws(() => parseWorkflowTemplate(JSON.stringify(bad)), { code: 'template-invalid' });
  }
  state.assets.find((a) => a.id === template.id).available = false;
  assert.throws(() => instantiateWorkflowTemplate(state, input), { code: 'template-unavailable' });
});

test('template command: one atomic draft and unchanged source, duplicate task IDs never overwrite', () => {
  const { state, input, template } = setup();
  const request = CommandRequestSchema.parse({
    requestId: randomUUID(),
    expectedRevision: state.revision,
    command: { type: 'instantiate-template', input },
  });
  const next = applyWorkbenchCommand(state, request.command);
  WorkbenchSchema.parse(next);
  assert.equal(next.revision, state.revision + 1);
  assert.equal(next.tasks.length, state.tasks.length + 1);
  assert.equal(next.assets.find((a) => a.id === template.id).content, template.content);
  assert.throws(() => applyWorkbenchCommand(next, request.command), { code: 'task-exists' });
  assert.equal(state.tasks.length, 1);
});
