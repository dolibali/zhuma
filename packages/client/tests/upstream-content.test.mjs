import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExecutionApi } from '../dist/execution/ExecutionApi.js';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { UpstreamContentBody } from '../dist/execution/UpstreamContent.js';
import { UpstreamInputsPanel } from '../dist/execution/UpstreamInputsPanel.js';
import { deliveryNode } from './browser/execution-fixture.mjs';
import { upstreamInputs } from './upstream-input-fixture.mjs';
import { upstreamQuery as query, upstreamContent } from './upstream-content-fixture.mjs';

function rpc(value = upstreamContent(), space = 'team-a') {
  const calls = [];
  const api = createExecutionApi(
    {
      async call(channel, method, payload, signal) {
        calls.push({ channel, method, payload, signal });
        return { ok: true, value };
      },
    },
    space,
  );
  return { api, calls };
}
const file = () => ({
  id: 'contract.md',
  mediaType: 'text/markdown',
  byteSize: 42,
  checksum: 'fixture-digest',
  accessPolicyId: 'fixture-policy',
  uploadComplete: true,
});

test('upstream content RPC: exact scoped pinned request, correlated response and isolated metadata copies', async () => {
  const value = upstreamContent();
  value.content.files = [file()];
  const { api, calls } = rpc(value);
  assert.equal(calls.length, 0);
  const result = await api.upstreamContent(query);
  const { expectedArtifactVersion, ...request } = query;
  assert.deepEqual(calls[0].payload, { ...request, spaceId: 'team-a' });
  assert.equal(calls[0].channel, '/api');
  assert.equal(calls[0].method, 'zhuma-exec/upstream-content');
  assert.deepEqual(result, value);
  value.content.links.push('https://example.com/new');
  value.content.files[0].id = 'mutated';
  value.downstream.nodeId = 'mutated';
  assert.equal(result.content.links.length, 1);
  assert.equal(result.content.files[0].id, 'contract.md');
  assert.equal(result.downstream.nodeId, query.nodeId);
});

test('upstream content RPC: a bound space and valid pin/version are required before dispatch', async () => {
  let calls = 0;
  const unbound = createExecutionApi({
    async call() {
      calls++;
    },
  });
  await assert.rejects(unbound.upstreamContent(query), { code: 'scope-required' });
  assert.equal(calls, 0);
  for (const patch of [
    { artifactVersionId: '' },
    { expectedArtifactVersion: 0 },
    { sourceNodeId: '' },
  ]) {
    const { api, calls } = rpc();
    await assert.rejects(api.upstreamContent({ ...query, ...patch }), { code: 'validation' });
    assert.equal(calls.length, 0);
  }
});

for (const path of [
  ['spaceId'],
  ['downstream', 'taskId'],
  ['downstream', 'planId'],
  ['downstream', 'revision'],
  ['downstream', 'nodeId'],
  ['source', 'taskId'],
  ['source', 'planId'],
  ['source', 'revision'],
  ['source', 'nodeId'],
  ['version', 'id'],
  ['version', 'version'],
]) {
  test(`upstream content RPC: rejects mismatched ${path.join('.')} without returning content`, async () => {
    const value = upstreamContent();
    let target = value;
    for (const part of path.slice(0, -1)) target = target[part];
    const field = path.at(-1);
    target[field] = typeof target[field] === 'number' ? 99 : 'wrong-target';
    await assert.rejects(rpc(value).api.upstreamContent(query), (error) =>
      ['scope-mismatch', 'upstream-mismatch'].includes(error.code),
    );
  });
}

for (const [label, change] of [
  ['missing actor', (v) => delete v.actorId],
  [
    'unknown root field',
    (v) => {
      v.privateBody = 'not-public';
    },
  ],
  [
    'unknown source field',
    (v) => {
      v.source.path = '/private/path';
    },
  ],
  [
    'nontext body',
    (v) => {
      v.content.text = {};
    },
  ],
  [
    'oversized body',
    (v) => {
      v.content.text = 'x'.repeat(100001);
    },
  ],
  ['missing links', (v) => delete v.content.links],
  [
    'too many links',
    (v) => {
      v.content.links = Array(21).fill('https://example.com');
    },
  ],
  ['missing files', (v) => delete v.content.files],
  [
    'unknown body field',
    (v) => {
      v.content.bytes = 'not-public';
    },
  ],
  [
    'malformed file',
    (v) => {
      v.content.files = [{ ...file(), uploadComplete: 'yes' }];
    },
  ],
  [
    'negative file size',
    (v) => {
      v.content.files = [{ ...file(), byteSize: -1 }];
    },
  ],
  [
    'duplicate file',
    (v) => {
      v.content.files = [file(), file()];
    },
  ],
  [
    'file path extra',
    (v) => {
      v.content.files = [{ ...file(), path: '/private/path' }];
    },
  ],
]) {
  test(`upstream content RPC: rejects ${label} as validation rather than empty content`, async () => {
    const value = upstreamContent();
    change(value);
    await assert.rejects(
      rpc(value).api.upstreamContent(query),
      (error) =>
        error.code === 'validation' &&
        !error.message.includes('not-public') &&
        !error.message.includes('/private/'),
    );
  });
}

