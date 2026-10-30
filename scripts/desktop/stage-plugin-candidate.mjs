#!/usr/bin/env node
/** Stage the product plugin and its verified optional admission Gateway into
 * an existing official Desktop SDK. No profile/credential copy or launch. */
import { execFileSync } from 'node:child_process';
import { access, readFile, mkdir, copyFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    plugin: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!values.stage) throw Error('Pass --stage with an owned existing official Desktop SDK');
const stage = resolve(values.stage);
if (stage === join(root, '.build/desktop/deepseek-harness'))
  throw Error('The frozen two-Host CLI SDK must not be replaced');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
if (!values.plugin && git(root, 'status', '--porcelain'))
  throw Error('Freeze and commit the product source before staging a candidate');
const pin = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8')).upstreams
  .deepseekHarness.commit;
if (git(stage, 'rev-parse', 'HEAD') !== pin) throw Error('Unexpected official SDK revision');
for (const file of [
  '.zhuma-prepared.json',
  'apps/desktop/lib/main.js',
  'apps/desktop-host/lib/index.js',
  'apps/desktop/scripts/dev.ts',
  'apps/desktop/.desktop-build/targets/mac-arm64/runtime/primary-runtime/runtime.json',
])
  await access(join(stage, file));
const target = join(stage, 'packages/bundle/web-app/lib/zhuma-workbench');
if (!(await realpath(target)).startsWith((await realpath(stage)) + '/'))
  throw Error('Plugin output must be an owned directory within this SDK');
const source = values.plugin ? resolve(values.plugin) : join(root, '.build/workbench'),
  files = [
    'index.js',
    'client.js',
    'member-web.js',
    'package.json',
    'LICENSE',
    'THIRD_PARTY_LICENSES.txt',
  ];
const current = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
const next = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const launchFiles = ['codearts-acp.js', 'codearts-acp.manifest.json', 'codearts-policy.js'];
if (next.zhuma?.codeArtsLaunch === 1) files.push(...launchFiles);
if (current.name !== '@zhuma/workbench' || next.name !== current.name)
  throw Error('Unexpected product plugin identity');
if (JSON.stringify(current.peerDependencies) !== JSON.stringify(next.peerDependencies))
  throw Error('Official SDK peer graph differs; resolve explicitly before staging');
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const previous = {},
  candidate = {};
const frozen = values.plugin
  ? JSON.parse(await readFile(join(source, 'A-SOURCE.json'), 'utf8'))
  : undefined;
if (
  frozen &&
  (!/^[a-f0-9]{40}$/u.test(frozen.head) ||
    !/^[a-f0-9]{40}$/u.test(frozen.tree) ||
    frozen.sdkPin !== pin)
)
  throw Error('Invalid frozen product source identity');
for (const file of files) {
  try {
    previous[file] = await hash(join(target, file));
  } catch (error) {
    if (error.code !== 'ENOENT' || (file !== 'member-web.js' && !launchFiles.includes(file)))
      throw error;
    previous[file] = null;
  }
  candidate[file] = await hash(join(source, file));
  if (frozen && frozen.hashes?.[file] !== candidate[file])
    throw Error('Frozen product bytes differ');
}
const backupId = createHash('sha256').update(JSON.stringify(previous)).digest('hex');
const backup = join(root, '.build/desktop-plugin-backups', backupId);
const gatewayTarget = join(stage, 'packages/api/gateway/lib/index.js');
const gateway = frozen?.sdkGateway;
if (gateway) {
  if (gateway.pin !== pin || (await hash(join(source, 'sdk-gateway/index.js'))) !== gateway.sha256)
    throw Error('Frozen SDK Gateway identity differs');
} else if (!(await readFile(gatewayTarget, 'utf8')).includes('registerSessionAdmission'))
  throw Error(
    'This plugin requires the matching Gateway; pass a verified frozen --plugin candidate',
  );
const workspaceTarget = join(stage, 'packages/client/ui-workspace/lib/client.js');
const workspace = frozen?.sdkUiWorkspace;
if (workspace) {
  if (
    workspace.pin !== pin ||
    (await hash(join(source, 'sdk-ui-workspace/client.js'))) !== workspace.sha256 ||
    !(await readFile(join(source, 'sdk-ui-workspace/client.js'), 'utf8')).includes(
      'registerSessionNavigationGuard',
    ) ||
    !(await realpath(workspaceTarget)).startsWith((await realpath(stage)) + '/')
  )
    throw Error('Frozen SDK Workspace client identity differs');
}
async function replaceSdkEntry(input, output, expected, label) {
  const old = await hash(output);
  const saved = join(root, '.build/desktop-plugin-backups', `${label}-${old}`);
  await mkdir(saved, { recursive: true });
  try {
    await access(join(saved, 'index.js'));
    if ((await hash(join(saved, 'index.js'))) !== old) throw Error('SDK backup differs');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await copyFile(output, join(saved, 'index.js'));
  }
  await copyFile(input, output);
  if ((await hash(output)) !== expected) throw Error('Staged SDK entry differs');
}
if (!values['dry-run']) {
  await mkdir(backup, { recursive: true });
  for (const file of files) {
    if (previous[file] === null) continue;
    try {
      await access(join(backup, file));
      if ((await hash(join(backup, file))) !== previous[file])
        throw Error('Backup identity differs');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await copyFile(join(target, file), join(backup, file));
    }
  }
  for (const file of files) await copyFile(join(source, file), join(target, file));
  if (gateway) {
    await replaceSdkEntry(
      join(source, 'sdk-gateway/index.js'),
      gatewayTarget,
      gateway.sha256,
      'gateway',
    );
  }
  if (workspace)
    await replaceSdkEntry(
      join(source, 'sdk-ui-workspace/client.js'),
      workspaceTarget,
      workspace.sha256,
      'ui-workspace',
    );
  for (const file of files)
    if ((await hash(join(target, file))) !== candidate[file])
      throw Error('Staged product bytes differ');
}
const report = {
  scope: 'official-existing-desktop-product-plugin-and-admission-entry',
  dryRun: values['dry-run'],
  sourceCommit: frozen?.head ?? git(root, 'rev-parse', 'HEAD'),
  sourceTree: frozen?.tree ?? git(root, 'rev-parse', 'HEAD^{tree}'),
  sdkPin: pin,
  target,
  backup,
  hashes: candidate,
  sdkGateway: gateway ?? { sha256: await hash(gatewayTarget), reused: true },
  ...(workspace ? { sdkUiWorkspace: workspace } : {}),
  launcher: join(stage, 'apps/desktop/scripts/dev.ts'),
  profileAccessed: false,
  launched: false,
  limits: [
    workspace
      ? 'Verified original Workspace browser bundle included; product native navigation registration remains a separate requirement'
      : 'No UI Workspace navigation hook is installed',
    'No desktop GUI, model, task execution or installation acceptance',
  ],
};
if (!values['dry-run'])
  await writeFile(join(target, 'ZHUMA-CANDIDATE.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
