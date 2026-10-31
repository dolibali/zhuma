/** Controlled fixture in a separate OS process. No real account/profile/model. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { assetHost } from './member-asset-host-fixture.mjs';
import { signal } from './member-workbench-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { packageFixture, sourceFile } from '../../../tests/fixtures/asset-package.mjs';
const [action, root, locator] = process.argv.slice(2),
  hooks = [];
const h = await assetHost({ after: (fn) => hooks.push(fn) }, { root });
try {
  if (action === 'seed') {
    const data = Buffer.from('new-process 汉😀 verified bytes'),
      created = await h.create();
    const input = h.uploadInput(created.input.assetId, data),
      receipt = await h.upload(input, data);
    await h.files.idle();
    const published = await h.publish(input, receipt);
    await writeFile(
      locator,
      JSON.stringify({
        input,
        receipt,
        reference: published.reference,
        revision: h.workbench.snapshot().revision,
        text: data.toString(),
      }),
    );
  } else if (action === 'recover') {
    const fixed = JSON.parse(await readFile(locator, 'utf8'));
    const target = {
      spaceId: fixed.reference.spaceId,
      assetId: fixed.reference.assetId,
      versionId: fixed.reference.versionId,
    };
    const read = await h.files.read(h.requests.bob, target, signal());
    assert.equal(Buffer.from(read.bytes).toString(), fixed.text);
    assert.deepEqual(await h.upload(fixed.input, Buffer.from(fixed.text)), fixed.receipt);
    await h.files.idle();
    assert.equal(h.workbench.snapshot().revision, fixed.revision);
    const metadata = await h.owner.reference(h.requests.bob, fixed.reference, signal());
    assert.deepEqual(metadata.reference, fixed.reference);
    process.stdout.write(
      JSON.stringify({
        fixedVersion: metadata.reference.versionId,
        replayedWithoutWrite: true,
        bytesVerified: true,
      }),
    );
  } else if (action === 'import-seed') {
    const upload = {
      kind: 'files',
      files: [...packageFixture(), sourceFile('LICENSE.txt', 'Original fixture license.')],
    };
    const preview = await h.owner.previewImport(
      h.requests.ann,
      { spaceId: 'north', upload },
      signal(),
    );
    const input = {
      spaceId: 'north',
      idempotencyKey: randomUUID(),
      packageChecksum: preview.packageChecksum,
      upload,
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
    const result = await h.owner.importDrafts(h.requests.ann, input, signal());
    await writeFile(
      locator,
      JSON.stringify({
        input,
        source: result.source,
        resultVersions: result.resultVersions,
        revision: h.workbench.snapshot().revision,
      }),
    );
  } else if (action === 'import-recover') {
    const stored = JSON.parse(await readFile(locator, 'utf8'));
    const result = await h.owner.importDrafts(h.requests.ann, stored.input, signal());
    assert.equal(result.disposition, 'replayed');
    assert.deepEqual(result.source, stored.source);
    assert.deepEqual(result.resultVersions, stored.resultVersions);
    assert.equal(h.workbench.snapshot().revision, stored.revision);
    assert.equal([...h.packageDomain.table('versions').keys()].length, 1);
    const expert = result.assets.find((item) => item.kind === 'expert');
    const detail = await h.owner.read(
      h.requests.ann,
      { spaceId: 'north', assetId: expert.assetId, draft: true },
      signal(),
    );
    assert.equal(detail.requirements.length, 1);
    process.stdout.write(
      JSON.stringify({
        replayedWithoutWrite: true,
        originalPackageRetained: true,
        requiredSkillCount: detail.requirements.length,
      }),
    );
  } else throw Error('unknown fixture action');
} finally {
  for (const hook of hooks) await hook();
}
