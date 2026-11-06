import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const arguments_ = process.argv.slice(2);
if (arguments_.length && (arguments_.length !== 2 || arguments_[0] !== '--destination'))
  throw new Error('Usage: node tools/create-workspace.mjs [--destination /new/path]');
const source = fileURLToPath(new URL('../', import.meta.url));
let destination;
if (arguments_.length) {
  destination = resolve(arguments_[1]);
  try {
    await lstat(destination);
    throw new Error('Destination already exists; no files were changed.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(destination, { recursive: false });
} else {
  destination = await mkdtemp(join(tmpdir(), 'zhuma-engineering-demo-'));
}
const entries = [
  'package.json',
  'server.mjs',
  'src',
  'public',
  'tests',
  'fixtures',
  'tools/check-syntax.mjs',
  'task.md',
  'README.md',
  'LICENSE.txt',
];
for (const entry of entries) {
  const target = join(destination, entry);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(source, entry), target, { recursive: true, errorOnExist: true, force: false });
}
const verifier = join(source, 'acceptance/check.mjs');
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  source,
  destination,
  verifier: {
    path: verifier,
    sha256: createHash('sha256')
      .update(await readFile(verifier))
      .digest('hex'),
  },
  writableScope: ['src/**', 'server.mjs', 'public/**', 'tests/**'],
  baselineTestCommand: ['node', '--test', 'tests/*.test.mjs'],
  acceptanceCommand: [process.execPath, verifier, '--project', destination],
  boundary:
    'Copies only the synthetic project; no credentials, profiles, product state, verifier, Git repository or runtime service. Scope is an instruction, not an OS sandbox.',
};
await writeFile(
  join(destination, 'workspace-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(manifest, null, 2));
