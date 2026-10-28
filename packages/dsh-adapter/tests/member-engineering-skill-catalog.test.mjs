import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { emptyWorkbench, instantiateWorkflowTemplate } from '@zhuma/agent-core';
import {
  defaultMemberEngineeringSkills,
  mergeDefaultMemberEngineeringSkills,
  ENGINEERING_SKILL_SOURCE,
} from '../dist/member-engineering-skill-catalog.js';
import { setup, request, signal, taskInput, rejected } from './member-workbench-fixture.mjs';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('resources/workflows/engineering-starter/catalog.json', root), 'utf8'),
);
const bundle = {
  sourceCommit: ENGINEERING_SKILL_SOURCE,
  assets: await Promise.all(
    manifest.skills.map(async (entry) => ({
      id: entry.id,
      name: entry.name,
      description: '',
      kind: 'skill',
      available: true,
      content: await readFile(new URL(entry.entry, root), 'utf8'),
    })),
  ),
};
const hash = (text) => createHash('sha256').update(text).digest('hex');

test('default engineering Skills: ten exact public bodies, stable IDs, cloned projection and retained license sources', async () => {
  const input = structuredClone(bundle);
  input.assets.reverse();
  const value = defaultMemberEngineeringSkills(input);
  assert.equal(value.length, 10);
  assert.deepEqual(
    value.map((asset) => asset.id),
    manifest.skills.map((entry) => entry.id),
  );
  for (const asset of value) {
    const source = bundle.assets.find((original) => original.id === asset.id);
    assert.equal(asset.kind, 'skill');
    assert.equal(asset.available, true);
    assert.equal(hash(asset.content), hash(source.content));
    assert.equal(asset.content, source.content);
    assert.equal(Object.hasOwn(asset, 'origin'), false);
    const entry = manifest.skills.find((entry) => entry.id === asset.id);
    const license = await readFile(new URL(entry.licenseFile, root), 'utf8');
    assert.match(license, /MIT License/u);
    assert.match(license, /Copyright \(c\) 2026 Zhuma contributors/u);
  }
  value[0].content = 'caller mutation';
  assert.notEqual(
    input.assets.find((asset) => asset.id === value[0].id).content,
    'caller mutation',
  );
});

for (const change of [
  'source',
  'count',
  'duplicate',
  'id',
  'bytes',
  'crlf',
  'kind',
  'disabled',
  'origin',
  'ownership',
  'actor',
]) {
  test(`default engineering Skills: ${change} mismatch rejects the whole batch`, () => {
    const bad = structuredClone(bundle);
    if (change === 'source') bad.sourceCommit = '0'.repeat(40);
    if (change === 'count') bad.assets.pop();
    if (change === 'duplicate') bad.assets[1] = bad.assets[0];
    if (change === 'id') bad.assets[0].id = 'another-skill';
    if (change === 'bytes') bad.assets[0].content += ' ';
    if (change === 'crlf') bad.assets[0].content = bad.assets[0].content.replaceAll('\n', '\r\n');
    if (change === 'kind') bad.assets[0].kind = 'template';
    if (change === 'disabled') bad.assets[0].available = false;
    if (change === 'origin') bad.assets[0].origin = undefined;
    if (change === 'ownership') bad.assets[0].memberTemplate = { ownerId: 'not-a-grant' };
    if (change === 'actor') bad.actorId = 'not-a-grant';
    assert.throws(() => defaultMemberEngineeringSkills(bad), rejected('unavailable'));
  });
}

test('default engineering Skills: authorized catalog merge is idempotent and never mutates existing definitions', () => {
  const prior = [
    {
      id: 'previous-skill',
      kind: 'skill',
      name: '既有方法',
      description: '',
      content: 'original',
      available: true,
    },
  ];
  const before = structuredClone(prior);
  const once = mergeDefaultMemberEngineeringSkills(prior, bundle);
  const twice = mergeDefaultMemberEngineeringSkills(once, bundle);
  assert.equal(once.length, 11);
  assert.deepEqual(twice, once);
  assert.deepEqual(prior, before);
  once[0].content = 'changed return';
  assert.equal(prior[0].content, 'original');
});

