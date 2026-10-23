import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  previewResourcePackage,
  parseWorkflowTemplate,
  applyWorkbenchCommand,
  emptyWorkbench,
  WorkbenchSchema,
  buildPlanningContext,
} from '../dist/index.js';

import {
  sourceFile,
  packageFixture,
  importCommand as packageCommand,
} from '../../../tests/fixtures/asset-package.mjs';
const importCommand = (files = packageFixture()) =>
  packageCommand(previewResourcePackage(files, parseWorkflowTemplate), files);

test('resource package: maps persona/methods and skill files without private state or execution', () => {
  const preview = previewResourcePackage(packageFixture(), parseWorkflowTemplate);
  assert.equal(preview.items.length, 2);
  assert.equal(preview.items[0].kind, 'skill');
  assert.equal(preview.items[1].name, 'Order analyst');
  assert.equal(preview.items[1].kind, 'expert');
  assert(preview.items[1].content.includes('Explain conflicting fields'));
  assert.deepEqual(preview.items[1].skillKeys, ['analyst/skills/field-review/SKILL.md']);
  assert.equal(preview.files.length, 6);
  assert.equal(preview.ignored.length, 4);
  assert.doesNotMatch(JSON.stringify(preview.files), /PRIVATE|unrelated/);
  assert(preview.files.some((f) => f.path.endsWith('scripts/check.py')));
  assert(preview.items[0].requirements.some((r) => r.includes('不授予权限')));
});

test('resource package: explicit import is atomic, preserves stable targets and freezes old references', () => {
  const state = emptyWorkbench();
  const command = importCommand();
  const first = applyWorkbenchCommand(state, command);
  assert.equal(first.assets.length, 1);
  assert.equal(first.participants.length, 1);
  assert.equal(first.participants[0].kind, 'expert');
  assert.deepEqual(first.participants[0].resourceBindings.skillIds, [first.assets[0].id]);
  assert.equal(first.assets[0].origin.versionId, command.input.versionId);
  assert.equal(first.participants[0].origin.filePaths.length, 3);
  assert.equal(first.assets[0].origin.filePaths.length, 3);
  assert.equal(state.assets.length, 0);
  const frozen = structuredClone(first);
  const update = structuredClone(command);
  update.input.versionId = randomUUID();
  update.input.choices.forEach((c) => (c.replace = true));
  update.input.files[0] = sourceFile(update.input.files[0].path, 'New persona source.');
  const second = applyWorkbenchCommand(first, update);
  assert.equal(second.participants[0].id, first.participants[0].id);
  assert.notEqual(second.participants[0].origin.versionId, first.participants[0].origin.versionId);
  assert.deepEqual(first, frozen);
  assert.throws(() => applyWorkbenchCommand(first, command), /标识已存在/);
  const renamed = applyWorkbenchCommand(first, {
    type: 'save-asset',
    asset: { ...first.assets[0], name: 'Display name' },
  });
  assert.equal(renamed.assets[0].name, 'Display name');
  assert.throws(
    () =>
      applyWorkbenchCommand(first, {
        type: 'save-asset',
        asset: { ...first.assets[0], content: 'silently rewrite' },
      }),
    /重新导入/,
  );
  assert.throws(
    () =>
      applyWorkbenchCommand(first, {
        type: 'save-participant',
        participant: { ...first.participants[0], origin: undefined },
      }),
    /来源版本/,
  );
});

test('resource package: missing files and unselected default skills stay disabled until a corrected import', () => {
  const files = packageFixture().filter((f) => !f.path.endsWith('guide.md'));
  const cmd = importCommand(files);
  const state = applyWorkbenchCommand(emptyWorkbench(), cmd);
  assert.equal(state.assets[0].available, false);
  assert.equal(state.participants[0].available, false);
  assert.deepEqual(state.assets[0].origin.missing, ['references/guide.md']);
  assert.throws(
    () => WorkbenchSchema.parse({ ...state, assets: [{ ...state.assets[0], available: true }] }),
    /缺项/,
  );
  const partial = importCommand();
  partial.input.choices = partial.input.choices.filter((c) => c.key.endsWith('SOUL.md'));
  const selected = applyWorkbenchCommand(emptyWorkbench(), partial);
  assert.equal(selected.participants[0].available, false);
  assert.equal(selected.assets.length, 0);
});

test('resource package: traversal, duplicate paths, hostile YAML, bad metadata and size limits fail closed', () => {
  for (const path of ['../SKILL.md', '/tmp/SKILL.md', 'C:/SKILL.md', 'a\\SKILL.md', 'a/./SKILL.md'])
    assert.throws(
      () => previewResourcePackage([sourceFile(path, 'x')], parseWorkflowTemplate),
      /路径/,
    );
  assert.throws(
    () =>
      previewResourcePackage(
        [...packageFixture(), sourceFile('analyst/soul.md', 'case collision')],
        parseWorkflowTemplate,
      ),
    /大小写冲突/,
  );
  for (const front of [
    'name: UPPER\ndescription: bad',
    'name: other-name\ndescription: wrong folder',
    'name: x\ndescription: !!js/function function() {}',
    'name: x\ndescription: &a [*a]',
    'name: x\nname: y\ndescription: duplicate',
  ])
    assert.throws(() =>
      previewResourcePackage(
        [sourceFile('x/SKILL.md', `---\n${front}\n---\nWork.`)],
        parseWorkflowTemplate,
      ),
    );
  assert.throws(() =>
    previewResourcePackage([sourceFile('SKILL.md', 'x'.repeat(262145))], parseWorkflowTemplate),
  );
  assert.throws(
    () =>
      previewResourcePackage(
        Array.from({ length: 101 }, (_, i) => sourceFile(`${i}/SKILL.md`, 'x')),
        parseWorkflowTemplate,
      ),
    /最多/,
  );
  const broken = sourceFile(
    'x/SKILL.md',
    '---\nname: x\ndescription: valid\n---\n[missing](../../secret.md)',
  );
  assert.deepEqual(previewResourcePackage([broken], parseWorkflowTemplate).items[0].missing, [
    '../../secret.md',
  ]);
});

