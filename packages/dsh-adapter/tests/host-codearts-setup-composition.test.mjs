/** Original ACP composition, ConfigEditor/Loader and subprocess resolver in an
 * isolated profile. No CLI/model executes; synthetic command is only resolved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import * as Policy from '../dist/host-codearts-policy.js';
import { openHostCodeArtsSetup } from '../dist/host-codearts-setup.js';

test(
  'CodeArts original composition: actual ACP health, persistent configure and cold reopen without CLI/model',
  {
    skip:
      !process.env.ZHUMA_CODEARTS_LOADER_MODULE ||
      !process.env.ZHUMA_CODEARTS_BUNDLE ||
      !process.env.ZHUMA_CODEARTS_ACP_MODULE,
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
    const launchDirectory = join(bundle, 'lib', 'zhuma-workbench');
    await mkdir(launchDirectory, { recursive: true });
    for (const file of ['codearts-acp.js', 'codearts-policy.js', 'codearts-acp.manifest.json'])
      await writeFile(
        join(launchDirectory, file),
        await readFile(join(dirname(resolve(process.env.ZHUMA_CODEARTS_BUNDLE)), file)),
      );
    const launchURL = pathToFileURL(launchDirectory + '/');
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
              name: fileURLToPath(new URL('codearts-policy.js', launchURL)),
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
    let principal = 'owner',
      resolutions = 0,
      spawns = 0;
    const writeErrors = [];
    const acp = await import(pathToFileURL(resolve(process.env.ZHUMA_CODEARTS_ACP_MODULE)));
    const manifests = new Map();
    const sdkPath = fileURLToPath(sdk);
    for (const group of readdirSync(join(sdkPath, 'packages'), { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      for (const pkg of readdirSync(join(sdkPath, 'packages', group.name), {
        withFileTypes: true,
      })) {
        if (!pkg.isDirectory()) continue;
        const path = join(sdkPath, 'packages', group.name, pkg.name, 'package.json');
        if (existsSync(path)) manifests.set(JSON.parse(readFileSync(path, 'utf8')).name, path);
      }
    }
    const load = async (name) =>
      import(pathToFileURL(createRequire(manifests.get(name)).resolve(name)));
    const modules = new Map();
    for (const name of [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-session-persistence-jsonl',
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-attachment-local',
      '@deepseek-ai/dsh-sandbox-local',
      '@deepseek-ai/dsh-sandbox-policy',
      '@deepseek-ai/dsh-bash-sandbox',
      '@deepseek-ai/dsh-user-approval',
      '@deepseek-ai/dsh-permission-presets',
    ])
      modules.set(name, await load(name));
    async function start() {
      const routes = new Map();
      const ctx = await boot(
        'dsh',
        join(dir, 'cordis.yml'),
        readProfilePatches('dsh', profile),
        async (ctx) => {
          ctx.provide('profileContext', profile);
          ctx.dshHomePath = (...parts) => join(home, ...parts);
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
          subprocess.spawn = () => {
            spawns++;
            throw new Error('No CLI/model may be launched by passive setup');
          };
          for (const [name, config, whole] of [
            ['@deepseek-ai/dsh-llm'],
            ['@deepseek-ai/dsh-session'],
            ['@deepseek-ai/dsh-session-projection'],
            ['@deepseek-ai/dsh-system-prompt'],
            ['@deepseek-ai/dsh-tools'],
            ['@deepseek-ai/dsh-agent'],
            [
              '@deepseek-ai/dsh-session-persistence-jsonl',
              { root: join(home, 'sessions'), compression: 'none' },
              true,
            ],
            ['@deepseek-ai/dsh-agent-loop', { agents: [] }],
            ['@deepseek-ai/dsh-attachment-local', { dshHome: home }],
            ['@deepseek-ai/dsh-sandbox-local'],
            ['@deepseek-ai/dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: home }],
            ['@deepseek-ai/dsh-bash-sandbox'],
            ['@deepseek-ai/dsh-user-approval'],
            [
              '@deepseek-ai/dsh-permission-presets',
              { presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } } },
            ],
          ]) {
            const module = modules.get(name);
            await ctx.plugin(whole ? module : module.default, config);
          }
          const originalImport = ctx.loader.internal.import.bind(ctx.loader.internal);
          ctx.loader.internal.import = (specifier) =>
            [
              new URL('codearts-policy.js', launchURL).href,
              fileURLToPath(new URL('codearts-policy.js', launchURL)),
            ].includes(specifier)
              ? Promise.resolve(Policy)
              : specifier === '@zaimokuza/dsh-acp-adapter'
                ? Promise.resolve(acp)
                : originalImport(specifier);
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
    assert.deepEqual(
      (await first.ctx.dshAcp.health()).liveSessions,
      [],
      'actual original composition reads an empty resource registry',
    );
    assert.equal((await first.call('configure', 'codearts --unsafe')).status, 400);
    assert.equal(await readFile(profile.patchPath, 'utf8'), before);
    const result = await first.call('configure', launcher);
    assert.deepEqual(
      result.body,
      { ok: true, value: { configured: true } },
      JSON.stringify(writeErrors),
    );
    assert.ok(resolutions > 0);
    const afterConfigureResolutions = resolutions;
    assert.equal(JSON.stringify(result.body).includes(home), false);
    const saved = parse(await readFile(profile.patchPath, 'utf8'));
    const row = saved.find((item) => item.id === 'dsh-acp-adapter');
    assert.equal(row.config.agents.foreign.env.KEEP, 'SYNTHETIC_FOREIGN');
    assert.equal(row.config.toolApprovalDefault, 'ask');
    assert.equal(row.config.agents['zhuma-codearts'].args[2], launcher);
    assert.equal((await stat(profile.patchPath)).mode & 0o777, 0o600);
    await assert.rejects(access(audit));
    assert.equal(
      first.ctx
        .get('acpNativeToolHandoffPolicy')
        .guardForProfile(
          'zhuma-codearts',
          first.ctx.configEditor.entries().find((r) => r.options.id === 'dsh-acp-adapter').options
            .config.agents['zhuma-codearts'],
        )(),
      true,
    );
    await first.setup.close();
    await first.ctx.fiber.dispose();

    const cold = await start();
    assert.deepEqual((await cold.call('status')).body, { ok: true, value: { configured: true } });
    assert.equal(
      resolutions,
      afterConfigureResolutions,
      'reopening status never resolves or launches a command',
    );
    assert.ok(cold.ctx.get('dshAcp'));
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
    assert.ok(upgraded.ctx.get('dshAcp'));
    assert.ok(resolutions > afterConfigureResolutions);
    assert.equal(spawns, 0);
    await assert.rejects(access(audit));
  },
);
