/** Patched pinned SDK, original member Cookie/Run issuer, actual SDK/JSON file bytes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  bootRunFiles,
  allHistory,
  toolResponse,
  describeNativeAcceptedFileTool,
} from './zhuma-native-files-bundle.ts';

test('actual pinned SDK accepts the v2 declaration at ToolRuntime registration without executing it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-file-schema-'));
  const h = await bootRunFiles(root);
  t.onTestFinished(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  const descriptor = describeNativeAcceptedFileTool();
  assert.equal(descriptor.sourceVersion, 'zhuma-accepted-files@2');
  const dispose = h.ctx.tools.register({
    name: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.parameters,
    output: { schema: descriptor.outputSchema, render: () => [] },
    execute: async () => {
      assert.fail('Schema qualification never executes the declaration');
    },
  });
  assert.ok(h.ctx.tools.get(descriptor.name));
  dispose();
  assert.equal(h.adapter.requests.length, 0);
});

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-files-'));
  const h = await bootRunFiles(root, options);
  t.onTestFinished(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await h.upload('V1 original bytes');
  await h.submit(first, 'native-file-v1');
  await h.ballot('request-changes', 'native-return-v1');
  const second = await h.upload(
    options.bytes ?? '\uFEFFV2 accepted selected bytes: 中文正确版本',
    options.name,
    options.mediaType,
  );
  await h.submit(second, 'native-file-v2');
  await h.ballot('approve', 'native-accept-v2');
  const opened = await h.begin();
  t.onTestFinished(() => opened.dispose());
  return { ...h, opened, first, second, inputRef: h.snapshot.payload.contextRefs[0] };
}

test('actual pinned native Agent admits the Cookie-issued expert Run but never upgrades an old text/links snapshot to file access', async (t) => {
  const h = await setup(t);
  const { grant } = h.opened;
  assert.equal(grant.scope.actorId, 'chen');
  assert.equal(h.row('expert').handoff.assignee.kind, 'expert');
  await assert.rejects(h.reader.list(grant, { inputRef: h.inputRef }, grant.signal), {
    code: 'not-found',
  });
  h.adapter.script.push('No file-reading capability is configured.');
  const native = await h.nativeSession();
  const receipt = await native.service.send(grant, h.firstMessage());
  assert.equal(receipt.status, 'received');
  const binding = native.service.open(grant).binding;
  await h.ctx.agents.get(binding.nativeAgentId).whenIdle();
  const history = await allHistory(native.service, grant);
  assert.ok(history.some((event) => event.type === 'assistant/message'));
  assert.deepEqual(
    h.adapter.requests[0].tools.map((tool) => tool.name),
    ['read_accepted_input'],
  );
  const inbox = await native.service.readInbox(grant);
  assert.equal(
    inbox.receipts.find((item) => item.requestId === 'file-run-start').status,
    'claimed',
  );
  assert.equal(JSON.stringify(h.adapter.requests[0]).includes('V2 accepted selected bytes'), false);
});

async function inputTool(t, options = {}) {
  const h = await setup(t, { ...options, acceptedFiles: true });
  const native = await h.nativeSession();
  let turn = 0;
  const agent = () => h.ctx.agents.get(native.service.open(h.opened.grant).binding.nativeAgentId);
  const invoke = async (args, name = 'read_accepted_file') => {
    h.adapter.script.push(toolResponse(args, `file-call-${++turn}`, name), 'Tool result received');
    await native.service.send(
      h.opened.grant,
      turn === 1
        ? h.firstMessage()
        : { ...h.firstMessage(), requestId: `file-turn-${turn}`, text: 'Read selected input.' },
    );
    await agent().whenIdle();
    const history = await allHistory(native.service, h.opened.grant);
    const result = history.filter((event) => event.type === 'tool/result').at(-1);
    assert.ok(result, JSON.stringify(history));
    return JSON.parse(result.data.message.content[0].text);
  };
  return { ...h, native, invoke, agent };
}

test('actual original native Agent lists accepted V2 then reads the exact chosen BOM/Unicode bytes through the original issuer', async (t) => {
  const h = await inputTool(t);
  const files = await h.invoke({ inputRef: h.inputRef, part: 'files' });
  assert.equal(files.ok, true, JSON.stringify(files));
  assert.equal(files.source.version, 2);
  assert.equal(files.source.sourceNodeId, 'source');
  assert.deepEqual(files.source.scope, h.opened.grant.scope);
  assert.equal(files.files[0].fileId, h.second.uploadId);
  assert.equal(
    files.files[0].sha256,
    createHash('sha256').update(h.second.originalBytes).digest('hex'),
  );
  const page = await h.invoke({
    inputRef: h.inputRef,
    part: 'file',
    fileId: h.second.uploadId,
    length: 12,
  });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual(Buffer.from(page.text), h.second.originalBytes.subarray(0, 12));
  assert.equal(page.source.artifactVersionId, h.row('source').acceptedArtifactVersionId);
  assert.deepEqual(page.range, { offset: 0, length: 12, total: h.second.originalBytes.length });
  const start = JSON.stringify(h.adapter.requests[0]);
  assert.equal(start.includes('V2 accepted selected bytes'), false);
  assert.equal(start.includes('V1 original bytes'), false);
  assert.deepEqual(h.adapter.requests[0].tools.map((tool) => tool.name).sort(), [
    'read_accepted_file',
    'read_accepted_input',
  ]);
  assert.equal(h.native.service.open(h.opened.grant).binding.inputReadBudget.attempts, 2);
});

test('actual native file calls share the existing text/links input budget and refuse old IDs and split UTF-8', async (t) => {
  const h = await inputTool(t);
  assert.equal(
    (await h.invoke({ inputRef: h.inputRef, part: 'links' }, 'read_accepted_input')).ok,
    true,
  );
  assert.deepEqual(
    await h.invoke({ inputRef: h.inputRef, part: 'file', fileId: h.first.uploadId }),
    { ok: false, code: 'input-unavailable' },
  );
  const offset = h.second.originalBytes.indexOf(Buffer.from('中文')) + 1;
  assert.deepEqual(
    await h.invoke({
      inputRef: h.inputRef,
      part: 'file',
      fileId: h.second.uploadId,
      offset,
      length: 3,
    }),
    { ok: false, code: 'unsupported-encoding' },
  );
  assert.equal(h.native.service.open(h.opened.grant).binding.inputReadBudget.attempts, 3);
});

test('actual text/links and file tools consume one shared sixteen-attempt reservation ledger', async (t) => {
  let agentCtx;
  const h = await inputTool(t, {
    configureNative(ctx) {
      agentCtx = ctx;
    },
  });
  assert.equal(
    (await h.invoke({ inputRef: h.inputRef, part: 'links' }, 'read_accepted_input')).ok,
    true,
  );
  const call = async (attempt, arguments_) => {
    const result = await agentCtx.tools.execute({
      callId: `budget-${attempt}`,
      name: 'read_accepted_file',
      arguments: arguments_,
      agent: h.agent(),
      signal: new AbortController().signal,
    });
    return JSON.parse(result.content[0].text);
  };
  // These are actual scoped SDK dispatches after the first native loop call,
  // not sixteen extra conversational turns or a second budget implementation.
  for (let attempt = 1; attempt < 16; attempt++)
    assert.equal(
      (
        await call(attempt, {
          inputRef: h.inputRef,
          part: 'file',
          fileId: h.second.uploadId,
          offset: 3,
          length: 1,
        })
      ).ok,
      true,
    );
  assert.deepEqual(await call(16, { inputRef: h.inputRef, part: 'files' }), {
    ok: false,
    code: 'input-read-budget-exceeded',
  });
  assert.equal(h.native.service.open(h.opened.grant).binding.inputReadBudget.attempts, 16);
});

test('actual registered definition refuses a same-ID Agent proxy before another input reservation', async (t) => {
  let agentCtx;
  const h = await inputTool(t, {
    configureNative(ctx) {
      agentCtx = ctx;
    },
  });
  assert.equal((await h.invoke({ inputRef: h.inputRef, part: 'files' })).ok, true);
  const real = h.agent();
  const proxy = new Proxy(real, {});
  assert.equal(proxy.id, real.id);
  const definition = agentCtx.tools.get('read_accepted_file', real);
  const result = await definition.execute(
    { inputRef: h.inputRef, part: 'files' },
    {
      agent: proxy,
      signal: new AbortController().signal,
      token: Symbol('different-agent'),
      callId: 'different-agent',
      rootCallId: 'different-agent',
      name: 'read_accepted_file',
      arguments: {},
      deferContext() {},
      concludeTurn() {},
    },
  );
  assert.deepEqual(result, { ok: false, code: 'input-unavailable' });
  assert.equal(h.native.service.open(h.opened.grant).binding.inputReadBudget.attempts, 1);
});

test('SDK-compatible descriptor preserves strict runtime file arguments before any SDK byte read', async (t) => {
  let agentCtx;
  const h = await inputTool(t, {
    configureNative(ctx) {
      agentCtx = ctx;
    },
  });
  let reads = 0;
  const source = h.ctx.attachments.readFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.readFileStream = (...args) => {
    reads++;
    return source(...args);
  };
  assert.equal((await h.invoke({ inputRef: h.inputRef, part: 'files' })).ok, true);
  for (const [index, arguments_] of [
    { inputRef: h.inputRef, part: 'file' },
    { inputRef: h.inputRef, part: 'file', fileId: h.second.uploadId, length: 8193 },
    { inputRef: h.inputRef, part: 'files', scope: h.opened.grant.scope },
  ].entries()) {
    const result = await agentCtx.tools.execute({
      callId: `invalid-file-${index}`,
      name: 'read_accepted_file',
      arguments: arguments_,
      agent: h.agent(),
      signal: new AbortController().signal,
    });
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, code: 'invalid-arguments' });
  }
  const budget = h.native.service.open(h.opened.grant).binding.inputReadBudget;
  assert.equal(budget.attempts, 4);
  assert.equal(budget.chargedBytes, 65536, 'Failed reads retain their conservative reservations');
  const exhausted = await agentCtx.tools.execute({
    callId: 'exhausted-bytes',
    name: 'read_accepted_file',
    agent: h.agent(),
    signal: new AbortController().signal,
    arguments: {
      inputRef: h.inputRef,
      part: 'file',
      fileId: h.second.uploadId,
      offset: 3,
      length: 1,
    },
  });
  assert.deepEqual(JSON.parse(exhausted.content[0].text), {
    ok: false,
    code: 'input-read-budget-exceeded',
  });
  assert.equal(reads, 0);
});

test('cancelled SDK file dispatch keeps the original input slot until the held SDK source actually drains', async (t) => {
  let agentCtx;
  const h = await inputTool(t, {
    configureNative(ctx) {
      agentCtx = ctx;
    },
  });
  assert.equal((await h.invoke({ inputRef: h.inputRef, part: 'files' })).ok, true);
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const abort = new AbortController();
  const source = h.ctx.attachments.readFileStream.bind(h.ctx.attachments);
  let reads = 0;
  h.ctx.attachments.readFileStream = (...args) => {
    reads++;
    const iterator = source(...args)[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        const value = await iterator.next();
        entered.resolve();
        await gate.promise;
        return value;
      },
      async return() {
        return (await iterator.return?.()) ?? { done: true };
      },
    };
  };
  const call = (callId, signal) =>
    agentCtx.tools.execute({
      callId,
      name: 'read_accepted_file',
      agent: h.agent(),
      signal,
      arguments: {
        inputRef: h.inputRef,
        part: 'file',
        fileId: h.second.uploadId,
        offset: 3,
        length: 1,
      },
    });
  const pending = call('held-file', abort.signal);
  let drain;
  try {
    await entered.promise;
    abort.abort();
    const result = await pending;
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, code: 'cancelled' });
    let idle = false;
    drain = h.native.service.whenInputReadsIdle(h.opened.grant.scope).then(() => {
      idle = true;
    });
    await Promise.resolve();
    assert.equal(
      idle,
      false,
      'Logical cancellation does not return the physical source reservation',
    );
    const busy = await call('still-held-file', new AbortController().signal);
    assert.deepEqual(JSON.parse(busy.content[0].text), { ok: false, code: 'input-read-busy' });
    assert.equal(reads, 1);
    gate.resolve();
    await drain;
    assert.equal(idle, true);
  } finally {
    abort.abort();
    gate.resolve();
    h.ctx.attachments.readFileStream = source;
    await pending.catch(() => undefined);
    await drain;
  }
});

test('actual native finalization rechecks a listed source after an intervening file-ledger change', async (t) => {
  let h;
  h = await inputTool(t, {
    configureNative(ctx) {
      ctx.on('tools/post-execute', async (_exec, result) => {
        if (result.value?.ok) {
          const files = h.ctx.storageDomain.get('zhuma_files').table('files');
          const record = files.get(h.second.uploadId);
          await files.put(record.uploadId, { ...record, state: 'abandoned' });
        }
        return { kind: 'accept' };
      });
    },
  });
  assert.deepEqual(await h.invoke({ inputRef: h.inputRef, part: 'files' }), {
    ok: false,
    code: 'cancelled',
  });
  assert.equal(JSON.stringify(h.adapter.requests).includes(h.second.uploadId), false);
});

test('actual native finalization rejects post-policy replacement of a charged file result', async (t) => {
  const h = await inputTool(t, {
    configureNative(ctx) {
      ctx.on('tools/post-execute', async (_exec, result) => ({
        kind: 'accept',
        value: {
          ...result.value,
          files: [{ ...result.value.files[0], name: 'replacement-must-not-reach-model' }],
        },
      }));
    },
  });
  assert.deepEqual(await h.invoke({ inputRef: h.inputRef, part: 'files' }), {
    ok: false,
    code: 'input-unavailable',
  });
  assert.equal(
    JSON.stringify(h.adapter.requests).includes('replacement-must-not-reach-model'),
    false,
  );
});

const reopenRoot = process.env.ZHUMA_NATIVE_FILE_REOPEN_ROOT;
const reopenMode = process.env.ZHUMA_NATIVE_FILE_REOPEN_MODE;
if (reopenRoot)
  test(`independent-process accepted-file recovery ${reopenMode}`, async () => {
    assert.ok(reopenMode === 'write' || reopenMode === 'read');
    const h = await bootRunFiles(reopenRoot, {
      first: reopenMode === 'write',
      acceptedFiles: true,
    });
    let opened;
    try {
      if (reopenMode === 'write') {
        const old = await h.upload('Rejected V1 must not be selected after reopening.');
        await h.submit(old, 'process-old');
        await h.ballot('request-changes', 'process-return');
        const file = await h.upload('\uFEFFPersisted V2 原始字节。');
        await h.submit(file, 'process-new');
        await h.ballot('approve', 'process-accept');
        opened = await h.begin();
        const inputRef = h.snapshot.payload.contextRefs[0];
        h.adapter.script.push(
          toolResponse(
            { inputRef, part: 'file', fileId: file.uploadId },
            'process-fixed-file',
            'read_accepted_file',
          ),
          'Fixed file read.',
        );
        const native = await h.nativeSession();
        await native.service.send(opened.grant, h.firstMessage());
        await h.ctx.agents.get(native.service.open(opened.grant).binding.nativeAgentId).whenIdle();
        const events = await allHistory(native.service, opened.grant);
        const result = JSON.parse(
          events.filter((event) => event.type === 'tool/result').at(-1).data.message.content[0]
            .text,
        );
        assert.equal(result.ok, true);
        assert.deepEqual(Buffer.from(result.text), file.originalBytes);
        await writeFile(
          join(reopenRoot, 'file-reopen-proof.json'),
          JSON.stringify({
            inputRef,
            fileId: file.uploadId,
            oldId: old.uploadId,
            scope: opened.grant.scope,
            artifactVersionId: result.source.artifactVersionId,
            hex: file.originalBytes.toString('hex'),
          }),
        );
      } else {
        const proof = JSON.parse(
          await readFile(join(reopenRoot, 'file-reopen-proof.json'), 'utf8'),
        );
        opened = await h.openExisting();
        assert.deepEqual(opened.grant.scope, proof.scope);
        const list = await h.reader.list(
          opened.grant,
          { inputRef: proof.inputRef },
          opened.grant.signal,
        );
        assert.equal(list.version, 2);
        assert.equal(list.artifactVersionId, proof.artifactVersionId);
        assert.equal(list.files[0].fileId, proof.fileId);
        const page = await h.reader.read(
          opened.grant,
          { inputRef: proof.inputRef, fileId: proof.fileId, offset: 0, length: 16384 },
          opened.grant.signal,
        );
        assert.equal(Buffer.from(page.bytes).toString('hex'), proof.hex);
        page.check();
        page.release();
        await assert.rejects(
          h.reader.read(
            opened.grant,
            { inputRef: proof.inputRef, fileId: proof.oldId, offset: 0, length: 1 },
            opened.grant.signal,
          ),
          { code: 'not-found' },
        );
        assert.equal(
          h.ctx.agents.list().length,
          0,
          'A fixed-file read does not create/resume another Agent',
        );
        assert.equal(h.adapter.requests.length, 0);
      }
    } finally {
      opened?.dispose();
      await h.close();
    }
  });

for (const [name, mediaType] of [
  ['report.pdf', 'application/pdf'],
  ['image.png', 'image/png'],
])
  test(`actual native ${name} lists metadata but never presents its bytes as decoded text`, async (t) => {
    const h = await inputTool(t, {
      bytes: 'ASCII bytes do not make a rendered document.',
      name,
      mediaType,
    });
    assert.equal(
      (await h.invoke({ inputRef: h.inputRef, part: 'files' })).files[0].mediaType,
      mediaType,
    );
    assert.deepEqual(
      await h.invoke({ inputRef: h.inputRef, part: 'file', fileId: h.second.uploadId }),
      { ok: false, code: 'unsupported-encoding' },
    );
  });
