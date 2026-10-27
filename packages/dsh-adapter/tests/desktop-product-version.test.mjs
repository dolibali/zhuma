/** Patched-source/version contracts; no installer, signing, user profile or runtime build proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sdk = join(root, 'upstream/deepseek-harness');
const scripts = 'apps/desktop/scripts';
const productVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const buildVersion = JSON.parse(
  await readFile(join(root, 'branding/default/brand.json'), 'utf8'),
).desktopBuildVersion;
const runtimeVersion = JSON.parse(
  await readFile(join(sdk, 'apps/desktop/package.json'), 'utf8'),
).version;
async function patched(t) {
  const stage = await mkdtemp(join(tmpdir(), 'zhuma-product-version-contract-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const files = [
    'desktop-build-version.mjs',
    'desktop-build-version.d.mts',
    'package-target.ts',
    'electron-builder-config.mjs',
  ];
  for (const file of files) {
    const name = join(scripts, file);
    const target = join(stage, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sdk, name), target);
  }
  await copyFile(join(sdk, 'apps/desktop/package.json'), join(stage, 'apps/desktop/package.json'));
  await writeFile(join(stage, 'package.json'), '{"type":"module"}');
  await symlink(
    join(root, 'node_modules'),
    join(stage, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  execFileSync(
    'git',
    [
      'apply',
      ...files.map((file) => `--include=${scripts}/${file}`),
      join(root, 'patches/deepseek-harness/zhuma-desktop.patch'),
    ],
    { cwd: stage },
  );
  const version = await import(
    pathToFileURL(join(stage, scripts, 'desktop-build-version.mjs')).href
  );
  return { stage, version };
}
test('owned desktop version: P/B are explicit while absent P preserves SDK semantics and manifests remain R', async (t) => {
  const { stage, version: v } = await patched(t);
  const env = {
    [v.DESKTOP_PRODUCT_VERSION_ENV]: productVersion,
    [v.DESKTOP_BUILD_VERSION_ENV]: buildVersion,
  };
  assert.notEqual(productVersion, runtimeVersion);
  assert.equal(v.resolveDesktopProductVersion(env, runtimeVersion), productVersion);
  assert.equal(v.resolveDesktopBuildVersion(env, runtimeVersion), buildVersion);
  assert.equal(
    v.resolveDesktopBuildVersion(
      { [v.DESKTOP_PRODUCT_VERSION_ENV]: productVersion },
      runtimeVersion,
    ),
    productVersion,
  );
  assert.equal(v.resolveDesktopBuildVersion({}, runtimeVersion), runtimeVersion);
  assert.equal(
    v.resolveDesktopBuildVersion({ [v.DESKTOP_BUILD_VERSION_ENV]: '   ' }, runtimeVersion),
    runtimeVersion,
  );
  assert.equal(
    v.resolveDesktopBuildVersion(
      { [v.DESKTOP_BUILD_VERSION_ENV]: `${runtimeVersion}.20261027.1` },
      runtimeVersion,
    ),
    `${runtimeVersion}.20261027.1`,
  );
  assert.equal(
    v.resolveDesktopBuildVersion(
      {
        [v.DESKTOP_PRODUCT_VERSION_ENV]: '1.0.0',
        [v.DESKTOP_BUILD_VERSION_ENV]: '1.0.0-test.20261027.1',
      },
      runtimeVersion,
    ),
    '1.0.0-test.20261027.1',
  );
  assert.equal(
    v.resolveDesktopBuildVersion(
      {
        [v.DESKTOP_PRODUCT_VERSION_ENV]: '1.0.0-beta.2',
        [v.DESKTOP_BUILD_VERSION_ENV]: '1.0.0-beta.2.20261027.1',
      },
      runtimeVersion,
    ),
    '1.0.0-beta.2.20261027.1',
  );
  assert.equal(
    await readFile(join(stage, 'apps/desktop/package.json'), 'utf8'),
    await readFile(join(sdk, 'apps/desktop/package.json'), 'utf8'),
  );
});
test('owned desktop version refuses invalid P/B, metadata, unrelated release numbers and wrong suffixes through the original parser', async (t) => {
  const { version: v } = await patched(t);
  const env = { [v.DESKTOP_PRODUCT_VERSION_ENV]: '1.0.0' };
  for (const invalid of ['', 'nightly', '1.0.0.', '1.0.0+metadata'])
    assert.throws(() =>
      v.resolveDesktopBuildVersion(
        { ...env, [v.DESKTOP_PRODUCT_VERSION_ENV]: invalid },
        runtimeVersion,
      ),
    );
  for (const invalid of [
    'nightly',
    '1.0.0.',
    '1.0.0+metadata',
    '1.0.0-test.1+metadata',
    '2.0.0',
    runtimeVersion,
    '1.0.0-alpha.1',
    '1.0.0-test',
  ])
    assert.throws(() =>
      v.resolveDesktopBuildVersion(
        { ...env, [v.DESKTOP_BUILD_VERSION_ENV]: invalid },
        runtimeVersion,
      ),
    );
  assert.throws(
    () =>
      v.resolveDesktopBuildVersion({ [v.DESKTOP_BUILD_VERSION_ENV]: buildVersion }, runtimeVersion),
    /must extend/,
  );
  assert.throws(
    () =>
      v.resolveDesktopBuildVersion(
        {
          [v.DESKTOP_PRODUCT_VERSION_ENV]: '1.0.0-beta.2',
          [v.DESKTOP_BUILD_VERSION_ENV]: '1.0.0-beta.3',
        },
        runtimeVersion,
      ),
    /must extend/,
  );
});
test('original package main resolves P before the original requested-build validator; downstream resolver still receives unchanged R', async (t) => {
  const { stage, version: v } = await patched(t);
  const source = ts.createSourceFile(
    'package-target.ts',
    await readFile(join(stage, scripts, 'package-target.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const main = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'main',
  );
  const product = main.body.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) => d.name.getText(source) === 'productVersion'),
  );
  const resolveProduct = new Function(
    'environment',
    'resolveDesktopProductVersion',
    'packageVersion',
    'join',
    'APP_ROOT',
    `${product.getText(source)}; return productVersion;`,
  );
  const requested = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveRequestedBuildVersion',
  );
  const compiled = ts.transpileModule(
    requested.getText(source).replace('async function', 'export async function'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  await writeFile(
    join(stage, scripts, 'requested-fixture.mjs'),
    `import {validateDesktopBuildVersion} from './desktop-build-version.mjs';\nconst AUTOMATIC_BUILD_VERSION = 'auto';\n${compiled}`,
  );
  const { resolveRequestedBuildVersion } = await import(
    pathToFileURL(join(stage, scripts, 'requested-fixture.mjs')).href
  );
  const env = { [v.DESKTOP_PRODUCT_VERSION_ENV]: productVersion };
  const resolved = resolveProduct(
    env,
    v.resolveDesktopProductVersion,
    () => runtimeVersion,
    join,
    'fixture-app',
  );
  assert.equal(resolved, productVersion);
  assert.equal(
    await resolveRequestedBuildVersion({ requestedBuildVersion: buildVersion }, resolved, env),
    buildVersion,
  );
  assert.equal(
    v.resolveDesktopBuildVersion(
      { ...env, [v.DESKTOP_BUILD_VERSION_ENV]: buildVersion },
      runtimeVersion,
    ),
    buildVersion,
  );
  await assert.rejects(
    resolveRequestedBuildVersion({ requestedBuildVersion: '2.0.0' }, resolved, env),
    /must extend product version/,
  );
});
test('original electron-builder config writes installed B but keeps the runtime-tree expectation at R and retains platform flag guards', async (t) => {
  const { stage, version: v } = await patched(t);
  const source = ts.createSourceFile(
    'electron-builder-config.mjs',
    await readFile(join(stage, scripts, 'electron-builder-config.mjs'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'createElectronBuilderConfig',
  );
  // Execute the original function body. Only its independent packaging services are fixture ports.
  const key = '__zhumaProductVersionConfigContract';
  globalThis[key] = {
    resolveDesktopAppId: () => 'dev.zhuma.app',
    resolveDesktopBuildCommit: () => undefined,
    resolveDesktopBuildTarget: () => 'mac-arm64',
    desktopTargetBuildPaths: () => ({
      root: 'fixture-root',
      dsh: 'fixture-sdk-runtime',
      runtime: 'fixture-node',
      electron: 'fixture-electron',
    }),
    desktopArtifactOutput: () => ({ directory: 'fixture-artifacts', suffix: '-unsigned' }),
  };
  t.after(() => delete globalThis[key]);
  await writeFile(
    join(stage, scripts, 'config-fixture.mjs'),
    `import {readFileSync} from 'node:fs';\nimport {join} from 'node:path';\nimport {fileURLToPath} from 'node:url';\nimport {resolveDesktopBuildVersion} from './desktop-build-version.mjs';\nconst {${Object.keys(globalThis[key]).join(',')}}=globalThis.${key};\n${declaration.getText(source)}`,
  );
  const runtimePath = join(stage, 'apps/desktop/lib/types/runtime-tree.js');
  await mkdir(dirname(runtimePath), { recursive: true });
  await writeFile(
    runtimePath,
    `export const calls=[]; export async function verifyDesktopRuntime(root,version,target){calls.push({root,version,target});if(version!==${JSON.stringify(runtimeVersion)})throw Error('fixture SDK version mismatch');}`,
  );
  const { createElectronBuilderConfig } = await import(
    pathToFileURL(join(stage, scripts, 'config-fixture.mjs')).href
  );
  const env = {
    DSH_DESKTOP_UNSIGNED: '1',
    [v.DESKTOP_PRODUCT_VERSION_ENV]: productVersion,
    [v.DESKTOP_BUILD_VERSION_ENV]: buildVersion,
  };
  const config = createElectronBuilderConfig(env, 'darwin', 'arm64');
  assert.equal(config.extraMetadata.version, buildVersion);
  assert.equal(config.productName, 'Zhuma');
  assert.equal(config.mac.forceCodeSigning, false);
  await config.afterPack({
    appOutDir: 'fixture-app',
    packager: { getResourcesDir: () => 'fixture-resources' },
  });
  const { calls } = await import(pathToFileURL(runtimePath).href);
  assert.deepEqual(calls, [
    {
      root: 'fixture-sdk-runtime',
      version: runtimeVersion,
      target: { platform: 'darwin', arch: 'arm64' },
    },
  ]);
  assert.equal(
    createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64').extraMetadata
      .version,
    undefined,
  );
  assert.throws(
    () => createElectronBuilderConfig({ ...env, DSH_DESKTOP_UNSIGNED: '2' }, 'darwin', 'arm64'),
    /must be 0 or 1/,
  );
  assert.throws(
    () =>
      createElectronBuilderConfig(
        { ...env, DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '1' },
        'darwin',
        'arm64',
      ),
    /Skipping notarization/,
  );
});
test('patched desktop product-version declarations expose the same literal key and typed resolver', async (t) => {
  const { stage } = await patched(t);
  const source = join(stage, 'version-contract.mts');
  await writeFile(
    source,
    `import {DESKTOP_PRODUCT_VERSION_ENV,resolveDesktopProductVersion,resolveDesktopBuildVersion} from './${scripts}/desktop-build-version.mjs';\nconst key:'ZHUMA_DESKTOP_PRODUCT_VERSION'=DESKTOP_PRODUCT_VERSION_ENV;\nconst version:string=resolveDesktopBuildVersion({[key]:'1.0.0'},resolveDesktopProductVersion({},'0.2.1-rc.2'));\n// @ts-expect-error An explicit product version must be a string.\nresolveDesktopProductVersion({[key]:1},'0.2.1-rc.2');\nvoid version;`,
  );
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--types',
      'node',
      '--skipLibCheck',
      source,
    ],
    { cwd: stage, stdio: 'pipe' },
  );
});
