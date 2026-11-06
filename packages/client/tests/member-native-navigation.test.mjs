/** Actual navigation glue with fake UI/member ports; no browser/Host authority proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  installMemberNativeNavigation,
  nativeSessionPanel,
} from '../dist/run/MemberNativeNavigation.js';
function setup() {
  let guard,
    component,
    shellLeave,
    session = {
      status: 'authenticated',
      epoch: 1,
      session: {
        accountId: 'member',
        spaces: [{ id: 'personal', kind: 'personal', name: 'Personal' }],
      },
    };
  let lookup = async () => ({ kind: 'ordinary' });
  let fetcher = () => assert.fail('Navigation must not start a Run or query model metadata');
  const delegates = new Map(),
    released = [];
  let space = { status: 'ready', epoch: 1, space: { id: 'personal' } };
  let backendState = {
    phase: 'ready',
    selection: { origin: 'http://backend.invalid', connectionId: 'connection' },
  };
  const listeners = new Set(),
    backendListeners = new Set(),
    effects = [],
    entries = [],
    views = [];
  const backend = {
    getSnapshot: () => backendState,
    subscribe(fn) {
      backendListeners.add(fn);
      return () => backendListeners.delete(fn);
    },
  };
  const ctx = {
    conversation: { blocks: { set() {}, forget() {} } },
    get(name) {
      if (name === 'sessions')
        return {
          registerSessionDelegate(id, delegate) {
            assert.equal(delegates.has(id), false);
            delegates.set(id, delegate);
            return () => {
              delegates.delete(id);
            };
          },
        };
      return {
        clearSessionSelection(id) {
          released.push(id);
        },
        registerSessionNavigationGuard(fn) {
          guard = fn;
          return () => {
            guard = undefined;
          };
        },
      };
    },
    slots: {
      inject(_name, fn) {
        fn();
      },
      register(options, view) {
        entries.push(options);
        views.push({ options, view });
        if (options.name === 'shell.overlay') component = view;
        return () => {};
      },
    },
    effect(fn) {
      effects.push(fn());
    },
  };
  const shell = {
    session: {
      getSnapshot: () => session,
      invalidate() {
        assert.fail();
      },
    },
    getSnapshot: () => ({ space }),
    requestLeave(proceed, signal) {
      if (shellLeave) shellLeave(proceed, signal);
      else proceed();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const scopes = [];
  let panel = { activePanelId: 'zhuma-workbench' },
    navigation = new AbortController(),
    leaveRequests = 0,
    lastSignal;
  const panelListeners = new Set();
  const layout = {
    panelInfo: {
      getSnapshot: () => panel,
      subscribe(fn) {
        panelListeners.add(fn);
        return () => panelListeners.delete(fn);
      },
    },
    beginNavigation() {
      navigation.abort();
      navigation = new AbortController();
      return navigation.signal;
    },
    selectPanel(target) {
      const signal = this.beginNavigation();
      const proceed = () => {
        if (signal.aborted) return;
        panel = { activePanelId: target };
        panelListeners.forEach((fn) => fn());
      };
      if (!state.guardPanel(target, proceed, signal)) shell.requestLeave(proceed, signal);
    },
  };
  ctx.layout = layout;
  shell.registerLeaveGuard = (_epoch, handler) => {
    shellLeave = handler;
    return () => {
      if (shellLeave === handler) shellLeave = undefined;
    };
  };
  shell.registerSpaceGuard = () => () => {};
  const requestLeave = shell.requestLeave;
  shell.requestLeave = (...args) => {
    leaveRequests++;
    requestLeave(...args);
  };
  const state = installMemberNativeNavigation(ctx, {
    shell,
    backend,
    native: {
      scoped(...args) {
        scopes.push(args);
        return {
          lookup: (...args) => lookup(...args),
          fetcher: (...args) => fetcher(...args),
        };
      },
    },
    directory: {},
    openModelSettings() {
      assert.fail();
    },
  });
  return {
    state,
    entries,
    scopes,
    delegates,
    released,
    setFetcher(fn) {
      fetcher = fn;
    },
    guard: (value, signal, intent) => {
      lastSignal = AbortSignal.any([signal, layout.beginNavigation()]);
      return guard(value, lastSignal, intent);
    },
    guardSignal: () => lastSignal,
    layout,
    panel: () => panel.activePanelId,
    leaveRequests: () => leaveRequests,
    setLookup: (fn) => {
      lookup = fn;
    },
    setSession(value) {
      session = value;
      listeners.forEach((fn) => fn());
    },
    setSpace(value) {
      space = value;
      listeners.forEach((fn) => fn());
    },
    setBackend(value) {
      backendState = value;
      backendListeners.forEach((fn) => fn());
    },
    render: () => renderToStaticMarkup(createElement(component, { state })),
    renderMain: () => {
      const main = views.find((v) => v.options.name === 'main');
      return renderToStaticMarkup(createElement(main.view, { state }));
    },
    renderTaskControls: (sessionId) => {
      const controls = views.find(
        (v) => v.options.name === 'conversation.session.header.utilities',
      );
      return renderToStaticMarkup(createElement(controls.view, { state, sessionId }));
    },
    change() {
      session = { ...session, epoch: 2 };
      listeners.forEach((fn) => fn());
    },
    close() {
      effects.toReversed().forEach((fn) => fn?.());
    },
  };
}
const task = {
  kind: 'task',
  presentation: 'sdk-native',
  sessionId: 'actual-native-session',
  target: {
    spaceId: 'team',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'actual-run',
    generation: 2,
    segmentId: 'segment',
  },
};
test('local task A/B/A permits original mainView only after exact delegation, then blanks and releases on member change', async () => {
  const h = setup();
  h.setBackend({ phase: 'ready', selection: { origin: null, connectionId: null } });
  const second = {
    ...task,
    sessionId: 'native-B',
    target: { ...task.target, nodeId: 'node-B', runId: 'run-B' },
  };
  h.setLookup(async (id) => (id === second.sessionId ? second : task));
  h.setFetcher(async (path, init) => {
    if (path === '/zhuma-id/session')
      return Response.json({
        ok: true,
        accountId: 'member',
        peerId: 'fixture',
        principal: { kind: 'zhuma-member', memberId: 'member' },
        spaces: [{ id: 'team', kind: 'team', name: 'Team' }],
      });
    assert.equal(path, '/api/zhuma-run/read');
    const wire = JSON.parse(init.body);
    const selected = wire.payload.runId === second.target.runId ? second : task;
    return Response.json({
      type: 'server-response',
      rpcId: wire.rpcId,
      result: {
        ok: true,
        value: {
          ...selected.target,
          nodeVersion: 1,
          runVersion: 1,
          status: 'running',
          dispatch: 'received',
          resources: 'held',
          acknowledged: true,
          stopPhase: 'none',
          native: { sessionId: selected.sessionId, agentId: selected.sessionId, status: 'running' },
          sendCapabilities: {
            followup: { kind: 'available' },
            queue: { kind: 'available' },
            steer: { kind: 'available' },
          },
        },
      },
    });
  });
  let previous;
  for (const selected of [task, second, task]) {
    assert.equal(await h.guard(selected.sessionId, new AbortController().signal), true);
    assert.deepEqual([...h.delegates.keys()], [selected.sessionId]);
    assert.equal(h.state.getSnapshot().sessionId, selected.sessionId);
    assert.deepEqual(h.state.getSnapshot().location, selected.target);
    if (previous) assert.equal(previous.signal.aborted, true);
    previous = h.delegates.get(selected.sessionId);
  }
  h.change();
  assert.equal(h.state.getSnapshot(), undefined);
  assert.equal(previous.signal.aborted, true);
  assert.equal(h.delegates.size, 0);
  assert.deepEqual(h.released, [task.sessionId, second.sessionId, task.sessionId]);
  h.close();
});
test('local unqualified or unsupported bindings preserve original task controls without SDK retention', async () => {
  for (const presentation of [undefined, 'task-controls', 'unsupported-engine']) {
    const h = setup();
    h.setBackend({ phase: 'ready', selection: { origin: null, connectionId: null } });
    h.setLookup(async () => ({ ...task, presentation }));
    assert.equal(await h.guard(task.sessionId, new AbortController().signal), false);
    assert.equal(h.delegates.size, 0);
    assert.equal(h.state.getSnapshot().conversation, undefined);
    assert.equal(h.panel(), nativeSessionPanel);
    h.close();
  }
});
test('task Conversation controls wait for physical stop confirmation and resource settlement', async () => {
  const h = setup();
  h.setBackend({ phase: 'ready', selection: { origin: null, connectionId: null } });
  h.setLookup(async () => task);
  let phase = { status: 'cancelled', resources: 'held', stopPhase: 'requested' };
  h.setFetcher(async (path, init) => {
    if (path === '/zhuma-id/session')
      return Response.json({
        ok: true,
        accountId: 'member',
        peerId: 'fixture',
        principal: { kind: 'zhuma-member', memberId: 'member' },
        spaces: [{ id: 'team', kind: 'team', name: 'Team' }],
      });
    assert.equal(path, '/api/zhuma-run/read');
    const wire = JSON.parse(init.body);
    return Response.json({
      type: 'server-response',
      rpcId: wire.rpcId,
      result: {
        ok: true,
        value: {
          ...task.target,
          nodeVersion: 1,
          runVersion: 1,
          dispatch: 'received',
          acknowledged: true,
          ...phase,
          native: { sessionId: task.sessionId, agentId: task.sessionId, status: 'idle' },
          sendCapabilities: {
            followup: { kind: 'available' },
            queue: { kind: 'available' },
            steer: { kind: 'available' },
          },
        },
      },
    });
  });
  assert.equal(await h.guard(task.sessionId, new AbortController().signal), true);
  assert.match(h.renderTaskControls(task.sessionId), /正在停止/);
  assert.doesNotMatch(h.renderTaskControls(task.sessionId), /已停止/);
  for (const [next, expected] of [
    [{ status: 'cancelled', resources: 'held', stopPhase: 'confirmed' }, /等待停止确认/],
    [{ status: 'cancelled', resources: 'settled', stopPhase: 'confirmed' }, /已停止/],
    [{ status: 'cancelled', resources: 'held', stopPhase: 'receipt-rejected' }, /停止未确认/],
    [{ status: 'completed', resources: 'held', stopPhase: 'none' }, /任务已结束，正在收尾/],
  ]) {
    phase = next;
    await h.state.getSnapshot().conversation.refresh();
    assert.match(h.renderTaskControls(task.sessionId), expected);
    if (next.stopPhase !== 'confirmed' || next.resources !== 'settled')
      assert.doesNotMatch(h.renderTaskControls(task.sessionId), /已停止/);
  }
  h.close();
});
test('original review Session opens its read-only purpose view with no work/model API call', async () => {
  const h = setup();
  h.setLookup(async () => ({
    kind: 'review',
    sessionId: 'review-session',
    runId: 'review-run',
    target: {
      spaceId: 'team',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      roundId: 'round',
      artifactVersionId: 'artifact',
    },
  }));
  assert.equal(await h.guard('review-session', new AbortController().signal), false);
  const entry = h.state.getSnapshot();
  assert.equal(entry.kind, 'review');
  assert.equal(entry.sessionId, 'review-session');
  assert.equal(entry.query.roundId, 'round');
  assert.equal(
    'start' in entry.api,
    true,
    'the purpose API is separate; navigation itself calls none of it',
  );
  h.close();
});
test('Workspace task navigation opens the same controlled Run without returning ordinary-retain permission or starting work', async () => {
  const h = setup();
  h.setLookup(async () => task);
  assert.equal(await h.guard('actual-native-session', AbortSignal.timeout(1000)), false);
  assert.ok(h.entries.some((entry) => entry.name === 'main' && entry.key === nativeSessionPanel));
  assert.deepEqual(h.scopes.at(-1), ['member', 'team', 'actual-run']);
  assert.equal(h.state.getSnapshot().target.nodeId, 'node');
  assert.equal(
    h.state.getSnapshot().api.workflow,
    undefined,
    'History navigation is not a plan control entry',
  );
  assert.equal(h.state.getSnapshot().api.workspaceApprovals, undefined);
  h.change();
  assert.equal(h.state.getSnapshot(), undefined);
  h.close();
});
test('Workspace ordinary navigation passes only an exact genuine ordinary classification', async () => {
  const h = setup();
  assert.equal(await h.guard('ordinary', AbortSignal.timeout(1000)), true);
  h.setLookup(async () => ({ kind: 'ordinary', extra: 'unknown' }));
  assert.equal(await h.guard('ordinary', AbortSignal.timeout(1000)), false);
  assert.match(h.state.getNoticeSnapshot(), /确认当前账号、所选空间和服务连接/);
  assert.equal(h.state.getSnapshot(), undefined);
  h.close();
});

test('Workspace authority failure is visible and neutral without ordinary fallback or raw error details', async () => {
  const h = setup();
  const raw = 'run-authority-unavailable private-session-id /private/example credential-value';
  h.setLookup(async () => {
    throw Error(raw);
  });
  assert.equal(await h.guard('unavailable-session', AbortSignal.timeout(1000)), false);
  assert.equal(h.state.getSnapshot(), undefined);
  const markup = h.render();
  assert.match(markup, /暂时无法打开会话/);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /从侧栏重新打开/);
  assert.match(markup, /知道了/);
  for (const secret of raw.split(' ')) assert.equal(markup.includes(secret), false);
  h.state.dismissNotice();
  assert.equal(h.state.getNoticeSnapshot(), undefined);
  assert.equal(h.render().includes('暂时无法打开会话'), false);
  h.close();
});

test('Workspace missing login, connection or ready space gives instructions before any lookup', async () => {
  for (const [change, expected] of [
    [(h) => h.setSession({ status: 'anonymous', epoch: 2 }), /先登录账号/],
    [(h) => h.setBackend({ phase: 'loading', selection: undefined }), /服务连接尚未就绪/],
    [(h) => h.setSpace({ status: 'error', epoch: 2 }), /空间目录尚未就绪/],
  ]) {
    const h = setup();
    change(h);
    h.setLookup(() => assert.fail('No lookup before member/connection/space is ready'));
    assert.equal(await h.guard('session', AbortSignal.timeout(1000)), false);
    assert.match(h.state.getNoticeSnapshot(), expected);
    assert.deepEqual(h.scopes, []);
    assert.equal(h.state.getSnapshot(), undefined);
    h.close();
  }
});

test('implicit startup restoration stays refused and quiet while logged out; explicit and legacy opens retain visible refusal', async () => {
  const h = setup();
  h.setSession({ status: 'anonymous', epoch: 2 });
  h.setLookup(() => assert.fail('Logged-out restore must not look up or resume a Session'));
  assert.equal(await h.guard('initial-blank', AbortSignal.timeout(1000), 'restore'), false);
  assert.equal(h.state.getNoticeSnapshot(), undefined);
  assert.deepEqual(h.scopes, []);
  assert.equal(h.state.getSnapshot(), undefined);
  for (const intent of ['explicit', undefined]) {
    assert.equal(await h.guard('chosen-session', AbortSignal.timeout(1000), intent), false);
    assert.match(h.state.getNoticeSnapshot(), /先登录账号/);
  }
  h.close();
});

test('restore provenance never bypasses authenticated service, space or session authority', async () => {
  for (const [change, expected] of [
    [(h) => h.setBackend({ phase: 'loading', selection: undefined }), /服务连接尚未就绪/],
    [(h) => h.setSpace({ status: 'error', epoch: 2 }), /空间目录尚未就绪/],
    [
      (h) =>
        h.setLookup(async () => {
          throw Error('original authority refused');
        }),
      /确认当前账号/,
    ],
  ]) {
    const h = setup();
    change(h);
    assert.equal(await h.guard('saved-session', AbortSignal.timeout(1000), 'restore'), false);
    assert.match(h.state.getNoticeSnapshot(), expected);
    assert.equal(h.state.getSnapshot(), undefined);
    h.close();
  }
});

test('Workspace session mismatch shows no target metadata and never opens the controlled view', async () => {
  const h = setup();
  h.setLookup(async () => ({ ...task, sessionId: 'different-session' }));
  assert.equal(await h.guard('requested-session', AbortSignal.timeout(1000)), false);
  assert.equal(h.state.getSnapshot(), undefined);
  assert.match(h.state.getNoticeSnapshot(), /确认当前账号/);
  assert.equal(h.render().includes('different-session'), false);
  assert.equal(h.render().includes('actual-run'), false);
  h.close();
});

test('Workspace ignored-abort failures after space/backend/member changes never publish a notice', async () => {
  for (const change of [
    (h) => h.setSpace({ status: 'ready', epoch: 2, space: { id: 'other' } }),
    (h) => h.setSpace({ status: 'ready', epoch: 2, space: { id: 'personal' } }),
    (h) => h.setBackend({ phase: 'ready', selection: { connectionId: 'other' } }),
    (h) => h.change(),
    (h) => h.state.close(),
    (h) => h.close(),
  ]) {
    const h = setup();
    const gate = Promise.withResolvers();
    h.setLookup(() => gate.promise);
    const pending = h.guard('old-selection', AbortSignal.timeout(1000));
    change(h);
    gate.reject(Error('late unavailable reply'));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(h.state.getSnapshot(), undefined);
    assert.equal(h.state.getNoticeSnapshot(), undefined);
    h.close();
  }
});

test('Workspace later selection supersedes a lookup even when the old reply ignores its signal', async () => {
  const h = setup();
  const gate = Promise.withResolvers();
  h.setLookup((sessionId) => (sessionId === 'old' ? gate.promise : { kind: 'ordinary' }));
  const pending = h.guard('old', AbortSignal.timeout(1000));
  assert.equal(await h.guard('new', AbortSignal.timeout(1000)), true);
  gate.resolve(task);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.state.getSnapshot(), undefined);
  assert.equal(h.state.getNoticeSnapshot(), undefined);
  h.close();
});

test('Workspace controlled task history closes and fences its API when selected space changes', async () => {
  const h = setup();
  h.setLookup(async () => task);
  assert.equal(await h.guard(task.sessionId, AbortSignal.timeout(1000)), false);
  const entry = h.state.getSnapshot();
  h.setSpace({ status: 'ready', epoch: 2, space: { id: 'other' } });
  assert.equal(h.state.getSnapshot(), undefined);
  assert.equal(h.state.getNoticeSnapshot(), undefined);
  await assert.rejects(entry.api.options(entry.target, new AbortController().signal), {
    name: 'AbortError',
  });
  h.close();
});

test('Workspace repeated task selection and ordinary navigation preserve the dirty leave guard', async () => {
  const h = setup();
  h.setLookup(async (sessionId) => (sessionId === task.sessionId ? task : { kind: 'ordinary' }));
  await h.guard(task.sessionId, AbortSignal.timeout(1000));
  const original = h.state.getSnapshot();
  let requests = 0;
  const stop = h.state.registerLeave(() => requests++);
  for (const sessionId of [task.sessionId, 'ordinary']) {
    const cancelled = new AbortController();
    const pending = h.guard(sessionId, cancelled.signal);
    await new Promise((done) => setImmediate(done));
    assert.equal(h.state.getSnapshot(), original);
    assert.equal(h.state.getNoticeSnapshot(), undefined);
    cancelled.abort();
    assert.equal(await pending, false);
    assert.equal(h.state.getSnapshot(), original);
  }
  assert.equal(requests, 2);
  stop();
  h.state.registerLeave((proceed) => proceed());
  assert.equal(await h.guard('ordinary', AbortSignal.timeout(1000)), true);
  assert.equal(h.state.getSnapshot(), undefined);
  h.close();
});

test('Workspace explicit cancellation never changes the prior view or displays an error', async () => {
  const h = setup();
  const gate = Promise.withResolvers();
  h.setLookup(() => gate.promise);
  const controller = new AbortController();
  const pending = h.guard('cancelled', controller.signal);
  controller.abort();
  gate.reject(Error('ignored-abort response'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.state.getSnapshot(), undefined);
  assert.equal(h.state.getNoticeSnapshot(), undefined);
  h.close();
});

test('Workspace dirty acceptance after a space change cannot open or return ordinary permission', async () => {
  for (const sessionId of [task.sessionId, 'ordinary']) {
    const h = setup();
    h.setLookup(async (id) => (id === task.sessionId ? task : { kind: 'ordinary' }));
    await h.guard(task.sessionId, AbortSignal.timeout(1000));
    let accept;
    h.state.registerLeave((proceed) => {
      accept = proceed;
    });
    const pending = h.guard(sessionId, AbortSignal.timeout(1000));
    await new Promise((done) => setImmediate(done));
    h.setSpace({ status: 'ready', epoch: 2, space: { id: 'other' } });
    assert.doesNotThrow(() => accept());
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(h.state.getSnapshot(), undefined);
    assert.equal(h.state.getNoticeSnapshot(), undefined);
    h.close();
  }
});
test('Workspace lookup cannot reveal a former member target after an ignored-abort reply', async () => {
  const h = setup();
  let resolve;
  h.setLookup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = h.guard('actual-native-session', AbortSignal.timeout(1000));
  h.change();
  resolve(task);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.state.getSnapshot(), undefined);
  h.close();
});
test('Workspace task-parent/ordinary-child address never falls through to ordinary SDK resume', async () => {
  const h = setup();
  h.setLookup(async (id) =>
    id === 'parent' ? { ...task, sessionId: 'parent' } : { kind: 'ordinary' },
  );
  assert.equal(
    await h.guard(
      { parentSessionId: 'parent', childSessionId: 'ordinary-child' },
      AbortSignal.timeout(1000),
    ),
    false,
  );
  assert.equal(h.state.getSnapshot(), undefined);
  assert.match(h.state.getNoticeSnapshot(), /确认当前账号/);
  h.close();
});

test('controlled Session handoff uses the main panel once and survives the shared SDK navigation signal replacement', async () => {
  const h = setup();
  h.setLookup(async () => task);
  assert.equal(await h.guard(task.sessionId, new AbortController().signal), false);
  assert.equal(h.panel(), nativeSessionPanel);
  assert.equal(h.leaveRequests(), 1, 'the accepted leave is not requested again for selectPanel');
  assert.equal(
    h.guardSignal().aborted,
    true,
    'public selectPanel replaces the old navigation signal',
  );
  assert.equal(h.state.getSnapshot().target.nodeId, 'node');
  assert.equal(h.state.getNoticeSnapshot(), undefined);
  const main = h.renderMain();
  assert.match(main, /zm-shell-panel/);
  assert.doesNotMatch(main, /role="dialog"/);
  assert.equal(
    h.render().includes('role="dialog"'),
    false,
    'the overlay has no second work dialog',
  );
  h.close();
});

test('main panel departure asks once and cancellation preserves the current controlled view', async () => {
  const h = setup();
  h.setLookup(async () => task);
  await h.guard(task.sessionId, new AbortController().signal);
  const original = h.state.getSnapshot();
  let requests = 0,
    accept;
  h.state.registerLeave((proceed) => {
    requests++;
    accept = proceed;
  });
  h.layout.selectPanel('zhuma-workbench');
  assert.equal(requests, 1);
  assert.equal(h.panel(), nativeSessionPanel);
  assert.equal(h.state.getSnapshot(), original, 'not proceeding keeps the same input owner');
  h.layout.selectPanel('zhuma-workbench');
  assert.equal(requests, 2, 'a later selection supersedes the cancelled one');
  accept();
  await new Promise((done) => setImmediate(done));
  assert.equal(h.panel(), 'zhuma-workbench');
  assert.equal(h.state.getSnapshot(), undefined);
  h.close();
});

test('ordinary Session selection leaves the controlled page and preserves original Conversation permission', async () => {
  const h = setup();
  h.setLookup(async (id) => (id === task.sessionId ? task : { kind: 'ordinary' }));
  await h.guard(task.sessionId, new AbortController().signal);
  let requests = 0;
  const original = h.state.getSnapshot();
  const stop = h.state.registerLeave((proceed) => {
    requests++;
    if (h.state.getSnapshot() === original) proceed();
  });
  assert.equal(await h.guard('ordinary', new AbortController().signal), true);
  assert.equal(requests, 1);
  assert.equal(h.state.getSnapshot(), undefined);
  h.layout.selectPanel(null);
  assert.equal(h.panel(), null);
  assert.equal(requests, 1, 'closed view guards retire synchronously, before React cleanup');
  stop();
  h.close();
});
