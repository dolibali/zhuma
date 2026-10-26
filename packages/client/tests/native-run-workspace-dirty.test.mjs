/** React + optional installed Happy DOM contracts; no browser, Host or model authority. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

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
}
