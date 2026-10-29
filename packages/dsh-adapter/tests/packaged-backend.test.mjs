import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PACKAGED_SDK_PIN,
  parseBackendArgs,
  inspectPackagedApp,
  backendLaunchPlan,
  createOutputSink,
} from '../../../scripts/server/packaged-backend.mjs';

const launcher = fileURLToPath(
  new URL('../../../scripts/server/packaged-backend.mjs', import.meta.url),
);
const shell = fileURLToPath(
  new URL('../../../scripts/server/packaged-backend.sh', import.meta.url),
);

// Public resource layout contract. A directory named app.asar is not an actual
// Electron/ASAR proof; the installed official CLI help is verified separately.
async function layout(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-packaged-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'App with spaces.app');
  const resources = join(app, 'Contents/Resources');
  const archive = join(resources, 'app.asar');
  const sdk = join(archive, 'dsh');
  const product = join(sdk, 'node_modules/@deepseek-ai/dsh-web-app/lib/zhuma-workbench');
  const cli = join(sdk, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
  const bin = join(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const executable = join(app, 'Contents/MacOS/Zhuma Renamed');
  await mkdir(product, { recursive: true });
  await mkdir(join(resources, 'runtime/primary-runtime'), { recursive: true });
  for (const file of [cli, bin, executable]) {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'public fixture');
  }
  await chmod(executable, 0o755);
  const desktop = { version: '1.1.0', dshBuildCommit: PACKAGED_SDK_PIN };
  const manifest = { name: '@zhuma/workbench', version: '1.1.0' };
  await writeFile(join(archive, 'package.json'), JSON.stringify(desktop));
  await writeFile(
    join(resources, 'runtime/primary-runtime/runtime.json'),
    JSON.stringify({ platform: 'darwin', arch: 'arm64' }),
  );
  await writeFile(join(product, 'package.json'), JSON.stringify(manifest));
  for (const file of ['index.js', 'member-web.js', 'LICENSE', 'THIRD_PARTY_LICENSES.txt'])
    await writeFile(join(product, file), 'public fixture');
  const plist = {
    CFBundleIdentifier: 'dev.zhuma.app',
    CFBundleExecutable: 'Zhuma Renamed',
    CFBundleShortVersionString: '1.1.0',
  };
  const readPlist = (path, key) => {
    assert.equal(path, join(app, 'Contents/Info.plist'));
    return plist[key];
  };
  return {
    root,
    app,
    resources,
    archive,
    product,
    cli,
    executable,
    desktop,
    manifest,
    plist,
    readPlist,
  };
}

test('packaged backend args: explicit app/data, normal local defaults and fixed repository SDK pin', async () => {
  const args = parseBackendArgs(['--app', '/Apps/Zhuma.app', '--data', '/data/backend']);
  assert.deepEqual(args, {
    app: '/Apps/Zhuma.app',
    data: '/data/backend',
    host: '127.0.0.1',
    port: 3080,
    fileUploads: false,
    independentReviews: false,
  });
  const lock = JSON.parse(
    await readFile(new URL('../../../runtime.lock.json', import.meta.url), 'utf8'),
  );
  assert.equal(PACKAGED_SDK_PIN, lock.upstreams.deepseekHarness.commit);
  assert.deepEqual(parseBackendArgs(['--help']), { help: true });
  assert.throws(() =>
    parseBackendArgs([
      '--app',
      '/Apps/Zhuma.app',
      '--data',
      '/data/backend',
      '--independent-reviews',
    ]),
  );
  assert.equal(
    parseBackendArgs([
      '--app',
      '/Apps/Zhuma.app',
      '--data',
      '/data/backend',
      '--file-uploads',
      '--independent-reviews',
    ]).independentReviews,
    true,
  );
  assert.equal(
    parseBackendArgs([
      '--app=/Apps/Zhuma.app',
      '--data=/data/backend',
      '--host',
      '::1',
      '--port',
      '4321',
      '--file-uploads',
    ]).fileUploads,
    true,
  );
});

for (const invalid of [
  [],
  ['--app', '/Apps/Zhuma.app'],
  ['--app', '', '--data', '/data/backend'],
  ['--app', '/Apps/Zhuma.app', '--data', '/Apps/Zhuma.app/data'],
  ['--app', '/Apps/Zhuma.app', '--data', '/data/backend', '--host', '0.0.0.0'],
  ['--app', '/Apps/Zhuma.app', '--data', '/data/backend', '--host', '::'],
  ['--app', '/Apps/Zhuma.app', '--data', '/data/backend', '--host', 'localhost'],
  ['--app', '/Apps/Zhuma.app', '--data', '/data/backend', '--port', '0'],
  ['--app', '/Apps/Zhuma.app', '--data', '/data/backend', '--port', '65536'],
  ['--app', '/Apps/Zhuma.app', '--data', '/data/backend', '--port', '1.5'],
  ['--app', '/Apps/Zhuma.app', '--data', '/data/backend', '--port', '1', '--port', '2'],
  ['--app', '/Apps/Zhuma.app', '--data', '/data/backend', '--sdk', '/source'],
])
  test(`packaged backend args: rejects ${JSON.stringify(invalid)}`, () =>
    assert.throws(() => parseBackendArgs(invalid)));

