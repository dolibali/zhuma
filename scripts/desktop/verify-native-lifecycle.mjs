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
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: {
    upstream: { type: 'string' },
    phase: { type: 'string', default: 'all' },
    'review-case': { type: 'string' },
  },
});
if (
  values['review-case'] !== undefined &&
  (values.phase !== 'host-review-resources' || values['review-case'] !== 'uploaded-file')
)
  throw new Error('review-case only supports uploaded-file in host-review-resources.');
if (
  ![
    'all',
    'host-run',
    'host-run-cold',
    'host-resources',
    'host-review-resources',
    'host-review-skill',
    'host-results',
    'host-local-workspace',
    'host-workspace-approvals',
    'host-project-artifacts',
    'host-local-policy',
    'host-fixed-publications',
    'host-backend-readiness',
    'host-workflow',
    'host-workflow-admission',
    'host-workflow-file',
    'host-workflow-cold',
    'skill-loader',
    'mcp-close',
    'native-stream',
  ].includes(values.phase)
)
  throw new Error('Unknown native verification phase.');
// Always build the actual artifact before copying it into the isolated SDK.
// The Host test imports these emitted bytes, not a fixture source re-bundle.
const emitted = spawnSync(process.execPath, [join(root, 'scripts/workbench/build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (emitted.error || emitted.status !== 0) throw new Error('Current Host artifact build failed.');
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
async function verifyInStage() {
  // All mutations stay in this verifier-owned temporary checkout. Never modify the fixed input.
  command('git', ['apply', '--check', patch], stage);
  command('git', ['apply', patch], stage);
  symlinkSync(join(upstream, 'node_modules'), join(stage, 'node_modules'), 'dir');
  for (const group of readdirSync(join(upstream, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const pkg of readdirSync(join(upstream, 'packages', group.name), {
      withFileTypes: true,
    })) {
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
  // The upstream paths plugin deliberately ignores emitted .js. Explicitly map
  // its own exact SDK paths for both JS artifacts and TS fixture providers, so
  // this source-SDK component probe uses one module graph. This is not a claim
  // about Web/profile package resolution, which is verified separately.
  const sdkPaths = ts.readConfigFile(join(stage, 'tsconfig.base.json'), (file) =>
    readFileSync(file, 'utf8'),
  );
  if (sdkPaths.error) throw new Error('Cannot read the pinned SDK resolution paths.');
  const sdkAliases = Object.entries(sdkPaths.config.compilerOptions.paths)
    .filter(([name]) => name.startsWith('@deepseek-ai/') && !name.includes('*'))
    .sort(([left], [right]) => right.length - left.length)
    .map(([find, paths]) => ({ find, replacement: resolve(stage, paths[0]) }));
  if (values.phase === 'skill-loader') {
    // These original SDK suites import documented source subpaths. Keep them in
    // the same staged graph, ahead of the exact package-entry alias.
    sdkAliases.unshift(
      ...['ts-types', 'py-types', 'json-schema'].map((name) => ({
        find: `@deepseek-ai/dsh-tools/src/${name}.ts`,
        replacement: join(stage, `packages/core/tools/src/${name}.ts`),
      })),
    );
  }
  if (values.phase === 'mcp-close') {
    sdkAliases.unshift(
      ...['index', 'connection'].map((name) => ({
        find: `@deepseek-ai/dsh-mcp-client/src/${name}.ts`,
        replacement: join(stage, `packages/mcp/mcp-client/src/${name}.ts`),
      })),
    );
  }
  writeFileSync(
    join(stage, '.zhuma-native-lifecycle.config.ts'),
    `
import config from './vitest.config.ts'
const sdkAliases = ${JSON.stringify(sdkAliases)}
const aliases = (current) => [...sdkAliases, ...(Array.isArray(current) ? current : Object.entries(current ?? {}).map(([find, replacement]) => ({find, replacement})))]
export default { ...config, resolve: {...config.resolve, alias: aliases(config.resolve?.alias)}, cacheDir: './.zhuma-test-cache/root', test: {
  ...config.test, projects: config.test.projects.map((project) => ({
    ...project, resolve: {...project.resolve, alias: aliases(project.resolve?.alias)}, cacheDir: './.zhuma-test-cache/' + project.test.name,
  })),
} }
`,
  );
  if (values.phase === 'mcp-close') {
    const fixture = join(root, 'tests/fixtures/mcp-close/confirmation.spec.ts');
    const target = 'packages/mcp/mcp-client/tests/zhuma-close-confirmation.spec.ts';
    const publicApiFixture = 'packages/mcp/mcp-client/src/zhuma-close-api.typecheck.ts';
    copyFileSync(fixture, join(stage, target));
    // Compile the public consumer with the package's original project references;
    // do not recheck vendor sources under a different root compiler policy.
    writeFileSync(
      join(stage, publicApiFixture),
      `import type { Context } from '@deepseek-ai/cordis';
import { captureMcpClientClose, McpClientCloseError, type McpClientCloseHandle } from '@deepseek-ai/dsh-mcp-client';
function publicContract(context: Context) {
  const capture: (context: Context) => McpClientCloseHandle = captureMcpClientClose;
  const handle = capture(context);
  const closed: Promise<void> = handle.close();
  const error = new McpClientCloseError('mcp-close-unconfirmed');
  const code: 'mcp-close-unavailable' | 'mcp-close-unconfirmed' = error.code;
  return { closed, code };
}
void publicContract;
`,
    );
    writeFileSync(
      join(evidence, 'sdk-typecheck.log'),
      command(
        process.execPath,
        [
          join(upstream, 'node_modules/typescript/bin/tsc'),
          '-b',
          'packages/mcp/mcp-client',
          '--pretty',
          'false',
        ],
        stage,
      ),
    );
    const run = (name, files, expected) => {
      const report = join(evidence, `${name}.json`);
      const result = spawnSync(
        process.execPath,
        [
          vitest,
          'run',
          '--config=.zhuma-native-lifecycle.config.ts',
          '--project',
          'thread-safe',
          ...files,
          '--reporter=json',
          `--outputFile=${report}`,
        ],
        {
          cwd: stage,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            ZHUMA_MCP_CLOSE_OBSERVATIONS: join(evidence, 'http-observations.json'),
          },
        },
      );
      writeFileSync(join(evidence, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
      if (result.error || !existsSync(report))
        throw new Error(`${name} did not produce evidence: ${evidence}`);
      const summary = JSON.parse(readFileSync(report, 'utf8'));
      if (
        result.status !== 0 ||
        !summary.success ||
        summary.numFailedTests ||
        summary.numPassedTests !== expected
      )
        throw new Error(`${name} failed; evidence: ${evidence}`);
      return { name, passed: summary.numPassedTests, omittedByFilter: summary.numPendingTests };
    };
    const contract = run(
      'mcp-close-contract',
      [
        'packages/mcp/mcp-client/tests/reconnect.spec.ts',
        '-t',
        'captures only the original plugin close owner|rejects bounded disposal',
      ],
      3,
    );
    const http = run('mcp-close-http', [target], 3);
    const observations = JSON.parse(readFileSync(join(evidence, 'http-observations.json'), 'utf8'));
    const refused = observations.find((item) => item.case === 'close-confirmation-timeout');
    if (
      !refused?.explicitCloseRejected ||
      !refused.cordisFiberDisposeResolved ||
      refused.clientCallSettled ||
      refused.httpHeld !== 1 ||
      refused.clientCloseObserved !== 0 ||
      refused.afterExplicitRealClose?.httpHeld !== 0
    )
      throw new Error(
        `The real false-close counterexample did not retain its physical assertions: ${evidence}`,
      );
    writeFileSync(
      join(evidence, 'proof.json'),
      `${JSON.stringify(
        {
          upstreamCommit: pin,
          sourceCommit: command('git', ['rev-parse', 'HEAD'], root),
          sourceClean:
            command(
              'git',
              ['status', '--porcelain', '--', 'packages', 'scripts', 'patches', 'tests', 'docs'],
              root,
            ) === '',
          patchSha256: hash(patch),
          fixtureSha256: hash(fixture),
          verifierSha256: hash(fileURLToPath(import.meta.url)),
          sdkTypecheck: true,
          publicApiTypecheck: true,
          publicApiFixtureSha256: hash(join(stage, publicApiFixture)),
          phases: [contract, http],
          mcpSource: ['src/index.ts', 'src/connection.ts', 'tests/reconnect.spec.ts'].map(
            (path) => ({ path, sha256: hash(join(stage, 'packages/mcp/mcp-client', path)) }),
          ),
          observations,
          boundary:
            'fixed source SDK MCP scope and physical HTTP close only; no model, credentials, Run adoption, stdio process, compiled Web, GUI or installer qualification',
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `MCP close qualification: ${contract.passed} focused SDK contracts and ${http.passed} actual HTTP cases passed; evidence: ${evidence}/proof.json`,
    );
    return;
  }
  // A dedicated qualification uses the same fixed-pin staging and one SDK graph.
  // It never opens a profile, native session or model connection.
  if (values.phase === 'skill-loader') {
    const fixture = join(root, 'tests/fixtures/skill-loader/ownership.spec.ts');
    const destination = join(stage, 'packages/skill/tool-skill/tests/zhuma-ownership.spec.ts');
    copyFileSync(fixture, destination);
    writeFileSync(
      join(evidence, 'sdk-typecheck.log'),
      command(
        process.execPath,
        [
          join(upstream, 'node_modules/typescript/bin/tsc'),
          '-b',
          'packages/core/tools',
          'packages/skill/tool-skill',
          '--pretty',
          'false',
        ],
        stage,
      ),
    );
    const run = (name, args, beforeBinding = false) => {
      const report = join(evidence, `${name}.json`);
      const env = { ...process.env };
      delete env.ZHUMA_SKILL_BIND_NEGATIVE_SOURCE;
      if (beforeBinding) env.ZHUMA_SKILL_BIND_NEGATIVE_SOURCE = '1';
      const result = spawnSync(
        process.execPath,
        [
          vitest,
          'run',
          '--config=.zhuma-native-lifecycle.config.ts',
          '--project',
          'thread-safe',
          ...args,
          '--reporter=json',
          `--outputFile=${report}`,
        ],
        { cwd: stage, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env },
      );
      writeFileSync(join(evidence, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
      if (result.error || !existsSync(report))
        throw new Error(`${name} did not produce evidence: ${evidence}`);
      return { status: result.status, summary: JSON.parse(readFileSync(report, 'utf8')) };
    };
    const positive = run('skill-loader', [
      'packages/core/tools/tests',
      'packages/skill/tool-skill/tests',
    ]);
    if (
      positive.status !== 0 ||
      !positive.summary.success ||
      positive.summary.numFailedTests ||
      !positive.summary.numPassedTests ||
      positive.summary.numPendingTests
    ) {
      throw new Error(`Skill loader qualification failed; evidence: ${evidence}`);
    }
    // Mechanical falsification: the same body-leak probes must fail on both
    // original production files, with the same repaired real-context fixtures.
    const paths = ['packages/core/tools/src/index.ts', 'packages/skill/tool-skill/src/index.ts'];
    const patched = paths.map((path) => readFileSync(join(stage, path)));
    let negative;
    let negativeEmpty;
    try {
      for (const path of paths)
        writeFileSync(join(stage, path), command('git', ['show', `${pin}:${path}`], stage));
      negative = run(
        'skill-loader-before',
        [
          'packages/skill/tool-skill/tests/zhuma-ownership.spec.ts',
          '-t',
          'does not load parent private body',
        ],
        true,
      );
      if (
        negative.status === 0 ||
        negative.summary.numFailedTests !== 2 ||
        negative.summary.numPassedTests !== 0 ||
        negative.summary.testResults
          .flatMap((suite) => suite.assertionResults)
          .filter((test) => test.status === 'failed')
          .some((test) => !test.failureMessages.join(' ').includes('PRIVATE_BODY'))
      ) {
        throw new Error(
          `Old SDK did not reproduce both leakage regressions; evidence: ${evidence}`,
        );
      }
      negativeEmpty = run(
        'skill-empty-before',
        [
          'packages/skill/tool-skill/tests/zhuma-ownership.spec.ts',
          '-t',
          'empty bound registry closed without a loader',
        ],
        true,
      );
      if (
        negativeEmpty.status === 0 ||
        negativeEmpty.summary.numFailedTests !== 2 ||
        negativeEmpty.summary.numPassedTests !== 0 ||
        negativeEmpty.summary.testResults
          .flatMap((suite) => suite.assertionResults)
          .filter((test) => test.status === 'failed')
          .some((test) => !test.failureMessages.join(' ').includes('expected 1 to be'))
      )
        throw new Error(
          `Old SDK did not reproduce empty-domain parent reads; evidence: ${evidence}`,
        );
    } finally {
      paths.forEach((path, index) => writeFileSync(join(stage, path), patched[index]));
    }
    writeFileSync(
      join(evidence, 'proof.json'),
      JSON.stringify(
        {
          upstreamCommit: pin,
          sourceCommit: command('git', ['rev-parse', 'HEAD'], root),
          patchSha256: hash(patch),
          fixtureSha256: hash(fixture),
          passed: positive.summary.numPassedTests,
          negativeFailed: negative.summary.numFailedTests,
          negativeEmptyParentReads: negativeEmpty.summary.numFailedTests,
          boundary:
            'fixed source SDK ToolSkill/Tools contracts; no model, GUI or resource adoption',
        },
        null,
        2,
      ),
    );
    console.log(
      `Skill loader qualification: ${positive.summary.numPassedTests} passed, old body-leak probes ${negative.summary.numFailedTests} failed as required; evidence: ${evidence}`,
    );
    return;
  }

  writeFileSync(
    join(stage, '.zhuma-panel-navigation.typecheck.json'),
    JSON.stringify({
      extends: './tsconfig.base.client.json',
      compilerOptions: {
        composite: false,
        incremental: false,
        noEmit: true,
        jsx: 'react-jsx',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      },
      files: ['packages/client/ui-layout/src/client/service.ts'],
      include: [],
      references: [
        { path: './vendor/cordis' },
        { path: './packages/util/brand' },
        { path: './packages/client/store' },
        { path: './packages/client/ui-slots' },
      ],
    }),
  );
  for (const name of ['retained-inbox', 'cross-process'])
    copyFileSync(
      join(fixtures, `${name}.spec.ts`),
      join(stage, `packages/core/agent-loop/tests/zhuma-${name}.spec.ts`),
    );
  const navigationFixture = join(root, 'tests/fixtures/member-navigation/panel-navigation.spec.ts');
  copyFileSync(
    navigationFixture,
    join(stage, 'packages/client/ui-layout/tests/zhuma-panel-navigation.spec.ts'),
  );

  const nativeFixture = join(root, 'packages/dsh-adapter/tests/native-work-session-fixture.mjs');
  const nativeInputFixture = join(
    root,
    'packages/dsh-adapter/tests/native-work-session-input-fixture.mjs',
  );
  const nativeMigrationFixture = join(
    root,
    'packages/dsh-adapter/tests/native-work-session-migration-fixture.mjs',
  );
  const executionRunFixture = join(
    root,
    'packages/dsh-adapter/tests/execution-run-native-fixture.mjs',
  );
  const executionRunHelperFixture = join(
    root,
    'packages/dsh-adapter/tests/execution-run-fixture.mjs',
  );
  const workbenchFixture = join(root, 'tests/fixtures/workbench.mjs');
  const nativeSpecs = [
    'native-work-session',
    'native-work-session-read',
    'native-work-session-retention',
    'native-work-session-input-tool',
    'native-work-session-migration',
    'native-work-session-origin',
    'native-work-session-working-directory',
    'native-work-session-stream',
  ];
  const executionRunSpecs = ['execution-run-native-migration', 'execution-run-native-recovery'];
  for (const name of [...nativeSpecs, ...executionRunSpecs])
    copyFileSync(
      join(root, `packages/dsh-adapter/tests/${name}.spec.ts`),
      join(stage, `packages/core/agent-loop/tests/zhuma-${name}.spec.ts`),
    );
  copyFileSync(
    join(root, '.build/workbench/index.js'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-run-plugin.js'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-run-native.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-run-native.spec.ts'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-run-local-workspace.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-run-local-workspace.spec.ts'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-workspace-approvals.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-workspace-approvals.spec.ts'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-project-artifacts.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-project-artifacts.spec.ts'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-run-local-policy.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-run-local-policy.spec.ts'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-run-fixed-publications.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-run-fixed-publications.spec.ts'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-workflow.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-workflow.spec.ts'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-run-cold.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-run-cold.spec.ts'),
  );
  copyFileSync(
    join(root, 'packages/dsh-adapter/tests/host-review-resources.spec.ts'),
    join(stage, 'packages/core/agent-loop/tests/zhuma-host-review-resources.spec.ts'),
  );
  const nativeBundle = join(stage, 'packages/core/agent-loop/tests/zhuma-native-work-bundle.ts');
  const executionRunBundle = join(
    stage,
    'packages/core/agent-loop/tests/zhuma-execution-run-bundle.ts',
  );
  const mappedProductionSources = new Set();
  const productionModules = [
    'native-work-session-storage',
    'native-work-session-input-tool',
    'native-work-session-record',
    'execution-service',
    'project-space',
    'upstream-inputs',
  ];
  const executionRunProductionModules = [
    'execution-run-authority',
    'execution-run-protocol',
    'execution-run-state',
    'native-work-session-contract',
  ];
  const nativeBuildOptions = {
    absWorkingDir: root,
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
            if (
              ![
                nativeFixture,
                nativeInputFixture,
                nativeMigrationFixture,
                executionRunFixture,
                executionRunHelperFixture,
              ].includes(resolve(args.importer))
            )
              throw new Error('Unexpected native fixture importer.');
            const name = args.path.slice('../dist/'.length, -'.js'.length);
            if (![...productionModules, ...executionRunProductionModules].includes(name))
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
  };
  const nativeBuild = await build({
    ...nativeBuildOptions,
    entryPoints: [nativeMigrationFixture],
    outfile: nativeBundle,
  });
  const hostTestData = join(stage, 'packages/core/agent-loop/tests/zhuma-host-run-test-data.js');
  await build({
    ...nativeBuildOptions,
    entryPoints: [join(root, 'packages/dsh-adapter/tests/host-run-test-data.mjs')],
    outfile: hostTestData,
  });
  for (const name of [...productionModules, 'agent-core', 'workbench-fixture-core'])
    if (!mappedProductionSources.has(name))
      throw new Error(`Native fixture did not use the current production source: ${name}`);
  // This bundle includes C's fixture source directly, never the generated C bundle.
  // D's error classification and C's runtime must share one actual module graph.
  const executionRunBuild = await build({
    ...nativeBuildOptions,
    entryPoints: [executionRunFixture],
    outfile: executionRunBundle,
  });
  for (const result of [nativeBuild, executionRunBuild]) {
    if (Object.keys(result.metafile.inputs).some((path) => /^packages\/[^/]+\/dist\//u.test(path)))
      throw new Error('Native fixture bundled a stale product dist input.');
    for (const output of Object.values(result.metafile.outputs))
      if (output.imports.some((entry) => /^(@zhuma\/|yaml$|zod(?:\/|$))/u.test(entry.path)))
        throw new Error('Native fixture left a product dependency external.');
  }
  const nativeBundleSha256 = hash(nativeBundle);
  const executionRunBundleSha256 = hash(executionRunBundle);
  const sourcePaths = (result) =>
    Object.keys(result.metafile.inputs)
      .map((path) => relative(root, resolve(root, path)).split(sep).join('/'))
      .filter((path) => path.startsWith('packages/dsh-adapter/src/') && path.endsWith('.ts'))
      .sort();
  const sourceSha256 = (paths) => paths.map((path) => ({ path, sha256: hash(join(root, path)) }));
  const nativeSourcePaths = sourcePaths(nativeBuild);
  for (const name of ['native-work-session-record', 'native-work-session-migration'])
    if (!nativeSourcePaths.includes(`packages/dsh-adapter/src/${name}.ts`))
      throw new Error(`Native fixture did not bundle the current migration source: ${name}`);
  const nativeSourceSha256 = sourceSha256(nativeSourcePaths);
  const executionRunSourcePaths = sourcePaths(executionRunBuild);
  for (const name of [
    ...executionRunProductionModules,
    'native-work-session',
    'native-work-session-dsh',
    'native-work-session-storage',
    'native-work-session-record',
    'native-work-session-migration',
  ])
    if (!executionRunSourcePaths.includes(`packages/dsh-adapter/src/${name}.ts`))
      throw new Error(`Run fixture did not bundle the current production source: ${name}`);
  const executionRunSourceSha256 = sourceSha256(executionRunSourcePaths);

  const phases = [];
  function verify(name, files, expectedTests, extraEnv = {}, omittedByNameFilter = 0) {
    const report = join(evidence, `${name}.json`);
    const env = { ...process.env };
    for (const variable of [
      'ZHUMA_RETENTION_TEST_ROOT',
      'ZHUMA_RETENTION_TEST_MODE',
      'ZHUMA_NATIVE_WORK_RETENTION_ROOT',
      'ZHUMA_NATIVE_WORK_RETENTION_MODE',
      'ZHUMA_NATIVE_STREAM_ROOT',
      'ZHUMA_NATIVE_STREAM_MODE',
      'ZHUMA_RUN_RECOVERY_ROOT',
      'ZHUMA_RUN_RECOVERY_MODE',
      'ZHUMA_HOST_COLD_ROOT',
      'ZHUMA_HOST_COLD_MODE',
      'ZHUMA_HOST_COLD_VARIANT',
      'ZHUMA_HOST_COLD_ATTACHMENTS',
      'ZHUMA_HOST_FIXED_PUBLICATION_TIMINGS',
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
      summary.numTotalTests !== expectedTests + omittedByNameFilter ||
      summary.numPendingTests !== omittedByNameFilter
    )
      throw new Error(`${name} did not complete all required tests; see ${report}`);
    phases.push({
      name,
      passed: summary.numPassedTests,
      ...(omittedByNameFilter ? { omittedByNameFilter } : {}),
    });
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
        'packages/client/ui-slots',
        '--pretty',
        'false',
      ],
      stage,
    ),
  );
  console.log('Patched SDK typecheck passed');
  writeFileSync(
    join(evidence, 'layout-typecheck.log'),
    command(
      process.execPath,
      [
        join(upstream, 'node_modules/typescript/bin/tsc'),
        '-p',
        '.zhuma-panel-navigation.typecheck.json',
        '--pretty',
        'false',
      ],
      stage,
    ),
  );
  if (values.phase === 'all') {
    verify(
      'panel-navigation',
      [
        'packages/client/ui-layout/tests/service.client.spec.ts',
        'packages/client/ui-layout/tests/zhuma-panel-navigation.spec.ts',
      ],
      13,
    );
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
    verify(
      'execution-run-native',
      executionRunSpecs.map((name) => `packages/core/agent-loop/tests/zhuma-${name}.spec.ts`),
      7,
    );
    const executionRunData = join(evidence, 'execution-run-data');
    mkdirSync(executionRunData, { mode: 0o700 });
    for (const mode of ['write', 'read'])
      verify(
        `execution-run-process-${mode}`,
        ['packages/core/agent-loop/tests/zhuma-execution-run-native-recovery.spec.ts'],
        1,
        { ZHUMA_RUN_RECOVERY_ROOT: executionRunData, ZHUMA_RUN_RECOVERY_MODE: mode },
      );
  }
  if (values.phase === 'all' || values.phase === 'native-stream') {
    verify(
      'native-work-session',
      nativeSpecs.map((name) => `packages/core/agent-loop/tests/zhuma-${name}.spec.ts`),
      74,
    );
    const inboxData = join(evidence, 'native-stream-data');
    mkdirSync(inboxData, { mode: 0o700 });
    for (const mode of ['write', 'read'])
      verify(
        `native-stream-${mode}`,
        ['packages/core/agent-loop/tests/zhuma-native-work-session-stream.spec.ts'],
        1,
        {
          ZHUMA_NATIVE_STREAM_ROOT: inboxData,
          ZHUMA_NATIVE_STREAM_MODE: mode,
        },
      );
  }
  if (values.phase === 'host-workflow-file')
    verify(
      'host-workflow-file',
      [
        'packages/core/agent-loop/tests/zhuma-host-run-fixed-publications.spec.ts',
        '-t',
        'actual Host fixed publications: file-only completion',
      ],
      1,
      {},
      20,
    );
  else if (values.phase === 'host-workflow-admission')
    verify(
      'host-workflow-admission',
      [
        'packages/core/agent-loop/tests/zhuma-host-workflow.spec.ts',
        '-t',
        'actual Host workflow: (parallel|Stop|successful)',
      ],
      4,
      {},
      15,
    );
  else if (values.phase === 'host-workflow')
    verify(
      'host-workflow',
      ['packages/core/agent-loop/tests/zhuma-host-workflow.spec.ts', '-t', 'actual Host workflow:'],
      5,
      {},
      14,
    );
  else if (values.phase === 'host-backend-readiness')
    verify(
      'host-backend-readiness',
      [
        'packages/core/agent-loop/tests/zhuma-host-run-fixed-publications.spec.ts',
        '-t',
        'actual Host backend readiness:|explicit legacy Host|backend-unload cancels',
      ],
      4,
      {},
      17,
    );
  else if (values.phase === 'host-fixed-publications')
    verify(
      'host-fixed-publications',
      [
        'packages/core/agent-loop/tests/zhuma-host-run-fixed-publications.spec.ts',
        '-t',
        'actual Host fixed publications:',
      ],
      5,
      {
        ZHUMA_HOST_FIXED_PUBLICATION_TIMINGS: join(
          evidence,
          'host-fixed-publications-timings.json',
        ),
      },
      16,
    );
  else if (values.phase === 'host-local-policy')
    verify(
      'host-local-policy',
      [
        'packages/core/agent-loop/tests/zhuma-host-run-local-policy.spec.ts',
        '-t',
        'actual Host local policy:',
      ],
      3,
      {},
      14,
    );
  else if (values.phase === 'host-local-workspace')
    verify(
      'host-local-workspace',
      [
        'packages/core/agent-loop/tests/zhuma-host-run-local-workspace.spec.ts',
        '-t',
        'actual Host local workspace:',
      ],
      5,
      {},
      14,
    );
  else if (values.phase === 'host-review-skill')
    verify(
      'host-review-skill',
      [
        'packages/core/agent-loop/tests/zhuma-host-review-resources.spec.ts',
        '-t',
        'actual Host independent review: real selected Skill',
      ],
      1,
      {},
      17,
    );
  else if (values.phase === 'host-review-resources')
    verify(
      'host-review-resources',
      [
        'packages/core/agent-loop/tests/zhuma-host-review-resources.spec.ts',
        '-t',
        values['review-case'] === 'uploaded-file'
          ? 'actual Host independent review: fixed uploaded UTF8 file'
          : 'actual Host independent review:',
      ],
      values['review-case'] === 'uploaded-file' ? 1 : 4,
      {},
      values['review-case'] === 'uploaded-file' ? 17 : 14,
    );
  else if (values.phase === 'host-project-artifacts')
    verify(
      'host-project-artifacts',
      [
        'packages/core/agent-loop/tests/zhuma-host-project-artifacts.spec.ts',
        '-t',
        'actual Host project artifacts:',
      ],
      1,
      {},
      14,
    );
  else if (values.phase === 'host-workspace-approvals')
    verify(
      'host-workspace-approvals',
      [
        'packages/core/agent-loop/tests/zhuma-host-workspace-approvals.spec.ts',
        '-t',
        'actual Host workspace approvals:',
      ],
      2,
      {},
      14,
    );
  else if (values.phase === 'host-resources')
    verify(
      'host-resources',
      [
        'packages/core/agent-loop/tests/zhuma-host-run-native.spec.ts',
        '-t',
        'actual emitted Host resources:',
      ],
      2,
      {},
      12,
    );
  else if (values.phase === 'host-results')
    verify(
      'host-results',
      [
        'packages/core/agent-loop/tests/zhuma-host-run-native.spec.ts',
        '-t',
        'actual emitted Host fixed result:',
      ],
      6,
      {},
      8,
    );
  else if (values.phase !== 'host-workflow-cold')
    verify('host-run', ['packages/core/agent-loop/tests/zhuma-host-run-native.spec.ts'], 14);
  const coldRecoveries = [];
  if (
    [
      'all',
      'host-run-cold',
      'host-results',
      'host-fixed-publications',
      'host-workflow-cold',
    ].includes(values.phase)
  ) {
    const variants =
      values.phase === 'host-workflow-cold'
        ? ['workflow']
        : ['host-results', 'host-fixed-publications'].includes(values.phase)
          ? ['result']
          : ['unadmitted', 'unknown', 'bound', 'revoked', 'result'];
    for (const variant of variants) {
      const data = join(evidence, `host-cold-${variant}`);
      mkdirSync(data, { mode: 0o700 });
      for (const mode of ['write', 'read'])
        verify(
          `host-cold-${variant}-${mode}`,
          [
            'packages/core/agent-loop/tests/zhuma-host-run-cold.spec.ts',
            '-t',
            variant === 'workflow' ? 'formal Host workflow:' : 'formal Host: explicit cold retry',
          ],
          1,
          {
            ZHUMA_HOST_COLD_ROOT: data,
            ZHUMA_HOST_COLD_MODE: mode,
            ZHUMA_HOST_COLD_VARIANT: variant,
            ...(values.phase === 'host-fixed-publications'
              ? { ZHUMA_HOST_COLD_ATTACHMENTS: 'reader' }
              : {}),
          },
          1,
        );
      const writer = JSON.parse(readFileSync(join(data, 'write-report.json'), 'utf8'));
      const reader = JSON.parse(readFileSync(join(data, 'read-report.json'), 'utf8'));
      if (!Number.isSafeInteger(writer.pid) || writer.pid === reader.pid)
        throw new Error('Cold recovery requires distinct actual OS processes.');
      coldRecoveries.push({ variant, writer, reader });
    }
  }
  writeFileSync(
    join(evidence, 'proof.json'),
    `${JSON.stringify(
      {
        upstreamCommit: pin,
        sourceCommit: command('git', ['rev-parse', 'HEAD'], root),
        sourceClean:
          command(
            'git',
            [
              'status',
              '--porcelain',
              '--',
              'packages',
              'scripts',
              'patches',
              'package.json',
              'pnpm-lock.yaml',
              'pnpm-workspace.yaml',
            ],
            root,
          ) === '',
        patchSha256: hash(patch),
        verifierSha256: hash(fileURLToPath(import.meta.url)),
        phase: values.phase,
        ...(values['review-case'] ? { reviewCase: values['review-case'] } : {}),
        ...(values.phase === 'host-fixed-publications'
          ? {
              hostFixedPublicationTimings: JSON.parse(
                readFileSync(join(evidence, 'host-fixed-publications-timings.json'), 'utf8'),
              ),
            }
          : {}),
        hostArtifactSha256: hash(join(root, '.build/workbench/index.js')),
        hostTestDataSha256: hash(hostTestData),
        hostRunSpecSha256: hash(join(root, 'packages/dsh-adapter/tests/host-run-native.spec.ts')),
        hostReviewResourcesSpecSha256: hash(
          join(root, 'packages/dsh-adapter/tests/host-review-resources.spec.ts'),
        ),
        hostLocalWorkspaceSpecSha256: hash(
          join(root, 'packages/dsh-adapter/tests/host-run-local-workspace.spec.ts'),
        ),
        hostWorkspaceApprovalsSpecSha256: hash(
          join(root, 'packages/dsh-adapter/tests/host-workspace-approvals.spec.ts'),
        ),
        hostProjectArtifactsSpecSha256: hash(
          join(root, 'packages/dsh-adapter/tests/host-project-artifacts.spec.ts'),
        ),
        hostLocalPolicySpecSha256: hash(
          join(root, 'packages/dsh-adapter/tests/host-run-local-policy.spec.ts'),
        ),
        hostFixedPublicationsSpecSha256: hash(
          join(root, 'packages/dsh-adapter/tests/host-run-fixed-publications.spec.ts'),
        ),
        hostWorkflowSpecSha256: hash(
          join(root, 'packages/dsh-adapter/tests/host-workflow.spec.ts'),
        ),
        hostRunWorkspacesSha256: hash(
          join(root, 'packages/dsh-adapter/src/host-run-workspaces.ts'),
        ),
        hostColdSpecSha256: hash(join(root, 'packages/dsh-adapter/tests/host-run-cold.spec.ts')),
        coldRecoveries,
        emittedHostUsesPinnedSourceSdkAliases: true,
        sdkTypecheck: true,
        layoutTypecheck: true,
        nativeBundleSha256,
        nativeFixtureSha256: hash(nativeFixture),
        nativeInputFixtureSha256: hash(nativeInputFixture),
        nativeMigrationFixtureSha256: hash(nativeMigrationFixture),
        nativeSourceSha256,
        executionRunBundleSha256,
        executionRunFixtureSha256: hash(executionRunFixture),
        executionRunHelperFixtureSha256: hash(executionRunHelperFixture),
        executionRunSourceSha256,
        executionRunSpecSha256: executionRunSpecs.map((name) => ({
          name,
          sha256: hash(join(root, `packages/dsh-adapter/tests/${name}.spec.ts`)),
        })),
        navigationFixtureSha256: hash(navigationFixture),
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
        emittedHostMemberRunGrantVerified: true,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Native lifecycle verification passed. Evidence: ${evidence}/proof.json`);
}
try {
  await verifyInStage();
} finally {
  command('git', ['worktree', 'remove', '--force', stage], upstream);
}
