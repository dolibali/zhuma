/** Original member command/confirmation/handoff integration. Catalog admission
 * and leases are explicit contracts; no desktop, real Run or model is asserted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memberAssetDefinitionId, createNodeHandoffs, canonicalPayload } from '@zhuma/agent-core';
import { assets, rejects } from './member-asset-fixture.mjs';
import { signal, request, taskInput, node, projectCommand } from './member-workbench-fixture.mjs';
import { definition } from './member-template-fixture.mjs';

const publish = async (h, created) =>
  h.command({
    operation: 'publish',
    spaceId: created.input.spaceId,
    assetId: created.input.assetId,
    expectedVersion: created.result.asset.version,
    idempotencyKey: randomUUID(),
  });
const member = (h, actor = 'ann', patch = {}) =>
  h.f.service(actor, {
    catalog: async (spaceId) => h.owner.publishedDefinitions(spaceId),
    ...patch,
  });
const command = (h, input, actor = 'ann') =>
  member(h, actor).command(request(h.f.workbench.snapshot().revision, input), signal());

test('member asset runtime: published expert and Skill enter normal member create/confirm and original fixed handoff, old publication never follows latest', async (t) => {
  const h = assets(t);
  const skill = await h.create('skill'),
    first = await publish(h, skill),
    skillId = memberAssetDefinitionId(first.reference);
  const expert = await h.create('expert', {
      dependencies: [{ slotId: 'method', reference: first.reference }],
    }),
    expertPublished = await publish(h, expert);
  const expertId = memberAssetDefinitionId(expertPublished.reference);
  await command(h, projectCommand());
  const task = taskInput({
    participantIds: ['ann', expertId],
    workflows: [
      {
        id: 'root',
        name: 'Work',
        parentNodeId: null,
        nodes: [node('write', { assigneeId: expertId, skillIds: [skillId] })],
      },
    ],
  });
  await command(h, { type: 'create-task', task });
  await command(h, { type: 'confirm-task', taskId: task.id });
  const fixed = structuredClone(h.f.workbench.snapshot().appliedPlans[0]);
  assert.deepEqual(
    fixed.participants.find((p) => p.id === expertId).memberAsset,
    expertPublished.reference,
  );
  assert.deepEqual(fixed.assets.find((a) => a.id === skillId).memberAsset, first.reference);
  const handoff = createNodeHandoffs(fixed)[0];
  assert.deepEqual(handoff.skillRefs, [{ id: skillId, version: fixed.id }]);
  assert.notEqual(handoff.skillRefs[0].version, first.reference.versionId);
  assert.equal(handoff.expertRef.id, expertId);
  const updated = await h.command({
    operation: 'update-draft',
    spaceId: 'north',
    assetId: skill.input.assetId,
    expectedVersion: first.asset.version,
    idempotencyKey: randomUUID(),
    definition: { ...skill.input.definition, content: 'A later method' },
    dependencies: [],
  });
  const newer = await h.command({
    operation: 'publish',
    spaceId: 'north',
    assetId: skill.input.assetId,
    expectedVersion: updated.asset.version,
    idempotencyKey: randomUUID(),
  });
  assert.notEqual(memberAssetDefinitionId(newer.reference), skillId);
  await h.reopen();
  assert.deepEqual(h.f.workbench.snapshot().appliedPlans[0], fixed);
  assert.deepEqual(createNodeHandoffs(h.f.workbench.snapshot().appliedPlans[0]), [handoff]);
  const catalog = h.owner.publishedDefinitions('north');
  assert.equal(catalog.assets.length, 2);
  assert.equal(catalog.experts[0].resourceBindings.skillIds[0], skillId);
  assert.equal(
    catalog.assets.find((a) => a.id === skillId).content,
    skill.input.definition.content,
  );
  assert.equal((await member(h).snapshot({ spaceId: 'north' })).state.assets.length, 2);
  assert.deepEqual((await member(h).assetSources({ spaceId: 'north' }, signal())).items, []);
});

test('member asset runtime: a published workflow instantiates through the original member endpoint and freezes its complete source reference', async (t) => {
  const h = assets(t);
  const skill = await h.create('skill'),
    dep = await publish(h, skill);
  const workflow = await h.create('template', {
    definition: {
      kind: 'template',
      name: '接口交付',
      description: '固定工作流',
      content: JSON.stringify(definition),
    },
    dependencies: [{ slotId: 'method', reference: dep.reference }],
  });
  const published = await publish(h, workflow);
  await command(h, projectCommand());
  const taskId = randomUUID();
  const result = await command(h, {
    type: 'instantiate-template',
    input: {
      templateId: memberAssetDefinitionId(published.reference),
      task: {
        id: taskId,
        projectId: 'project-one',
        title: '实例',
        goal: '接口交付',
        participantIds: ['ann', 'bob'],
        ownerId: 'ann',
      },
      roleBindings: { author: 'ann', reviewer: 'bob' },
      resourceBindings: { method: memberAssetDefinitionId(dep.reference) },
    },
  });
  const task = result.state.tasks.find((item) => item.id === taskId);
  assert.deepEqual(task.templateSource.memberAsset, published.reference);
  assert.deepEqual(task.templateSource.definition, definition);
  assert.equal(task.workflows[0].nodes[0].skillIds[0], memberAssetDefinitionId(dep.reference));
});

test('member asset runtime: a forged catalog publication, changed body, or foreign-space marker never grants normal task access', async (t) => {
  const h = assets(t),
    skill = await h.create('skill'),
    published = await publish(h, skill);
  const actual = h.owner.publishedDefinitions('north').assets[0];
  for (const candidate of [
    { ...actual, content: 'FORGED' },
    { ...actual, memberAsset: { ...published.reference, spaceId: 'south' } },
    {
      ...actual,
      id: `member-asset-${randomUUID()}`,
      memberAsset: { ...published.reference, versionId: randomUUID() },
    },
  ]) {
    await assert.rejects(
      member(h, 'ann', { catalog: async () => ({ experts: [], assets: [candidate] }) }).snapshot({
        spaceId: 'north',
      }),
    );
  }
  const personal = await h.create('skill', { spaceId: 'personal-ann' });
  await publish(h, personal);
  await assert.rejects(
    member(h, 'bob', {
      catalog: async () => h.owner.publishedDefinitions('personal-ann'),
    }).snapshot({ spaceId: 'north' }),
  );
  assert.equal(h.f.workbench.snapshot().tasks.length, 0);
});

test('member asset runtime: original catalog capacity is rejected before package bytes or publication facts are written', async (t) => {
  const catalog = {
    experts: [],
    assets: Array.from({ length: 100 }, (_, i) => ({
      id: `base-${i}`,
      kind: 'skill',
      name: 'Base',
      description: '',
      content: 'base',
      available: true,
    })),
  };
  const h = assets(t, { catalog }),
    created = await h.create('skill');
  const before = canonicalPayload(h.f.workbench.snapshot());
  await assert.rejects(publish(h, created), rejects('asset-quota'));
  assert.equal(canonicalPayload(h.f.workbench.snapshot()), before);
  assert.equal(h.packages.size, 0);
});

test('member asset runtime: changed Host catalog during original package I/O prevents late publication', async (t) => {
  const catalog = { experts: [], assets: [] },
    h = assets(t, { catalog }),
    created = await h.create('skill');
  h.packageWrite(() => {
    catalog.assets.push({
      id: 'new-base',
      kind: 'skill',
      name: 'Changed',
      description: '',
      content: 'Changed',
      available: true,
    });
  });
  await assert.rejects(publish(h, created), rejects('asset-conflict'));
  assert.equal(h.f.workbench.snapshot().memberAssets[0].published.length, 0);
  assert.equal(h.packages.size, 1, 'unreferenced immutable bytes do not imply publication success');
});
