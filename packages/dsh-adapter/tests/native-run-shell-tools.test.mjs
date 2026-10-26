/** Real official foreground Bash, Cordis services, local processes and file bytes.
 * Member/Run/workspace issuers and the session-bearing caller are contracts.
 * No real member login, native Agent/model, installed desktop or sandbox is certified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, symbols } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import LocalBash from '@deepseek-ai/dsh-bash-local';
import * as ShellEnv from '@deepseek-ai/dsh-shell-env';
import * as ToolBash from '@deepseek-ai/dsh-tool-bash';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import { createScope } from '@deepseek-ai/dsh-scope';
import {
  NativeRunLocalToolProducer,
  NATIVE_RUN_LOCAL_TOOL_CONFIG,
  NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
  adoptNativeRunLocalTools,
} from '../dist/native-run-local-tools.js';
import {
  NativeRunShellProducer,
  NATIVE_RUN_SHELL_SOURCE_VERSION,
  NATIVE_RUN_SHELL_CONFIG,
  NATIVE_RUN_SHELL_LIMITS,
  adoptNativeRunShellTool,
} from '../dist/native-run-shell-tools.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';

class ObservedSubprocess extends LocalSubprocess {
  handles = [];
  specs = [];
  spawn(spec) {
    this.specs.push(spec);
    const handle = super.spawn(spec);
    this.handles.push(handle);
    this.afterSpawn?.(handle);
    return handle;
  }
}
async function host(t, { provider = {} } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-shell-')));
  const root = join(home, 'work'),
    sibling = join(home, 'outside');
  await mkdir(root);
  await mkdir(sibling);
  const ctx = new Context(),
    fibers = [];
  for (const [plugin, config] of [
    [Tools, { mode: 'native' }],
    [SystemPrompt],
    [SessionStore],
    [SessionProjections],
    [FileSystem, { cwd: root }],
    [WorkingDirectory, { defaultDirectory: root }],
    [ObservedSubprocess],
    [LocalBash, { cwd: root, ...provider }],
    [ShellEnv, { dshHome: join(home, 'harness') }],
    [ToolFs, NATIVE_RUN_LOCAL_TOOL_CONFIG],
    [ToolBash, NATIVE_RUN_SHELL_CONFIG],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  }
  const source = new AbortController(),
    permission = new AbortController(),
    run = new AbortController();
  const facts = compositionFacts();
  const producer = new NativeRunShellProducer(ctx, {
    sourceVersion: NATIVE_RUN_SHELL_SOURCE_VERSION,
    signal: source.signal,
    assertCurrent() {
      assert(!source.signal.aborted);
    },
  });
  const files = new NativeRunLocalToolProducer(ctx, {
    sourceVersion: NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
    signal: new AbortController().signal,
    assertCurrent() {},
  });
  const composition = freezeExecutionRunComposition({
    ...facts,
    tools: {
      kind: 'local-tools',
      definitions: files.describe(['read', 'write', 'edit']),
      shell: producer.describe(),
    },
  });
  const session = ctx.sessions.create(SessionId('foreground-shell-session'), { cwd: root });
  const agent = { session },
    scope = createScope(ctx, agent);
  await scope.ctx.fiber;
  agent.ctx = scope.ctx;
  const binding = {
    schemaVersion: 1,
    scope: structuredClone(facts.scope),
    nativeSessionId: String(session.id),
    nativeAgentId: 'shell-agent',
    selection: executionRunCompositionRequest(composition).selection,
    receipts: [],
  };
  const grant = {
    scope: structuredClone(facts.scope),
    signal: run.signal,
    assertCurrent(action) {
      assert.equal(action, 'send');
      assert(!run.signal.aborted);
    },
  };
  const deadlineFacts = { memberExpiresAt: Date.now() + 3_600_000 };
  const capability = {
    authority: 'local-host-process',
    scope: structuredClone(facts.scope),
    root,
    signal: permission.signal,
    assertCurrent(action) {
      assert.equal(action, 'execute');
      assert(!permission.signal.aborted);
    },
    deadlines() {
      return { ...deadlineFacts };
    },
  };
  const fileAdoption = await adoptNativeRunLocalTools(scope.ctx, binding, grant, {
    composition,
    producer: files,
    workspace: {
      scope: structuredClone(facts.scope),
      root,
      permissions: { read: true, write: true },
      signal: new AbortController().signal,
      assertCurrent() {},
    },
  });
  let adoption,
    calls = 0;
  let expectedDrainFailure = false;
  const h = {
    ctx,
    scope,
    agent,
    composition,
    binding,
    grant,
    capability,
    deadlineFacts,
    producer,
    source,
    permission,
    run,
    root,
    sibling,
    home,
    runtime: ctx.get('subprocess')[symbols.original],
    originalShell: ctx.get('shell')[symbols.original],
    originalFilesystem: ctx.get('fs')[symbols.original],
    expectDrainFailure() {
      expectedDrainFailure = true;
    },
    async adopt(patch = {}) {
      adoption = await adoptNativeRunShellTool(scope.ctx, binding, grant, {
        composition,
        producer,
        capability,
        ...patch,
      });
      return adoption;
    },
    call(command, patch = {}, execPatch = {}) {
      return ctx.tools.execute({
        callId: `shell-${++calls}`,
        name: 'bash',
        arguments: { description: 'Local test', command, ...patch },
        signal: new AbortController().signal,
        agent,
        ...execPatch,
      });
    },
  };
  t.after(async () => {
    const errors = [];
    for (const release of [
      () => adoption?.dispose(),
      () => fileAdoption.dispose(),
      () => scope.dispose(),
      ...fibers.reverse().map((fiber) => () => fiber.dispose()),
    ]) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    await rm(home, { recursive: true, force: true });
    if (expectedDrainFailure) {
      assert(errors.length > 0);
      for (const error of errors) assert.equal(error.code, 'local-shell-unavailable');
    } else if (errors.length) throw errors[0];
  });
  return h;
}
const okay = (result) => assert.equal(result.isError, false, JSON.stringify(result));
const denied = (result) => assert.equal(result.isError, true, JSON.stringify(result));

test('real foreground shell: actual definitions are copied and file/shell selection survives frozen readback', async (t) => {
  const h = await host(t);
  const first = h.producer.describe();
  first.parameters = {};
  assert.notDeepEqual(h.producer.describe(), first);
  const adopted = await h.adopt();
  assert.deepEqual(adopted.toolAllowlist, ['read', 'write', 'edit', 'bash']);
  assert(!JSON.stringify(h.composition).includes(h.root));
  okay(await h.call('printf actual > made.txt'));
  assert.equal(await readFile(join(h.root, 'made.txt'), 'utf8'), 'actual');
  assert.equal(h.runtime.handles.length, 1);
  assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
});

test('real foreground shell: descriptors use the actual producer scope rather than an unrelated global tool', async (t) => {
  const h = await host(t);
  const key = {},
    prepared = createScope(h.ctx, key);
  await prepared.ctx.fiber;
  const fiber = prepared.ctx.plugin(ToolBash, NATIVE_RUN_SHELL_CONFIG);
  await fiber;
  const scoped = h.ctx.tools.get('bash', key);
  const global = h.ctx.tools.get('bash');
  assert.notEqual(scoped, global);
  const previous = global.description;
  global.description = 'UNRELATED_GLOBAL_DEFINITION';
  try {
    const producer = new NativeRunShellProducer(prepared.ctx, {
      sourceVersion: NATIVE_RUN_SHELL_SOURCE_VERSION,
      signal: h.source.signal,
      assertCurrent() {
        assert(!h.source.signal.aborted);
      },
    });
    assert.equal(producer.describe().description, scoped.description);
    assert.notEqual(producer.describe().description, global.description);
  } finally {
    global.description = previous;
    await fiber.dispose();
    await prepared.dispose();
  }
});

test('real foreground shell: absent or file-only authority, async assertions and changed scope/config are refused before spawn', async (t) => {
  const h = await host(t);
  for (const capability of [
    undefined,
    { ...h.capability, authority: undefined },
    { ...h.capability, assertCurrent: async () => undefined },
    { ...h.capability, scope: { ...h.capability.scope, generation: 2 } },
  ]) {
    await assert.rejects(h.adopt({ capability }));
  }
  const wrong = structuredClone(h.composition);
  wrong.payload.tools.shell.description += 'changed';
  await assert.rejects(h.adopt({ composition: wrong }));
  assert.equal(h.runtime.handles.length, 0);
});

test('real foreground shell: outside/symlink workdirs, background and escalation never spawn', async (t) => {
  const h = await host(t);
  await h.adopt();
  await symlink(
    h.sibling,
    join(h.root, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const patch of [
    { workdir: h.sibling },
    { workdir: '../outside' },
    { workdir: 'escape' },
    { run_in_background: true },
    { sandbox_permissions: 'danger-full-access', justification: 'test' },
  ])
    denied(await h.call('printf forbidden > marker', patch));
  assert.equal(h.runtime.handles.length, 0);
  await assert.rejects(readFile(join(h.sibling, 'marker')));
});

for (const kind of ['source', 'permission', 'run'])
  test(`real foreground shell: ${kind} revocation stops admission and old handlers`, async (t) => {
    const h = await host(t);
    await h.adopt();
    const handler = h.ctx.tools.get('bash', h.agent);
    h[kind].abort();
    denied(await h.call('printf forbidden'));
    await assert.rejects(
      handler.execute(
        { command: 'printf forbidden', description: 'old' },
        { agent: h.agent, signal: new AbortController().signal },
      ),
    );
    assert.equal(h.runtime.handles.length, 0);
  });

test('real foreground shell: existing pre-execution policy still refuses the actual tool', async (t) => {
  const h = await host(t);
  await h.adopt();
  h.ctx.tools.guard(() => 'HOST_POLICY_DENIED');
  denied(await h.call('printf forbidden'));
  assert.equal(h.runtime.handles.length, 0);
});

test(
  'real foreground shell: requested shorter deadline kills an admitted actual child and settles its range',
  { timeout: 5000 },
  async (t) => {
    const h = await host(t);
    const adopted = await h.adopt();
    const arrival = Promise.withResolvers();
    h.runtime.afterSpawn = () => arrival.resolve();
    // Pre-spawn cwd/source checks legitimately consume the requested deadline.
    // Advance it only after a real handle exists, so host load cannot turn this
    // admitted-child cleanup test into a pre-spawn timeout test.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const call = h.call('sleep 30', { timeoutMs: 30 });
    try {
      await Promise.race([
        arrival.promise,
        call.then(() => assert.fail('command ended before real spawn')),
      ]);
      assert.equal(h.runtime.handles.length, 1);
      t.mock.timers.tick(31);
      denied(await call);
      assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
      await adopted.dispose();
    } finally {
      t.mock.timers.reset();
      await call.catch(() => undefined);
    }
  },
);

for (const kind of ['source', 'permission', 'run'])
  test(`real foreground shell: ${kind} revocation kills an admitted real process before disposal resolves`, async (t) => {
    const h = await host(t);
    const adopted = await h.adopt();
    let entered;
    const arrival = new Promise((resolve) => {
      entered = resolve;
    });
    h.runtime.afterSpawn = entered;
    const call = h.call('sleep 30; printf late > late.txt');
    await arrival;
    h[kind].abort();
    await adopted.dispose();
    denied(await call);
    assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
    await assert.rejects(readFile(join(h.root, 'late.txt')));
  });

test('real foreground shell: a shell syntax background child does not survive foreground settlement', async (t) => {
  const h = await host(t);
  await h.adopt();
  okay(await h.call('sleep 30 & printf parent'));
  assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
});

test('real foreground shell: capture is bounded without spill or credential-shaped explicit environment', async (t) => {
  const h = await host(t);
  await h.adopt();
  okay(
    await h.call(
      "node -e \"process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000))\"",
    ),
  );
  const spec = h.runtime.specs[0];
  for (const key of ['stdout', 'stderr']) {
    assert.deepEqual(spec.stdio[key], { maxBytes: NATIVE_RUN_SHELL_LIMITS.outputBytes });
    const out = h.runtime.handles[0].collected[key].readFrom(0);
    assert.equal(out.lossy, true);
    assert(Buffer.byteLength(out.text) <= NATIVE_RUN_SHELL_LIMITS.outputBytes);
    assert.equal(out.spillPath, undefined);
  }
  assert(!Object.keys(spec.env).some((name) => /KEY|PASSWORD|SECRET|TOKEN/i.test(name)));
});

test('real foreground shell: concurrent calls and oversized command text cannot spawn extra processes', async (t) => {
  const h = await host(t);
  const adopted = await h.adopt();
  denied(await h.call('x'.repeat(NATIVE_RUN_SHELL_LIMITS.commandBytes + 1)));
  assert.equal(h.runtime.handles.length, 0);
  let entered;
  const arrival = new Promise((resolve) => {
    entered = resolve;
  });
  h.runtime.afterSpawn = entered;
  const call = h.call('sleep 30');
  await arrival;
  denied(await h.call('printf concurrent'));
  assert.equal(h.runtime.handles.length, 1);
  await adopted.dispose();
  denied(await call);
});

test('real foreground shell: an existing confining producer is refused instead of rebuilt without its policy', async (t) => {
  const h = await host(t);
  const original = h.ctx.get('shell')[symbols.original];
  Object.defineProperty(original, 'sandboxMode', { value: 'workspace-write', configurable: true });
  assert.throws(() => h.producer.describe(), { code: 'local-shell-unavailable' });
  await assert.rejects(h.adopt());
  assert.equal(h.runtime.handles.length, 0);
});

test('real foreground shell: complete per-Run attempt budget rejects the next command before spawn', async (t) => {
  const h = await host(t);
  await h.adopt();
  for (let i = 0; i < NATIVE_RUN_SHELL_LIMITS.commands; i++) okay(await h.call('printf okay'));
  denied(await h.call('printf excess'));
  assert.equal(h.runtime.handles.length, NATIVE_RUN_SHELL_LIMITS.commands);
});

test('real foreground shell: disposal waits for an admitted actual range observation', async (t) => {
  const h = await host(t);
  const adopted = await h.adopt();
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  h.runtime.afterSpawn = (handle) => {
    const wait = handle.waitForExit.bind(handle);
    handle.waitForExit = async (signal) => {
      enter();
      await held;
      return wait(signal);
    };
  };
  const call = h.call('printf done');
  await entered;
  let closed = false;
  const closing = adopted.dispose().then(() => {
    closed = true;
  });
  try {
    await new Promise(setImmediate);
    assert.equal(closed, false);
  } finally {
    release();
  }
  await closing;
  denied(await call);
});

test('real foreground shell: an unconfirmed range cannot report successful tool settlement or disposal', async (t) => {
  const h = await host(t);
  const adopted = await h.adopt();
  let actualWait;
  h.runtime.afterSpawn = (handle) => {
    actualWait = handle.waitForExit.bind(handle);
    handle.waitForExit = async () => false;
  };
  denied(await h.call('printf done'));
  h.expectDrainFailure();
  denied(await h.call('printf another'));
  assert.equal(h.runtime.handles.length, 1);
  await assert.rejects(adopted.dispose(), { code: 'local-shell-unavailable' });
  assert.equal(await actualWait(AbortSignal.timeout(1000)), true);
});

test('real foreground shell: a true Host Run deadline bounds a default command and confirms its range', async (t) => {
  const h = await host(t);
  await h.adopt();
  h.deadlineFacts.runDeadlineAt = Date.now() + 150;
  const began = Date.now();
  denied(await h.call('sleep 30'));
  assert(Date.now() - began < 3000);
  assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
});

test('real foreground shell: actual dispatch assembles 120s default and 600s maximum without waiting those durations', async (t) => {
  const h = await host(t);
  await h.adopt();
  assert.deepEqual(h.composition.payload.tools.shell.budget, {
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 600_000,
    maxAttempts: 32,
  });
  const normal = await h.call('printf normal');
  okay(normal);
  assert(normal.value.timeoutMs > 119_000 && normal.value.timeoutMs <= 120_000);
  const requested = await h.call('printf requested', { timeoutMs: 50_000 });
  okay(requested);
  assert(requested.value.timeoutMs > 49_000 && requested.value.timeoutMs <= 50_000);
  const capped = await h.call('printf maximum', { timeoutMs: 9_000_000 });
  okay(capped);
  assert(capped.value.timeoutMs > 599_000 && capped.value.timeoutMs <= 600_000);
  assert.equal(h.deadlineFacts.runDeadlineAt, undefined);
});

test('real foreground shell: an actual command longer than five seconds completes under the normal default', async (t) => {
  const h = await host(t);
  await h.adopt();
  const began = Date.now();
  okay(await h.call('sleep 5.2; printf long > long.txt'));
  assert(Date.now() - began >= 5000);
  assert.equal(await readFile(join(h.root, 'long.txt'), 'utf8'), 'long');
  assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
});

test('real foreground shell: original real provider default and maximum remain tighter than the Run profile', async (t) => {
  const h = await host(t, { provider: { timeoutMs: 60, maxTimeoutMs: 60 } });
  await h.adopt();
  for (const patch of [{}, { timeoutMs: 600_000 }]) {
    const began = Date.now();
    denied(await h.call('sleep 0.3', patch));
    assert(Date.now() - began < 3000);
  }
  for (const handle of h.runtime.handles)
    assert.equal(await handle.waitForExit(AbortSignal.timeout(1000)), true);
});

test('real foreground shell: the original provider stop signal is retained across later budget resolution', async (t) => {
  const h = await host(t);
  await h.adopt();
  const stopping = new AbortController();
  const originalResolve = h.originalShell.resolve.bind(h.originalShell);
  h.originalShell.resolve = (request) => ({ ...originalResolve(request), signal: stopping.signal });
  const timer = setTimeout(() => stopping.abort(), 100);
  try {
    denied(await h.call('sleep 0.3'));
    assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
  } finally {
    clearTimeout(timer);
  }
});

test('real foreground shell: original member expiry shortens a running command even with no whole-Run budget', async (t) => {
  const h = await host(t);
  await h.adopt();
  h.deadlineFacts.memberExpiresAt = Date.now() + 150;
  denied(await h.call('sleep 30', { timeoutMs: 600_000 }));
  assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
});

test('real foreground shell: missing, invalid or asynchronous true deadline facts refuse before spawn', async (t) => {
  const h = await host(t);
  for (const deadlines of [
    undefined,
    () => ({}),
    () => ({ memberExpiresAt: Infinity }),
    () => ({ memberExpiresAt: NaN }),
    () => ({ memberExpiresAt: Number.MAX_SAFE_INTEGER + 1 }),
    () => ({ memberExpiresAt: Date.now() - 1 }),
    () => ({ memberExpiresAt: Date.now() + 60_000, runDeadlineAt: Date.now() - 1 }),
    async () => ({ memberExpiresAt: Date.now() + 60_000 }),
  ])
    await assert.rejects(h.adopt({ capability: { ...h.capability, deadlines } }));
  assert.equal(h.runtime.handles.length, 0);
});

test('real foreground shell: elapsed cwd resolution cannot buy a new deadline window', async (t) => {
  const h = await host(t);
  await h.adopt();
  okay(await h.call('printf warmed'));
  const original = h.originalFilesystem.resolve.bind(h.originalFilesystem);
  let held = false;
  h.originalFilesystem.resolve = async (...args) => {
    const target = await original(...args);
    if (!held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return target;
  };
  denied(await h.call('sleep 0.15; printf late > extended.txt', { timeoutMs: 200 }));
  await assert.rejects(readFile(join(h.root, 'extended.txt')));
  for (const handle of h.runtime.handles)
    assert.equal(await handle.waitForExit(AbortSignal.timeout(1000)), true);
});

for (const action of ['stop', 'revoke'])
  test(`real foreground shell: ${action} after five seconds drains the actual long-running process`, async (t) => {
    const h = await host(t);
    const adopted = await h.adopt();
    const call = h.call('sleep 5.2; printf READY; sleep 30; printf late > late-long.txt');
    const until = Date.now() + 12_000;
    while (!h.runtime.handles[0]?.collected.stdout.readFrom(0).text.includes('READY')) {
      assert(Date.now() < until, 'actual command did not reach its READY output');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (action === 'revoke') h.permission.abort();
    await adopted.dispose();
    denied(await call);
    assert.equal(await h.runtime.handles[0].waitForExit(AbortSignal.timeout(1000)), true);
    await assert.rejects(readFile(join(h.root, 'late-long.txt')));
  });

test('real foreground shell: a replaced root refuses before real process launch', async (t) => {
  const h = await host(t);
  await h.adopt();
  await rename(h.root, join(h.home, 'moved'));
  await symlink(h.sibling, h.root, process.platform === 'win32' ? 'junction' : 'dir');
  denied(await h.call('printf forbidden > marker'));
  assert.equal(h.runtime.handles.length, 0);
  await assert.rejects(readFile(join(h.sibling, 'marker')));
});

test('real foreground shell: disposal fences inherited global fallback and a saved actual handler', async (t) => {
  const h = await host(t);
  const adopted = await h.adopt();
  const old = h.ctx.tools.get('bash', h.agent);
  await adopted.dispose();
  assert.equal(h.ctx.tools.get('bash', h.agent), h.ctx.tools.get('bash'));
  denied(await h.call('printf forbidden'));
  await assert.rejects(
    old.execute(
      { command: 'printf forbidden', description: 'old' },
      { agent: h.agent, signal: new AbortController().signal },
    ),
  );
  assert.equal(h.runtime.handles.length, 0);
});
