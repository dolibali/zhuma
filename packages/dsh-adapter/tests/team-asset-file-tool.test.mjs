/** SDK descriptor qualification only, not an installed/run tool or model proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Tools, {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import { describeTeamAssetFileTool } from '../dist/team-asset-file-tool.js';
const reference = {
  spaceId: 'north',
  assetId: 'guide',
  kind: 'file',
  versionId: randomUUID(),
  sha256: 'a'.repeat(64),
};
test('team_asset descriptor: exact immutable metadata admits only fixed-reference list/search/read, without source I/O', () => {
  const d = describeTeamAssetFileTool();
  assert.equal(
    createHash('sha256').update(JSON.stringify(d)).digest('hex'),
    '6bd88de17c0130a82c34c5526121f3a2f1b81a4c0cf4ef36f12e31957398d20a',
  );
  assert.equal(d.name, 'team_asset');
  assert.equal(d.sourceVersion, 'zhuma-native-team-assets@1');
  assert.equal(Object.isFrozen(d.parameters.properties.request.oneOf), true);
  assert.notEqual(d.parameters, describeTeamAssetFileTool().parameters);
  assertObjectJsonSchema(d.parameters);
  assertSupportedJsonSchema(d.outputSchema);
  for (const request of [
    { action: 'list' },
    { action: 'search', query: 'guide' },
    { action: 'read', reference, offset: 0, length: 4096 },
  ])
    assert.deepEqual(validateJsonSchemaValue(d.parameters, { request }), []);
  for (const request of [
    { action: 'publish' },
    { action: 'read', reference: { ...reference, versionId: undefined } },
    { action: 'read', reference, url: 'https://example.org' },
    { action: 'search', query: 'x', actorId: 'another' },
    { action: 'list', attachmentId: 'private-handle' },
  ])
    assert.ok(validateJsonSchemaValue(d.parameters, { request }).length);
});
test('team_asset descriptor: original SDK Tools registry accepts the pure declared schema without a model/process', async () => {
  const ctx = new Context();
  const d = describeTeamAssetFileTool();
  const prompt = ctx.plugin(Prompt);
  await prompt;
  const tools = ctx.plugin(Tools, { mode: 'native' });
  await tools;
  try {
    ctx.tools.register({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
      output: {
        schema: d.outputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ok: false, code: 'unavailable' }),
    });
  } finally {
    await tools.dispose();
    await prompt.dispose();
  }
});

import { registerTeamAssetFileTool } from '../dist/team-asset-file-tool.js';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { grant, message, scope } from './native-work-session-fixture.mjs';
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
  const sessions = new NativeWorkSessionService(
    {
      read: () => record,
      write: async (_key, value) => {
        record = structuredClone(value);
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
  const current = grant();
  await sessions.send(current, message('start', 'contract'));
  const binding = sessions.open(current).binding,
    agent = { id: binding.nativeAgentId };
  const data = options.bytes ?? Buffer.from('A汉😀BC');
  const file = {
    name: '固定使用说明.txt',
    mediaType: options.mediaType ?? 'text/plain',
    byteSize: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
  const reference = {
    spaceId: scope.spaceId,
    assetId: 'guide',
    kind: 'file',
    versionId: randomUUID(),
    sha256: 'a'.repeat(64),
  };
  let reads = 0,
    releases = 0,
    denied = false;
  const catalog = {
    scope,
    files: [{ reference: structuredClone(reference), file: structuredClone(file) }],
  };
  const ports = {
    catalog,
    signal: new AbortController().signal,
    async assertCurrent(signal) {
      signal.throwIfAborted();
      if (denied) throw Error('PRIVATE_REVOKED');
      await options.gate?.(signal);
    },
    openFile(ref, signal) {
      reads++;
      const handle = {
        file: structuredClone(file),
        bytes: Uint8Array.from(data),
        signal,
        check() {
          signal.throwIfAborted();
          if (denied) throw Error('PRIVATE_REVOKED');
        },
        release() {
          releases++;
        },
      };
      return options.open
        ? options.open(ref, signal, handle)
        : { result: Promise.resolve(handle), drain: Promise.resolve() };
    },
  };
  const ctx = {
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
    tools: {
      register: (value) => {
        definition = value;
      },
    },
    effect: (factory) => {
      cleanup = factory();
    },
  };
  const composition = registerTeamAssetFileTool(ctx, binding, current, sessions, ports);
  t.after(async () => {
    await cleanup();
  });
  const execute = async (request, patch = {}) => {
    const exec = {
      agent,
      token: Symbol('team tool'),
      signal: new AbortController().signal,
      ...patch,
    };
    return { exec, value: await definition.execute({ request }, exec) };
  };
  return {
    sessions,
    current,
    binding,
    reference,
    file,
    data,
    catalog,
    composition,
    execute,
    definition,
    reads: () => reads,
    releases: () => releases,
    deny: () => {
      denied = true;
    },
    finalize: ({ exec, value }) =>
      JSON.parse(definition.finalizeContent(exec, { isError: false, value })[0].text),
  };
}

test('team_asset runtime: frozen metadata search reads no body, exact UTF8 slice retains its independent byte digest and lease to final output', async (t) => {
  const h = await harness(t);
  assert.doesNotMatch(h.composition.context, /固定使用说明|versionId/);
  h.catalog.files[0].file.name = 'later mutation';
  const list = await h.execute({ action: 'search', query: '使用说明' });
  assert.equal(list.value.value.files[0].file.name, '固定使用说明.txt');
  assert.equal(h.reads(), 0);
  h.finalize(list);
  const read = await h.execute({ action: 'read', reference: h.reference, offset: 1, length: 4 });
  assert.equal(read.value.ok, true);
  assert.equal(read.value.value.text, '汉');
  assert.equal(read.value.value.length, 3);
  assert.equal(read.value.value.nextOffset, 4);
  assert.notEqual(read.value.value.reference.sha256, read.value.value.file.sha256);
  assert.equal(h.releases(), 0);
  assert.deepEqual(h.finalize(read), read.value);
  assert.equal(h.releases(), 1);
});

test('team_asset runtime: other fixed versions, URL/actor/partial refs and stale agent identity never open bytes', async (t) => {
  const h = await harness(t);
  for (const request of [
    { action: 'read', reference: { ...h.reference, versionId: randomUUID() } },
    { action: 'read', reference: { ...h.reference, sha256: 'b'.repeat(64) } },
    { action: 'read', reference: h.reference, url: 'https://example.org' },
    { action: 'list', actorId: 'another' },
  ]) {
    const result = await h.execute(request);
    assert.equal(result.value.ok, false);
    h.finalize(result);
  }
  const wrong = await h.execute({ action: 'list' }, { agent: { id: h.binding.nativeAgentId } });
  assert.equal(wrong.value.ok, false);
  assert.equal(h.reads(), 0);
});

test('team_asset runtime: revocation before final output discards candidate text and releases the original lease', async (t) => {
  const h = await harness(t);
  const read = await h.execute({ action: 'read', reference: h.reference });
  assert.equal(read.value.ok, true);
  h.deny();
  assert.equal(h.finalize(read).ok, false);
  assert.equal(h.releases(), 1);
});

test('team_asset runtime: output tampering does not become model content', async (t) => {
  const h = await harness(t);
  const read = await h.execute({ action: 'read', reference: h.reference });
  read.value.value.text = 'fabricated';
  assert.equal(h.finalize(read).ok, false);
  assert.equal(h.releases(), 1);
});

test('team_asset runtime: nontext formats and whole-object invalid UTF8 never yield a plausible prefix', async (t) => {
  for (const options of [
    { mediaType: 'application/pdf', bytes: Buffer.from('%PDF-1.7') },
    { bytes: Buffer.from([65, 66, 0xff]) },
  ]) {
    const h = await harness(t, options);
    const read = await h.execute({ action: 'read', reference: h.reference, length: 1 });
    assert.deepEqual(read.value, { ok: false, code: 'unsupported-encoding' });
    assert.equal(h.releases(), 1);
    h.finalize(read);
  }
});

test('team_asset runtime: cancellation returns promptly but original read reservation stays busy until real physical drain', async (t) => {
  const entered = deferred(),
    physical = deferred();
  const h = await harness(t, {
    open(_ref, signal, handle) {
      entered.resolve();
      return {
        result: new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(Error('PRIVATE_ABORT')), { once: true }),
        ),
        drain: physical.promise,
      };
    },
  });
  const abort = new AbortController();
  const reading = h.execute({ action: 'read', reference: h.reference }, { signal: abort.signal });
  await entered.promise;
  abort.abort();
  const cancelled = await reading;
  assert.equal(cancelled.value.code, 'cancelled');
  await assert.rejects(h.sessions.reserveInputRead(h.current), { code: 'input-read-busy' });
  physical.resolve();
  await h.sessions.whenInputReadsIdle(scope);
  const next = await h.execute({ action: 'list' });
  assert.equal(next.value.ok, true);
  h.finalize(next);
  h.finalize(cancelled);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { TeamAssetFileBytes } from '../dist/team-asset-file.js';
import { TeamAssetFileService } from '../dist/team-asset-file-service.js';
async function originalByteComposition(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-team-tool-bytes-')),
    ctx = new Context();
  let service, attachment;
  t.after(async () => {
    await service?.close();
    await attachment?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  attachment = ctx.plugin(LocalAttachmentStore, { dshHome: root });
  await attachment;
  let blocked = false,
    reads = 0,
    releases = 0;
  const provider = {
    saveFileStream: (request) => ctx.attachments.saveFileStream(request),
    async *readFileStream(request) {
      if (blocked) await options.block();
      yield* ctx.attachments.readFileStream(request);
    },
  };
  const carrier = new TeamAssetFileBytes(provider),
    data = Buffer.from('A汉😀BC');
  const declare = {
    name: '固定使用说明.txt',
    mediaType: 'text/plain',
    byteSize: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
  const bytesGrant = { signal: new AbortController().signal, assertCurrent() {} };
  const blob = await carrier.save(
    declare,
    (async function* () {
      yield data;
    })(),
    bytesGrant,
  );
  // Only the original asset authority is a contract; no task/asset facts are
  // fabricated in product storage. Actual bytes/stream verifier are unmodified.
  const authority = {
    reserveFile() {
      throw Error('tool must not upload');
    },
    commitFile() {
      throw Error('tool must not commit');
    },
    abortFile() {
      throw Error('tool must not alter upload facts');
    },
    async readFile(_request, target, signal) {
      reads++;
      assert.equal(target.spaceId, scope.spaceId);
      assert.equal(target.assetId, 'guide');
      return {
        blob: structuredClone(blob),
        grant: {
          signal,
          assertCurrent() {
            signal.throwIfAborted();
          },
        },
        release() {
          releases++;
        },
      };
    },
  };
  service = new TeamAssetFileService(carrier, authority);
  const h = await harness(t, {
    open(ref, signal) {
      return service.openReadTracked(
        { headers: {} },
        { spaceId: ref.spaceId, assetId: ref.assetId, versionId: ref.versionId },
        signal,
      );
    },
  });
  return {
    ...h,
    byteService: service,
    reads: () => reads,
    byteReleases: () => releases,
    block() {
      blocked = true;
    },
    stored: blob,
  };
}

test('team_asset composition: actual original attachment stream crosses service, Run budget and final tool output without task metadata writes', async (t) => {
  const h = await originalByteComposition(t);
  const metadata = await h.execute({ action: 'list' });
  assert.equal(metadata.value.ok, true);
  h.finalize(metadata);
  assert.equal(h.reads(), 0);
  const read = await h.execute({ action: 'read', reference: h.reference, offset: 1, length: 4 });
  assert.equal(read.value.ok, true);
  assert.equal(read.value.value.text, '汉');
  assert.equal(read.value.value.file.sha256, h.stored.sha256);
  assert.notEqual(read.value.value.reference.sha256, h.stored.sha256);
  assert.equal(h.byteReleases(), 0);
  assert.deepEqual(h.finalize(read), read.value);
  await h.byteService.idle();
  assert.equal(h.byteReleases(), 1);
  assert.ok(h.sessions.open(h.current).binding.inputReadBudget.chargedBytes > 0);
});

test('team_asset composition: real tracked byte drain keeps Native reservation and original file lease after a cancelled tool result', async (t) => {
  const entered = deferred(),
    physical = deferred();
  const h = await originalByteComposition(t, {
    block: async () => {
      entered.resolve();
      await physical.promise;
    },
  });
  h.block();
  const abort = new AbortController();
  const reading = h.execute({ action: 'read', reference: h.reference }, { signal: abort.signal });
  await entered.promise;
  abort.abort();
  try {
    const value = await reading;
    assert.equal(value.value.code, 'cancelled');
    await assert.rejects(h.sessions.reserveInputRead(h.current), { code: 'input-read-busy' });
    assert.equal(h.byteReleases(), 0);
    h.finalize(value);
  } finally {
    physical.resolve();
  }
  await h.sessions.whenInputReadsIdle(scope);
  await h.byteService.idle();
  assert.equal(h.byteReleases(), 1);
  const next = await h.execute({ action: 'list' });
  assert.equal(next.value.ok, true);
  h.finalize(next);
});
