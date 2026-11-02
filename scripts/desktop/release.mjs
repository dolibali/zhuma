#!/usr/bin/env node
/** Exact-main release gates and provenance. No credentials or profile files are read. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackagedCodeArts } from '../lib/desktop-codearts-artifacts.mjs';
import {
  assemblePlatformAssets,
  serverQualification,
  unpackServerArtifact,
  verifyPlatformAssets,
} from '../lib/release-platforms.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const backendLaunchers = ['packaged-backend.sh', 'packaged-backend.mjs'];
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
export function releaseContext(root, env) {
  const source = env.RELEASE_SOURCE_SHA;
  assert.match(source ?? '', /^[a-f0-9]{40}$/, 'A full verified source SHA is required.');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Dispatch must run from main.');
  assert.equal(env.GITHUB_SHA, source, 'Workflow and verified source SHA differ.');
  assert.equal(git(root, 'rev-parse', 'HEAD'), source, 'Checkout differs from verified source.');
  assert.equal(git(root, 'status', '--porcelain'), '', 'Release source is dirty.');
  assert.match(env.GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/);
  const product = readJson(join(root, 'package.json'));
  const sdk = readJson(join(root, 'runtime.lock.json')).upstreams.deepseekHarness;
  const sdkPin = sdk.commit;
  assert.equal(git(root, 'rev-parse', 'HEAD:upstream/deepseek-harness'), sdkPin);
  const brand = readJson(join(root, 'branding/default/brand.json'));
  assert.match(product.version, /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/);
  assert.equal(brand.desktopBuildVersion, product.version, 'Product/build versions differ.');
  return {
    root,
    source,
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    repository: env.GITHUB_REPOSITORY,
    version: product.version,
    sdkPin,
    sdkVersion: sdk.version,
    rootLockSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
    tag: `v${product.version}`,
    filename: `zhuma-${product.version}-mac-arm64-unsigned.dmg`,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}
export function githubApi(token, fetcher = fetch) {
  assert(token, 'A job-scoped GitHub token is required.');
  return async (
    path,
    { method = 'GET', body, bytes, allowMissing = false, upload = false } = {},
  ) => {
    const response = await fetcher(`https://${upload ? 'uploads' : 'api'}.github.com/${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(180_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10',
        ...(bytes ? { 'content-type': 'application/octet-stream' } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(bytes ? { body: bytes } : {}),
    });
    if (response.status === 404 && allowMissing) return undefined;
    // Never log arbitrary API response bodies, headers, tokens or upload contents.
    if (!response.ok) throw new Error(`GitHub ${method} request refused (${response.status}).`);
    return response.json();
  };
}
async function verifiedMainCI(context, api) {
  const { repository, source } = context;
  const prefix = `repos/${repository}`;
  const main = await api(`${prefix}/git/ref/heads/main`);
  assert.equal(main.object.sha, source, 'Verified main moved; do not substitute another source.');
  const runs = await api(
    `${prefix}/actions/workflows/ci.yml/runs?head_sha=${source}&branch=main&event=push&per_page=100`,
  );
  const latest = runs.workflow_runs
    .filter((run) => run.head_sha === source && run.head_branch === 'main' && run.event === 'push')
    .sort((a, b) => b.id - a.id || (b.run_attempt ?? 1) - (a.run_attempt ?? 1))[0];
  assert(
    latest && latest.status === 'completed' && latest.conclusion === 'success',
    'The latest existing main CI for this exact SHA must succeed first.',
  );
  return latest;
}
export async function preflight(context, api) {
  const { repository, source, tag } = context;
  const prefix = `repos/${repository}`;
  const latest = await verifiedMainCI(context, api);
  assert.equal(
    await api(`${prefix}/git/ref/tags/${tag}`, { allowMissing: true }),
    undefined,
    'Tag already exists; never move or overwrite it.',
  );
  assert.equal(
    await api(`${prefix}/releases/tags/${tag}`, { allowMissing: true }),
    undefined,
    'Release already exists; inspect it without overwriting assets.',
  );
  return { ciRunId: latest.id, ciRunUrl: latest.html_url, source, tag, version: context.version };
}
export function writeManifest(context, gate) {
  const { root, filename } = context;
  const stage = join(root, '.build/desktop/deepseek-harness');
  const sdk = readJson(join(root, 'runtime.lock.json')).upstreams.deepseekHarness;
  assert.equal(git(stage, 'rev-parse', 'HEAD'), sdk.commit);
  assert.equal(git(root, 'rev-parse', 'HEAD:upstream/deepseek-harness'), sdk.commit);
  const stamp = readJson(join(stage, '.zhuma-prepared.json'));
  assert.equal(stamp.pinned, sdk.commit);
  const app = join(
    stage,
    'apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/mac-arm64/Zhuma.app',
  );
  const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app], {
    encoding: 'utf8',
  });
  assert.equal(signature.status, 0);
  assert.match(signature.stderr, /^Signature=adhoc$/m);
  assert.match(signature.stderr, /^TeamIdentifier=not set$/m);
  assert.equal(git(root, 'status', '--porcelain'), '', 'Release source is dirty.');
  const archive = join(app, 'Contents/Resources/app.asar');
  const require = createRequire(join(stage, 'apps/desktop/package.json'));
  const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar');
  const plugin = 'dsh/node_modules/@deepseek-ai/dsh-web-app/lib/zhuma-workbench/';
  const host = asar.extractFile(archive, plugin + 'index.js');
  const client = asar.extractFile(archive, plugin + 'client.js');
  assert(host.equals(readFileSync(join(root, '.build/workbench/index.js'))));
  assert(client.equals(readFileSync(join(root, '.build/workbench/client.js'))));
  verifyPackagedCodeArts(join(app, 'Contents/Resources'), join(root, '.build/workbench'), asar);
  const dmg = readFileSync(join(root, 'dist', filename));
  const launchers = backendLaunchers.map((name) => {
    const bytes = readFileSync(join(root, 'scripts/server', name));
    writeFileSync(join(root, 'dist', name), bytes);
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  assert(
    dmg.equals(
      readFileSync(
        join(stage, 'apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts', filename),
      ),
    ),
  );
  const manifest = {
    schemaVersion: 1,
    repository: context.repository,
    sourceCommit: context.source,
    sourceTree: context.tree,
    version: context.version,
    tag: context.tag,
    ci: gate,
    workflow: { runId: context.runId, runAttempt: context.runAttempt },
    target: { platform: 'darwin', arch: 'arm64', signature: 'ad-hoc', notarized: false },
    sdkPin: sdk.commit,
    recipeDigest: stamp.digest,
    toolchain: {
      node: process.version,
      pnpm: readJson(join(root, 'package.json')).packageManager,
      sdkPnpm: sdk.packageManager,
    },
    locks: {
      workspace: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
      sdk: sha256(readFileSync(join(stage, 'pnpm-lock.yaml'))),
    },
    artifacts: {
      dmg: { name: filename, bytes: dmg.length, sha256: sha256(dmg) },
      asarSha256: sha256(readFileSync(archive)),
      hostSha256: sha256(host),
      clientSha256: sha256(client),
      backendLaunchers: launchers,
    },
  };
  const provenance = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(root, 'dist/SOURCE.json'), provenance);
  writeFileSync(
    join(root, 'dist/SHA256SUMS'),
    `${sha256(dmg)}  ${filename}\n${sha256(provenance)}  SOURCE.json\n` +
      launchers.map((item) => `${item.sha256}  ${item.name}\n`).join(''),
  );
  return manifest;
}
export function verifyMacMaterial(context, directory, additionalAssets = []) {
  const manifest = readJson(join(directory, 'SOURCE.json'));
  assert.equal(manifest.sourceCommit, context.source);
  assert.equal(manifest.sourceTree, context.tree);
  assert.equal(manifest.repository, context.repository);
  assert.equal(manifest.version, context.version);
  assert.equal(manifest.sdkPin, context.sdkPin);
  assert.equal(manifest.locks.workspace, context.rootLockSha256);
  assert.equal(manifest.tag, context.tag);
  assert.equal(manifest.workflow.runId, context.runId);
  assert.equal(manifest.workflow.runAttempt, context.runAttempt);
  assert.deepEqual(manifest.target, {
    platform: 'darwin',
    arch: 'arm64',
    signature: 'ad-hoc',
    notarized: false,
  });
  const dmg = readFileSync(join(directory, context.filename));
  assert.equal(manifest.artifacts.dmg.name, context.filename);
  assert.equal(manifest.artifacts.dmg.bytes, dmg.length);
  assert.equal(manifest.artifacts.dmg.sha256, sha256(dmg));
  assert.deepEqual(
    manifest.artifacts.backendLaunchers?.map((item) => item.name),
    backendLaunchers,
  );
  for (const item of manifest.artifacts.backendLaunchers) {
    const bytes = readFileSync(join(directory, item.name));
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.sha256, sha256(bytes));
    assert(
      bytes.equals(readFileSync(join(context.root, 'scripts/server', item.name))),
      'Backend launcher differs from the exact checked-out release source.',
    );
  }
  const sums =
    `${sha256(dmg)}  ${context.filename}\n${sha256(readFileSync(join(directory, 'SOURCE.json')))}  SOURCE.json\n` +
    [...manifest.artifacts.backendLaunchers, ...additionalAssets]
      .map((item) => `${item.sha256}  ${item.name}\n`)
      .join('');
  assert.equal(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), sums);
  return manifest;
}
export async function publish(context, directory, api) {
  const manifest = readJson(join(directory, 'SOURCE.json'));
  const extra = verifyPlatformAssets(context, directory, manifest.platforms);
  verifyMacMaterial(context, directory, extra);
  assert.deepEqual(
    await serverQualification(context, manifest.platforms.server.qualification.runId, api),
    manifest.platforms.server.qualification,
    'The exact Linux qualification or artifact changed before publication.',
  );
  await preflight(context, api); // Fresh exact source/CI/conflict checks before the first write.
  const prefix = `repos/${context.repository}`;
  const tag = await api(`${prefix}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/tags/${context.tag}`, sha: context.source },
  });
  assert.equal(tag.object.sha, context.source);
  const release = await api(`${prefix}/releases`, {
    method: 'POST',
    body: {
      tag_name: context.tag,
      target_commitish: context.source,
      name: `Zhuma ${context.version}`,
      draft: true,
      prerelease: context.version.includes('-'),
      body: `Zhuma ${context.version}

Windows x64 安装包、macOS arm64 DMG 与 Linux amd64 服务镜像／便携包来自同一准确 main 提交。
安装、签名、配置、数据与验证边界见 [本版说明](https://github.com/${context.repository}/blob/${context.source}/docs/release-v1.4.md)。

下载所需平台文件与 SOURCE.json、SHA256SUMS，先核对摘要。macOS 为 ad-hoc、未公证；Windows 未签名；无自动更新。服务镜像压缩包使用 docker load，部署模板须先填写自己的入口和持久卷，不含凭据。

自有代码采用 [MIT License](https://github.com/${context.repository}/blob/${context.source}/LICENSE)，保留第三方许可和真实供应商信息。
来源：${context.source}；SDK：${context.sdkPin}；各平台原始来源与全部上传字节摘要见 SOURCE.json、SHA256SUMS。
`,
    },
  });
  assert(Number.isSafeInteger(release.id) && release.id > 0);
  assert.equal(release.draft, true);
  assert.equal(release.tag_name, context.tag);
  assert.equal(release.target_commitish, context.source);
  // A partial failure intentionally leaves the new draft/tag for inspection.
  // Never delete a tag/release, clobber an asset, or silently retry publication.
  for (const name of [
    context.filename,
    'SOURCE.json',
    'SHA256SUMS',
    ...backendLaunchers,
    ...extra.map((item) => item.name),
  ]) {
    const bytes = readFileSync(join(directory, name));
    const asset = await api(
      `${prefix}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      { method: 'POST', upload: true, bytes },
    );
    assert.equal(asset.name, name);
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, bytes.length);
    assert.equal(asset.digest, `sha256:${sha256(bytes)}`, 'Uploaded asset digest differs.');
  }
  await verifiedMainCI(context, api);
  const currentTag = await api(`${prefix}/git/ref/tags/${context.tag}`);
  assert.equal(currentTag.object.sha, context.source, 'Release tag moved during upload.');
  assert.deepEqual(
    await serverQualification(context, manifest.platforms.server.qualification.runId, api),
    manifest.platforms.server.qualification,
    'Linux qualification changed during asset upload; keep this release private.',
  );
  const completed = await api(`${prefix}/releases/${release.id}`, {
    method: 'PATCH',
    body: { draft: false },
  });
  assert.equal(completed.draft, false);
  assert.equal(completed.tag_name, context.tag);
  return completed.html_url;
}
async function main() {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const context = releaseContext(root, process.env);
  const mode = process.argv[2];
  if (mode === 'preflight') {
    const gate = await preflight(context, githubApi(process.env.GH_TOKEN));
    mkdirSync(join(root, '.build/release'), { recursive: true });
    writeFileSync(join(root, '.build/release/preflight.json'), JSON.stringify(gate) + '\n');
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `tag=${context.tag}\nversion=${context.version}\n`);
  } else if (mode === 'manifest') {
    writeManifest(context, readJson(join(root, '.build/release/preflight.json')));
  } else if (mode === 'server-preflight') {
    await preflight(context, githubApi(process.env.GH_TOKEN));
    const receipt = await serverQualification(
      context,
      process.env.SERVER_RUN_ID,
      githubApi(process.env.GH_TOKEN),
    );
    mkdirSync(join(root, '.build/release'), { recursive: true });
    writeFileSync(
      join(root, '.build/release/server-preflight.json'),
      JSON.stringify(receipt) + '\n',
    );
    assert(process.env.GITHUB_OUTPUT);
    appendFileSync(process.env.GITHUB_OUTPUT, `artifact_id=${receipt.artifactId}\n`);
  } else if (mode === 'server-unpack') {
    const server = join(root, '.build/release-input/server');
    mkdirSync(server, { recursive: true });
    unpackServerArtifact(
      context,
      readJson(join(root, '.build/release/server-preflight.json')),
      join(root, '.build/release/server.zip'),
      join(server, 'payload'),
    );
    copyFileSync(
      join(root, '.build/release/server-preflight.json'),
      join(server, 'server-preflight.json'),
    );
  } else if (mode === 'assemble') {
    const inputs = join(root, '.build/release-input'),
      output = join(root, '.build/release-combined');
    const mac = join(inputs, 'macos'),
      windows = join(inputs, 'windows'),
      server = join(inputs, 'server');
    const manifest = verifyMacMaterial(context, mac);
    mkdirSync(output); // A fresh output only; preserve any earlier candidate.
    for (const name of [context.filename, ...backendLaunchers])
      copyFileSync(join(mac, name), join(output, name));
    manifest.platforms = await assemblePlatformAssets(
      context,
      windows,
      join(server, 'payload'),
      readJson(join(server, 'server-preflight.json')),
      output,
    );
    verifyPlatformAssets(context, output, manifest.platforms);
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(output, 'SOURCE.json'), bytes, { flag: 'wx' });
    writeFileSync(
      join(output, 'SHA256SUMS'),
      `${sha256(readFileSync(join(output, context.filename)))}  ${context.filename}\n${sha256(bytes)}  SOURCE.json\n` +
        [...manifest.artifacts.backendLaunchers, ...manifest.platforms.assets]
          .map((item) => `${item.sha256}  ${item.name}\n`)
          .join(''),
      { flag: 'wx' },
    );
    verifyMacMaterial(context, output, manifest.platforms.assets);
  } else if (mode === 'publish') {
    console.log(
      await publish(context, join(root, '.build/release-input'), githubApi(process.env.GH_TOKEN)),
    );
  } else
    throw new Error(
      'Expected preflight, manifest, server-preflight, server-unpack, assemble or publish.',
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
