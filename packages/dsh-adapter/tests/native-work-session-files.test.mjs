/** Actual Cookie, member/Run issuer, SDK bytes and JSON. No model or native factory drive. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootRunFiles,
  describeNativeAcceptedFileTool,
} from './native-work-session-files-fixture.mjs';
import { runFileEncoding } from '../dist/native-work-session-files-contract.js';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-run-files-'));
  const h = await bootRunFiles(root, options);
  t.after(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await h.upload('V1 original fixed bytes');
  await h.submit(first, 'file-v1');
  await h.ballot('request-changes', 'return-v1');
  const second = await h.upload('V2 accepted fixed bytes');
  await h.submit(second, 'file-v2');
  await h.ballot('approve', 'accept-v2');
  const opened = await h.begin();
  t.after(() => opened.dispose());
  let reads = 0;
  const read = h.ctx.attachments.readFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.readFileStream = (...args) => {
    reads++;
    return read(...args);
  };
  const facts = () =>
    JSON.stringify(
      ['zhuma_execution', 'zhuma_files'].map((name) => {
        const domain = h.ctx.storageDomain.get(name);
        return {
          global: domain.global.get(),
          nodes: [...domain.table(name === 'zhuma_files' ? 'files' : 'nodes').entries()],
        };
      }),
    );
  return {
    ...h,
    opened,
    first,
    second,
    reads: () => reads,
    facts,
    inputRef: h.snapshot.payload.contextRefs[0],
  };
}

test('actual expert/Cookie Run with an old text-only input tool cannot acquire fixed-file capability', async (t) => {
  const h = await setup(t);
  assert.equal(h.row('expert').handoff.assignee.kind, 'expert');
  assert.equal(h.opened.grant.scope.actorId, 'chen');
  const before = h.facts();
  await assert.rejects(
    h.reader.list(h.opened.grant, { inputRef: h.inputRef }, h.opened.grant.signal),
    { code: 'not-found' },
  );
  await assert.rejects(
    h.reader.read(
      h.opened.grant,
      {
        inputRef: h.inputRef,
        fileId: h.second.uploadId,
        offset: 0,
        length: 10,
      },
      h.opened.grant.signal,
    ),
    { code: 'not-found' },
  );
  assert.equal(h.reads(), 0);
  assert.equal(h.facts(), before);
  assert.equal(h.adapter.requests.length, 0);
});

test('original Cookie-issued expert Run lists only accepted V2 and reads exact owned bytes without business/file writes', async (t) => {
  const h = await setup(t, { acceptedFiles: true });
  const { grant } = h.opened;
  const before = h.facts();
  const list = await h.reader.list(grant, { inputRef: h.inputRef }, grant.signal);
  assert.equal(list.version, 2);
  assert.equal(list.sourceNodeId, 'source');
  assert.equal(list.artifactVersionId, h.row('source').acceptedArtifactVersionId);
  assert.deepEqual(list.scope, grant.scope);
  assert.equal(list.files.length, 1);
  assert.equal(list.files[0].fileId, h.second.uploadId);
  assert.equal(
    list.files[0].sha256,
    createHash('sha256').update(h.second.originalBytes).digest('hex'),
  );
  assert.equal(h.reads(), 0, 'A catalog is not proof of reading SDK bytes');
  list.check();
  list.files[0].name = 'changed by consumer';
  list.scope.actorId = 'changed by consumer';
  const fresh = await h.reader.list(grant, { inputRef: h.inputRef }, grant.signal);
  assert.equal(fresh.files[0].name, 'fixed.txt');
  assert.equal(fresh.scope.actorId, 'chen');
  const page = await h.reader.read(
    grant,
    { inputRef: h.inputRef, fileId: h.second.uploadId, offset: 3, length: 9 },
    grant.signal,
  );
  assert.deepEqual(Buffer.from(page.bytes), h.second.originalBytes.subarray(3, 12));
  assert.deepEqual(page.range, { offset: 3, length: 9, total: h.second.originalBytes.length });
  assert.equal(page.source.version, 2);
  assert.equal(page.source.file.fileId, h.second.uploadId);
  assert.equal(page.encoding, 'utf-8');
  page.check();
  page.release();
  assert.throws(() => page.check(), { code: 'cancelled' });
  assert.equal(h.reads(), 1);
  assert.equal(h.facts(), before);
  assert.equal(h.adapter.requests.length, 0);
});

test('old file/ref, extra authority fields and out-of-file range reject before SDK reads or writes', async (t) => {
  const h = await setup(t, { acceptedFiles: true });
  const { grant } = h.opened;
  const before = h.facts();
  const base = { inputRef: h.inputRef, fileId: h.second.uploadId, offset: 0, length: 4 };
  for (const [query, code] of [
    [{ ...base, fileId: h.first.uploadId }, 'not-found'],
    [{ ...base, inputRef: `input_${'0'.repeat(64)}` }, 'not-found'],
    [{ ...base, scope: grant.scope }, 'invalid-request'],
    [{ ...base, offset: h.second.originalBytes.length + 1 }, 'invalid-request'],
    [{ ...base, offset: -1 }, 'invalid-request'],
  ])
    await assert.rejects(h.reader.read(grant, query, grant.signal), { code });
  assert.equal(h.reads(), 0);
  assert.equal(h.facts(), before);
});

for (const action of ['stop', 'revoke'])
  test(`actual ${action} invalidates already-returned source checks and prevents further SDK reads`, async (t) => {
    const h = await setup(t, { acceptedFiles: true });
    const { grant } = h.opened;
    const list = await h.reader.list(grant, { inputRef: h.inputRef }, grant.signal);
    const page = await h.reader.read(
      grant,
      { inputRef: h.inputRef, fileId: h.second.uploadId, offset: 0, length: 4 },
      grant.signal,
    );
    await h[action]();
    const before = h.facts();
    assert.throws(() => list.check());
    assert.throws(() => page.check());
    await assert.rejects(
      h.reader.read(
        grant,
        { inputRef: h.inputRef, fileId: h.second.uploadId, offset: 0, length: 4 },
        grant.signal,
      ),
    );
    page.release();
    assert.equal(h.reads(), 1);
    assert.equal(h.facts(), before);
  });

for (const fault of ['missing', 'corrupt'])
  test(`actual SDK ${fault} accepted object cannot expose even its first requested byte`, async (t) => {
    const h = await setup(t, { acceptedFiles: true });
    const record = h.ctx.storageDomain.get('zhuma_files').table('files').get(h.second.uploadId);
    const path = join(
      h.root,
      'attachments',
      'v1',
      'files',
      record.sha256.slice(0, 2),
      record.sha256,
      record.name,
    );
    if (fault === 'missing') await rm(path);
    else {
      await rm(path);
      await writeFile(path, Buffer.alloc(record.byteSize, 0x78));
    }
    const before = h.facts();
    await assert.rejects(
      h.reader.read(
        h.opened.grant,
        { inputRef: h.inputRef, fileId: h.second.uploadId, offset: 0, length: 1 },
        h.opened.grant.signal,
      ),
    );
    assert.equal(h.reads(), 1);
    assert.equal(h.facts(), before);
  });

test('source tuple and ledger mismatch refuse before SDK I/O, and a prior list checks the current accepted source again', async (t) => {
  const h = await setup(t, { acceptedFiles: true });
  const { grant } = h.opened;
  const table = h.ctx.storageDomain.get('zhuma_files').table('files');
  const record = table.get(h.second.uploadId);
  for (const change of [
    { spaceId: 'different-space' },
    { taskId: 'different-task' },
    { planId: 'different-plan' },
    { revision: record.revision + 1 },
    { nodeId: 'different-source' },
    { sha256: '0'.repeat(64) },
    { byteSize: record.byteSize + 1 },
    { mediaType: 'application/json' },
    { state: 'abandoned' },
  ]) {
    await table.put(record.uploadId, { ...record, ...change });
    const before = h.facts();
    await assert.rejects(
      h.reader.read(
        grant,
        { inputRef: h.inputRef, fileId: record.uploadId, offset: 0, length: 1 },
        grant.signal,
      ),
      { code: 'not-found' },
    );
    assert.equal(h.reads(), 0);
    assert.equal(h.facts(), before);
    await table.put(record.uploadId, record);
  }
  const list = await h.reader.list(grant, { inputRef: h.inputRef }, grant.signal);
  const nodes = h.ctx.storageDomain.get('zhuma_execution').table('nodes');
  const [key, source] = [...nodes.entries()].find(([, value]) => value.nodeId === 'source');
  await nodes.put(key, { ...source, acceptedArtifactVersionId: source.artifactVersions[0].id });
  const before = h.facts();
  assert.throws(() => list.check(), { code: 'not-found' });
  await assert.rejects(h.reader.list(grant, { inputRef: h.inputRef }, grant.signal), {
    code: 'not-found',
  });
  assert.equal(h.reads(), 0);
  assert.equal(h.facts(), before);
});

test('new process-local issuer reads the same persisted accepted V2 and SDK bytes after reopening storage', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-run-files-reopen-'));
  let h = await bootRunFiles(root, { acceptedFiles: true });
  t.after(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  const rejected = await h.upload('Rejected durable V1 bytes.');
  await h.submit(rejected, 'durable-old-file');
  await h.ballot('request-changes', 'durable-return');
  const file = await h.upload('Durable accepted V2 bytes.');
  await h.submit(file, 'durable-file');
  await h.ballot('approve', 'durable-approve');
  const first = await h.begin();
  const ref = h.snapshot.payload.contextRefs[0];
  const id = h.row('source').acceptedArtifactVersionId;
  first.dispose();
  await h.close();
  h = await bootRunFiles(root, { first: false });
  const current = await h.openExisting();
  t.after(() => current.dispose());
  const list = await h.reader.list(current.grant, { inputRef: ref }, current.grant.signal);
  assert.equal(list.version, 2);
  assert.equal(list.artifactVersionId, id);
  assert.equal(list.files[0].fileId, file.uploadId);
  const page = await h.reader.read(
    current.grant,
    { inputRef: ref, fileId: file.uploadId, offset: 0, length: 16384 },
    current.grant.signal,
  );
  assert.deepEqual(Buffer.from(page.bytes), file.originalBytes);
  page.release();
  assert.equal(h.adapter.requests.length, 0);
});

test('Run file factory and operations reject fake issuer/grant objects before any SDK read or fact write', async (t) => {
  const h = await setup(t);
  const before = h.facts();
  let fakeCalls = 0;
  assert.throws(
    () =>
      h.execution.createRunAcceptedFiles(
        {
          assertGrant() {
            fakeCalls++;
          },
        },
        {
          signal: new AbortController().signal,
          assertCurrent() {},
        },
      ),
    { code: 'unavailable' },
  );
  const fake = {
    ...h.opened.grant,
    assertCurrent() {
      fakeCalls++;
    },
  };
  await assert.rejects(h.reader.list(fake, { inputRef: h.inputRef }, fake.signal), {
    code: 'run-authority-denied',
  });
  assert.equal(fakeCalls, 0, 'Only the original issuer WeakSet may admit this grant');
  assert.equal(h.reads(), 0);
  assert.equal(h.facts(), before);
});

test('same-team nonparticipant Cookie cannot issue the expert Run capability', async (t) => {
  const h = await setup(t);
  const before = h.facts();
  await assert.rejects(
    h.issuer.open(h.requests.outside, { ...h.locate('expert'), runId: 'file-run' }, 'drive'),
    { code: 'run-authority-denied' },
  );
  assert.equal(h.reads(), 0);
  assert.equal(h.facts(), before);
});

test('native file descriptor is a pure owned copy with separate list/range arguments and no credential/path inputs', () => {
  const first = describeNativeAcceptedFileTool();
  const original = JSON.stringify(first);
  assert.equal(first.name, 'read_accepted_file');
  assert.equal(first.sourceVersion, 'zhuma-accepted-files@2');
  assert.equal(first.parameters.type, 'object');
  assert.deepEqual(first.parameters.required, ['inputRef', 'part']);
  assert.equal(first.parameters.properties.offset.default, 0);
  assert.equal(first.parameters.properties.length.default, 4096);
  assert.deepEqual(first.parameters.properties.part.enum, ['files', 'file']);
  for (const secret of ['scope', 'path', 'cookie'])
    assert.equal(Object.hasOwn(first.parameters.properties, secret), false);
  first.parameters.properties.part.enum.length = 0;
  assert.equal(JSON.stringify(describeNativeAcceptedFileTool()), original);
});

test('encoding contracts never label binary or PDF/image content as UTF-8 text', () => {
  const info = {
    fileId: 'file',
    name: 'report.txt',
    mediaType: 'text/plain',
    bytes: 1,
    sha256: '0'.repeat(64),
  };
  assert.equal(runFileEncoding(info, Buffer.from('可准确解码的正文')), 'utf-8');
  for (const bytes of [Buffer.from('%PDF-1.7'), Buffer.from([0xff, 0xfe]), Buffer.from('a\0b')])
    assert.equal(runFileEncoding(info, bytes), 'binary');
  assert.equal(runFileEncoding({ ...info, name: 'report.pdf' }, Buffer.from('ASCII')), 'binary');
  assert.equal(
    runFileEncoding({ ...info, mediaType: 'image/png' }, Buffer.from('ASCII')),
    'binary',
  );
});
