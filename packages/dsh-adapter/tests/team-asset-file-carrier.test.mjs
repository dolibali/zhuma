/** Byte-proof and original Native budget contracts only; no remote producer,
 * provider, AgentLoop, GUI or consume-time distributed authorization proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  createVerifiedTeamAssetFile,
  verifiedTeamAssetFileInfo,
  readVerifiedTeamAssetText,
} from '../dist/team-asset-file-carrier.js';
import { registerTeamAssetFileTool } from '../dist/team-asset-file-tool.js';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { grant, message, scope } from './native-work-session-fixture.mjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileFor = (bytes) => ({
  name: 'Fixed guide.txt',
  mediaType: 'text/plain',
  byteSize: bytes.length,
  sha256: digest(bytes),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('verified carrier: private defensive copy and opaque identity prevent later mutation or forged proofs', () => {
  const input = Buffer.from('A汉😀BC'),
    file = fileFor(input);
  const carrier = createVerifiedTeamAssetFile(file, input);
  const original = structuredClone(file);
  input.fill(0);
  file.name = 'changed.txt';
  file.sha256 = '0'.repeat(64);
  const info = verifiedTeamAssetFileInfo(carrier);
  assert.deepEqual(info, original);
  info.name = 'other.txt';
  assert.deepEqual(verifiedTeamAssetFileInfo(carrier), original);
  assert.equal(Object.isFrozen(carrier), true);
  assert.deepEqual(Object.keys(carrier).sort(), ['byteSize', 'kind', 'sha256']);
  assert.equal(carrier.bytes, undefined);
  assert.equal(readVerifiedTeamAssetText(carrier, { offset: 1, length: 4 }).text, '汉');
  for (const forged of [{ ...carrier }, structuredClone(carrier), undefined]) {
    assert.throws(() => verifiedTeamAssetFileInfo(forged), { code: 'invalid' });
    assert.throws(() => readVerifiedTeamAssetText(forged, { offset: 0, length: 1 }), {
      code: 'invalid',
    });
  }
});

test('verified carrier: exact length/digest and original 20MiB limit are checked before accepting bytes', () => {
  const bytes = Buffer.from('bytes'),
    file = fileFor(bytes);
  assert.throws(() => createVerifiedTeamAssetFile({ ...file, byteSize: 4 }, bytes), {
    code: 'digest-mismatch',
  });
  assert.throws(() => createVerifiedTeamAssetFile({ ...file, sha256: 'f'.repeat(64) }, bytes), {
    code: 'digest-mismatch',
  });
  assert.throws(
    () => createVerifiedTeamAssetFile({ ...file, byteSize: 20 * 1024 * 1024 + 1 }, bytes),
    { code: 'invalid' },
  );
  assert.throws(() => createVerifiedTeamAssetFile(file, Array.from(bytes)), { code: 'invalid' });
});

test('verified carrier: whole UTF8 validates across 64KiB boundary, invalid tail cannot yield plausible prefix', () => {
  const valid = Buffer.concat([Buffer.alloc(65535, 65), Buffer.from('😀汉')]);
  const carrier = createVerifiedTeamAssetFile(fileFor(valid), valid);
  assert.equal(readVerifiedTeamAssetText(carrier, { offset: 65535, length: 4 }).text, '😀');
  const invalid = Buffer.concat([Buffer.alloc(65535, 65), Buffer.from([0xf0, 0x9f, 0x98])]);
  const bad = createVerifiedTeamAssetFile(fileFor(invalid), invalid);
  assert.throws(() => readVerifiedTeamAssetText(bad, { offset: 0, length: 1 }), {
    code: 'unsupported',
  });
});

test('verified carrier: bounded byte ranges respect UTF8 starts/ends, EOF, BOM and empty files', () => {
  const bytes = Buffer.from('A汉😀BC'),
    carrier = createVerifiedTeamAssetFile(fileFor(bytes), bytes);
  assert.deepEqual(readVerifiedTeamAssetText(carrier, { offset: 1, length: 4 }), {
    text: '汉',
    offset: 1,
    length: 3,
    nextOffset: 4,
    totalBytes: bytes.length,
  });
  for (const range of [
    { offset: 2, length: 8 },
    { offset: 4, length: 3 },
    { offset: 100, length: 1 },
    { offset: 0, length: 8193 },
    { offset: 0, length: 0 },
    { offset: -1, length: 1 },
  ])
    assert.throws(() => readVerifiedTeamAssetText(carrier, range), { code: 'invalid' });
  assert.equal(readVerifiedTeamAssetText(carrier, { offset: bytes.length, length: 1 }).length, 0);
  const empty = Buffer.alloc(0);
  assert.equal(
    readVerifiedTeamAssetText(createVerifiedTeamAssetFile(fileFor(empty), empty), {
      offset: 0,
      length: 1,
    }).text,
    '',
  );
  const bom = Buffer.from('\ufeffA');
  assert.equal(
    readVerifiedTeamAssetText(createVerifiedTeamAssetFile(fileFor(bom), bom), {
      offset: 0,
      length: 4,
    }).text,
    '\ufeffA',
  );
});

async function harness(t, options = {}) {
  let record,
    definition,
    cleanup,
    denied = false,
    releases = 0,
    checks = 0,
    reads = 0;
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
      send() {},
      flush: async () => {},
      stop: async () => 'stopped',
    },
  );
  const current = grant();
  await sessions.send(current, message('start', 'carrier contract'));
  const binding = sessions.open(current).binding,
    agent = { id: binding.nativeAgentId };
  const bytes = Buffer.from('A汉😀BC'),
    file = fileFor(bytes);
  const reference = {
    spaceId: scope.spaceId,
    assetId: 'guide',
    kind: 'file',
    versionId: randomUUID(),
    sha256: 'a'.repeat(64),
  };
  const carrier = createVerifiedTeamAssetFile(file, bytes);
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
  const ports = {
    catalog: { scope, files: [{ reference, file }] },
    signal: new AbortController().signal,
    async assertCurrent(signal, ref) {
      checks++;
      signal.throwIfAborted();
      if (denied) throw Error('PRIVATE_REVOKED');
      if (ref) assert.deepEqual(ref, reference);
      await options.gate?.(ref);
    },
    openFile(ref, signal) {
      reads++;
      assert.deepEqual(ref, reference);
      const handle = {
        file,
        carrier,
        signal,
        check() {
          signal.throwIfAborted();
          if (denied) throw Error('PRIVATE_REVOKED');
        },
        release() {
          releases++;
        },
      };
      return (
        options.open?.(handle) ?? { result: Promise.resolve(handle), drain: Promise.resolve() }
      );
    },
  };
  registerTeamAssetFileTool(ctx, binding, current, sessions, ports);
  t.after(async () => {
    await cleanup();
  });
  return {
    reference,
    carrier,
    file,
    sessions,
    current,
    deny() {
      denied = true;
    },
    releases: () => releases,
    checks: () => checks,
    reads: () => reads,
    async execute(patch = {}) {
      const exec = {
        agent,
        token: Symbol('carrier'),
        signal: new AbortController().signal,
        ...patch,
      };
      return {
        exec,
        value: await definition.execute(
          { request: { action: 'read', reference, offset: 1, length: 4 } },
          exec,
        ),
      };
    },
    finalize({ exec, value }) {
      return JSON.parse(definition.finalizeContent(exec, { isError: false, value })[0].text);
    },
  };
}

test('carrier tool: selected ref is remotely rechecked after real drain, Native budget and file lease survive until their actual boundaries', async (t) => {
  const physical = deferred(),
    entered = deferred();
  const refs = [];
  const h = await harness(t, {
    open(handle) {
      entered.resolve();
      return { result: Promise.resolve(handle), drain: physical.promise };
    },
    gate(ref) {
      refs.push(ref);
    },
  });
  let finished = false;
  const pending = h.execute().then((value) => {
    finished = true;
    return value;
  });
  await entered.promise;
  await tick();
  assert.equal(finished, false);
  assert.deepEqual(refs, [undefined]);
  await assert.rejects(h.sessions.reserveInputRead(h.current), { code: 'input-read-busy' });
  assert.equal(h.releases(), 0);
  physical.resolve();
  const read = await pending;
  assert.equal(read.value.ok, true);
  assert.equal(read.value.value.text, '汉');
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[1], h.reference);
  assert.equal(h.releases(), 0);
  assert.deepEqual(h.finalize(read), read.value);
  assert.equal(h.releases(), 1);
});

test('carrier tool: a byte proof never skips fresh Run gates or synchronous final authorization', async (t) => {
  const h = await harness(t);
  const first = await h.execute();
  assert.equal(first.value.ok, true);
  assert.equal(h.checks(), 2);
  h.deny();
  assert.equal(h.finalize(first).ok, false);
  assert.equal(h.releases(), 1);
  const after = await h.execute();
  assert.equal(after.value.ok, false);
  assert.equal(h.reads(), 1);
  h.finalize(after);
});

test('carrier tool: forged proof, mismatching metadata or ambiguous raw+carrier handle cannot become content', async (t) => {
  for (const patch of [
    (h) => ({ ...h, carrier: { ...h.carrier } }),
    (h) => ({ ...h, file: { ...h.file, name: 'wrong.txt' } }),
    (h) => ({ ...h, bytes: Buffer.from('A汉😀BC') }),
  ]) {
    const h = await harness(t, {
      open(handle) {
        return { result: Promise.resolve(patch(handle)), drain: Promise.resolve() };
      },
    });
    const read = await h.execute();
    assert.equal(read.value.ok, false);
    assert.equal(h.releases(), 1);
    h.finalize(read);
  }
});
