#!/usr/bin/env node
/** Reuses only declared public SDK runtime outputs. Never copies profiles,
 * HOME, credentials, sessions or arbitrary ignored files. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, copyFile, access, symlink, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: { sdk: { type: 'string' }, 'native-only': { type: 'boolean', default: false } },
});
if (!values.sdk) throw new Error('Pass --sdk with the built fixed public SDK');
const cache = resolve(values.sdk),
  target = join(root, '.build/desktop/deepseek-harness');
if (cache === target) throw new Error('Source SDK and owned target must differ');
const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8'));
for (const path of [cache, target]) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
  if (sha !== lock.upstreams.deepseekHarness.commit) throw new Error('Unexpected SDK source pin');
}
await access(join(target, '.zhuma-prepared.json'));
await access(join(cache, 'apps/cli/lib/bin.js'));
if (!values['native-only'])
  execFileSync(
    'git',
    ['apply', '--reverse', '--check', join(root, 'patches/deepseek-harness/zhuma-desktop.patch')],
    { cwd: target },
  );
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const gateway = join(target, 'packages/api/gateway/lib/index.js');
const frozen = values['native-only']
  ? {
      gateway: await hash(gateway),
      cli: await hash(join(target, 'apps/cli/lib/bin.js')),
      flockEntry: await hash(join(target, 'native/system/packages/entry/lib/flock.js')),
    }
  : undefined;
if (!values['native-only']) {
  // Rebased Workspace links and a read-only public third-party dependency store.
  await mkdir(join(target, 'node_modules'), { recursive: true });
  await symlink(join(cache, 'node_modules/.pnpm'), join(target, 'node_modules/.pnpm'), 'dir');
}
const manifests = execFileSync('git', ['ls-files', '-z', '**/package.json'], { cwd: cache })
  .toString()
  .split('\0')
  .filter(Boolean);
let packages = 0;
const nativeMaterials = [];
for (const manifest of manifests) {
  const directory = dirname(manifest),
    value = JSON.parse(await readFile(join(cache, manifest), 'utf8'));
  if (!value.name?.startsWith('@deepseek-ai/')) continue;
  if (!values['native-only']) {
    for (const output of ['lib', 'dist', 'node_modules']) {
      const from = join(cache, directory, output),
        to = join(target, directory, output);
      if (await exists(from))
        await cp(from, to, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });
    }
    packages++;
  }
  if (directory !== `native/system/packages/${process.platform}-${process.arch}`) continue;
  assert.equal(value.name, `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`);
  assert.ok(value.os.includes(process.platform) && value.cpu.includes(process.arch));
  assert.equal(value.license, 'BSD-3-Clause');
  const prebuild = JSON.parse(await readFile(join(cache, directory, 'prebuilds.json'), 'utf8'));
  assert.equal(prebuild.platform, `${process.platform}-${process.arch}`);
  for (const binary of prebuild.binaries) {
    assert.match(binary.path, /^bin\/(?:(?:glibc|musl)\/)?(?:system\.node|landlock-run)$/u);
    if (binary.kind === 'node-api') assert.ok(binary.napi <= Number(process.versions.napi));
    const from = join(cache, directory, binary.path),
      to = join(target, directory, binary.path),
      digest = await hash(from);
    const present = await exists(to);
    if (present)
      assert.equal(
        await hash(to),
        digest,
        'Existing frozen native output must match; never overwrite it',
      );
    else {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to, constants.COPYFILE_EXCL);
    }
    nativeMaterials.push({
      package: value.name,
      version: value.version,
      license: value.license,
      path: `${directory}/${binary.path}`,
      sha256: digest,
      newlyAdded: !present,
      ...(binary.kind === 'node-api' ? { napi: binary.napi } : {}),
    });
  }
}
if (!values['native-only']) {
  // The changed public Gateway is built from the actual prepared patched source.
  await build({
    entryPoints: [join(target, 'packages/api/gateway/src/index.ts')],
    outfile: gateway,
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    logLevel: 'silent',
  });
}
const after = {
  gateway: await hash(gateway),
  cli: await hash(join(target, 'apps/cli/lib/bin.js')),
  flockEntry: await hash(join(target, 'native/system/packages/entry/lib/flock.js')),
};
if (frozen)
  assert.deepEqual(after, frozen, 'Native-only addition must preserve all frozen entry bytes');
const result = {
  scope: values['native-only']
    ? 'additive-public-native-runtime-extension-no-entry-rebuild'
    : 'owned-local-cli-sdk-cut-public-compiled-cache-no-profile-no-package',
  pin: lock.upstreams.deepseekHarness.commit,
  copiedPublicPackages: packages,
  ...(values['native-only']
    ? { base: JSON.parse(await readFile(join(root, '.build/desktop/member-sdk-cut.json'), 'utf8')) }
    : { patch: await hash(join(root, 'patches/deepseek-harness/zhuma-desktop.patch')) }),
  ...after,
  nativeMaterials,
  runtime: {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    napi: process.versions.napi,
  },
  limits: [
    'No profile/state copied',
    'Not a fresh full SDK build, desktop package, GUI or cross-machine proof',
  ],
};
const manifestPath = join(
  root,
  `.build/desktop/${values['native-only'] ? 'member-sdk-native-extension' : 'member-sdk-cut'}.json`,
);
if (values['native-only'] && (await exists(manifestPath))) {
  const recorded = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(recorded.pin, result.pin);
  assert.equal(recorded.gateway, result.gateway);
  const materials = (rows) => rows.map(({ path, sha256 }) => ({ path, sha256 }));
  assert.deepEqual(materials(recorded.nativeMaterials), materials(result.nativeMaterials));
} else await writeFile(manifestPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
