/** Actual Cordis/producer/files; synthetic launch files are contracts, never CLI/model readiness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Inject } from '@deepseek-ai/cordis';
import { mkdtemp, writeFile, readFile, rm, access, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { parse } from 'yaml';
import * as Policy from '../dist/host-codearts-policy.js';
import { createCodeArtsProfileRegistration } from '../dist/index.js';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-codearts-policy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = {};
  for (const key of ['node', 'adapter', 'launcher']) {
    const path = join(root, key),
      bytes = Buffer.from(`synthetic-${key}`);
    await writeFile(path, bytes);
    artifacts[key] = { path, sha256: hash(bytes) };
  }
  const registration = await createCodeArtsProfileRegistration({
    ...artifacts,
    signal: new AbortController().signal,
  });
  const profile = structuredClone(registration.profile);
  registration.revoke();
  return { root, artifacts, profile };
}

test('CodeArts Host policy: exact verified generation and full profile; change, unload and failed preparation cannot regain a grant', async (t) => {
  const { artifacts, profile } = await fixture(t),
    ctx = new Context();
  const mount = ctx.plugin(Policy, { artifacts });
  t.after(() => mount.dispose());
  await mount;
  const policy = ctx.get('acpNativeToolHandoffPolicy');
  const guard = policy.guardForProfile('zhuma-codearts', profile);
  assert.equal(typeof guard, 'function');
  assert.equal(guard(), true);
  assert.equal(policy.guardForProfile('other', profile), undefined);
  assert.equal(
    policy.guardForProfile('zhuma-codearts', {
      ...profile,
      env: { ...profile.env, EXTRA: 'changed' },
    }),
    undefined,
  );
  assert.equal(guard(), false);
  assert.equal(
    policy.guardForProfile('zhuma-codearts', profile),
    undefined,
    'retired generation cannot be reacquired',
  );
  await mount.dispose();
  assert.equal(guard(), false);
  const empty = new Context(),
    disabled = empty.plugin(Policy, {});
  await disabled;
  assert.equal(
    empty.get('acpNativeToolHandoffPolicy').guardForProfile('zhuma-codearts', profile),
    undefined,
  );
  await disabled.dispose();
  const failed = new Context(),
    invalid = failed.plugin(Policy, {
      artifacts: { ...artifacts, adapter: { ...artifacts.adapter, sha256: '0'.repeat(64) } },
    });
  await assert.rejects(Promise.resolve(invalid), /launch artifacts are unavailable/);
  assert.equal(failed.get('acpNativeToolHandoffPolicy'), undefined);
  await invalid.dispose();
});

test('CodeArts product composition adds a producer dependency without replacing original plugin identity or inject requirements', async () => {
  const overlay = parse(
    await readFile(
      new URL('../../../distribution/workbench/cordis.patch.yml', import.meta.url),
      'utf8',
    ),
  );
  const entries = overlay.find((row) => row.insert).insert,
    acp = entries.find((row) => row.id === 'dsh-acp-adapter'),
    policy = entries.find((row) => row.id === 'zhuma-codearts-policy');
  assert.equal(acp.name, '@zaimokuza/dsh-acp-adapter');
  assert.equal(policy.name, './lib/zhuma-workbench/codearts-policy.js');
  assert.deepEqual(acp.inject, ['acpNativeToolHandoffPolicy']);
  const original = Inject.resolve(['llm', 'sessions', 'subprocess']);
  Inject.resolve(acp.inject, original);
  assert.deepEqual(Object.keys(original), [
    'llm',
    'sessions',
    'subprocess',
    'acpNativeToolHandoffPolicy',
  ]);
});

test(
  'CodeArts actual Loader entry inject waits for producer and replays only after the original ready service',
  { skip: !process.env.ZHUMA_CODEARTS_LOADER_MODULE },
  async (t) => {
    const file = resolve(process.env.ZHUMA_CODEARTS_LOADER_MODULE),
      require = createRequire(file);
    const { Context: SdkContext } = await import(
      pathToFileURL(require.resolve('@deepseek-ai/cordis')).href
    );
    const { default: Loader } = await import(pathToFileURL(file).href);
    const actualPolicy = process.env.ZHUMA_CODEARTS_BUNDLE
      ? await import(
          pathToFileURL(
            join(dirname(resolve(process.env.ZHUMA_CODEARTS_BUNDLE)), 'codearts-policy.js'),
          ).href
        )
      : Policy;
    const { artifacts, profile: profiles } = await fixture(t),
      ctx = new SdkContext();
    await ctx.plugin(Loader);
    t.after(() => ctx.fiber.dispose());
    const calls = [];
    const consumer = {
      inject: ['originalSeam'],
      apply(child) {
        calls.push(
          child.get('acpNativeToolHandoffPolicy').guardForProfile('zhuma-codearts', profiles),
        );
      },
    };
    const modules = new Map([
      ['consumer', consumer],
      ['policy', actualPolicy],
    ]);
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier) {
        if (!modules.has(specifier)) throw Error('Unexpected module');
        return modules.get(specifier);
      },
    };
    ctx.provide('originalSeam', {});
    await ctx.loader.create({
      id: 'consumer',
      name: 'consumer',
      inject: ['acpNativeToolHandoffPolicy'],
    });
    assert.equal(calls.length, 0, 'no factory registration before prepare');
    await ctx.loader.create({ id: 'policy', name: 'policy', config: { artifacts } });
    await ctx.loader.await();
    assert.equal(calls.length, 1);
    assert.equal(calls[0](), true);
    const entry = ctx.loader.resolve('policy');
    await entry.fiber.dispose();
    assert.equal(calls[0](), false, 'old factory guard stays retired on producer unload');
  },
);

test(
  'CodeArts emitted independent bundle: original ACP initialize and private patch generation launch no CLI',
  { skip: !process.env.ZHUMA_CODEARTS_BUNDLE, timeout: 30000 },
  async (t) => {
    const file = resolve(process.env.ZHUMA_CODEARTS_BUNDLE),
      { root } = await fixture(t),
      audit = join(root, 'not-created');
    const launcher = join(root, 'unused-codearts');
    await writeFile(launcher, '#!/bin/sh\nprintf launched >> "$ZHUMA_LAUNCH_AUDIT"\nexit 90\n', {
      mode: 0o755,
    });
    const child = spawn(process.execPath, [file, '--codearts-command', launcher], {
      cwd: root,
      env: { ELECTRON_RUN_AS_NODE: '1', ZHUMA_LAUNCH_AUDIT: audit },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stderr.on('data', (bytes) => {
      diagnostics = (diagnostics + bytes).slice(-1000);
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.stdin.end();
        child.kill('SIGTERM');
      }
      await done;
    });
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {
          throw Error('initialize cannot publish session updates');
        },
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    );
    const hello = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'launch-artifact-contract', version: '1' },
    });
    assert.equal(hello.agentInfo.name, 'zhuma-codearts');
    await assert.rejects(access(audit));
    child.stdin.end();
    assert.equal(await done, 0, diagnostics);
    const output = join(root, 'private-launch.json');
    const command = new URL(
      '../../../scripts/desktop/prepare-codearts-profile.mjs',
      import.meta.url,
    );
    execFileSync(
      process.execPath,
      [
        command.pathname,
        '--node',
        process.execPath,
        '--launcher',
        launcher,
        '--bundle',
        dirname(file),
        '--out',
        output,
      ],
      { stdio: 'pipe', env: { ...process.env, ZHUMA_LAUNCH_AUDIT: audit } },
    );
    const patch = JSON.parse(await readFile(output, 'utf8'));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(patch[0].id, 'zhuma-codearts-policy');
    assert.equal(patch[1].id, 'dsh-acp-adapter');
    assert.equal(patch[0].config.artifacts.adapter.sha256, hash(await readFile(file)));
    assert.deepEqual(patch[1].config.agents['zhuma-codearts'].args, [
      file,
      '--codearts-command',
      launcher,
    ]);
    await assert.rejects(access(audit));
  },
);
