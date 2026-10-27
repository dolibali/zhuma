#!/usr/bin/env node
/** Run Zhuma desktop inside the isolated DSH worktree. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const stage = `${root}/.build/desktop/deepseek-harness`;
const task = process.argv[2] ?? 'dev';
const brand = JSON.parse(readFileSync(join(root, 'branding/default/brand.json'), 'utf8'));
const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^[0-9A-Za-z.-]+$/u.test(brand.desktopBuildVersion))
  throw new Error('Invalid desktop build version');
if (!['dev', 'package'].includes(task)) throw new Error(`Unknown desktop task: ${task}`);
const env = {
  ...process.env,
  DSH_DESKTOP_APP_ID: 'dev.zhuma.app',
  DSH_CLIENT_TITLE: 'Zhuma',
  // Keep the independent product/build versions separate from the pinned SDK runtime version.
  ZHUMA_DESKTOP_PRODUCT_VERSION: product.version,
  // Disallow upstream auto updates in this independent unsigned build.
  DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '1',
};
const run = (args) => {
  const p = spawnSync('corepack', ['pnpm', ...args], { cwd: stage, stdio: 'inherit', env });
  if (p.error || p.status !== 0)
    throw new Error(`pnpm ${args.join(' ')} failed with ${String(p.error?.message ?? p.status)}`);
};
run(['install', '--frozen-lockfile']);
for (const script of ['workbench/build.mjs', 'workbench/install-stage.mjs']) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', script)], {
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
    'package:desktop:mac:arm64:unsigned',
    '--build-version',
    brand.desktopBuildVersion,
  ]);
  const artifacts = join(stage, 'apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts');
  const artifactName = `zhuma-${brand.desktopBuildVersion}-mac-arm64-unsigned.dmg`;
  const destination = join(root, 'dist');
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(artifacts, artifactName), join(destination, artifactName));
  console.log(`Zhuma installer available at ${join(destination, artifactName)}`);
}
