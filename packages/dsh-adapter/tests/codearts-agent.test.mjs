/** ACP/HTTP composition contracts with an injected HTTP peer; no real CLI or model. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeArtsAcpAgent } from '../dist/executors/codearts/agent.js';
import { CodeArtsHttpClient } from '../dist/executors/codearts/http.js';
import { createCodeArtsMcpPolicy, codeArtsPromptText } from '../dist/executors/codearts/policy.js';

const bridge = (digit) => ({
  type: 'http',
  name: `dshteam_${digit.repeat(16)}`,
  url: `http://127.0.0.1:44444/${digit.repeat(64)}`,
  headers: [],
});
async function fixture(t, options = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-codearts-agent-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const records = options.records ?? new Map();
  const starts = [];
  const updates = [];
  const requests = [];
  const streams = new Map();
  const lifetime = new AbortController();
  const push = (id, type, properties) =>
    streams
      .get(id)
      ?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
  const gate = async (pending, signal) => {
    if (!pending) return;
    await Promise.race([
      pending.promise,
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled before dispatch')), {
          once: true,
        }),
      ),
    ]);
  };
  const startServer = async (input) => {
    const stopped = new AbortController();
    const instance = { input, stopped, closed: false };
    starts.push(instance);
    const fetch = async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      requests.push({ path, method: init.method, body });
      if (path === '/session' && init.method === 'POST') {
        const id = `ses_own_${records.size + 1}`;
        const value = { id, directory: cwd, permission: body.permission, rows: [] };
        records.set(id, value);
        return Response.json(value);
      }
      const id = path.split('/')[2];
      if (path === '/event') {
        await gate(options.delayOpen, init.signal);
        return new Response(
          new ReadableStream({
            start(controller) {
              streams.set(instance.id, controller);
              init.signal.addEventListener(
                'abort',
                () => {
                  try {
                    controller.error(new Error('aborted'));
                  } catch {}
                },
                { once: true },
              );
            },
            cancel() {
              streams.delete(instance.id);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (path.endsWith('/prompt_async')) {
        await gate(options.holdDispatch, init.signal);
        queueMicrotask(() => {
          push(id, 'session.status', { sessionID: id, status: { type: 'busy' } });
          push(id, 'message.updated', {
            info: {
              id: 'msg_user',
              sessionID: id,
              role: 'user',
              model: body.model ?? { providerID: 'owned-provider', modelID: 'owned-model' },
            },
          });
          push(id, 'message.updated', {
            info: { id: 'msg_agent', sessionID: id, role: 'assistant' },
          });
          push(id, 'message.part.updated', {
            part: { id: 'prt_text', sessionID: id, messageID: 'msg_agent', type: 'text', text: '' },
          });
          push(id, 'message.part.delta', {
            sessionID: id,
            messageID: 'msg_agent',
            partID: 'prt_text',
            field: 'text',
            delta: 'live output',
          });
          push(id, 'message.part.updated', {
            part: {
              id: 'prt_text',
              sessionID: id,
              messageID: 'msg_agent',
              type: 'text',
              text: 'live output',
            },
          });
          if (options.dropStream) streams.get(id)?.close();
          else if (!options.hold)
            push(id, 'session.status', { sessionID: id, status: { type: 'idle' } });
        });
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/abort')) {
        push(id, 'session.status', { sessionID: id, status: { type: 'idle' } });
        return Response.json(true);
      }
      const value = records.get(id);
      if (!value)
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      if (path.endsWith('/message')) return Response.json(value.rows);
      instance.id = id;
      return Response.json(value);
    };
    const client = new CodeArtsHttpClient({
      origin: 'http://127.0.0.1:44444',
      basicAuthorization: 'Basic eDp5',
      directory: cwd,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (init.method === 'POST' && new URL(url).pathname === '/session')
          instance.id = (await response.clone().json()).id;
        return response;
      },
    });
    return {
      client,
      signal: AbortSignal.any([lifetime.signal, stopped.signal]),
      async close() {
        instance.closed = true;
        stopped.abort();
        const stream = streams.get(instance.id);
        try {
          stream?.error(new Error('closed'));
        } catch {}
        streams.delete(instance.id);
      },
    };
  };
  const agent = new CodeArtsAcpAgent({
    command: '/synthetic/codearts',
    signal: lifetime.signal,
    connection: {
      async sessionUpdate(update) {
        updates.push(update);
      },
    },
    startServer,
  });
  t.after(() => agent.dispose());
  return {
    agent,
    cwd,
    starts,
    updates,
    requests,
    records,
    push,
    streams,
    setup: (digit) => agent.newSession({ cwd, mcpServers: [bridge(digit)] }),
  };
}
const prompt = (id) => ({
  sessionId: id,
  prompt: [{ type: 'text', text: 'Owned task instruction' }],
});

test('CodeArts ACP: initialize is static; only the fixed scoped bridge is accepted', async (t) => {
  const f = await fixture(t);
  assert.equal(f.agent.initialize().agentCapabilities.loadSession, true);
  assert.equal(f.starts.length, 0);
  for (const servers of [
    [],
    [{ ...bridge('1'), url: 'https://example.com/mcp' }],
    [{ ...bridge('1'), headers: [{ name: 'Authorization', value: 'unapproved' }] }],
    [bridge('1'), bridge('2')],
  ])
    assert.throws(() => createCodeArtsMcpPolicy(servers));
  const policy = createCodeArtsMcpPolicy([bridge('1')]);
  assert.deepEqual(policy.tools, { '*': false, ['dshteam_1111111111111111_*']: true });
});

test('CodeArts ACP: the original empty-bridge probe shape discovers only a passive routing strategy', async (t) => {
  const f = await fixture(t);
  const metadata = await f.agent.newSession({ cwd: f.cwd, mcpServers: [] });
  assert.match(metadata.sessionId, /^zhuma-codearts-metadata-/u);
  assert.deepEqual(metadata._meta, {
    'zhuma.dev/session-kind': 'metadata-only',
    'zhuma.dev/model-source': 'adapter-routing-capability',
    'zhuma.dev/backend-verified': false,
  });
  assert.equal(metadata.configOptions[0].currentValue, 'provider-default');
  assert.equal(metadata.configOptions[0].options[0].name, '继承码道当前配置（开始时解析）');
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.requests, []);
  assert.equal(f.records.size, 0, 'no provider SID or transcript is created');
  assert.deepEqual(f.updates, []);
  await f.agent.closeSession({ sessionId: metadata.sessionId });
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.requests, []);
});

test('CodeArts ACP: metadata IDs cannot prompt, set a model, cancel, load or resume even on a cold connection', async (t) => {
  const f = await fixture(t),
    metadata = await f.agent.newSession({ cwd: f.cwd, mcpServers: [] });
  await assert.rejects(f.agent.prompt(prompt(metadata.sessionId)));
  await assert.rejects(f.agent.cancel({ sessionId: metadata.sessionId }));
  assert.throws(() =>
    f.agent.setSessionConfigOption({
      sessionId: metadata.sessionId,
      configId: 'model',
      value: 'provider-default',
    }),
  );
  await assert.rejects(
    f.agent.loadSession({ cwd: f.cwd, sessionId: metadata.sessionId, mcpServers: [bridge('1')] }),
  );
  await assert.rejects(
    f.agent.resumeSession({ cwd: f.cwd, sessionId: metadata.sessionId, mcpServers: [bridge('1')] }),
  );
  const cold = await fixture(t);
  await assert.rejects(
    cold.agent.resumeSession({
      cwd: cold.cwd,
      sessionId: metadata.sessionId,
      mcpServers: [bridge('1')],
    }),
  );
  await assert.rejects(
    cold.agent.loadSession({
      cwd: cold.cwd,
      sessionId: metadata.sessionId,
      mcpServers: [bridge('1')],
    }),
  );
  assert.equal(f.starts.length, 0);
  assert.equal(cold.starts.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(cold.requests.length, 0);
});

test('CodeArts ACP: bounded metadata sessions cannot consume, replace or close the genuine task binding', async (t) => {
  const f = await fixture(t),
    created = await Promise.all(
      Array.from({ length: 8 }, () => f.agent.newSession({ cwd: f.cwd, mcpServers: [] })),
    );
  await assert.rejects(f.agent.newSession({ cwd: f.cwd, mcpServers: [] }));
  const actual = await f.setup('1');
  assert.match(actual.sessionId, /^ses_own_/u);
  assert.equal(f.starts.length, 1);
  for (const metadata of created) await f.agent.closeSession({ sessionId: metadata.sessionId });
  assert.equal(f.starts[0].closed, false);
  assert.deepEqual(await f.agent.prompt(prompt(actual.sessionId)), { stopReason: 'end_turn' });
  await assert.rejects(f.setup('2'), /busy/u);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].closed, false);
  const after = await f.agent.newSession({ cwd: f.cwd, mcpServers: [] });
  await f.agent.closeSession({ sessionId: after.sessionId });
  assert.equal(f.starts[0].closed, false);
});

test('CodeArts ACP: metadata admission stays bounded under concurrent requests and disposal is final', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, () => f.agent.newSession({ cwd: f.cwd, mcpServers: [] })),
  );
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 8);
  assert.equal(results.filter((row) => row.status === 'rejected').length, 8);
  assert.equal(f.starts.length, 0);
  await f.agent.dispose();
  await assert.rejects(f.agent.newSession({ cwd: f.cwd, mcpServers: [] }));
  await assert.rejects(f.setup('1'));
  assert.equal(f.starts.length, 0);
});

test('CodeArts ACP: live deltas arrive once and each explicit turn sends the current MCP-only tool policy', async (t) => {
  const f = await fixture(t);
  const session = await f.setup('1');
  assert.deepEqual(await f.agent.prompt(prompt(session.sessionId)), { stopReason: 'end_turn' });
  const output = f.updates
    .filter((value) => value.update.sessionUpdate === 'agent_message_chunk')
    .map((value) => value.update.content.text)
    .join('');
  assert.equal(output, 'live output');
  const first = f.requests.find((value) => value.path.endsWith('/prompt_async'));
  assert.equal(first.body.tools['*'], false);
  assert.equal(first.body.tools['dshteam_1111111111111111_*'], true);
  assert.equal(first.body.model, undefined);
  await f.agent.prompt(prompt(session.sessionId));
  const second = f.requests.filter((value) => value.path.endsWith('/prompt_async'))[1];
  assert.deepEqual(second.body.model, { providerID: 'owned-provider', modelID: 'owned-model' });
});

test('CodeArts ACP: another task bridge is busy and cannot replace or stop the existing session', async (t) => {
  const f = await fixture(t);
  const first = await f.setup('1');
  await assert.rejects(f.setup('2'), /busy/);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].closed, false);
  await assert.rejects(f.agent.cancel({ sessionId: 'ses_other' }));
  await f.agent.prompt(prompt(first.sessionId));
  assert.equal(f.starts[0].closed, false);
});

test('CodeArts ACP: cancelling one connection leaves the other Run and bridge active', async (t) => {
  const one = await fixture(t, { hold: true });
  const two = await fixture(t, { hold: true });
  const a = await one.setup('1');
  const b = await two.setup('2');
  const first = one.agent.prompt(prompt(a.sessionId));
  const second = two.agent.prompt(prompt(b.sessionId));
  while (one.updates.length === 0 || two.updates.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  await one.agent.cancel({ sessionId: a.sessionId });
  assert.deepEqual(await first, { stopReason: 'cancelled' });
  assert.equal(two.starts[0].closed, false);
  assert.equal(
    two.requests.some((value) => value.path.endsWith('/abort')),
    false,
  );
  await two.agent.cancel({ sessionId: b.sessionId });
  await second;
});

test('CodeArts ACP: missing cold session does not create a replacement or dispatch inference', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.agent.resumeSession({ sessionId: 'ses_missing', cwd: f.cwd, mcpServers: [bridge('1')] }),
  );
  assert.equal(
    f.requests.some((value) => value.method === 'POST'),
    false,
  );
  assert.equal(f.starts[0].closed, true);
});

test('CodeArts ACP: load replays the original session and remains read-only', async (t) => {
  const f = await fixture(t);
  f.records.set('ses_saved', {
    id: 'ses_saved',
    directory: f.cwd,
    permission: [],
    rows: [
      {
        info: {
          id: 'msg_original',
          sessionID: 'ses_saved',
          role: 'user',
          model: { providerID: 'previous', modelID: 'original' },
        },
        parts: [{ sessionID: 'ses_saved', type: 'text', text: 'original history' }],
      },
    ],
  });
  await f.agent.loadSession({ sessionId: 'ses_saved', cwd: f.cwd, mcpServers: [bridge('1')] });
  assert.equal(f.updates[0].update.content.text, 'original history');
  assert.equal(
    f.requests.some((value) => value.method === 'POST'),
    false,
  );
  await f.agent.prompt(prompt('ses_saved'));
});

test('CodeArts ACP: stream loss poisons the connection rather than replaying a prompt', async (t) => {
  const f = await fixture(t, { dropStream: true });
  const session = await f.setup('1');
  await assert.rejects(f.agent.prompt(prompt(session.sessionId)));
  assert.equal(f.starts[0].closed, true);
  await assert.rejects(f.agent.prompt(prompt(session.sessionId)));
  assert.equal(f.requests.filter((value) => value.path.endsWith('/prompt_async')).length, 1);
});

test('CodeArts ACP: attachments never become arbitrary filesystem/network reads', () => {
  assert.equal(
    codeArtsPromptText([{ type: 'resource', resource: { text: 'inline text' } }]),
    'inline text',
  );
  assert.throws(() => codeArtsPromptText([{ type: 'resource_link', uri: 'file:///private/file' }]));
  assert.throws(() =>
    codeArtsPromptText([{ type: 'image', data: 'unknown', mimeType: 'image/png' }]),
  );
});

test('CodeArts ACP: cancel before stream readiness never dispatches a prompt', async (t) => {
  const delayOpen = Promise.withResolvers();
  const f = await fixture(t, { delayOpen });
  const session = await f.setup('1');
  const running = f.agent.prompt(prompt(session.sessionId));
  while (!f.requests.some((value) => value.path === '/event'))
    await new Promise((resolve) => setImmediate(resolve));
  await f.agent.cancel({ sessionId: session.sessionId });
  assert.deepEqual(await running, { stopReason: 'cancelled' });
  assert.equal(
    f.requests.some((value) => value.path.endsWith('/prompt_async')),
    false,
  );
  assert.equal(f.starts[0].closed, false);
});

test('CodeArts ACP: cancel an unacknowledged dispatch retires its backend and cannot start a late turn', async (t) => {
  const holdDispatch = Promise.withResolvers();
  const f = await fixture(t, { holdDispatch });
  const session = await f.setup('1');
  const running = f.agent.prompt(prompt(session.sessionId));
  const rejected = assert.rejects(running);
  while (!f.requests.some((value) => value.path.endsWith('/prompt_async')))
    await new Promise((resolve) => setImmediate(resolve));
  await f.agent.cancel({ sessionId: session.sessionId });
  await rejected;
  assert.equal(f.starts[0].closed, true);
  holdDispatch.resolve();
  await assert.rejects(f.agent.prompt(prompt(session.sessionId)));
  assert.equal(f.requests.filter((value) => value.path.endsWith('/prompt_async')).length, 1);
});
