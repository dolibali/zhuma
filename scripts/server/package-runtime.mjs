#!/usr/bin/env node
/** Build a relocatable public Linux payload using the fixed SDK's production deploy helpers. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fileHash, HEADLESS_SDK_PIN, runtimeInventory } from './runtime-manifest.mjs';
import { assertProductSourceRecipe } from '../desktop/source-recipe.mjs';
import { bundleHeadlessLaunchers } from './bundle-headless.mjs';
import { sharedPatchPackageRoot } from './shared-patch-owner.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { sdk: { type: 'string' }, out: { type: 'string' } } });
assert(values.sdk && values.out, 'Pass an explicitly prepared --sdk and absent --out.');
assert(
  process.platform === 'linux' && process.arch === 'x64',
  'Build this payload on Linux amd64.',
);
assert.equal(process.versions.node, '24.15.0', 'Use the product Node toolchain.');
const sdk = resolve(values.sdk),
  output = resolve(values.out);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8'));
assert.equal(lock.upstreams.deepseekHarness.commit, HEADLESS_SDK_PIN);
assert.equal(git(sdk, 'rev-parse', 'HEAD'), HEADLESS_SDK_PIN);
assert.equal(git(root, 'status', '--porcelain'), '', 'Freeze product source before packaging.');
const productIdentity = {
  commit: git(root, 'rev-parse', 'HEAD'),
  tree: git(root, 'rev-parse', 'HEAD^{tree}'),
};
// Never label a stale mutable workbench build with the current source commit.
execFileSync(process.execPath, [join(root, 'scripts/workbench/build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
assertProductSourceRecipe(
  root,
  JSON.parse(await readFile(join(sdk, '.zhuma-prepared.json'), 'utf8')),
  'server',
);
execFileSync(
  'git',
  ['apply', '--reverse', '--check', join(root, 'patches/deepseek-harness/zhuma-desktop.patch')],
  { cwd: sdk },
);
await assert.rejects(access(output), { code: 'ENOENT' });
await mkdir(dirname(output), { recursive: true });
const stage = await mkdtemp(join(dirname(output), '.zhuma-server-'));
const deployed = join(stage, '.deployed');
const pnpm = (...args) =>
  execFileSync('corepack', ['pnpm', ...args], { cwd: sdk, stdio: 'inherit' });
assert.equal(
  execFileSync('corepack', ['pnpm', '--version'], { cwd: sdk, encoding: 'utf8' }).trim(),
  '11.28.5',
);
try {
  const source = (path) => pathToFileURL(join(sdk, path)).href;
  const { verifyRuntimeClosure } = await import(source('scripts/verify-runtime-closure.ts'));
  assert.deepEqual(
    (await verifyRuntimeClosure(sdk)).failures,
    [],
    'Official production closure is incomplete.',
  );
  const { prepareRuntimePatches } = await import(
    source('apps/desktop/scripts/prepare-runtime-patches.ts')
  );
  const policyRoot = join(stage, '.policy');
  await mkdir(policyRoot);
  await writeFile(join(policyRoot, 'pnpm-workspace.yaml'), 'packages: ["."]\n');
  // Classification/hash guards run before the official legacy deploy's reviewed unused-build-patch option.
  const plan = prepareRuntimePatches(policyRoot, sdk);
  pnpm(
    '--filter',
    'dsh-python-runtime-closure',
    'deploy',
    '--legacy',
    '--prod',
    '--config.allow-unused-patches=true',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    '--config.hoist-workspace-packages=false',
    deployed,
  );
  const { restoreLegacyHoists } = await import(source('scripts/executable-packaging.ts'));
  const { materializeStagedLinks, deduplicateStagedWorkspacePackages } = await import(
    source('scripts/build-exe-for-python-sdk-staging.ts')
  );
  await restoreLegacyHoists(deployed, join(sdk, 'python/sdk-runtime/node_modules'));
  await materializeStagedLinks(deployed);
  await deduplicateStagedWorkspacePackages(deployed, sdk);
  for (const patch of plan.patches) {
    const from = await sharedPatchPackageRoot(sdk, patch.name);
    const to = join(deployed, 'node_modules', patch.name);
    assert.equal(
      JSON.parse(await readFile(join(to, 'package.json'), 'utf8')).version,
      patch.version,
    );
    // Every changed file in each shared patch must retain the qualified installed bytes.
    const body = await readFile(join(policyRoot, patch.path), 'utf8');
    const files = [...body.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1]);
    assert(files.length > 0, 'Shared patch must identify changed files.');
    for (const file of files) {
      assert(!file.split('/').includes('..') && !file.startsWith('/'));
      assert.equal(
        await fileHash(join(to, file)),
        await fileHash(join(from, file)),
        'Production shared patch bytes differ.',
      );
    }
  }
  const { selectOfficeEngine } = await import(source('scripts/libreoffice-packages.mjs'));
  const { desktopRuntimeFileExclusion } = await import(
    source('apps/desktop/scripts/runtime-file-policy.ts')
  );
  const office = JSON.parse(
    await readFile(
      join(deployed, 'node_modules/@deepseek-ai/libreoffice-kit/package.json'),
      'utf8',
    ),
  );
  const engine = selectOfficeEngine(office, { platform: process.platform, arch: process.arch });
  const destination = join(stage, 'sdk');
  await cp(deployed, destination, {
    recursive: true,
    dereference: true,
    filter(path) {
      const local = path
        .slice(deployed.length + 1)
        .split('\\')
        .join('/');
      if (local.startsWith('node_modules/'))
        return (
          desktopRuntimeFileExclusion(
            local.slice('node_modules/'.length),
            { platform: process.platform, arch: process.arch },
            engine,
          ) === undefined
        );
      return !['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'].includes(local);
    },
  });
  await rm(deployed, { recursive: true });
  await rm(policyRoot, { recursive: true });
  await mkdir(join(stage, 'workbench'));
  const publicFiles = [
    'index.js',
    'client.js',
    'member-web.js',
    'package.json',
    'LICENSE',
    'THIRD_PARTY_LICENSES.txt',
    'codearts-acp.js',
    'codearts-acp.manifest.json',
    'codearts-policy.js',
  ];
  for (const file of publicFiles)
    await cp(join(root, '.build/workbench', file), join(stage, 'workbench', file));
  await symlink('../sdk/node_modules', join(stage, 'workbench/node_modules'), 'dir');
  await bundleHeadlessLaunchers(root, stage);
  await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  await cp(
    join(root, '.build/workbench/THIRD_PARTY_LICENSES.txt'),
    join(stage, 'THIRD_PARTY_LICENSES.txt'),
  );
  const cli = JSON.parse(
    await readFile(join(stage, 'sdk/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'),
  );
  assert.equal(cli.version, lock.upstreams.deepseekHarness.version);
  const product = JSON.parse(await readFile(join(stage, 'workbench/package.json'), 'utf8'));
  const manifest = {
    schemaVersion: 1,
    product: {
      version: product.version,
      ...productIdentity,
      lockSha256: await fileHash(join(root, 'pnpm-lock.yaml')),
    },
    sdk: {
      commit: HEADLESS_SDK_PIN,
      version: cli.version,
      lockSha256: await fileHash(join(sdk, 'pnpm-lock.yaml')),
      patchSha256: await fileHash(join(root, 'patches/deepseek-harness/zhuma-desktop.patch')),
    },
    runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    files: await runtimeInventory(stage),
  };
  assert.equal(
    git(root, 'rev-parse', 'HEAD'),
    productIdentity.commit,
    'Product source moved during packaging.',
  );
  assert.equal(git(root, 'status', '--porcelain'), '', 'Product source changed during packaging.');
  await writeFile(join(stage, 'SOURCE.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rename(stage, output);
  console.log(
    'Public Linux backend payload prepared; credentials and user profiles were not copied.',
  );
} catch (error) {
  await rm(stage, { recursive: true, force: true });
  throw error;
}
