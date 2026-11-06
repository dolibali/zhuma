/** Synthetic release assets only. Never a real installer, image or qualification. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const serverReceipt = (context) => ({
  runId: 77,
  runAttempt: 1,
  source: context.source,
  artifactId: 88,
  artifactDigest: `sha256:${'9'.repeat(64)}`,
  artifactBytes: 100,
});
export const platformNames = (context) => [
  `zhuma-${context.version}-windows-x64-unsigned.exe`,
  'windows-SOURCE.json',
  'server-SOURCE.json',
  `zhuma-${context.version}-server-linux-amd64-portable.tar.gz`,
  `zhuma-${context.version}-server-linux-amd64-image.tar.gz`,
  `zhuma-${context.version}-deployment.tar.gz`,
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];
export function windowsSource(context, installer) {
  return {
    schemaVersion: 1,
    scope: 'unsigned-windows-candidate',
    sourceCommit: context.source,
    sourceTree: context.tree,
    version: context.version,
    buildVersion: context.version,
    sdkPin: context.sdkPin,
    sdkVersion: context.sdkVersion,
    locks: { workspace: context.rootLockSha256 },
    target: { platform: 'win32', arch: 'x64', buildMode: 'unsigned' },
    material: { installer: { bytes: installer.length, sha256: sha(installer) } },
  };
}
export function serverSource(context) {
  return {
    schemaVersion: 1,
    product: {
      version: context.version,
      commit: context.source,
      tree: context.tree,
      lockSha256: context.rootLockSha256,
    },
    sdk: { commit: context.sdkPin, version: context.sdkVersion },
    runtime: { platform: 'linux', arch: 'x64', node: '24.15.0' },
    files: [{ path: 'SYNTHETIC_CONTRACT_ONLY', type: 'file', bytes: 1, sha256: sha('x') }],
  };
}
export async function publishedPlatformFixture(context, directory) {
  const names = platformNames(context),
    installer = Buffer.from('SYNTHETIC_EXE_CONTRACT_ONLY'),
    rawImage = Buffer.from('SYNTHETIC_IMAGE_CONTRACT_ONLY');
  const content = [
    installer,
    JSON.stringify(windowsSource(context, installer)),
    JSON.stringify(serverSource(context)),
    'SYNTHETIC_PORTABLE_CONTRACT_ONLY',
    gzipSync(rawImage),
    'SYNTHETIC_DEPLOYMENT_CONTRACT_ONLY',
    await readFile(join(context.root, 'LICENSE')),
    await readFile(join(context.root, 'THIRD_PARTY_NOTICES.md')),
  ];
  const assets = [];
  for (let i = 0; i < names.length; i++) {
    const bytes = Buffer.from(content[i]);
    await writeFile(join(directory, names[i]), bytes);
    assets.push({ name: names[i], bytes: bytes.length, sha256: sha(bytes) });
  }
  return {
    windows: { source: names[1], installer: names[0] },
    server: {
      source: names[2],
      portable: names[3],
      image: names[4],
      deployment: names[5],
      qualification: serverReceipt(context),
      records: Object.fromEntries(
        ['portable.tar.gz', 'backend-image.tar', 'SOURCE.json', 'IMAGE_ID', 'STOP.json'].map(
          (name, i) => [
            name,
            i === 0
              ? { bytes: assets[3].bytes, sha256: assets[3].sha256 }
              : i === 1
                ? { bytes: rawImage.length, sha256: sha(rawImage) }
                : i === 2
                  ? { bytes: assets[2].bytes, sha256: assets[2].sha256 }
                  : { bytes: 1, sha256: 'e'.repeat(64) },
          ],
        ),
      ),
      imageId: `sha256:${'e'.repeat(64)}`,
      stop: { exitCode: 0, scope: 'idle process stop; no business Run drain proof' },
    },
    assets,
  };
}
export function qualificationApi(context, options = {}) {
  const receipt = serverReceipt(context);
  return async (path) => {
    if (path.endsWith('/runs/77'))
      return {
        id: 77,
        run_attempt: 1,
        path: '.github/workflows/linux-server-qualification.yml',
        event: 'workflow_dispatch',
        head_branch: 'main',
        head_sha: context.source,
        status: 'completed',
        conclusion: 'success',
        ...options.run,
      };
    if (path.endsWith('/attempts/1/jobs?per_page=100'))
      return {
        total_count: 2,
        jobs: options.jobs ?? [
          { name: 'qualify', conclusion: 'success' },
          { name: 'native-probe', conclusion: 'skipped' },
        ],
      };
    if (path.endsWith('/runs/77/artifacts?per_page=100'))
      return {
        total_count: 1,
        artifacts: [
          {
            id: 88,
            name: `linux-server-amd64-${context.source}`,
            expired: false,
            size_in_bytes: 100,
            digest: receipt.artifactDigest,
            workflow_run: { id: 77, head_sha: context.source, head_branch: 'main' },
            ...options.artifact,
          },
        ],
      };
    throw Error('Unexpected synthetic qualification API path');
  };
}
export async function rawPlatformFixture(context, directory, options = {}) {
  const windows = join(directory, 'windows'),
    server = join(directory, 'server'),
    portable = join(directory, 'portable'),
    image = join(directory, 'image');
  for (const path of [windows, server, portable, image]) await mkdir(path);
  const installer = Buffer.from('SYNTHETIC_EXE_CONTRACT_ONLY'),
    name = platformNames(context)[0];
  await writeFile(join(windows, name), installer);
  await writeFile(join(windows, 'SOURCE.json'), JSON.stringify(windowsSource(context, installer)));
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await writeFile(join(windows, file), await readFile(join(context.root, file)));
  await writeSums(windows, [name, 'SOURCE.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']);
  const source = serverSource(context);
  await writeFile(join(server, 'SOURCE.json'), JSON.stringify(source));
  await writeFile(join(portable, 'SOURCE.json'), JSON.stringify(options.portableSource ?? source));
  execFileSync('tar', ['-czf', join(server, 'portable.tar.gz'), '-C', portable, '.']);
  const config = Buffer.from(
    JSON.stringify({
      os: 'linux',
      architecture: 'amd64',
      config: { User: '10001:10001', Entrypoint: ['node', '/app/start.mjs'], ...options.config },
    }),
  );
  const imageId = sha(config),
    configName = `${imageId}.json`;
  await writeFile(join(image, configName), config);
  await writeFile(
    join(image, 'manifest.json'),
    JSON.stringify([
      { Config: configName, RepoTags: [`zhuma-backend:${context.source}`], Layers: [] },
    ]),
  );
  execFileSync('tar', [
    '-cf',
    join(server, 'backend-image.tar'),
    '-C',
    image,
    'manifest.json',
    configName,
  ]);
  await writeFile(join(server, 'IMAGE_ID'), `sha256:${imageId}\n`);
  await writeFile(
    join(server, 'STOP.json'),
    JSON.stringify({ exitCode: 0, scope: 'idle process stop; no business Run drain proof' }),
  );
  await writeSums(server, [
    'portable.tar.gz',
    'backend-image.tar',
    'SOURCE.json',
    'IMAGE_ID',
    'STOP.json',
  ]);
  return { windows, server };
}
export async function writeSums(directory, names) {
  const lines = await Promise.all(
    names.map(async (name) => `${sha(await readFile(join(directory, name)))}  ${name}\n`),
  );
  await writeFile(join(directory, 'SHA256SUMS'), lines.join(''));
}
