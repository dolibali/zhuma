/** Actual emitted Host, SDK owner + member Cookies and original directory/file
 * services. Scripted local model output is a contract, not paid model or GUI proof. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { boot, checked, waitFor } from './zhuma-host-run-native.spec.ts';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';

const location = { spaceId: 'north', projectId: 'project' };
const command = (h, patch = {}) => ({
  ...location,
  requestId: randomUUID(),
  workspaceId: h.ctx.workspaceRegistry.list()[0].id,
  expectedGeneration: 0,
  access: 'write',
  publish: [],
  ...patch,
});
function tool(name, args) {
  return function* () {
    const text = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: name, name, argumentsDelta: text };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: name, name, arguments: text },
    };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}
test(
  'actual Host workspace approvals: explicit original owner/member permission enables real file tools/publisher; revocation drains the Run without static fallback',
  { timeout: 30000 },
  async (t) => {
    const text = 'File created through explicit dynamic permission.\n';
    const adapter = new ScriptedAdapter([
      tool('write', { file_path: 'result.txt', content: text }),
      tool('publish_output_file', { path: 'result.txt' }),
      'Published',
    ]);
    const h = await boot(t, {
      localWorkspace: { configured: false, policyMode: 'workspace-write' },
      adapter,
    });
    const before = await readFile(join(h.root, 'domains/zhuma_execution.json'));
    const empty = checked(await h.rpc('workspaces', 'options', location));
    assert.equal(empty.available, true);
    assert.equal(empty.directories.length, 1);
    assert.deepEqual(empty.approvals, []);
    assert.deepEqual(await readFile(join(h.root, 'domains/zhuma_execution.json')), before);
    assert.equal(adapter.requests.length, 0);
    assert.equal(h.ctx.agents.list().length, 0);
    assert.deepEqual(
      checked(await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' })).workspaces,
      [],
    );
    const input = command(h, { publish: [{ kind: 'file', path: 'result.txt' }] });
    const first = checked(await h.rpc('workspaces', 'approve', input));
    const options = checked(await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }));
    assert.deepEqual(options.workspaceApprovalScope, location);
    assert.deepEqual(options.workspaces, [
      { id: first.current.id, label: 'Local contract project', access: 'write', publish: true },
    ]);
    assert.equal(JSON.stringify(options).includes(h.workspaceRoot), false);
    checked(
      await h.rpc('run', 'begin', {
        ...h.begin,
        tools: 'local-tools',
        workspace: { kind: 'local', id: first.current.id },
      }),
    );
    await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
    const agent = h.ctx.agents.get(h.run().attempt.sessionId);
    assert.ok(agent);
    await agent.whenIdle();
    assert.equal(agent.session.header.cwd, await realpath(h.workspaceRoot));
    assert.equal(await readFile(join(h.workspaceRoot, 'result.txt'), 'utf8'), text);
    const files = [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()].map(
      ([, value]) => value,
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].state, 'completed');
    assert.equal(h.row().artifactVersions.length, 0, 'file publication is not artifact submission');
    const held = await h.rpc(
      'workspaces',
      'approve',
      command(h, { expectedGeneration: 1, access: 'read' }),
    );
    assert.equal(held.result.ok, false, 'changing a held root requires genuine Stop/drain');
    const revoked = checked(
      await h.rpc('workspaces', 'revoke', {
        ...location,
        requestId: randomUUID(),
        approvalId: first.current.id,
        expectedGeneration: 1,
      }),
    );
    assert.equal(revoked.current.status, 'revoked');
    await waitFor(h.ctx, () => h.run()?.resources === 'settled');
    assert.equal(h.ctx.agents.list().length, 0);
    const replay = checked(await h.rpc('workspaces', 'approve', input));
    assert.equal(replay.disposition, 'replayed');
    assert.equal(replay.current.status, 'revoked');
    assert.deepEqual(
      checked(await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' })).workspaces,
      [],
    );
    assert.equal(adapter.requests.length, 3);
  },
);
test(
  'actual Host workspace approvals: cold metadata preserves bytes; missing/foreign owner origin and owner-only identity never grant a directory',
  { timeout: 30000 },
  async (t) => {
    const h = await boot(t, { localWorkspace: { configured: false, policyMode: 'read-only' } });
    const refused = await h.rpc('workspaces', 'approve', command(h));
    assert.equal(refused.result.ok, false);
    const first = checked(await h.rpc('workspaces', 'approve', command(h, { access: 'read' })));
    const before = await readFile(join(h.root, 'domains/zhuma_execution.json'));
    await h.remountHost();
    const rows = checked(await h.rpc('workspaces', 'options', location));
    assert.equal(rows.approvals[0].id, first.current.id);
    assert.equal(rows.approvals[0].access, 'read');
    assert.deepEqual(await readFile(join(h.root, 'domains/zhuma_execution.json')), before);
    for (const [cookie, origin, status] of [
      [h.cookie, undefined, 403],
      [h.cookie, 'https://outside.example', 403],
      [h.owner, h.base, 401],
    ]) {
      const response = await fetch(h.base + '/api/zhuma-workspaces/approve', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'refused',
          method: 'zhuma-workspaces/approve',
          payload: command(h),
        }),
      });
      assert.equal(response.status, status);
    }
    assert.deepEqual(await readFile(join(h.root, 'domains/zhuma_execution.json')), before);
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(h.ctx.sessions.list().length, 0);
  },
);
