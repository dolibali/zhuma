import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { assets, rejects } from './member-asset-fixture.mjs';
import { signal, deferred } from './member-workbench-fixture.mjs';
import {
  applyWorkbenchCommand,
  emptyWorkbench,
  previewResourcePackage,
  parseWorkflowTemplate,
  packageFileText,
} from '@zhuma/agent-core';
import { sourceFile, importCommand } from '../../../tests/fixtures/asset-package.mjs';
import { digest } from './member-asset-fixture.mjs';

const command = (created, operation, patch = {}) => ({
  operation,
  spaceId: created.input.spaceId,
  assetId: created.input.assetId,
  expectedVersion: created.result.asset.version,
  idempotencyKey: randomUUID(),
  ...patch,
});
test('member asset authority: original request identity, current space and maintainer rights precede all writes', async (t) => {
  const h = assets(t);
  const created = await h.create('skill');
  const before = JSON.stringify(h.f.storage.read());
  await assert.rejects(
    h.owner.list({ headers: {} }, { spaceId: 'north' }, signal()),
    rejects('asset-forbidden'),
  );
  await assert.rejects(
    h.owner.list(h.requests.ann, { spaceId: 'south' }, signal()),
    rejects('asset-forbidden'),
  );
  await assert.rejects(
    h.owner.list(h.requests.ann, { spaceId: 'north', actorId: 'dana' }, signal()),
    rejects('asset-invalid'),
  );
  await assert.rejects(h.command(command(created, 'publish'), 'bob'), rejects('asset-forbidden'));
  await assert.rejects(
    h.owner.read(
      h.requests.bob,
      { spaceId: 'north', assetId: created.input.assetId, draft: true },
      signal(),
    ),
    rejects('asset-forbidden'),
  );
  assert.deepEqual(
    (await h.owner.list(h.requests.bob, { spaceId: 'north', includeDrafts: true }, signal())).items,
    [],
  );
  assert.equal(JSON.stringify(h.f.storage.read()), before);
});
test('member asset authority: same-key canonical replay survives original owner reopen; changed body never overwrites', async (t) => {
  const h = assets(t);
  const created = await h.create('skill');
  assert.equal((await h.command(created.input)).disposition, 'replayed');
  await assert.rejects(
    h.command({
      ...created.input,
      definition: { ...created.input.definition, content: 'changed' },
    }),
    rejects('asset-request-reused'),
  );
  assert.equal(h.f.writes, 1);
  await h.reopen();
  const replay = await h.command(created.input);
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.resultVersion, 1);
  assert.equal(h.f.writes, 1);
});
test('member asset authority: original immutable package and fixed published version do not follow a later draft or publication', async (t) => {
  const h = assets(t);
  const created = await h.create('skill');
  const published = await h.command(command(created, 'publish'));
  assert.equal(h.packages.size, 1);
  const fixed = await h.owner.read(
    h.requests.bob,
    { spaceId: 'north', assetId: created.input.assetId, versionId: published.reference.versionId },
    signal(),
  );
  const oldPackage = structuredClone([...h.packages.values()][0]);
  const updated = await h.command(
    command(created, 'update-draft', {
      expectedVersion: published.asset.version,
      definition: {
        ...created.input.definition,
        content: 'New definition',
        name: 'PRIVATE-DRAFT-TITLE',
      },
      dependencies: [],
    }),
  );
  const publicList = await h.owner.list(
    h.requests.bob,
    { spaceId: 'north', includeDrafts: true },
    signal(),
  );
  assert.equal(publicList.items[0].name, 'Review');
  assert(!JSON.stringify(publicList).includes('PRIVATE-DRAFT'));
  const next = await h.command(
    command(created, 'publish', { expectedVersion: updated.asset.version }),
  );
  assert.notEqual(next.reference.versionId, published.reference.versionId);
  assert.notEqual(next.reference.sha256, published.reference.sha256);
  assert.deepEqual(
    (
      await h.owner.read(
        h.requests.bob,
        {
          spaceId: 'north',
          assetId: created.input.assetId,
          versionId: published.reference.versionId,
        },
        signal(),
      )
    ).definition,
    fixed.definition,
  );
  assert.deepEqual(h.packages.get(oldPackage.versionId), oldPackage);
  await assert.rejects(
    h.owner.reference(h.requests.bob, { ...published.reference, sha256: 'f'.repeat(64) }, signal()),
    rejects('asset-reference-denied'),
  );
});
test('member asset authority: expectedVersion conflict and concurrent original-queue commands produce only one mutation', async (t) => {
  const h = assets(t);
  const created = await h.create('expert');
  const update = command(created, 'update-draft', {
    definition: { ...created.input.definition, instructions: 'Updated method' },
    dependencies: [],
  });
  const results = await Promise.allSettled([
    h.command(update),
    h.command({ ...update, idempotencyKey: randomUUID() }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'asset-conflict');
  assert.equal(h.f.writes, 2);
});
test('member asset authority: metadata maintenance is explicit; team membership alone cannot publish or appoint maintainers', async (t) => {
  const h = assets(t);
  const created = await h.create('expert');
  await assert.rejects(
    h.command(command(created, 'set-maintainers', { maintainerIds: ['ann', 'bob'] }), 'bob'),
    rejects('asset-forbidden'),
  );
  const changed = await h.command(
    command(created, 'set-maintainers', { maintainerIds: ['ann', 'bob'] }),
    'cy',
  );
  await h.command(command(created, 'publish', { expectedVersion: changed.asset.version }), 'bob');
  await assert.rejects(
    h.command(
      command(created, 'set-maintainers', {
        expectedVersion: changed.asset.version,
        maintainerIds: ['bob'],
      }),
      'bob',
    ),
    rejects('asset-forbidden'),
  );
});
test('member asset authority: copy is independent and personal dependencies require explicit target-space replacement', async (t) => {
  const h = assets(t);
  const dependency = await h.create('skill', { spaceId: 'personal-ann' });
  const dep = await h.command(command(dependency, 'publish'));
  const expert = await h.create('expert', {
    spaceId: 'personal-ann',
    dependencies: [{ slotId: 'method', reference: dep.reference }],
  });
  const original = await h.command(command(expert, 'publish'));
  const copy = {
    operation: 'copy',
    spaceId: 'north',
    assetId: randomUUID(),
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    name: 'Team copy',
    source: original.reference,
    dependencies: [{ slotId: 'method', reference: dep.reference }],
  };
  const before = JSON.stringify(h.f.storage.read());
  await assert.rejects(h.command(copy), rejects('asset-dependency-required'));
  assert.equal(JSON.stringify(h.f.storage.read()), before);
  const teamDep = await h.create('skill');
  const teamPublished = await h.command(command(teamDep, 'publish'));
  const independent = await h.command({
    ...copy,
    dependencies: [{ slotId: 'method', reference: teamPublished.reference }],
  });
  assert.equal(independent.asset.ownerId, 'ann');
  assert.equal(independent.asset.spaceId, 'north');
  const sourceValue = await h.owner.reference(h.requests.ann, original.reference, signal());
  assert.equal(sourceValue.definition.name, 'Reviewer');
});
test('member asset authority: revocation during original package write prevents publication; original bytes never imply business success', async (t) => {
  const h = assets(t);
  const created = await h.create('skill');
  h.packageWrite(async () => {
    h.revoke('ann');
  });
  await assert.rejects(h.command(command(created, 'publish')));
  assert.equal(h.packages.size, 1);
  assert.equal(h.f.storage.read().memberAssets[0].published.length, 0);
  assert.equal(h.f.writes, 1);
});
test('member asset authority: remove-draft keeps all fixed versions and original task/project facts', async (t) => {
  const h = assets(t);
  const created = await h.create('skill');
  const published = await h.command(command(created, 'publish'));
  const record = structuredClone(h.f.storage.read().memberAssets[0]);
  await h.command(command(created, 'remove-draft', { expectedVersion: published.asset.version }));
  assert.equal(h.f.storage.read().memberAssets[0].draft, null);
  assert.deepEqual(h.f.storage.read().memberAssets[0].published, record.published);
  assert.deepEqual(h.f.storage.read().tasks, []);
  await h.owner.reference(h.requests.bob, published.reference, signal());
});

test('member asset authority: copied nested Skill retains original metadata, linked support and legal notices when publishing an edited body', async (t) => {
  const files = [
    sourceFile(
      'skills/original/SKILL.md',
      '---\nname: original\ndescription: Original method\nlicense: MIT\nuser-invocable: false\n---\nRead [guide](references/guide.md).',
    ),
    sourceFile('skills/original/references/guide.md', 'Original support.'),
    sourceFile('LICENSE.txt', 'Original fixture license.'),
    sourceFile('README.md', 'Original provenance.'),
  ];
  const preview = previewResourcePackage(files, parseWorkflowTemplate),
    imported = importCommand(preview, files);
  const original = applyWorkbenchCommand(emptyWorkbench(), imported).assets[0];
  const h = assets(t, { catalog: { experts: [], assets: [original] } });
  h.packages.set(imported.input.versionId, {
    versionId: imported.input.versionId,
    files: preview.files,
    digest: digest(JSON.stringify(preview.files)),
  });
  const source = (await h.owner.sources(h.requests.ann, { spaceId: 'north' }, signal())).items[0]
    .source;
  const copied = await h.command({
    operation: 'copy',
    spaceId: 'north',
    assetId: randomUUID(),
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    name: 'Independent copy',
    source,
    dependencies: [],
  });
  const edited = await h.command({
    operation: 'update-draft',
    spaceId: 'north',
    assetId: copied.asset.assetId,
    expectedVersion: copied.asset.version,
    idempotencyKey: randomUUID(),
    definition: {
      kind: 'skill',
      name: 'Edited method',
      description: 'Edited description',
      content: 'Edited body. Read [guide](references/guide.md).',
    },
    dependencies: [],
  });
  const published = await h.command({
    operation: 'publish',
    spaceId: 'north',
    assetId: copied.asset.assetId,
    expectedVersion: edited.asset.version,
    idempotencyKey: randomUUID(),
  });
  const fixed = await h.owner.reference(h.requests.bob, published.reference, signal());
  const pack = h.packages.get(fixed.definition.origin.versionId),
    entry = pack.files.find((file) => file.path === 'skills/original/SKILL.md');
  assert.match(packageFileText(entry), /name: original/u);
  assert.match(packageFileText(entry), /license: MIT/u);
  assert.match(packageFileText(entry), /user-invocable: false/u);
  assert.match(packageFileText(entry), /Edited body/u);
  assert(fixed.definition.origin.filePaths.includes('README.md'));
  assert(fixed.definition.origin.filePaths.includes('LICENSE.txt'));
  assert(pack.files.some((file) => file.path === 'skills/original/references/guide.md'));
  assert.equal(
    h.packages.get(imported.input.versionId).digest,
    digest(JSON.stringify(preview.files)),
  );
});