function http({ value = upstreamContent(), failure, isCurrent = () => true, hold } = {}) {
  const calls = [],
    failures = { member: 0, space: 0 };
  const api = createExecutionHttpApi(
    async (url, options) => {
      if (url === '/zhuma-id/session')
        return Response.json({
          ok: true,
          accountId: 'chen',
          principal: { kind: 'zhuma-member', memberId: 'chen' },
          peerId: 'peer',
          spaces: [{ id: 'team-a', kind: 'team', name: 'A' }],
        });
      const request = JSON.parse(options.body);
      calls.push({ url, request, options });
      const response = Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: failure ? { ok: false, error: failure } : { ok: true, value },
      });
      return hold ? hold(response) : response;
    },
    () => failures.member++,
    'chen',
    {
      spaceId: 'team-a',
      onUnavailable: () => failures.space++,
      isCurrent,
    },
  );
  return { api, calls, failures };
}

test('upstream content HTTP: cookie transport, account/scope checks and source denial have distinct lifetimes', async () => {
  const good = http();
  await good.api.upstreamContent(query);
  assert.equal(good.calls[0].url, '/api/zhuma-exec/upstream-content');
  assert.equal(good.calls[0].options.credentials, 'same-origin');
  assert.equal('actorId' in good.calls[0].request.payload, false);
  const wrongActor = http({ value: { ...upstreamContent(), actorId: 'another-member' } });
  await assert.rejects(wrongActor.api.upstreamContent(query), { code: 'unauthenticated' });
  assert.deepEqual(wrongActor.failures, { member: 1, space: 0 });
  const wrongSpace = http({ value: { ...upstreamContent(), spaceId: 'team-b' } });
  await assert.rejects(wrongSpace.api.upstreamContent(query), { code: 'scope-mismatch' });
  assert.deepEqual(wrongSpace.failures, { member: 0, space: 1 });
  const denied = http({
    failure: { code: 'not-found', message: '来源版本已不可读取。', details: {} },
  });
  await assert.rejects(denied.api.upstreamContent(query), { code: 'not-found' });
  assert.deepEqual(denied.failures, { member: 0, space: 0 });
});

test('upstream content HTTP: old generation or aborted late replies cannot reach another view or close it', async () => {
  for (const abort of [false, true]) {
    let current = true,
      release,
      entered;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const source = new AbortController();
    const { api, failures } = http({
      isCurrent: () => current,
      hold(response) {
        entered();
        return new Promise((resolve) => {
          release = () => resolve(response);
        });
      },
    });
    const pending = api.upstreamContent(query, source.signal);
    await waiting;
    if (abort) source.abort();
    else current = false;
    release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(failures, { member: 0, space: 0 });
  }
});

test('upstream content SSR: safe links, escaped plain text and honest file metadata', () => {
  const content = upstreamContent().content;
  content.text = '<script>unsafe</script>\nplain text';
  content.links.push('javascript:alert(1)', 'https://user:pass@example.com', 'file:///private');
  content.files = [file()];
  const html = renderToStaticMarkup(createElement(UpstreamContentBody, { content }));
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.equal((html.match(/href=/g) ?? []).length, 1);
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('contract.md') && html.includes('42 字节'));
  assert.ok(!/iframe|download=|type="file"/.test(html));
});

test('upstream content SSR: only visible inputs offer closed disclosure; rendering never reads', () => {
  let reads = 0;
  const html = renderToStaticMarkup(
    createElement(UpstreamInputsPanel, {
      api: {
        upstreamContent() {
          reads++;
        },
      },
      node: deliveryNode,
      inputs: upstreamInputs(),
    }),
  );
  assert.equal(reads, 0);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.ok(html.includes('class="zm-control-icon"'));
  assert.ok(html.includes('查看内容'));
  assert.ok(!html.includes('订单接口约定'));
});
