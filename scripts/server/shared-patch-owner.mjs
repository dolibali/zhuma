/** Resolve each reviewed shared patch from the package which actually declares it. */
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { installedDependencyRoot } from './portable-dependencies.mjs';

const owners = Object.freeze({
  '@earendil-works/pi-ai': 'packages/llm/llm-pi-ai/package.json',
  'node-pty': 'packages/subprocess/subprocess-local/package.json',
  '@zaimokuza/dsh-acp-adapter': 'packages/bundle/web-app/package.json',
});
export async function sharedPatchPackageRoot(sdk, name, version) {
  assert(Object.hasOwn(owners, name), 'Review the owner of every new shared runtime patch.');
  const owner = join(sdk, owners[name]);
  const manifest = JSON.parse(await readFile(owner, 'utf8'));
  assert(
    Object.hasOwn(
      { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies },
      name,
    ),
    'The reviewed patch owner no longer declares its dependency.',
  );
  // Read the declared install directly: ESM-only exports can forbid both
  // require(name) and the package.json subpath. pnpm's owner link is physical
  // build input, not a public executable/module entrypoint.
  const directory = await realpath(join(dirname(owner), 'node_modules', name));
  const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.equal(installed.name, name, 'Installed shared patch package name differs.');
  assert(
    typeof version === 'string' && version.length > 0,
    'Expected shared patch version is required.',
  );
  assert.equal(installed.version, version, 'Installed shared patch package version differs.');
  return directory;
}

export async function deployedSharedPatchPackageRoot(runtime, sdk, name, version) {
  assert(Object.hasOwn(owners, name), 'Review the owner of every new shared runtime patch.');
  const expectedOwner = JSON.parse(await readFile(join(sdk, owners[name]), 'utf8'));
  let ownerFile = join(runtime, 'package.json');
  // These are the actual fixed SDK CLI plugin chains, rather than a guessed root hoist.
  const chain =
    name === '@zaimokuza/dsh-acp-adapter'
      ? ['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-app']
      : ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', expectedOwner.name];
  for (const dependency of chain) {
    const item = await installedDependencyRoot(runtime, ownerFile, dependency);
    ownerFile = join(item.directory, 'package.json');
  }
  const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  assert.equal(owner.name, expectedOwner.name, `Runtime patch owner differs: ${name}`);
  assert.equal(
    owner.version,
    expectedOwner.version,
    `Runtime patch owner version differs: ${name}`,
  );
  const installed = await installedDependencyRoot(runtime, ownerFile, name);
  assert.equal(
    installed.manifest.version,
    version,
    `Runtime shared patch version differs: ${name}`,
  );
  return installed.directory;
}
