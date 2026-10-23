import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkbenchBody } from '../dist/workbench-http.js';

function request(chunks, headers = {}) {
  return new Request('http://localhost/api/zhuma/command', {
    method: 'POST',
    headers,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: 'half',
  });
}
const limits = { bodyBytes: 64, bodyTimeoutMs: 1000 };

test('HTTP body budget counts UTF-8 bytes across chunks, preserving complete text', async () => {
  const text = JSON.stringify({ name: '项目' }),
    bytes = new TextEncoder().encode(text);
  assert.deepEqual(
    await readWorkbenchBody(request([bytes.slice(0, 11), bytes.slice(11)]), limits),
    { name: '项目' },
  );
  await assert.rejects(
    readWorkbenchBody(request([bytes]), { ...limits, bodyBytes: bytes.length - 1 }),
    { status: 413 },
  );
});

test('HTTP body admission rejects declared overflow before reader acquisition and rejects malformed UTF-8/JSON', async () => {
  let reads = 0;
  const oversized = request([], { 'content-length': '65' });
  Object.defineProperty(oversized, 'body', {
    get() {
      reads++;
      throw Error('No reader should be acquired');
    },
  });
  await assert.rejects(readWorkbenchBody(oversized, limits), { status: 413 });
  assert.equal(reads, 0);
  for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode('{')])
    await assert.rejects(readWorkbenchBody(request([bytes]), limits), { status: 400 });
});
