#!/usr/bin/env node
/** Original patch preparation and ASAR writer probes; no full package, CLI, profile or model. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  codeArtsLaunchFiles,
  packagedWorkbench,
  verifyPackagedCodeArts,
} from '../lib/desktop-codearts-artifacts.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { sdk: { type: 'string' }, output: { type: 'string' } } });
if (!values.sdk) throw Error('Pass --sdk with the installed, fixed official SDK toolchain.');
const sdk = resolve(values.sdk),
  source = join(root, 'upstream/deepseek-harness');
const pin = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8')).upstreams
  .deepseekHarness.commit;
for (const cwd of [sdk, source])
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), pin);
const request = createRequire(join(sdk, 'apps/desktop/package.json'));
const asar = createRequire(request.resolve('app-builder-lib/package.json'))('@electron/asar');
const { AsarPackager } = request('app-builder-lib/out/asar/asarUtil.js');
const { FileMatcher } = request('app-builder-lib/out/fileMatcher.js');
const directory = await mkdtemp(join(tmpdir(), 'zhuma-runtime-packaging-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  const stage = join(directory, 'sdk');
  await mkdir(stage);
  const archive = execFileSync(
    'git',
    [
      'archive',
      pin,
      'apps/desktop/scripts',
      'scripts',
      'apps/desktop/package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      'patches',
    ],
    { cwd: source, maxBuffer: 32 * 1024 * 1024 },
  );
  execFileSync('tar', ['-xf', '-', '-C', stage], { input: archive });
  await writeFile(join(stage, 'package.json'), '{"type":"module"}');
  await symlink(join(sdk, 'node_modules'), join(stage, 'node_modules'), 'dir');
  await symlink(
    join(sdk, 'apps/desktop/node_modules'),
    join(stage, 'apps/desktop/node_modules'),
    'dir',
  );
  execFileSync('git', ['init', '--quiet'], { cwd: stage });
  execFileSync(
    'git',
    [
      'apply',
      '--include=apps/desktop/scripts/*',
      '--include=scripts/*',
      '--include=pnpm-workspace.yaml',
      '--include=pnpm-lock.yaml',
      '--include=patches/*',
      join(root, 'patches/deepseek-harness/zhuma-desktop.patch'),
    ],
    { cwd: stage },
  );

  const policy = 'apps/desktop/scripts/runtime-patch-policy.ts';
  const policyFile = join(stage, policy),
    nextPolicy = await readFile(policyFile);
  const oldPolicy = await readFile(join(source, policy));
  const project = join(directory, 'runtime');
  await mkdir(project);
  await writeFile(join(project, 'pnpm-workspace.yaml'), 'packages: ["."]\n');
  const probe = `import {prepareRuntimePatches} from ${JSON.stringify(pathToFileURL(join(stage, 'apps/desktop/scripts/prepare-runtime-patches.ts')).href)};
    console.log(JSON.stringify(prepareRuntimePatches(${JSON.stringify(project)}, ${JSON.stringify(stage)})));`;
  function prepare() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  }
  await writeFile(policyFile, oldPolicy);
  const before = prepare();
  assert.equal(before.status, 1);
  assert.match(
    before.stderr,
    /classify the workspace patch @zaimokuza\/dsh-acp-adapter@0\.2\.1-rc\.4\.1/u,
  );
  await writeFile(policyFile, nextPolicy);
  const after = prepare();
  assert.equal(after.status, 0, after.stderr);
  const plan = JSON.parse(after.stdout);
  const acp = plan.patches.find(
    (entry) => entry.spec === '@zaimokuza/dsh-acp-adapter@0.2.1-rc.4.1',
  );
  assert(acp);
  const originalPatch = await readFile(
    join(root, 'patches/dsh-acp-adapter/published-package.patch'),
  );
  assert.equal(acp.hash, hash(originalPatch));
  assert((await readFile(join(project, acp.path))).equals(originalPatch));
  const workspace = join(stage, 'pnpm-workspace.yaml'),
    settings = await readFile(workspace);
  // Unknown future patches still fail the original explicit classification guard.
  const yaml = request('js-yaml');
  const unknown = yaml.load(settings.toString());
  unknown.patchedDependencies['unknown-probe@1.0.0'] = 'patches/absent.patch';
  await writeFile(workspace, yaml.dump(unknown));
  const unknownResult = prepare();
  assert.equal(unknownResult.status, 1);
  assert.match(unknownResult.stderr, /classify the workspace patch unknown-probe@1\.0\.0/u);
  await writeFile(workspace, settings);
  const sharedFile = join(stage, 'patches/zhuma-dsh-acp-adapter.patch');
  await writeFile(sharedFile, Buffer.concat([originalPatch, Buffer.from('\n')]));
  const changedResult = prepare();
  assert.equal(changedResult.status, 1);
  assert.match(changedResult.stderr, /shared patch hash differs from the root lockfile/u);
  await writeFile(sharedFile, originalPatch);

  const configName = 'apps/desktop/scripts/electron-builder-config.mjs';
  const configFile = join(stage, configName),
    nextConfig = await readFile(configFile);
  const env = {
    DSH_DESKTOP_APP_ID: 'dev.zhuma.probe',
    DSH_DESKTOP_UNSIGNED: '1',
    DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
    DSH_DESKTOP_TARGET_ARCH: 'arm64',
  };
  async function configuration(generation) {
    const { createElectronBuilderConfig } = await import(
      pathToFileURL(configFile).href + `?${generation}`
    );
    return createElectronBuilderConfig(env, 'darwin', 'arm64');
  }
  const input = join(directory, 'app');
  // Match the real recipe: files.from is a separate runtime tree, files.to is app/dsh.
  const runtime = join(directory, 'prepared-runtime', 'dsh');
  const runtimeWorkbench = packagedWorkbench.slice('dsh/'.length);
  await mkdir(input);
  await mkdir(join(runtime, runtimeWorkbench), { recursive: true });
  for (const file of codeArtsLaunchFiles)
    await cp(join(root, '.build/workbench', file), join(runtime, runtimeWorkbench, file));
  await writeFile(join(input, 'package.json'), '{"name":"probe","version":"1.0.0"}');
  async function pack(config, name) {
    const resources = join(directory, name);
    await mkdir(resources);
    async function fileSet(src, destination) {
      const files = (await readdir(src, { recursive: true })).map((file) => join(src, file));
      const metadata = new Map(
        await Promise.all(files.map(async (file) => [file, await stat(file)])),
      );
      return { src, destination, files, metadata };
    }
    const unpackPattern = new FileMatcher(
      input,
      input,
      (value) => value,
      config.asarUnpack,
    ).createFilter();
    await new AsarPackager(
      { info: { getWorkspaceRoot: async () => directory } },
      {
        resourcePath: resources,
        defaultDestination: input,
        options: { smartUnpack: false },
        unpackPattern,
      },
    ).pack([await fileSet(input, input), await fileSet(runtime, join(input, 'dsh'))]);
    return resources;
  }
  await writeFile(configFile, await readFile(join(source, configName)));
  const oldResources = await pack(await configuration('before'), 'before-resources');
  assert.throws(
    () => verifyPackagedCodeArts(oldResources, join(root, '.build/workbench'), asar),
    /must be unpacked|ENOENT/u,
  );
  await writeFile(configFile, nextConfig);
  const resources = await pack(await configuration('after'), 'after-resources');
  const hashes = verifyPackagedCodeArts(resources, join(root, '.build/workbench'), asar);
  const physical = join(resources, 'app.asar.unpacked', packagedWorkbench);
  const readProbe = `const fs=require('node:fs'),crypto=require('node:crypto');console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(file=>[require('node:path').basename(file),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))));`;
  for (const executable of [process.execPath, request('electron')]) {
    const result = spawnSync(
      executable,
      ['-e', readProbe, ...codeArtsLaunchFiles.map((file) => join(physical, file))],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), hashes);
    for (const file of ['codearts-acp.js', 'codearts-policy.js']) {
      const syntax = spawnSync(executable, ['--check', join(physical, file)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
  const adapter = join(physical, 'codearts-acp.js');
  const bytes = await readFile(adapter);
  await writeFile(adapter, Buffer.concat([bytes, Buffer.from('\n')]));
  assert.throws(
    () => verifyPackagedCodeArts(resources, join(root, '.build/workbench'), asar),
    /bytes differ/u,
  );
  await rm(adapter);
  assert.throws(
    () => verifyPackagedCodeArts(resources, join(root, '.build/workbench'), asar),
    /ENOENT/u,
  );
  const report = {
    scope: 'original-runtime-patch-stage-and-small-asar-writer-contract',
    sdkPin: pin,
    oldUnclassifiedPatchRejected: true,
    sharedAcpPatchSha256: acp.hash,
    unknownPatchRejected: true,
    changedSharedPatchRejected: true,
    oldAsarOnlyCarrierRejected: true,
    physicalCodeArtsHashes: hashes,
    plainNodeAndElectronReadSameBytes: true,
    syntaxCheckedWithoutExecution: true,
    modifiedAndMissingPhysicalFilesRejected: true,
    limits: [
      'No complete production install, app signing, DMG, GUI, CLI, model or business acceptance.',
    ],
  };
  if (values.output)
    await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