test('packaged backend layout: actual declared executable and original public CLI paths, no legacy launcher name', async (t) => {
  const f = await layout(t),
    value = await inspectPackagedApp(f.app, { readPlist: f.readPlist });
  assert.equal(value.executable, f.executable);
  assert.equal(value.cli, f.cli);
  assert.equal(value.plugin, join(f.product, 'index.js'));
  assert.equal(value.version, '1.1.0');
});

for (const invalid of [
  'old-member-web',
  'sdk-pin',
  'product-version',
  'identifier',
  'executable-traversal',
])
  test(`packaged backend layout: ${invalid} fails before data creation`, async (t) => {
    const f = await layout(t);
    if (invalid === 'old-member-web') await rm(join(f.product, 'member-web.js'));
    if (invalid === 'sdk-pin')
      await writeFile(
        join(f.archive, 'package.json'),
        JSON.stringify({ ...f.desktop, dshBuildCommit: '0'.repeat(40) }),
      );
    if (invalid === 'product-version')
      await writeFile(
        join(f.product, 'package.json'),
        JSON.stringify({ ...f.manifest, version: '1.0.0' }),
      );
    if (invalid === 'identifier') f.plist.CFBundleIdentifier = 'another.application';
    if (invalid === 'executable-traversal') f.plist.CFBundleExecutable = '../different';
    await assert.rejects(inspectPackagedApp(f.app, { readPlist: f.readPlist }));
    await assert.rejects(access(join(f.root, 'backend-data')));
  });

test('packaged backend plan: original web profile and member config; no git/pnpm/source dependency or inherited secret', async (t) => {
  const f = await layout(t),
    app = await inspectPackagedApp(f.app, { readPlist: f.readPlist });
  const options = parseBackendArgs(['--app', f.app, '--data', join(f.root, 'data')]);
  const plan = backendLaunchPlan(app, options, '/public/path');
  assert.equal(plan.executable, f.executable);
  assert.deepEqual(plan.args, [
    '--expose-internals',
    f.cli,
    '--profile',
    'web',
    '--patch',
    join(options.data, 'zhuma-server.patch.json'),
    '--host',
    '127.0.0.1',
    '--port',
    '3080',
    '--no-open',
  ]);
  assert.deepEqual(plan.env, {
    PATH: '/public/path',
    HOME: join(options.data, 'home'),
    DSH_HOME: join(options.data, 'dsh'),
    LANG: 'en_US.UTF-8',
    ELECTRON_RUN_AS_NODE: '1',
  });
  const config = plan.overlay[2].insert[0].config;
  assert.deepEqual(config, {
    deploymentMode: 'multi-member',
    localSetup: true,
    memberWeb: true,
    remoteExecution: true,
  });
  assert.equal(plan.overlay[1].disabled, true);
  assert.equal(plan.overlay[2].insert[0].name, app.plugin);
  assert.equal(
    backendLaunchPlan(app, { ...options, fileUploads: true }).overlay[2].insert[0].config
      .remoteFileUploads,
    true,
  );
  assert.doesNotMatch(plan.args.join(' '), /git|pnpm|apps\/cli|\.build/u);
});

test('packaged backend output: owner capability stays private, streams cannot corrupt each other', async () => {
  const privateValues = [],
    member = [],
    log = [];
  const sink = createOutputSink({
    operatorFile: 'owned-operator.txt',
    writePrivate: async (...args) => privateValues.push(args),
    member: (...args) => member.push(args),
    log: (x) => log.push(x),
  });
  sink.feed('dsh web: http://127.0.0.1:3080/?to', 'stdout');
  sink.feed('other stream log\n', 'stderr');
  sink.feed('ken=synthetic-capability\n', 'stdout');
  sink.feed('warning /?token=other-synthetic-value\n', 'stderr');
  await sink.finish();
  assert.deepEqual(privateValues, [
    ['owned-operator.txt', 'http://127.0.0.1:3080/?token=synthetic-capability\n'],
  ]);
  assert.deepEqual(member, [['http://127.0.0.1:3080/workbench', 'owned-operator.txt']]);
  assert.equal(log.join('\n').includes('synthetic-value'), false);
  assert.equal(log.join('\n').includes('synthetic-capability'), false);
});

test('packaged backend output: private URL write failure is observed and cannot announce a member entry', async () => {
  let failures = 0;
  const sink = createOutputSink({
    operatorFile: 'owned.txt',
    writePrivate: async () => {
      throw Error('contract write failure');
    },
    member: () => assert.fail('no announcement before durable private file'),
    log() {},
    failure() {
      failures++;
    },
  });
  sink.feed('dsh web: http://127.0.0.1:3080/?token=synthetic\n');
  await assert.rejects(sink.finish());
  assert.equal(failures, 1);
});

test('packaged backend public help and argument failure never boot an App/profile', () => {
  execFileSync('/bin/sh', ['-n', shell]);
  const help = spawnSync('/bin/sh', [shell, '--help'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--app/);
  const absent = spawnSync('/bin/sh', [shell], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(absent.status, 64);
  const nodeHelp = spawnSync(process.execPath, [launcher, '--help'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(nodeHelp.status, 0);
  assert.match(nodeHelp.stdout, /--data/);
  const bad = spawnSync(process.execPath, [launcher, '--sdk', 'not-supported'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /参数无效/u);
});
