/** Read-only build checks; never decode, execute, delete or rewrite Python bytecode. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}

/** Enumerate regular runtime files, allowing only file links whose targets remain inside the payload. */
function runtimeFiles(root: string): string[] {
  const physicalRoot = realpathSync(root);
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const name = join(directory, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) paths.push(name);
      else if (entry.isSymbolicLink()) {
        const target = realpathSync(join(root, name));
        if (
          !inside(physicalRoot, target) ||
          !statSync(target).isFile() ||
          entry.name.endsWith('.pyc')
        )
          throw new Error('Runtime has an unsupported file link');
        paths.push(name);
      } else throw new Error('Runtime has an unsupported file type');
    }
  };
  visit('');
  return paths.sort();
}

/** Reject the actual logical/physical preparation root in any payload file, without printing it. */
export function verifyRuntimePrivacy(root: string): void {
  try {
    const roots = new Set([resolve(root), realpathSync(root)]);
    const patterns = [...roots].flatMap((path) =>
      [...new Set([path, path.replaceAll('\\', '/')])].flatMap((value) => [
        Buffer.from(value, 'utf8'),
        Buffer.from(value, 'utf16le'),
      ]),
    );
    for (const file of runtimeFiles(root)) {
      const bytes = readFileSync(join(root, file));
      if (patterns.some((pattern) => bytes.includes(pattern)))
        throw new Error('Runtime contains a private preparation path');
    }
  } catch {
    // Deliberately do not expose native filesystem errors, file contents or the private root.
    throw new Error('Runtime privacy validation failed');
  }
}

/** Snapshot only recognized, source-backed caches; preserve the verified archive's original bytes. */
export function pythonBytecodeSnapshot(
  root: string,
  pythonVersion: string,
): ReadonlyMap<string, string> {
  try {
    if (!/^\d+\.\d+\.\d+$/u.test(pythonVersion)) throw new Error('Unknown Python version');
    const tag = pythonVersion.split('.').slice(0, 2).join('');
    if (tag !== '312') throw new Error('Unknown pinned Python cache version');
    const pythonRoot = join(root, 'dependencies/python');
    const caches = new Map<string, string>();
    for (const file of runtimeFiles(pythonRoot)) {
      if (!file.endsWith('.pyc')) continue;
      const parts = file.split(sep);
      const name = parts.at(-1)!;
      const match = /^(.+)\.cpython-(\d+)(?:\.opt-[012])?\.pyc$/u.exec(name);
      if (!match || match[2] !== tag || parts.at(-2) !== '__pycache__')
        throw new Error('Unknown Python cache format');
      const source = join(pythonRoot, dirname(dirname(file)), `${match[1]}.py`);
      if (!lstatSync(source).isFile()) throw new Error('Sourceless Python cache');
      const bytes = readFileSync(join(pythonRoot, file));
      if (
        bytes.length < 16 ||
        !bytes.subarray(0, 4).equals(Buffer.from([0xcb, 0x0d, 0x0d, 0x0a])) ||
        ![0, 1, 3].includes(bytes.readUInt32LE(4))
      )
        throw new Error('Unknown pinned Python cache header');
      caches.set(file, createHash('sha256').update(bytes).digest('hex'));
    }
    return caches;
  } catch {
    throw new Error('Python bytecode validation failed');
  }
}

/** A build smoke must not add caches or modify any cache copied from the verified archives. */
export function assertPythonBytecodeUnchanged(
  root: string,
  pythonVersion: string,
  before: ReadonlyMap<string, string>,
): void {
  const after = pythonBytecodeSnapshot(root, pythonVersion);
  if (after.size !== before.size || [...before].some(([path, hash]) => after.get(path) !== hash))
    throw new Error('Build smoke changed Python bytecode');
}
