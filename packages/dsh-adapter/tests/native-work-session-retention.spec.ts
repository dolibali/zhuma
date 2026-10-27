/** Copied into the full-patch native tree; bundle is generated from this package's real adapter. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { boot, grant, message, ScriptedAdapter } from './zhuma-native-work-bundle.ts';

const processMode = process.env.ZHUMA_NATIVE_WORK_RETENTION_MODE;

if (processMode !== undefined) {
  it('C adapter retains the exact native message across independent write/read processes', async () => {
    const root = process.env.ZHUMA_NATIVE_WORK_RETENTION_ROOT;
    if (!root || !['write', 'read'].includes(processMode))
      throw Error('Explicit test root/mode required');
    const host = await boot(root, new ScriptedAdapter([]));
    const current = grant();
    try {
      assert.equal(host.ctx.agents.lifecycleCapabilities.retainPendingInboxOnDispose, true);
      if (processMode === 'write') {
        const receipt = await host.service.send(
          current,
          message('pending', 'persist this exact pending item', 'queue'),
        );
        assert.equal((await host.service.stop(current)).status, 'stopped');
        const binding = host.service.open(current).binding;
        assert.deepEqual(
          host.service.queue(current).items.map((item) => item.id),
          [receipt.messageId],
        );
        await writeFile(
          join(root, 'c-expected.json'),
          JSON.stringify({
            messageId: receipt.messageId,
            nativeSessionId: binding.nativeSessionId,
          }),
        );
      } else {
        const expected = JSON.parse(await readFile(join(root, 'c-expected.json'), 'utf8'));
        const opened = host.service.open(current);
        assert.equal(opened.status, 'detached');
        assert.equal(opened.binding.nativeSessionId, expected.nativeSessionId);
        const history = await host.service.history(current);
        assert.ok(
          history.events.some(
            (event) =>
              event.type === 'agent/inbox/spliced' &&
              event.data.inserted.some((item) => item.id === expected.messageId),
          ),
        );
        assert.equal(
          history.events.some(
            (event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled',
          ),
          false,
        );
        assert.equal(host.ctx.agents.list().length, 0, 'cold open/history must not resume');
        await host.runtime.connect(opened.binding, current, false);
        assert.deepEqual(
          host.service.queue(current).items.map((item) => item.id),
          [expected.messageId],
        );
        assert.equal(host.service.open(current).status, 'idle');
      }
      assert.equal(host.adapter.requests.length, 0);
    } finally {
      await host.close();
    }
  });
} else {
  it('C adapter preserves a stopped queue on normal close, resumes without wake, and honors explicit remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhuma-c-retention-'));
    const current = grant();
    let host, reopened, third;
    try {
      host = await boot(root, new ScriptedAdapter([]));
      const receipt = await host.service.send(
        current,
        message('queued', 'pending product work', 'queue'),
      );
      assert.equal((await host.service.stop(current)).status, 'stopped');
      const binding = host.service.open(current).binding;
      await host.close();
      reopened = await boot(root, new ScriptedAdapter([]));
      assert.equal(reopened.service.open(current).status, 'detached');
      assert.equal(reopened.service.open(current).binding.nativeSessionId, binding.nativeSessionId);
      await reopened.runtime.connect(reopened.service.open(current).binding, current, false);
      assert.deepEqual(
        reopened.service.queue(current).items.map((item) => item.id),
        [receipt.messageId],
      );
      assert.equal(reopened.service.open(current).status, 'idle');
      await reopened.service.updateQueue(current, { kind: 'remove', messageId: receipt.messageId });
      await reopened.close();
      third = await boot(root, new ScriptedAdapter([]));
      await third.runtime.connect(third.service.open(current).binding, current, false);
      assert.deepEqual(third.service.queue(current).items, []);
      assert.equal(
        host.adapter.requests.length +
          reopened.adapter.requests.length +
          third.adapter.requests.length,
        0,
      );
    } finally {
      await third?.close();
      await reopened?.close();
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('C adapter still uses one retained native session for explicit multi-turn work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhuma-c-turns-'));
    const current = grant();
    let host;
    try {
      host = await boot(root, new ScriptedAdapter(['first response', 'second response']));
      await host.service.send(current, message('one', 'first request'));
      const first = host.service.open(current).binding;
      await host.ctx.agents.get(first.nativeSessionId).whenIdle();
      await host.service.send(current, message('two', 'second request'));
      await host.ctx.agents.get(first.nativeSessionId).whenIdle();
      assert.equal(host.service.open(current).binding.nativeSessionId, first.nativeSessionId);
      assert.equal(host.ctx.agents.list().length, 1);
      assert.equal(host.adapter.requests.length, 2);
    } finally {
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('C adapter rejects a new generation before a preserved old queue can be resumed or driven', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhuma-c-generation-'));
    const current = grant();
    let host, reopened;
    try {
      host = await boot(root, new ScriptedAdapter([]));
      await host.service.send(current, message('old', 'old generation pending work', 'queue'));
      await host.close();
      reopened = await boot(root, new ScriptedAdapter([]));
      const next = grant({ generation: current.scope.generation + 1 });
      assert.throws(() => reopened.service.open(next), { code: 'scope-mismatch' });
      await assert.rejects(reopened.service.send(next, message('new', 'do not rebind old work')), {
        code: 'scope-mismatch',
      });
      assert.equal(reopened.ctx.agents.list().length, 0);
      assert.equal(reopened.adapter.requests.length, 0);
    } finally {
      await reopened?.close();
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
