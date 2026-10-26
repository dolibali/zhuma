/** Private SDK test driver, never a product Host entry or a model provider. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Each test CLI gets its own group, including its actual SDK worker.
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function withDeadline(work, child, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          terminate(child);
          reject(Error('The private SDK child exceeded its proof deadline.'));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function proveNativeResultProcessRecovery({ sdkRoot, sdkConfig, vitestPath }) {
  assert.notEqual(process.platform, 'win32', 'This fixture requires POSIX process groups.');
  for (const path of [sdkRoot, sdkConfig, vitestPath]) assert.equal(typeof path, 'string');
  const evidence = await mkdtemp(join(tmpdir(), 'zhuma-result-process-proof-'));
  const data = join(evidence, 'host-data');
  const bundle = join(evidence, 'zhuma-native-result-process-bundle.ts');
  const fixtureNames = ['result-publications', 'output-file', 'result', 'files', 'input', ''].map(
    (suffix) => `native-work-session${suffix ? `-${suffix}` : ''}-fixture.mjs`,
  );
  const ownedFixtures = new Set(
    fixtureNames.map((name) => join(root, 'packages/dsh-adapter/tests', name)),
  );
  const product = await build({
    absWorkingDir: root,
    entryPoints: [
      join(root, 'packages/dsh-adapter/tests/native-work-session-result-publications-fixture.mjs'),
    ],
    outfile: bundle,
    bundle: true,
    external: ['@deepseek-ai/*'],
    metafile: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    plugins: [
      {
        name: 'current-native-result-source',
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/dist\/[\w-]+\.js$/ }, (args) => {
            assert.ok(ownedFixtures.has(resolve(args.importer)));
            return {
              path: join(root, 'packages/dsh-adapter/src', args.path.slice(8, -3) + '.ts'),
            };
          });
          builder.onResolve({ filter: /^@zhuma\/(agent-core|context)$/ }, (args) => ({
            path: join(root, 'packages', args.path.slice(7), 'src/index.ts'),
          }));
          builder.onResolve(
            { filter: /^\.\.\/\.\.\/packages\/agent-core\/dist\/index\.js$/ },
            () => ({ path: join(root, 'packages/agent-core/src/index.ts') }),
          );
        },
      },
    ],
  });
  assert.equal(
    Object.keys(product.metafile.inputs).some((path) => /^packages\/[^/]+\/dist\//u.test(path)),
    false,
    'The SDK proof must not bundle stale product dist.',
  );
  for (const output of Object.values(product.metafile.outputs))
    assert.equal(
      output.imports.some((item) => /^(@zhuma\/|yaml$|zod(?:\/|$))/u.test(item.path)),
      false,
    );
  const spec = join(evidence, 'native-result-process.spec.ts');
  await copyFile(
    join(root, 'packages/dsh-adapter/tests/native-work-session-result-process.spec.ts'),
    spec,
  );
  const config = join(evidence, 'vitest.config.mts');
  await writeFile(
    config,
    `import original from ${JSON.stringify(sdkConfig)};
const project = original.test.projects.find(p => p.test.name === 'thread-safe');
if (!project) throw Error('The original SDK thread-safe test project is required.');
export default { ...original, cacheDir: ${JSON.stringify(join(evidence, 'root-cache'))}, test: {
  ...original.test, projects: [{ ...project, cacheDir: ${JSON.stringify(join(evidence, 'project-cache'))}, test: {
    ...project.test, name: 'native-process', include: [${JSON.stringify(spec)}],
    pool: 'forks', maxWorkers: 1, fileParallelism: false, testTimeout: 90000, hookTimeout: 90000,
  }}],
}};
`,
  );
  await writeFile(
    join(evidence, 'inputs.json'),
    JSON.stringify(
      {
        root,
        sdkRoot,
        sdkConfig,
        specSha256: await hash(spec),
        driverSha256: await hash(fileURLToPath(import.meta.url)),
        bundleSha256: await hash(bundle),
        configSha256: await hash(config),
        sdkConfigSha256: await hash(sdkConfig),
        sources: await Promise.all(
          Object.keys(product.metafile.inputs)
            .filter((path) => path.startsWith('packages/'))
            .map(async (path) => ({ path, sha256: await hash(join(root, path)) })),
        ),
      },
      null,
      2,
    ),
  );
  const launch = (phase) => {
    const child = spawn(
      process.execPath,
      [
        vitestPath,
        'run',
        `--config=${config}`,
        spec,
        '--project=native-process',
        '--reporter=json',
        `--outputFile=${join(evidence, `${phase}-vitest.json`)}`,
      ],
      {
        cwd: sdkRoot,
        detached: true,
        env: {
          ...process.env,
          ZHUMA_RESULT_PROCESS_PHASE: phase,
          ZHUMA_RESULT_PROCESS_ROOT: data,
          ZHUMA_RESULT_PROCESS_EVIDENCE: evidence,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (value) => (output += value));
    child.stderr.on('data', (value) => (output += value));
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', async (code, signal) => {
        try {
          await writeFile(join(evidence, `${phase}.log`), output);
          resolve({ pid: child.pid, code, signal });
        } catch (error) {
          reject(error);
        }
      });
    });
    return { child, completion };
  };
  console.log(`Actual OS process proof: ${evidence}`);
  const first = launch('produce');
  let second;
  try {
    const ready = join(evidence, 'producer-ready.json');
    let closed = false;
    void first.completion.then(
      () => (closed = true),
      () => (closed = true),
    );
    await withDeadline(
      (async () => {
        while (!(await exists(ready))) {
          if (closed) throw Error(`The producer exited before a durable cut: ${evidence}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })(),
      first.child,
      90000,
    );
    const producer = JSON.parse(await readFile(ready, 'utf8'));
    terminate(first.child);
    const exited = await withDeadline(first.completion, first.child, 10000);
    assert.equal(exited.signal, 'SIGKILL');
    await unlink(join(data, 'work/outputs/result.bin'));
    await writeFile(
      join(evidence, 'producer-exit.json'),
      JSON.stringify({
        ...exited,
        actualWorkerPid: producer.pid,
        reason: 'SIGKILL after durable cut and before business submit; source then deleted.',
      }),
    );
    second = launch('recover');
    const resumed = await withDeadline(second.completion, second.child, 100000);
    await writeFile(join(evidence, 'recovery-exit.json'), JSON.stringify(resumed));
    assert.equal(resumed.code, 0, `Actual new-process recovery failed: ${evidence}`);
    const result = JSON.parse(await readFile(join(evidence, 'recovery-completed.json'), 'utf8'));
    assert.notEqual(result.pid, producer.pid);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.unchangedFacts, true);
    assert.equal(result.wrongActorRejected, true);
    console.log(JSON.stringify({ evidence, producerPid: producer.pid, recoveryPid: result.pid }));
    return { evidence, result };
  } finally {
    terminate(first.child);
    if (second) terminate(second.child);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 3, 'Pass SDK root, original SDK test config and Vitest CLI paths.');
  await proveNativeResultProcessRecovery({
    sdkRoot: resolve(args[0]),
    sdkConfig: resolve(args[1]),
    vitestPath: resolve(args[2]),
  });
}
