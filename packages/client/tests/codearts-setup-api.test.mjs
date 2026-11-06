/** Local owner settings transport contracts; no real profile/CLI/model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeArtsSetupApi } from '../dist/run/codearts-setup.js';

test('CodeArts settings only read status or explicitly POST the unchanged local command', async () => {
  const calls = [],
    signal = new AbortController().signal;
  const api = createCodeArtsSetupApi(
    async (path, init) => {
      calls.push({ path, init });
      return Response.json({ ok: true, value: { configured: init.method === 'POST' } });
    },
    () => true,
  );
  assert.deepEqual(await api.status(signal), { configured: false });
  assert.deepEqual(await api.configure('/synthetic/codearts', signal), { configured: true });
  assert.deepEqual(
    calls.map(({ path, init }) => ({
      path,
      method: init.method,
      body: init.body,
      credentials: init.credentials,
      redirect: init.redirect,
    })),
    [
      {
        path: '/api/zhuma-codearts/status',
        method: 'GET',
        body: undefined,
        credentials: 'same-origin',
        redirect: 'error',
      },
      {
        path: '/api/zhuma-codearts/configure',
        method: 'POST',
        body: '{"command":"/synthetic/codearts"}',
        credentials: 'same-origin',
        redirect: 'error',
      },
    ],
  );
});
test('CodeArts settings keep an interrupted save unconfirmed without leaking transport exceptions or masking a retired view', async () => {
  let current = true,
    retire = false;
  const api = createCodeArtsSetupApi(
      async () => {
        if (retire) current = false;
        throw Error('private-transport-url-or-path');
      },
      () => current,
    ),
    signal = new AbortController().signal;
  await assert.rejects(api.configure('codearts', signal), (error) => {
    assert.equal(error.message, '本机连接中断，配置结果尚未确认。');
    assert.equal(error.message.includes('private-transport'), false);
    return true;
  });
  retire = true;
  await assert.rejects(api.configure('codearts', signal), { name: 'AbortError' });
});
