/** Real Cordis services, public tool-fs handlers, Session and local filesystem.
 * Member/Run/workspace issuers and the session-bearing Agent caller are contracts;
 * no model, native Agent publication, real login or installed desktop is certified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context, symbols } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import { createScope } from '@deepseek-ai/dsh-scope';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import {
  adoptNativeRunLocalTools,
  describeNativeRunLocalTools,
  NativeRunLocalToolProducer,
  NATIVE_RUN_LOCAL_TOOL_CONFIG,
  NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
} from '../dist/native-run-local-tools.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
  readExecutionRunComposition,
} from '../dist/execution-run-composition.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import { describeAcceptedInputTool } from '../dist/native-work-session-input-tool.js';
import { open as openRunHost, checked } from './execution-service-run-fixture.mjs';

class FaultableLocalFileSystem extends LocalFileSystem {
  async resolve(path, options) {
    const result = await super.resolve(path, options);
    await this.afterResolve?.(result, options?.signal);
    return result;
  }
  async writeText(target, content, expected, signal) {
    await this.beforeWrite?.(signal);
    return super.writeText(target, content, expected, signal);
  }
  async streamText(target, signal) {
    const source = await super.streamText(target, signal);
    return this.transformStream ? this.transformStream(source, signal) : source;
  }
}
async function host(t, { readOnly = false, upstream = false } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-local-tools-')));
  const root = join(home, 'work'),
    sibling = join(home, 'work-private');
  await mkdir(root);
  await mkdir(sibling);
  await writeFile(join(root, 'a.txt'), 'hello\n');
  await writeFile(join(sibling, 'secret.txt'), 'PRIVATE_OUTSIDE_BODY');
  t.after(() => rm(home, { recursive: true, force: true }));
  const ctx = new Context(),
    fibers = [];
  let fsFiber, toolFiber;
  for (const [plugin, config] of [
    [SystemPrompt],
    [Tools, { mode: 'native' }],
    [SessionStore],
    [SessionProjections],
    [FaultableLocalFileSystem, { cwd: root }],
    [WorkingDirectory, { defaultDirectory: root }],
    [ToolFs, NATIVE_RUN_LOCAL_TOOL_CONFIG],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
    if (plugin === FaultableLocalFileSystem) fsFiber = fiber;
    if (plugin === ToolFs) toolFiber = fiber;
  }
  const source = new AbortController(),
    permission = new AbortController(),
    run = new AbortController();
  const producer = new NativeRunLocalToolProducer(ctx, {
    sourceVersion: NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
    signal: source.signal,
    assertCurrent() {
      assert.equal(source.signal.aborted, false);
    },
  });
  const facts = compositionFacts({ upstream });
  const session = ctx.sessions.create(SessionId('native-local-session'), { cwd: root });
  const agent = { session };
  const scope = createScope(ctx, agent);
  await scope.ctx.fiber;
  agent.ctx = scope.ctx;
  const selected = readOnly ? ['read'] : ['read', 'write', 'edit'];
  const definitions = describeNativeRunLocalTools(producer, selected);
  const composition = freezeExecutionRunComposition({
    ...facts,
    tools: {
      kind: 'local-tools',
      definitions,
      ...(upstream ? { acceptedInputReader: describeAcceptedInputTool() } : {}),
    },
  });
  const binding = {
    schemaVersion: 1,
    scope: structuredClone(facts.scope),
    nativeSessionId: String(session.id),
    nativeAgentId: 'native-local-agent',
    selection: executionRunCompositionRequest(composition).selection,
    receipts: [],
  };
  const grant = {
    scope: structuredClone(facts.scope),
    signal: run.signal,
    assertCurrent(action) {
      assert.equal(action, 'send');
      assert.equal(run.signal.aborted, false);
    },
  };
  const workspace = {
    scope: structuredClone(facts.scope),
    root,
    permissions: { read: true, write: !readOnly },
    signal: permission.signal,
    assertCurrent(action) {
      assert.equal(permission.signal.aborted, false);
      assert.equal(this.permissions[action], true);
    },
  };
  let adoption;
  let expectedDrainFailure = false;
  let calls = 0;
  const h = {
    ctx,
    agent,
    scope,
    producer,
    composition,
    binding,
    grant,
    workspace,
    source,
    permission,
    run,
    home,
    root,
    sibling,
    facts,
    fs: ctx.get('fs'),
    fsFiber,
    toolFiber,
    backend: ctx.get('fs')[symbols.original],
    expectDrainFailure() {
      expectedDrainFailure = true;
    },
    async adopt(patch = {}) {
      adoption = await adoptNativeRunLocalTools(scope.ctx, binding, grant, {
        composition,
        producer,
        workspace,
        ...patch,
      });
      return adoption;
    },
    call(name, args, patch = {}) {
      return ctx.tools.execute({
        callId: `local-${++calls}`,
        name,
        arguments: args,
        signal: new AbortController().signal,
        agent,
        ...patch,
      });
    },
  };
  t.after(async () => {
    if (expectedDrainFailure) {
      await assert.rejects(adoption.dispose(), { code: 'local-tools-unavailable' });
      await Promise.allSettled([scope.dispose()]);
    } else {
      await adoption?.dispose();
      await scope.dispose();
    }
    for (const fiber of fibers.reverse()) await fiber.dispose();
  });
  return h;
}
const okay = (result) => assert.equal(result.isError, false, JSON.stringify(result));
const denied = (result) => {
  assert.equal(result.isError, true);
  assert(!JSON.stringify(result).includes('PRIVATE_OUTSIDE_BODY'));
};

test('real file tools: descriptors come from the live producer and local snapshot survives copied readback', async (t) => {
  const h = await host(t);
  const first = describeNativeRunLocalTools(h.producer, ['read', 'write', 'edit']);
  first[0].parameters = { modified: true };
  assert.notDeepEqual(describeNativeRunLocalTools(h.producer, ['read', 'write', 'edit']), first);
  assert.deepEqual(
    readExecutionRunComposition(JSON.parse(JSON.stringify(h.composition))),
    h.composition,
  );
  assert(!JSON.stringify(h.composition).includes(h.root));
  const adopted = await h.adopt();
  assert.deepEqual(adopted.toolAllowlist, ['read', 'write', 'edit']);
});

test('real file tools: official read/write/edit preserve real bytes, observation and stale versions', async (t) => {
  const h = await host(t);
  await h.adopt();
  okay(await h.call('read', { file_path: 'a.txt' }));
  okay(await h.call('edit', { file_path: 'a.txt', old_string: 'hello', new_string: 'world' }));
  assert.equal(await readFile(join(h.root, 'a.txt'), 'utf8'), 'world\n');
  okay(await h.call('write', { file_path: 'created.txt', content: 'new file' }));
  assert.equal(await readFile(join(h.root, 'created.txt'), 'utf8'), 'new file');
  denied(await h.call('edit', { file_path: 'unobserved.txt', old_string: 'a', new_string: 'b' }));
  okay(await h.call('read', { file_path: 'a.txt' }));
  await writeFile(join(h.root, 'a.txt'), 'external edit\n');
  denied(await h.call('write', { file_path: 'a.txt', content: 'lost update' }));
  assert.equal(await readFile(join(h.root, 'a.txt'), 'utf8'), 'external edit\n');
});

test('real file tools: absolute inside paths work, parent/sibling/symlink/ancestor escapes never read or write bytes', async (t) => {
  const h = await host(t);
  await symlink(
    h.sibling,
    join(h.root, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await h.adopt();
  okay(await h.call('read', { file_path: join(h.root, 'a.txt') }));
  for (const path of [
    join(h.sibling, 'secret.txt'),
    '../work-private/secret.txt',
    'escape/secret.txt',
  ]) {
    denied(await h.call('read', { file_path: path }));
    denied(await h.call('write', { file_path: path, content: 'bad' }));
    denied(await h.call('edit', { file_path: path, old_string: 'PRIVATE', new_string: 'bad' }));
  }
  denied(await h.call('write', { file_path: 'escape/new/file.txt', content: 'bad' }));
  assert.equal(await readFile(join(h.sibling, 'secret.txt'), 'utf8'), 'PRIVATE_OUTSIDE_BODY');
  await assert.rejects(readFile(join(h.sibling, 'new/file.txt')));
});

test('real file tools: read-only refuses inherited global writes, write-only is unsupported, and no approval escalation is adopted', async (t) => {
  const h = await host(t, { readOnly: true });
  await h.adopt();
  okay(await h.call('read', { file_path: 'a.txt' }));
  denied(await h.call('write', { file_path: 'a.txt', content: 'bad' }));
  denied(await h.call('edit', { file_path: 'a.txt', old_string: 'hello', new_string: 'bad' }));
  denied(
    await h.call('read', {
      file_path: 'a.txt',
      sandbox_permissions: 'danger-full-access',
      justification: 'bypass',
    }),
  );
  h.workspace.permissions.read = false;
  h.workspace.permissions.write = true;
  await assert.rejects(h.adopt(), { code: 'local-tools-mismatch' });
  assert.equal(await readFile(join(h.root, 'a.txt'), 'utf8'), 'hello\n');
});

for (const fault of ['run', 'workspace', 'producer'])
  test(`real file tools: ${fault} revocation fences registry dispatch and an old saved handler`, async (t) => {
    const h = await host(t);
    await h.adopt();
    const saved = h.ctx.tools.get('read', h.agent);
    assert(saved);
    if (fault === 'run') h.run.abort();
    if (fault === 'workspace') h.permission.abort();
    if (fault === 'producer') h.source.abort();
    denied(await h.call('read', { file_path: 'a.txt' }));
    await assert.rejects(
      saved.execute(
        { file_path: 'a.txt' },
        { agent: h.agent, signal: new AbortController().signal },
      ),
    );
  });

test('real file tools: wrong scope/configuration/caller and producer Service removal fail closed', async (t) => {
  const h = await host(t);
  const foreign = { ...h.workspace, scope: { ...h.workspace.scope, generation: 99 } };
  await assert.rejects(h.adopt({ workspace: foreign }), { code: 'local-tools-mismatch' });
  const wrong = { ...h.composition, configurationId: 'tampered' };
  await assert.rejects(h.adopt({ composition: wrong }));
  await h.adopt();
  denied(await h.call('read', { file_path: 'a.txt' }, { agent: { session: { id: 'other' } } }));
  await h.fsFiber.dispose();
  denied(await h.call('read', { file_path: 'a.txt' }));
});

test('real file tools: disposal unregisters scope tools, old handlers refuse and the parent producer stays registered', async (t) => {
  const h = await host(t);
  const before = h.ctx.tools.get('read');
  const adopted = await h.adopt();
  const saved = h.ctx.tools.get('read', h.agent);
  assert.notEqual(saved, before);
  await adopted.dispose();
  assert.equal(h.ctx.tools.get('read', h.agent), before);
  denied(await h.call('read', { file_path: 'a.txt' }));
  await assert.rejects(
    saved.execute({ file_path: 'a.txt' }, { agent: h.agent, signal: new AbortController().signal }),
  );
});

test('real file tools: concurrent edits based on the same observation do not silently overwrite each other', async (t) => {
  const h = await host(t);
  await h.adopt();
  okay(await h.call('read', { file_path: 'a.txt' }));
  const results = await Promise.all([
    h.call('edit', { file_path: 'a.txt', old_string: 'hello', new_string: 'one' }),
    h.call('edit', { file_path: 'a.txt', old_string: 'hello', new_string: 'two' }),
  ]);
  assert.equal(results.filter((result) => !result.isError).length, 1);
  assert.match(await readFile(join(h.root, 'a.txt'), 'utf8'), /^(one|two)\n$/u);
});

test('local snapshot: required accepted inputs cannot be omitted or made text-only by local tooling', () => {
  const facts = compositionFacts({ upstream: true });
  assert.throws(
    () =>
      freezeExecutionRunComposition({
        ...facts,
        tools: {
          kind: 'local-tools',
          definitions: [
            {
              name: 'read',
              description: 'Contract metadata',
              parameters: { type: 'object' },
              outputSchema: { type: 'object' },
              sourceVersion: 'contract-only',
            },
          ],
        },
      }),
    { code: 'composition-input-reader-required' },
  );
});

test('real file tools: Cordis trace proxies retain the actual Service identity and producer removal fences local handlers', async (t) => {
  const h = await host(t);
  const first = h.ctx.get('fs'),
    second = h.ctx.get('fs');
  assert.notEqual(first, second);
  assert.equal(first[symbols.original], second[symbols.original]);
  h.producer.assertCurrent();
  await h.adopt();
  okay(await h.call('read', { file_path: 'a.txt' }));
  await h.toolFiber.dispose();
  denied(await h.call('read', { file_path: 'a.txt' }));
});

for (const revoke of ['run', 'workspace'])
  test(`real file tools: ${revoke} revoked during a real resolve cannot release file contents`, async (t) => {
    const h = await host(t);
    await h.adopt();
    let release, entered;
    const held = new Promise((r) => {
      release = r;
    });
    const arrived = new Promise((r) => {
      entered = r;
    });
    let once = true;
    h.backend.afterResolve = async () => {
      if (!once) return;
      once = false;
      entered();
      await held;
    };
    const pending = h.call('read', { file_path: 'a.txt' });
    await arrived;
    (revoke === 'run' ? h.run : h.permission).abort();
    release();
    denied(await pending);
  });

test('real file tools: a new-file ancestor changed to an outside symlink during resolve is refused before write', async (t) => {
  const h = await host(t);
  await mkdir(join(h.root, 'parent'));
  await h.adopt();
  let once = true;
  h.backend.afterResolve = async (target) => {
    if (!once || !String(target.targetKey).endsWith(join('parent', 'new.txt'))) return;
    once = false;
    await rename(join(h.root, 'parent'), join(h.root, 'old-parent'));
    await symlink(
      h.sibling,
      join(h.root, 'parent'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  };
  denied(await h.call('write', { file_path: 'parent/new.txt', content: 'bad' }));
  await assert.rejects(readFile(join(h.sibling, 'new.txt')));
});

test('real file tools: streaming checks revocation between chunks and drains the real source iterator', async (t) => {
  const h = await host(t);
  await h.adopt();
  let closed = false;
  h.backend.transformStream = (source) => ({
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of source) {
          yield chunk.slice(0, 1);
          h.permission.abort();
          yield chunk.slice(1);
        }
      } finally {
        closed = true;
      }
    },
  });
  denied(await h.call('read', { file_path: 'a.txt' }));
  assert.equal(closed, true);
});

test('real file tools: dispose stays pending until an admitted real write quiesces and cannot publish after revocation', async (t) => {
  const h = await host(t);
  const adopted = await h.adopt();
  let release, entered;
  const held = new Promise((r) => {
    release = r;
  });
  const arrived = new Promise((r) => {
    entered = r;
  });
  h.backend.beforeWrite = async (signal) => {
    entered();
    await held;
    signal.throwIfAborted();
  };
  const pending = h.call('write', { file_path: 'never-published.txt', content: 'bad' });
  await arrived;
  let done = false;
  const disposed = adopted.dispose().then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  release();
  denied(await pending);
  await disposed;
  assert.equal(done, true);
  await assert.rejects(readFile(join(h.root, 'never-published.txt')));
});

test('real file tools: missing capabilities, unsupported versions, and an old generation refuse with stable errors', async (t) => {
  const h = await host(t);
  await assert.rejects(h.adopt({ workspace: undefined }), { code: 'local-tools-unavailable' });
  assert.throws(
    () =>
      new NativeRunLocalToolProducer(h.ctx, {
        sourceVersion: 'unknown',
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    { code: 'local-tools-unavailable' },
  );
  await h.adopt();
  h.grant.scope.generation++;
  denied(await h.call('read', { file_path: 'a.txt' }));
});

test(
  'real file tools: the handler deadline aborts actual provider work and does not create a file',
  { timeout: 15_000 },
  async (t) => {
    const h = await host(t);
    await h.adopt();
    let cancelled = false;
    h.backend.beforeWrite = async (signal) => {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      cancelled = true;
      signal.throwIfAborted();
    };
    const began = Date.now();
    denied(await h.call('write', { file_path: 'deadline.txt', content: 'not published' }));
    assert.equal(cancelled, true);
    assert(Date.now() - began >= 4500);
    await assert.rejects(readFile(join(h.root, 'deadline.txt')));
  },
);

test('real file tools: complete writes/edits and source streams enforce the file byte budget', async (t) => {
  const h = await host(t);
  await h.adopt();
  denied(await h.call('write', { file_path: 'too-large.txt', content: 'a'.repeat(1_048_577) }));
  await assert.rejects(readFile(join(h.root, 'too-large.txt')));
  await writeFile(join(h.root, 'huge.txt'), 'a'.repeat(1_048_577));
  denied(await h.call('read', { file_path: 'huge.txt' }));
  denied(await h.call('edit', { file_path: 'huge.txt', old_string: 'a', new_string: 'b' }));
  assert.equal((await readFile(join(h.root, 'huge.txt'))).length, 1_048_577);
});

test('real file tools: a bounded edit cannot amplify its final file beyond the byte budget', async (t) => {
  const h = await host(t);
  await h.adopt();
  const initial = 'x'.repeat(600_000) + 'old';
  await writeFile(join(h.root, 'growth.txt'), initial);
  okay(await h.call('read', { file_path: 'growth.txt' }));
  denied(
    await h.call('edit', {
      file_path: 'growth.txt',
      old_string: 'old',
      new_string: 'y'.repeat(600_000),
    }),
  );
  assert.equal(await readFile(join(h.root, 'growth.txt'), 'utf8'), initial);
  await writeFile(join(h.root, 'all.txt'), 'a'.repeat(1000));
  okay(await h.call('read', { file_path: 'all.txt' }));
  denied(
    await h.call('edit', {
      file_path: 'all.txt',
      old_string: 'a',
      new_string: 'b'.repeat(2000),
      replace_all: true,
    }),
  );
  assert.equal(await readFile(join(h.root, 'all.txt'), 'utf8'), 'a'.repeat(1000));
  okay(
    await h.call('edit', {
      file_path: 'all.txt',
      old_string: 'a',
      new_string: 'b'.repeat(100),
      replace_all: true,
    }),
  );
  assert.equal(await readFile(join(h.root, 'all.txt'), 'utf8'), 'b'.repeat(100_000));
});

test('real file tools: disposing the real Cordis scope drains admitted I/O before completing', async (t) => {
  const h = await host(t);
  await h.adopt();
  let entered, release;
  const arrived = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  h.backend.beforeWrite = async (signal) => {
    entered();
    await held;
    signal.throwIfAborted();
  };
  const pending = h.call('write', { file_path: 'scope-stop.txt', content: 'not published' });
  await arrived;
  let closed = false;
  const closing = h.scope.dispose().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  denied(await pending);
  await closing;
  assert.equal(closed, true);
  await assert.rejects(readFile(join(h.root, 'scope-stop.txt')));
});

test('real file tools: async workspace assertions and late write-only permission changes are refused', async (t) => {
  const h = await host(t);
  await assert.rejects(h.adopt({ workspace: { ...h.workspace, assertCurrent: async () => {} } }), {
    code: 'local-tools-denied',
  });
  await h.adopt();
  h.workspace.permissions.read = false;
  h.workspace.permissions.write = true;
  denied(await h.call('write', { file_path: 'write-only.txt', content: 'bad' }));
  await assert.rejects(readFile(join(h.root, 'write-only.txt')));
});

test('real file tools: a frozen accepted-input descriptor cannot substitute for the actual C reader registration', async (t) => {
  const h = await host(t, { upstream: true });
  assert(h.composition.payload.inputs.length > 0);
  assert(h.composition.payload.toolAllowlist.includes('read_accepted_input'));
  const original = h.ctx.tools.get('read');
  await assert.rejects(h.adopt(), { code: 'local-tools-mismatch' });
  assert.equal(h.ctx.tools.get('read', h.agent), original);
});

test('real file tools: matching tool names with changed JSON definitions cannot be adopted', async (t) => {
  const h = await host(t);
  const definitions = structuredClone(h.composition.payload.tools.definitions);
  definitions[0].description = 'Different implementation contract';
  const composition = freezeExecutionRunComposition({
    ...h.facts,
    tools: { kind: 'local-tools', definitions },
  });
  h.binding.selection = executionRunCompositionRequest(composition).selection;
  await assert.rejects(h.adopt({ composition }), { code: 'local-tools-mismatch' });
});

test('real file tools: an in-root directory alias keeps the official shared-target version guard', async (t) => {
  const h = await host(t);
  await mkdir(join(h.root, 'real-dir'));
  await writeFile(join(h.root, 'real-dir/file.txt'), 'original');
  await symlink(
    join(h.root, 'real-dir'),
    join(h.root, 'alias-dir'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await h.adopt();
  okay(await h.call('read', { file_path: 'alias-dir/file.txt' }));
  okay(
    await h.call('edit', {
      file_path: 'real-dir/file.txt',
      old_string: 'original',
      new_string: 'updated',
    }),
  );
  assert.equal(await readFile(join(h.root, 'alias-dir/file.txt'), 'utf8'), 'updated');
});

test('real file tools: workspace initialization failures never expose the provider private error', async (t) => {
  const h = await host(t);
  h.backend.afterResolve = async () => {
    throw Error('PRIVATE_PROVIDER_ROOT_PATH');
  };
  await assert.rejects(h.adopt(), (error) => {
    assert.equal(error.code, 'local-tools-unavailable');
    assert(!error.message.includes('PRIVATE_PROVIDER_ROOT_PATH'));
    assert(!error.message.includes(h.root));
    return true;
  });
});

test('real file tools: an iterator return failure cannot be reported as successful drain', async (t) => {
  const h = await host(t);
  const adopted = await h.adopt();
  h.backend.transformStream = (source) => ({
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        async return() {
          await iterator.return?.();
          throw Error('PRIVATE_STREAM_CLOSE_FAILURE');
        },
      };
    },
  });
  denied(await h.call('read', { file_path: 'a.txt' }));
  h.expectDrainFailure();
  await assert.rejects(adopted.dispose(), { code: 'local-tools-unavailable' });
  assert.equal(h.ctx.tools.get('read', h.agent), h.ctx.tools.get('read'));
  denied(await h.call('read', { file_path: 'a.txt' }));
});

test('real file tools + JSON Run: the complete local configuration is saved before its actual handlers are adopted', async (t) => {
  const h = await host(t);
  const run = await openRunHost(join(h.home, 'run-store'));
  t.after(() => run.close());
  const tools = {
    kind: 'local-tools',
    definitions: describeNativeRunLocalTools(h.producer, ['read', 'write', 'edit']),
  };
  const body = run.begin({}, 'produce', tools);
  checked(await run.service.startRun(run.request, body));
  assert.deepEqual(run.counters, { global: 1, nodes: 4, plans: 1 });
  const saved = run.service.readRunComposition(run.runLocator());
  assert.deepEqual(saved.payload.tools, body.composition.payload.tools);
  assert(!JSON.stringify(saved).includes(h.root));
  h.binding.scope = structuredClone(saved.payload.scope);
  h.binding.selection = executionRunCompositionRequest(saved).selection;
  h.grant.scope = structuredClone(saved.payload.scope);
  h.workspace.scope = structuredClone(saved.payload.scope);
  await h.adopt({ composition: saved });
  okay(await h.call('read', { file_path: 'a.txt' }));
  okay(
    await h.call('edit', {
      file_path: 'a.txt',
      old_string: 'hello',
      new_string: 'persisted configuration',
    }),
  );
  assert.equal(await readFile(join(h.root, 'a.txt'), 'utf8'), 'persisted configuration\n');
  assert.deepEqual(run.service.readRunComposition(run.runLocator()), saved);
});
