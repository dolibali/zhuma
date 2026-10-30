/** HTTP/SSE contracts; injected responses are not a real provider execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeArtsHttpClient } from '../dist/executors/codearts/http.js';
const id = 'ses_synthetic';
const permission = [{ permission: '*', pattern: '*', action: 'deny' }];
const signal = () => new AbortController().signal;
const json = (value) => Response.json(value);
function fixture(respond) {
  const requests = [];
  const client = new CodeArtsHttpClient({
    origin: 'http://127.0.0.1:44444',
    basicAuthorization: 'Basic c3ludGhldGljOnRlc3Q=',
    directory: '/synthetic/workspace',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return respond(url, options);
    },
  });
  return { client, requests };
}
const metadata = { id, directory: '/synthetic/workspace', permission };
async function create(client) {
  return client.createSession({ title: 'Synthetic test', permission, signal: signal() });
}

test('CodeArts HTTP: construction rejects non-owned endpoints and never probes', () => {
  for (const origin of [
    'https://127.0.0.1:44444',
    'http://localhost:44444',
    'http://example.com:44444',
    'http://user:secret@127.0.0.1:44444',
    'http://127.0.0.1:44444/path',
    'http://127.0.0.1:44444/?other=1',
  ])
    assert.throws(
      () =>
        new CodeArtsHttpClient({
          origin,
          basicAuthorization: 'Basic eDp5',
          directory: '/workspace',
        }),
      { code: 'invalid-endpoint' },
    );
  const { client, requests } = fixture(() => json({}));
  assert.equal(requests.length, 0);
  assert.equal(JSON.stringify(client), '{}');
});

test('CodeArts HTTP: bind exact session/cwd, scope every read and treat abort as acknowledgement', async () => {
  const { client, requests } = fixture((url) =>
    json(url.includes('/abort') ? true : url.includes('/message') ? [] : metadata),
  );
  await create(client);
  assert.deepEqual(await client.messages(id, signal()), []);
  assert.deepEqual(await client.abort(id, signal()), { status: 'acknowledged' });
  assert(requests.every((request) => request.url.endsWith('?directory=%2Fsynthetic%2Fworkspace')));
  assert(requests.every((request) => request.options.redirect === 'error'));
  await assert.rejects(client.messages('ses_other', signal()), { code: 'invalid-session' });
  await assert.rejects(client.messages('../session', signal()), { code: 'invalid-session' });
  assert.equal(requests.length, 3);
});

test('CodeArts HTTP: lost write outcome is unknown, redacted and never retried', async () => {
  const { client, requests } = fixture(() => {
    throw new Error('PRIVATE_RAW_CREDENTIAL');
  });
  await assert.rejects(
    create(client),
    (error) =>
      error.code === 'dispatch-unknown' && !String(error).includes('PRIVATE_RAW_CREDENTIAL'),
  );
  assert.equal(requests.length, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.createSession({ title: 'test', permission, signal: controller.signal }),
    { code: 'cancelled' },
  );
  assert.equal(requests.length, 1);
});

test('CodeArts HTTP: restored history is never silently replaced or deletable as a new setup', async () => {
  const { client, requests } = fixture(() => json(metadata));
  await client.resumeSession(id, signal());
  await assert.rejects(client.discardCreatedSession(id, signal()), { code: 'invalid-session' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'GET');
  const rejected = fixture(
    () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
  );
  await assert.rejects(rejected.client.resumeSession(id, signal()), { code: 'rejected' });
  assert.equal(rejected.requests.length, 1);
});

test('CodeArts HTTP: wrong directory, ID, echoed policy or cross-session history is rejected', async () => {
  for (const response of [
    { ...metadata, directory: '/another' },
    { ...metadata, permission: [] },
  ]) {
    const { client } = fixture(() => json(response));
    await assert.rejects(create(client));
    await assert.rejects(client.messages(id, signal()), { code: 'invalid-session' });
  }
  const { client } = fixture((url) =>
    json(
      url.includes('/message')
        ? [{ info: { id: 'message', sessionID: 'ses_other' }, parts: [] }]
        : metadata,
    ),
  );
  await create(client);
  await assert.rejects(client.messages(id, signal()), { code: 'invalid-response' });
});

test('CodeArts SSE: fragmented UTF-8 and CRLF preserve only the bound session and close the reader', async () => {
  let cancelled = false;
  const own = { type: 'message.part.delta', properties: { sessionID: id, delta: '你好' } };
  const events = [
    { type: 'server.connected', properties: {} },
    { type: 'session.updated', properties: { info: { id: 'ses_other' } } },
    own,
  ];
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  );
  const { client } = fixture((url) =>
    url.includes('/event?')
      ? new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      : json(metadata),
  );
  await create(client);
  for await (const event of client.events(id, signal())) {
    assert.deepEqual(event, own);
    break;
  }
  assert.equal(cancelled, true);
});

test('CodeArts SSE: malformed/truncated and oversized frames close without reconnection', async () => {
  for (const frame of ['data: {}', `data: ${'x'.repeat(512 * 1024 + 1)}\n\n`]) {
    const { client, requests } = fixture((url) =>
      url.includes('/event?')
        ? new Response(frame, { headers: { 'content-type': 'text/event-stream' } })
        : json(metadata),
    );
    await create(client);
    await assert.rejects(
      async () => {
        for await (const _event of client.events(id, signal())) {
        }
      },
      (error) => ['invalid-response', 'response-too-large'].includes(error.code),
    );
    assert.equal(requests.length, 2);
  }
});

test('CodeArts SSE: every declared session identity must agree, without treating message IDs as session IDs', async () => {
  const frames = [
    {
      type: 'message.part.updated',
      properties: { sessionID: id, part: { sessionID: 'ses_other' } },
    },
    {
      type: 'message.updated',
      properties: { sessionID: id, info: { id: 'msg_synthetic', sessionID: 'ses_other' } },
    },
    { type: 'message.part.updated', properties: { sessionID: id, part: { sessionID: null } } },
    { type: 'session.updated', properties: { sessionID: id, info: { id: 'ses_other' } } },
  ];
  for (const frame of frames) {
    const { client } = fixture((url) =>
      url.includes('/event?')
        ? new Response(`data: ${JSON.stringify(frame)}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          })
        : json(metadata),
    );
    await create(client);
    await assert.rejects(
      async () => {
        for await (const _event of client.events(id, signal())) {
        }
      },
      { code: 'invalid-response' },
    );
  }
  const frame = {
    type: 'message.updated',
    properties: { sessionID: id, info: { id: 'msg_synthetic', sessionID: id } },
  };
  const { client } = fixture((url) =>
    url.includes('/event?')
      ? new Response(`data: ${JSON.stringify(frame)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      : json(metadata),
  );
  await create(client);
  const received = [];
  for await (const event of client.events(id, signal())) received.push(event);
  assert.deepEqual(received, [frame]);
});
