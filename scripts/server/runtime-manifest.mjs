/** Public immutable payload inventory. No Git or writable checkout is needed at startup. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const HEADLESS_SDK_PIN = '504a01a9578abc2c6f1fb896b1dc322c9fe24f66';
export async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
export async function runtimeInventory(root) {
  const canonical = await realpath(root),
    entries = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        local = relative(root, path).split(sep).join('/');
      if (local === 'SOURCE.json') continue;
      assert(name !== '.git', 'Runtime must not carry Git state.');
      const metadata = await lstat(path);
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isSymbolicLink()) {
        const target = await readlink(path),
          actual = await realpath(path);
        assert(
          !isAbsolute(target) && actual.startsWith(canonical + sep),
          'Runtime link must remain inside the payload.',
        );
        entries.push({ path: local, link: target });
      } else {
        assert(metadata.isFile(), 'Runtime contains an unsupported file type.');
        entries.push({ path: local, bytes: metadata.size, sha256: await fileHash(path) });
      }
    }
  }
  await walk(root);
  return entries;
}
export async function inspectHeadlessRuntime(root) {
  const source = JSON.parse(await readFile(join(root, 'SOURCE.json'), 'utf8'));
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.sdk.commit, HEADLESS_SDK_PIN);
  assert.match(source.product.commit, /^[a-f0-9]{40}$/u);
  assert.match(source.product.tree, /^[a-f0-9]{40}$/u);
  assert.equal(source.runtime.platform, process.platform);
  assert.equal(source.runtime.arch, process.arch);
  assert.equal(source.runtime.node, process.versions.node);
  const plugin = JSON.parse(await readFile(join(root, 'workbench/package.json'), 'utf8'));
  assert.equal(plugin.name, '@zhuma/workbench');
  assert.equal(plugin.version, source.product.version);
  const cli = JSON.parse(
    await readFile(join(root, 'sdk/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'),
  );
  assert.equal(cli.version, '0.2.1-rc.4');
  assert.deepEqual(
    await runtimeInventory(root),
    source.files,
    'Runtime payload differs from its source inventory.',
  );
  return {
    source,
    cli: resolve(root, 'sdk/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    plugin: resolve(root, 'workbench/index.js'),
  };
}
