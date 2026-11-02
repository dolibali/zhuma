#!/usr/bin/env node
/** Prepare or explicitly refresh Zhuma's owned desktop worktree, leaving the pinned submodule intact. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256, verifyIconAssets, installIconAssets } from './icon-assets.mjs';
import { productSourceRecipeDigest } from './source-recipe.mjs';
import { assertReversiblePatchSeries, PRODUCT_SOURCE_PATCHES } from './patch-series.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const upstream = join(root, 'upstream/deepseek-harness');

/** Prepare an isolated public SDK source tree; no profile or model access. */
export function prepareProductSources({ kind = 'desktop', refresh = false } = {}) {
  if (!['desktop', 'server'].includes(kind)) throw new Error('Unsupported preparation kind');
  const stage = join(root, `.build/${kind}/deepseek-harness`);
  const patches = PRODUCT_SOURCE_PATCHES.map((name) => join(root, name));
  const memberTransport = join(root, 'packages/dsh-adapter/src/desktop-member-cookie.ts');
  const stagedMemberTransport = join(stage, 'apps/desktop/src/zhuma-member-cookie.ts');
  const sourceVerifier = join(root, 'scripts/desktop/verify-build-source-paths.ts');
  const stagedSourceVerifier = join(stage, 'scripts/zhuma-verify-build-source-paths.ts');
  const runtimeVerifier = join(root, 'scripts/desktop/verify-runtime-privacy.ts');
  const stagedRuntimeVerifier = join(stage, 'scripts/zhuma-verify-runtime-privacy.ts');
  const pinned = JSON.parse(readFileSync(join(root, 'runtime.lock.json'), 'utf8')).upstreams
    .deepseekHarness.commit;
  const stampPath = join(stage, '.zhuma-prepared.json');
  function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error || result.status !== 0)
      throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
  }
  function output(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
    return result.stdout.trim();
  }
  if (kind === 'desktop' && !['darwin', 'win32'].includes(process.platform))
    throw new Error(
      'Desktop preparation supports macOS and Windows; use server preparation for headless Linux',
    );
  if (output('git', ['rev-parse', 'HEAD'], upstream) !== pinned)
    throw new Error('Unexpected DSH source revision');
  const manifest = verifyIconAssets(root);
  const digest = productSourceRecipeDigest(root, kind);
  if (existsSync(stampPath)) {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    if (stamp.pinned !== pinned || output('git', ['rev-parse', 'HEAD'], stage) !== pinned)
      throw new Error('Prepared worktree revision differs');
    if (
      !existsSync(stagedMemberTransport) ||
      sha256(readFileSync(stagedMemberTransport)) !== sha256(readFileSync(memberTransport))
    )
      throw new Error(
        'Prepared member transport differs; inspect the owned build tree before resetting.',
      );
    if (
      !existsSync(stagedSourceVerifier) ||
      sha256(readFileSync(stagedSourceVerifier)) !== sha256(readFileSync(sourceVerifier))
    )
      throw new Error(
        'Prepared build source verifier differs; inspect the owned build tree before resetting.',
      );
    if (
      !existsSync(stagedRuntimeVerifier) ||
      sha256(readFileSync(stagedRuntimeVerifier)) !== sha256(readFileSync(runtimeVerifier))
    )
      throw new Error(
        'Prepared runtime verifier differs; inspect the owned build tree before resetting.',
      );
    if (stamp.digest === digest && !refresh) {
      assertReversiblePatchSeries(stage, patches);
      console.log(`Zhuma ${kind} already prepared: ${stage}`);
      return stage;
    }
    if (!refresh)
      throw new Error(
        'Recipe/assets changed: use --refresh-assets only if source patch matches; otherwise reset the owned worktree.',
      );
    // Do not overwrite arbitrary user edits. Refresh is restricted to generated image files.
    assertReversiblePatchSeries(stage, patches);
  } else {
    if (existsSync(stage)) throw new Error(`Unmanaged stage exists: ${stage}`);
    mkdirSync(resolve(stage, '..'), { recursive: true });
    run('git', ['-C', upstream, 'worktree', 'add', '--detach', stage, pinned]);
    for (const patch of patches) {
      run('git', ['-C', stage, 'apply', '--check', patch]);
      run('git', ['-C', stage, 'apply', patch]);
    }
    copyFileSync(memberTransport, stagedMemberTransport);
    copyFileSync(sourceVerifier, stagedSourceVerifier);
    copyFileSync(runtimeVerifier, stagedRuntimeVerifier);
    writeFileSync(
      join(stage, 'scripts/install-lefthook.mjs'),
      '// Zhuma isolated build: do not change hooks in the upstream repository.\n',
    );
  }
  installIconAssets(root, stage, { macOS: kind === 'desktop' && process.platform === 'darwin' });
  writeFileSync(
    stampPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        kind,
        pinned,
        digest,
        sourceIconSha256: manifest.source.sha256,
        source: 'pinned DSH + Zhuma patch + exact approved PNG',
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Prepared Zhuma ${kind} sources: ${stage}`);
  return stage;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { 'refresh-assets': { type: 'boolean', default: false } },
  });
  prepareProductSources({ refresh: values['refresh-assets'] });
}
