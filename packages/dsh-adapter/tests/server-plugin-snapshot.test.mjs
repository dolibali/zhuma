import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotServerPlugin } from '../../../scripts/server/plugin-snapshot.mjs';

test('server plugin snapshot contract: frozen bytes, pin, complete digest and no overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-public-plugin-'));
  try {
    const source = join(root, 'source');
    await mkdir(source);
    const hashes = {};
    for (const file of [
      'index.js',
      'member-web.js',
      'client.js',
      'package.json',
      'LICENSE',
      'THIRD_PARTY_LICENSES.txt',
    ]) {
      const body =
        file === 'package.json'
          ? JSON.stringify({ name: '@zhuma/workbench' })
          : `public fixture ${file}`;
      await writeFile(join(source, file), body);
      hashes[file] = createHash('sha256').update(body).digest('hex');
    }
    const manifest = { head: 'a'.repeat(40), tree: 'b'.repeat(40), sdkPin: 'c'.repeat(40), hashes };
    await writeFile(join(source, 'A-SOURCE.json'), JSON.stringify(manifest));
    const input = {
      source,
      sdkRoot: '/synthetic-sdk',
      pin: manifest.sdkPin,
      outputRoot: join(root, 'snapshots'),
      frozen: true,
    };
    const first = await snapshotServerPlugin(input);
    assert.equal(await snapshotServerPlugin(input), first);
    await writeFile(join(source, 'client.js'), 'later mutable build');
    await assert.rejects(snapshotServerPlugin(input), /bytes differ/u);
    assert.equal(await readFile(join(first, 'client.js'), 'utf8'), 'public fixture client.js');
    await assert.rejects(
      snapshotServerPlugin({ ...input, pin: 'd'.repeat(40) }),
      /source identity/u,
    );
    await writeFile(join(source, 'client.js'), 'public fixture client.js');
    await writeFile(join(first, 'index.js'), 'foreign output');
    await assert.rejects(snapshotServerPlugin(input), /snapshot differs/u);
    assert.equal(await readFile(join(first, 'index.js'), 'utf8'), 'foreign output');
    await writeFile(join(source, 'LICENSE'), 'new public license');
    assert.notEqual(await snapshotServerPlugin({ ...input, frozen: false }), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
