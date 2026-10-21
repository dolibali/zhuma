#!/usr/bin/env node
/** Explicitly remove only the disposable worktree owned by Zhuma's desktop build. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const upstream = `${root}/upstream/deepseek-harness`;
const stage = `${root}/.build/desktop/deepseek-harness`;
const result = spawnSync('git', ['-C', upstream, 'worktree', 'remove', '--force', stage], {
  stdio: 'inherit',
});
if (result.status !== 0) process.exitCode = result.status ?? 1;
