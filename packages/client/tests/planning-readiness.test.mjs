/** Planning model chooser contracts. Click coverage uses the optional in-memory DOM. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { WorkbenchError } from '@zhuma/agent-core';

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
    'NodeFilter',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLDialogElement',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? window : window[name],
    });
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
const { createElement: el, act, StrictMode, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { PlanningReadiness, choosePlanningModel, readPlanningReadiness, usePlanningReadiness } =
  await import('../dist/workbench/PlanningReadiness.js');

const current = {
  id: '["fixture-provider","fixture-current"]',
  label: 'fixture-provider / fixture-current',
  provider: 'fixture-provider',
  model: 'fixture-current',
};
const alternate = {
  id: '["fixture-provider","fixture-alternate"]',
  label: 'fixture-provider / fixture-alternate',
  provider: 'fixture-provider',
  model: 'fixture-alternate',
};
const readyCatalog = (selected = current) => ({
  kind: 'ready',
  label: selected.label,
  selectedId: selected.id,
  message: '',
  items: [current, alternate],
});
function view(patch) {
  return {
    model: 'fixture-provider / fixture-current',
    choices: undefined,
    ready: true,
    checking: false,
    selecting: false,
    error: '',
    refresh: async () => {},
    loadCatalog: async () => {},
    selectModel: async () => {},
    ...patch,
  };
}

test('list and select change the readiness label the panel renders', async () => {
  let model = current.label;
  const calls = [];
  const api = {
    member: { actorId: 'ann', capabilities: () => ({ planning: true }) },
    async snapshot() {
      return { state: {}, model };
    },
    async planningModels() {
      calls.push('list');
      return readyCatalog(model === alternate.label ? alternate : current);
    },
    async selectPlanningModel(provider, selected) {
      calls.push(['select', provider, selected]);
      model = alternate.label;
      return readyCatalog(alternate);
    },
  };
  const signal = new AbortController().signal;
  const listed = await readPlanningReadiness(api, signal);
  assert.equal(listed.model, current.label);
  assert.equal(listed.choices.items.length, 2);
  const chosen = await choosePlanningModel(api, listed.choices.items, alternate.id, signal);
  assert.deepEqual(calls[1], ['select', alternate.provider, alternate.model]);
  assert.equal(chosen.model, alternate.label);
  const before = renderToStaticMarkup(
    el(PlanningReadiness, { value: view({ choices: listed.choices }) }),
  );
  const after = renderToStaticMarkup(
    el(PlanningReadiness, { value: view({ model: chosen.model, choices: chosen.choices }) }),
  );
  assert.match(before, /规划模型 · /);
  assert.match(before, /生成计划前可确认当前规划模型/);
  assert.match(after, /生成计划前可确认当前规划模型/);
  assert.match(before, new RegExp(current.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(after, new RegExp(alternate.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(after, /fixture-current/);
  assert.match(before, /刷新模型/);
  await assert.rejects(
    choosePlanningModel(api, listed.choices.items, 'missing', signal),
    (error) => error instanceof WorkbenchError && error.code === 'model-unavailable',
  );
});

test('refresh still reads the catalog and the unavailable path keeps operator guidance', async () => {
  let fail = true;
  const api = {
    async snapshot() {
      if (fail) throw new Error('offline');
      return { state: {}, model: 'fixture-provider / fixture-current' };
    },
    async planningModels() {
      if (fail) throw new Error('catalog-offline');
      return {
        kind: 'unavailable',
        label: 'fixture-provider / fixture-current',
        selectedId: null,
        message: '模型目录暂不可用，请检查模型配置后刷新。',
        items: [],
      };
    },
  };
  await assert.rejects(readPlanningReadiness(api, new AbortController().signal));
  fail = false;
  const refreshed = await readPlanningReadiness(api, new AbortController().signal);
  assert.equal(refreshed.model, 'fixture-provider / fixture-current');
  assert.equal(refreshed.choices.kind, 'unavailable');
  const html = renderToStaticMarkup(
    el(PlanningReadiness, {
      value: view({
        ready: false,
        model: '未配置模型',
        choices: refreshed.choices,
        error: '暂时无法确认规划模型，请重试。',
      }),
    }),
  );
  assert.match(html, /当前服务未配置规划模型/);
  assert.match(html, /请由服务操作者配置后刷新/);
  assert.match(html, /本机模型设置不会自动配置共享服务/);
  assert.match(html, /模型目录暂不可用，请检查模型配置后刷新。/);
  assert.match(html, /暂时无法确认规划模型，请重试。/);
  assert.match(html, /刷新模型/);
  assert.doesNotMatch(html, /zm-single-select/);
  const empty = renderToStaticMarkup(
    el(PlanningReadiness, {
      value: view({
        choices: {
          kind: 'ready',
          label: 'fixture-provider / fixture-current',
          selectedId: null,
          message: '',
          items: [],
        },
      }),
    }),
  );
  assert.match(empty, /当前没有可切换的规划模型/);
  assert.match(empty, /规划模型 · fixture-provider \/ fixture-current/);
});

test(
  'planning panel chooser commits a listed model and refresh keeps the editor-independent label',
  { skip: !domModule && 'set ZHUMA_NATIVE_PANEL_DOM_MODULE for in-memory DOM contracts' },
  async () => {
    let model = current.label;
    let catalog = readyCatalog();
    const selected = [];
    const api = {
      member: {
        actorId: 'ann',
        capabilities: () => ({ planning: true, tasks: [] }),
      },
      async snapshot() {
        return { state: {}, model };
      },
      async planningModels() {
        return catalog;
      },
      async selectPlanningModel(provider, selectedModel) {
        selected.push([provider, selectedModel]);
        model = alternate.label;
        catalog = readyCatalog(alternate);
        return catalog;
      },
    };
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    function Harness() {
      const value = usePlanningReadiness(api, current.label);
      return el(PlanningReadiness, { value });
    }
    try {
      await act(async () => {
        root.render(el(Harness));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.match(node.textContent, /规划模型 · /);
      assert.match(
        node.textContent,
        new RegExp(current.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      const trigger = node.querySelector('[aria-label="规划模型"]');
      assert.ok(trigger);
      await act(async () => {
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const option = [...document.querySelectorAll('[role="option"]')].find((item) =>
        item.textContent.includes(alternate.label),
      );
      assert.ok(option);
      await act(async () => {
        option.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.deepEqual(selected, [[alternate.provider, alternate.model]]);
      assert.match(
        node.textContent,
        new RegExp(alternate.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      catalog = {
        kind: 'unavailable',
        label: alternate.label,
        selectedId: null,
        message: '模型目录暂不可用，请检查模型配置后刷新。',
        items: [],
      };
      const refresh = [...node.querySelectorAll('button')].find((button) =>
        (button.querySelector('.zm-button-label')?.textContent ?? '').includes('刷新模型'),
      );
      await act(async () => {
        refresh.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.match(node.textContent, /模型目录暂不可用/);
      assert.match(
        node.textContent,
        new RegExp(alternate.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  },
);

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test(
  'StrictMode setup, cleanup, setup still loads the catalog and can refresh or select',
  { skip: !domModule && 'set ZHUMA_NATIVE_PANEL_DOM_MODULE for in-memory DOM contracts' },
  async () => {
    assert.notEqual(process.env.NODE_ENV, 'production');
    let model = current.label;
    let catalogs = 0;
    let snapshots = 0;
    const selected = [];
    const api = {
      member: { actorId: 'ann', capabilities: () => ({ planning: true, tasks: [] }) },
      async snapshot() {
        snapshots += 1;
        return { state: {}, model };
      },
      async planningModels() {
        catalogs += 1;
        return readyCatalog(model === alternate.label ? alternate : current);
      },
      async selectPlanningModel(provider, selectedModel) {
        selected.push([provider, selectedModel]);
        model = alternate.label;
        return readyCatalog(alternate);
      },
    };
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    function Harness() {
      const value = usePlanningReadiness(api, current.label);
      return el(PlanningReadiness, { value });
    }
    try {
      await act(async () => {
        root.render(el(StrictMode, null, el(Harness)));
      });
      await flush();
      assert.ok(catalogs >= 2);
      assert.ok(node.querySelector('[aria-label="规划模型"]'));
      assert.equal(snapshots, 0);
      const refresh = [...node.querySelectorAll('button')].find((button) =>
        (button.querySelector('.zm-button-label')?.textContent ?? '').includes('刷新模型'),
      );
      assert.ok(refresh);
      await act(async () => {
        refresh.click();
      });
      await flush();
      assert.ok(snapshots >= 1);
      const trigger = node.querySelector('[aria-label="规划模型"]');
      await act(async () => {
        trigger.click();
      });
      await flush();
      const option = [...document.querySelectorAll('[role="option"]')].find((item) =>
        item.textContent.includes(alternate.label),
      );
      assert.ok(option);
      await act(async () => {
        option.click();
      });
      await flush();
      assert.deepEqual(selected, [[alternate.provider, alternate.model]]);
      assert.match(
        node.textContent,
        new RegExp(alternate.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  },
);

test(
  'a replaced planning api drops the previous catalog, and unmount aborts its request',
  { skip: !domModule && 'set ZHUMA_NATIVE_PANEL_DOM_MODULE for in-memory DOM contracts' },
  async () => {
    const stale = Promise.withResolvers();
    const signals = [];
    const oldApi = {
      member: { actorId: 'ann', capabilities: () => ({ planning: true, tasks: [] }) },
      async snapshot() {
        return { state: {}, model: current.label };
      },
      async planningModels(signal) {
        signals.push(signal);
        return stale.promise;
      },
    };
    const nextApi = {
      member: { actorId: 'ann', capabilities: () => ({ planning: true, tasks: [] }) },
      async snapshot() {
        return { state: {}, model: alternate.label };
      },
      async planningModels(signal) {
        signals.push(signal);
        return readyCatalog(alternate);
      },
    };
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    function Harness() {
      const [api, setApi] = useState(oldApi);
      const value = usePlanningReadiness(api, current.label);
      return el(
        'div',
        null,
        el('button', { type: 'button', onClick: () => setApi(nextApi) }, '更换'),
        el(PlanningReadiness, { value }),
      );
    }
    try {
      await act(async () => {
        root.render(el(StrictMode, null, el(Harness)));
      });
      await flush();
      assert.ok(signals.length >= 1);
      const previous = signals.slice();
      await act(async () => {
        node.querySelector('button').click();
      });
      await flush();
      assert.ok(previous.every((item) => item.aborted));
      assert.match(
        node.textContent,
        new RegExp(alternate.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      stale.resolve({
        kind: 'ready',
        label: 'stale-route / secret',
        selectedId: 'stale',
        message: '',
        items: [
          {
            id: 'stale',
            label: 'stale-route / secret',
            provider: 'stale-route',
            model: 'secret',
          },
        ],
      });
      await flush();
      assert.doesNotMatch(node.textContent, /stale-route/);
      const pending = signals.at(-1);
      await act(async () => root.unmount());
      assert.equal(pending.aborted, true);
    } finally {
      node.remove();
    }
  },
);
