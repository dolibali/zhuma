#!/usr/bin/env node
/** Materialize a Zhuma-branded build without changing the pinned DSH submodule. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const upstream = join(root, 'upstream/deepseek-harness');
const stage = join(root, '.build/desktop/deepseek-harness');
const patchPath = join(root, 'patches/deepseek-harness/zhuma-desktop.patch');
const image = join(root, 'branding/default/icon-source.jpg');
const pinned = JSON.parse(readFileSync(join(root, 'runtime.lock.json'), 'utf8')).upstreams
  .deepseekHarness.commit;
const stampPath = join(stage, '.zhuma-prepared.json');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.error?.message ?? result.status)})`,
    );
}
function output(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout.trim();
}
if (output('git', ['rev-parse', 'HEAD'], upstream) !== pinned)
  throw new Error('DSH submodule moved from the pinned version');
if (!existsSync(image)) throw new Error(`Missing approved Zhuma icon: ${image}`);
const digest = createHash('sha256')
  .update(readFileSync(patchPath))
  .update(readFileSync(image))
  .digest('hex');
if (existsSync(stampPath)) {
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  if (stamp.digest === digest && output('git', ['rev-parse', 'HEAD'], stage) === pinned) {
    console.log(`Zhuma desktop already prepared: ${stage}`);
    process.exit(0);
  }
  throw new Error(
    'Prepared build changed; remove the owned .build/desktop worktree with scripts/desktop/reset.mjs',
  );
}
if (existsSync(stage)) throw new Error(`Unmanaged stage exists: ${stage}; do not overwrite it`);
mkdirSync(resolve(stage, '..'), { recursive: true });
run('git', ['-C', upstream, 'worktree', 'add', '--detach', stage, pinned]);
run('git', ['-C', stage, 'apply', '--check', patchPath]);
run('git', ['-C', stage, 'apply', patchPath]);
// The pinned upstream's postinstall hook expects the main repository's Git layout;
// this disposable worktree is intentionally not allowed to register repo-wide hooks.
writeFileSync(
  join(stage, 'scripts/install-lefthook.mjs'),
  '// Zhuma isolated build: do not alter Git hooks in the pinned upstream repository.\n',
);
if (process.platform !== 'darwin')
  throw new Error(
    'Current branding exporter targets macOS; add a Windows icon exporter before building on Windows',
  );
const icons = [
  'apps/desktop/resources/icon.png',
  'apps/desktop/resources/icon-macos.png',
  'apps/desktop/resources/icon-windows.png',
  'apps/web/public/zhuma-icon.png',
];
for (const name of icons)
  run('sips', ['-s', 'format', 'png', '-z', '1024', '1024', image, '--out', join(stage, name)]);
// A native multi-resolution .icns is also used for Finder and Dock in the dev .app.
const iconset = join(root, '.build/desktop/Zhuma.iconset');
mkdirSync(iconset, { recursive: true });
for (const base of [16, 32, 128, 256, 512])
  for (const density of [1, 2]) {
    const pixels = base * density;
    const suffix = density === 2 ? '@2x' : '';
    run('sips', [
      '-s',
      'format',
      'png',
      '-z',
      String(pixels),
      String(pixels),
      image,
      '--out',
      join(iconset, `icon_${base}x${base}${suffix}.png`),
    ]);
  }
run('iconutil', [
  '-c',
  'icns',
  iconset,
  '-o',
  join(stage, 'apps/desktop/resources/icon-macos.icns'),
]);
// Different launcher name and separate user data avoid stealing an existing DSH installation.
writeFileSync(
  stampPath,
  `${JSON.stringify({ pinned, digest, source: 'official dsh + isolated Zhuma patch' }, null, 2)}\n`,
);
console.log(`Prepared Zhuma sources: ${stage}`);
