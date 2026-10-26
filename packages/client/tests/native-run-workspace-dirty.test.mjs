/** React + optional installed Happy DOM contracts; no browser, Host or model authority. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
if (!domModule) {
  test(
    'Run workspace DOM contracts require the explicit installed qualification DOM module',
    { skip: true },
    () => {},
  );
} else {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
  const window = new Window({ url: 'http://localhost/' });
  for (const name of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'SVGElement',
    'Document',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLDialogElement',
    'Node',
    'Event',
    'MouseEvent',
    'MutationObserver',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'ResizeObserver',
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? window : window[name],
    });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { NativeRunLauncher } = await import('../dist/run/NativeRunWorkspace.js');
  const { ExecutionWorkspace } = await import('../dist/execution/ExecutionWorkspace.js');
  const { UnsavedChangesBoundary } = await import('../dist/workbench/UnsavedChanges.js');
  const target = {
    spaceId: 'north',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    title: 'Review current work',
  };
  const selection = {
    model: { provider: 'contract', model: 'model', maxTokens: 4096 },
    executor: { kind: 'builtin' },
  };
  const available = { kind: 'available' };
  const run = {
    ...target,
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
    nodeVersion: 2,
    runVersion: 1,
    status: 'running',
    dispatch: 'received',
    resources: 'held',
    acknowledged: true,
    stopPhase: 'none',
    native: { sessionId: 'native', agentId: 'native', status: 'idle' },
    sendCapabilities: { followup: available, steer: available, queue: available },
  };
  function api(overrides = {}) {
    return {
      options: async () => ({
        target,
        nodeVersion: 2,
        runVersion: 1,
        currentRunId: 'run',
        selection,
        models: { kind: 'ready', items: [{ id: 'model', label: 'Model', value: selection.model }] },
        experts: [
          {
            id: 'builtin',
            label: 'Builtin',
            description: 'Current node',
            value: selection.executor,
          },
        ],
        resources: [],
        start: { kind: 'unavailable', message: 'Held' },
        tools: 'text-only',
      }),
      read: async () => run,
      history: async () => ({ messages: [], nextAfter: -1 }),
      begin: async () => {
        throw Error('Must not begin on mount');
      },
      send: async () => {},
      stop: async () => {
        throw Error('Closing must not stop a Run');
      },
      ...overrides,
    };
  }
  async function mount(current = api()) {
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node),
      dirty = new Set();
    const register = (token, value) => {
      if (value) dirty.add(token);
      return () => dirty.delete(token);
    };
    const render = async (next) => {
      current = next;
      await act(async () => {
        root.render(
          h(UnsavedChangesBoundary, { register }, h(NativeRunLauncher, { api: current, target })),
        );
      });
    };
    const button = (label) =>
      [...node.querySelectorAll('button')].find(
        (item) =>
          item.getAttribute('aria-label') === label ||
          item.querySelector('.zm-button-label')?.textContent === label,
      );
    const click = async (label) => {
      const item = button(label);
      assert.ok(item, label);
      await act(async () => item.click());
    };
    await render(current);
    await click('使用 Agent');
    const input = () => {
      const item = node.querySelector('textarea');
      assert.ok(item, 'message input');
      return item;
    };
    const type = async (text) => {
      const item = input();
      item.focus();
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
          item,
          text,
        );
        item.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    };
    return {
      node,
      dirty,
      click,
      render,
      input,
      type,
      cancelDialog: async (dialog) => {
        await act(async () =>
          dialog.dispatchEvent(new window.Event('cancel', { bubbles: true, cancelable: true })),
        );
      },
      submit: async () => {
        await act(async () =>
          node
            .querySelector('form')
            .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
        );
      },
      close: async () => {
        await act(async () => root.unmount());
        node.remove();
      },
    };
  }
  test('DOM contract: close/ESC guards preserve unsent text and focus; only confirmed abandon clears this scope', async () => {
    const current = await mount();
    try {
      await current.type('Keep this unsent draft');
      const input = current.input();
      assert.equal(
        current.dirty.size,
        1,
        'existing navigation/space guard receives dirty presence',
      );
      await current.cancelDialog(current.node.querySelector('dialog'));
      assert.ok(current.node.querySelector('.zm-dialog-confirmation'));
      await current.cancelDialog(current.node.querySelector('.zm-dialog-confirmation'));
      assert.equal(current.input(), input);
      assert.equal(input.value, 'Keep this unsent draft');
      assert.equal(document.activeElement, input);
      await current.click('关闭');
      await current.click('继续编辑');
      assert.equal(input.value, 'Keep this unsent draft');
      await current.click('关闭');
      await current.click('放弃并离开');
      assert.equal(current.node.querySelector('textarea'), null);
      assert.equal(current.dirty.size, 0);
      await current.click('使用 Agent');
      assert.equal(current.input().value, '');
    } finally {
      await current.close();
    }
  });
  test('DOM contract: acknowledged send clears dirty presence; opening and closing never stop a Run', async () => {
    let sends = 0,
      stops = 0;
    const current = await mount(
      api({
        send: async () => {
          sends++;
        },
        stop: async () => {
          stops++;
        },
      }),
    );
    try {
      await current.type('Send explicitly');
      assert.equal(current.dirty.size, 1);
      await current.submit();
      assert.equal(sends, 1);
      assert.equal(current.input().value, '');
      assert.equal(current.dirty.size, 0);
      await current.click('关闭');
      assert.equal(current.node.querySelector('.zm-dialog-confirmation'), null);
      assert.equal(stops, 0);
    } finally {
      await current.close();
    }
  });
  test('DOM contract: real API/controller replacement immediately fences old draft and late send without transfer', async () => {
    const late = Promise.withResolvers();
    let nextSends = 0;
    const current = await mount(api({ send: async () => late.promise }));
    try {
      await current.type('Old account input');
      await current.submit();
      await current.render(
        api({
          send: async () => {
            nextSends++;
          },
        }),
      );
      assert.equal(current.node.querySelector('textarea'), null);
      assert.equal(current.node.querySelector('.zm-dialog-confirmation'), null);
      assert.equal(current.dirty.size, 0);
      await current.click('使用 Agent');
      assert.equal(current.input().value, '');
      await current.type('New account input');
      await act(async () => late.resolve());
      assert.equal(current.input().value, 'New account input');
      assert.equal(current.dirty.size, 1);
      assert.equal(nextSends, 0);
    } finally {
      late.resolve();
      await current.close();
    }
  });

  test('DOM contract: human submission and revision launch Agent from the delivery heading while preserving the form', async () => {
    for (const action of ['submit', 'revise']) {
      const node = document.createElement('div');
      document.body.append(node);
      const root = createRoot(node);
      let drafts = 0,
        options = 0;
      const execution = {
        nodeId: 'node',
        taskId: 'task',
        planId: 'plan',
        revision: 1,
        version: 1,
        status: action === 'submit' ? 'ready' : 'needs-revision',
        goal: 'Prepare the release notes',
        assigneeId: 'chen',
        reviewerIds: [],
        artifacts: [],
        rounds: [],
        comments: [],
      };
      const item = {
        id: 'item',
        kind: 'deliver',
        actorId: 'chen',
        nodeId: 'node',
        taskId: 'task',
        reason: action === 'submit' ? 'assignee-delivery' : 'revision-delivery',
        action,
      };
      const executionApi = {
        inbox: async () => ({ items: [item], nodes: [execution] }),
        readDeliveryDraft: async () => {
          drafts++;
          return { version: 0, text: '', links: [], files: [] };
        },
        revision: async () => ({ notes: [], reviewed: undefined }),
      };
      const nativeApi = api({
        options: async () => {
          options++;
          return api().options();
        },
      });
      try {
        await act(async () =>
          root.render(
            h(ExecutionWorkspace, {
              api: executionApi,
              nativeRun: { api: nativeApi, spaceId: 'north' },
            }),
          ),
        );
        const open = node.querySelector('.zm-directory-actions button');
        assert.ok(open);
        await act(async () => open.click());
        const form = node.querySelector('textarea')?.closest('.zm-execution-detail');
        assert.ok(form);
        assert.equal(drafts, 1);
        assert.equal(options, 0, 'opening a human delivery does not discover models');
        assert.equal(
          node.querySelector('.zm-run-node-entry'),
          null,
          'no intermediate duplicate title',
        );
        const heading = form.querySelector('.zm-page-heading');
        assert.equal(heading.querySelector('h2').textContent, execution.goal);
        const launch = heading.querySelector('button');
        assert.equal(launch.querySelector('.zm-button-label').textContent, '使用 Agent');
        const input = form.querySelector('textarea');
        await act(async () => launch.click());
        assert.ok(node.querySelector('.zm-run-workspace-dialog'));
        assert.equal(options, 1);
        assert.ok(input.isConnected && form.contains(input), 'launching preserves the manual form');
      } finally {
        await act(async () => root.unmount());
        node.remove();
      }
    }
  });

  test('DOM contract: a service continuation item reopens the same persisted Run from My Work without beginning or submitting', async () => {
    const execution = {
      ...target,
      version: 2,
      status: 'running',
      goal: target.title,
      assigneeId: 'chen',
      reviewerIds: [],
      artifacts: [],
      rounds: [],
      comments: [],
    };
    const item = {
      id: 'continuation',
      kind: 'deliver',
      actorId: 'chen',
      nodeId: target.nodeId,
      taskId: target.taskId,
      reason: 'agent-assisted-delivery',
      action: 'continue-handling',
    };
    const reads = [],
      histories = [];
    let options = 0,
      begins = 0,
      submissions = 0;
    const executionApi = {
      inbox: async () => ({ items: [item], nodes: [execution] }),
      submit: async () => submissions++,
    };
    const nativeApi = api({
      options: async (current) => {
        assert.deepEqual(current, target);
        options++;
        return api().options();
      },
      read: async (current, runId) => {
        reads.push({ current, runId });
        return run;
      },
      history: async (current, runId) => {
        histories.push({ current, runId });
        return {
          messages: [{ id: 'saved', sequence: 1, role: 'assistant', text: 'Persisted result' }],
          nextAfter: 1,
        };
      },
      begin: async () => begins++,
    });
    // Two fresh React roots model leaving/re-entering the Client. Host cold-start
    // proof remains separate; neither render may replace or start the saved Run.
    for (let round = 0; round < 2; round++) {
      const node = document.createElement('div');
      document.body.append(node);
      const root = createRoot(node);
      try {
        await act(async () =>
          root.render(
            h(ExecutionWorkspace, {
              api: executionApi,
              nativeRun: { api: nativeApi, spaceId: target.spaceId },
            }),
          ),
        );
        assert.equal(options, round, 'inbox render performs no native discovery or command');
        const open = node.querySelector('.zm-directory-actions button');
        assert.equal(open.querySelector('.zm-button-label').textContent, '打开 Agent 会话');
        assert.equal(open.disabled, false);
        await act(async () => open.click());
        assert.equal(options, round + 1);
        assert.ok(node.querySelector('.zm-run-workspace-dialog'));
        assert.ok(node.textContent.includes('Persisted result'));
        assert.equal(node.querySelector('.zm-execution-detail'), null, 'no fake manual delivery');
        assert.deepEqual(reads.at(-1), { current: target, runId: run.runId });
        assert.deepEqual(histories.at(-1), { current: target, runId: run.runId });
        assert.equal(begins, 0);
        assert.equal(submissions, 0);
      } finally {
        await act(async () => root.unmount());
        node.remove();
      }
    }
  });

  test('DOM/style contract: conversation keeps one title and a full-width vertical composer without changing ordinary modal footers', async () => {
    const style = document.createElement('style');
    style.textContent = (
      await Promise.all([
        readFile(new URL('../src/workbench/workbench.css', import.meta.url), 'utf8'),
        readFile(new URL('../src/run/NativeRunPanel.css', import.meta.url), 'utf8'),
      ])
    ).join('\n');
    document.head.append(style);
    const current = await mount(
      api({
        history: async () => ({
          nextAfter: 2,
          messages: [
            { id: 'human', sequence: 1, role: 'user', text: '请先核对发布范围。' },
            {
              id: 'agent',
              sequence: 2,
              role: 'assistant',
              text: '已整理范围。\n我会继续检查兼容性、文档和回归结果。',
            },
          ],
        }),
      }),
    );
    const ordinary = document.createElement('dialog');
    ordinary.className = 'zm-dialog';
    ordinary.innerHTML = '<footer><button>保存</button></footer>';
    document.body.append(ordinary);
    try {
      const dialog = current.node.querySelector('dialog');
      assert.equal(dialog.getAttribute('aria-label'), target.title);
      assert.equal(dialog.querySelectorAll('h2').length, 1);
      assert.equal(dialog.querySelector('footer'), null);
      const footer = dialog.querySelector('.zm-native-run__footer');
      const composer = footer.querySelector('form');
      assert.equal(getComputedStyle(footer).flexDirection, 'column');
      assert.equal(getComputedStyle(composer).width, '100%');
      assert.equal(getComputedStyle(composer).flexDirection, 'column');
      const user = dialog.querySelector('[data-role="user"]');
      assert.equal(user.getAttribute('aria-label'), '用户');
      assert.equal(getComputedStyle(user).justifySelf, 'end');
      assert.equal(getComputedStyle(user).maxWidth, '85%');
      assert.equal(dialog.querySelector('.zm-native-run__config').open, false);
      assert.equal(getComputedStyle(ordinary.querySelector('footer')).justifyContent, 'flex-end');
    } finally {
      await current.close();
      ordinary.remove();
      style.remove();
    }
  });
}
