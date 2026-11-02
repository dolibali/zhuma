/** Isolated dependency-owner shape; no real SDK/build success is inferred. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
    );
    await writeFile(join(packageRoot, 'index.js'), 'module.exports = {};');
    assert.equal(await sharedPatchPackageRoot(sdk, name, '1.0.0'), await realpath(packageRoot));
  }
  const web = createRequire(join(sdk, 'packages/bundle/web-app/package.json'));
  assert.throws(() => web.resolve('node-pty'), { code: 'MODULE_NOT_FOUND' });
  assert.throws(() => web.resolve('@earendil-works/pi-ai'), { code: 'MODULE_NOT_FOUND' });
  await assert.rejects(sharedPatchPackageRoot(sdk, 'unknown-patch', '1.0.0'), /Review the owner/u);
});

test('pi-ai 1.1.0 import-only root export resolves through the physical owner link with exact name/version', async (t) => {
  const sdk = await mkdtemp(join(tmpdir(), 'zhuma-patch-esm-owner-'));
  t.after(() => rm(sdk, { recursive: true, force: true }));
  const name = '@earendil-works/pi-ai',
    owner = join(sdk, 'packages/llm/llm-pi-ai');
  const physical = join(sdk, 'node_modules/.pnpm/pi-ai-1.1.0/node_modules', name);
  await mkdir(join(owner, 'node_modules/@earendil-works'), { recursive: true });
  await mkdir(join(physical, 'dist'), { recursive: true });
  await writeFile(
    join(owner, 'package.json'),
    JSON.stringify({ dependencies: { [name]: '1.1.0' } }),
  );
  // Exact root metadata from registry.npmjs.org/@earendil-works%2Fpi-ai/1.1.0.
  // Unrelated public API subpaths are omitted; neither require nor package.json is exported.
  const manifest = {
    name,
    version: '1.1.0',
    type: 'module',
    main: './dist/index.js',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    },
  };
  await writeFile(join(physical, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(physical, 'dist/index.js'), 'export {};');
  await writeFile(join(physical, 'dist/index.d.ts'), 'export {};');
  await symlink(
    physical,
    join(owner, 'node_modules', name),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const require = createRequire(join(owner, 'package.json'));
  assert.throws(() => require.resolve(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.throws(() => require.resolve(`${name}/package.json`), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  assert.equal(await sharedPatchPackageRoot(sdk, name, '1.1.0'), await realpath(physical));
  await assert.rejects(sharedPatchPackageRoot(sdk, name, '1.1.1'), /version differs/u);
  await writeFile(
    join(physical, 'package.json'),
    JSON.stringify({ ...manifest, name: 'wrong-name' }),
  );
  await assert.rejects(sharedPatchPackageRoot(sdk, name, '1.1.0'), /name differs/u);
});
