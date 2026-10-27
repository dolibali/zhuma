/** React/SSR + explicit in-memory DOM contracts, not browser or native GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { row, target, unknown, value } from './task-progress-fixture.mjs';

const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
if (domModule) {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
  const window = new Window({ url: 'http://localhost/' });
  for (const name of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Document',
    'Node',
    'Event',
    'MouseEvent',
    'MutationObserver',
  ]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? window : window[name],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
const { createElement: el, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { TaskProgressSummary, taskProgressFacts } =
  await import('../dist/execution/TaskProgressSummary.js');
const { useTaskProgress } = await import('../dist/execution/useTaskProgress.js');
const { ProjectHub } = await import('../dist/workbench/ProjectHub.js');
const tick = () => new Promise(setImmediate);

test('task progress UI: execution, review, current acceptance and held resources remain independent facts', () => {
  const html = renderToStaticMarkup(
    el(TaskProgressSummary, { progress: { state: 'ready', row: row() } }),
  );
  for (const text of [
    '已接受 2/5',
    '执行中 2',
    '待评审 1',
    '执行资源持有 2',
    '评审资源持有 1',
    '人工 3',
    '专家 2',
  ])
    assert.ok(html.includes(text), text);
  const accepted = row({
    delivery: 'all-accepted',
    acceptedNodes: 5,
    byStatus: { ...row().byStatus, running: 0, 'in-review': 0, completed: 5 },
  });
  const facts = taskProgressFacts(accepted).join(' · ');
  assert.match(facts, /产物全部已接受 5\/5/);
  assert.match(facts, /评审资源持有 1/);
  assert.doesNotMatch(facts, /排空|资源已释放|Agent.*运行/);
  assert.doesNotMatch(taskProgressFacts(unknown()).join(' '), /\d+\s*\/\s*\d+|100%/);
  assert.match(taskProgressFacts(row({ delivery: 'mixed-terminal' })).join(' '), /未全部交付/);
  assert.match(taskProgressFacts(row({ delivery: 'cancelled' })).join(' '), /全部已取消/);
  const data = fixture();
  const project = renderToStaticMarkup(
    el(ProjectHub, {
      project: data.state.projects[0],
      state: data.state,
      tab: 'work',
      changeTab() {},
      openTask() {},
      createTask() {},
      edit() {},
      taskProgress: () => ({ state: 'ready', row: accepted }),
    }),
  );
  assert.match(project, /产物全部已接受 5\/5/);
  assert.match(project, /计划草稿/); // A newer draft does not erase an earlier confirmed delivery.
});

test(
  'task progress DOM: sequential batches <=5, original API/space/plan generations and late replies cannot restore old rows',
  { skip: !domModule },
  async (t) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    t.after(async () => {
      await act(async () => root.unmount());
      container.remove();
    });
    const targets = Array.from({ length: 6 }, (_, index) => ({
      ...target,
      taskId: `task-${index}`,
      planId: `plan-${index}`,
    }));
    const pending = Promise.withResolvers();
    const oldCalls = [],
      calls = [];
    const oldApi = {
      read(query, signal) {
        oldCalls.push({ query, signal });
        return pending.promise;
      },
    };
    const api = {
      async read(query, signal) {
        calls.push({ query, signal });
        return value(query.plans.map((ref) => row({ target: ref })));
      },
    };
    function Harness({ service, refs = targets, space = 'north', token = 0 }) {
      const progress = useTaskProgress(service, space, refs, token);
      return el(
        'div',
        {},
        el('button', { onClick: progress.refresh }, '刷新进度'),
        ...refs.map((ref) =>
          el(
            'div',
            { key: ref.taskId },
            el(TaskProgressSummary, { progress: progress.get(ref.taskId) }),
          ),
        ),
      );
    }
    await act(async () => {
      root.render(el(Harness, { service: oldApi }));
      await tick();
    });
    assert.equal(oldCalls.length, 1);
    assert.equal(oldCalls[0].query.plans.length, 5);
    assert.match(container.textContent, /正在读取进度/);
    await act(async () => {
      root.render(el(Harness, { service: api }));
      await tick();
    });
    assert.equal(oldCalls[0].signal.aborted, true);
    assert.deepEqual(
      calls.map((call) => call.query.plans.length),
      [5, 1],
    );
    assert.match(container.textContent, /执行中 2/);
    await act(async () => {
      pending.resolve(value(targets.slice(0, 5).map((ref) => unknown())));
      await tick();
    });
    assert.equal(oldCalls.length, 1);
    assert.doesNotMatch(container.textContent, /进度未知/);
    const waiting = Promise.withResolvers();
    const changed = {
      read(query, signal) {
        calls.push({ query, signal });
        return waiting.promise;
      },
    };
    const next = [{ ...targets[0], revision: 3 }];
    await act(async () => {
      root.render(el(Harness, { service: changed, refs: next, space: 'south' }));
      await tick();
    });
    assert.doesNotMatch(container.textContent, /已接受 2\/5/);
    assert.match(container.textContent, /正在读取进度/);
    assert.equal(calls.at(-1).query.spaceId, 'south');
    assert.equal(calls.at(-1).query.plans[0].revision, 3);
    await act(async () => {
      waiting.resolve(value([{ ...unknown(), target: next[0] }], { spaceId: 'south' }));
      await tick();
    });
    assert.match(container.textContent, /进度未知/);
    await act(async () => {
      root.render(el(Harness, { service: api, refs: next, token: 1 }));
      await tick();
    });
    const before = calls.length;
    await act(async () => {
      container.querySelector('button').click();
      await tick();
    });
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).query.plans[0].revision, 3);
  },
);
