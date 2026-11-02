/** Synthetic Windows carrier/tooling contracts; no native build, installation or GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corepackPnpmInvocation } from '../../../scripts/lib/corepack-pnpm.mjs';
import { desktopPackageTarget } from '../../../scripts/lib/desktop-package-target.mjs';
import {
  codeArtsLaunchFiles,
  packagedWorkbench,
} from '../../../scripts/lib/desktop-codearts-artifacts.mjs';
import {
  candidateWorkbenchFiles,
  verifyWindowsCandidateFiles,
} from '../../../scripts/lib/windows-candidate.mjs';

test('Windows Corepack uses its installed JavaScript entry with Unicode/spaces/ampersands as literal argv', () => {
  const executable = 'C:\\Program Files\\nodejs\\node.exe';
  const entry = 'C:\\工具 A & B\\node_modules\\corepack\\dist\\corepack.js';
  const args = ['run', 'package:desktop:win:x64:unsigned', '--build-version', '1.4.0'];
  assert.deepEqual(
    corepackPnpmInvocation(args, {
      platform: 'win32',
      execPath: executable,
      onPath: () => ['C:\\工具 A & B\\corepack.cmd'],
      exists: (file) => file === entry,
    }),
    [executable, [entry, 'pnpm', ...args]],
  );
  assert.throws(
    () =>
      corepackPnpmInvocation(args, {
        platform: 'win32',
        execPath: executable,
        onPath: () => ['C:\\工具 A & B\\corepack.cmd'],
        exists: () => false,
      }),
    /JavaScript entrypoint/u,
  );
  assert.deepEqual(
    corepackPnpmInvocation(args, {
      platform: 'darwin',
      onPath: () => assert.fail('No Windows lookup on Mac'),
    }),
    ['corepack', ['pnpm', ...args]],
  );
});

test('product package targets require the matching native platform and architecture', () => {
  assert.equal(
    desktopPackageTarget('win-x64', 'win32', 'x64').script,
    'package:desktop:win:x64:unsigned',
  );
  assert.equal(desktopPackageTarget('mac-arm64', 'darwin', 'arm64').extension, 'dmg');
  for (const args of [
    ['win-x64', 'darwin', 'x64'],
    ['win-x64', 'win32', 'arm64'],
    ['mac-arm64', 'win32', 'x64'],
    ['linux-x64', 'linux', 'x64'],
  ])
    assert.throws(() => desktopPackageTarget(...args));
});

test('Windows candidate checks source metadata, all nine workbench files, physical CodeArts and x64 application bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-win-candidate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = join(directory, 'artifacts'),
    workbench = join(directory, 'workbench');
  const resources = join(artifacts, 'win-unpacked/resources');
  await mkdir(workbench, { recursive: true });
  await mkdir(join(resources, 'app.asar.unpacked', packagedWorkbench), { recursive: true });
  const entries = new Map();
  const application = {
    name: '@deepseek-ai/dsh-desktop',
    version: '1.4.0',
    dshDesktopAppId: 'dev.zhuma.app',
    dshBuildCommit: 'c'.repeat(40),
    dshBuildDirty: true,
    zhumaSourceCommit: 'a'.repeat(40),
    zhumaSourceDirty: false,
  };
  entries.set('package.json', Buffer.from(JSON.stringify(application)));
  entries.set(
    'dsh/node_modules/@deepseek-ai/dsh/package.json',
    Buffer.from('{"version":"0.2.1-rc.4"}'),
  );
  for (const file of candidateWorkbenchFiles) {
    const bytes = Buffer.from(
      file === 'package.json'
        ? '{"name":"@zhuma/workbench","version":"1.4.0"}'
        : `synthetic ${file}`,
    );
    entries.set(`${packagedWorkbench}/${file}`, bytes);
    await writeFile(join(workbench, file), bytes);
    if (codeArtsLaunchFiles.includes(file))
      await writeFile(join(resources, 'app.asar.unpacked', packagedWorkbench, file), bytes);
  }
  await writeFile(join(resources, 'app.asar'), 'synthetic archive carrier');
  const pe = (machine, magic) => {
    const bytes = Buffer.alloc(128);
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 60);
    bytes.write('PE\0\0', 64, 'binary');
    bytes.writeUInt16LE(machine, 68);
    bytes.writeUInt16LE(magic, 88);
    return bytes;
  };
  const executable = join(artifacts, 'win-unpacked/Zhuma.exe');
  await writeFile(executable, pe(0x8664, 0x20b));
  await writeFile(join(artifacts, 'zhuma-1.4.0-win-x64-unsigned.exe'), pe(0x14c, 0x10b));
  const options = {
    artifacts,
    workbench,
    buildVersion: '1.4.0',
    productVersion: '1.4.0',
    source: application.zhumaSourceCommit,
    sdkPin: application.dshBuildCommit,
    sdkVersion: '0.2.1-rc.4',
    asar: {
      extractFile: (_, file) => {
        file = file.split(sep).join('/');
        assert(entries.has(file));
        return entries.get(file);
      },
      statFile: (_, file) => ({
        unpacked: codeArtsLaunchFiles.some((name) => file === join(packagedWorkbench, name)),
      }),
    },
  };
  assert.equal(Object.keys(verifyWindowsCandidateFiles(options).workbench).length, 9);
  assert.throws(
    () => verifyWindowsCandidateFiles({ ...options, source: 'b'.repeat(40) }),
    /commit differs/u,
  );
  entries.set(
    'package.json',
    Buffer.from(JSON.stringify({ ...application, zhumaSourceDirty: true })),
  );
  assert.throws(() => verifyWindowsCandidateFiles(options), /source was dirty/u);
  entries.set('package.json', Buffer.from(JSON.stringify(application)));
  const client = entries.get(`${packagedWorkbench}/client.js`);
  entries.set(`${packagedWorkbench}/client.js`, Buffer.from('stale bundle'));
  assert.throws(() => verifyWindowsCandidateFiles(options), /workbench bytes differ/u);
  entries.set(`${packagedWorkbench}/client.js`, client);
  await writeFile(executable, pe(0xaa64, 0x20b));
  assert.throws(() => verifyWindowsCandidateFiles(options), /application architecture/u);
  await writeFile(executable, pe(0x8664, 0x20b));
  await rm(join(resources, 'app.asar.unpacked', packagedWorkbench, 'codearts-acp.js'));
  assert.throws(() => verifyWindowsCandidateFiles(options), /ENOENT/u);
});

test(
  'Windows candidate CLI refuses another OS before reading a build or publishing anything',
  { skip: process.platform === 'win32' },
  () => {
    const entry = fileURLToPath(
      new URL('../../../scripts/desktop/verify-windows.mjs', import.meta.url),
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [entry, '--source-sha', 'a'.repeat(40)], { stdio: 'pipe' }),
      (error) => error.status === 1 && /on Windows/u.test(error.stderr.toString()),
    );
  },
);
