/** Controlled fixture in a separate OS process. No real account/profile/model. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { assetHost } from './member-asset-host-fixture.mjs';
import { signal } from './member-workbench-fixture.mjs';
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
  } else throw Error('unknown fixture action');
} finally {
  for (const hook of hooks) await hook();
}
