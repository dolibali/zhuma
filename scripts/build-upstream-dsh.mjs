import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 上游锁要求 pnpm 11.28.5。仓库本身仍用自己的 pnpm。
// 安装必须带 CI=true，否则上游 postinstall 会失败。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, 'upstream/deepseek-harness');

function run(args) {
  const result = spawnSync('corepack', args, {
    cwd: upstream,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(path.join(upstream, 'node_modules'))) {
  run(['pnpm@11.28.5', 'install']);
}
run(['pnpm@11.28.5', 'run', 'build']);
