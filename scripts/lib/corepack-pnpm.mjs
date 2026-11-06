/** Invoke the pinned SDK package manager without a Windows command shell. */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';

const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
};
function corepackOnPath() {
  const found = spawnSync('where.exe', ['corepack'], { encoding: 'utf8', windowsHide: true });
  if (found.error || found.status !== 0) return [];
  return found.stdout
    .split(/\r?\n/u)
    .map((file) => file.trim())
    .filter(Boolean);
}
export function corepackPnpmInvocation(
  args,
  {
    platform = process.platform,
    execPath = process.execPath,
    exists = isFile,
    onPath = corepackOnPath,
  } = {},
) {
  if (platform !== 'win32') return ['corepack', ['pnpm', ...args]];
  const paths = platform === process.platform ? { dirname, join } : win32;
  // npm's global Windows shim and Node's bundled Corepack share this layout.
  // Resolve their JS entry; never execute or parse a .cmd/.ps1 wrapper.
  const bases = [paths.dirname(execPath), ...onPath().map((file) => paths.dirname(file))];
  for (const base of [...new Set(bases)]) {
    const entry = paths.join(base, 'node_modules', 'corepack', 'dist', 'corepack.js');
    if (exists(entry)) return [execPath, [entry, 'pnpm', ...args]];
  }
  throw new Error('Install Corepack with its JavaScript entrypoint before building on Windows.');
}
