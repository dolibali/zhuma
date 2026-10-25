#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { upstream: { type: 'string' } } });
const upstream = resolve(values.upstream ?? join(root, 'upstream/deepseek-harness'));
const pin = JSON.parse(readFileSync(join(root, 'runtime.lock.json'), 'utf8')).upstreams
  .deepseekHarness.commit;
const patch = join(root, 'patches/deepseek-harness/zhuma-desktop.patch');
const fixtures = join(root, 'tests/fixtures/native-lifecycle');
const evidence = mkdtempSync(join(tmpdir(), 'zhuma-native-lifecycle-proof-'));
const stage = join(evidence, 'upstream');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function command(bin, args, cwd, env = process.env) {
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${bin} failed (${result.status}):\n${(result.stdout + result.stderr).slice(-6000)}`,
    );
  return result.stdout.trim();
}
if (command('git', ['rev-parse', 'HEAD'], upstream) !== pin)
  throw new Error('Upstream must match the locked commit.');
const vitest = join(upstream, 'node_modules/vitest/vitest.mjs');
if (!existsSync(vitest))
  throw new Error(
    'Install the fixed upstream test toolchain first; no automatic installation is performed.',
  );
command('git', ['worktree', 'add', '--detach', stage, pin], upstream);
// All mutations stay in this verifier-owned temporary checkout. Never modify the fixed input.
command('git', ['apply', '--check', patch], stage);
command('git', ['apply', patch], stage);
symlinkSync(join(upstream, 'node_modules'), join(stage, 'node_modules'), 'dir');
for (const group of readdirSync(join(upstream, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of readdirSync(join(upstream, 'packages', group.name), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const relative = join('packages', group.name, pkg.name);
    if (existsSync(join(upstream, relative, 'node_modules')) && existsSync(join(stage, relative)))
      symlinkSync(
        join(upstream, relative, 'node_modules'),
        join(stage, relative, 'node_modules'),
        'dir',
      );
  }
}
// The JSONL backend uses the fixed upstream's actual platform flock binding.
// It belongs to a native workspace package rather than packages/*/*.
for (const group of readdirSync(join(upstream, 'native'), { withFileTypes: true })) {
  const nativePackages = join(upstream, 'native', group.name, 'packages');
  if (!group.isDirectory() || !existsSync(nativePackages)) continue;
  for (const pkg of readdirSync(nativePackages, { withFileTypes: true })) {
    const relative = join('native', group.name, 'packages', pkg.name);
    if (pkg.isDirectory() && existsSync(join(upstream, relative, 'node_modules')))
      symlinkSync(
        join(upstream, relative, 'node_modules'),
        join(stage, relative, 'node_modules'),
        'dir',
      );
  }
}
for (const pkg of readdirSync(join(upstream, 'vendor'), { withFileTypes: true })) {
  const relative = join('vendor', pkg.name);
  if (pkg.isDirectory() && existsSync(join(upstream, relative, 'node_modules')))
    symlinkSync(
      join(upstream, relative, 'node_modules'),
      join(stage, relative, 'node_modules'),
      'dir',
    );
}
writeFileSync(
  join(stage, '.zhuma-native-lifecycle.config.ts'),
  `
import config from './vitest.config.ts'
export default { ...config, cacheDir: './.zhuma-test-cache/root', test: {
  ...config.test, projects: config.test.projects.map((project) => ({
    ...project, cacheDir: './.zhuma-test-cache/' + project.test.name,
  })),
} }
`,
);
for (const name of ['retained-inbox', 'cross-process'])
  copyFileSync(
    join(fixtures, `${name}.spec.ts`),
    join(stage, `packages/core/agent-loop/tests/zhuma-${name}.spec.ts`),
  );

const nativeFixture = join(root, 'packages/dsh-adapter/tests/native-work-session-fixture.mjs');
const nativeInputFixture = join(
  root,
  'packages/dsh-adapter/tests/native-work-session-input-fixture.mjs',
);
const workbenchFixture = join(root, 'tests/fixtures/workbench.mjs');
const nativeSpecs = [
  'native-work-session',
  'native-work-session-read',
  'native-work-session-retention',
  'native-work-session-input-tool',
];
for (const name of nativeSpecs)
  copyFileSync(
    join(root, `packages/dsh-adapter/tests/${name}.spec.ts`),
    join(stage, `packages/core/agent-loop/tests/zhuma-${name}.spec.ts`),
  );
const nativeBundle = join(stage, 'packages/core/agent-loop/tests/zhuma-native-work-bundle.ts');
const mappedProductionSources = new Set();
const productionModules = [
  'native-work-session-storage',
  'native-work-session-input-tool',
  'execution-service',
  'project-space',
  'upstream-inputs',
];
const nativeBuild = await build({
  absWorkingDir: root,
  entryPoints: [nativeInputFixture],
  outfile: nativeBundle,
  bundle: true,
  // The runtime must resolve through Vitest's single patched native alias.
  // Ordinary product dependencies (including yaml/zod) belong in this bundle.
  external: ['@deepseek-ai/*'],
  metafile: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  plugins: [
    {
      name: 'native-production-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/dist\/[\w-]+\.js$/ }, (args) => {
          if (![nativeFixture, nativeInputFixture].includes(resolve(args.importer)))
            throw new Error('Unexpected native fixture importer.');
          const name = args.path.slice('../dist/'.length, -'.js'.length);
          if (!productionModules.includes(name))
            throw new Error('Unexpected fixture production module.');
          mappedProductionSources.add(name);
          return { path: join(root, `packages/dsh-adapter/src/${name}.ts`) };
        });
        builder.onResolve({ filter: /^@zhuma\/(agent-core|context)$/ }, (args) => {
          const name = args.path.slice('@zhuma/'.length);
          mappedProductionSources.add(name);
          return { path: join(root, `packages/${name}/src/index.ts`) };
        });
        builder.onResolve(
          { filter: /^\.\.\/\.\.\/packages\/agent-core\/dist\/index\.js$/ },
          (args) => {
            if (resolve(args.importer) !== workbenchFixture)
              throw new Error('Unexpected workbench fixture importer.');
            mappedProductionSources.add('workbench-fixture-core');
            return { path: join(root, 'packages/agent-core/src/index.ts') };
          },
        );
      },
    },
  ],
});
for (const name of [...productionModules, 'agent-core', 'workbench-fixture-core'])
  if (!mappedProductionSources.has(name))
    throw new Error(`Native fixture did not use the current production source: ${name}`);
if (Object.keys(nativeBuild.metafile.inputs).some((path) => /^packages\/[^/]+\/dist\//u.test(path)))
  throw new Error('Native fixture bundled a stale product dist input.');
for (const output of Object.values(nativeBuild.metafile.outputs))
  if (output.imports.some((entry) => /^(@zhuma\/|yaml$|zod(?:\/|$))/u.test(entry.path)))
    throw new Error('Native fixture left a product dependency external.');
const nativeBundleSha256 = hash(nativeBundle);

const phases = [];
function verify(name, files, expectedTests, extraEnv = {}) {
  const report = join(evidence, `${name}.json`);
  const env = { ...process.env };
  for (const variable of [
    'ZHUMA_RETENTION_TEST_ROOT',
    'ZHUMA_RETENTION_TEST_MODE',
    'ZHUMA_NATIVE_WORK_RETENTION_ROOT',
    'ZHUMA_NATIVE_WORK_RETENTION_MODE',
  ])
    delete env[variable];
  Object.assign(env, extraEnv);
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--config=.zhuma-native-lifecycle.config.ts',
      ...files,
      '--project',
      'thread-safe',
      '--testTimeout=5000',
      '--hookTimeout=5000',
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    {
      cwd: stage,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  writeFileSync(join(evidence, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed; evidence retained at ${evidence}`, { cause: result.error });
  const summary = JSON.parse(readFileSync(report, 'utf8'));
  if (
    !summary.success ||
    summary.numFailedTests ||
    summary.numPassedTests !== expectedTests ||
    summary.numTotalTests !== expectedTests ||
    summary.numPendingTests
  )
    throw new Error(`${name} did not complete all required tests; see ${report}`);
  phases.push({ name, passed: summary.numPassedTests });
  console.log(`${name}: ${summary.numPassedTests} passed`);
}
console.log(`Verifying fixed upstream ${pin}; evidence: ${evidence}`);
writeFileSync(
  join(evidence, 'sdk-typecheck.log'),
  command(
    process.execPath,
    [
      join(upstream, 'node_modules/typescript/bin/tsc'),
      '-b',
      'packages/core/agent',
      'packages/core/agent-loop',
      '--pretty',
      'false',
    ],
    stage,
  ),
);
console.log('Patched SDK typecheck passed');
verify(
  'lifecycle',
  [
    'packages/core/agent-loop/tests/zhuma-retained-inbox.spec.ts',
    'packages/core/agent-loop/tests/resource-lifecycle.spec.ts',
    'packages/core/agent-loop/tests/cancel.spec.ts',
  ],
  58,
);
const data = join(evidence, 'session-data');
mkdirSync(data, { mode: 0o700 });
for (const mode of ['write', 'read'])
  verify(`process-${mode}`, ['packages/core/agent-loop/tests/zhuma-cross-process.spec.ts'], 1, {
    ZHUMA_RETENTION_TEST_ROOT: data,
    ZHUMA_RETENTION_TEST_MODE: mode,
  });
