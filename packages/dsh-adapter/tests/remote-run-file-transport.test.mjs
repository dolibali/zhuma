/** Framing/reader contracts only. No file authorization, ledger or SDK drain proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_RUN_LIMITS } from '@zhuma/agent-core';
import {
  encodeRemoteRunUploadPrefix,
  RemoteRunUploadReader,
  REMOTE_RUN_UPLOAD_TAIL_BYTES,
} from '../dist/remote-run-file-transport.js';
import { publicationEnvelope } from './remote-run-file-transport-fixture.mjs';
const wait = () => new Promise(setImmediate);
const frame = (raw) => {
  const bytes = Buffer.from(JSON.stringify(raw)),
    size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([size, bytes]);
};
const chunks = (values) =>
  new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
test('publish frame retains original signed metadata, Unicode and exact raw bytes across split/coalesced boundaries', async () => {
  const bytes = Buffer.from([0, 255, 128, 10, 13]),
    envelope = publicationEnvelope(bytes);
  const prefix = encodeRemoteRunUploadPrefix(envelope),
    metadata = JSON.parse(Buffer.from(prefix).subarray(4).toString('utf8'));
  assert.deepEqual(metadata, envelope);
  assert.equal(Buffer.from(prefix).readUInt32BE(), prefix.byteLength - 4);
  for (const split of [1, 3, 4, 17, prefix.byteLength - 1, prefix.byteLength + 2]) {
    const all = Buffer.concat([prefix, bytes]);
    const reader = new RemoteRunUploadReader(
      chunks([all.subarray(0, split), all.subarray(split)]),
      new AbortController().signal,
    );
    assert.deepEqual(await reader.metadata(), envelope);
    const actual = [];
    for await (const value of reader.data) actual.push(value);
    assert.deepEqual(Buffer.concat(actual), bytes);
    await reader.close();
  }
});
test('frame rejects malformed/truncated/over-budget metadata, UTF8 and wrong method/operation/mode', async () => {
  const envelope = publicationEnvelope();
  for (const raw of [
    { ...envelope, method: 'zhuma-remote-run/info' },
    { ...envelope, payload: { ...envelope.payload, operation: 'info', payload: {} } },
    {
      ...envelope,
      payload: { ...envelope.payload, payload: { ...envelope.payload.payload, mode: 'reserve' } },
    },
  ]) {
    assert.throws(() => encodeRemoteRunUploadPrefix(raw), { status: 400 });
    const reader = new RemoteRunUploadReader(chunks([frame(raw)]), new AbortController().signal);
    await assert.rejects(reader.metadata(), { status: 400 });
    await reader.close();
  }
  const huge = Buffer.alloc(4);
  huge.writeUInt32BE(REMOTE_RUN_LIMITS.requestBytes + 1);
  for (const [value, status] of [
    [Buffer.alloc(4), 400],
    [huge, 413],
    [Buffer.from([0, 0]), 400],
    [Buffer.from([0, 0, 0, 1, 255]), 400],
  ]) {
    const reader = new RemoteRunUploadReader(chunks([value]), new AbortController().signal);
    await assert.rejects(reader.metadata(), { status });
    await reader.close();
  }
  assert.throws(
    () =>
      encodeRemoteRunUploadPrefix({
        ...envelope,
        rpcId: 'x'.repeat(REMOTE_RUN_LIMITS.requestBytes),
      }),
    { status: 413 },
  );
});
test('metadata parser never aggregates a file: its same-chunk retained tail is bounded', async () => {
  const prefix = encodeRemoteRunUploadPrefix(publicationEnvelope());
  const reader = new RemoteRunUploadReader(
    chunks([Buffer.concat([prefix, Buffer.alloc(REMOTE_RUN_UPLOAD_TAIL_BYTES + 1)])]),
    new AbortController().signal,
  );
  await assert.rejects(reader.metadata(), { status: 413 });
  await reader.close();
});
test('metadata timeout permits an HTTP error reply before closing its pending source', async () => {
  let cancelled = 0;
  const stream = new ReadableStream({
    pull: () => new Promise(() => {}),
    cancel: () => {
      cancelled++;
    },
  });
  const reader = new RemoteRunUploadReader(stream, new AbortController().signal);
  await assert.rejects(reader.metadata(10), { status: 408 });
  assert.equal(cancelled, 0);
  await reader.close();
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});
for (const action of ['abort', 'return']) {
  test(`pending raw next can be ${action === 'abort' ? 'aborted' : 'returned'} immediately`, async () => {
    let cancelled = 0;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeRemoteRunUploadPrefix(publicationEnvelope()));
      },
      cancel() {
        cancelled++;
      },
    });
    const abort = new AbortController(),
      reader = new RemoteRunUploadReader(stream, abort.signal);
    await reader.metadata();
    const pending = reader.data.next();
    const observed = action === 'abort' ? assert.rejects(pending, { name: 'AbortError' }) : pending;
    await wait();
    if (action === 'abort') abort.abort();
    else await reader.data.return();
    await observed;
    await reader.close();
    assert.equal(cancelled, 1);
    assert.equal(stream.locked, false);
  });
}
