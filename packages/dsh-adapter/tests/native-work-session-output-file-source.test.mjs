/** Actual Cordis/official local FS bytes; Run/workspace/publication issuers are contracts. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, truncate, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SessionStore from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import {
  NativeRunLocalToolProducer,
  NATIVE_RUN_LOCAL_TOOL_CONFIG,
  NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
} from '../dist/native-run-local-tools.js';
import { NativeOutputFileByteProducer } from '../dist/native-work-session-output-file-source.js';

class InspectableFS extends LocalFileSystem {
  reads = 0;
  async readBytes(...args) {
    this.reads++;
    await this.beforeRead?.();
    const value = await super.readBytes(...args);
    await this.afterRead?.();
    return value;
  }
}
async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-output-source-'));
  const root = join(home, 'work');
  await mkdir(join(root, 'outputs'), { recursive: true });
  const binary = Buffer.from([0, 255, 254, 128, 1, 37, 80, 68, 70, 0, 42]);
  await writeFile(join(root, 'outputs', 'a.bin'), binary);
  await writeFile(join(home, 'outside.bin'), 'PRIVATE_OUTSIDE_BYTES');
  const ctx = new Context(),
    fibers = [];
  for (const [plugin, config] of [
    [SystemPrompt],
    [Tools],
    [SessionStore],
    [Projections],
    [InspectableFS, { cwd: root }],
    [WorkingDirectory, { defaultDirectory: root }],
    [ToolFs, NATIVE_RUN_LOCAL_TOOL_CONFIG],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  }
  const lifetime = new AbortController(),
    run = new AbortController(),
    publication = new AbortController();
  const scope = {
    actorId: 'member',
    spaceId: 'space',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
  };
  const grant = {
    scope,
    signal: run.signal,
    assertCurrent() {
      assert.equal(run.signal.aborted, false);
    },
  };
  const workspace = {
    scope: { ...scope },
    root,
    permissions: { read: true, write: false },
    signal: lifetime.signal,
    assertCurrent() {},
  };
  let allowed = true;
  const authority = {
    scope: { ...scope },
    configurationId: 'configuration',
    signal: publication.signal,
    paths: [{ kind: 'directory', path: 'outputs' }],
    assertCurrent() {
      if (!allowed)
        throw Object.assign(Error('publication-denied'), { code: 'publication-denied' });
    },
  };
  const native = new NativeRunLocalToolProducer(ctx, {
    sourceVersion: NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
    signal: lifetime.signal,
    assertCurrent() {
      assert.equal(lifetime.signal.aborted, false);
    },
  });
  const producer = new NativeOutputFileByteProducer(native, workspace, authority);
  t.after(async () => {
    await producer.close();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    root,
    binary,
    ctx,
    grant,
    workspace,
    authority,
    producer,
    run,
    publication,
    deny: () => {
      allowed = false;
    },
    inspect: (path = 'outputs/a.bin', signal = new AbortController().signal) =>
      producer.inspect(grant, 'configuration', path, signal),
  };
}

test('output source contract: original local FS preserves non-UTF8 bytes and hashes the exact adopted object', async (t) => {
  const h = await setup(t);
  const read = await h.inspect();
  try {
    const result = await read.read();
    assert.deepEqual(Buffer.from(result.bytes), h.binary);
    assert.equal(result.sha256, createHash('sha256').update(h.binary).digest('hex'));
    assert.equal(read.maximumBytes, h.binary.length);
    assert.equal(result.mediaType, 'application/octet-stream');
  } finally {
    read.close();
    await read.drain();
  }
});

test('output source contract: passive text MIME shares the exact hash/read pass and validates UTF8 across chunk boundaries', async (t) => {
  const h = await setup(t);
  const rows = [
    ['cjk.md', Buffer.from('a'.repeat(65535) + '中文\n'), 'text/plain'],
    ['code.tsx', Buffer.from('const label = "工作流";\n'), 'text/plain'],
    ['config.YAML', Buffer.from('name: 工作流\n'), 'text/plain'],
    ['empty.txt', Buffer.alloc(0), 'text/plain'],
    [
      'tail.md',
      Buffer.concat([Buffer.alloc(65535, 97), Buffer.from([0xe4, 0xb8])]),
      'application/octet-stream',
    ],
    ['nul.json', Buffer.from([123, 0, 125]), 'application/octet-stream'],
    ['binary.txt', h.binary, 'application/octet-stream'],
    [
      'passive.bin',
      Buffer.from('valid UTF8 remains binary without an allowed suffix'),
      'application/octet-stream',
    ],
    ['page.html', Buffer.from('<script>irrelevant()</script>'), 'application/octet-stream'],
    ['image.svg', Buffer.from('<svg/>'), 'application/octet-stream'],
  ];
  for (const [name, bytes, mediaType] of rows) {
    await writeFile(join(h.root, 'outputs', name), bytes);
    const before = h.ctx.fs.reads,
      reading = await h.inspect(`outputs/${name}`);
    try {
      const adopted = await reading.read();
      assert.equal(adopted.mediaType, mediaType, name);
      assert.deepEqual(Buffer.from(adopted.bytes), bytes, name);
      assert.equal(adopted.sha256, createHash('sha256').update(bytes).digest('hex'), name);
      assert.equal(h.ctx.fs.reads - before, 1, 'classification must not read again');
    } finally {
      reading.close();
      await reading.drain();
    }
  }
});

test('output source contract: read permission alone, wrong Run, changed publication scope and asynchronous grants cannot publish', async (t) => {
  const h = await setup(t);
  h.authority.paths = [];
  await assert.rejects(h.inspect(), { code: 'publication-denied' });
  assert.equal(h.ctx.fs.reads, 0);
  const other = await setup(t);
  await assert.rejects(
    other.producer.inspect(
      { ...other.grant, scope: { ...other.grant.scope, runId: 'foreign' } },
      'configuration',
      'outputs/a.bin',
      new AbortController().signal,
    ),
    { code: 'publication-denied' },
  );
  other.authority.assertCurrent = async () => undefined;
  await assert.rejects(other.inspect(), { code: 'publication-denied' });
  assert.equal(other.ctx.fs.reads, 0);
});

test('output source contract: traversal, absolute paths and symlink components are rejected before byte reads', async (t) => {
  const h = await setup(t);
  await symlink(join(h.home, 'outside.bin'), join(h.root, 'outputs', 'linked.bin'));
  for (const path of [
    '../outside.bin',
    '/outside.bin',
    'C:\\outside.bin',
    'outputs/../a.bin',
    'outputs/linked.bin',
  ])
    await assert.rejects(h.inspect(path), { code: 'publication-denied' });
  assert.equal(h.ctx.fs.reads, 0);
});

test('output source contract: a file replaced between inspection and read is not adopted', async (t) => {
  const h = await setup(t),
    read = await h.inspect();
  await writeFile(join(h.root, 'outputs', 'a.bin'), 'replacement with a different size');
  await assert.rejects(read.read(), { code: 'source-changed' });
  read.close();
  await read.drain();
  assert.equal(h.ctx.fs.reads, 0);
});

test('output source contract: a version changing during the real binary read is rejected', async (t) => {
  const h = await setup(t),
    read = await h.inspect();
  h.ctx.fs.afterRead = () => writeFile(join(h.root, 'outputs', 'a.bin'), 'changed during read');
  await assert.rejects(read.read(), { code: 'source-changed' });
  read.close();
  await read.drain();
});

test('output source contract: logical cancellation retains a held physical read until it actually settles', async (t) => {
  const h = await setup(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const cancel = new AbortController(),
    read = await h.inspect('outputs/a.bin', cancel.signal);
  h.ctx.fs.beforeRead = async () => {
    entered.resolve();
    await release.promise;
  };
  try {
    const pending = read.read();
    await entered.promise;
    cancel.abort();
    await assert.rejects(pending, { code: 'cancelled' });
    let drained = false;
    const draining = read.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    release.resolve();
    await draining;
    assert.equal(drained, true);
  } finally {
    release.resolve();
    read.close();
    await read.drain();
  }
});

test('output source contract: the 20MiB bound is checked before reading an oversized file', async (t) => {
  const h = await setup(t);
  await truncate(join(h.root, 'outputs', 'a.bin'), 20 * 1024 * 1024 + 1);
  await assert.rejects(h.inspect(), { code: 'file-too-large' });
  assert.equal(h.ctx.fs.reads, 0);
});
