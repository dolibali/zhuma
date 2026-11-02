/** Windows-only pinned SDK/JSONL/working-directory contracts. Model output and
 * Run grants are scripted; no real model, profile, shell or external tool runs.
 * Copied beside zhuma-native-work-bundle.ts in an isolated patched SDK tree.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace';
import { boot, grant, message, ScriptedAdapter } from './zhuma-native-work-bundle.ts';

async function at(root, adapter, expectedWorkspaceId?) {
  const cwd = await realpath(join(root, '项目 A & B'));
  const current = grant();
  const cap = {
    kind: 'local',
    scope: structuredClone(current.scope),
    cwd,
    workspaceId: expectedWorkspaceId,
    signal: current.signal,
    assertCurrent: () => current.assertCurrent(),
  };
  const host = await boot(root, adapter, undefined, { workingDirectory: () => cap });
  try {
    await host.ctx.plugin(LocalFileSystem, { cwd: root });
    await host.ctx.plugin(WorkingDirectory, { defaultDirectory: root });
    await host.ctx.plugin(WorkspaceRegistry);
    const workspace = await host.ctx.workspaceRegistry.create(cwd, 'Windows 路径契约');
    if (expectedWorkspaceId) assert.equal(workspace.id, expectedWorkspaceId);
    cap.workspaceId = workspace.id;
    assert.equal(workspace.path, cwd);
    assert.match(cwd, /^[A-Za-z]:\\/u);
    return { ...host, current, cwd, workspace };
  } catch (error) {
    await host.close();
    throw error;
  }
}

async function home() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhuma Windows 原生 ')));
  await mkdir(join(root, '项目 A & B'));
  return root;
}

test.skipIf(process.platform !== 'win32')(
  'Windows drive/Unicode/spaces: original workspace, stream, durable same-session cold open',
  { timeout: 20_000 },
  async () => {
    const root = await home();
    let host, reopened;
    try {
      host = await at(root, new ScriptedAdapter(['原生流式回复']));
      const streams = [];
      host.ctx.on('agent/assistant-stream', ({ frame }) => streams.push(frame), { global: true });
      await host.service.send(host.current, message('windows-first', '只运行模拟模型'));
      const binding = host.service.open(host.current).binding;
      const agent = host.ctx.agents.get(binding.nativeSessionId);
      await agent.whenIdle();
      assert.equal(agent.session.header.cwd, host.cwd);
      assert.equal(host.ctx.workingDirectory.get(agent.session), host.cwd);
      assert.deepEqual(host.workspace.sessionIds, [binding.nativeSessionId]);
      assert.ok(
        streams.some((frame) => frame.type === 'chunk' && frame.chunk.type === 'text-delta'),
      );
      assert.equal(host.adapter.requests.length, 1);
      const workspaceId = host.workspace.id;
      await host.close();
      host = undefined;

      reopened = await at(root, new ScriptedAdapter(['明确继续后的回复']), workspaceId);
      const opened = reopened.service.open(reopened.current);
      assert.equal(opened.status, 'detached');
      assert.equal(opened.binding.nativeSessionId, binding.nativeSessionId);
      assert.equal(reopened.ctx.agents.list().length, 0);
      const history = await reopened.service.history(reopened.current);
      assert.ok(history.events.some((event) => event.type === 'assistant/message'));
      assert.deepEqual(reopened.workspace.sessionIds, [binding.nativeSessionId]);
      assert.equal(
        reopened.adapter.requests.length,
        0,
        'reading/reopening must never wake a model',
      );
      await reopened.service.send(reopened.current, message('windows-next', '明确继续'));
      await reopened.ctx.agents.get(binding.nativeSessionId).whenIdle();
      assert.equal(
        reopened.service.open(reopened.current).binding.nativeSessionId,
        binding.nativeSessionId,
      );
      assert.deepEqual(reopened.workspace.sessionIds, [binding.nativeSessionId]);
      assert.equal(reopened.adapter.requests.length, 1);
    } finally {
      await reopened?.close();
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows stop waits for original generator drain and then closes the durable writer',
  { timeout: 20_000 },
  async () => {
    const root = await home();
    const entered = Promise.withResolvers(),
      aborted = Promise.withResolvers(),
      release = Promise.withResolvers();
    let host;
    try {
      host = await at(
        root,
        new ScriptedAdapter([
          async function* (options) {
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: '未完成' };
            options.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
            entered.resolve();
            await release.promise;
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        ]),
      );
      await host.service.send(host.current, message('windows-held', '等待真实排空'));
      await entered.promise;
      const binding = host.service.open(host.current).binding;
      const queued = await host.service.send(
        host.current,
        message('windows-queued', '保留待处理输入', 'queue'),
      );
      let stopped = false;
      const stopping = host.service.stop(host.current).then((result) => {
        stopped = true;
        return result;
      });
      await aborted.promise;
      await setImmediate();
      assert.equal(stopped, false, 'abort delivery alone is not physical drain');
      release.resolve();
      assert.equal((await stopping).status, 'stopped');
      assert.equal(host.ctx.agents.get(binding.nativeSessionId).status, 'idle');
      assert.ok(
        host.service.queue(host.current).items.some((item) => item.id === queued.messageId),
      );
      const drained = await host.runtime.retire(
        binding.nativeSessionId,
        new AbortController().signal,
      );
      assert.equal(drained.basis, 'flushed-and-closed');
      drained.assertCurrent();
      assert.equal(host.ctx.agents.get(binding.nativeSessionId), undefined);
    } finally {
      release.resolve();
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

const phase = process.env.ZHUMA_NATIVE_WINDOWS_PHASE;
if (phase !== undefined) {
  test.skipIf(process.platform !== 'win32')(
    'Windows independent processes preserve the original workspace/session/inbox',
    async () => {
      const root = process.env.ZHUMA_NATIVE_WINDOWS_ROOT;
      if (!root || !['write', 'read'].includes(phase))
        throw Error('Explicit isolated root/phase required');
      if (phase === 'write') await mkdir(join(root, '项目 A & B'), { recursive: true });
      const expectedPath = join(root, 'windows-expected.json');
      const expected =
        phase === 'read' ? JSON.parse(await readFile(expectedPath, 'utf8')) : undefined;
      const host = await at(root, new ScriptedAdapter([]), expected?.workspaceId);
      try {
        if (phase === 'write') {
          const receipt = await host.service.send(
            host.current,
            message('windows-pending', '跨进程保留', 'queue'),
          );
          assert.equal((await host.service.stop(host.current)).status, 'stopped');
          await writeFile(
            expectedPath,
            JSON.stringify({
              workspaceId: host.workspace.id,
              nativeSessionId: host.service.open(host.current).binding.nativeSessionId,
              messageId: receipt.messageId,
            }),
          );
        } else {
          const opened = host.service.open(host.current);
          assert.equal(opened.status, 'detached');
          assert.equal(opened.binding.nativeSessionId, expected.nativeSessionId);
          assert.deepEqual(host.workspace.sessionIds, [expected.nativeSessionId]);
          await host.service.history(host.current);
          assert.equal(host.ctx.agents.list().length, 0);
          await host.runtime.connect(opened.binding, host.current, false);
          assert.deepEqual(
            host.service.queue(host.current).items.map((item) => item.id),
            [expected.messageId],
          );
          assert.equal(host.service.open(host.current).status, 'idle');
        }
        assert.equal(host.adapter.requests.length, 0);
      } finally {
        await host.close();
      }
    },
  );
}
