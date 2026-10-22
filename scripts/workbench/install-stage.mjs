import { cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../..', import.meta.url));
const stage = resolve(root, '.build/desktop/deepseek-harness');
const lock = JSON.parse(await readFile(resolve(root, 'runtime.lock.json'), 'utf8'));
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: stage, encoding: 'utf8' }).trim();
if (actual !== lock.upstreams.deepseekHarness.commit)
  throw new Error('Unexpected desktop stage revision.');
const bundle = resolve(stage, 'packages/bundle/web-app');
const sourcePatch = execFileSync('git', ['show', 'HEAD:packages/bundle/web-app/cordis.patch.yml'], {
  cwd: stage,
  encoding: 'utf8',
});
const marker = '\n# Zhuma workbench generated composition\n';
const current = await readFile(resolve(bundle, 'cordis.patch.yml'), 'utf8');
if (current.split(marker)[0] !== sourcePatch)
  throw new Error('The Web bundle has unrelated changes; refusing to overwrite.');
const overlay = await readFile(resolve(root, 'distribution/workbench/cordis.patch.yml'), 'utf8');
await cp(resolve(root, '.build/workbench'), resolve(bundle, 'lib/zhuma-workbench'), {
  recursive: true,
});
await writeFile(resolve(bundle, 'cordis.patch.yml'), sourcePatch + marker + overlay);
const manifestPath = resolve(bundle, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!manifest.files.includes('lib/zhuma-workbench')) manifest.files.push('lib/zhuma-workbench');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Installed workbench into the isolated official DSH Web/Desktop bundle.');
