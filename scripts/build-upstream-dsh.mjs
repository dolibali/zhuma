import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, 'upstream/deepseek-harness');
const result = spawnSync('pnpm', ['run', 'build'], {
  cwd: upstream,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
