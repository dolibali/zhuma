/** Bind extra release assets to one accepted main source. No models or deployment. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { candidateFileRecord, windowsInstallerNames } from './windows-candidate.mjs';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const qualifiedFiles = [
  'portable.tar.gz',
  'backend-image.tar',
  'SOURCE.json',
  'IMAGE_ID',
  'STOP.json',
];
const shaPattern = /^[a-f0-9]{64}$/u;
const positiveId = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export async function serverQualification(context, runId, api) {
  assert(
    /^[1-9][0-9]*$/u.test(String(runId)),
    'Pass the completed exact-main Linux qualification run ID.',
  );
  const prefix = `repos/${context.repository}/actions`;
  const run = await api(`${prefix}/runs/${runId}`);
  assert.equal(String(run.id), String(runId));
  assert.equal(run.path, '.github/workflows/linux-server-qualification.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, context.source);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert(positiveId(run.id) && positiveId(run.run_attempt));
  const jobs = await api(`${prefix}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  assert.equal(
    jobs.total_count,
    jobs.jobs.length,
    'Qualification jobs must fit the exact bounded response.',
  );
  assert.equal(
    jobs.jobs.filter((job) => job.name === 'qualify' && job.conclusion === 'success').length,
    1,
  );
  assert.equal(
    jobs.jobs.filter((job) => job.name === 'native-probe' && job.conclusion === 'skipped').length,
    1,
  );
  const listed = await api(`${prefix}/runs/${run.id}/artifacts?per_page=100`);
  assert.equal(listed.total_count, listed.artifacts.length);
  const matches = listed.artifacts.filter(
    (item) => item.name === `linux-server-amd64-${context.source}`,
  );
  assert.equal(matches.length, 1, 'One qualified production artifact is required.');
  const artifact = matches[0];
  assert(positiveId(artifact.id) && artifact.expired === false && artifact.size_in_bytes > 0);
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(artifact.workflow_run.id, run.id);
  assert.equal(artifact.workflow_run.head_sha, context.source);
  assert.equal(artifact.workflow_run.head_branch, 'main');
  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    source: context.source,
    artifactId: artifact.id,
    artifactDigest: artifact.digest,
    artifactBytes: artifact.size_in_bytes,
  };
}

export function unpackServerArtifact(context, receipt, archive, directory) {
  assert.equal(receipt.source, context.source);
  assert.equal(`sha256:${candidateFileRecord(archive).sha256}`, receipt.artifactDigest);
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(
    entries.sort(),
    [...qualifiedFiles, 'SHA256SUMS'].sort(),
    'Unexpected qualification archive entries.',
  );
  mkdirSync(directory); // Refuse an existing intake; never overwrite other evidence.
  execFileSync('unzip', ['-q', archive, '-d', directory], { stdio: 'pipe' });
  verifyQualifiedServer(context, directory);
}

function sourceIdentity(context, source, platform) {
  assert.equal(source.schemaVersion, 1);
  if (platform === 'windows') {
    assert.equal(source.scope, 'unsigned-windows-candidate');
    assert.equal(source.sourceCommit, context.source);
    assert.equal(source.sourceTree, context.tree);
    assert.equal(source.version, context.version);
    assert.equal(source.buildVersion, context.version);
    assert.equal(source.sdkPin, context.sdkPin);
    assert.equal(source.sdkVersion, context.sdkVersion);
    assert.equal(source.locks.workspace, context.rootLockSha256);
    assert.deepEqual(source.target, { platform: 'win32', arch: 'x64', buildMode: 'unsigned' });
  } else {
    assert.equal(source.product.commit, context.source);
    assert.equal(source.product.tree, context.tree);
    assert.equal(source.product.version, context.version);
    assert.equal(source.product.lockSha256, context.rootLockSha256);
    assert.equal(source.sdk.commit, context.sdkPin);
    assert.equal(source.sdk.version, context.sdkVersion);
    assert.deepEqual(source.runtime, { platform: 'linux', arch: 'x64', node: '24.15.0' });
    assert(Array.isArray(source.files) && source.files.length > 0);
  }
}

function exactSums(directory, names) {
  const records = Object.fromEntries(
    names.map((name) => [name, candidateFileRecord(join(directory, name))]),
  );
  const expected = names.map((name) => `${records[name].sha256}  ${name}\n`).join('');
  assert.equal(
    readFileSync(join(directory, 'SHA256SUMS'), 'utf8'),
    expected,
    'Qualification hashes differ.',
  );
  return records;
}

export function verifyQualifiedServer(context, directory) {
  assert.deepEqual(readdirSync(directory).sort(), [...qualifiedFiles, 'SHA256SUMS'].sort());
  const records = exactSums(directory, qualifiedFiles);
  const source = json(join(directory, 'SOURCE.json'));
  sourceIdentity(context, source, 'server');
  const inside = execFileSync(
    'tar',
    ['-xOzf', join(directory, 'portable.tar.gz'), './SOURCE.json'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  assert(
    inside.equals(readFileSync(join(directory, 'SOURCE.json'))),
    'Portable and external source manifests differ.',
  );
  const imageId = readFileSync(join(directory, 'IMAGE_ID'), 'utf8');
  assert.match(imageId, /^sha256:[a-f0-9]{64}\n$/u);
  const image = join(directory, 'backend-image.tar');
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', image, 'manifest.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }),
  );
  assert(Array.isArray(manifest) && manifest.length === 1);
  assert.deepEqual(manifest[0].RepoTags, [`zhuma-backend:${context.source}`]);
  assert.match(manifest[0].Config, /^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/u);
  const bytes = execFileSync('tar', ['-xOf', image, manifest[0].Config], {
    maxBuffer: 1024 * 1024,
  });
  assert.equal(`sha256:${digest(bytes)}\n`, imageId);
  const config = JSON.parse(bytes);
  assert.equal(config.os, 'linux');
  assert.equal(config.architecture, 'amd64');
  assert.equal(config.config.User, '10001:10001');
  assert.deepEqual(config.config.Entrypoint, ['node', '/app/start.mjs']);
  const stop = json(join(directory, 'STOP.json'));
  assert([0, 1].includes(stop.exitCode));
  assert.equal(stop.scope, 'idle process stop; no business Run drain proof');
  return { records, imageId: imageId.trim(), stop };
}

export async function assemblePlatformAssets(context, windows, server, receipt, output) {
  assert.equal(receipt.source, context.source);
  const installer = windowsInstallerNames(context.version).product;
  const winSource = json(join(windows, 'SOURCE.json'));
  sourceIdentity(context, winSource, 'windows');
  const winRecords = exactSums(windows, [
    installer,
    'SOURCE.json',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ]);
  assert.deepEqual(winSource.material.installer, winRecords[installer]);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    assert(readFileSync(join(windows, file)).equals(readFileSync(join(context.root, file))));
  const verified = verifyQualifiedServer(context, server);
  const assets = [];
  const copy = (directory, from, to) => {
    copyFileSync(join(directory, from), join(output, to));
    assets.push({ name: to, ...candidateFileRecord(join(output, to)) });
  };
  copy(windows, installer, installer);
  copy(windows, 'SOURCE.json', 'windows-SOURCE.json');
  copy(server, 'SOURCE.json', 'server-SOURCE.json');
  const portable = `zhuma-${context.version}-server-linux-amd64-portable.tar.gz`;
  const image = `zhuma-${context.version}-server-linux-amd64-image.tar.gz`;
  const deployment = `zhuma-${context.version}-deployment.tar.gz`;
  copy(server, 'portable.tar.gz', portable);
  // Recompress the exact qualified Docker SAVE, without rebuilding or importing it.
  const originalHash = createHash('sha256');
  let originalBytes = 0;
  await pipeline(
    createReadStream(join(server, 'backend-image.tar')),
    new Transform({
      transform(bytes, _encoding, done) {
        originalBytes += bytes.length;
        originalHash.update(bytes);
        done(null, bytes);
      },
    }),
    createGzip(),
    createWriteStream(join(output, image), { flags: 'wx' }),
  );
  assert.deepEqual(
    { bytes: originalBytes, sha256: originalHash.digest('hex') },
    verified.records['backend-image.tar'],
  );
  assets.push({ name: image, ...candidateFileRecord(join(output, image)) });
  execFileSync(
    'git',
    [
      'archive',
      '--format=tar.gz',
      `--output=${join(output, deployment)}`,
      context.source,
      'distribution/server',
    ],
    { cwd: context.root, stdio: 'pipe' },
  );
  assets.push({ name: deployment, ...candidateFileRecord(join(output, deployment)) });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) copy(context.root, file, file);
  return {
    windows: { source: 'windows-SOURCE.json', installer },
    server: {
      source: 'server-SOURCE.json',
      portable,
      image,
      deployment,
      qualification: receipt,
      ...verified,
    },
    assets,
  };
}

export async function verifyPlatformAssets(context, directory, platforms) {
  assert(
    platforms && Array.isArray(platforms.assets),
    'Both Windows and qualified Linux release assets are required.',
  );
  const expected = [
    windowsInstallerNames(context.version).product,
    'windows-SOURCE.json',
    'server-SOURCE.json',
    `zhuma-${context.version}-server-linux-amd64-portable.tar.gz`,
    `zhuma-${context.version}-server-linux-amd64-image.tar.gz`,
    `zhuma-${context.version}-deployment.tar.gz`,
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ];
  assert.deepEqual(
    platforms.assets.map((item) => item.name),
    expected,
  );
  for (const item of platforms.assets) {
    assert.match(item.sha256, shaPattern);
    assert.deepEqual(candidateFileRecord(join(directory, item.name)), {
      bytes: item.bytes,
      sha256: item.sha256,
    });
  }
  assert.equal(platforms.windows.source, 'windows-SOURCE.json');
  assert.equal(platforms.windows.installer, expected[0]);
  assert.equal(platforms.server.source, 'server-SOURCE.json');
  assert.equal(platforms.server.portable, expected[3]);
  assert.equal(platforms.server.image, expected[4]);
  assert.equal(platforms.server.deployment, expected[5]);
  const winSource = json(join(directory, platforms.windows.source));
  sourceIdentity(context, winSource, 'windows');
  sourceIdentity(context, json(join(directory, platforms.server.source)), 'server');
  assert.deepEqual(winSource.material.installer, candidateFileRecord(join(directory, expected[0])));
  const { records, imageId, stop } = platforms.server;
  assert.deepEqual(Object.keys(records), qualifiedFiles);
  for (const value of Object.values(records)) {
    assert(Number.isSafeInteger(value.bytes) && value.bytes > 0);
    assert.match(value.sha256, shaPattern);
  }
  assert.deepEqual(
    records['SOURCE.json'],
    candidateFileRecord(join(directory, 'server-SOURCE.json')),
  );
  assert.deepEqual(records['portable.tar.gz'], candidateFileRecord(join(directory, expected[3])));
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
  assert([0, 1].includes(stop.exitCode));
  assert.equal(stop.scope, 'idle process stop; no business Run drain proof');
  const receipt = platforms.server.qualification;
  assert.equal(receipt.source, context.source);
  assert(
    positiveId(receipt.runId) && positiveId(receipt.runAttempt) && positiveId(receipt.artifactId),
  );
  assert.match(receipt.artifactDigest, /^sha256:[a-f0-9]{64}$/u);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    assert(readFileSync(join(directory, file)).equals(readFileSync(join(context.root, file))));
  const original = records['backend-image.tar'],
    hash = createHash('sha256');
  let bytes = 0;
  await pipeline(
    createReadStream(join(directory, platforms.server.image)),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > original.bytes) {
          done(new Error('Decompressed image exceeds the qualified byte length.'));
          return;
        }
        hash.update(chunk);
        done();
      },
    }),
  );
  assert.deepEqual(
    { bytes, sha256: hash.digest('hex') },
    original,
    'Decompressed image differs from the qualified Docker SAVE.',
  );
  return platforms.assets;
}
