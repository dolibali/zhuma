/** Isolated dependency-owner shape; no real SDK/build success is inferred. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { sharedPatchPackageRoot } from '../../../scripts/server/shared-patch-owner.mjs';

test('shared patches resolve only from their real owners in an unhoisted installation', async (t) => {
  const sdk = await mkdtemp(join(tmpdir(), 'zhuma-patch-owners-'));
  t.after(() => rm(sdk, { recursive: true, force: true }));
  const rows = [
    ['@earendil-works/pi-ai', 'packages/llm/llm-pi-ai'],
    ['node-pty', 'packages/subprocess/subprocess-local'],
    ['@zaimokuza/dsh-acp-adapter', 'packages/bundle/web-app'],
  ];
  for (const [name, owner] of rows) {
    const packageRoot = join(sdk, owner, 'node_modules', name);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(sdk, owner, 'package.json'),
      JSON.stringify({ dependencies: { [name]: '1.0.0' } }),
    );
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    await writeFile(join(packageRoot, 'index.js'), 'module.exports = {};');
    assert.equal(await sharedPatchPackageRoot(sdk, name), await realpath(packageRoot));
  }
  const web = createRequire(join(sdk, 'packages/bundle/web-app/package.json'));
  assert.throws(() => web.resolve('node-pty'), { code: 'MODULE_NOT_FOUND' });
  assert.throws(() => web.resolve('@earendil-works/pi-ai'), { code: 'MODULE_NOT_FOUND' });
  await assert.rejects(sharedPatchPackageRoot(sdk, 'unknown-patch'), /Review the owner/u);
});
