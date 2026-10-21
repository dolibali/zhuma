import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fromRoot, PACKAGE_DIRECTORIES, ROOT } from './lib/paths.mjs';

const tests = PACKAGE_DIRECTORIES.flatMap((name) => {
  const directory = fromRoot('packages', name, 'tests');
  return readdirSync(directory)
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
    .map((file) => fromRoot('packages', name, 'tests', file));
});
if (tests.length === 0) throw new Error('No tests discovered; refusing to report success.');
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: ROOT, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
