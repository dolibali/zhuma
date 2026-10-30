#!/usr/bin/env node
/** Actual pinned SDK/plugin registration. Process and model ports are explicit contracts. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const { values } = parseArgs({ options: { sdk: { type: 'string' } } });
if (!values.sdk) throw Error('Pass --sdk with the built fixed SDK and installed ACP package');
const repository = fileURLToPath(new URL('../..', import.meta.url));
const lock = JSON.parse(readFileSync(join(repository, 'runtime.lock.json'), 'utf8'));
const sdk = resolve(values.sdk);
const upstreamCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: sdk,
  encoding: 'utf8',
}).trim();
assert.equal(upstreamCommit, lock.upstreams.deepseekHarness.commit);
execFileSync(
  'git',
  [
    'apply',
    '--reverse',
    '--check',
    join(repository, 'patches/deepseek-harness/zhuma-desktop.patch'),
  ],
  { cwd: sdk, stdio: 'pipe' },
);
const require = createRequire(join(sdk, 'packages/bundle/web-app/package.json'));
const paths = new Map();
for (const group of readdirSync(join(sdk, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of readdirSync(join(sdk, 'packages', group.name), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const manifest = join(sdk, 'packages', group.name, pkg.name, 'package.json');
    if (existsSync(manifest)) paths.set(JSON.parse(readFileSync(manifest, 'utf8')).name, manifest);
  }
}
const load = async (name) => {
  const resolver = paths.has(name) ? createRequire(paths.get(name)) : require;
  return import(pathToFileURL(resolver.resolve(name)).href);
};
const pluginPackage = require('@zaimokuza/dsh-acp-adapter/package.json');
assert.equal(pluginPackage.version, lock.plugins.acpAdapter.version);
assert.equal(pluginPackage.license, 'MIT');
const pluginRequire = createRequire(require.resolve('@zaimokuza/dsh-acp-adapter/package.json'));
for (const name of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
])
  assert.equal(
    realpathSync(require.resolve(name + '/package.json')),
    realpathSync(pluginRequire.resolve(name + '/package.json')),
    'Plugin must share the official Host peer graph',
  );
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
const root = await mkdtemp(join(tmpdir(), 'zhuma-acp-registration-'));
const ctx = new Context();
let inference = 0,
  spawns = 0;
class Native extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }
  async *stream() {
    inference++;
    throw Error('Registration must not run a model');
  }
}
try {
  ctx.provide('dshHomePath', (...parts) => join(root, ...parts));
  ctx.provide('subprocess', {
    spawn() {
      spawns++;
      throw Error('Registration must not start a subprocess');
    },
    async resolveExecutable() {
      return '/qualification/unused';
    },
  });
  for (const [name, config, whole] of [
    ['@deepseek-ai/dsh-llm'],
    ['@deepseek-ai/dsh-session'],
    ['@deepseek-ai/dsh-session-projection'],
    ['@deepseek-ai/dsh-system-prompt'],
    ['@deepseek-ai/dsh-tools'],
    ['@deepseek-ai/dsh-agent'],
    [
      '@deepseek-ai/dsh-session-persistence-jsonl',
      { root: join(root, 'sessions'), compression: 'none' },
      true,
    ],
    ['@deepseek-ai/dsh-agent-loop', { agents: [] }],
    ['@deepseek-ai/dsh-attachment-local', { dshHome: root }],
  ]) {
    const module = name === '@deepseek-ai/dsh-llm' ? { default: LlmRuntime } : await load(name);
    await ctx.plugin(whole ? module : module.default, config);
  }
  ctx.llm.registerAdapter(['native-qualification'], new Native());
  const before = await ctx.agents.create({
    sessionId: 'qualification-before',
    agentOptions: { provider: 'native-qualification', model: 'native' },
  });
  const type = before.agent.constructor;
  const capabilities = ctx.agents.lifecycleCapabilities;
  await before.dispose();
  const { installInstalledProfileRegistry } = await load('@zaimokuza/dsh-acp-adapter');
  const profiles = {
    codearts: {
      name: 'CodeArts qualification',
      command: 'unused-codearts-command',
      args: [],
      env: {},
    },
  };
  let guardRegistrations = 0;
  const registry = installInstalledProfileRegistry(
    ctx,
    {
      agents: { get: () => structuredClone(profiles) },
      toolApprovalDefault: { get: () => 'ask' },
    },
    {
      installRemote: true,
      ...(lock.plugins.acpAdapter.nativeToolHandoff
        ? {
            nativeToolHandoffGuard(id, profile) {
              assert.equal(id, 'codearts');
              assert.deepEqual(profile, profiles.codearts);
              guardRegistrations++;
              return () => false; // Contract only; no real producer or execution grant.
            },
          }
        : {}),
    },
  );
  await registry.ready;
  if (lock.plugins.acpAdapter.nativeToolHandoff) assert.equal(guardRegistrations, 1);
  assert.equal(registry.agents().get('codearts').name, 'CodeArts qualification');
  assert.ok(ctx.llm.listProviders().some((row) => row.id === 'acp-codearts'));
  assert.ok(ctx.llm.listProviders().some((row) => row.id === 'native-qualification'));
  const after = await ctx.agents.create({
    sessionId: 'qualification-after',
    agentOptions: { provider: 'native-qualification', model: 'native' },
  });
  assert.equal(after.agent.constructor, type);
  assert.deepEqual(ctx.agents.lifecycleCapabilities, capabilities);
  await after.dispose();
  const health = await ctx.get('dshAcp').health();
  assert.equal(health.providers[0].id, 'codearts');
  assert.equal(health.providers[0].probe.status, 'never');
  assert.equal(spawns, 0);
  assert.equal(inference, 0);
  const report = {
    scope: 'actual-pinned-plugin-public-registration-contract',
    upstreamCommit,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    sourceClean: !execFileSync('git', ['status', '--porcelain'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    pluginVersion: pluginPackage.version,
    pluginSource: lock.plugins.acpAdapter.commit,
    pluginMainSha256: createHash('sha256')
      .update(readFileSync(require.resolve('@zaimokuza/dsh-acp-adapter')))
      .digest('hex'),
    patchSha256: createHash('sha256')
      .update(readFileSync(join(repository, 'patches/deepseek-harness/zhuma-desktop.patch')))
      .digest('hex'),
    nativeFactoryPreserved: true,
    acpRouteRegistered: true,
    passiveHealthRead: true,
    hostGuardRegistration: guardRegistrations,
    spawns,
    inference,
    limits: [
      'Guarded subprocess port and synthetic native model adapter',
      'Public registry port with explicit Volatile values, not official Loader configuration',
      'No real CLI, login, paid model, task delivery, GUI or installer acceptance',
    ],
  };
  mkdirSync(join(repository, '.artifacts/desktop'), { recursive: true });
  writeFileSync(
    join(repository, '.artifacts/desktop/acp-registration-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
