#!/usr/bin/env node
/** Exact-main release gates and provenance. No credentials or profile files are read. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assert.match(env.GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/);
  const product = readJson(join(root, 'package.json'));
  const sdkPin = readJson(join(root, 'runtime.lock.json')).upstreams.deepseekHarness.commit;
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
  for (const file of ['codearts-acp.js', 'codearts-acp.manifest.json', 'codearts-policy.js'])
    assert(
      asar
        .extractFile(archive, plugin + file)
        .equals(readFileSync(join(root, '.build/workbench', file))),
    );
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
export async function publish(context, directory, api) {
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
    manifest.artifacts.backendLaunchers.map((item) => `${item.sha256}  ${item.name}\n`).join('');
  assert.equal(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), sums);
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
      body: `## 核心能力
- 成员明确授权本机运行工作流，只接续自己获准的节点；其他成员各自授权，离线等待，后端不代跑成员 Agent。
- 固定文字／真实文件自动交付、指定独立 Agent 评审及 0／1／2 轮有界返工；真人评审与上限耗尽等待人工，全部通过且原运行收口后接续。手工交付与逐节点使用 Agent 保留。
- 任务按参与真人／专家、阶段、项目与搜索联合筛选，列表／看板共用结果与计数。
- 项目关联必需／可选的固定版本知识，运行沿原授权工具按需读取；引用清单和工具注册不代表正文已读。
- 共享后端 AI 规划读取实际模型可用状态，提案可继续编辑，失败保留输入；规划与成员本机执行分别配置模型。
- 同机共享后端与两个隔离成员 Host 的真实 HTTP 接续、停止、未知回执与冷恢复；保留原工作区／Session 导航及历史交付。

## 安装与首次使用
1. 下载 DMG、SOURCE.json、SHA256SUMS 和两个 packaged-backend 启动文件，放在同一目录，执行 shasum -a 256 -c SHA256SUMS 核验。
2. 打开 DMG，将 Zhuma 拖入 Applications。首次被系统拦截时，核对来源后按 [macOS 正常允许打开流程](https://support.apple.com/zh-cn/102445)操作；不要全局关闭系统保护。
3. 成员自行在桌面模型页配置本机执行模型；共享 AI 规划由服务操作者在后端官方 Settings → Models 中单独配置。凭据不自动复制，模型调用费用由供应商计费。
4. 需要共享后端时，用同目录脚本运行 sh packaged-backend.sh --app /Applications/Zhuma.app --data /path/to/backend-data --file-uploads --independent-reviews，启用文件交付和独立 Agent 评审。保留两个启动文件同目录，使用本版 App；成员在桌面选择该后端并正常登录。

## 支持与边界
仅 macOS Apple Silicon（arm64）；ad-hoc 签名、未公证，无自动更新。Intel Mac、Windows、Linux 尚未认证。
非空 MCP、资产／工作流发布版本、批量反馈、复杂子流程与完整工作树执行、效能统计、个人专家直接使用与导入、外部 CLI 和完整跨会话通信后置。
多成员恢复以同机隔离模拟为边界，不认证实体异机网络、休眠或平台差异；真实模型与知识正文实际读取须按准确候选分别留证。共享后端为本地部署，集群部署后置。

## 许可与来源
自有代码采用 [MIT License](https://github.com/${context.repository}/blob/${context.source}/LICENSE)，第三方许可保留在安装包中。
源码：${context.source}。来源与产物摘要见 SOURCE.json、SHA256SUMS。
`,
    },
  });
  assert(Number.isSafeInteger(release.id) && release.id > 0);
  assert.equal(release.draft, true);
  assert.equal(release.tag_name, context.tag);
  assert.equal(release.target_commitish, context.source);
  // A partial failure intentionally leaves the new draft/tag for inspection.
  // Never delete a tag/release, clobber an asset, or silently retry publication.
  for (const name of [context.filename, 'SOURCE.json', 'SHA256SUMS', ...backendLaunchers]) {
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
  } else if (mode === 'publish') {
    console.log(
      await publish(context, join(root, '.build/release-input'), githubApi(process.env.GH_TOKEN)),
    );
  } else throw new Error('Expected preflight, manifest or publish.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
