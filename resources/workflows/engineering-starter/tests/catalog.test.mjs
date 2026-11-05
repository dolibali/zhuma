import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseWorkflowTemplate } from '@zhuma/agent-core';

const directory = new URL('../', import.meta.url);
const root = new URL('../../../../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog.json', directory), 'utf8'));
const legacyDigests = {
  'requirements-to-test.json': '05889adea412b2bbbc2d8d1fbb728e5dda6e2de1fb8e9a66b3cb76c284282b4d',
  'design-to-plan.json': '7668b76b1e105ee7460d438b3bac0d68d130001370d8ce186f5da72365a0dc92',
  'review-fix-verify.json': '6f74d69dbfb2e7ed149f8b4a60f09d1a0d0a064f85bbfe672da4b0a8511a1378',
  'sources-to-docs.json': '6341c51355b7f023cf06e0da6f3d80ca4a428d22918faf072e1c60886e9720dd',
};

test('legacy workflow bytes and IDs stay available beside the new default', async () => {
  assert.equal(catalog.workflows.length, 5);
  assert.equal(catalog.workflows[0].id, 'zhuma-eng-requirements-to-code');
  assert.equal(catalog.workflows[0].file, 'requirements-to-code.json');
  for (const [file, digest] of Object.entries(legacyDigests)) {
    const bytes = await readFile(new URL(file, directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, file);
    assert.ok(catalog.workflows.some((entry) => entry.file === file));
  }
});

test('all templates parse with the existing production v1 parser and bind real catalog Skills', async () => {
  const knownSkills = new Set(catalog.skills.map((entry) => entry.id));
  assert.equal(knownSkills.size, 11);
  for (const entry of catalog.workflows) {
    const template = parseWorkflowTemplate(await readFile(new URL(entry.file, directory), 'utf8'));
    for (const resource of template.resources) {
      if (resource.kind === 'skill') assert.ok(knownSkills.has(resource.suggestedAssetId));
    }
    for (const suggestions of Object.values(entry.roleSkillSuggestions)) {
      for (const assetId of suggestions) assert.ok(knownSkills.has(assetId));
    }
  }
  for (const entry of catalog.skills) {
    assert.match(await readFile(new URL(entry.entry, root), 'utf8'), /^---\nname:/);
    assert.match(await readFile(new URL(entry.licenseFile, root), 'utf8'), /MIT License/);
  }
});

test('six-node flow has concrete implementation Skill and fixed-input human review checkpoints', async () => {
  const template = parseWorkflowTemplate(
    await readFile(new URL('requirements-to-code.json', directory), 'utf8'),
  );
  const nodes = template.workflows[0].nodes;
  assert.deepEqual(
    nodes.map((node) => node.id),
    ['requirements', 'design', 'implement', 'verify', 'review', 'deliver'],
  );
  assert.deepEqual(nodes[2].skillIds, ['controlled-implementation']);
  assert.equal(template.roles.find((role) => role.id === 'human-approver').preferredKind, 'human');
  for (const id of ['design', 'review']) {
    const node = nodes.find((value) => value.id === id);
    assert.equal(node.reviewRequired, true);
    assert.deepEqual(node.reviewerIds, ['human-approver']);
  }
  assert.notEqual(nodes[2].assigneeId, nodes[4].assigneeId);
  assert.ok(nodes[5].dependsOn.includes('review'));
  assert.ok(nodes[5].dependsOn.includes('verify'));
});
