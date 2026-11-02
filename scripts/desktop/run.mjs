#!/usr/bin/env node
/** Run Zhuma desktop inside the isolated DSH worktree. */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { desktopStageLaunch } from '../lib/dev-model-gateway.mjs';
import { corepackPnpmInvocation } from '../lib/corepack-pnpm.mjs';
import { desktopPackageTarget } from '../lib/desktop-package-target.mjs';
import { assertProductSourceRecipe } from './source-recipe.mjs';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const stage = `${root}/.build/desktop/deepseek-harness`;
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { target: { type: 'string' } },
});
assert(positionals.length <= 1, 'Pass one desktop task.');
const task = positionals[0] ?? 'dev';
const brand = JSON.parse(readFileSync(join(root, 'branding/default/brand.json'), 'utf8'));
const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^[0-9A-Za-z.-]+$/u.test(brand.desktopBuildVersion))
  throw new Error('Invalid desktop build version');
if (!['dev', 'package'].includes(task)) throw new Error(`Unknown desktop task: ${task}`);
assert(task === 'package' || values.target === undefined, 'target only applies to packaging.');
const target =
  task === 'package'
    ? desktopPackageTarget(
        values.target ?? (process.platform === 'win32' ? 'win-x64' : 'mac-arm64'),
      )
    : undefined;
assertProductSourceRecipe(
  root,
  JSON.parse(readFileSync(join(stage, '.zhuma-prepared.json'), 'utf8')),
  'desktop',
);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const provenance =
  task === 'package'
    ? {
        ZHUMA_DESKTOP_SOURCE_COMMIT: git('rev-parse', 'HEAD'),
        ZHUMA_DESKTOP_SOURCE_DIRTY: git('status', '--porcelain') ? '1' : '0',
      }
    : {};
if (target?.name === 'win-x64')
  assert.equal(
    provenance.ZHUMA_DESKTOP_SOURCE_DIRTY,
    '0',
    'Freeze Windows candidate sources first.',
  );
const candidateRecord = join(root, 'dist/windows-x64/SOURCE.json');
if (target?.name === 'win-x64')
  assert(
    !existsSync(candidateRecord),
    'Preserve the existing Windows candidate before a new build.',
  );
const baseEnv = {
  ...process.env,
  ...provenance,
  DSH_DESKTOP_APP_ID: 'dev.zhuma.app',
  DSH_CLIENT_TITLE: 'Zhuma',
  // Keep the independent product/build versions separate from the pinned SDK runtime version.
  ZHUMA_DESKTOP_PRODUCT_VERSION: product.version,
  // Disallow upstream auto updates in this independent unsigned build.
  DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '1',
};
// desktop:dev passes --dev-gateway when ZHUMA_WORKBENCH_DEV_GATEWAY is 1 (the dev default).
// Formal package always passes --no-dev-gateway and forces that variable off.
// URL / key / model ids come only from env; the key is not written into the overlay.
const { env, installStageArgs } = desktopStageLaunch(task, baseEnv);
const run = (args) => {
  const [command, argv] = corepackPnpmInvocation(args);
  const p = spawnSync(command, argv, { cwd: stage, stdio: 'inherit', env });
  if (p.error || p.status !== 0)
    throw new Error(`pnpm ${args.join(' ')} failed with ${String(p.error?.message ?? p.status)}`);
};
run(['install', '--frozen-lockfile']);
for (const script of ['workbench/build.mjs', 'workbench/install-stage.mjs']) {
  const extra = script === 'workbench/install-stage.mjs' ? installStageArgs : [];
  const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...extra], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Workbench preparation failed: ${script}`);
}
if (task === 'dev') {
  // Upstream's dev launcher imports compiled workspace libraries before its own build begins.
  run(['--config.verifyDepsBeforeRun=false', 'run', 'build:lib:host']);
  run(['--config.verifyDepsBeforeRun=false', 'run', 'build:lib:client']);
  run(['--config.verifyDepsBeforeRun=false', 'run', 'dev:desktop']);
} else {
  run([
    '--config.verifyDepsBeforeRun=false',
    'run',
    target.script,
    '--build-version',
    brand.desktopBuildVersion,
  ]);
  if (target.name === 'win-x64') {
    assert.equal(
      git('rev-parse', 'HEAD'),
      provenance.ZHUMA_DESKTOP_SOURCE_COMMIT,
      'Windows candidate source moved.',
    );
    assert.equal(git('status', '--porcelain'), '', 'Windows candidate source changed.');
    assert(!existsSync(candidateRecord), 'Preserve the existing Windows candidate before copying.');
  }
  const artifacts = join(
    stage,
    'apps/desktop/.desktop-build/targets',
    target.name,
    'unsigned-artifacts',
  );
  const artifactName = `zhuma-${brand.desktopBuildVersion}-${target.name}-unsigned.${target.extension}`;
  const destination = join(root, target.name === 'win-x64' ? 'dist/windows-x64' : 'dist');
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(artifacts, artifactName), join(destination, artifactName));
  console.log(`Zhuma installer available at ${join(destination, artifactName)}`);
}
