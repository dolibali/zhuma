/** Original native reservation/tool + actual signed outgoing HTTP. Runtime,
 * backend member/Run authorization and tool execution callers remain contracts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture } from './member-local-execution-protocol-fixture.mjs';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { registerMemberLocalAcceptedInputs } from '../dist/member-local-execution-inputs.js';
import { acceptedInputRef } from '../dist/native-work-session-input-tool.js';

async function setup(t, options = {}) {
  const remote = await fixture(t, { upstream: true, ...options }),
    protocol = await remote.open();
  t.after(() => protocol.close());
  const run = await (await protocol.prepareAccept(randomUUID(), remote.input)).send();
  const { backendId: _backendId, ...scope } = run.value.scope;
  const abort = new AbortController(),
    grant = {
      scope,
      signal: abort.signal,
      assertCurrent() {
        abort.signal.throwIfAborted();
      },
    };
  let row, tool;
  const service = new NativeWorkSessionService(
    {
      read: () => row,
      write: async (_key, value) => {
        row = structuredClone(value);
      },
    },
    {
      connect: async () => {},
      isConnected: () => true,
      status: () => 'idle',
      send: () => {},
      flush: async () => {},
      stop: async () => 'stopped',
    },
  );
  await service.send(grant, {
    requestId: 'contract-first-message',
    text: 'Contract task',
    mode: 'followup',
    selection: run.value.selection,
  });
  const binding = service.open(grant).binding,
    agent = { id: binding.nativeAgentId };
  const ctx = {
    tools: {
      register: (definition) => {
        tool = definition;
      },
    },
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
    effect() {},
  };
  const register = () =>
    registerMemberLocalAcceptedInputs(ctx, binding, grant, service, protocol, run);
  const invoke = (part = 'text', limit = 4, signal = abort.signal) =>
    tool.execute(
      {
        inputRef: acceptedInputRef(scope, run.composition.payload.inputs[0]),
        part,
        limit,
      },
      { agent, token: Symbol(), signal },
    );
  return { remote, protocol, run, service, register, invoke, tool: () => tool };
}

test('member-local input contract: metadata only until tool call; split UTF8 chunks preserve bounded text and links', async (t) => {
  const text = '😀汉'.repeat(10000),
    links = ['https://example.com/1', 'https://example.com/2'];
  const h = await setup(t, { text, links, chunkBytes: 32767 });
  const registered = await h.register();
  assert(!registered.context.includes(text));
  assert.equal(h.remote.seen.filter((v) => v.request.operation === 'input-read').length, 0);
  const read = await h.invoke();
  assert.equal(read.ok, true);
  assert.equal(read.text, '😀汉😀汉');
  assert.equal(read.range.total, 20000);
  assert.equal(read.range.hasMore, true);
  assert(h.remote.seen.filter((v) => v.request.operation === 'input-read').length > 1);
  const references = await h.invoke('links', 1);
  assert.deepEqual(references.links, [links[0]]);
  assert.equal(references.range.hasMore, true);
});

test('member-local input contract: a changed frozen catalog fails before native tool registration', async (t) => {
  const h = await setup(t, {
    mutateCatalog: (items) => {
      items[0].sha256 = '0'.repeat(64);
    },
  });
  await assert.rejects(h.register(), { code: 'input-context-unavailable' });
  assert.equal(h.tool(), undefined);
  assert.equal(h.remote.seen.filter((v) => v.request.operation === 'input-read').length, 0);
});

test('member-local input contract: corrupt content/ranges/base64 cannot enter a successful tool output', async (t) => {
  for (const mutatePage of [
    (page) => {
      page.sha256 = '0'.repeat(64);
    },
    (page) => {
      page.offset++;
      page.totalBytes++;
    },
    (page) => {
      page.base64 = ' '.repeat(page.base64.length);
    },
    (page) => {
      const bytes = Buffer.from(page.base64, 'base64');
      bytes[0] ^= 1;
      page.base64 = bytes.toString('base64');
    },
    (page) => {
      page.byteSize = 0;
      page.base64 = '';
      page.eof = false;
    },
  ]) {
    const h = await setup(t, { mutatePage });
    await h.register();
    const result = await h.invoke();
    assert.deepEqual(result, { ok: false, code: 'input-unavailable' });
    await h.service.whenInputReadsIdle();
  }
});

test('member-local input contract: digest-valid JSON still requires exact original actor/source/version and content schema', async (t) => {
  for (const mutateDocument of [
    (value) => {
      value.actorId = 'other-member';
    },
    (value) => {
      value.source.planId = 'other-plan';
    },
    (value) => {
      value.version.version++;
    },
    (value) => {
      value.content.files = [{ id: 'fake-file' }];
    },
    (value) => {
      value.content.links = ['file:///private/path'];
    },
  ]) {
    const h = await setup(t, { mutateDocument });
    await h.register();
    assert.deepEqual(await h.invoke(), { ok: false, code: 'input-unavailable' });
  }
});

test('member-local input contract: rejected current backend membership never exposes cached content', async (t) => {
  let reject = false;
  const h = await setup(t, {
    inputError: () => (reject ? 'remote-forbidden' : undefined),
  });
  await h.register();
  reject = true;
  assert.deepEqual(await h.invoke(), { ok: false, code: 'input-unavailable' });
  assert.equal(h.remote.seen.filter((v) => v.request.operation === 'input-read').length, 0);
});

test('member-local input contract: abort returns to the tool while actual late auth keeps the original read slot held', async (t) => {
  let held = false;
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const h = await setup(t, {
    beforeAuthentication: async () => {
      if (held) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  t.after(() => release.resolve());
  await h.register();
  held = true;
  const abort = new AbortController(),
    read = h.invoke('text', 4, abort.signal);
  await entered.promise;
  abort.abort();
  assert.deepEqual(await read, { ok: false, code: 'cancelled' });
  let idle = false;
  const draining = h.service.whenInputReadsIdle().then(() => {
    idle = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle, false);
  release.resolve();
  await draining;
  assert.equal(idle, true);
  assert.equal(
    h.remote.seen.filter((v) => v.request.operation === 'input-read').length,
    0,
    'late auth must never start source network after cancellation',
  );
});
