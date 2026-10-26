/** Actual Cookie, member/Run issuer, SDK bytes and JSON. No model or native factory drive. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootRunFiles,
  describeNativeAcceptedFileTool,
} from './native-work-session-files-fixture.mjs';
import { runFileEncoding } from '../dist/native-work-session-files-contract.js';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-run-files-'));
  const h = await bootRunFiles(root);
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
  assert.equal(first.sourceVersion, 'zhuma-accepted-files@1');
  assert.equal(first.parameters.type, 'object');
  assert.equal(first.parameters.oneOf.length, 2);
  for (const variant of first.parameters.oneOf)
    assert.equal(
      Object.hasOwn(variant.properties, 'scope') ||
        Object.hasOwn(variant.properties, 'path') ||
        Object.hasOwn(variant.properties, 'cookie'),
      false,
    );
  first.parameters.oneOf.length = 0;
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
