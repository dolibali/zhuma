/** Original MemberWorkbench scope/catalog contracts, not a product permission claim. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { emptyWorkbench } from '@zhuma/agent-core';
import { setup, signal, rejected } from './member-workbench-fixture.mjs';
import { template, skill } from './member-template-fixture.mjs';
import { ENGINEERING_WORKFLOW_SOURCE } from '../dist/member-template-catalog.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const origin = () => ({
  versionId: randomUUID(),
  format: 'agent-skill',
  entryPath: 'SKILL.md',
  filePaths: ['SKILL.md'],
  totalBytes: 1,
  missing: [],
  sourceId: 'package-skill',
  sourceVersion: '1.0.0',
});

test('member asset sources: four genuine built-ins retain source commit/content pin, never owner or publication UUID', async () => {
  const base = new URL('../../../resources/workflows/engineering-starter/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('catalog.json', base), 'utf8'));
  const assets = await Promise.all(
    manifest.workflows.map(async (entry) => ({
      id: entry.id,
      kind: 'template',
      name: entry.name,
      description: entry.description,
      available: true,
      content: await readFile(new URL(entry.file, base), 'utf8'),
    })),
  );
  const f = setup({ service: { catalog: async () => ({ experts: [], assets }) } });
  const view = await f.service().assetSources({ spaceId: 'north' }, signal());
  assert.equal(view.actorId, 'ann');
  assert.equal(view.items.length, 4);
  for (const item of view.items) {
    assert.equal(item.summary.source.kind, 'builtin');
    assert.equal(item.summary.source.sourceCommit, ENGINEERING_WORKFLOW_SOURCE);
    assert.equal(item.summary.source.sha256, hash(item.definition.content));
    assert.equal(item.summary.canCopy, true);
    assert.equal(Object.hasOwn(item.summary, 'ownerId'), false);
    assert.equal(Object.hasOwn(item.summary.source, 'versionId'), false);
  }
  assert.equal(f.writes, 0);
  assert.equal(f.storage.read().memberAssets, undefined);
});
test('member asset sources: authorized package, scoped member template and unknown pin stay separate; legacy global grants nothing', async () => {
  const state = emptyWorkbench();
  state.assets = [
    { ...template(), id: 'LEGACY-PRIVATE', name: 'LEGACY-PRIVATE' },
    {
      ...template(),
      id: 'owned',
      memberTemplate: {
        schemaVersion: 1,
        spaceId: 'north',
        ownerId: 'ann',
        sourceTaskId: 'original-task',
        sourceWorkbenchRevision: 17,
      },
    },
    {
      ...template(),
      id: 'foreign-owned',
      memberTemplate: {
        schemaVersion: 1,
        spaceId: 'south',
        ownerId: 'dana',
        sourceTaskId: 'foreign-task',
        sourceWorkbenchRevision: 19,
      },
    },
  ];
  const pack = { ...skill(), id: 'package-skill', origin: origin() };
  const unknown = { ...skill(), id: 'unpinned' };
  const f = setup({
    state,
    service: { catalog: async () => ({ experts: [], assets: [pack, unknown] }) },
  });
  const value = await f.service().assetSources({ spaceId: 'north' }, signal());
  assert.deepEqual(
    value.items.map((item) => item.summary.source.kind),
    ['package', 'unknown', 'member-template'],
  );
  assert.deepEqual(value.items[0].summary.source.origin, pack.origin);
  assert.equal(value.items[1].summary.canCopy, false);
  assert.equal(value.items[2].summary.source.ownerId, 'ann');
  assert.equal(value.items[2].summary.source.sourceWorkbenchRevision, 17);
  assert(!JSON.stringify(value).includes('LEGACY-PRIVATE'));
  assert(!JSON.stringify(value).includes('foreign-owned'));
  assert.equal(f.writes, 0);
});
test('member asset sources: caller actor/foreign space, retired membership and post-await source changes fail closed without writes', async () => {
  const f = setup();
  await assert.rejects(f.service().assetSources({ spaceId: 'north', actorId: 'dana' }, signal()));
  await assert.rejects(f.service().assetSources({ spaceId: 'south' }, signal()));
  f.grants.delete('north/ann');
  await assert.rejects(f.service().assetSources({ spaceId: 'north' }, signal()));
  assert.equal(f.writes, 0);
  let calls = 0;
  const changing = setup({
    service: {
      catalog: async () => ({
        experts: [],
        assets: [{ ...skill(), content: `version-${calls++}` }],
      }),
    },
  });
  await assert.rejects(
    changing.service().assetSources({ spaceId: 'north' }, signal()),
    rejected('context-changed'),
  );
  assert.equal(changing.writes, 0);
});
test('member asset sources: managed personal owner remains mandatory for owned workflows', async () => {
  const state = emptyWorkbench();
  state.assets.push({
    ...template(),
    memberTemplate: {
      schemaVersion: 1,
      spaceId: 'personal-ann',
      ownerId: 'ann',
      sourceTaskId: 'task',
      sourceWorkbenchRevision: 0,
    },
  });
  const f = setup({ state });
  await assert.rejects(f.service().assetSources({ spaceId: 'personal-ann' }, signal()));
  f.directory.administratorForSpace = () => 'ann';
  const value = await f.service().assetSources({ spaceId: 'personal-ann' }, signal());
  assert.equal(value.items[0].summary.source.kind, 'member-template');
  f.directory.administratorForSpace = () => 'bob';
  await assert.rejects(f.service().assetSources({ spaceId: 'personal-ann' }, signal()));
  assert.equal(f.writes, 0);
});
