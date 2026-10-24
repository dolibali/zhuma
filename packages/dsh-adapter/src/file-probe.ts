import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type FileProbeResult =
  | { readonly ok: true; readonly exists: boolean; readonly readable: boolean }
  | { readonly ok: false; readonly code: 'path-rejected' };

/** 只接受工作区内的相对路径。符号链接解析后仍必须留在工作区内。结果不返回绝对路径。 */
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
  let rootReal: string;
  try {
    rootReal = realpathSync(rootResolved);
  } catch {
    return { ok: false, code: 'path-rejected' };
  }
  try {
    const listed = lstatSync(target);
    if (!listed.isFile() && !listed.isSymbolicLink()) {
      return { ok: true, exists: false, readable: false };
    }
  } catch (error) {
    return missingOrUnreadable(error);
  }
  let resolved: string;
  try {
    resolved = realpathSync(target);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { ok: true, exists: false, readable: false };
    return { ok: false, code: 'path-rejected' };
  }
  const relativeResolved = path.relative(rootReal, resolved);
  if (relativeResolved.startsWith('..') || path.isAbsolute(relativeResolved)) {
    return { ok: false, code: 'path-rejected' };
  }
  try {
    if (!statSync(resolved).isFile()) return { ok: true, exists: false, readable: false };
    accessSync(resolved, constants.R_OK);
    return { ok: true, exists: true, readable: true };
  } catch (error) {
    return missingOrUnreadable(error);
  }
}

/** 读工作区内的文本文件。二进制或越界路径不返回正文，也不返回绝对路径。 */
export function readRelativeFile(
  root: string,
  relativePath: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false } {
  const probed = probeRelativeFile(root, relativePath);
  if (!probed.ok || !probed.exists || !probed.readable) return { ok: false };
  const resolved = resolveInside(root, relativePath);
  if (resolved === null) return { ok: false };
  try {
    const bytes = readFileSync(resolved);
    if (bytes.includes(0)) return { ok: false };
    return { ok: true, text: bytes.toString('utf8') };
  } catch {
    return { ok: false };
  }
}

function resolveInside(root: string, relativePath: string): string | null {
  if (
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    return null;
  }
  const segments = relativePath.split(/[\\/]+/);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '..')
  ) {
    return null;
  }
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relativePath);
  const relative = path.relative(rootResolved, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const rootReal = realpathSync(rootResolved);
    const resolved = realpathSync(target);
    const relativeResolved = path.relative(rootReal, resolved);
    if (relativeResolved.startsWith('..') || path.isAbsolute(relativeResolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function missingOrUnreadable(error: unknown): FileProbeResult {
  if (errorCode(error) === 'ENOENT') return { ok: true, exists: false, readable: false };
  return { ok: true, exists: true, readable: false };
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}
