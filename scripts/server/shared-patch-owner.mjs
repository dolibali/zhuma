/** Resolve each reviewed shared patch from the package which actually declares it. */
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
