import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalPayload, remoteFileValueSchema } from '@zhuma/agent-core';
import { artifactFileReference } from '../dist/artifact-files.js';
import { createMemberLocalOutputFiles } from '../dist/member-local-execution-files.js';

// Port contracts only: real raw HTTP and original SDK publisher are separate
// evidence. These fixtures do not mint device/member/native execution authority.
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
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
      nodeId: 'node',
      runId: randomUUID(),
      generation: 1,
      segmentId: randomUUID(),
    },
    source = {
      scope,
      nativeSessionId: 'original-session',
      nativeAgentId: 'original-agent',
      configurationId: 'configuration',
      expertVersionId: 'builtin-v1',
      toolVersion: 'zhuma-native-output-file@1',
      callId: 'original-tool-call',
    },
    request = {
      source,
      selectorFingerprint: hash({ path: 'out.bin', name: 'out.bin' }),
      name: 'out.bin',
      mode: 'reserve',
      maximumBytes: 64,
    },
    bytes = Buffer.from([0, 255, 1, 254]),
    key = `native-output_${hash(source)}`,
    record = {
      uploadId: randomUUID(),
      attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      name: request.name,
      mediaType: 'application/octet-stream',
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...scope,
      uploadedBy: scope.actorId,
      idempotencyKey: key,
      state: 'completed',
      uploadedAt: '2026-10-28T20:00:00.000Z',
      producer: {
        kind: 'native-run-output',
        version: 1,
        source,
        selectorFingerprint: request.selectorFingerprint,
      },
    };
  // Scope fields outside the actual upload ledger must never be fabricated.
  for (const k of ['actorId', 'runId', 'generation', 'segmentId']) delete record[k];
  const remoteScope = { backendId: randomUUID(), ...scope },
    handle = { value: { scope: remoteScope } },
    complete = () =>
      remoteFileValueSchema.parse({
        scope: remoteScope,
        status: 'completed',
        uploadId: record.uploadId,
        idempotencyKey: key,
        file: artifactFileReference(record),
        record,
      }),
    reservationId = randomUUID(),
    reserved = {
      scope: remoteScope,
      status: 'reserved',
      reservationId,
      maximumBytes: 64,
      idempotencyKey: key,
    },
    grant = {
      scope,
      signal: life.signal,
      assertCurrent(action) {
        life.signal.throwIfAborted();
        seen.push(['grant', action]);
      },
    },
    protocol = {
      async command(run, command, _signal, options) {
        assert.equal(run, handle);
        assert.equal(options.waitForSourceSettlement, true);
        seen.push(['command', structuredClone(command)]);
        if (command.operation === 'file-status') return complete();
        if (command.operation === 'abandon-file') return { ...reserved, status: 'released' };
        return control.completed
          ? complete()
          : command.payload.mode === 'lookup'
            ? { scope: remoteScope, status: 'absent', idempotencyKey: key }
            : reserved;
      },
      async publishFile(run, input, data, signal) {
        assert.equal(run, handle);
        assert.equal(input.reservationId, reservationId);
        const chunks = [];
        for await (const chunk of data) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), bytes);
        seen.push(['raw-publish', signal]);
        await control.publishing?.promise;
        return complete();
      },
    },
    files = createMemberLocalOutputFiles(
      protocol,
      {
        signal: life.signal,
        assertCurrent() {
          assert.fail('remote port must not substitute a local AttachmentStore');
        },
        assertPublication(g, s, selector) {
          assert.equal(g, grant);
          assert.deepEqual(s, source);
          assert.equal(selector, request.selectorFingerprint);
        },
      },
      (g) => {
        assert.equal(g, grant);
        return handle;
      },
      async () => {
        await control.admission?.promise;
      },
    );
  return { files, grant, request, source, seen, control, bytes, record, complete, life };
}
test('member-local files contract: first publication waits the original accepted admission before even lookup', async () => {
  const h = fixture();
  h.control.admission = Promise.withResolvers();
  const pending = h.files.reserve(h.grant, h.request, h.life.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.seen.length, 0);
  h.control.admission.resolve();
  const lease = await pending;
  lease.releaseAfter(Promise.resolve());
  await lease.drain;
});
test('member-local files contract: exact original source key and full ledger; raw bytes are not a JSON field', async () => {
  const h = fixture();
  await assert.rejects(h.files.reserve(h.grant, { ...h.request, mode: 'lookup' }, h.life.signal), {
    code: 'not-found',
  });
  const lease = await h.files.reserve(h.grant, h.request, h.life.signal);
  const result = await lease.publish({
    mediaType: h.record.mediaType,
    byteSize: h.bytes.length,
    sha256: h.record.sha256,
    data: (async function* () {
      yield h.bytes;
    })(),
  });
  assert.deepEqual(result, h.record);
  lease.releaseAfter(Promise.resolve());
  await lease.drain;
  assert.equal(lease.signal.aborted, true);
  const commands = h.seen.filter((x) => x[0] === 'command').map((x) => x[1]);
  assert.equal(commands[1].payload.idempotencyKey, `native-output_${hash(h.source)}`);
  assert.equal(commands.at(-1).operation, 'abandon-file');
  assert(!JSON.stringify(commands).includes('base64'));
});
test('member-local files contract: release waits original FS drain and an uncooperative upload before abandon', async () => {
  const h = fixture(),
    source = Promise.withResolvers();
  h.control.publishing = Promise.withResolvers();
  const lease = await h.files.reserve(h.grant, h.request, h.life.signal);
  const publishing = lease.publish({
    mediaType: h.record.mediaType,
    byteSize: h.bytes.length,
    sha256: h.record.sha256,
    data: (async function* () {
      yield h.bytes;
    })(),
  });
  // Attach rejection before intentionally aborting the original reservation.
  const rejected = assert.rejects(publishing);
  await new Promise((resolve) => setImmediate(resolve));
  lease.releaseAfter(source.promise);
  source.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert(!h.seen.some((x) => x[0] === 'command' && x[1].operation === 'abandon-file'));
  let drained = false;
  void lease.drain.then(() => {
    drained = true;
  });
  assert.equal(drained, false);
  h.control.publishing.resolve();
  await rejected;
  await lease.drain;
  assert.equal(
    h.seen.filter((x) => x[0] === 'command' && x[1].operation === 'abandon-file').length,
    1,
  );
  lease.releaseAfter(Promise.resolve());
  await lease.drain;
});
test('member-local files contract: completed replay/cold status keeps original ledger and performs no FS/upload', async () => {
  const h = fixture();
  h.control.completed = true;
  const lease = await h.files.reserve(h.grant, { ...h.request, mode: 'lookup' }, h.life.signal);
  assert.deepEqual(lease.completed, h.record);
  lease.releaseAfter(Promise.resolve());
  await lease.drain;
  const saved = await h.files.readCompleted(
    h.grant,
    { source: h.source, publicationId: h.record.uploadId },
    h.life.signal,
  );
  assert.deepEqual(saved.record, h.record);
  saved.check();
  saved.record.name = 'mutated.bin';
  assert.throws(() => saved.check(), { code: 'publication-unavailable' });
  saved.record.name = h.record.name;
  saved.check();
  assert(!h.seen.some((x) => x[0] === 'raw-publish'));
  await assert.rejects(
    h.files.readCompleted(
      h.grant,
      { source: { ...h.source, callId: 'other-call' }, publicationId: h.record.uploadId },
      h.life.signal,
    ),
    { code: 'publication-unavailable' },
  );
  h.life.abort();
  assert.throws(() => saved.check());
});
