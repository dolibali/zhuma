/** Fixed patched SDK, real directory/JSONL services; Host root authority remains a contract.
 * No model resolution, model requests, shell, file tools or external tools may execute.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  boot,
  grant,
  message,
  ScriptedAdapter,
  acceptedFixture,
  acceptedInputRef,
  registerNativeAcceptedInputTool,
} from './zhuma-native-work-bundle.ts';

class NoModel extends ScriptedAdapter {
  resolutions = 0;
  override resolveModel() {
    this.resolutions++;
    throw Error('must not resolve a model');
  }
  override async *stream() {
    throw Error('must not call a model');
    yield {};
  }
}
async function home(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-native-directory-')));
  await mkdir(join(root, 'project-a'));
  await mkdir(join(root, 'project-b'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function hostAt(t, root, options = {}, compose) {
  const adapter = new NoModel();
  const host = await boot(root, adapter, compose, options);
  t.onTestFinished(async () => {
    await host.close();
    assert.equal(adapter.resolutions, 0);
    assert.equal(adapter.requests.length, 0);
  });
  return host;
}
async function directory(host, root) {
  await host.ctx.plugin(LocalFileSystem, { cwd: root });
  await host.ctx.plugin(WorkingDirectory, { defaultDirectory: root });
}
function local(current, cwd) {
  const controller = new AbortController();
  return {
    kind: 'local',
    scope: structuredClone(current.scope),
    cwd,
    signal: controller.signal,
    assertCurrent() {
      assert.equal(controller.signal.aborted, false);
    },
    revoke: () => controller.abort(),
  };
}
const zero = () => ({ context: 'Contract task, no executable tools.', toolAllowlist: [] });
const tool = (name) => ({
  name,
  description: 'Sentinel which must never execute.',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'null' }, render: () => [] },
  execute: async () => assert.fail('sentinel tool executed'),
});
const agentOf = (host, current) =>
  host.ctx.agents.get(host.service.open(current).binding.nativeSessionId);

test('real SDK: local root becomes immutable create cwd and inherited tools are masked in native presentation', async (t) => {
  const root = await home(t),
    current = grant(),
    cap = local(current, join(root, 'project-a'));
  const host = await hostAt(t, root, { workingDirectory: () => cap }, zero);
  await directory(host, root);
  for (const name of ['sentinel_fs', 'sentinel_exec', 'sentinel_external'])
    host.ctx.tools.register(tool(name));
  await host.service.send(current, message('park', 'Do not wake', 'queue'));
  const agent = agentOf(host, current);
  assert.equal(agent.session.header.cwd, cap.cwd);
  assert.equal(host.ctx.workingDirectory.get(agent.session), cap.cwd);
  assert.equal(await host.ctx.workingDirectory.ensure(agent), cap.cwd);
  assert.deepEqual(host.ctx.tools.schemas(agent), []);
  assert.equal(host.ctx.tools.get('run_code', agent.ctx), undefined);
  const assembly = await host.ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.deepEqual(assembly.tools, []);
  assert.equal(agent.status, 'idle');
});

test('real SDK: missing callback/service, relative path, scope mismatch and async permission fail before publication', async (t) => {
  for (const kind of ['callback', 'service', 'relative', 'scope', 'async']) {
    const root = await home(t),
      current = grant(),
      cap = local(current, join(root, 'project-a'));
    if (kind === 'relative') cap.cwd = 'relative-root';
    if (kind === 'scope') cap.scope.generation++;
    if (kind === 'async') cap.assertCurrent = async () => {};
    const host = await hostAt(
      t,
      root,
      { workingDirectory: kind === 'callback' ? undefined : () => cap },
      zero,
    );
    if (kind !== 'service') await directory(host, root);
    await assert.rejects(host.service.send(current, message('refuse', 'Do not publish', 'queue')));
    assert.equal(host.ctx.agents.list().length, 0);
    const binding = host.service.open(current).binding;
    assert.equal(
      await host.ctx.sessionPersistence.stat(SessionId(binding.nativeSessionId)),
      undefined,
    );
  }
});

test('real SDK: permission revocation during unpublished compose rolls back without late publication', async (t) => {
  const root = await home(t),
    current = grant(),
    cap = local(current, join(root, 'project-a'));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const host = await hostAt(t, root, { workingDirectory: () => cap }, async () => {
    entered.resolve();
    await release.promise;
    return zero();
  });
  await directory(host, root);
  const sending = host.service.send(current, message('revoke', 'Do not wake', 'queue'));
  const rejected = assert.rejects(sending);
  await entered.promise;
  cap.revoke();
  release.resolve();
  await rejected;
  assert.equal(host.ctx.agents.list().length, 0);
});

test('real SDK: revocation during an actual working-directory filesystem await rolls back setup', async (t) => {
  const root = await home(t),
    current = grant(),
    cap = local(current, join(root, 'project-a'));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const host = await hostAt(t, root, { workingDirectory: () => cap }, zero);
  await directory(host, root);
  const stat = host.ctx.fs.stat.bind(host.ctx.fs);
  host.ctx.fs.stat = async (...args) => {
    entered.resolve();
    await release.promise;
    return stat(...args);
  };
  const sending = host.service.send(current, message('held-directory', 'Do not wake', 'queue'));
  const rejected = assert.rejects(sending);
  await entered.promise;
  cap.revoke();
  release.resolve();
  await rejected;
  assert.equal(host.ctx.agents.list().length, 0);
});

test('real SDK: resume refuses another selected root and preserves the original session directory', async (t) => {
  const root = await home(t),
    current = grant(),
    first = local(current, join(root, 'project-a'));
  const original = await hostAt(t, root, { workingDirectory: () => first }, zero);
  await directory(original, root);
  await original.service.send(current, message('park', 'Do not wake', 'queue'));
  const id = original.service.open(current).binding.nativeSessionId;
  await original.close();
  const second = local(current, join(root, 'project-b'));
  const reopened = await hostAt(t, root, { workingDirectory: () => second }, zero);
  await directory(reopened, root);
  await assert.rejects(
    reopened.service.send(current, message('wrong-root', 'Do not wake', 'queue')),
    { code: 'configuration-mismatch' },
  );
  assert.equal(reopened.ctx.agents.list().length, 0);
  const reader = await reopened.ctx.sessionPersistence.open(SessionId(id), 'read');
  try {
    assert.equal(reader.header.cwd, first.cwd);
  } finally {
    await reader.close();
  }
});

test('real SDK: changed effective cwd and a revoked local capability cannot drive a parked agent', async (t) => {
  const root = await home(t),
    current = grant(),
    cap = local(current, join(root, 'project-a'));
  const host = await hostAt(t, root, { workingDirectory: () => cap }, zero);
  await directory(host, root);
  await host.service.send(current, message('park', 'Do not wake', 'queue'));
  const agent = agentOf(host, current);
  agent.session.append('working-directory/change', { cwd: join(root, 'project-b') });
  await assert.rejects(host.service.send(current, message('changed', 'Do not wake', 'queue')), {
    code: 'configuration-mismatch',
  });
  agent.session.append('working-directory/change', { cwd: cap.cwd });
  cap.revoke();
  await assert.rejects(host.service.send(current, message('revoked', 'Do not wake', 'queue')), {
    code: 'unavailable',
  });
});

test('real SDK: same-scope unlisted tools and conflicting PTC declaration fail before publication', async (t) => {
  for (const mode of ['tool', 'ptc']) {
    const root = await home(t);
    const host = await hostAt(t, root, {}, (ctx) => {
      if (mode === 'tool') ctx.tools.register(tool('unlisted_local'));
      else ctx.tools.presentAs('ptc');
      return zero();
    });
    await assert.rejects(host.service.send(grant(), message('refuse', 'Do not wake', 'queue')));
    assert.equal(host.ctx.agents.list().length, 0);
  }
});

test('real SDK: cleanup closes the exact native writer after the underlying input reservation drains', async (t) => {
  const root = await home(t),
    current = grant(),
    host = await hostAt(t, root, {}, zero);
  await host.service.send(current, message('park', 'Do not wake', 'queue'));
  const binding = host.service.open(current).binding;
  const reservation = await host.service.reserveInputRead(current);
  const controller = new AbortController(),
    authority = { scope: current.scope, assertCurrent() {} };
  const retiring = host.service.retireForCleanup(authority, controller.signal);
  controller.abort();
  assert.deepEqual(await retiring, { status: 'pending' });
  let idle = false;
  const idlePromise = host.service.whenRetirementsIdle().then(() => {
    idle = true;
  });
  await new Promise(setImmediate);
  assert.equal(idle, false);
  await host.service.finishInputRead(current, reservation);
  await idlePromise;
  const result = await host.service.retireForCleanup(authority, new AbortController().signal);
  assert.equal(result.status, 'retired');
  assert.equal(result.binding.nativeSessionId, binding.nativeSessionId);
  assert.equal(result.drain.basis, 'flushed-and-closed');
  result.drain.assertCurrent();
  assert.equal(host.ctx.agents.list().length, 0);
  // A successful write-open proves no native writer lock is still held.
  const writer = await host.ctx.sessionPersistence.open(
    SessionId(binding.nativeSessionId),
    'write',
  );
  await writer.close();
  assert.equal(host.service.open(current).binding.receipts.length, binding.receipts.length);
});

test('real SDK: revoked-member cleanup retains an actual held accepted-input source until it settles', async (t) => {
  const root = await home(t),
    input = await acceptedFixture(),
    current = grant(input.scope);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let host,
    reads = 0;
  const ports = {
    catalog: input.catalog,
    resolveCurrentCaller: async () => input.caller,
    reader: {
      upstreamContent: async (...args) => {
        reads++;
        const result = await input.service.upstreamContent(...args);
        entered.resolve();
        await release.promise;
        return result;
      },
    },
  };
  host = await hostAt(t, root, {}, (ctx, binding, received) =>
    registerNativeAcceptedInputTool(ctx, binding, received, host.service, ports),
  );
  t.onTestFinished(() => release.resolve());
  await host.service.send(current, message('park', 'Do not wake', 'queue'));
  const binding = host.service.open(current).binding;
  const calling = host.ctx.tools.execute({
    callId: 'explicit-no-model-read',
    name: 'read_accepted_input',
    arguments: {
      inputRef: acceptedInputRef(current.scope, input.catalog.inputs[0].input),
      part: 'text',
      limit: 1,
    },
    agent: agentOf(host, current),
    signal: new AbortController().signal,
  });
  await entered.promise;
  current.revoke();
  const controller = new AbortController(),
    authority = { scope: current.scope, assertCurrent() {} };
  const retiring = host.service.retireForCleanup(authority, controller.signal);
  controller.abort();
  assert.deepEqual(await retiring, { status: 'pending' });
  let idle = false;
  const idlePromise = host.service.whenRetirementsIdle().then(() => {
    idle = true;
  });
  await new Promise(setImmediate);
  assert.equal(idle, false);
  assert.equal(reads, 1);
  release.resolve();
  const result = await calling;
  await idlePromise;
  assert.equal(JSON.stringify(result).includes('😀汉'), false);
  const retired = await host.service.retireForCleanup(authority, new AbortController().signal);
  assert.equal(retired.binding.nativeSessionId, binding.nativeSessionId);
  retired.drain.assertCurrent();
  assert.equal(host.ctx.agents.list().length, 0);
});
