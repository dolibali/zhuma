/** Original SDK service-port contracts; no native GUI or model execution proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalWorkspaceDirectory } from '../dist/run/workspace-directory.js';
import { createNativeRunApi } from '../dist/run/api.js';

function local() {
  const opened = [];
  let snapshot = {
    phase: 'ready',
    state: 'idle',
    error: null,
    items: [{ workspaceId: 'local', title: 'Existing', path: '/local', sessionIds: ['native'] }],
  };
  let source = {
    list: { getSnapshot: () => snapshot },
    create: () => assert.fail('must not register'),
  };
  const navigation = {
    openSession: (id) => opened.push(id),
    startSession: () => assert.fail('must not start'),
  };
  const directory = createLocalWorkspaceDirectory({
    fiber: { assertActive() {} },
    get: (key) => (key === 'workspaces' ? source : navigation),
  });
  return {
    directory,
    opened,
    change: (next) => {
      snapshot = next;
    },
    replace: () => {
      source = { ...source };
    },
    snapshot: () => snapshot,
  };
}
const signal = () => new AbortController().signal;
test('local workspace selection reads the official list, preserves its order and starts nothing', async () => {
  const h = local();
  assert.deepEqual(await h.directory.read(signal(), async () => {}), [
    { id: 'local', title: 'Existing', path: '/local', sessionIds: ['native'] },
  ]);
  assert.deepEqual(h.opened, []);
  for (const next of [
    { phase: 'pending', state: 'loading' },
    { phase: 'ready', state: 'error' },
  ]) {
    h.change({ ...h.snapshot(), ...next });
    await assert.rejects(
      h.directory.read(signal(), async () => {}),
      { code: 'unavailable' },
    );
  }
});
test('local workspace navigation refuses switched member, replaced service and a directory deleted during recheck', async () => {
  for (const mode of ['member', 'service', 'deleted', 'valid']) {
    const h = local();
    let checks = 0;
    const action = h.directory.openSession('native', signal(), async () => {
      checks++;
      if (mode === 'member') throw new DOMException('changed', 'AbortError');
      if (mode === 'service') h.replace();
      if (mode === 'deleted' && checks === 2) h.change({ ...h.snapshot(), items: [] });
    });
    if (mode === 'valid') await action;
    else
      await assert.rejects(
        action,
        mode === 'deleted' ? { code: 'unavailable' } : { name: 'AbortError' },
      );
    assert.deepEqual(h.opened, mode === 'valid' ? ['native'] : []);
  }
  const h = local();
  await assert.rejects(
    h.directory.openSession('unrelated', signal(), async () => {}),
    { code: 'unavailable' },
  );
  assert.deepEqual(h.opened, []);
});
const run = {
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'run',
  generation: 1,
  segmentId: 'segment',
  nodeVersion: 2,
  runVersion: 1,
  status: 'running',
  dispatch: 'received',
  resources: 'held',
  acknowledged: false,
  stopPhase: 'none',
  native: { sessionId: 'native', agentId: 'native', status: 'idle' },
};
const available = { kind: 'available' };
const member = {
  ok: true,
  accountId: 'chen',
  principal: { kind: 'zhuma-member', memberId: 'chen' },
  peerId: 'peer',
  spaces: [{ id: 'north', kind: 'team', name: 'Team' }],
};
test('task navigation revalidates the exact original member Run before exposing its native Session', async () => {
  for (const mode of ['valid', 'generation', 'segment', 'session', 'late-member']) {
    let current = true;
    const opened = [],
      calls = [];
    const api = createNativeRunApi(
      async (url, init) => {
        calls.push(url);
        if (url === '/zhuma-id/session') return Response.json(member);
        assert.equal(url, '/api/zhuma-run/read');
        const request = JSON.parse(init.body);
        const latest = {
          ...run,
          sendCapabilities: { followup: available, steer: available, queue: available },
          ...(mode === 'generation' ? { generation: 2 } : {}),
          ...(mode === 'segment' ? { segmentId: 'new-segment' } : {}),
          ...(mode === 'session' ? { native: { ...run.native, sessionId: 'other' } } : {}),
        };
        if (mode === 'late-member') current = false;
        return Response.json({
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value: latest },
        });
      },
      'chen',
      { spaceId: 'north', isCurrent: () => current, onUnavailable() {} },
      () => {},
      undefined,
      undefined,
      {
        read: async () => [],
        openSession: async (id, signal, authorize) => {
          await authorize();
          opened.push(id);
        },
      },
    );
    const operation = api.openNativeSession(run, signal());
    if (mode === 'valid') await operation;
    else await assert.rejects(operation);
    assert.deepEqual(opened, mode === 'valid' ? ['native'] : []);
    assert.equal(
      calls.some((url) => /begin|send|connect/u.test(url)),
      false,
    );
  }
});

test('original SDK scope proxies preserve workspace selection/navigation identity', async () => {
  const { symbols } = await import('@deepseek-ai/cordis');
  const opened = [];
  const services = {
    workspaces: {
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          state: 'idle',
          items: [
            { workspaceId: 'local', title: 'Existing', path: '/local', sessionIds: ['native'] },
          ],
        }),
      },
    },
    uiWorkspace: { openSession: (id) => opened.push(id) },
  };
  const ctx = {
    fiber: { assertActive() {} },
    get(name) {
      return new Proxy(services[name], {
        get(target, key) {
          return key === symbols.original ? target : Reflect.get(target, key);
        },
      });
    },
  };
  assert.notEqual(ctx.get('workspaces'), ctx.get('workspaces'));
  const directory = createLocalWorkspaceDirectory(ctx);
  assert.equal((await directory.read(signal(), async () => {}))[0].id, 'local');
  await directory.openSession('native', signal(), async () => {});
  assert.deepEqual(opened, ['native']);
});
