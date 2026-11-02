/** Candidate byte/metadata guards, independent of installation or GUI acceptance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { packagedWorkbench, verifyPackagedCodeArts } from './desktop-codearts-artifacts.mjs';

export const candidateWorkbenchFiles = Object.freeze([
  'index.js',
  'client.js',
  'member-web.js',
  'package.json',
  'LICENSE',
  'THIRD_PARTY_LICENSES.txt',
  'codearts-acp.js',
  'codearts-acp.manifest.json',
  'codearts-policy.js',
]);
export function candidateFileRecord(file) {
  assert(lstatSync(file).isFile(), 'Candidate material must be a regular file.');
  const fd = openSync(file, 'r'),
    buffer = Buffer.alloc(1024 * 1024),
    hash = createHash('sha256');
  let bytes = 0;
  try {
    for (;;) {
      const size = readSync(fd, buffer);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
      bytes += size;
    }
  } finally {
    closeSync(fd);
  }
  assert(bytes > 0, 'Candidate material is empty.');
  return { bytes, sha256: hash.digest('hex') };
}
export function assertWindowsPE(file, machine) {
  const fd = openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    assert.equal(readSync(fd, dos, 0, dos.length, 0), dos.length, 'Missing DOS header.');
    assert.equal(dos.toString('ascii', 0, 2), 'MZ', 'Missing Windows executable.');
    const pe = Buffer.alloc(26);
    assert.equal(
      readSync(fd, pe, 0, pe.length, dos.readUInt32LE(60)),
      pe.length,
      'Missing PE header.',
    );
    assert.equal(pe.toString('binary', 0, 4), 'PE\0\0', 'Invalid PE header.');
    if (machine !== undefined) {
      assert.equal(pe.readUInt16LE(4), machine, 'Wrong Windows application architecture.');
      assert.equal(pe.readUInt16LE(24), 0x20b, 'Windows x64 application must use PE32+.');
    }
  } finally {
    closeSync(fd);
  }
}
export function verifyWindowsCandidateFiles({
  artifacts,
  workbench,
  buildVersion,
  productVersion,
  source,
  sdkPin,
  sdkVersion,
  asar,
}) {
  const resources = join(artifacts, 'win-unpacked/resources'),
    archive = join(resources, 'app.asar');
  const application = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert.equal(application.name, '@deepseek-ai/dsh-desktop');
  assert.equal(application.version, buildVersion, 'Wrong packaged build version.');
  assert.equal(application.dshDesktopAppId, 'dev.zhuma.app');
  assert.equal(application.zhumaSourceCommit, source, 'Packaged product commit differs.');
  assert.equal(application.zhumaSourceDirty, false, 'Packaged product source was dirty.');
  assert.equal(application.dshBuildCommit, sdkPin, 'Packaged SDK commit differs.');
  assert.equal(
    application.dshBuildDirty,
    true,
    'Product patches must remain explicit SDK changes.',
  );
  const sdk = JSON.parse(
    asar.extractFile(archive, 'dsh/node_modules/@deepseek-ai/dsh/package.json').toString(),
  );
  assert.equal(sdk.version, sdkVersion, 'SDK and product versions must remain separate.');
  const files = Object.fromEntries(
    candidateWorkbenchFiles.map((file) => {
      const bytes = asar.extractFile(archive, `${packagedWorkbench}/${file}`);
      assert(bytes.equals(readFileSync(join(workbench, file))), 'Packaged workbench bytes differ.');
      assert(bytes.length > 0);
      return [
        file,
        { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      ];
    }),
  );
  const plugin = JSON.parse(
    asar.extractFile(archive, `${packagedWorkbench}/package.json`).toString(),
  );
  assert.equal(plugin.name, '@zhuma/workbench');
  assert.equal(plugin.version, productVersion);
  const codeArts = verifyPackagedCodeArts(resources, workbench, asar);
  const executable = join(artifacts, 'win-unpacked/Zhuma.exe');
  assertWindowsPE(executable, 0x8664);
  const installer = join(artifacts, `zhuma-${buildVersion}-win-x64-unsigned.exe`);
  // The NSIS bootstrap can be x86 even for an x64 application.
  assertWindowsPE(installer);
  return {
    application: candidateFileRecord(executable),
    archive: candidateFileRecord(archive),
    installer: candidateFileRecord(installer),
    workbench: files,
    physicalCodeArts: codeArts,
    provenance: {
      productCommit: application.zhumaSourceCommit,
      productDirty: application.zhumaSourceDirty,
      sdkCommit: application.dshBuildCommit,
      sdkDirty: application.dshBuildDirty,
    },
  };
}
