/** Resolve each reviewed shared patch from the package which actually declares it. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const owners = Object.freeze({
  '@earendil-works/pi-ai': 'packages/llm/llm-pi-ai/package.json',
  'node-pty': 'packages/subprocess/subprocess-local/package.json',
  '@zaimokuza/dsh-acp-adapter': 'packages/bundle/web-app/package.json',
});
export async function sharedPatchPackageRoot(sdk, name) {
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
  let directory = dirname(createRequire(owner).resolve(name));
  for (;;) {
    try {
      if (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name === name)
        return directory;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    assert(parent !== directory, 'Qualified installed patch package is absent.');
    directory = parent;
  }
}
