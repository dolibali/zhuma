import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMemberLocalAcceptedFiles } from '../dist/member-local-execution-accepted-files.js';
import { acceptedInputRef } from '../dist/native-work-session-input-tool.js';
import { describeNativeAcceptedFileTool } from '../dist/native-work-session-files-tool.js';
import { MemberLocalProtocolError } from '../dist/member-local-execution-protocol.js';

// Client/native-port contracts only. A successful file response represents D's
// required original full-object UTF8 qualification, not a synthetic runtime proof.
const sha = (b) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const life = new AbortController(),
    seen = [],
    control = {},
    scope = {
      actorId: 'member',
      spaceId: 'space',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'consume',
      runId: 'run',
      generation: 1,
      segmentId: 'segment',
    },
    input = { sourceNodeId: 'source', artifactVersionId: 'artifact', version: 1 },
    inputRef = acceptedInputRef(scope, input),
    bytes = Buffer.from('固定文件正文。\n'),
    node = {
      taskId: scope.taskId,
      planId: scope.planId,
      revision: scope.revision,
      nodeId: scope.nodeId,
    },
    document = {
      actorId: scope.actorId,
      spaceId: scope.spaceId,
      downstream: node,
      source: { ...node, nodeId: input.sourceNodeId },
      version: { id: input.artifactVersionId, version: 1 },
      content: {
        text: 'File metadata only until file tool invocation.',
        links: [],
        files: [
          {
            id: 'file',
            mediaType: 'text/plain',
            byteSize: bytes.length,
            checksum: sha(bytes),
            accessPolicyId: 'space:space',
            uploadComplete: true,
          },
        ],
      },
    },
    docBytes = Buffer.from(JSON.stringify(document)),
    slots = [
      {
        slotId: 'text-slot',
        kind: 'text',
        name: 'fixed-input',
        sourceNodeId: 'source',
        artifactVersionId: 'artifact',
        byteSize: docBytes.length,
        sha256: sha(docBytes),
      },
      {
        slotId: 'file-slot',
        kind: 'file',
        fileId: 'file',
        name: 'result.md',
        sourceNodeId: 'source',
        artifactVersionId: 'artifact',
        resourceRef: { id: inputRef, version: 'artifact' },
        byteSize: bytes.length,
        sha256: sha(bytes),
      },
    ],
    remoteScope = { backendId: 'backend', ...scope },
    run = {
      value: { scope: remoteScope, shared: { inputs: slots } },
      composition: {
        schemaVersion: 2,
        payload: { scope, inputs: [input], acceptedFileReader: describeNativeAcceptedFileTool() },
      },
    },
    grant = {
      scope,
      signal: life.signal,
      assertCurrent() {
        life.signal.throwIfAborted();
      },
    },
    binding = { scope, nativeSessionId: 'original-session', nativeAgentId: 'original-agent' },
    protocol = {
      async command(actual, command, signal, options) {
        assert.equal(actual, run);
        assert.equal(options.waitForSourceSettlement, true);
        signal.throwIfAborted();
        seen.push(structuredClone(command));
        if (control.denied) throw Error('current membership denied');
        if (command.operation === 'input-list')
          return { scope: remoteScope, items: structuredClone(slots) };
        const q = command.payload,
          isFile = q.slotId === 'file-slot',
          content = isFile ? bytes : docBytes,
          selected = content.subarray(
            q.offset,
            Math.min(q.offset + q.maximumBytes, content.length),
          );
        if (isFile && control.pending) await control.pending.promise;
        if (isFile && control.unsupported)
          throw new MemberLocalProtocolError('remote-protocol-unsupported');
        const page = {
          scope: remoteScope,
          slotId: q.slotId,
          offset: q.offset,
          byteSize: selected.length,
          totalBytes: content.length,
          sha256: sha(content),
          base64: selected.toString('base64'),
          eof: q.offset + selected.length === content.length,
        };
        return isFile && control.corrupt ? { ...page, offset: page.offset + 1 } : page;
      },
    };
  return {
    life,
    seen,
    control,
    scope,
    inputRef,
    bytes,
    slots,
    grant,
    binding,
    protocol,
    run,
    open: () =>
      createMemberLocalAcceptedFiles(binding, grant, protocol, run, async () => {
        await control.admission?.promise;
      }),
  };
}
test('member-local accepted-file contract: registration metadata only, original input handle/metadata and bounded actual bytes', async () => {
  const h = fixture(),
    reader = await h.open();
  assert.deepEqual(
    h.seen.map((x) => x.operation),
    ['input-list'],
  );
  const list = await reader.list(h.grant, { inputRef: h.inputRef }, h.life.signal);
  assert.equal(list.files[0].fileId, 'file');
  assert.equal(list.files[0].mediaType, 'text/plain');
  assert.equal(
    h.seen.filter((x) => x.operation === 'input-read' && x.payload.slotId === 'file-slot').length,
    0,
  );
  const page = await reader.read(
    h.grant,
    { inputRef: h.inputRef, fileId: 'file', offset: 0, length: 8192 },
    h.life.signal,
  );
  assert.deepEqual(page.bytes, h.bytes);
  assert.equal(page.encoding, 'utf-8');
  assert.equal(page.range.total, h.bytes.length);
  page.check();
  page.bytes[0] ^= 1;
  assert.throws(() => page.check());
  page.release();
  assert.throws(() => page.check());
});
test('member-local accepted-file contract: first tool waits original admission while registration remains metadata-only', async () => {
  const h = fixture();
  h.control.admission = Promise.withResolvers();
  const reader = await h.open(),
    cut = h.seen.length;
  const waiting = reader.list(h.grant, { inputRef: h.inputRef }, h.life.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.seen.length, cut);
  h.control.admission.resolve();
  await waiting;
});
test('member-local accepted-file contract: stale version/resource binding, corrupt range and revoked member fail closed', async () => {
  const invalid = fixture();
  invalid.slots[1].resourceRef.version = 'latest';
  await assert.rejects(invalid.open());
  const h = fixture(),
    reader = await h.open();
  await assert.rejects(
    reader.list(h.grant, { inputRef: 'input_' + 'f'.repeat(64) }, h.life.signal),
  );
  await assert.rejects(
    reader.read(
      h.grant,
      { inputRef: h.inputRef, fileId: 'other-file', offset: 0, length: 1 },
      h.life.signal,
    ),
  );
  h.control.corrupt = true;
  await assert.rejects(
    reader.read(
      h.grant,
      { inputRef: h.inputRef, fileId: 'file', offset: 0, length: 8192 },
      h.life.signal,
    ),
  );
  h.control.corrupt = false;
  h.control.unsupported = true;
  await assert.rejects(
    reader.read(
      h.grant,
      { inputRef: h.inputRef, fileId: 'file', offset: 0, length: 8192 },
      h.life.signal,
    ),
    { code: 'unsupported-encoding' },
  );
  h.control.unsupported = false;
  h.control.denied = true;
  await assert.rejects(reader.list(h.grant, { inputRef: h.inputRef }, h.life.signal));
});
test('member-local accepted-file contract: original read job is retained after cancellation until uncooperative remote source settles', async () => {
  const h = fixture(),
    reader = await h.open(),
    abort = new AbortController();
  h.control.pending = Promise.withResolvers();
  const work = reader.read(
    h.grant,
    { inputRef: h.inputRef, fileId: 'file', offset: 0, length: 8192 },
    abort.signal,
  );
  const rejected = assert.rejects(work);
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!h.seen.some((x) => x.operation === 'input-read' && x.payload.slotId === 'file-slot'))
    await new Promise((r) => setImmediate(r));
  abort.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  h.control.pending.resolve();
  await rejected;
});
