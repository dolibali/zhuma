/** Emitted Host, original fixed SDK/factory, true local Cookie/Run/JSON and actual
 * filesystem/attachment bytes. Model responses are local scripts; no GUI/model-provider proof.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { boot, checked, waitFor } from './zhuma-host-run-native.spec.ts';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';

const localBegin = (h) => ({
  ...h.begin,
  tools: 'local-tools',
  workspace: { kind: 'local', id: 'project-files' },
});
function tool(name, args, id = name) {
  return function* () {
    const text = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}
async function start(h) {
  const receipt = checked(await h.rpc('run', 'begin', localBegin(h)));
  assert.equal(receipt.dispatch, 'received');
  await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
  const view = checked(await h.rpc('run', 'read', { ...h.locator, runId: h.begin.newRunId }));
  const agent = h.ctx.agents.get(view.native.sessionId);
  assert.ok(agent);
  await agent.whenIdle();
  return agent;
}

test(
  'actual Host local workspace: explicit trusted selection runs original read/write/edit only inside its actual root',
  { timeout: 20000 },
  async (t) => {
    const adapter = new ScriptedAdapter([
      tool('write', { file_path: 'note.txt', content: 'first' }),
      tool('read', { file_path: 'note.txt' }),
      tool('edit', { file_path: 'note.txt', old_string: 'first', new_string: 'revised' }),
      tool('read', { file_path: '../outside-sentinel.txt' }),
      tool('publish_output_file', { path: 'note.txt' }),
      'Done',
    ]);
    const h = await boot(t, {
      localWorkspace: { access: 'write', policyMode: 'workspace-write' },
      adapter,
    });
    const sentinel = 'OWNED-TEST-OUTSIDE-WORKSPACE';
    await writeFile(join(h.root, 'outside-sentinel.txt'), sentinel);
    const options = checked(await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }));
    assert.deepEqual(options.workspaces, [
      { id: 'project-files', label: 'Local contract project', access: 'write', publish: false },
    ]);
    assert.equal(JSON.stringify(options).includes(h.workspaceRoot), false);
    assert.equal(JSON.stringify(options).includes(await realpath(h.workspaceRoot)), false);
    assert.equal(adapter.requests.length, 0);
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(h.ctx.sessions.list().length, 0);
    const agent = await start(h);
    assert.equal(agent.session.header.cwd, await realpath(h.workspaceRoot));
    assert.equal(await readFile(join(h.workspaceRoot, 'note.txt'), 'utf8'), 'revised');
    assert.equal(adapter.requests.length, 6);
    assert.deepEqual(adapter.requests[0].tools.map((tool) => tool.name).sort(), [
      'edit',
      'read',
      'write',
    ]);
    assert.equal(
      JSON.stringify(adapter.requests.map((request) => request.messages)).includes(sentinel),
      false,
    );
    assert.equal([...h.ctx.storageDomain.get('zhuma_files').table('files').entries()].length, 0);
    assert.equal(h.row().artifactVersions.length, 0);
    assert.equal(h.run().workspace.rootId, h.ctx.workspaceRegistry.list()[0].id);
    assert.equal(h.run().workspace.access, 'write');
  },
);

test(
  'actual Host local workspace: original scopes reject foreign actors, unknown selectors and caller paths before model startup',
  { timeout: 20000 },
  async (t) => {
    const h = await boot(t, { localWorkspace: { access: 'write', policyMode: 'workspace-write' } });
    for (const workspace of [
      { kind: 'local', id: 'foreign' },
      { kind: 'local', id: 'project-files', path: h.root },
      { kind: 'local', id: 'project-files', access: 'write' },
    ])
      assert.equal((await h.rpc('run', 'begin', { ...localBegin(h), workspace })).result.ok, false);
    const outsider = await h.login('outside');
    assert.equal((await h.rpc('run', 'begin', localBegin(h), outsider)).result.ok, false);
    assert.equal(
      (await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }, outsider)).result.ok,
      false,
    );
    assert.equal(h.run(), undefined);
    assert.equal(h.adapter.requests.length, 0);
  },
);

test(
  'actual Host local workspace: read-only and absent publication permission cannot invoke inherited file writers or publishers',
  { timeout: 20000 },
  async (t) => {
    const adapter = new ScriptedAdapter([
      tool('write', { file_path: 'forbidden.txt', content: 'must not write' }),
      tool('publish_output_file', { path: 'forbidden.txt' }),
      'Done',
    ]);
    const h = await boot(t, {
      localWorkspace: { access: 'read', policyMode: 'workspace-write' },
      adapter,
    });
    await start(h);
    assert.deepEqual(
      adapter.requests[0].tools.map((tool) => tool.name),
      ['read'],
    );
    await assert.rejects(stat(join(h.workspaceRoot, 'forbidden.txt')), { code: 'ENOENT' });
    assert.equal(h.run().composition.payload.outputFilePublisherTool, undefined);
    assert.equal(h.row().artifactVersions.length, 0);
  },
);

test(
  'actual Host local workspace: separate explicit publication adopts the generated bytes into the original file store',
  { timeout: 20000 },
  async (t) => {
    const text = 'A generated local result.\n';
    const adapter = new ScriptedAdapter([
      tool('write', { file_path: 'result.txt', content: text }),
      tool('publish_output_file', { path: 'result.txt' }),
      'Published for manual submission',
    ]);
    const h = await boot(t, {
      localWorkspace: {
        access: 'write',
        policyMode: 'workspace-write',
        publish: [{ kind: 'file', path: 'result.txt' }],
      },
      adapter,
    });
    await start(h);
    const files = [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()].map(
      ([, value]) => value,
    );
    assert.equal(files.length, 1);
    const file = files[0];
    assert.equal(file.state, 'completed');
    assert.equal(file.sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(file.byteSize, Buffer.byteLength(text));
    assert.equal(file.uploadedBy, 'chen');
    assert.equal(file.producer.source.scope.runId, h.begin.newRunId);
    const chunks = [];
    for await (const chunk of h.ctx.attachments.readFileStream({
      attachmentId: file.attachmentId,
      name: file.name,
      bytes: file.byteSize,
    }))
      chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), text);
    assert.equal(h.row().artifactVersions.length, 0); // Publication is not artifact submission or approval.
  },
);

test(
  'actual Host local workspace: real registry unmount revokes the original Run and retains cleanup until native drain',
  { timeout: 20000 },
  async (t) => {
    const h = await boot(t, {
      localWorkspace: { access: 'write', policyMode: 'workspace-write' },
      adapter: new ScriptedAdapter(['Ready']),
    });
    await start(h);
    assert.equal(h.run().resources, 'held');
    await h.workspaceFiber.dispose();
    await waitFor(h.ctx, () => h.run()?.resources === 'settled');
    assert.ok(['failed', 'cancelled'].includes(h.run().attempt.status));
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(h.adapter.requests.length, 1);
  },
);