verify(
  'native-work-session',
  nativeSpecs.map((name) => `packages/core/agent-loop/tests/zhuma-${name}.spec.ts`),
  35,
);
const nativeData = join(evidence, 'native-work-session-data');
mkdirSync(nativeData, { mode: 0o700 });
for (const mode of ['write', 'read'])
  verify(
    `native-work-process-${mode}`,
    ['packages/core/agent-loop/tests/zhuma-native-work-session-retention.spec.ts'],
    1,
    {
      ZHUMA_NATIVE_WORK_RETENTION_ROOT: nativeData,
      ZHUMA_NATIVE_WORK_RETENTION_MODE: mode,
    },
  );
writeFileSync(
  join(evidence, 'proof.json'),
  `${JSON.stringify(
    {
      upstreamCommit: pin,
      sourceCommit: command('git', ['rev-parse', 'HEAD'], root),
      patchSha256: hash(patch),
      verifierSha256: hash(fileURLToPath(import.meta.url)),
      sdkTypecheck: true,
      nativeBundleSha256,
      nativeFixtureSha256: hash(nativeFixture),
      nativeInputFixtureSha256: hash(nativeInputFixture),
      nativeSpecSha256: nativeSpecs.map((name) => ({
        name,
        sha256: hash(join(root, `packages/dsh-adapter/tests/${name}.spec.ts`)),
      })),
      fixtureSha256: ['retained-inbox', 'cross-process'].map((name) => ({
        name,
        sha256: hash(join(fixtures, `${name}.spec.ts`)),
      })),
      node: process.version,
      phases,
      model: 'local scripted adapter only',
      realProductGrantVerified: false,
    },
    null,
    2,
  )}\n`,
);
command('git', ['worktree', 'remove', '--force', stage], upstream);
console.log(`Native lifecycle verification passed. Evidence: ${evidence}/proof.json`);
