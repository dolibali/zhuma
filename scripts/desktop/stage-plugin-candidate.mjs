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
    if (error.code !== 'ENOENT' || file !== 'member-web.js') throw error;
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
    const old = await hash(gatewayTarget),
      gatewayBackup = join(root, '.build/desktop-plugin-backups', `gateway-${old}`);
    await mkdir(gatewayBackup, { recursive: true });
    try {
      await access(join(gatewayBackup, 'index.js'));
      if ((await hash(join(gatewayBackup, 'index.js'))) !== old)
        throw Error('Gateway backup differs');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await copyFile(gatewayTarget, join(gatewayBackup, 'index.js'));
    }
    await copyFile(join(source, 'sdk-gateway/index.js'), gatewayTarget);
    if ((await hash(gatewayTarget)) !== gateway.sha256) throw Error('Staged Gateway differs');
  }
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
  launcher: join(stage, 'apps/desktop/scripts/dev.ts'),
  profileAccessed: false,
  launched: false,
  limits: [
    'Product plugin plus the verified optional Gateway entry only; no UI Workspace navigation hook is installed',
    'No desktop GUI, model, task execution or installation acceptance',
  ],
};
if (!values['dry-run'])
  await writeFile(join(target, 'ZHUMA-CANDIDATE.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
