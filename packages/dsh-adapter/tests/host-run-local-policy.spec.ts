/** Actual emitted Host/factory, real SDK sandbox policy and local I/O.
 * Source-SDK alias graph and local scripted model only; no GUI/provider proof.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { boot, checked, waitFor } from './zhuma-host-run-native.spec.ts';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';

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
async function started(h) {
  const receipt = checked(
    await h.rpc('run', 'begin', {
      ...h.begin,
      tools: 'local-tools',
      workspace: { kind: 'local', id: 'project-files' },
    }),
  );
  assert.equal(receipt.dispatch, 'received');
  await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
  const view = checked(await h.rpc('run', 'read', { ...h.locator, runId: h.begin.newRunId }));
  const agent = h.ctx.agents.get(view.native.sessionId);
  assert.ok(agent);
  return agent;
}

test(
  'actual Host local policy: original default read-only keeps an operator write grant read-only with no file writer',
  { timeout: 20000 },
  async (t) => {
    const adapter = new ScriptedAdapter([
      tool('write', { file_path: 'forbidden.txt', content: 'must not write' }),
      tool('read', { file_path: 'input.txt' }),
      'Done',
    ]);
    // No SDK mode is provided: its real schema default applies.
    const h = await boot(t, { localWorkspace: { access: 'write', sandboxed: true }, adapter });
    await writeFile(join(h.workspaceRoot, 'input.txt'), 'Owned read input');
    assert.equal(h.ctx.fs.sandboxMode, 'read-only');
    assert.equal(h.ctx.sandboxPolicy.resolve().mode, 'read-only');
    const options = checked(await h.rpc('run', 'options', { ...h.locator, spaceId: 'north' }));
    assert.equal(options.workspaces[0].access, 'read');
    assert.equal(adapter.requests.length, 0);
    const agent = await started(h);
    await agent.whenIdle();
    assert.equal(h.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
    assert.equal(h.run().workspace.access, 'read');
    assert.deepEqual(
      adapter.requests[0].tools.map((entry) => entry.name),
      ['read'],
    );
    assert.equal(adapter.requests.length, 3);
    await assert.rejects(stat(join(h.workspaceRoot, 'forbidden.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(h.workspaceRoot, 'input.txt'), 'utf8'), 'Owned read input');
  },
);

test(
  'actual Host local policy: explicit SDK workspace-write permits only the frozen Host tools and independent publication',
  { timeout: 20000 },
  async (t) => {
    const adapter = new ScriptedAdapter([
      tool('write', { file_path: 'result.txt', content: 'first' }),
      tool('read', { file_path: 'result.txt' }),
      tool('edit', { file_path: 'result.txt', old_string: 'first', new_string: 'revised' }),
      tool('publish_output_file', { path: 'result.txt' }),
      'Done',
    ]);
    const h = await boot(t, {
      localWorkspace: {
        access: 'write',
        sandboxed: true,
        policyMode: 'workspace-write',
        publish: [{ kind: 'file', path: 'result.txt' }],
      },
      adapter,
    });
    assert.equal(h.ctx.fs.sandboxMode, 'workspace-write');
    const agent = await started(h);
    await agent.whenIdle();
    const policy = h.ctx.sandboxPolicy.resolve({ session: agent.session });
    assert.equal(policy.mode, 'workspace-write');
    assert.equal(policy.workspaceRoot, agent.session.header.cwd);
    assert.equal(await readFile(join(h.workspaceRoot, 'result.txt'), 'utf8'), 'revised');
    assert.deepEqual(adapter.requests[0].tools.map((entry) => entry.name).sort(), [
      'edit',
      'publish_output_file',
      'read',
      'write',
    ]);
    const files = [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()].map(
      ([, value]) => value,
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].state, 'completed');
    assert.equal(files[0].producer.source.scope.runId, h.begin.newRunId);
    assert.equal(h.row().artifactVersions.length, 0);
    assert.equal(h.ctx.fs.sandboxMode, 'workspace-write');
  },
);

test(
  'actual Host local policy: a real same-session read-only event revokes write authority and retains cleanup until the held native stream drains',
  { timeout: 20000 },
  async (t) => {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    let drained = false;
    let modelSignal;
    const adapter = new ScriptedAdapter([
      async function* (options) {
        modelSignal = options.signal;
        try {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: 'Waiting' };
          entered.resolve();
          await released.promise;
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Waiting' } };
          yield* tool('write', { file_path: 'after-revocation.txt', content: 'must not write' })();
        } finally {
          drained = true;
        }
      },
    ]);
    const h = await boot(t, {
      localWorkspace: { access: 'write', sandboxed: true, policyMode: 'workspace-write' },
      adapter,
    });
    let modeEvents = 0;
    h.ctx.on(
      'session/event',
      (_session, event) => {
        if (event.type === 'sandbox/mode') modeEvents++;
      },
      { global: true },
    );
    try {
      const agent = await started(h);
      await entered.promise;
      agent.session.append('sandbox/mode', { mode: 'read-only' });
      assert.equal(h.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
      try {
        // Revocation precedes the durable cleanup row: the native stream is
        // intentionally still held, so a domain/changed wait cannot observe it.
        if (!modelSignal.aborted)
          await once(modelSignal, 'abort', { signal: AbortSignal.timeout(5000) });
      } catch (cause) {
        throw new Error(
          `policy revocation wait: ${JSON.stringify({ modeEvents, mode: h.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, modelAborted: modelSignal?.aborted, status: h.run().attempt.status, stopPhase: h.run().attempt.stopPhase, resources: h.run().resources, sessionInStore: !!h.ctx.sessions.get(agent.session.id), drained })}`,
          { cause },
        );
      }
      assert.equal(drained, false);
      assert.equal(h.run().resources, 'held');
      released.resolve();
      try {
        await waitFor(h.ctx, () => h.run().resources === 'settled');
      } catch (cause) {
        throw new Error(
          `policy drain wait: ${JSON.stringify({ modeEvents, status: h.run().attempt.status, stopPhase: h.run().attempt.stopPhase, resources: h.run().resources, drained })}`,
          { cause },
        );
      }
      assert.equal(drained, true);
      await assert.rejects(stat(join(h.workspaceRoot, 'after-revocation.txt')), { code: 'ENOENT' });
      assert.equal(adapter.requests.length, 1);
      assert.equal(h.ctx.agents.list().length, 0);
    } finally {
      released.resolve();
    }
  },
);
