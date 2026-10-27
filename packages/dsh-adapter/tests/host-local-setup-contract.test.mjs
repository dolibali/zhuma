/** Host composition and patched-source contracts, not identity/profile/desktop acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { canonicalPayload } from '@zhuma/agent-core';
import { openHostLocalSetup } from '../dist/host-local-setup.js';
import { hostTeamCatalogPin } from '../dist/host-team-catalog.js';
import { publicTeamStarterPackages } from '../../../scripts/lib/team-starter-packages.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('first setup Host contract: explicit Config/context conflict refuses cold activation and new writes', async () => {
  const packages = await publicTeamStarterPackages();
  // The source test module has no esbuild constant. Inject the original public
  // build input only in this contract process, never into Config or HTTP.
  globalThis.ZHUMA_PUBLIC_TEAM_PACKAGES = packages;
  let control;
  try {
    const requestId = '9a599192-b01e-43df-92c2-7b2ee83ab6a4',
      spaceId = `team-${requestId}`;
    const selected = [{ spaceId, packs: [{ id: 'zhuma-work-planning', version: '1.0.0' }] }];
    const directoryFingerprint = 'd'.repeat(64);
    const setup = {
      requestId,
      setupContext: { schemaVersion: 1, teamCatalog: selected },
      setupFingerprint: createHash('sha256')
        .update(
          canonicalPayload({
            schemaVersion: 1,
            directoryFingerprint,
            catalogPin: hostTeamCatalogPin(selected, packages),
          }),
        )
        .digest('hex'),
    };
    let writes = 0,
      imports = 0;
    const lifetime = new AbortController();
    const directory = {
      signal: lifetime.signal,
      initializationStatus: () => ({ kind: 'configured', fingerprint: directoryFingerprint }),
      space: () => ({ id: spaceId, kind: 'team', name: 'Team' }),
    };
    const handle = {
      signal: lifetime.signal,
      status: () => ({ kind: 'configured' }),
      readSetup: () => structuredClone(setup),
      initializeAccount: async () => {
        writes++;
      },
    };
    control = openHostLocalSetup({
      directory: () => directory,
      workbench: {
        openTeamCatalog: async () => {
          imports++;
          throw Error('Must not activate');
        },
      },
      configuredCatalog: [
        { spaceId, packs: [{ id: 'zhuma-interaction-review', version: '1.0.0' }] },
      ],
    });
    control.initialization.publish(handle);
    await assert.rejects(control.restore(), { code: 'conflict' });
    await assert.rejects(
      control.operations.initialize({
        requestId,
        accountId: 'ann',
        password: 'synthetic-only',
        teamName: 'Team',
        packIds: ['zhuma-work-planning'],
      }),
      { code: 'conflict' },
    );
    await assert.rejects(
      control.operations.initialize({
        requestId,
        accountId: 'zhuma-work-planning',
        password: 'synthetic-only',
        teamName: 'Team',
        packIds: ['zhuma-work-planning'],
      }),
      { code: 'invalid-input' },
    );
    assert.equal(writes, 0);
    assert.equal(imports, 0);
  } finally {
    control?.close();
    delete globalThis.ZHUMA_PUBLIC_TEAM_PACKAGES;
  }
});

async function patched() {
  const stage = await mkdtemp(join(tmpdir(), 'zhuma-setup-source-contract-'));
  for (const file of ['apps/desktop/src/project-manager.ts', 'apps/desktop/src/web-document.ts']) {
    const target = join(stage, file);
    mkdirSync(dirname(target), { recursive: true });
    await copyFile(join(root, 'upstream/deepseek-harness', file), target);
  }
  execFileSync(
    'git',
    [
      'apply',
      '--include=apps/desktop/src/project-manager.ts',
      '--include=apps/desktop/src/web-document.ts',
      join(root, 'patches/deepseek-harness/zhuma-desktop.patch'),
    ],
    { cwd: stage },
  );
  await copyFile(
    join(root, 'packages/dsh-adapter/src/desktop-member-cookie.ts'),
    join(stage, 'apps/desktop/src/zhuma-member-cookie.ts'),
  );
  return stage;
}
function profileCreator(source, initialize) {
  const ast = ts.createSourceFile('project-manager.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'createPluginProfile',
  );
  assert(declaration);
  const compiled = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function(
    'existsSync',
    'join',
    'mkdirSync',
    'writeFileSync',
    'initProfile',
    'WEB_PROFILE',
    'exports',
    compiled,
  )(existsSync, join, mkdirSync, writeFileSync, initialize, { bundles: ['contract-web'] }, exports);
  return exports.createPluginProfile;
}
function initializeProfile(directory) {
  mkdirSync(directory, { recursive: true });
  if (!existsSync(join(directory, 'package.json')))
    writeFileSync(join(directory, 'package.json'), '{}');
  if (!existsSync(join(directory, 'cordis.patch.yml')))
    writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n');
}
test('first setup profile source contract: only new profiles select member mode; old files and interrupted creation retain their exact choice', async () => {
  const stage = await patched();
  try {
    const source = await readFile(join(stage, 'apps/desktop/src/project-manager.ts'), 'utf8');
    const create = profileCreator(source, initializeProfile);
    const fresh = join(stage, 'fresh');
    create(fresh);
    const selection = readFileSync(join(fresh, 'cordis.patch.yml'), 'utf8');
    assert(selection.includes('deploymentMode: multi-member\n    localSetup: true'));
    create(fresh);
    assert.equal(readFileSync(join(fresh, 'cordis.patch.yml'), 'utf8'), selection);
    const existing = join(stage, 'existing');
    initializeProfile(existing);
    const old =
      '- id: zhuma-workbench\n  config:\n    deploymentMode: legacy-single-user\n# keep the existing profile\n';
    writeFileSync(join(existing, 'cordis.patch.yml'), old);
    create(existing);
    assert.equal(readFileSync(join(existing, 'cordis.patch.yml'), 'utf8'), old);
    const prefix = join(stage, 'prefix');
    assert.throws(() =>
      profileCreator(source, () => {
        throw Error('Contract init interruption');
      })(prefix),
    );
    assert.equal(existsSync(join(prefix, 'package.json')), false);
    assert.equal(readFileSync(join(prefix, 'cordis.patch.yml'), 'utf8'), selection);
    create(prefix);
    assert.equal(readFileSync(join(prefix, 'cordis.patch.yml'), 'utf8'), selection);
    const manifestOnly = join(stage, 'manifest-only');
    mkdirSync(manifestOnly);
    writeFileSync(join(manifestOnly, 'package.json'), '{}');
    create(manifestOnly);
    assert.equal(readFileSync(join(manifestOnly, 'cordis.patch.yml'), 'utf8'), '[]\n');
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('first setup desktop forwarding source contract: validated local owner POST carries actual Host Origin, foreign callers never dispatch', async () => {
  const stage = await patched(),
    original = globalThis.fetch;
  try {
    const output = join(stage, 'forward.mjs');
    await build({
      entryPoints: [join(stage, 'apps/desktop/src/web-document.ts')],
      outfile: output,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'error',
    });
    const module = await import(pathToFileURL(output).href);
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response('{}');
    };
    const host = 'http://127.0.0.1:39071',
      owner = 'dsh-session=synthetic-owner-only';
    const request = (origin) =>
      new Request('dsh-app://app/api/zhuma-local-setup/initialize', {
        method: 'POST',
        body: '{}',
        headers: { origin },
      });
    assert.equal(
      (await module.forwardWebRequest(request('dsh-app://app'), host, owner)).status,
      200,
    );
    assert.equal(calls[0].headers.get('origin'), host);
    assert.equal(calls[0].headers.get('cookie'), owner);
    assert.equal(
      (await module.forwardWebRequest(request('https://outside.example'), host, owner)).status,
      403,
    );
    assert.equal(calls.length, 1);
    for (const endpoint of ['options', 'approve', 'revoke']) {
      const allowed = new Request(`dsh-app://app/api/zhuma-workspaces/${endpoint}`, {
        method: 'POST',
        body: '{}',
        headers: { origin: 'dsh-app://app' },
      });
      assert.equal((await module.forwardWebRequest(allowed, host, owner)).status, 200);
      assert.equal(calls.at(-1).headers.get('origin'), host);
      const foreign = new Request(`dsh-app://app/api/zhuma-workspaces/${endpoint}`, {
        method: 'POST',
        body: '{}',
        headers: { origin: 'https://outside.example' },
      });
      assert.equal((await module.forwardWebRequest(foreign, host, owner)).status, 403);
    }
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = original;
    await rm(stage, { recursive: true, force: true });
  }
});
