import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fromRoot } from './lib/paths.mjs';
import { checkUpstream } from './lib/upstream.mjs';

const lock = JSON.parse(readFileSync(fromRoot('runtime.lock.json'), 'utf8'));
const failures = [];
console.log('Zhuma — scaffold environment');
console.log(`Node: ${process.versions.node} (pinned ${lock.toolchain.node})`);
if (process.versions.node !== lock.toolchain.node)
  failures.push('Use the Node version in .node-version.');
const pnpmVersion = /(?:^|\s)pnpm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? '')?.[1];
console.log(`pnpm: ${pnpmVersion ?? 'not detected'} (pinned ${lock.toolchain.pnpm})`);
if (pnpmVersion !== lock.toolchain.pnpm)
  failures.push('Run this command with the pinned pnpm: pnpm run doctor.');
try {
  console.log(execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim());
  const pin = checkUpstream();
  console.log(`DSH: ${pin.ref}, source and gitlink match`);
  console.log(`DSH package manager: ${pin.packageManager} (separate from this workspace)`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}
console.log('Desktop integration: not tested; product packaging: not implemented.');
console.log(
  'No models, cloud accounts, global configuration or installed applications were accessed.',
);
for (const failure of failures) console.error(`ERROR: ${failure}`);
if (failures.length) process.exitCode = 1;
