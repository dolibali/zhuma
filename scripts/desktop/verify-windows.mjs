#!/usr/bin/env node
/** Freeze an unsigned Windows candidate; this does not install, run or publish it. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertProductSourceRecipe } from './source-recipe.mjs';
import { candidateFileRecord, verifyWindowsCandidateFiles } from '../lib/windows-candidate.mjs';

const { values } = parseArgs({ options: { 'source-sha': { type: 'string' } } });
assert.equal(process.platform, 'win32', 'Verify a Windows candidate on Windows.');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, '24.15.0');
assert.match(values['source-sha'] ?? '', /^[a-f0-9]{40}$/u, 'Pass the full accepted source SHA.');
const root = fileURLToPath(new URL('../..', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const source = git(root, 'rev-parse', 'HEAD'),
  tree = git(root, 'rev-parse', 'HEAD^{tree}');
assert.equal(source, values['source-sha']);
assert.equal(git(root, 'status', '--porcelain'), '', 'Candidate product source is dirty.');
const stage = join(root, '.build/desktop/deepseek-harness');
const lock = json(join(root, 'runtime.lock.json')),
  sdk = lock.upstreams.deepseekHarness;
assert.equal(git(root, 'rev-parse', 'HEAD:upstream/deepseek-harness'), sdk.commit);
assert.equal(git(stage, 'rev-parse', 'HEAD'), sdk.commit);
const stamp = json(join(stage, '.zhuma-prepared.json'));
assert.equal(stamp.pinned, sdk.commit);
assertProductSourceRecipe(root, stamp, 'desktop');
const request = createRequire(join(stage, 'apps/desktop/package.json'));
const asar = createRequire(request.resolve('app-builder-lib/package.json'))('@electron/asar');
const buildVersion = json(join(root, 'branding/default/brand.json')).desktopBuildVersion;
const product = json(join(root, 'package.json'));
const artifacts = join(stage, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts');
const material = verifyWindowsCandidateFiles({
  artifacts,
  workbench: join(root, '.build/workbench'),
  buildVersion,
  productVersion: product.version,
  source,
  sdkPin: sdk.commit,
  sdkVersion: sdk.version,
  asar,
});
const filename = `zhuma-${buildVersion}-win-x64-unsigned.exe`;
const output = join(root, 'dist/windows-x64');
assert.deepEqual(candidateFileRecord(join(output, filename)), material.installer);
assert(
  !existsSync(join(output, 'SOURCE.json')),
  'Candidate record already exists; preserve it before a new build.',
);
mkdirSync(output, { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
  copyFileSync(join(root, file), join(output, file));
const manifest = {
  schemaVersion: 1,
  scope: 'unsigned-windows-candidate',
  sourceCommit: source,
  sourceTree: tree,
  version: product.version,
  buildVersion,
  sdkPin: sdk.commit,
  sdkVersion: sdk.version,
  recipeDigest: stamp.digest,
  target: { platform: 'win32', arch: 'x64', buildMode: 'unsigned' },
  toolchain: { node: process.version, pnpm: product.packageManager, sdkPnpm: sdk.packageManager },
  locks: {
    workspace: candidateFileRecord(join(root, 'pnpm-lock.yaml')).sha256,
    sdk: candidateFileRecord(join(stage, 'pnpm-lock.yaml')).sha256,
  },
  material,
  limits: [
    'Build and bytes only; installation, GUI, model, credentials and business acceptance are not certified.',
  ],
};
assert.equal(git(root, 'rev-parse', 'HEAD'), source, 'Candidate product source moved.');
assert.equal(git(root, 'status', '--porcelain'), '', 'Candidate product source changed.');
writeFileSync(join(output, 'SOURCE.json'), JSON.stringify(manifest, null, 2) + '\n', {
  flag: 'wx',
});
writeFileSync(
  join(output, 'SHA256SUMS'),
  [filename, 'SOURCE.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']
    .map((file) => `${candidateFileRecord(join(output, file)).sha256}  ${file}\n`)
    .join(''),
  { flag: 'wx' },
);
console.log(
  'Windows candidate bytes and source verified; no installation, GUI or publication performed.',
);
