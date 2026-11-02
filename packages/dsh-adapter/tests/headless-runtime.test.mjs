/** Portable provenance/launch contracts using disposable synthetic public material only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleHeadlessLaunchers } from '../../../scripts/server/bundle-headless.mjs';
import {
  HEADLESS_SDK_PIN,
  inspectHeadlessRuntime,
  runtimeInventory,
} from '../../../scripts/server/runtime-manifest.mjs';
import { headlessLaunchPlan, parseHeadlessArgs } from '../../../scripts/server/headless.mjs';

test('emitted launchers run outside the source tree with a frozen, SDK-independent member route table', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-headless-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await bundleHeadlessLaunchers(fileURLToPath(new URL('../../../', import.meta.url)), directory);
  const { memberRequestAllowed } = await import(
    pathToFileURL(join(directory, 'member-gateway.mjs')).href
  );
  assert.equal(memberRequestAllowed('GET', '/workbench'), true);
  assert.equal(memberRequestAllowed('POST', '/api/session/prompt'), false);
  assert((await readFile(join(directory, 'member-gateway.mjs'))).length < 16 * 1024);
  const { parseHeadlessArgs } = await import(pathToFileURL(join(directory, 'start.mjs')).href);
  assert.equal(parseHeadlessArgs(['--data', '/data']).operatorPort, 3081);
});

test('headless parser separates public/private binds and admits only explicit public roots', () => {
  const value = parseHeadlessArgs([
    '--data',
    '/data',
    '--host',
    '10.0.0.8',
    '--public-origin',
    'https://members.example',
    '--file-uploads',
    '--independent-reviews',
  ]);
  assert.deepEqual(value.authorities, ['10.0.0.8:3080', 'members.example']);
  const plan = headlessLaunchPlan(
    { cli: '/app/sdk/cli.js', plugin: '/app/workbench/index.js' },
    value,
    '/usr/bin',
  );
  assert.deepEqual(plan.env, {
    PATH: '/usr/bin',
    HOME: '/data/home',
    DSH_HOME: '/data/dsh',
    LANG: 'en_US.UTF-8',
  });
  assert.equal(plan.args[plan.args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(plan.args[plan.args.indexOf('--port') + 1], '3081');
  assert.equal(plan.overlay.at(-1).insert[0].config.deploymentMode, 'multi-member');
  assert.equal(plan.overlay.at(-1).insert[0].config.remoteIndependentReviews, true);
  for (const args of [
    ['--host', '0.0.0.0'],
    ['--host', '::'],
    ['--host', '::ffff:0.0.0.0'],
    ['--public-origin', 'https://user:secret@example/'],
    ['--public-origin', 'https://example/workbench'],
    ['--port', '03081'],
    ['--independent-reviews'],
  ])
    assert.throws(() => parseHeadlessArgs(['--data', '/data', ...args]));
});
test('a relocatable payload checks exact bytes, platform and internal links without Git or a writable source root', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-headless-inventory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'workbench'));
  await mkdir(join(directory, 'sdk/node_modules/@deepseek-ai/dsh'), { recursive: true });
  await writeFile(
    join(directory, 'workbench/package.json'),
    JSON.stringify({ name: '@zhuma/workbench', version: '1.4.0' }),
  );
  await writeFile(join(directory, 'workbench/index.js'), 'export {};');
  await writeFile(
    join(directory, 'sdk/node_modules/@deepseek-ai/dsh/package.json'),
    '{"version":"0.2.1-rc.4"}',
  );
  await symlink('../sdk/node_modules', join(directory, 'workbench/node_modules'), 'dir');
  const source = {
    schemaVersion: 1,
    product: { commit: '1'.repeat(40), tree: '2'.repeat(40), version: '1.4.0' },
    sdk: { commit: HEADLESS_SDK_PIN },
    runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    files: await runtimeInventory(directory),
  };
  await writeFile(join(directory, 'SOURCE.json'), JSON.stringify(source));
  assert.equal((await inspectHeadlessRuntime(directory)).source.product.version, '1.4.0');
  await writeFile(join(directory, 'workbench/index.js'), 'changed');
  await assert.rejects(inspectHeadlessRuntime(directory), /payload differs/u);
  await symlink(tmpdir(), join(directory, 'escape'), 'dir');
  await assert.rejects(runtimeInventory(directory), /inside the payload/u);
  await rm(join(directory, 'escape'));
  await mkdir(join(directory, '.git'));
  await assert.rejects(runtimeInventory(directory), /Git state/u);
  assert.equal((await readFile(join(directory, 'SOURCE.json'), 'utf8')).includes('secret'), false);
});
