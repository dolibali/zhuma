import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createLocalSetupApi, LocalSetupApiError } from '../dist/identity/local-setup-api.js';
import { LocalSetupForm } from '../dist/identity/LocalSetupBoundary.js';

const packs = [
  { id: 'zhuma-work-planning', version: '1.0.0', name: '工作规划专家', role: '规划与分工' },
];
const reply = (value) => Response.json({ version: 1, ok: true, value });
const signal = () => new AbortController().signal;
const input = {
  requestId: '93229ea7-fd11-4575-b7af-40b7337f3e01',
  accountId: 'ann',
  password: 'synthetic-password-only',
  teamName: '研发团队',
  packIds: packs.map((p) => p.id),
};

test('first setup Client API contract: exact same-origin owner paths and fields, detached bounded replies', async () => {
  const calls = [];
  const api = createLocalSetupApi(async (url, options) => {
    calls.push({ url, options });
    return reply({
      kind: options.method === 'GET' ? 'pending' : 'configured',
      requestId: input.requestId,
      packs,
    });
  });
  const state = await api.status(signal());
  assert.equal(state.kind, 'pending');
  assert.equal(state.requestId, input.requestId);
  assert(Object.isFrozen(state.packs[0]));
  assert.equal(JSON.stringify(state).includes(input.password), false);
  assert.equal(
    (await api.initialize({ ...input, actorId: 'not-accepted', ready: true }, signal())).kind,
    'configured',
  );
  assert.deepEqual(
    calls.map((call) => [call.url, call.options.method]),
    [
      ['/api/zhuma-local-setup/status', 'GET'],
      ['/api/zhuma-local-setup/initialize', 'POST'],
    ],
  );
  for (const call of calls) {
    assert.equal(call.options.credentials, 'same-origin');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.cache, 'no-store');
  }
  assert.deepEqual(JSON.parse(calls[1].options.body), input);
  assert.equal(calls[0].options.body, undefined);
});

test('first setup Client API contract: foreign owner, unknown error and malformed state never become readiness', async () => {
  for (const [response, code] of [
    [new Response('', { status: 403 }), 'untrusted-request'],
    [
      Response.json({ error: { code: 'conflict', message: input.password } }, { status: 409 }),
      'conflict',
    ],
    [
      Response.json({ error: { code: 'toString', message: input.password } }, { status: 503 }),
      'unavailable',
    ],
    [reply({ kind: 'pending', packs }), 'invalid-response'],
    [reply({ kind: 'configured', packs: [...packs, ...packs] }), 'invalid-response'],
    [
      reply({ kind: 'configured', packs: [{ ...packs[0], version: 'private-next' }] }),
      'invalid-response',
    ],
  ]) {
    await assert.rejects(createLocalSetupApi(async () => response).status(signal()), (error) => {
      assert(error instanceof LocalSetupApiError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(input.password), false);
      return true;
    });
  }
});

test('first setup Client API contract: an already-cancelled view sends nothing and a late reply cannot become success', async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const api = createLocalSetupApi(async () => {
    calls++;
    return reply({ kind: 'configured', packs });
  });
  await assert.rejects(api.status(abort.signal));
  assert.equal(calls, 0);
  const late = new AbortController();
  const slow = createLocalSetupApi(async () => {
    late.abort();
    return reply({ kind: 'configured', packs });
  });
  // A fetch test port can return after abort. The API must still reject it.
  await assert.rejects(slow.initialize(input, late.signal));
});

test('first setup form SSR contract: real labels and explicit expert choices, no seeded user or credential value', () => {
  const html = renderToStaticMarkup(
    createElement(LocalSetupForm, {
      snapshot: { kind: 'unconfigured', packs },
      initialize: async () => {},
    }),
  );
  assert(html.includes('创建并进入工作台'));
  assert(html.includes('账号与团队'));
  assert(html.includes('团队基础专家'));
  assert(html.includes('type="checkbox"'));
  assert(html.includes('autoComplete="new-password"'));
  assert.equal(html.includes(input.password), false);
  assert.equal(html.includes('value="ann"'), false);
  const pending = renderToStaticMarkup(
    createElement(LocalSetupForm, {
      snapshot: { kind: 'pending', requestId: input.requestId, packs },
      initialize: async () => {},
    }),
  );
  assert(pending.includes('继续完成首次设置'));
});
