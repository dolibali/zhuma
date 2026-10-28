import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { REMOTE_RUN_PERMIT_HEADER } from '@zhuma/agent-core';
import { MemberLocalExecutionClient } from '../dist/member-local-execution-client.js';
import {
  REMOTE_RUN_UPLOAD_MEDIA_TYPE,
  REMOTE_RUN_UPLOAD_METHOD,
  RemoteRunUploadReader,
} from '../dist/remote-run-file-transport.js';

// Real outgoing Node HTTP / original A framing. Device/Run authorization and
// replies here are contracts; production two-Host SDK evidence is separate.
async function host(t, handler) {
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
function request() {
  return {
    protocolVersion: 1,
    operation: 'publish-file',
    requestId: randomUUID(),
    backendId: randomUUID(),
    deviceId: randomUUID(),
    proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
    payload: {
      mode: 'publish',
      scope: {
        backendId: randomUUID(),
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
      permit: { id: randomUUID(), sha256: 'a'.repeat(64) },
      reservationId: randomUUID(),
      declare: {
        name: '原始文件.bin',
        mediaType: 'application/octet-stream',
        byteSize: 200000,
        sha256: 'b'.repeat(64),
      },
    },
  };
}
test('member-local file HTTP: original A prefix + raw binary source, private permit and member auth stay separate', async (t) => {
  const expected = Buffer.alloc(200000, 255),
    payload = request();
  const origin = await host(t, async (req, res) => {
    assert.equal(req.url, `/api/${REMOTE_RUN_UPLOAD_METHOD}`);
    assert.equal(req.headers['content-type'], REMOTE_RUN_UPLOAD_MEDIA_TYPE);
    assert.equal(req.headers.cookie, 'synthetic-member-cookie');
    assert.equal(req.headers[REMOTE_RUN_PERMIT_HEADER], 'synthetic-private-permit');
    const reader = new RemoteRunUploadReader(Readable.toWeb(req), new AbortController().signal);
    try {
      const envelope = await reader.metadata();
      assert.deepEqual(envelope.payload, payload);
      const chunks = [];
      for await (const bytes of reader.data) chunks.push(bytes);
      assert.deepEqual(Buffer.concat(chunks), expected);
      res.end(
        JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: 'accepted-contract',
        }),
      );
    } finally {
      await reader.close();
    }
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: [REMOTE_RUN_UPLOAD_METHOD],
    authentication: () => ({ cookie: 'synthetic-member-cookie' }),
    privateHeaderNames: [REMOTE_RUN_PERMIT_HEADER],
  });
  t.after(() => client.close());
  assert.equal(
    await client.invoke(
      REMOTE_RUN_UPLOAD_METHOD,
      payload,
      (x) => x,
      undefined,
      { [REMOTE_RUN_PERMIT_HEADER]: 'synthetic-private-permit' },
      {
        waitForSourceSettlement: true,
        upload: (async function* () {
          yield expected;
        })(),
      },
    ),
    'accepted-contract',
  );
});
test('member-local file HTTP: cancelled/early HTTP cannot release an uncooperative pending byte source', async (t) => {
  const started = Promise.withResolvers(),
    next = Promise.withResolvers();
  let returned = 0,
    settled = false,
    response;
  const origin = await host(t, async (req, res) => {
    response = res;
    req.resume();
  });
  const client = new MemberLocalExecutionClient({
    origin,
    methods: [REMOTE_RUN_UPLOAD_METHOD],
    authentication: () => ({}),
  });
  t.after(() => client.close());
  const controller = new AbortController();
  const work = client.invoke(
    REMOTE_RUN_UPLOAD_METHOD,
    request(),
    (x) => x,
    controller.signal,
    undefined,
    {
      waitForSourceSettlement: true,
      upload: {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          started.resolve();
          return next.promise;
        },
        async return() {
          returned++;
          return { done: true, value: undefined };
        },
      },
    },
  );
  const rejected = assert.rejects(work, { code: 'cancelled' });
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started.promise;
  controller.abort();
  response?.writeHead(403).end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(returned, 0);
  next.resolve({ done: true, value: undefined });
  await rejected;
  assert.equal(returned, 1);
});
