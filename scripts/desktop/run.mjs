#!/usr/bin/env node
/** Run Zhuma desktop inside the isolated DSH worktree. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const stage = `${root}/.build/desktop/deepseek-harness`;
const task = process.argv[2] ?? 'dev';
if (!['dev', 'package'].includes(task)) throw new Error(`Unknown desktop task: ${task}`);
const env = {
  ...process.env,
  DSH_DESKTOP_APP_ID: 'dev.zhuma.app',
  DSH_CLIENT_TITLE: 'Zhuma',
  // Disallow upstream auto updates in this independent unsigned build.
  DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '1',
};
const run = (args) => {
  const p = spawnSync('corepack', ['pnpm', ...args], { cwd: stage, stdio: 'inherit', env });
  if (p.error || p.status !== 0)
    throw new Error(`pnpm ${args.join(' ')} failed with ${String(p.error?.message ?? p.status)}`);
};
run(['install', '--frozen-lockfile']);
if (task === 'dev') {
  // Upstream's dev launcher imports compiled workspace libraries before its own build begins.
  run(['--config.verifyDepsBeforeRun=false', 'run', 'build:lib:host']);
  run(['--config.verifyDepsBeforeRun=false', 'run', 'build:lib:client']);
  run(['--config.verifyDepsBeforeRun=false', 'run', 'dev:desktop']);
} else {
  run(['--config.verifyDepsBeforeRun=false', 'run', 'package:desktop:mac:arm64:unsigned']);
  const artifacts = join(stage, 'apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts');
  const images = readdirSync(artifacts).filter((name) =>
    /^zhuma-.+-mac-arm64-unsigned\.dmg$/u.test(name),
  );
  if (images.length !== 1)
    throw new Error(`Expected exactly one Zhuma DMG, found ${images.join(', ')}`);
  const destination = join(root, 'dist');
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(artifacts, images[0]), join(destination, images[0]));
  console.log(`Zhuma installer available at ${join(destination, images[0])}`);
}
