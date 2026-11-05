/** Synthetic locked graph and relocation contracts, not a native SDK/HTTP qualification. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import {
  materializeExternalWorkspaceLinks,
  portableRuntimeFileExclusion,
} from '../../../scripts/server/portable-dependencies.mjs';
import { deployedSharedPatchPackageRoot } from '../../../scripts/server/shared-patch-owner.mjs';
import { runtimeInventory } from '../../../scripts/server/runtime-manifest.mjs';

async function packageAt(path, name, version, dependencies = {}) {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({ name, version, dependencies, main: 'index.cjs' }),
  );
  await writeFile(join(path, 'index.cjs'), 'module.exports = {};');
}
async function link(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await symlink(relative(dirname(to), from), to, 'dir');
}
test('only public workspace links are copied once; internal graph, module identity and relocation survive', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-locked-graph-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sdk = join(directory, 'sdk'),
    runtime = join(directory, 'runtime');
  const source = join(sdk, 'vendor/cosmokit'),
    name = '@deepseek-ai/cosmokit';
  await packageAt(source, name, '1.8.6');
  await mkdir(join(source, 'node_modules/unused'), { recursive: true });
  await writeFile(join(source, 'node_modules/unused/ignored'), 'not a runtime input');
  for (const owner of ['one', 'two']) {
    const root = join(runtime, 'node_modules/.pnpm', owner, 'node_modules', owner);
    await packageAt(root, owner, '1.0.0', { [name]: '1.8.6' });
    await link(source, join(dirname(root), name));
  }
  await link(source, join(runtime, 'node_modules', name));
  assert.equal(await materializeExternalWorkspaceLinks(runtime, sdk), 1);
  const from = (owner) =>
    createRequire(
      join(runtime, 'node_modules/.pnpm', owner, 'node_modules', owner, 'package.json'),
    );
  assert.equal(
    from('one')(name),
    from('two')(name),
    'one SDK workspace must remain one loaded module',
  );
  await assert.rejects(
    readFile(join(runtime, 'node_modules', name, 'node_modules/unused/ignored')),
    { code: 'ENOENT' },
  );
  const moved = join(directory, 'relocated');
  await cp(runtime, moved, { recursive: true, dereference: false, verbatimSymlinks: true });
  await rename(sdk, join(directory, 'source-unavailable'));
  const original = await runtimeInventory(runtime),
    relocated = await runtimeInventory(moved);
  assert.deepEqual(relocated, original);
  const a = createRequire(join(moved, 'node_modules/.pnpm/one/node_modules/one/package.json'));
  const b = createRequire(join(moved, 'node_modules/.pnpm/two/node_modules/two/package.json'));
  assert.equal(a(name), b(name));
});

test('runtime patch checks follow the real CLI private owner and never substitute a newer root hoist', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-private-patch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sdk = join(directory, 'sdk'),
    runtime = join(directory, 'runtime');
  const name = '@earendil-works/pi-ai',
    owner = '@deepseek-ai/dsh-llm-pi-ai',
    version = '0.2.1-rc.4';
  await packageAt(join(sdk, 'packages/llm/llm-pi-ai'), owner, version, { [name]: '^1.1.0' });
  await packageAt(runtime, 'runtime', '1.0.0');
  await packageAt(join(runtime, 'node_modules/@deepseek-ai/dsh'), '@deepseek-ai/dsh', version);
  await packageAt(
    join(runtime, 'node_modules/@deepseek-ai/dsh-base'),
    '@deepseek-ai/dsh-base',
    version,
  );
  const privateModules = join(runtime, 'node_modules/.pnpm/private/node_modules');
  await packageAt(join(privateModules, owner), owner, version, { [name]: '^1.1.0' });
  await link(join(privateModules, owner), join(runtime, 'node_modules', owner));
  await packageAt(join(privateModules, name), name, '1.1.0');
  await packageAt(join(runtime, 'node_modules', name), name, '1.4.0');
  assert.equal(
    await deployedSharedPatchPackageRoot(runtime, sdk, name, '1.1.0'),
    await realpath(join(privateModules, name)),
  );
  await packageAt(join(privateModules, name), name, '1.4.0');
  await assert.rejects(
    deployedSharedPatchPackageRoot(runtime, sdk, name, '1.1.0'),
    /Runtime shared patch version differs: @earendil-works\/pi-ai/u,
  );
});

test('virtual-store containers remain while original per-file exclusions still run', () => {
  const policy = (path) =>
    path.endsWith('.map') ? 'source map' : path.includes('.pnpm') ? 'metadata' : undefined;
  assert.equal(portableRuntimeFileExclusion('.pnpm', {}, '', policy), undefined);
  assert.equal(
    portableRuntimeFileExclusion('.pnpm/pkg@1/node_modules/pkg/index.js', {}, '', policy),
    undefined,
  );
  assert.equal(
    portableRuntimeFileExclusion('.pnpm/pkg@1/node_modules/pkg/index.js.map', {}, '', policy),
    'source map',
  );
  assert.equal(
    portableRuntimeFileExclusion('.pnpm/lock.yaml', {}, '', policy),
    'package-manager lock',
  );
});
