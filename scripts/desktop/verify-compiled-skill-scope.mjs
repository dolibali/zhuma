#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: 'string' } } });
const upstream = resolve(values.upstream ?? join(root, 'upstream/deepseek-harness'));
const lock = JSON.parse(readFileSync(join(root, 'runtime.lock.json'), 'utf8'));
const pin = lock.upstreams.deepseekHarness.commit;
const evidence = mkdtempSync(join(tmpdir(), 'zhuma-compiled-skill-scope-'));
const stage = join(evidence, 'upstream');
const patch = join(root, 'patches/deepseek-harness/zhuma-desktop.patch');
const fixture = join(root, 'tests/fixtures/skill-loader/compiled-scope.mjs');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const env = { ...process.env };
delete env.NODE_OPTIONS;
function command(label, bin, args, cwd = stage) {
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(join(evidence, `${label}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error || result.status !== 0)
    throw new Error(`${label} failed; evidence: ${evidence}`, { cause: result.error });
  return result.stdout.trim();
}
assert.equal(command('pin', 'git', ['rev-parse', 'HEAD'], upstream), pin);
// Use the SDK's already installed, exact toolchain. Installation is offline and
// script-free, in this owned checkout, with normal workspace package links.
const pnpm = join(upstream, 'node_modules/pnpm/bin/pnpm.cjs');
assert.equal(
  `pnpm@${command('pnpm-version', process.execPath, [pnpm, '--version'], upstream)}`,
  lock.upstreams.deepseekHarness.packageManager,
);
command('stage', 'git', ['worktree', 'add', '--detach', stage, pin], upstream);
try {
  command('apply-check', 'git', ['apply', '--check', patch]);
  command('apply', 'git', ['apply', patch]);
  const sdkLock = join(stage, 'pnpm-lock.yaml');
  const lockBeforeInstall = hash(sdkLock);
  command('frozen-install', process.execPath, [
    pnpm,
    'install',
    '--offline',
    '--frozen-lockfile',
    '--ignore-scripts',
  ]);
  assert.equal(hash(sdkLock), lockBeforeInstall);
  command('sdk-types', process.execPath, [
    join(stage, 'node_modules/typescript/bin/tsc'),
    '-b',
    'packages/typert/generator',
    'packages/core/agent-loop',
    'packages/skill/tool-skill',
    '--pretty',
    'false',
  ]);
  // Bundle only the ordinary runtime closure emitted by these original project
  // references. Keep the SDK tsdown config, peer resolution and Typert plugin.
  const packages = [];
  for (const group of [
    'vendor',
    ...readdirSync(join(stage, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}`),
  ]) {
    for (const entry of readdirSync(join(stage, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(stage, group, entry.name);
      if (
        existsSync(join(directory, 'package.json')) &&
        existsSync(join(directory, 'lib/types/index.js'))
      )
        packages.push(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name);
    }
  }
  assert.ok(packages.includes('@deepseek-ai/dsh-agent-loop'));
  assert.ok(packages.includes('@deepseek-ai/dsh-scope'));
  writeFileSync(
    join(stage, '.zhuma-compiled-build.mjs'),
    `
import { build } from 'tsdown';
await build({configLoader:'native',env:{DSH_BUILD_FACE:'host'},filter:process.argv.length>2?process.argv.slice(2):${JSON.stringify(packages)}});
`,
  );
  const builder = join(stage, '.zhuma-compiled-build.mjs');
  command('sdk-build', process.execPath, [builder]);
  copyFileSync(fixture, join(stage, '.zhuma-compiled-skill-probe.mjs'));
  const probe = join(stage, '.zhuma-compiled-skill-probe.mjs');
  const manifestPath = join(stage, 'packages/skill/tool-skill/package.json');
  const fixedManifest = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(fixedManifest);
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-scope'], 'workspace:*');
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-scope'], 'workspace:*');
  const runtimePath = join(stage, 'packages/skill/tool-skill/lib/index.js');
  let before;
  let beforeArtifactSha256;
  try {
    // Falsify exactly the repair: all SDK production source, dependencies and
    // compiler options remain unchanged. A fresh Node process avoids caches.
    delete manifest.peerDependencies['@deepseek-ai/dsh-scope'];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    command('before-build', process.execPath, [builder, '@deepseek-ai/dsh-tool-skill']);
    beforeArtifactSha256 = hash(runtimePath);
    before = JSON.parse(command('before-runtime', process.execPath, [probe, 'before']));
    assert.equal(before.rejectedBeforeModel, true);
    assert.equal(before.modelCalls, 0);
  } finally {
    writeFileSync(manifestPath, fixedManifest);
  }
  command('fixed-build', process.execPath, [builder, '@deepseek-ai/dsh-tool-skill']);
  const after = JSON.parse(command('fixed-runtime', process.execPath, [probe]));
  assert.equal(after.originalFactoryAndScope, true);
  assert.equal(after.wrongContextsRejected, 3);
  assert.equal(after.invalidRegistryRejected, true);
  assert.equal(after.retiredScopeRejected, true);
  assert.equal(after.modelCalls, 1);
  const fixedArtifactSha256 = hash(runtimePath);
  assert.notEqual(beforeArtifactSha256, fixedArtifactSha256);
  writeFileSync(
    join(evidence, 'proof.json'),
    `${JSON.stringify(
      {
        upstreamCommit: pin,
        sourceCommit: command('source-commit', 'git', ['rev-parse', 'HEAD'], root),
        sourceClean: command('source-status', 'git', ['status', '--porcelain'], root) === '',
        patchSha256: hash(patch),
        fixtureSha256: hash(fixture),
        verifierSha256: hash(fileURLToPath(import.meta.url)),
        frozenInstall: true,
        lockUnchanged: true,
        sdkTypecheck: true,
        officialRuntimePackages: packages,
        beforeArtifactSha256,
        fixedArtifactSha256,
        before,
        after,
        boundary:
          'ordinary compiled SDK package graph and original factory; local scripted model only; no Host resources, GUI, credentials or installer',
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Compiled Skill scope regression passed; evidence: ${evidence}/proof.json`);
} finally {
  command('remove-stage', 'git', ['worktree', 'remove', '--force', stage], upstream);
}
