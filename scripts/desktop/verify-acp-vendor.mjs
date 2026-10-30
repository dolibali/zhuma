#!/usr/bin/env node
/** Verify frozen source and actual pnpm-patched package bytes; never run a CLI/model. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    sdk: { type: 'string' },
    rebuild: { type: 'boolean', default: false },
  },
});
if (!values.source || !values.sdk) throw Error('Pass --source and --sdk for owned fixed checkouts');
const root = fileURLToPath(new URL('../..', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'runtime.lock.json'), 'utf8'));
const pin = lock.plugins.acpAdapter;
const handoff = pin.nativeToolHandoff;
const source = resolve(values.source),
  sdk = resolve(values.sdk);
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

assert.equal(git(source, 'rev-parse', 'HEAD'), pin.commit);
assert.equal(git(source, 'write-tree'), handoff.sourceTree, 'Stage both exact source patches');
assert.equal(git(source, 'diff', '--name-only'), '', 'Source has unstaged changes');
assert.equal(git(sdk, 'rev-parse', 'HEAD'), lock.upstreams.deepseekHarness.commit);
for (const patch of Object.values(handoff.patches)) {
  assert.match(patch.path, /^patches\/dsh-acp-adapter\/[a-z-]+\.patch$/);
  assert.equal(sha(join(root, patch.path)), patch.sha256);
}
execFileSync(
  'git',
  ['apply', '--reverse', '--check', join(root, 'patches/deepseek-harness/zhuma-desktop.patch')],
  { cwd: sdk },
);
assert.equal(
  sha(join(sdk, 'patches/zhuma-dsh-acp-adapter.patch')),
  handoff.patches['published-package.patch'].sha256,
);
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
assert.equal(manifest.name, pin.package);
assert.equal(manifest.version, pin.version);
assert.equal(manifest.packageManager, handoff.sourcePackageManager);
if (values.rebuild)
  execFileSync('corepack', ['pnpm', 'run', 'build'], { cwd: source, stdio: 'inherit' });

const request = createRequire(join(sdk, 'packages/bundle/web-app/package.json'));
const installed = dirname(request.resolve(pin.package + '/package.json'));
const packageManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
assert.equal(packageManifest.version, pin.version);
assert.equal(packageManifest.license, 'MIT');
assert.equal(sha(join(source, 'LICENSE')), sha(join(installed, 'LICENSE')));
const peer = createRequire(join(installed, 'package.json'));
for (const name of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
])
  assert.equal(
    realpathSync(request.resolve(name + '/package.json')),
    realpathSync(peer.resolve(name + '/package.json')),
  );
const files = JSON.parse(
  readFileSync(join(root, 'patches/dsh-acp-adapter/compiled-files.json'), 'utf8'),
);
assert.equal(Object.keys(files).length, 9);
for (const [file, hash] of Object.entries(files)) {
  assert.match(
    file,
    /^lib\/(?:types\/)?host\/(?:composition\/(?:index|installed-profile-registry|profile-adapter|stream-handoff)|tools\/bridge)\.(?:js|d\.ts)$/,
  );
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(sha(join(source, file)), hash, 'Rebuilt file: ' + file);
  assert.equal(sha(join(installed, file)), hash, 'Installed file: ' + file);
}
const report = {
  scope: 'frozen-acp-source-to-pnpm-package-byte-contract',
  sourceCommit: git(root, 'rev-parse', 'HEAD'),
  sourceClean: !git(root, 'status', '--porcelain'),
  pluginSource: pin.commit,
  pluginPatchedTree: handoff.sourceTree,
  communityPatchTree: handoff.communityPatchTree,
  packagePatchSha256: handoff.patches['published-package.patch'].sha256,
  compiledFiles: files,
  rebuilt: values.rebuild,
  observedNode: process.versions.node,
  licensePreserved: true,
  sharedHostPeers: true,
  limits: [
    'Build and exact installed-byte checks, not execution or business acceptance',
    'No real CLI, authentication, model, native tool isolation, GUI or installer qualification',
  ],
};
mkdirSync(join(root, '.artifacts/desktop'), { recursive: true });
writeFileSync(
  join(root, '.artifacts/desktop/acp-vendor-proof.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
