import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fromRoot, ROOT } from './paths.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** Check local content only; never downloads or changes the submodule. */
export function checkUpstream() {
  const lock = JSON.parse(readFileSync(fromRoot('runtime.lock.json'), 'utf8'));
  const pin = lock.upstreams.deepseekHarness;
  if (pin.path !== 'upstream/deepseek-harness' || !/^[0-9a-f]{40}$/.test(pin.commit)) {
    throw new Error('Invalid upstream pin in runtime.lock.json.');
  }
  const directory = fromRoot(pin.path);
  if (!existsSync(fromRoot(pin.path, '.git'))) {
    throw new Error('DSH submodule is missing. Run pnpm upstream:init.');
  }
  const head = git(directory, 'rev-parse', 'HEAD');
  if (head !== pin.commit)
    throw new Error(`DSH checkout mismatch: expected ${pin.commit}, got ${head}`);
  const url = git(
    ROOT,
    'config',
    '-f',
    '.gitmodules',
    '--get',
    'submodule.upstream/deepseek-harness.url',
  );
  if (url !== pin.repository) throw new Error('Submodule URL does not match runtime.lock.json.');
  const index = git(ROOT, 'ls-files', '--stage', '--', pin.path);
  const [mode, object] = index.split(/\s+/);
  if (mode !== '160000' || object !== pin.commit) {
    throw new Error('Git index submodule pointer does not match runtime.lock.json.');
  }
  const dirty = git(directory, 'status', '--porcelain', '--untracked-files=no');
  if (dirty)
    throw new Error('DSH tracked files were modified. Keep changes in patches or a reviewed fork.');
  const manifest = JSON.parse(readFileSync(fromRoot(pin.path, 'package.json'), 'utf8'));
  const desktop = JSON.parse(readFileSync(fromRoot(pin.path, 'apps/desktop/package.json'), 'utf8'));
  if (manifest.version !== pin.version || desktop.version !== pin.version) {
    throw new Error('Upstream Desktop and runtime package versions do not match the pin.');
  }
  if (manifest.packageManager !== pin.packageManager) {
    throw new Error('Upstream package manager does not match the pin.');
  }
  return pin;
}
