/** Pure transport/picker-port contracts; these do not prove a native picker or Host IO. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createWorkspaceApprovalApi,
  workspacePublishRanges,
} from '../dist/run/workspace-approvals.js';
import { createWorkspaceDirectoryRegistrar } from '../dist/run/workspace-directory.js';
import { createNativeRunApi } from '../dist/run/api.js';
import { NativeRunPanel } from '../dist/run/NativeRunPanel.js';

const location = { spaceId: 'north', projectId: 'project' };
const requestId = '7b2b6e3a-840f-41a9-b810-5b4827ef9902';
const input = {
  ...location,
  requestId,
  workspaceId: 'workspace',
  expectedGeneration: 0,
  access: 'write',
  publish: [{ kind: 'file', path: 'result.txt' }],
};
const row = {
  id: 'approval',
  workspaceId: 'workspace',
  generation: 1,
  status: 'approved',
  access: 'write',
  publish: input.publish,
};
const view = {
  available: true,
  directories: [{ id: 'workspace', title: 'Project', path: '/owned/project', access: 'write' }],
  approvals: [row],
};
const receipt = {
  requestId,
  expectedGeneration: 0,
  generation: 1,
  status: 'approved',
  fingerprint: 'a'.repeat(64),
};
const signal = () => new AbortController().signal;
const session = (accountId = 'chen') => ({
  ok: true,
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: 'peer',
  spaces: [{ id: 'north', kind: 'team', name: 'Team' }],
});
test('workspace Client: explicit operations use original member route and whitelisted ids, without actor/path/confirmation or native commands', async () => {
  const calls = [];
  const api = createNativeRunApi(
    async (url, init) => {
      calls.push({ url, init });
      if (url === '/zhuma-id/session') return Response.json(session());
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      const body = JSON.parse(init.body);
      assert.equal(body.method, `zhuma-workspaces/${url.split('/').at(-1)}`);
      assert.equal('actorId' in body.payload, false);
      assert.equal('path' in body.payload, false);
      assert.equal('confirmed' in body.payload, false);
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: url.endsWith('/options')
            ? view
            : { disposition: 'applied', receipt, current: row },
        },
      });
    },
    'chen',
    { spaceId: 'north', isCurrent: () => true, onUnavailable() {} },
    () => {},
  ).workspaceApprovals;
  assert.deepEqual(await api.options(location, signal()), view);
  assert.deepEqual(
    await api.approve(
      { ...input, actorId: 'outside', path: '/outside', confirmed: true },
      signal(),
    ),
    row,
  );
  assert.deepEqual(
    calls.filter((item) => item.url.startsWith('/api')).map((item) => item.url),
    ['/api/zhuma-workspaces/options', '/api/zhuma-workspaces/approve'],
  );
  const before = calls.length;
  await assert.rejects(api.options({ ...location, spaceId: 'other' }, signal()), {
    code: 'validation',
  });
  assert.equal(calls.length, before);
});
test('workspace Client: replay returns the latest tombstone; crossed selectors and generations never restore approved UI state', async () => {
  const revoked = { ...row, generation: 2, status: 'revoked', access: null, publish: [] };
  const api = createWorkspaceApprovalApi(
    async () => ({ disposition: 'replayed', receipt, current: revoked }),
    'north',
  );
  assert.deepEqual(await api.approve(input, signal()), revoked);
  for (const current of [
    { ...row, workspaceId: 'crossed' },
    { ...row, generation: 0 },
    { ...revoked, publish: input.publish },
  ]) {
    const bad = createWorkspaceApprovalApi(
      async () => ({ disposition: 'applied', receipt, current }),
      'north',
    );
    await assert.rejects(bad.approve(input, signal()), { code: 'validation' });
  }
  for (const range of [
    [{ kind: 'file', path: '../private' }],
    [{ kind: 'directory', path: '/absolute' }],
    [
      { kind: 'file', path: 'x' },
      { kind: 'file', path: 'x' },
    ],
  ])
    assert.throws(() => workspacePublishRanges(range), { code: 'validation' });
});
test('workspace Client: an old member/view response is discarded and an account change prevents directory registration', async () => {
  const pending = Promise.withResolvers();
  let current = true;
  const api = createNativeRunApi(
    async (url, init) => (url === '/zhuma-id/session' ? Response.json(session()) : pending.promise),
    'chen',
    { spaceId: 'north', isCurrent: () => current, onUnavailable() {} },
    () => {},
  );
  const reading = api.workspaceApprovals.options(location, signal());
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  pending.resolve(
    Response.json({ type: 'server-response', rpcId: 'late', result: { ok: true, value: view } }),
  );
  await assert.rejects(reading, { name: 'AbortError' });
  let called = 0,
    invalidated = 0;
  const changed = createNativeRunApi(
    async () => Response.json(session('outside')),
    'chen',
    { spaceId: 'north', isCurrent: () => true, onUnavailable() {} },
    () => invalidated++,
    async () => {
      called++;
      return 'workspace';
    },
  );
  await assert.rejects(changed.workspaceApprovals.pickDirectory(signal()), {
    code: 'unauthenticated',
  });
  assert.equal(called, 0);
  assert.equal(invalidated, 1);
});
test('workspace picker port: cancellation, replaced services and stale member checks stop before registration', async () => {
  for (const mode of ['cancel', 'aborted', 'replaced', 'member-changed', 'registered']) {
    let created = 0,
      checks = 0;
    const pending = Promise.withResolvers(),
      controller = new AbortController();
    const picker = { pickDirectory: () => pending.promise },
      workspaces = {
        create: async ({ path }) => {
          created++;
          assert.equal(path, '/picked');
          return { workspaceId: 'registered' };
        },
      };
    let selectedPicker = picker;
    const registrar = createWorkspaceDirectoryRegistrar({
      fiber: { assertActive() {} },
      get: (name) => (name === 'uiWorkspace' ? selectedPicker : workspaces),
    });
    const operation = registrar(controller.signal, async () => {
      checks++;
      if (mode === 'member-changed') throw new DOMException('changed', 'AbortError');
    });
    if (mode === 'aborted') controller.abort();
    if (mode === 'replaced') selectedPicker = { ...picker };
    pending.resolve(mode === 'cancel' ? null : '/picked');
    if (['aborted', 'replaced', 'member-changed'].includes(mode))
      await assert.rejects(operation, { name: 'AbortError' });
    else assert.equal(await operation, mode === 'cancel' ? null : 'registered');
    assert.equal(created, mode === 'registered' ? 1 : 0);
    assert.equal(checks, ['member-changed', 'registered'].includes(mode) ? 1 : 0);
  }
});
test('workspace UI projection: first empty configuration offers directory management without selecting or starting a Run', () => {
  const available = { kind: 'available' },
    unavailable = { kind: 'unavailable', message: 'unavailable' };
  const target = {
    ...location,
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    title: 'Work',
  };
  const html = renderToStaticMarkup(
    createElement(NativeRunPanel, {
      target,
      view: {
        kind: 'ready',
        run: null,
        messages: [],
        hasEarlier: false,
        selection: null,
        models: { kind: 'ready', items: [] },
        experts: { kind: 'ready', items: [] },
        resources: [],
        workspaces: [],
        actions: {
          start: available,
          send: { followup: unavailable, steer: unavailable, queue: unavailable },
          stop: unavailable,
        },
      },
      onManageWorkspaces() {
        assert.fail('render must not invoke a command');
      },
      onSelectionChange() {
        assert.fail('render must not choose a workspace');
      },
      onStart: async () => assert.fail(),
      onSend: async () => assert.fail(),
      onStop: async () => assert.fail(),
      onRefresh: async () => assert.fail(),
      onLoadEarlier: async () => assert.fail(),
    }),
  );
  assert.match(html, /执行范围/);
  assert.match(html, /管理目录授权/);
  assert.doesNotMatch(html, /\/owned\/project|grantId|deviceId/);
});
