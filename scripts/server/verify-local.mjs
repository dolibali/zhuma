import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startLocalServer, stopLocalServer } from './runtime.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { sdk: { type: 'string' } } });
if (!values.sdk) throw new Error('Pass --sdk with the built, pinned official SDK');
const sdk = resolve(values.sdk);
const directory = await mkdtemp(join(tmpdir(), 'zhuma-official-web-'));
const checks = [];
let child;
async function boot() {
  child = await startLocalServer({ sdk, data: directory, port: 0 });
  const running = child;
  let diagnostics = '';
  const url = await new Promise((done, fail) => {
    const timeout = setTimeout(
      () => fail(new Error(`Official CLI startup timeout: ${diagnostics.slice(-2400)}`)),
      45_000,
    );
    const inspect = (chunk) => {
      const text = chunk.toString();
      diagnostics = (diagnostics + text.replace(/token=[^\s&]+/gu, 'token=[redacted]')).slice(
        -5000,
      );
      const match = text.match(/dsh web: (https?:\/\/\S+\?token=\S+)/u);
      if (match) {
        clearTimeout(timeout);
        done(match[1]);
      }
    };
    running.stdout.on('data', inspect);
    running.stderr.on('data', inspect);
    running.once('exit', () => {
      clearTimeout(timeout);
      fail(new Error(`Official CLI exited: ${diagnostics}`));
    });
    running.once('error', (error) => {
      clearTimeout(timeout);
      fail(error);
    });
  });
  const ownerURL = new URL(url);
  const base = ownerURL.origin;
  const exchange = await fetch(ownerURL, { redirect: 'manual' });
  assert.equal(exchange.status, 303);
  const ownerCookie = exchange.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  assert.ok(ownerCookie);
  return {
    base,
    ownerCookie,
    diagnostics: () =>
      diagnostics.replaceAll(sdk, '[sdk]').replaceAll(directory, '[temporary-data]'),
  };
}
async function call(host, path, body, cookie) {
  return fetch(host.base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: host.base,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });
}
async function upgradeStatus(host, cookie) {
  return new Promise((done, fail) => {
    const req = httpRequest(host.base + '/api/remote.mux', {
      headers: {
        cookie,
        origin: host.base,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
      },
    });
    req.once('response', (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.once('upgrade', (_res, socket) => {
      socket.destroy();
      fail(new Error('Member unexpectedly admitted to owner websocket'));
    });
    req.once('error', fail);
    req.setTimeout(5000, () => req.destroy(new Error('Websocket rejection timeout')));
    req.end();
  });
}
const input = {
  requestId: randomUUID(),
  accountId: 'web-member',
  password: 'synthetic-web-passphrase',
  teamName: '演示研发团队',
  packIds: ['zhuma-work-planning'],
};
try {
  let host = await boot();
  const page = await call(host, '/workbench');
  assert.equal(page.status, 200, host.diagnostics());
  assert.equal(page.headers.get('set-cookie'), null);
  const html = await page.text();
  assert.ok(html.includes('/workbench/app.js'));
  assert.ok(!/token=|__ModuleLoader__|__DSH_/u.test(html));
  const script = await call(host, '/workbench/app.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('set-cookie'), null);
  assert.ok((await script.text()).length > 1000);
  checks.push('public-member-page-without-owner-bootstrap');
  assert.equal((await call(host, '/api/zhuma-local-setup/status')).status, 401);
  const initialized = await call(
    host,
    '/api/zhuma-local-setup/initialize',
    input,
    host.ownerCookie,
  );
  assert.equal(initialized.status, 200);
  const setup = await initialized.json();
  assert.equal(setup.ok, true);
  assert.equal(setup.value.kind, 'configured');
  checks.push('normal-owner-first-setup');
  const login = await call(host, '/zhuma-id/login', {
    accountId: input.accountId,
    password: input.password,
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .find((line) => line.startsWith('zhuma-member='))
    ?.split(';')[0];
  assert.ok(cookie);
  const session = await (await call(host, '/zhuma-id/session', undefined, cookie)).json();
  assert.equal(session.principal.kind, 'zhuma-member');
  checks.push('normal-member-login-without-owner-cookie');
  const spaceId = setup.value.createdTeam.id;
  const memberRpc = async (endpoint, payload, active = host, memberCookie = cookie) => {
    const response = await call(
      active,
      '/api/zhuma-member/' + endpoint,
      {
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'zhuma-member/' + endpoint,
        payload,
      },
      memberCookie,
    );
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.result.ok, true, JSON.stringify(value));
    return value.result.value;
  };
  let snapshot = await memberRpc('snapshot', { spaceId });
  snapshot = await memberRpc('command', {
    spaceId,
    requestId: randomUUID(),
    expectedRevision: snapshot.state.revision,
    command: {
      type: 'create-project',
      project: { id: 'demo-project', name: '本地共享项目', description: '' },
    },
  });
  snapshot = await memberRpc('command', {
    spaceId,
    requestId: randomUUID(),
    expectedRevision: snapshot.state.revision,
    command: {
      type: 'create-task',
      task: {
        id: 'demo-task',
        projectId: 'demo-project',
        title: '整理接口与交付说明',
        goal: '形成可供后续工作引用的接口说明',
        participantIds: [input.accountId],
        ownerId: input.accountId,
        workflows: [{ id: 'main', name: '主流程', parentNodeId: null, nodes: [] }],
      },
    },
  });
  assert.equal(snapshot.state.projects[0].name, '本地共享项目');
  assert.equal(snapshot.state.tasks[0].title, '整理接口与交付说明');
  checks.push('normal-member-snapshot-project-and-task-creation-without-owner');
  const rpc = {
    type: 'client-request',
    rpcId: randomUUID(),
    method: 'zhuma-exec/startable',
    payload: { spaceId },
  };
  assert.equal((await call(host, '/api/zhuma-exec/startable', rpc)).status, 401);
  const startable = await call(host, '/api/zhuma-exec/startable', rpc, cookie);
  assert.equal(startable.status, 200);
  const startableBody = await startable.json();
  assert.equal(startableBody.result.ok, true, JSON.stringify(startableBody));
  assert.deepEqual(startableBody.result.value.plans, []);
  checks.push('member-product-exact-route-without-owner');
  for (const path of [
    '/',
    '/api',
    '/connect',
    '/api/zhuma-local-setup/status',
    '/api/zhuma-run/options',
    '/api/zhuma-workflow/start',
  ]) {
    const reply = await call(host, path, undefined, cookie);
    assert.ok([401, 403].includes(reply.status), `${path}: ${reply.status}`);
  }
  checks.push('member-cookie-refused-by-owner-rpc-connect-and-server-run');
  assert.equal(await upgradeStatus(host, cookie), 401);
  checks.push('member-cookie-refused-by-real-websocket-upgrade');
  const rejected = await fetch(host.base + '/api/zhuma-exec/startable', {
    method: 'POST',
    headers: { cookie, origin: 'https://attacker.invalid', 'content-type': 'application/json' },
    body: JSON.stringify(rpc),
  });
  assert.equal(rejected.status, 403);
  checks.push('cross-origin-member-request-refused');
  await stopLocalServer(child);
  child = undefined;
  host = await boot();
  const relogin = await call(host, '/zhuma-id/login', {
    accountId: input.accountId,
    password: input.password,
  });
  assert.equal(relogin.status, 200);
  const renewedCookie = relogin.headers
    .getSetCookie()
    .find((line) => line.startsWith('zhuma-member='))
    ?.split(';')[0];
  const renewedSession = await (
    await call(host, '/zhuma-id/session', undefined, renewedCookie)
  ).json();
  assert.deepEqual(renewedSession.spaces, session.spaces);
  const reopened = await memberRpc('snapshot', { spaceId }, host, renewedCookie);
  assert.deepEqual(reopened.state.projects, snapshot.state.projects);
  assert.deepEqual(reopened.state.tasks, snapshot.state.tasks);
  checks.push('normal-project-task-facts-survive-official-cli-cold-restart');
  checks.push('official-cli-cold-restart-member-persistence');
  const hash = (file) =>
    readFile(join(root, '.build/workbench', file)).then((bytes) =>
      createHash('sha256').update(bytes).digest('hex'),
    );
  const report = {
    scope: 'real-official-cli-http-no-model',
    checks,
    artifacts: { host: await hash('index.js'), memberWeb: await hash('member-web.js') },
    limits: ['No browser or model validation', 'Cross-device desktop execution is not implemented'],
  };
  await mkdir(join(root, '.artifacts/server'), { recursive: true });
  await writeFile(
    join(root, '.artifacts/server/local-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child) await stopLocalServer(child);
  await rm(directory, { recursive: true, force: true });
}
