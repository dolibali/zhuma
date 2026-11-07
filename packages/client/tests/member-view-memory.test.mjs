/** Contract: a later visit paints the last read before any new request. Not a live GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { MemberSessionBoundary } from '../dist/identity/MemberSessionBoundary.js';
import { WorkbenchPage } from '../dist/workbench/WorkbenchPage.js';
import { StartablePlansPanel } from '../dist/execution/StartablePlansPanel.js';
import { ExecutionWorkspace } from '../dist/execution/ExecutionWorkspace.js';
import {
  forgetMemberViews,
  recallMemberInbox,
  recallMemberPlans,
  recallMemberWorkbench,
  rememberMemberInbox,
  rememberMemberPlans,
  rememberMemberWorkbench,
} from '../dist/execution/member-view-memory.js';

const appearance = { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} };
const scope = (accountId, spaceId) => ({ accountId, spaceId });

test('member view memory keeps one account and drops it on sign-out', () => {
  forgetMemberViews();
  const { state } = fixture();
  rememberMemberWorkbench('ann', 'north', { state, model: 'contract' });
  rememberMemberPlans('ann', 'north', []);
  rememberMemberInbox('ann', 'south', { items: [], nodes: [] });
  assert.equal(recallMemberWorkbench('ann', 'north')?.model, 'contract');
  assert.deepEqual(recallMemberPlans('ann', 'north'), []);
  assert.deepEqual(recallMemberInbox('ann', 'south'), { items: [], nodes: [] });
  rememberMemberWorkbench('bo', 'north', { state, model: 'other' });
  assert.equal(recallMemberWorkbench('ann', 'north'), undefined);
  assert.equal(recallMemberPlans('ann', 'north'), undefined);
  assert.equal(recallMemberWorkbench('bo', 'north')?.model, 'other');
  const session = {
    accountId: 'bo',
    principal: { kind: 'zhuma-member', memberId: 'bo' },
    peerId: 'peer',
    spaces: [],
  };
  const boundary = (status) =>
    renderToStaticMarkup(
      createElement(MemberSessionBoundary, {
        api: {},
        controller: {
          getSnapshot: () =>
            status === 'authenticated' ? { status, epoch: 1, session } : { status },
          subscribe: () => () => {},
          restore() {},
          dispose() {},
          login() {},
          logout() {},
          invalidate() {},
        },
        children: () => 'kept',
      }),
    );
  assert.match(boundary('authenticated'), /kept/);
  assert.equal(recallMemberWorkbench('bo', 'north')?.model, 'other');
  assert.match(boundary('signed-out'), /登录工作台/);
  assert.equal(recallMemberWorkbench('bo', 'north'), undefined);
  assert.equal(boundary('authenticated').includes('kept'), true);
  rememberMemberWorkbench('bo', 'north', { state, model: 'other' });
  assert.match(boundary('signing-out'), /正在退出登录/);
  assert.equal(recallMemberWorkbench('bo', 'north'), undefined);
  forgetMemberViews();
});

test('member view memory paints the last workbench and work lists without a connection shell', () => {
  forgetMemberViews();
  const { state } = fixture();
  const calls = [];
  const api = {
    snapshot() {
      calls.push('snapshot');
      return Promise.resolve({ state, model: 'contract' });
    },
  };
  const cold = renderToStaticMarkup(
    createElement(WorkbenchPage, {
      api,
      initialSection: 'tasks',
      appearance,
      viewScope: scope('ann', 'north'),
    }),
  );
  assert.match(cold, /正在连接工作台/);
  assert.equal(cold.includes('账号登录'), false);
  assert.deepEqual(calls, []);
  rememberMemberWorkbench('ann', 'north', { state, model: 'contract' });
  const again = renderToStaticMarkup(
    createElement(WorkbenchPage, {
      api,
      initialSection: 'tasks',
      appearance,
      viewScope: scope('ann', 'north'),
    }),
  );
  assert.match(again, /账号登录/);
  assert.equal(again.includes('正在连接工作台'), false);
  const other = renderToStaticMarkup(
    createElement(WorkbenchPage, {
      api,
      initialSection: 'tasks',
      appearance,
      viewScope: scope('ann', 'south'),
    }),
  );
  assert.match(other, /正在连接工作台/);
  assert.equal(other.includes('账号登录'), false);
  assert.deepEqual(calls, []);

  const plans = {
    startable() {
      calls.push('startable');
      return Promise.resolve({ plans: [] });
    },
  };
  const unreadPlans = renderToStaticMarkup(
    createElement(StartablePlansPanel, {
      api: plans,
      onStarted() {},
      viewScope: scope('ann', 'north'),
    }),
  );
  assert.match(unreadPlans, /正在读取计划/);
  rememberMemberPlans('ann', 'north', []);
  const readPlans = renderToStaticMarkup(
    createElement(StartablePlansPanel, {
      api: plans,
      onStarted() {},
      viewScope: scope('ann', 'north'),
    }),
  );
  assert.match(readPlans, /暂无待开始的计划/);
  assert.equal(readPlans.includes('正在读取计划'), false);
  assert.equal(readPlans.includes('aria-busy="true"'), false);

  const inbox = {
    inbox() {
      calls.push('inbox');
      return Promise.resolve({ items: [], nodes: [] });
    },
  };
  const unreadInbox = renderToStaticMarkup(
    createElement(ExecutionWorkspace, { api: inbox, viewScope: scope('ann', 'north') }),
  );
  assert.equal(unreadInbox.includes('现在没有需要你处理的工作'), false);
  assert.match(unreadInbox, /aria-busy="true"/);
  rememberMemberInbox('ann', 'north', { items: [], nodes: [] });
  const readInbox = renderToStaticMarkup(
    createElement(ExecutionWorkspace, { api: inbox, viewScope: scope('ann', 'north') }),
  );
  assert.match(readInbox, /现在没有需要你处理的工作/);
  assert.equal(readInbox.includes('aria-busy="true"'), false);
  assert.deepEqual(calls, []);
  forgetMemberViews();
});

const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
test(
  'remembered workbench stays visible while the next read is still pending',
  { skip: !domModule && 'set ZHUMA_NATIVE_PANEL_DOM_MODULE for in-memory DOM contracts' },
  async (t) => {
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
      'HTMLInputElement',
      'ResizeObserver',
    ]) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: name === 'window' ? window : window[name],
      });
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    forgetMemberViews();
    const { state } = fixture();
    const next = structuredClone(state);
    next.tasks[0] = { ...next.tasks[0], title: '刷新后的任务' };
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const api = {
      snapshot() {
        calls += 1;
        return gate.then(() => ({ state: next, model: 'contract' }));
      },
    };
    rememberMemberWorkbench('ann', 'north', { state, model: 'contract' });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    t.after(async () => {
      await act(async () => root.unmount());
      container.remove();
      forgetMemberViews();
    });
    await act(async () => {
      root.render(
        createElement(WorkbenchPage, {
          api,
          initialSection: 'tasks',
          appearance,
          viewScope: scope('ann', 'north'),
        }),
      );
    });
    assert.match(container.textContent, /账号登录/);
    assert.equal(container.textContent.includes('正在连接工作台'), false);
    assert.equal(calls, 1);
    await act(async () => {
      release();
      await gate;
    });
    assert.match(container.textContent, /刷新后的任务/);
    assert.equal(container.textContent.includes('正在连接工作台'), false);
    assert.equal(container.textContent.includes('账号登录'), false);

    let releasePlans;
    const plansGate = new Promise((resolve) => {
      releasePlans = resolve;
    });
    rememberMemberPlans('ann', 'north', []);
    const plansHost = document.createElement('div');
    document.body.append(plansHost);
    const plansRoot = createRoot(plansHost);
    t.after(async () => {
      await act(async () => plansRoot.unmount());
      plansHost.remove();
    });
    await act(async () => {
      plansRoot.render(
        createElement(StartablePlansPanel, {
          api: {
            startable() {
              return plansGate.then(() => ({ plans: [] }));
            },
          },
          onStarted() {},
          viewScope: scope('ann', 'north'),
        }),
      );
    });
    assert.match(plansHost.textContent, /暂无待开始的计划/);
    assert.equal(plansHost.textContent.includes('正在读取计划'), false);
    assert.equal(plansHost.querySelector('button')?.getAttribute('aria-busy'), null);
    await act(async () => {
      releasePlans();
      await plansGate;
    });
    assert.match(plansHost.textContent, /暂无待开始的计划/);
    assert.equal(plansHost.textContent.includes('正在读取计划'), false);

    let releaseInbox;
    const inboxGate = new Promise((resolve) => {
      releaseInbox = resolve;
    });
    rememberMemberInbox('ann', 'north', { items: [], nodes: [] });
    const inboxHost = document.createElement('div');
    document.body.append(inboxHost);
    const inboxRoot = createRoot(inboxHost);
    t.after(async () => {
      await act(async () => inboxRoot.unmount());
      inboxHost.remove();
    });
    await act(async () => {
      inboxRoot.render(
        createElement(ExecutionWorkspace, {
          api: {
            inbox() {
              return inboxGate.then(() => ({ items: [], nodes: [] }));
            },
          },
          viewScope: scope('ann', 'north'),
        }),
      );
    });
    assert.match(inboxHost.textContent, /现在没有需要你处理的工作/);
    assert.equal(inboxHost.querySelector('button')?.getAttribute('aria-busy'), null);
    await act(async () => {
      releaseInbox();
      await inboxGate;
    });
    assert.match(inboxHost.textContent, /现在没有需要你处理的工作/);
    assert.equal(inboxHost.querySelector('button')?.getAttribute('aria-busy'), null);
  },
);
