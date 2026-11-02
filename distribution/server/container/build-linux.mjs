#!/usr/bin/env node
/** Build public sources inside a disposable Linux amd64 builder, without host profiles. */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
  },
});
if (!values.source || !/^[0-9a-f]{40}$/u.test(values.source))
  throw new Error('Pass --source with a full reviewed product commit');
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Build requires Linux amd64; host native artifacts are not supported');

function run(command, args, cwd = '/workspace') {
  console.log(`Build phase: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build phase failed with ${result.status}`);
}

// The builder's /workspace is an owned empty Docker volume, never the user's checkout.
run('git', ['clone', '--no-checkout', 'https://github.com/dolibali/zhuma.git', 'source']);
const root = '/workspace/source';
run('git', ['fetch', '--depth=1', 'origin', values.source], root);
run('git', ['checkout', '--detach', values.source], root);
run('git', ['submodule', 'update', '--init', '--depth=1', 'upstream/deepseek-harness'], root);
run(process.execPath, ['scripts/server/prepare.mjs'], root);
const sdk = `${root}/.build/server/deepseek-harness`;
run('corepack', ['pnpm', 'install', '--frozen-lockfile'], sdk);
run('corepack', ['pnpm', 'run', 'build:native-system'], sdk);
run('corepack', ['pnpm', 'run', 'build:lib'], sdk);
run('corepack', ['pnpm', 'run', 'build:web'], sdk);
run('corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], root);
run('corepack', ['pnpm', 'workbench:build'], root);
console.log('Linux source build finished; portable packaging and runtime proof remain separate.');
