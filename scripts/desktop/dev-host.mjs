#!/usr/bin/env node
/** Refresh only the Host in an existing official development workspace. Never inspect a profile. */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { values } = parseArgs({
  options: { stage: { type: 'string' }, 'prepare-only': { type: 'boolean', default: false } },
});
const stage = resolve(values.stage ?? join(root, '.build/desktop/deepseek-harness'));
const lock = JSON.parse(readFileSync(join(root, 'runtime.lock.json'), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This development target requires macOS arm64.');
if (git(stage, 'rev-parse', 'HEAD') !== lock.upstreams.deepseekHarness.commit)
  throw new Error('Unexpected prepared SDK revision.');
const stamp = JSON.parse(readFileSync(join(stage, '.zhuma-prepared.json'), 'utf8'));
const recipe = Buffer.concat(
  [
    'patches/deepseek-harness/zhuma-desktop.patch',
    'packages/dsh-adapter/src/desktop-member-cookie.ts',
    'scripts/desktop/verify-build-source-paths.ts',
    'scripts/desktop/verify-runtime-privacy.ts',
    'branding/default/icon-manifest.json',
    'scripts/desktop/prepare.mjs',
    'scripts/desktop/icon-assets.mjs',
  ].map((name) => readFileSync(join(root, name))),
);
if (stamp.pinned !== lock.upstreams.deepseekHarness.commit || stamp.digest !== sha(recipe))
  throw new Error('Prepared SDK recipe differs; prepare the matching SDK before refreshing.');
for (const name of [
  'apps/desktop/lib/main.js',
  'apps/desktop-host/lib/index.js',
  'apps/desktop/scripts/dev.ts',
  'apps/desktop/.desktop-build/targets/mac-arm64/runtime/primary-runtime/runtime.json',
])
  if (!existsSync(join(stage, name)))
    throw new Error('Official development artifacts/runtime are missing; run desktop:dev once.');
const build = spawnSync(
  process.execPath,
  [join(root, 'scripts/workbench/build.mjs'), '--host-only'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (build.error || build.status !== 0) throw new Error('Host-only workbench build failed.');
const source = join(root, '.build/workbench');
const target = join(stage, 'packages/bundle/web-app/lib/zhuma-workbench');
if (!existsSync(join(target, 'client.js'))) throw new Error('Prepared Client bundle is missing.');
for (const name of ['package.json', 'LICENSE', 'THIRD_PARTY_LICENSES.txt'])
  if (!readFileSync(join(source, name)).equals(readFileSync(join(target, name))))
    throw new Error('Existing manifest/legal inputs differ; assemble the complete bundle first.');
copyFileSync(join(source, 'index.js'), join(target, 'index.js'));
const identity = {
  sourceCommit: git(root, 'rev-parse', 'HEAD'),
  sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
  sourceDirty: git(root, 'status', '--porcelain').length > 0,
  sdkPin: stamp.pinned,
  recipeDigest: stamp.digest,
  hostSha256: sha(readFileSync(join(target, 'index.js'))),
  clientSha256: sha(readFileSync(join(target, 'client.js'))),
  launcher: join(stage, 'apps/desktop/scripts/dev.ts'),
  profileAccessed: false,
  packaged: false,
};
const report = join(root, '.build/desktop/debug-host-identity.json');
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, JSON.stringify(identity, null, 2) + '\n');
console.log(JSON.stringify(identity));
if (!values['prepare-only']) {
  // The official launcher owns Electron, development-project links and inspectors.
  // DSH_HOME/userData are supplied by the operator; no profile is read or copied here.
  const launched = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'apps/desktop/scripts/dev.ts', '--skip-build'],
    {
      cwd: stage,
      stdio: 'inherit',
      env: {
        ...process.env,
        DSH_DESKTOP_APP_ID: 'dev.zhuma.app',
        DSH_CLIENT_TITLE: 'Zhuma',
        ZHUMA_DESKTOP_PRODUCT_VERSION: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
          .version,
        DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '1',
      },
    },
  );
  if (launched.error) throw launched.error;
  process.exitCode = launched.status ?? 1;
}