for (const field of ['content', 'name', 'kind', 'available']) {
  test(`default engineering Skills: existing same-ID ${field} conflict fails without overwrite`, () => {
    const prior = [structuredClone(bundle.assets[0])];
    prior[0][field] = field === 'available' ? false : field === 'kind' ? 'mcp' : 'other definition';
    const before = structuredClone(prior);
    assert.throws(
      () => mergeDefaultMemberEngineeringSkills(prior, bundle),
      rejected('resource-conflict'),
    );
    assert.deepEqual(prior, before);
  });
}

test('default engineering Skills: duplicate or oversized combined catalogs fail closed', () => {
  const one = bundle.assets[0];
  assert.throws(
    () => mergeDefaultMemberEngineeringSkills([one, one], bundle),
    rejected('resource-conflict'),
  );
  const prior = Array.from({ length: 91 }, (_, index) => ({ ...one, id: `prior-${index}` }));
  assert.throws(() => mergeDefaultMemberEngineeringSkills(prior, bundle), rejected('unavailable'));
});

test('default engineering Skills: same-ID imported source cannot be silently replaced by a built-in definition', () => {
  const imported = {
    ...bundle.assets[0],
    origin: {
      versionId: randomUUID(),
      format: 'agent-skill',
      entryPath: 'SKILL.md',
      filePaths: ['SKILL.md'],
      totalBytes: Buffer.byteLength(bundle.assets[0].content),
      missing: [],
    },
  };
  const before = structuredClone(imported);
  assert.throws(
    () => mergeDefaultMemberEngineeringSkills([imported], bundle),
    rejected('resource-conflict'),
  );
  assert.deepEqual(imported, before);
});

test('default engineering Skills: all four actual workflow resource suggestions resolve without inventing participants', async () => {
  const skills = defaultMemberEngineeringSkills(bundle);
  for (const entry of manifest.workflows) {
    const content = await readFile(
      new URL(`resources/workflows/engineering-starter/${entry.file}`, root),
      'utf8',
    );
    const definition = JSON.parse(content),
      state = emptyWorkbench();
    const asset = {
      id: entry.id,
      name: entry.name,
      kind: 'template',
      description: entry.description,
      content,
      available: true,
    };
    state.projects.push({ id: 'project', name: '项目', description: '' });
    state.assets.push(...skills, asset);
    const resourceBindings = Object.fromEntries(
      definition.resources.map((resource) => {
        assert.ok(skills.some((skill) => skill.id === resource.suggestedAssetId));
        return [resource.id, resource.suggestedAssetId];
      }),
    );
    const task = instantiateWorkflowTemplate(state, {
      templateId: entry.id,
      task: {
        id: randomUUID(),
        projectId: 'project',
        title: '复用',
        goal: '确认结构',
        participantIds: [],
        ownerId: null,
        updatedAt: '2026-10-28T12:00:00.000Z',
      },
      roleBindings: {},
      resourceBindings,
    });
    assert.equal(task.status, 'draft');
    assert.equal(task.templateSource.pendingAssets.length, 0);
    assert.ok(task.templateSource.pendingParticipants.length);
    assert.equal(state.tasks.length, 0);
  }
});

test('default engineering Skills: existing member gate still rejects foreign scope and legacy same-ID private content', async () => {
  const state = emptyWorkbench();
  state.projects.push({ id: 'project-one', name: '项目', description: '' });
  state.assets.push({ ...bundle.assets[0], content: 'LEGACY_PRIVATE_CANARY' });
  const f = setup({
    state,
    projectSpaces: [['project-one', 'north']],
    service: {
      catalog: async () => ({
        experts: [],
        assets: mergeDefaultMemberEngineeringSkills([], bundle),
      }),
    },
  });
  const task = taskInput();
  task.workflows[0].nodes[0].skillIds = [bundle.assets[0].id];
  await assert.rejects(
    f.service('dana').command(request(0, { type: 'create-task', task }), signal()),
    rejected('not-found'),
  );
  await assert.rejects(
    f.service().command(request(0, { type: 'create-task', task }), signal()),
    rejected('resource-conflict'),
  );
  assert.equal(f.writes, 0);
  assert.equal(f.intents.size, 0);
  assert.equal(f.workbench.snapshot().assets[0].content, 'LEGACY_PRIVATE_CANARY');
});
