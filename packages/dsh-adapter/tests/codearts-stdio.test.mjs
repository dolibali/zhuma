/** Real generated stdio entry/process lifecycle with a synthetic CLI-shaped HTTP peer. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { build } from 'esbuild';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describeCodeArtsRoutingCapability } from '../dist/executors/codearts/routing-metadata.js';
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const bridge = (digit) => ({
  type: 'http',
  name: `dshteam_${digit.repeat(16)}`,
  url: `http://127.0.0.1:44444/${digit.repeat(64)}`,
  headers: [],
});

test(
  'CodeArts stdio artifact: init does not launch; cold resume keeps SID and rotates only its bridge',
  { skip: process.platform === 'win32', timeout: 15_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-codearts-stdio-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const entry = join(root, 'codearts-acp.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../src/executors/codearts/main.ts', import.meta.url))],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
    });
    const launcher = join(root, 'codearts');
    const fixture = fileURLToPath(new URL('./fixtures/codearts-cli.mjs', import.meta.url));
    await writeFile(
      launcher,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
      { mode: 0o755 },
    );
    const statePath = join(root, 'owned-state.json');
    async function launch() {
      const processChild = spawn(process.execPath, [entry, '--codearts-command', launcher], {
        cwd: root,
        env: { ...process.env, ZHUMA_CODEARTS_FIXTURE_STATE: statePath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      processChild.stderr.on('data', (value) => {
        stderr = (stderr + value).slice(-1000);
      });
      const done = new Promise((resolve, reject) => {
        processChild.once('error', reject);
        processChild.once('exit', (code) => resolve(code));
      });
      const updates = [];
      const client = new ClientSideConnection(
        () => ({
          async sessionUpdate(value) {
            updates.push(value);
          },
        }),
        ndJsonStream(Writable.toWeb(processChild.stdin), Readable.toWeb(processChild.stdout)),
      );
      t.after(async () => {
        if (processChild.exitCode === null) {
          processChild.stdin.end();
          processChild.kill('SIGTERM');
        }
        await done;
      });
      try {
        await client.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'owned-stdio-test', version: '1' },
        });
      } catch (error) {
        throw new Error(`Synthetic ACP artifact failed: ${stderr}`, { cause: error });
      }
      return {
        client,
        updates,
        async close() {
          processChild.stdin.end();
          assert.equal(await done, 0, stderr);
        },
      };
    }
    const first = await launch();
    await assert.rejects(access(statePath));
    // Same RPC sequence as the original community model catalogue probe:
    // initialize -> session/new with no bridge -> configOptions -> close.
    const metadata = await first.client.newSession({ cwd: root, mcpServers: [] });
    const route = describeCodeArtsRoutingCapability();
    assert.equal(metadata._meta['zhuma.dev/session-kind'], 'metadata-only');
    assert.equal(metadata.configOptions[0].currentValue, route.id);
    assert.deepEqual(metadata.configOptions[0].options, [{ value: route.id, name: route.name }]);
    assert.equal(metadata.models.currentModelId, route.id);
    assert.deepEqual(metadata.models.availableModels, [{ modelId: route.id, name: route.name }]);
    assert.equal(metadata._meta['zhuma.dev/model-source'], route.kind);
    assert.equal(metadata._meta['zhuma.dev/backend-verified'], route.backendVerified);
    await assert.rejects(access(statePath), 'catalogue discovery must not launch the CLI');
    await assert.rejects(
      first.client.prompt({
        sessionId: metadata.sessionId,
        prompt: [{ type: 'text', text: 'Must not execute' }],
      }),
    );
    await assert.rejects(
      first.client.resumeSession({
        cwd: root,
        sessionId: metadata.sessionId,
        mcpServers: [bridge('1')],
      }),
    );
    await first.client.closeSession({ sessionId: metadata.sessionId });
    await assert.rejects(access(statePath));
    const session = await first.client.newSession({ cwd: root, mcpServers: [bridge('1')] });
    assert.equal(session.sessionId, 'ses_fixture_owned');
    await first.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Owned stdio test' }],
    });
    assert.equal(
      first.updates
        .filter((item) => item.update.sessionUpdate === 'agent_message_chunk')
        .map((item) => item.update.content.text)
        .join(''),
      'fixture live output',
    );
    const old = JSON.parse(await readFile(statePath, 'utf8'));
    await first.close();
    assert.throws(() => process.kill(old.pid, 0));
    const second = await launch();
    await second.client.resumeSession({
      sessionId: session.sessionId,
      cwd: root,
      mcpServers: [bridge('2')],
    });
    await second.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Explicit same-session continuation' }],
    });
    const current = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(current.createCalls, 1);
    assert.deepEqual(current.mcpNames, ['dshteam_2222222222222222']);
    assert.equal(current.promptTools[1]['dshteam_1111111111111111_*'], undefined);
    assert.equal(current.promptTools[1]['dshteam_2222222222222222_*'], true);
    assert.equal(current.promptTools[1]['*'], false);
    await second.close();
    assert.throws(() => process.kill(current.pid, 0));
  },
);
