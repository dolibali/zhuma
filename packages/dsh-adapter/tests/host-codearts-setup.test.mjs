/** Original profile editor/Loader/subprocess path resolution over a disposable
 * synthetic profile. ACP service/factory is a contract fixture; no CLI/model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import * as Policy from '../dist/host-codearts-policy.js';
import { openHostCodeArtsSetup } from '../dist/host-codearts-setup.js';

const layout = process.env.ZHUMA_CODEARTS_LAYOUT ?? 'directory';
test(
  `CodeArts normal setup (${layout}): original persistent profile writes, passive executable lookup, cold reopen and no launcher execution`,
  {
    skip: !process.env.ZHUMA_CODEARTS_LOADER_MODULE || !process.env.ZHUMA_CODEARTS_BUNDLE,
    timeout: 30_000,
  },
  async (t) => {
    const sdk = new URL(
      '../../../',
      pathToFileURL(resolve(process.env.ZHUMA_CODEARTS_LOADER_MODULE)),
    );
    const { boot, initProfile, readProfilePatches } = await import(
      new URL('packages/boot/app-boot/lib/index.js', sdk)
    );
    const { default: ConfigEditor } = await import(
      new URL('packages/boot/config-editor/lib/index.js', sdk)
    );
    const { LocalSubprocessRuntime } = await import(
      new URL('packages/subprocess/subprocess-local/lib/index.js', sdk)
    );
    const home = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-codearts-settings-'))),
      dir = join(home, 'profiles', 'test'),
      audit = join(home, 'not-launched'),
      launcher = join(home, 'synthetic codearts');
    t.after(() => rm(home, { recursive: true, force: true }));
    initProfile(dir, ['test-bundle']);
    await writeFile(join(home, 'package.json'), '{"name":"synthetic-installation"}\n');
    await writeFile(launcher, `#!/bin/sh\nprintf launched > '${audit}'\nexit 90\n`, {
      mode: 0o755,
    });
    const bundle = join(dir, 'node_modules', 'test-bundle');
    await mkdir(bundle, { recursive: true });
    const suffix = join('dsh', 'node_modules', 'test-bundle', 'lib', 'zhuma-workbench');
    const launchDirectory =
      layout === 'asar'
        ? join(home, 'app.asar.unpacked', suffix)
        : join(bundle, 'lib', 'zhuma-workbench');
    await mkdir(launchDirectory, { recursive: true });
    for (const file of ['codearts-acp.js', 'codearts-policy.js', 'codearts-acp.manifest.json'])
      await writeFile(
        join(launchDirectory, file),
        await readFile(join(dirname(resolve(process.env.ZHUMA_CODEARTS_BUNDLE)), file)),
      );
    if (layout === 'asar') await writeFile(join(home, 'app.asar'), 'opaque archive fixture');
    const launchURL = pathToFileURL(
      (layout === 'asar' ? join(home, 'app.asar', suffix) : launchDirectory) + '/',
    );
    await writeFile(
      join(bundle, 'package.json'),
      JSON.stringify({
        name: 'test-bundle',
        version: '1.0.0',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }),
    );
    await writeFile(
      join(bundle, 'cordis.patch.yml'),
      JSON.stringify([
        {
          insert: [
            { id: 'config-editor', name: 'cordis:editor' },
            {
              id: 'zhuma-codearts-policy',
              name:
                layout === 'asar'
                  ? new URL(
                      'codearts-policy.js',
                      process.env.ZHUMA_CODEARTS_POLICY_PHYSICAL
                        ? pathToFileURL(launchDirectory + '/')
                        : launchURL,
                    ).href
                  : './lib/zhuma-workbench/codearts-policy.js',
              config: {},
            },
            {
              id: 'dsh-acp-adapter',
              name: '@zaimokuza/dsh-acp-adapter',
              inject: ['acpNativeToolHandoffPolicy'],
              config: {
                agents: {
                  foreign: {
                    name: 'Foreign',
                    command: 'synthetic',
                    args: [],
                    env: { KEEP: 'SYNTHETIC_FOREIGN' },
                  },
                },
                toolApprovalDefault: 'ask',
              },
            },
          ],
        },
      ]),
    );
    await writeFile(join(dir, 'cordis.yml'), '[]\n');
    const profile = {
      name: 'test',
      startedBundles: ['test-bundle'],
      dir,
      patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'),
      cwd: home,
      home,
      overlays: [],
      telemetryDisabledEnv: undefined,
    };
    let sessions = [],
      principal = 'owner',
      resolutions = 0;
    const guards = [],
      writeErrors = [];
    async function start() {
      const routes = new Map();
      const acp = {
        Config: z.object({
          agents: z.record(z.string(), z.unknown()).default({}),
          toolApprovalDefault: z.string().optional(),
        }),
        apply(ctx, config) {
          ctx.provide('dshAcp', {
            health: async () => ({ providers: [], liveSessions: sessions }),
          });
          const guard = ctx
            .get('acpNativeToolHandoffPolicy')
            .guardForProfile('zhuma-codearts', config.agents['zhuma-codearts']);
          if (guard) guards.push(guard);
        },
      };
      const ctx = await boot(
        'dsh',
        join(dir, 'cordis.yml'),
        readProfilePatches('dsh', profile),
        (ctx) => {
          ctx.provide('profileContext', profile);
          ctx.provide('connection', {
            requestRejection: () => undefined,
            admit: () => ({ peer: { principal: { kind: principal } } }),
            fetch: {
              register(route) {
                routes.set(route.path, route);
                return () => routes.delete(route.path);
              },
            },
          });
          const subprocess = new LocalSubprocessRuntime(ctx),
            original = subprocess.resolveExecutable.bind(subprocess);
          subprocess.resolveExecutable = (...args) => {
            resolutions++;
            return original(...args);
          };
          const load = ctx.loader.internal.import.bind(ctx.loader.internal);
          ctx.loader.internal.import = (specifier) =>
            [launchURL, pathToFileURL(launchDirectory + '/')].some(
              (base) => specifier === new URL('codearts-policy.js', base).href,
            )
              ? Promise.resolve(Policy)
              : specifier === '@zaimokuza/dsh-acp-adapter'
                ? Promise.resolve(acp)
                : load(specifier);
          ctx.loader.builtins.editor = ConfigEditor;
        },
      );
      const edit = ctx.configEditor.edit.bind(ctx.configEditor);
      ctx.configEditor.edit = async (...args) => {
        try {
          return await edit(...args);
        } catch (error) {
          writeErrors.push(String(error));
          throw error;
        }
      };
      const setup = openHostCodeArtsSetup(ctx, launchURL);
      t.after(async () => {
        await setup.close();
        await ctx.fiber.dispose();
      });
      async function call(endpoint, command) {
        const response = await routes.get(`/api/zhuma-codearts/${endpoint}`).fetch(
          new Request(`http://local.invalid/api/zhuma-codearts/${endpoint}`, {
            method: command === undefined ? 'GET' : 'POST',
            headers: {
              origin: 'http://local.invalid',
              host: 'local.invalid',
              'content-type': 'application/json',
            },
            ...(command === undefined ? {} : { body: JSON.stringify({ command }) }),
          }),
        );
        return { status: response.status, body: await response.json() };
      }
      return { ctx, setup, call };
    }
    const first = await start();
    const before = await readFile(profile.patchPath, 'utf8');
    assert.deepEqual((await first.call('status')).body, { ok: true, value: { configured: false } });
    assert.equal(resolutions, 0);
    principal = 'member';
    assert.equal((await first.call('configure', launcher)).status, 403);
    principal = 'owner';
    sessions = [{ sessionId: 'synthetic-session' }];
    assert.equal((await first.call('configure', launcher)).body.code, 'active-sessions');
    assert.equal(resolutions, 0);
    sessions = [];
    assert.equal((await first.call('configure', 'codearts --unsafe')).status, 400);
    assert.equal(await readFile(profile.patchPath, 'utf8'), before);
    const result = await first.call('configure', launcher);
    assert.deepEqual(
      result.body,
      { ok: true, value: { configured: true } },
      JSON.stringify(writeErrors),
    );
    assert.equal(resolutions, 1);
    assert.equal(JSON.stringify(result.body).includes(home), false);
    const saved = parse(await readFile(profile.patchPath, 'utf8'));
    const row = saved.find((item) => item.id === 'dsh-acp-adapter');
    assert.equal(row.config.agents.foreign.env.KEEP, 'SYNTHETIC_FOREIGN');
    assert.equal(row.config.toolApprovalDefault, 'ask');
    assert.equal(row.config.agents['zhuma-codearts'].args[2], launcher);
    assert.equal(
      row.config.agents['zhuma-codearts'].args[0],
      await realpath(join(launchDirectory, 'codearts-acp.js')),
    );
    assert.equal((await stat(profile.patchPath)).mode & 0o777, 0o600);
    await assert.rejects(access(audit));
    assert.equal(guards.at(-1)(), true);
    await first.setup.close();
    await first.ctx.fiber.dispose();
    assert.equal(guards.at(-1)(), false);
    const cold = await start();
    assert.deepEqual((await cold.call('status')).body, { ok: true, value: { configured: true } });
    assert.equal(resolutions, 1, 'reopening status never resolves or launches a command');
    assert.equal(guards.at(-1)(), true);
    await assert.rejects(access(audit));
    await cold.setup.close();
    await cold.ctx.fiber.dispose();
    const adapterFile = join(launchDirectory, 'codearts-acp.js');
    const nextAdapter = Buffer.concat([await readFile(adapterFile), Buffer.from('\n')]);
    await writeFile(adapterFile, nextAdapter);
    const manifestFile = join(launchDirectory, 'codearts-acp.manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.sha256 = createHash('sha256').update(nextAdapter).digest('hex');
    await writeFile(manifestFile, JSON.stringify(manifest));
    const upgraded = await start();
    assert.deepEqual((await upgraded.call('status')).body, {
      ok: true,
      value: { configured: false },
    });
    assert.equal(
      !!upgraded.ctx.get('dshAcp'),
      true,
      'original ACP/settings stay available after an artifact upgrade',
    );
    assert.deepEqual((await upgraded.call('configure', launcher)).body, {
      ok: true,
      value: { configured: true },
    });
    assert.equal(guards.at(-1)(), true);
    assert.equal(resolutions, 2);
    await assert.rejects(access(audit));
  },
);

// Explicit rejection contracts; no original composition or CLI claim.
for (const scenario of [
  'editor-missing',
  'acp-entry-missing',
  'policy-neighbor',
  'policy-query',
  'policy-hash',
  'duplicate-entry',
  'health-null',
  'health-throws',
  'resolver-throws',
  'manifest-missing',
  'active-runtime',
  'asar-policy-neighbor',
  'asar-policy-missing',
  'asar-like-directory',
]) {
  test(`CodeArts setup rejects ${scenario} without writes and logs only its fixed stage`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-codearts-entry-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const archived = scenario.startsWith('asar-policy-');
    const directory = archived
      ? join(home, 'app.asar.unpacked', 'plugin')
      : scenario === 'asar-like-directory'
        ? join(home, 'app.asar.backup', 'plugin')
        : home;
    await mkdir(directory, { recursive: true });
    if (archived) await writeFile(join(home, 'app.asar'), 'opaque archive fixture');
    const bundle = pathToFileURL((archived ? join(home, 'app.asar', 'plugin') : directory) + '/');
    const bytes = 'synthetic policy; not executed\n';
    if (scenario !== 'asar-policy-missing')
      await writeFile(join(directory, 'codearts-policy.js'), bytes);
    await mkdir(join(directory, 'foreign'));
    await writeFile(join(directory, 'foreign', 'codearts-policy.js'), bytes);
    const rows = [
      { options: { id: 'dsh-acp-adapter', name: '@zaimokuza/dsh-acp-adapter' } },
      {
        options: { id: 'zhuma-codearts-policy', name: new URL('codearts-policy.js', bundle).href },
      },
    ];
    if (scenario === 'acp-entry-missing') rows.shift();
    if (scenario === 'policy-neighbor')
      rows[1].options.name = pathToFileURL(join(directory, 'foreign', 'codearts-policy.js')).href;
    if (scenario === 'asar-policy-neighbor')
      rows[1].options.name = new URL('foreign/codearts-policy.js', bundle).href;
    if (scenario === 'policy-query') rows[1].options.name += '?generation=other';
    if (scenario === 'policy-hash') rows[1].options.name += '#other';
    if (scenario === 'duplicate-entry') rows.push(rows[1]);
    let edits = 0,
      resolutions = 0;
    const diagnostics = [];
    const dependencies = {
      configEditor:
        scenario === 'editor-missing'
          ? undefined
          : {
              entries: () => rows,
              edit: async () => {
                edits++;
              },
            },
      dshAcp: {
        health: async () => {
          if (scenario === 'health-throws')
            throw new Error('diagnostic-secret /private/never-print');
          return {
            providers: [],
            liveSessions:
              scenario === 'health-null'
                ? null
                : scenario === 'active-runtime'
                  ? [{ sessionId: 'synthetic-runtime' }]
                  : [],
          };
        },
      },
      subprocess: {
        resolveExecutable: async () => {
          resolutions++;
          if (scenario === 'manifest-missing') return process.execPath;
          throw new Error('diagnostic-secret /private/never-print');
        },
      },
    };
    const routes = new Map();
    const setup = openHostCodeArtsSetup(
      {
        fiber: { assertActive() {} },
        logger: { warn: (text) => diagnostics.push(text) },
        get: (name) => dependencies[name],
        effect() {},
        connection: {
          requestRejection: () => undefined,
          admit: () => ({ peer: { principal: { kind: 'owner' } } }),
          fetch: {
            register: (route) => {
              routes.set(route.path, route);
              return () => routes.delete(route.path);
            },
          },
        },
      },
      bundle,
    );
    t.after(() => setup.close());
    const response = await routes.get('/api/zhuma-codearts/configure').fetch(
      new Request('http://local.invalid/api/zhuma-codearts/configure', {
        method: 'POST',
        headers: {
          origin: 'http://local.invalid',
          host: 'local.invalid',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ command: 'codearts' }),
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(
      (await response.json()).code,
      scenario === 'active-runtime' ? 'active-sessions' : 'unavailable',
    );
    assert.equal(edits, 0);
    assert.equal(
      resolutions,
      ['resolver-throws', 'manifest-missing', 'asar-like-directory'].includes(scenario) ? 1 : 0,
    );
    const stage = {
      'editor-missing': 'editor',
      'acp-entry-missing': 'acp-entry',
      'policy-neighbor': 'policy-entry',
      'policy-query': 'policy-entry',
      'policy-hash': 'policy-entry',
      'duplicate-entry': 'policy-entry',
      'health-null': 'health',
      'health-throws': 'health',
      'resolver-throws': 'resolve-command',
      'manifest-missing': 'manifest',
      'asar-policy-neighbor': 'policy-entry',
      'asar-policy-missing': 'policy-entry',
      'asar-like-directory': 'resolve-command',
    }[scenario];
    assert.deepEqual(diagnostics, stage ? [`CodeArts setup unavailable at ${stage}.`] : []);
    assert.equal(JSON.stringify(diagnostics).includes('diagnostic-secret'), false);
    assert.equal(JSON.stringify(diagnostics).includes('/private/'), false);
  });
}
