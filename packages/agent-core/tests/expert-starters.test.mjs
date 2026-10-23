import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkbenchCommand,
  emptyWorkbench,
  parseWorkflowTemplate,
  previewResourcePackage,
} from '../dist/index.js';
import { importCommand } from '../../../tests/fixtures/asset-package.mjs';
import {
  expertStarterFiles,
  expertStarterFolders,
} from '../../../tests/fixtures/expert-starters.mjs';

test('expert starters contract: all four originals import with stable source versions, methods and default Skills', async () => {
  const files = await expertStarterFiles();
  const preview = previewResourcePackage(files, parseWorkflowTemplate);
  assert.equal(files.length, 17);
  assert.equal(preview.ignored.length, 0);
  assert.equal(preview.files.length, 17);
  assert.equal(preview.items.filter((i) => i.kind === 'expert').length, 4);
  assert.equal(preview.items.filter((i) => i.kind === 'skill').length, 4);
  assert(preview.items.every((i) => i.missing.length === 0));
  const state = applyWorkbenchCommand(emptyWorkbench(), importCommand(preview, files));
  assert.equal(state.participants.length, 4);
  assert.equal(state.assets.length, 4);
  for (const folder of expertStarterFolders) {
    const expert = state.participants.find((p) => p.origin.sourceId === `zhuma-${folder}`);
    assert(expert?.available);
    assert.notEqual(expert.id, expert.origin.sourceId);
    assert.equal(expert.origin.sourceVersion, '1.0.0');
    assert.equal(expert.resourceBindings.skillIds.length, 1);
    assert.deepEqual(expert.resourceBindings.mcpIds, []);
    const skill = state.assets.find((a) => a.id === expert.resourceBindings.skillIds[0]);
    assert(skill?.available);
    assert.equal(skill.origin.entryPath, `${folder}/skills/${folder}/SKILL.md`);
    assert(expert.origin.filePaths.includes(`${folder}/LICENSE.txt`));
    assert(expert.origin.filePaths.includes(`${folder}/README.md`));
    assert(skill.origin.filePaths.includes(`${folder}/LICENSE.txt`));
  }
});

test('expert starters contract: each folder is self-contained and omitting its default Skill stays disabled', async () => {
  for (const folder of expertStarterFolders) {
    const files = await expertStarterFiles(folder);
    const preview = previewResourcePackage(files, parseWorkflowTemplate);
    assert.equal(preview.items.length, 2);
    assert.equal(preview.files.length, 4);
    assert(preview.items.every((i) => i.missing.length === 0));
    const command = importCommand(preview, files);
    command.input.choices = command.input.choices.filter((c) => c.key === 'expert.json');
    const state = applyWorkbenchCommand(emptyWorkbench(), command);
    assert.equal(state.participants[0].available, false);
    assert(state.participants[0].origin.missing.length > 0);
    assert.equal(state.assets.length, 0);
  }
});
