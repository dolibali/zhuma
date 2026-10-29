/** Real tool registry/schema and original reservation service; member transport,
 * admission, Run grants and source values are explicit contracts. No model/GUI proof. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Tools, {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import { SessionId } from '@deepseek-ai/dsh-session';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import {
  describeMemberKnowledgeTool,
  registerMemberKnowledgeTool,
} from '../dist/member-knowledge-tool.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { boot, grant, message, scope, selection } from './native-work-session-fixture.mjs';

const library = {
  id: 'library-a',
  spaceId: scope.spaceId,
  kind: 'team',
  name: 'Team knowledge',
  canCreate: true,
};
const reference = {
  spaceId: scope.spaceId,
  libraryId: library.id,
  pageId: 'guide',
  version: 1,
  checksum: 'a'.repeat(64),
};
const summary = {
  reference,
  title: 'Guide',
  format: 'markdown',
  ownerActorId: scope.actorId,
  pageRevision: 2,
  bytes: 5,
  publishedAt: '2026-10-28T00:00:00.000Z',
};
const search = {
  actorId: scope.actorId,
  spaceId: scope.spaceId,
  libraryIds: [library.id],
  query: 'guide',
  hits: [{ ...summary, snippet: 'hello' }],
  complete: true,
};
const read = {
  actorId: scope.actorId,
  spaceId: scope.spaceId,
  reference,
  part: 'body',
  title: 'Guide',
  format: 'markdown',
  text: 'hello',
  offset: 0,
  length: 5,
  nextOffset: 5,
  totalBytes: 5,
  partChecksum: 'a'.repeat(64),
  sources: [],
};
const written = {
  actorId: scope.actorId,
  spaceId: scope.spaceId,
  libraryId: library.id,
  pageId: 'guide',
  pageRevision: 3,
  operation: 'save-draft',
  disposition: 'saved',
};
const readArgs = {
  action: 'read',
  reference: { pageId: reference.pageId, version: reference.version, checksum: reference.checksum },
};
const proposal = {
  action: 'propose-draft',
  pageId: 'guide',
  expectedVersion: 2,
  idempotencyKey: 'draft-1',
  content: { title: 'Guide', format: 'markdown', text: 'Draft', sources: [reference] },
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness(t, options = {}) {
  let record, definition, cleanup;
  const completionGuards = [];
  const storage = {
    read: () => record,
    write: async (_key, value) => {
      record = structuredClone(value);
    },
  };
  const runtime = {
    connect: async () => {},
    isConnected: () => true,
    status: () => 'idle',
    send: () => {},
    flush: async () => {},
    stop: async () => 'stopped',
  };
  const current = grant();
  const sessions = new NativeWorkSessionService(storage, runtime);
  await sessions.send(current, message('start', 'contract'));
  const binding = sessions.open(current).binding;
  const agent = { id: binding.nativeAgentId };
  const calls = [],
    gates = [];
  const ports = {
    catalog: { scope, library },
    allowDrafts: options.allowDrafts ?? false,
    async assertCurrent(signal) {
      gates.push(signal);
      signal.throwIfAborted();
      await options.gate?.(signal);
    },
    async invoke(request, signal) {
      calls.push(structuredClone(request));
      return options.invoke
        ? options.invoke(request, signal)
        : {
            ok: true,
            value: structuredClone(
              request.action === 'search' ? search : request.action === 'read' ? read : written,
            ),
          };
    },
  };
  const ctx = {
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
    tools: {
      guard: (guard) => completionGuards.push(guard),
      register: (value) => {
        definition = value;
      },
    },
    effect: (factory) => {
      cleanup = factory();
    },
  };
  const composition = registerMemberKnowledgeTool(
    ctx,
    binding,
    current,
    sessions,
    ports,
    options.required,
  );
  t.after(async () => {
    await cleanup();
  });
  const execute = async (request, patch = {}) => {
    const exec = { agent, token: Symbol('tool'), signal: new AbortController().signal, ...patch };
    const value = await definition.execute({ request }, exec);
    return { value, exec };
  };
  const call = async (request, patch) => (await execute(request, patch)).value;
  return {
    sessions,
    binding,
    current,
    agent,
    ctx,
    ports,
    composition,
    calls,
    gates,
    call,
    execute,
    definition,
    value: () => record,
    completionGuard: () =>
      completionGuards
        .map((guard) =>
          guard({
            name: 'complete_work',
            agent,
            signal: current.signal,
          }),
        )
        .find(Boolean),
    finalize: ({ exec, value }) =>
      JSON.parse(definition.finalizeContent(exec, { isError: false, value })[0].text),
  };
}

test('SDK: immutable exact descriptor validates three actions and rejects publish/caller/partial refs', async () => {
  const d = describeMemberKnowledgeTool();
  assert.equal(
    createHash('sha256').update(JSON.stringify(d)).digest('hex'),
    'eb797f16228ffd0160a7e463651251ebfe948ca6e30054d09e6a20b54786c191',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  assert.equal(Object.isFrozen(d.parameters.properties.request.oneOf), true);
  assert.notEqual(d.parameters, describeMemberKnowledgeTool().parameters);
  assertObjectJsonSchema(d.parameters);
  assertSupportedJsonSchema(d.outputSchema);
  for (const request of [{ action: 'search', query: 'guide' }, readArgs, proposal])
    assert.deepEqual(validateJsonSchemaValue(d.parameters, { request }), []);
  for (const request of [
    { action: 'publish' },
    { action: 'search', query: 'x', caller: {} },
    { ...readArgs, reference: { pageId: 'guide', version: 1 } },
  ])
    assert.ok(validateJsonSchemaValue(d.parameters, { request }).length);
  const ctx = new Context();
  try {
    await ctx.plugin(Prompt);
    await ctx.plugin(Tools, { mode: 'native' });
    ctx.tools.register({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
      output: {
        schema: d.outputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: () => ({ ok: false, code: 'forbidden' }),
    });
    const result = await ctx.tools.execute({
      callId: 'knowledge-schema',
      name: d.name,
      arguments: { request: { action: 'search', query: 'guide' } },
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, { ok: false, code: 'forbidden' });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('registration is metadata-only and never waits for dispatch/admission', async (t) => {
  const h = await harness(t, { gate: () => assert.fail('registration must not await admission') });
  assert.deepEqual(h.composition.toolAllowlist, ['knowledge']);
  assert.equal(h.gates.length, 0);
  assert.equal(h.calls.length, 0);
  assert.ok(h.composition.context.includes(library.name));
  assert.ok(!h.composition.context.includes('hello'));
  const d = describeMemberKnowledgeTool();
  assert.deepEqual(h.definition.parameters, d.parameters);
  assert.deepEqual(h.definition.output.schema, d.outputSchema);
});

test('SDK: the actual leaf executes in the genuine scoped Agent tool registry without a model', async (t) => {
  const h = await harness(t, { allowDrafts: true });
  const root = await mkdtemp(join(tmpdir(), 'zhuma-knowledge-sdk-'));
  let host, handle;
  try {
    host = await boot(root);
    // Direct public SDK creation is a contract caller, not a bypass of the
    // production native retention/admission issuer or proof of model execution.
    handle = await host.ctx.agents.create({
      sessionId: SessionId(h.binding.nativeSessionId),
      agentOptions: { provider: selection.provider, model: selection.model },
    });
    assert.equal(handle.agent.id, h.binding.nativeAgentId);
    registerMemberKnowledgeTool(handle.agent.ctx, h.binding, h.current, h.sessions, h.ports);
    let n = 0;
    for (const request of [{ action: 'search', query: 'guide' }, readArgs, proposal]) {
      const result = await handle.agent.ctx.tools.execute({
        callId: `knowledge-leaf-${++n}`,
        name: 'knowledge',
        arguments: { request },
        signal: new AbortController().signal,
        agent: handle.agent,
      });
      assert.equal(result.isError, false);
      assert.equal(result.value.ok, true);
      assert.equal(JSON.parse(result.content[0].text).action, request.action);
    }
    assert.equal(h.calls.length, 3);
    assert.equal(host.adapter.requests.length, 0);
  } finally {
    await handle?.dispose();
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('registration rejects each stale scope field and a foreign library before registering', async (t) => {
  const h = await harness(t);
  for (const field of Object.keys(scope)) {
    const wrong = { ...scope, [field]: typeof scope[field] === 'number' ? 2 : 'other' };
    assert.throws(
      () =>
        registerMemberKnowledgeTool(h.ctx, h.binding, h.current, h.sessions, {
          ...h.ports,
          catalog: { scope: wrong, library },
        }),
      { code: 'input-context-unavailable' },
    );
  }
  assert.throws(
    () =>
      registerMemberKnowledgeTool(h.ctx, h.binding, h.current, h.sessions, {
        ...h.ports,
        catalog: { scope, library: { ...library, spaceId: 'private' } },
      }),
    { code: 'input-context-unavailable' },
  );
});

test('search and fixed read bind actual space/library and preserve exact version/checksum/slice', async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.call({ action: 'search', query: ' guide ' }), {
    ok: true,
    action: 'search',
    value: search,
  });
  assert.deepEqual(h.calls[0], {
    action: 'search',
    payload: { spaceId: scope.spaceId, libraryIds: [library.id], query: 'guide', limit: 5 },
  });
  assert.deepEqual(await h.call(readArgs), { ok: true, action: 'read', value: read });
  assert.deepEqual(h.calls[1], {
    action: 'read',
    payload: { ...reference, part: 'body', offset: 0, length: 4096 },
  });
  assert.equal(h.gates.length, 4);
  assert.equal(h.value().inputReadBudget.attempts, 2);
  assert.ok(h.value().inputReadBudget.chargedBytes < 24576);
});

test('default-off consent cannot be enabled by a prompt/model field or mutating the factory result', async (t) => {
  const h = await harness(t);
  h.ports.allowDrafts = true;
  assert.deepEqual(await h.call(proposal), { ok: false, code: 'forbidden' });
  assert.deepEqual(await h.call({ ...proposal, allowDrafts: true }), {
    ok: false,
    code: 'invalid',
  });
  assert.equal(h.calls.length, 0);
});

test('explicit Run consent only proposes the original author/CAS/idempotency request, never publishes', async (t) => {
  const h = await harness(t, { allowDrafts: true });
  assert.deepEqual(await h.call(proposal), { ok: true, action: 'propose-draft', value: written });
  assert.deepEqual(h.calls[0], {
    action: 'propose-draft',
    payload: {
      spaceId: scope.spaceId,
      libraryId: library.id,
      pageId: proposal.pageId,
      expectedVersion: 2,
      idempotencyKey: 'draft-1',
      content: proposal.content,
    },
  });
  assert.deepEqual(
    await h.call({
      ...proposal,
      content: { ...proposal.content, sources: [{ ...reference, spaceId: 'other' }] },
    }),
    { ok: false, code: 'forbidden' },
  );
  assert.equal(h.calls.length, 1);
});

test('invalid selectors, URLs, budgets and missing checksums never reach the source', async (t) => {
  for (const request of [
    { action: 'search', query: 'x', spaceId: 'other' },
    { action: 'search', query: 'x', limit: 11 },
    { action: 'search', query: 'x', url: 'https://example.org' },
    { action: 'publish', pageId: 'guide' },
    { ...readArgs, reference: { pageId: 'guide', version: 1 } },
    { ...readArgs, offset: -1 },
    { ...readArgs, length: 8193 },
    { ...proposal, content: { ...proposal.content, text: '😀'.repeat(2049) } },
  ]) {
    const h = await harness(t, { allowDrafts: true });
    assert.deepEqual(await h.call(request), { ok: false, code: 'invalid' });
    assert.equal(h.calls.length, 0);
    assert.equal(h.value().inputReadBudget.attempts, 1);
  }
});

test('foreign actor/space/library/source and stale version/checksum responses are not rendered', async (t) => {
  for (const patch of [
    { actorId: 'other' },
    { spaceId: 'other' },
    { reference: { ...reference, libraryId: 'other' } },
    { reference: { ...reference, version: 2 } },
    { reference: { ...reference, checksum: 'b'.repeat(64) } },
    { sources: [{ ...reference, spaceId: 'other' }] },
    { length: 4 },
    { nextOffset: 6 },
    { part: 'original' },
  ]) {
    const h = await harness(t, {
      invoke: async () => ({ ok: true, value: { ...read, ...patch } }),
    });
    assert.deepEqual(await h.call(readArgs), { ok: false, code: 'unavailable' });
  }
});

test('backend failure messages and unexpected exceptions never leak through model output', async (t) => {
  for (const invoke of [
    async () => ({ ok: false, error: { code: 'forbidden', message: 'PRIVATE_TRANSPORT_DETAIL' } }),
    async () => {
      throw Error('PRIVATE_TRANSPORT_DETAIL');
    },
    async () => ({ ok: false, error: { code: 'PRIVATE_TRANSPORT_DETAIL' } }),
  ]) {
    const h = await harness(t, { invoke });
    const result = await h.call(readArgs);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  }
});

test('genuine agent identity and current grant are rechecked before any source I/O', async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.call(readArgs, { agent: { id: h.agent.id } }), {
    ok: false,
    code: 'unavailable',
  });
  h.current.deny();
  assert.deepEqual(await h.call(readArgs), { ok: false, code: 'unavailable' });
  assert.equal(h.calls.length, 0);
});

test('admission is awaited only inside invocation, cancellation prevents late source dispatch', async (t) => {
  const admission = deferred(),
    entered = deferred();
  const h = await harness(t, {
    gate: async () => {
      entered.resolve();
      await admission.promise;
    },
  });
  const abort = new AbortController();
  const pending = h.call(readArgs, { signal: abort.signal });
  await entered.promise;
  assert.equal(h.calls.length, 0);
  abort.abort();
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  admission.resolve();
  await h.sessions.whenInputReadsIdle(scope);
  assert.equal(h.calls.length, 0);
});

test('cancelled wait retains the shared reservation until the actual source settles', async (t) => {
  const source = deferred(),
    entered = deferred();
  let first = true;
  const h = await harness(t, {
    invoke: async () => {
      if (first) {
        first = false;
        entered.resolve();
        return source.promise;
      }
      return { ok: true, value: read };
    },
  });
  const abort = new AbortController();
  const pending = h.call(readArgs, { signal: abort.signal });
  await entered.promise;
  abort.abort();
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  assert.deepEqual(await h.call(readArgs), { ok: false, code: 'input-read-busy' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.value().inputReadBudget.chargedBytes, 24576);
  source.resolve({ ok: true, value: read });
  await h.sessions.whenInputReadsIdle(scope);
  assert.equal(h.value().inputReadBudget.chargedBytes, 24576);
  assert.equal((await h.call(readArgs)).ok, true);
});

test('revocation while the source is pending cannot return its late body', async (t) => {
  const source = deferred(),
    entered = deferred();
  const h = await harness(t, {
    invoke: async () => {
      entered.resolve();
      return source.promise;
    },
  });
  const pending = h.call(readArgs);
  await entered.promise;
  h.current.revoke();
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  source.resolve({ ok: true, value: read });
  await h.sessions.whenInputReadsIdle(scope);
  assert.equal(h.value().inputReadBudget.chargedBytes, 24576);
});

test('oversize output cannot consume another input tool page or disclose its contents', async (t) => {
  const h = await harness(t, {
    invoke: async () => ({
      ok: true,
      value: {
        ...read,
        text: '\u0000'.repeat(8192),
        length: 8192,
        nextOffset: 8192,
        totalBytes: 8192,
      },
    }),
  });
  assert.deepEqual(await h.call({ ...readArgs, length: 8192 }), {
    ok: false,
    code: 'output-too-large',
  });
  assert.equal(h.value().inputReadBudget.chargedBytes, 24576);
});

test('final model content rejects post-execute mutation, token replay and late revocation', async (t) => {
  const h = await harness(t);
  const first = await h.execute(readArgs);
  first.value.value.text = 'LEAK';
  const altered = h.definition.finalizeContent(first.exec, { isError: false, value: first.value });
  assert.deepEqual(JSON.parse(altered[0].text), { ok: false, code: 'unavailable' });
  const second = await h.execute(readArgs);
  const accepted = h.definition.finalizeContent(second.exec, {
    isError: false,
    value: second.value,
  });
  assert.equal(JSON.parse(accepted[0].text).ok, true);
  const replay = h.definition.finalizeContent(second.exec, { isError: false, value: second.value });
  assert.deepEqual(JSON.parse(replay[0].text), { ok: false, code: 'unavailable' });
  const third = await h.execute(readArgs);
  h.current.revoke();
  const stale = h.definition.finalizeContent(third.exec, { isError: false, value: third.value });
  assert.deepEqual(JSON.parse(stale[0].text), { ok: false, code: 'cancelled' });
});

test('attempt exhaustion is shared with original input reads and does not dispatch more I/O', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 16; i++) assert.equal((await h.call(readArgs)).ok, true);
  const before = structuredClone(h.value());
  assert.deepEqual(await h.call(readArgs), { ok: false, code: 'input-read-budget-exceeded' });
  assert.deepEqual(h.value(), before);
  assert.equal(h.calls.length, 16);
});

test('current transport/consent gate is rechecked after a source reply before rendering', async (t) => {
  let gate = 0;
  const h = await harness(t, {
    gate: () => {
      if (++gate === 2) throw Error('revoked-connection');
    },
  });
  assert.deepEqual(await h.call(readArgs), { ok: false, code: 'unavailable' });
  assert.equal(h.calls.length, 1);
  assert.equal(gate, 2);
  await tick();
});

const requiredBody = Buffer.from('A汉😀BC');
const requiredRef = {
  ...reference,
  checksum: createHash('sha256').update(requiredBody).digest('hex'),
};
const requiredArgs = (offset = 0, length = 8192, patch = {}) => ({
  action: 'read',
  reference: {
    pageId: requiredRef.pageId,
    version: requiredRef.version,
    checksum: requiredRef.checksum,
  },
  offset,
  length,
  ...patch,
});
const requiredPage = (request) => {
  const { offset, length, part } = request.payload;
  const text = requiredBody.subarray(offset, offset + length).toString('utf8');
  return {
    ...read,
    reference: requiredRef,
    part,
    text,
    offset,
    length: Buffer.byteLength(text),
    nextOffset: offset + Buffer.byteLength(text),
    totalBytes: requiredBody.length,
    partChecksum: requiredRef.checksum,
  };
};
const requiredHarness = (t, options = {}) =>
  harness(t, {
    required: [requiredRef],
    invoke: async (request) => ({ ok: true, value: requiredPage(request) }),
    ...options,
  });

test('required knowledge: only finalized exact body bytes count; search, original and execute alone do not', async (t) => {
  const h = await requiredHarness(t, {
    invoke: async (request) => ({
      ok: true,
      value: request.action === 'search' ? search : requiredPage(request),
    }),
  });
  assert.equal(h.completionGuard(), 'native-required-knowledge-unread');
  assert.equal(h.finalize(await h.execute({ action: 'search', query: 'guide' })).ok, true);
  assert.equal(h.finalize(await h.execute(requiredArgs(0, 8192, { part: 'original' }))).ok, true);
  const pending = await h.execute(requiredArgs());
  assert.equal(pending.value.ok, true);
  assert.equal(h.completionGuard(), 'native-required-knowledge-unread');
  assert.equal(h.finalize(pending).ok, true);
  assert.equal(h.completionGuard(), undefined);
});

test('required knowledge: exact UTF8 byte union permits out-of-order/overlap but duplicates never fill a gap', async (t) => {
  const h = await requiredHarness(t);
  for (const [offset, length] of [
    [4, 4],
    [4, 4],
    [0, 1],
    [8, 2],
  ]) {
    assert.equal(h.finalize(await h.execute(requiredArgs(offset, length))).ok, true);
    assert.equal(h.completionGuard(), 'native-required-knowledge-unread');
  }
  assert.equal(h.finalize(await h.execute(requiredArgs(1, 3))).ok, true);
  assert.equal(h.completionGuard(), undefined);
});

test('required knowledge: all fixed refs are necessary; another page/version/checksum cannot discharge them', async (t) => {
  const second = { ...requiredRef, pageId: 'second' };
  const exact = await requiredHarness(t, {
    required: [requiredRef, second],
    invoke: async (request) => ({
      ok: true,
      value: {
        ...requiredPage(request),
        reference: {
          ...requiredRef,
          pageId: request.payload.pageId,
          version: request.payload.version,
          checksum: request.payload.checksum,
        },
      },
    }),
  });
  for (const patch of [{ pageId: 'other' }, { version: 2 }, { checksum: 'b'.repeat(64) }]) {
    await exact
      .execute(requiredArgs(0, 8192, { reference: { ...requiredArgs().reference, ...patch } }))
      .then(exact.finalize);
    assert.equal(exact.completionGuard(), 'native-required-knowledge-unread');
  }
  assert.equal(exact.finalize(await exact.execute(requiredArgs())).ok, true);
  assert.equal(exact.completionGuard(), 'native-required-knowledge-unread');
  assert.equal(
    exact.finalize(
      await exact.execute(
        requiredArgs(0, 8192, {
          reference: { ...requiredArgs().reference, pageId: 'second' },
        }),
      ),
    ).ok,
    true,
  );
  assert.equal(exact.completionGuard(), undefined);
});

test('required knowledge: registration rejects foreign scope/library or incomplete references before any I/O', async (t) => {
  const h = await harness(t);
  for (const ref of [
    { ...requiredRef, spaceId: 'foreign' },
    { ...requiredRef, libraryId: 'foreign' },
    { ...requiredRef, checksum: '' },
    { ...requiredRef, version: 0 },
  ]) {
    assert.throws(
      () => registerMemberKnowledgeTool(h.ctx, h.binding, h.current, h.sessions, h.ports, [ref]),
      { code: 'input-context-unavailable' },
    );
  }
  assert.equal(h.calls.length, 0);
});

test('required knowledge: failures and bad body/part checksums or inconsistent total ranges cannot allow completion', async (t) => {
  for (const reply of [
    { ok: false, error: { code: 'not-found' } },
    { ok: false, error: { code: 'forbidden' } },
    {
      ok: true,
      value: {
        ...requiredPage({ payload: { offset: 0, length: 8192, part: 'body' } }),
        text: 'X汉😀BC',
      },
    },
    {
      ok: true,
      value: {
        ...requiredPage({ payload: { offset: 0, length: 8192, part: 'body' } }),
        partChecksum: 'b'.repeat(64),
      },
    },
    {
      ok: true,
      value: {
        ...requiredPage({ payload: { offset: 0, length: 8192, part: 'body' } }),
        reference: { ...requiredRef, version: 2 },
      },
    },
  ]) {
    const h = await requiredHarness(t, { invoke: async () => reply });
    assert.equal(h.finalize(await h.execute(requiredArgs())).ok, false);
    assert.equal(h.completionGuard(), 'native-required-knowledge-unread');
  }
  let changed = false;
  const h = await requiredHarness(t, {
    invoke: async (request) => ({
      ok: true,
      value: { ...requiredPage(request), totalBytes: requiredBody.length + (changed ? 1 : 0) },
    }),
  });
  assert.equal(h.finalize(await h.execute(requiredArgs(0, 4))).ok, true);
  changed = true;
  assert.equal(h.finalize(await h.execute(requiredArgs(4, 6))).ok, false);
  assert.equal(h.completionGuard(), 'native-required-knowledge-unread');
});

test('required knowledge: mutation, cancellation and a forged finalizer token do not count successful execute output', async (t) => {
  const h = await requiredHarness(t);
  const mutated = await h.execute(requiredArgs());
  mutated.value.value.text = 'X汉😀BC';
  assert.equal(h.finalize(mutated).ok, false);
  const forged = await h.execute(requiredArgs());
  assert.equal(h.finalize({ ...forged, exec: { ...forged.exec, token: Symbol() } }).ok, false);
  assert.equal(h.completionGuard(), 'native-required-knowledge-unread');
  const abort = new AbortController();
  const cancelled = await h.execute(requiredArgs(), { signal: abort.signal });
  abort.abort();
  assert.equal(h.finalize(cancelled).ok, false);
  assert.equal(h.completionGuard(), 'native-required-knowledge-unread');
});

test('required knowledge: scope-local observations and frozen requirements cannot be borrowed by another registration or Run', async (t) => {
  const required = [structuredClone(requiredRef)];
  const h = await requiredHarness(t, { required });
  required.length = 0;
  assert.equal(h.completionGuard(), 'native-required-knowledge-unread');
  assert.equal(h.finalize(await h.execute(requiredArgs())).ok, true);
  assert.equal(h.completionGuard(), undefined);
  const cold = await requiredHarness(t);
  assert.equal(cold.completionGuard(), 'native-required-knowledge-unread');
  h.current.revoke();
  assert.equal(h.completionGuard(), 'native-required-knowledge-unavailable');
});

test('optional knowledge: no forced read or completion guard is added', async (t) => {
  const h = await harness(t);
  assert.equal(h.calls.length, 0);
  assert.equal(h.completionGuard(), undefined);
});

test('SDK required knowledge: original monotonic guard rejects before the completion body; successful exact read then permits it', async (t) => {
  const h = await requiredHarness(t);
  const root = await mkdtemp(join(tmpdir(), 'zhuma-required-knowledge-sdk-'));
  let host, handle;
  let completionCalls = 0;
  try {
    host = await boot(root);
    handle = await host.ctx.agents.create({
      sessionId: SessionId(h.binding.nativeSessionId),
      agentOptions: { provider: selection.provider, model: selection.model },
    });
    const ctx = handle.agent.ctx,
      definition = describeNativeResultTool();
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: {
        schema: definition.outputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute() {
        completionCalls++;
        return { ok: false, code: 'result-unavailable' };
      },
    });
    registerMemberKnowledgeTool(ctx, h.binding, h.current, h.sessions, h.ports, [requiredRef]);
    let sequence = 0;
    const execute = (name, args) =>
      ctx.tools.execute({
        name,
        callId: `required-${++sequence}`,
        arguments: args,
        agent: handle.agent,
        signal: new AbortController().signal,
      });
    const denied = await execute('complete_work', { text: 'No read yet.', links: [] });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /native-required-knowledge-unread/u);
    assert.equal(completionCalls, 0);
    assert.equal(h.value().resultIntent, undefined);
    assert.equal((await execute('knowledge', { request: requiredArgs(0, 4) })).value.ok, true);
    assert.equal(
      (await execute('complete_work', { text: 'Only a part.', links: [] })).isError,
      true,
    );
    assert.equal(completionCalls, 0);
    assert.equal((await execute('knowledge', { request: requiredArgs(4, 6) })).value.ok, true);
    assert.equal(
      (await execute('complete_work', { text: 'Read fixed body.', links: [] })).isError,
      false,
    );
    assert.equal(completionCalls, 1);
    assert.equal(host.adapter.requests.length, 0);
  } finally {
    await handle?.dispose();
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});
