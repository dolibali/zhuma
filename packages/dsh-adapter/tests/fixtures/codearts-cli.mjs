/** Synthetic official-CLI-shaped peer. No model, user profile, filesystem tools or credentials. */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const path = process.env.ZHUMA_CODEARTS_FIXTURE_STATE;
if (!path || process.argv[2] !== 'serve') throw new Error('owned fixture required');
const state = existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : { createCalls: 0, promptTools: [], rows: [] };
state.pid = process.pid;
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
state.mcpNames = Object.keys(config.mcp);
const persist = () => writeFileSync(path, JSON.stringify(state));
persist();
const authorization =
  'Basic ' +
  Buffer.from(
    process.env.CODEARTS_SERVER_USERNAME + ':' + process.env.CODEARTS_SERVER_PASSWORD,
  ).toString('base64');
const events = new Set();
const emit = (type, properties) => {
  for (const output of events) output.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
};
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== authorization) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : undefined;
  const reply = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  };
  if (url.pathname === '/global/health') return reply({ healthy: true, version: '26.10.13' });
  if (url.pathname === '/session' && req.method === 'POST') {
    state.createCalls++;
    state.metadata = {
      id: 'ses_fixture_owned',
      directory: process.cwd(),
      permission: body.permission,
    };
    persist();
    return reply(state.metadata);
  }
  if (url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"server.connected","properties":{}}\n\n');
    events.add(res);
    res.on('close', () => events.delete(res));
    return;
  }
  const id = url.pathname.split('/')[2];
  if (!state.metadata || id !== state.metadata.id) return reply({}, 404);
  if (url.pathname.endsWith('/message')) return reply(state.rows);
  if (url.pathname.endsWith('/abort')) {
    emit('session.status', { sessionID: id, status: { type: 'idle' } });
    return reply(true);
  }
  if (url.pathname.endsWith('/prompt_async')) {
    state.promptTools.push(body.tools);
    const info = {
      id: 'msg_user',
      sessionID: id,
      role: 'user',
      model: { providerID: 'fixture', modelID: 'fixture-model' },
    };
    state.rows.push({ info, parts: [{ sessionID: id, type: 'text', text: body.parts[0].text }] });
    persist();
    res.writeHead(204).end();
    emit('session.status', { sessionID: id, status: { type: 'busy' } });
    emit('message.updated', { info });
    emit('message.updated', { info: { id: 'msg_agent', sessionID: id, role: 'assistant' } });
    emit('message.part.updated', {
      part: { id: 'prt_owned', sessionID: id, messageID: 'msg_agent', type: 'text', text: '' },
    });
    emit('message.part.delta', {
      sessionID: id,
      messageID: 'msg_agent',
      partID: 'prt_owned',
      field: 'text',
      delta: 'fixture live output',
    });
    emit('message.part.updated', {
      part: {
        id: 'prt_owned',
        sessionID: id,
        messageID: 'msg_agent',
        type: 'text',
        text: 'fixture live output',
      },
    });
    emit('session.status', { sessionID: id, status: { type: 'idle' } });
    return;
  }
  return reply(state.metadata);
});
server.listen(0, '127.0.0.1', () =>
  process.stdout.write(`fixture http://127.0.0.1:${server.address().port}\n`),
);
process.once('SIGTERM', () => {
  for (const output of events) output.end();
  server.close(() => process.exit(0));
});
