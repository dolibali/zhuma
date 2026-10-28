#!/usr/bin/env node
/** Stage ONLY this product plugin into an operator-selected, already compiled
 * official Desktop SDK. Does not launch, inspect or copy profiles/credentials. */
import { execFileSync } from 'node:child_process';
import { access, readFile, mkdir, copyFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: { stage: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
if (!values.stage) throw Error('Pass --stage with an owned existing official Desktop SDK');
const stage = resolve(values.stage);
if (stage === join(root, '.build/desktop/deepseek-harness'))
  throw Error('The frozen two-Host CLI SDK must not be replaced');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
if (git(root, 'status', '--porcelain'))
  throw Error('Freeze and commit the product source before staging a candidate');
const pin = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8')).upstreams
  .deepseekHarness.commit;
if (git(stage, 'rev-parse', 'HEAD') !== pin) throw Error('Unexpected official SDK revision');
for (const file of [
  '.zhuma-prepared.json',
  'apps/desktop/lib/main.js',
  'apps/desktop-host/lib/index.js',
  'apps/desktop/scripts/dev.ts',
  'apps/desktop/.desktop-build/targets/mac-arm64/runtime/primary-runtime/runtime.json',
])
  await access(join(stage, file));
const target = join(stage, 'packages/bundle/web-app/lib/zhuma-workbench');
if (!(await realpath(target)).startsWith((await realpath(stage)) + '/'))
  throw Error('Plugin output must be an owned directory within this SDK');
const source = join(root, '.build/workbench'),
  files = [
    'index.js',
    'client.js',
    'member-web.js',
    'package.json',
    'LICENSE',
    'THIRD_PARTY_LICENSES.txt',
  ];
const current = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
const next = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (current.name !== '@zhuma/workbench' || next.name !== current.name)
  throw Error('Unexpected product plugin identity');
if (JSON.stringify(current.peerDependencies) !== JSON.stringify(next.peerDependencies))
  throw Error('Official SDK peer graph differs; resolve explicitly before staging');
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const previous = {},
  candidate = {};
for (const file of files) {
  previous[file] = await hash(join(target, file));
  candidate[file] = await hash(join(source, file));
}
const backupId = createHash('sha256').update(JSON.stringify(previous)).digest('hex');
const backup = join(root, '.build/desktop-plugin-backups', backupId);
if (!values['dry-run']) {
  await mkdir(backup, { recursive: true });
  for (const file of files) {
    try {
      await access(join(backup, file));
      if ((await hash(join(backup, file))) !== previous[file])
        throw Error('Backup identity differs');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await copyFile(join(target, file), join(backup, file));
    }
  }
  for (const file of files) await copyFile(join(source, file), join(target, file));
  for (const file of files)
    if ((await hash(join(target, file))) !== candidate[file])
      throw Error('Staged product bytes differ');
}
const report = {
  scope: 'official-existing-desktop-product-plugin-only',
  dryRun: values['dry-run'],
  sourceCommit: git(root, 'rev-parse', 'HEAD'),
  sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
  sdkPin: pin,
  target,
  backup,
  hashes: candidate,
  launcher: join(stage, 'apps/desktop/scripts/dev.ts'),
  profileAccessed: false,
  launched: false,
  limits: [
    'Only Host/Client product plugin updated; no new SDK Gateway/navigation patch is certified',
    'No desktop GUI, model, task execution or installation acceptance',
  ],
};
if (!values['dry-run'])
  await writeFile(join(target, 'ZHUMA-CANDIDATE.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