test('resource package: declarative Zhuma expert excludes executable configuration; Unicode skill names survive', () => {
  const expert = {
    format: 'zhuma-expert',
    schemaVersion: 1,
    id: 'stable-expert',
    version: 'v1',
    name: 'Release reviewer',
    role: 'Independent review',
    capabilities: ['Review'],
    instructions: 'Review the submitted version.',
  };
  const preview = previewResourcePackage(
    [sourceFile('expert.json', JSON.stringify(expert))],
    parseWorkflowTemplate,
  );
  assert.equal(preview.items[0].sourceId, 'stable-expert');
  assert.equal(preview.items[0].sourceVersion, 'v1');
  const imported = applyWorkbenchCommand(
    emptyWorkbench(),
    importCommand([sourceFile('expert.json', JSON.stringify(expert))]),
  );
  assert.equal(imported.participants[0].origin.sourceId, 'stable-expert');
  assert.notEqual(imported.participants[0].id, 'stable-expert');
  assert.throws(
    () =>
      previewResourcePackage(
        [sourceFile('expert.json', JSON.stringify({ ...expert, plugins: ['execute'] }))],
        parseWorkflowTemplate,
      ),
    /不支持字段/,
  );
  const unicode = sourceFile(
    '代码评审/SKILL.md',
    '---\nname: 代码评审\ndescription: Review code.\n---\nReview the change.',
  );
  assert.equal(previewResourcePackage([unicode], parseWorkflowTemplate).items[0].name, '代码评审');
  const state = emptyWorkbench();
  state.participants = [
    {
      id: 'human',
      name: 'Human',
      kind: 'human',
      role: 'Owner',
      capabilities: [],
      instructions: '',
      available: true,
    },
  ];
  const cmd = importCommand([sourceFile('expert.json', JSON.stringify(expert))]);
  cmd.input.choices[0] = { ...cmd.input.choices[0], id: 'human', replace: true };
  assert.throws(() => applyWorkbenchCommand(state, cmd), /类型不匹配/);
});

test('resource package: ancestor notices survive; planning sees declared skills and source version, not package file manifests', () => {
  const files = [
    ...packageFixture(),
    sourceFile('LICENSE', 'Public test license.'),
    sourceFile('README.md', 'Public package reference.'),
    sourceFile('COPYRIGHT', 'Public test attribution.'),
  ];
  const preview = previewResourcePackage(files, parseWorkflowTemplate);
  for (const item of preview.items)
    assert(
      item.filePaths.includes('LICENSE') &&
        item.filePaths.includes('README.md') &&
        item.filePaths.includes('COPYRIGHT'),
    );
  const state = applyWorkbenchCommand(emptyWorkbench(), importCommand(files));
  state.projects = [{ id: 'project', name: 'Project', description: '' }];
  const expert = state.participants[0];
  const task = {
    id: 'task',
    title: 'Prepare release',
    goal: 'Prepare a release report.',
    ownerId: null,
    projectId: 'project',
    participantIds: [expert.id],
    workflows: [{ id: 'root', name: 'Main', parentNodeId: null, nodes: [] }],
    status: 'draft',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
  const context = buildPlanningContext(state, task, '');
  assert.equal(context.assets[0].id, state.assets[0].id);
  assert.equal(context.assets[0].selection, 'bound');
  assert.equal(context.participants[0].sourcePackageVersionId, expert.origin.versionId);
  assert.equal(context.participants[0].instructions, expert.instructions);
  assert(!JSON.stringify(context.participants).includes('filePaths'));
});

test('resource package: bracket-heavy instructions and declaration metadata stay bounded', () => {
  const file = sourceFile(
    'large/SKILL.md',
    `---\nname: large\ndescription: Static instructions.\n---\n${'['.repeat(50000)}`,
  );
  const preview = previewResourcePackage([file], parseWorkflowTemplate);
  assert.deepEqual(preview.items[0].missing, []);
  const state = applyWorkbenchCommand(emptyWorkbench(), importCommand());
  const expert = state.participants[0];
  assert.throws(
    () =>
      applyWorkbenchCommand(state, {
        type: 'save-participant',
        participant: { ...expert, resourceBindings: { skillIds: ['not-a-skill'], mcpIds: [] } },
      }),
    /默认能力/,
  );
  assert.throws(
    () =>
      applyWorkbenchCommand(state, {
        type: 'save-participant',
        participant: {
          ...expert,
          resourceBindings: { skillIds: [state.assets[0].id, state.assets[0].id], mcpIds: [] },
        },
      }),
    /默认能力/,
  );
});
