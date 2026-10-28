import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeHandoffs } from '@zhuma/agent-core';
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
  assert.equal(initial.state.assets.filter((asset) => asset.kind === 'skill').length, 10);
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
