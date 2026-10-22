import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export type FileProbeResult =
  | { readonly ok: true; readonly exists: boolean; readonly readable: boolean }
  | { readonly ok: false; readonly code: 'path-rejected' };

/** 只接受工作区内的相对路径。结果不返回绝对路径。 */
export function probeRelativeFile(root: string, relativePath: string): FileProbeResult {
  if (
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    return { ok: false, code: 'path-rejected' };
  }
  const segments = relativePath.split(/[\\/]+/);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '..')
  ) {
    return { ok: false, code: 'path-rejected' };
  }
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relativePath);
  const relative = path.relative(rootResolved, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, code: 'path-rejected' };
  }
  try {
    const stat = statSync(target);
    if (!stat.isFile()) return { ok: true, exists: false, readable: false };
    accessSync(target, constants.R_OK);
    return { ok: true, exists: true, readable: true };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return { ok: true, exists: false, readable: false };
    return { ok: true, exists: true, readable: false };
  }
}
