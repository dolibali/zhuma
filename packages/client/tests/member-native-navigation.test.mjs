/** Actual navigation glue with fake UI/member ports; no browser/Host authority proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installMemberNativeNavigation } from '../dist/run/MemberNativeNavigation.js';
function setup() {
  let guard,
    component,
    session = {
      status: 'authenticated',
      epoch: 1,
      session: {
        accountId: 'member',
        spaces: [{ id: 'personal', kind: 'personal', name: 'Personal' }],
      },
    };
  let lookup = async () => ({ kind: 'ordinary' });
  let space = { status: 'ready', epoch: 1, space: { id: 'personal' } };
  let backendState = {
    phase: 'ready',
    selection: { origin: 'http://backend.invalid', connectionId: 'connection' },
  };
  const listeners = new Set(),
    backendListeners = new Set(),
    effects = [],
    entries = [];
  const backend = {
    getSnapshot: () => backendState,
    subscribe(fn) {
      backendListeners.add(fn);
      return () => backendListeners.delete(fn);
    },
  };
  const ctx = {
    get() {
      return {
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
        component = view;
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
    requestLeave(proceed) {
      proceed();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const scopes = [];
  const state = installMemberNativeNavigation(ctx, {
    shell,
    backend,
    native: {
      scoped(...args) {
        scopes.push(args);
        return {
          lookup: (...args) => lookup(...args),
          fetcher: () => assert.fail('Navigation must not start a Run or query model metadata'),
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
    guard: (...args) => guard(...args),
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
  assert.equal(h.entries[0].name, 'shell.overlay');
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
