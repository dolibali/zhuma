/** Real files/hash/registration; editor, ACP health and route projection are
 * contracts. Platform selection is simulated on non-Windows hosts. No CLI/model.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openHostCodeArtsSetup } from '../dist/host-codearts-setup.js';
import { describeCodeArtsRoutingCapability } from '../dist/executors/codearts/routing-metadata.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, kind, platform = 'win32') {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhuma 码道 & launcher ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installation = join(root, 'installers'),
    bin = join(installation, 'bin');
  await mkdir(bin, { recursive: true });
  const wrapper = join(
    installation,
    kind === 'unknown' ? 'other.cmd' : kind === 'batch' ? 'codearts.bat' : 'codearts.cmd',
  );
  const executable = join(bin, 'codearts.exe');
  const exeBytes = 'synthetic executable, never run';
  await writeFile(wrapper, 'synthetic batch, never parsed or run');
  if (!['missing', 'directory', 'foreign'].includes(kind)) await writeFile(executable, exeBytes);
  if (kind === 'directory') await mkdir(executable);
  if (kind === 'foreign') {
    const foreign = join(root, 'foreign.exe');
    await writeFile(foreign, exeBytes);
    await symlink(foreign, executable, 'file');
  }
  const adapter = 'synthetic adapter',
    policy = 'synthetic policy';
  await writeFile(join(root, 'codearts-acp.js'), adapter);
  await writeFile(join(root, 'codearts-policy.js'), policy);
  await writeFile(
    join(root, 'codearts-acp.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      entry: 'codearts-acp.js',
      acpProtocolSdk: '1.5.1',
      sha256: digest(adapter),
      policySha256: digest(policy),
    }),
  );
  const rows = [
    { options: { id: 'dsh-acp-adapter', name: '@zaimokuza/dsh-acp-adapter' } },
    {
      options: {
        id: 'zhuma-codearts-policy',
        name: pathToFileURL(join(root, 'codearts-policy.js')).href,
      },
    },
  ];
  const resolved = kind === 'direct' ? executable : wrapper;
  const resolutions = [],
    edits = [],
    warnings = [];
  let configured, artifacts;
  const dependencies = {
    configEditor: {
      entries: () => rows,
      async edit(row, change) {
        const value = change(row === rows[0] ? { agents: { foreign: { keep: true } } } : {});
        edits.push(row.options.id);
        if (row === rows[0]) configured = value;
        else artifacts = value.artifacts;
      },
    },
    dshAcp: { health: async () => ({ liveSessions: [] }) },
    subprocess: {
      async resolveExecutable(command, cwd, signal) {
        assert.equal(cwd, undefined);
        signal.throwIfAborted();
        resolutions.push(command);
        if (command === 'codearts') return resolved;
        assert.equal(command, executable);
        if (!(await stat(command)).isFile()) return undefined;
        return command;
      },
      spawn() {
        assert.fail('configuration must never launch a process');
      },
    },
    loader: { async await() {} },
    acpNativeToolHandoffPolicy: {
      currentRoutingCapability: () =>
        artifacts
          ? { provider: 'acp-zhuma-codearts', capability: describeCodeArtsRoutingCapability() }
          : undefined,
    },
  };
  const routes = new Map();
  const setup = openHostCodeArtsSetup(
    {
      fiber: { assertActive() {} },
      logger: { warn: (value) => warnings.push(value) },
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
    pathToFileURL(root + '/'),
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
  return {
    root,
    response,
    body: await response.json(),
    configured,
    artifacts,
    resolutions,
    edits,
    warnings,
    executable,
    exeBytes,
    wrapper,
  };
}

test('Windows discovery contract: official sibling EXE is resolved, hashed and registered without a shell or wrapper content', async (t) => {
  const f = await fixture(t, 'official');
  assert.equal(f.response.status, 200);
  assert.deepEqual(f.body, { ok: true, value: { configured: true } });
  assert.deepEqual(f.resolutions, ['codearts', f.executable]);
  assert.equal(f.artifacts.launcher.path, await realpath(f.executable));
  assert.equal(f.artifacts.launcher.sha256, digest(f.exeBytes));
  assert.equal(f.configured.agents['zhuma-codearts'].args[2], f.artifacts.launcher.path);
  assert.deepEqual(f.configured.agents.foreign, { keep: true });
  assert.deepEqual(f.edits, ['dsh-acp-adapter', 'zhuma-codearts-policy']);
  assert.deepEqual(f.warnings, []);
});

test('Windows discovery contract: direct EXE keeps one original resolver call', async (t) => {
  const f = await fixture(t, 'direct');
  assert.equal(f.response.status, 200);
  assert.deepEqual(f.resolutions, ['codearts']);
  assert.equal(f.artifacts.launcher.path, await realpath(f.executable));
});

for (const kind of ['missing', 'directory', 'unknown', 'batch', 'foreign']) {
  test(`Windows discovery contract: ${kind} sibling/layout refuses before configuration writes`, async (t) => {
    const f = await fixture(t, kind);
    assert.equal(f.response.status, 409);
    assert.deepEqual(f.body, { ok: false, code: 'command-not-found' });
    assert.deepEqual(f.edits, []);
    assert.equal(f.artifacts, undefined);
    assert.equal(JSON.stringify(f.body).includes(f.root), false);
  });
}

test('non-Windows discovery contract: existing launch file is preserved', async (t) => {
  const f = await fixture(t, 'official', 'darwin');
  assert.equal(f.response.status, 200);
  assert.deepEqual(f.resolutions, ['codearts']);
  assert.equal(f.artifacts.launcher.path, await realpath(f.wrapper));
});
