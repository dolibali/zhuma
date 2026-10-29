/** Actual navigation glue with fake UI/member ports; no browser/Host authority proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installMemberNativeNavigation } from '../dist/run/MemberNativeNavigation.js';
function setup() {
  let guard,
    session = {
      status: 'authenticated',
      epoch: 1,
      session: {
        accountId: 'member',
        spaces: [{ id: 'personal', kind: 'personal', name: 'Personal' }],
      },
    };
  let lookup = async () => ({ kind: 'ordinary' });
  const listeners = new Set(),
    effects = [],
    entries = [];
  const backend = {
    getSnapshot: () => ({
      phase: 'ready',
      selection: { origin: 'http://backend.invalid', connectionId: 'connection' },
    }),
    subscribe: () => () => {},
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
      register(options) {
        entries.push(options);
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
    getSnapshot: () => ({ space: { status: 'ready', space: { id: 'personal' } } }),
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
  await assert.rejects(h.guard('ordinary', AbortSignal.timeout(1000)));
  assert.equal(h.state.getSnapshot(), undefined);
  h.close();
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
  h.close();
});
