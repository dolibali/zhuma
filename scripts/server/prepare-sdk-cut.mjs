#!/usr/bin/env node
/** Reuses public compiled SDK packages only in this task's prepared build tree.
 * Never copies profiles, HOME, credentials, sessions or arbitrary ignored files. */
import { execFileSync } from 'node:child_process';
import { cp, access, symlink, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { sdk: { type: 'string' } } });
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
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
// Workspace links retain their relative targets in the new source checkout.
// Third-party .pnpm is a read-only public dependency cache, not profile state.
await mkdir(join(target, 'node_modules'), { recursive: true });
await symlink(join(cache, 'node_modules/.pnpm'), join(target, 'node_modules/.pnpm'), 'dir');
const manifests = execFileSync('git', ['ls-files', '-z', '**/package.json'], { cwd: cache })
  .toString()
  .split('\0')
  .filter(Boolean);
let packages = 0;
for (const manifest of manifests) {
  const directory = dirname(manifest);
  const value = JSON.parse(await readFile(join(cache, manifest), 'utf8'));
  if (!value.name?.startsWith('@deepseek-ai/')) continue;
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
// Build the changed public Gateway from the actual prepared patched source.
// Its normal package entry/exports and dependency graph remain in place.
const gateway = join(target, 'packages/api/gateway/lib/index.js');
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
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const result = {
  scope: 'owned-local-cli-sdk-cut-public-compiled-cache-no-profile-no-package',
  pin: lock.upstreams.deepseekHarness.commit,
  copiedPublicPackages: packages,
  patch: await hash(join(root, 'patches/deepseek-harness/zhuma-desktop.patch')),
  gateway: await hash(gateway),
  cli: await hash(join(target, 'apps/cli/lib/bin.js')),
  limits: [
    'Gateway rebuilt; unchanged public package outputs reused',
    'Not a fresh full SDK build, desktop package, GUI or cross-machine proof',
  ],
};
await writeFile(
  join(root, '.build/desktop/member-sdk-cut.json'),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(JSON.stringify(result, null, 2));
