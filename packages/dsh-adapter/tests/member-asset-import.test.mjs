/** Original bounded import preflight/parser, member issuer, Workbench/package
 * JSON. Account/admission setup is contractual; no GUI/model/script execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageFileText, memberAssetDefinitionId } from '@zhuma/agent-core';
import { assetHost } from './member-asset-host-fixture.mjs';
import { signal, deferred } from './member-workbench-fixture.mjs';
import { sourceFile, packageFixture, packageZip } from '../../../tests/fixtures/asset-package.mjs';
import { definition as workflowDefinition } from './member-template-fixture.mjs';

const upload = () => ({
  kind: 'files',
  files: [
    ...packageFixture(),
    sourceFile('LICENSE.txt', 'Original fixture license.'),
    sourceFile('README.md', 'Original public provenance.'),
  ],
});
async function prepare(h, raw = upload()) {
  const preview = await h.owner.previewImport(
    h.requests.ann,
    { spaceId: 'north', upload: raw },
    signal(),
  );
  const input = {
    spaceId: 'north',
    idempotencyKey: randomUUID(),
    packageChecksum: preview.packageChecksum,
    upload: raw,
    choices: preview.items.map((item) => ({
      key: item.key,
      id: randomUUID(),
      name: item.name,
      description: item.description,
      role: item.role,
      capabilities: item.capabilities,
      dependencies: [],
    })),
  };
  return { preview, input };
}
const commit = (h, input, actor = 'ann') =>
  h.owner.importDrafts(h.requests[actor], input, signal());
const read = (h, row, actor = 'ann') =>
  h.owner.read(
    h.requests[actor],
    { spaceId: row.spaceId, assetId: row.assetId, draft: true },
    signal(),
  );
const publish = (h, row) =>
  h.command({
    operation: 'publish',
    spaceId: row.spaceId,
    assetId: row.assetId,
    expectedVersion: row.version,
    idempotencyKey: randomUUID(),
  });

test('member import: actual preflight is read-only and raw ZIP/files import only owned drafts into the original atomic fact/package', async (t) => {
  const h = await assetHost(t),
    { preview, input } = await prepare(h);
  assert.equal(h.workbench.snapshot().memberAssets, undefined);
  assert.equal([...h.packageDomain.table('versions').keys()].length, 0);
  assert.equal(preview.items.length, 2);
  assert(!JSON.stringify(preview).includes('PRIVATE_TOKEN'));
  assert(!('files' in preview));
  const result = await commit(h, input);
  assert.equal(result.assets.length, 2);
  assert(
    result.assets.every(
      (row) => row.ownerId === 'ann' && row.hasDraft && row.versions.length === 0,
    ),
  );
  assert.equal(h.workbench.snapshot().revision, 1);
  assert.deepEqual(h.owner.publishedDefinitions('north'), { experts: [], assets: [] });
  assert.equal([...h.packageDomain.table('versions').keys()].length, 1);
  const pack = h.workbench.memberAssetPackage(result.source.versionId);
  assert(!JSON.stringify(pack).includes('PRIVATE_USER'));
  assert(!JSON.stringify(pack).includes('PRIVATE_MEMORY'));
  assert(!JSON.stringify(pack).includes('PRIVATE_TOKEN'));
  assert(pack.files.some((file) => file.path === 'LICENSE.txt'));
  assert(pack.files.some((file) => packageFileText(file).includes('NEVER_EXECUTE_IMPORT')));
  const zip = { kind: 'zip', data: packageZip(input.upload.files).toString('base64') };
  const second = await prepare(h, zip);
  const zipped = await commit(h, second.input);
  assert.equal(zipped.assets.length, 2);
  assert(zipped.assets.every((item) => !item.versions.length));
});

test('member import: missing published Skill dependencies stay visible until explicit real fixed mapping and publication', async (t) => {
  const h = await assetHost(t),
    { input } = await prepare(h),
    result = await commit(h, input);
  const expert = result.assets.find((row) => row.kind === 'expert'),
    skill = result.assets.find((row) => row.kind === 'skill');
  const detail = await read(h, expert);
  assert.equal(detail.requirements.length, 1);
  assert.equal(detail.requirements[0].suggestedAssetId, skill.assetId);
  assert.equal(detail.dependencies.length, 0);
  await assert.rejects(publish(h, expert), { code: 'asset-dependency-required' });
  assert.equal(
    h.workbench.snapshot().memberAssets.find((row) => row.assetId === expert.assetId).published
      .length,
    0,
  );
  const fixed = await publish(h, skill);
  const edited = await h.command({
    operation: 'update-draft',
    spaceId: 'north',
    assetId: expert.assetId,
    expectedVersion: expert.version,
    idempotencyKey: randomUUID(),
    definition: detail.definition,
    dependencies: [{ slotId: detail.requirements[0].slotId, reference: fixed.reference }],
  });
  const published = await publish(h, edited.asset);
  const catalog = h.owner.publishedDefinitions('north');
  assert.equal(catalog.experts[0].id, memberAssetDefinitionId(published.reference));
  assert.deepEqual(catalog.experts[0].resourceBindings.skillIds, [
    memberAssetDefinitionId(fixed.reference),
  ]);
  const publicValue = await h.owner.read(
    h.requests.bob,
    { spaceId: 'north', assetId: expert.assetId, versionId: published.reference.versionId },
    signal(),
  );
  assert.equal(publicValue.requirements[0].sourceKey, detail.requirements[0].sourceKey);
});

test('member import: a physically missing declared Skill stays readable as an unmet draft requirement and cannot publish', async (t) => {
  const h = await assetHost(t);
  const raw = {
    kind: 'files',
    files: [
      sourceFile(
        'expert.json',
        JSON.stringify({
          format: 'zhuma-expert',
          schemaVersion: 1,
          name: '接口专家',
          role: '审阅接口',
          capabilities: ['review'],
          instructions: '检查接口。',
          skillPaths: ['skills/missing/SKILL.md'],
        }),
      ),
    ],
  };
  const { preview, input } = await prepare(h, raw);
  assert.deepEqual(preview.items[0].missing, ['skills/missing/SKILL.md']);
  const result = await commit(h, input),
    asset = result.assets[0];
  const before = h.workbench.snapshot();
  const detail = await read(h, asset);
  assert.deepEqual(detail.requirements, [
    {
      slotId: 'source-skill-1',
      kind: 'skill',
      name: 'skills/missing/SKILL.md',
      sourceKey: 'skills/missing/SKILL.md',
    },
  ]);
  assert.deepEqual(detail.definition.origin.missing, ['skills/missing/SKILL.md']);
  assert.deepEqual(detail.dependencies, []);
  assert.equal(detail.asset.hasDraft, true);
  await assert.rejects(publish(h, asset), { code: 'asset-dependency-required' });
  assert.deepEqual(h.workbench.snapshot(), before);
  assert.equal([...h.packageDomain.table('versions').keys()].length, 1);
});

test('member import: checksum/selection/identity/scope tampering and private origin injection refuse without package or Workbench writes', async (t) => {
  const h = await assetHost(t),
    { input } = await prepare(h),
    before = h.workbench.snapshot();
  for (const candidate of [
    { ...input, packageChecksum: 'f'.repeat(64) },
    { ...input, choices: [{ ...input.choices[0], key: 'not-in-package' }] },
    { ...input, actorId: 'ann' },
    { ...input, choices: [{ ...input.choices[0], origin: { versionId: randomUUID() } }] },
  ])
    await assert.rejects(commit(h, candidate));
  await assert.rejects(commit(h, input, 'dana'), { code: 'asset-forbidden' });
  await assert.rejects(commit(h, { ...input, spaceId: 'south' }), { code: 'asset-forbidden' });
  assert.deepEqual(h.workbench.snapshot(), before);
  assert.equal([...h.packageDomain.table('versions').keys()].length, 0);
});

test('member import: same-key atomic replay survives reopen and later draft removal without restoring or duplicating content', async (t) => {
  const h = await assetHost(t),
    { input } = await prepare(h),
    first = await commit(h, input),
    target = first.assets[0];
  await h.command({
    operation: 'remove-draft',
    spaceId: 'north',
    assetId: target.assetId,
    expectedVersion: target.version,
    idempotencyKey: randomUUID(),
  });
  const before = h.workbench.snapshot();
  await h.close();
  const cold = await assetHost(t, { root: h.root }),
    replay = await commit(cold, input);
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.source, first.source);
  assert.deepEqual(replay.resultVersions, first.resultVersions);
  assert.equal(replay.assets.find((row) => row.assetId === target.assetId).hasDraft, false);
  assert.equal(cold.workbench.snapshot().revision, before.revision);
  assert.equal([...cold.packageDomain.table('versions').keys()].length, 1);
  await assert.rejects(
    commit(cold, {
      ...input,
      choices: input.choices.map((choice) => ({ ...choice, name: 'Changed' })),
    }),
    { code: 'asset-request-reused' },
  );
});

test('member import: failed original metadata write retains one immutable source package and exact retry commits the whole batch once', async (t) => {
  let fail = false;
  const h = await assetHost(t, {
    beforeWrite: async (next) => {
      if (fail && next.memberAssets?.length) throw Error('PRIVATE_DISK_FAILURE');
    },
  });
  const { input } = await prepare(h);
  fail = true;
  await assert.rejects(
    commit(h, input),
    (error) => error.code === 'asset-unavailable' && !error.message.includes('PRIVATE_'),
  );
  assert.equal(h.workbench.snapshot().memberAssets, undefined);
  assert.equal([...h.packageDomain.table('versions').keys()].length, 1);
  fail = false;
  const result = await commit(h, input);
  assert.equal(result.disposition, 'applied');
  assert.equal(h.workbench.snapshot().revision, 1);
  assert.equal([...h.packageDomain.table('versions').keys()].length, 1);
});

test('member import: original package success plus revocation is not business success', async (t) => {
  let revoke;
  const h = await assetHost(t, {
    beforePackageWrite: async () => {
      await revoke?.();
    },
  });
  const { input } = await prepare(h);
  revoke = () => h.revoke('north', 'ann');
  await assert.rejects(commit(h, input));
  assert.equal(h.workbench.snapshot().memberAssets, undefined);
  assert.equal([...h.packageDomain.table('versions').keys()].length, 1);
});

test('member import: selecting only the expert retains real dependency requirements without inventing missing files or published Skill references', async (t) => {
  const h = await assetHost(t),
    { input } = await prepare(h);
  input.choices = input.choices.filter((choice) => choice.key.endsWith('SOUL.md'));
  const result = await commit(h, input),
    detail = await read(h, result.assets[0]);
  assert.equal(detail.definition.kind, 'expert');
  assert.deepEqual(detail.definition.origin.missing, []);
  assert.equal(detail.requirements.length, 1);
  assert.equal(detail.requirements[0].suggestedAssetId, undefined);
  assert.equal(detail.dependencies.length, 0);
  await assert.rejects(publish(h, result.assets[0]), { code: 'asset-dependency-required' });
});

test('member import: unrelated unselected duplicate source names do not block the selected original definition', async (t) => {
  const h = await assetHost(t),
    raw = {
      kind: 'files',
      files: [
        sourceFile('a/same/SKILL.md', '---\nname: same\ndescription: A\n---\nA.'),
        sourceFile('b/same/SKILL.md', '---\nname: same\ndescription: B\n---\nB.'),
      ],
    };
  const { input } = await prepare(h, raw);
  input.choices = input.choices.slice(0, 1);
  const result = await commit(h, input);
  assert.equal(result.assets.length, 1);
  const fixed = await publish(h, result.assets[0]);
  assert.equal(fixed.reference.kind, 'skill');
});

test('member import: a lost acknowledgement after the actual original JSON commit replays exactly without a second batch write', async (t) => {
  let fail = true;
  const h = await assetHost(t, {
    afterWrite: async () => {
      if (fail) {
        fail = false;
        throw Error('PRIVATE-ACK-LOST');
      }
    },
  });
  const { input } = await prepare(h);
  await assert.rejects(commit(h, input), { code: 'asset-unavailable' });
  assert.equal(h.workbench.snapshot().memberAssets.length, 2);
  const before = h.workbench.snapshot().revision;
  const replay = await commit(h, input);
  assert.equal(replay.disposition, 'replayed');
  assert.equal(h.workbench.snapshot().revision, before);
  assert.equal([...h.packageDomain.table('versions').keys()].length, 1);
});

test('member import: concurrent same-key requests create one atomic owned batch; a changed accepted body never overwrites it', async (t) => {
  const h = await assetHost(t),
    { input } = await prepare(h);
  const values = await Promise.all([commit(h, input), commit(h, input)]);
  assert.deepEqual(values.map((value) => value.disposition).sort(), ['applied', 'replayed']);
  assert.deepEqual(values[0].source, values[1].source);
  assert.equal(h.workbench.snapshot().revision, 1);
  await assert.rejects(
    commit(h, {
      ...input,
      choices: input.choices.map((choice) => ({ ...choice, id: randomUUID() })),
    }),
    { code: 'asset-request-reused' },
  );
  assert.equal(h.workbench.snapshot().memberAssets.length, input.choices.length);
});

test('member import: a new OS process reopens the original JSON package/drafts and exact receipt with unresolved dependencies intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-import-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = new URL('./member-asset-process.mjs', import.meta.url),
    locator = join(root, 'locator.json'),
    run = promisify(execFile);
  await run(process.execPath, [script.pathname, 'import-seed', root, locator], { timeout: 20000 });
  const result = await run(process.execPath, [script.pathname, 'import-recover', root, locator], {
    timeout: 20000,
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    replayedWithoutWrite: true,
    originalPackageRetained: true,
    requiredSkillCount: 1,
  });
});

test('member import: an actual workflow definition remains an editable unpublished template until an explicit fixed publication', async (t) => {
  const h = await assetHost(t),
    raw = {
      kind: 'files',
      files: [
        sourceFile('workflow.json', JSON.stringify(workflowDefinition)),
        sourceFile('LICENSE', 'Fixture license.'),
      ],
    };
  const { input } = await prepare(h, raw),
    result = await commit(h, input),
    detail = await read(h, result.assets[0]);
  assert.equal(detail.definition.kind, 'template');
  assert.deepEqual(JSON.parse(detail.definition.content), workflowDefinition);
  assert.equal(result.assets[0].versions.length, 0);
  assert.equal(h.workbench.snapshot().tasks.length, 0);
  const published = await publish(h, result.assets[0]);
  const fixed = await h.owner.reference(h.requests.bob, published.reference, signal());
  assert.equal(fixed.definition.kind, 'template');
  assert(fixed.definition.origin.filePaths.includes('LICENSE'));
  assert.deepEqual(
    JSON.parse(h.owner.publishedDefinitions('north').assets[0].content),
    workflowDefinition,
  );
});

test('member import: repeated original preflight failures release import admission and never create package facts', async (t) => {
  const h = await assetHost(t),
    bad = {
      spaceId: 'north',
      upload: { kind: 'files', files: [sourceFile('not-a-definition.txt', 'plain reference')] },
    };
  for (let index = 0; index < 3; index++)
    await assert.rejects(h.owner.previewImport(h.requests.ann, bad, signal()), {
      code: 'asset-invalid',
    });
  const { preview } = await prepare(h);
  assert.equal(preview.items.length, 2);
  assert.equal(h.workbench.snapshot().memberAssets, undefined);
  assert.equal([...h.packageDomain.table('versions').keys()].length, 0);
});

test('member import: close joins an ignored-abort original package write and fences late draft commit', async (t) => {
  const entered = deferred(),
    pending = deferred();
  const h = await assetHost(t, {
    beforePackageWrite: async () => {
      entered.resolve();
      await pending.promise;
    },
  });
  const { input } = await prepare(h),
    importing = commit(h, input);
  await entered.promise;
  let closed = false;
  const closing = h.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  pending.resolve();
  await assert.rejects(importing);
  await closing;
  const cold = await assetHost(t, { root: h.root });
  assert.equal(cold.workbench.snapshot().memberAssets, undefined);
  assert.equal([...cold.packageDomain.table('versions').keys()].length, 1);
  assert.equal((await commit(cold, input)).disposition, 'applied');
});
