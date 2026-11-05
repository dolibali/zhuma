import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createNodeHandoffs, parseWorkflowTemplate } from '@zhuma/agent-core';
import { publicMemberEngineeringSkills } from '../../../scripts/lib/member-engineering-skills.mjs';
import { publicMemberTemplates } from '../../../scripts/lib/member-template-defaults.mjs';
import { mergeDefaultMemberEngineeringSkills } from '../dist/member-engineering-skill-catalog.js';
import { defaultMemberTemplates } from '../dist/member-template-catalog.js';
import { setup, request, signal, projectCommand, taskInput } from './member-workbench-fixture.mjs';

test('public Skill build input: actual build bundle reaches a member catalog and fixed plan through original gates', async () => {
  const source = await publicMemberEngineeringSkills();
  const assets = mergeDefaultMemberEngineeringSkills([], source.bundle);
  const templates = defaultMemberTemplates(await publicMemberTemplates());
  assert.equal(source.licenses.length, assets.length);
  for (const license of source.licenses) {
    assert.ok(assets.some((asset) => asset.id === license.name));
    assert.match(license.text, /MIT License/u);
  }
  const f = setup({
    service: { catalog: async () => ({ experts: [], assets: [...assets, ...templates] }) },
  });
  const initial = await f.service().snapshot({ spaceId: 'north' });
  assert.equal(initial.state.assets.filter((asset) => asset.kind === 'skill').length, 11);
  assert.equal(f.writes, 0);
  await f.service().command(request(0, projectCommand()), signal());
  const task = taskInput();
  task.workflows[0].nodes[0].skillIds = [assets[0].id];
  await f.service().command(request(1, { type: 'create-task', task }), signal());
  await f.service().command(request(2, { type: 'confirm-task', taskId: task.id }), signal());
  const plan = f.workbench.snapshot().appliedPlans[0];
  assert.deepEqual(
    plan.assets.find((asset) => asset.id === assets[0].id),
    assets[0],
  );
  assert.ok(
    createNodeHandoffs(plan).some((handoff) =>
      handoff.skillRefs.some((ref) => ref.id === assets[0].id && ref.version === plan.id),
    ),
  );
});

test('public engineering default contract: independent editable copies retain real Skill bindings in the confirmed plan', async () => {
  const { bundle } = await publicMemberEngineeringSkills();
  const assets = mergeDefaultMemberEngineeringSkills([], bundle);
  const templates = defaultMemberTemplates(await publicMemberTemplates());
  assert.equal(templates.length, 5);
  const template = templates[0];
  assert.equal(template.id, 'zhuma-eng-requirements-to-code');
  const definition = parseWorkflowTemplate(template.content);
  const reviewer = {
    id: 'independent-expert',
    name: '独立代码评审专家',
    kind: 'expert',
    role: '代码评审',
    capabilities: ['代码审查'],
    instructions: '核对固定版本及真实验证证据。',
    available: true,
    resourceBindings: {
      skillIds: ['zhuma-eng-change-review', 'zhuma-eng-acceptance-review'],
      mcpIds: [],
    },
  };
  const f = setup({
    service: { catalog: async () => ({ experts: [reviewer], assets: [...assets, ...templates] }) },
  });
  await f.service().command(request(0, projectCommand()), signal());
  const input = (id) => ({
    templateId: template.id,
    task: {
      id,
      projectId: 'project-one',
      title: '实现导入预览',
      goal: '保持原接口行为并验证新增预览',
      participantIds: ['ann', 'bob', reviewer.id],
      ownerId: 'ann',
    },
    roleBindings: {
      analyst: 'ann',
      designer: 'ann',
      implementer: 'ann',
      verifier: 'ann',
      'independent-reviewer': reviewer.id,
      'human-approver': 'bob',
    },
    resourceBindings: Object.fromEntries(
      definition.resources.map((resource) => [resource.id, resource.suggestedAssetId]),
    ),
  });
  const firstId = randomUUID(),
    secondId = randomUUID();
  await f
    .service()
    .command(request(1, { type: 'instantiate-template', input: input(firstId) }), signal());
  const copies = await f
    .service()
    .command(request(2, { type: 'instantiate-template', input: input(secondId) }), signal());
  const first = copies.state.tasks.find((task) => task.id === firstId);
  assert.equal(first.workflows[0].nodes.length, 6);
  const { status, updatedAt, templateSource, ...editable } = structuredClone(first);
  editable.workflows[0].nodes[2].title = '实现导入预览与空字段提示';
  const edited = await f
    .service()
    .command(request(3, { type: 'update-task', task: editable }), signal());
  assert.equal(
    edited.state.tasks.find((task) => task.id === secondId).workflows[0].nodes[2].title,
    '代码实现',
  );
  assert.equal(
    edited.state.assets.find((asset) => asset.id === template.id).content,
    template.content,
  );
  const savedId = randomUUID();
  const saved = await f.service().command(
    request(4, {
      type: 'save-template',
      input: {
        templateId: savedId,
        sourceTaskId: firstId,
        name: '导入预览工程流程',
        description: '自定义副本',
      },
    }),
    signal(),
  );
  const savedTemplate = saved.state.assets.find((asset) => asset.id === savedId);
  assert.equal(
    parseWorkflowTemplate(savedTemplate.content).workflows[0].nodes[2].title,
    editable.workflows[0].nodes[2].title,
  );
  assert.equal(savedTemplate.memberTemplate.ownerId, 'ann');
  await f.service().command(request(5, { type: 'confirm-task', taskId: firstId }), signal());
  const plan = f.workbench.snapshot().appliedPlans[0];
  const implementation = plan.task.workflows[0].nodes[2];
  assert.deepEqual(implementation.skillIds, ['zhuma-eng-controlled-implementation']);
  const submission = plan.task.workflows[0].nodes[4];
  assert.equal(submission.assigneeId, implementation.assigneeId);
  assert.deepEqual(submission.reviewerIds, [reviewer.id, 'bob']);
  assert.equal(submission.reviewerIds.includes(implementation.assigneeId), false);
  assert.deepEqual(
    plan.participants.find((participant) => participant.id === reviewer.id).resourceBindings,
    reviewer.resourceBindings,
  );
  assert.equal(submission.skillIds.includes('zhuma-eng-change-review'), false);
  assert.equal(submission.skillIds.includes('zhuma-eng-acceptance-review'), false);
  assert.deepEqual(
    plan.assets.find((asset) => asset.id === implementation.skillIds[0]),
    assets.find((asset) => asset.id === implementation.skillIds[0]),
  );
  assert.ok(
    createNodeHandoffs(plan).some((handoff) =>
      handoff.skillRefs.some(
        (ref) => ref.id === implementation.skillIds[0] && ref.version === plan.id,
      ),
    ),
  );
});
