/** In-memory DOM navigation contract; no browser, Host or permission proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
let window;
if (domModule) {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
  window = new Window({ url: 'http://localhost/' });
  for (const key of [
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
    Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
  globalThis.window = window;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
const { createElement: el, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { emptyWorkbench } = await import('@zhuma/agent-core');
const { WorkbenchPage } = await import('../dist/workbench/WorkbenchPage.js');
const tick = () => new Promise(setImmediate);
async function flush() {
  await act(async () => {
    await tick();
    await tick();
  });
}
async function click(target) {
  assert.ok(target);
  await act(async () => {
    target.click();
    await tick();
  });
}
const button = (root, text) =>
  [...root.querySelectorAll('button')].find(
    (node) =>
      (node.querySelector('.zm-button-label')?.textContent ?? node.textContent).trim() === text,
  );

test(
  'knowledge main-tab contract keeps edits on cancel and leaves through the existing confirmation',
  { skip: !window },
  async (t) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    t.after(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const scope = { actorId: 'ann', spaceId: 'north' };
    const knowledge = {
      ...scope,
      lifetime: { isCurrent: () => true, onUnauthenticated() {} },
      api: {
        async libraries() {
          return {
            ...scope,
            libraries: [
              { id: 'north', spaceId: 'north', kind: 'team', name: '研发', canCreate: true },
            ],
          };
        },
        async list() {
          return { ...scope, libraryId: 'north', pages: [], nextCursor: null };
        },
      },
    };
    await act(async () =>
      root.render(
        el(WorkbenchPage, {
          api: { snapshot: async () => ({ state: emptyWorkbench(), model: '未配置' }) },
          initialSection: 'tasks',
          appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
          knowledge,
        }),
      ),
    );
    await flush();
    const nav = host.querySelector('nav[aria-label="工作台导航"]');
    assert.ok(nav);
    const taskTab = [...nav.querySelectorAll('button')].find((node) =>
      node.textContent.startsWith('任务清单'),
    );
    await click(button(nav, '知识'));
    await flush();
    assert.ok(host.querySelector('h1').textContent.includes('知识'));
    assert.equal(button(host, '创建任务'), undefined);
    await click(button(host, '新建资料'));
    const title = host.querySelector('article input');
    assert.ok(title);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
        title,
        '未保存的设计说明',
      );
      title.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick();
    });
    await click(taskTab);
    assert.ok(host.querySelector('dialog[open]'));
    await click(button(document, '继续编辑'));
    assert.equal(host.querySelector('article input').value, '未保存的设计说明');
    await click(taskTab);
    await click(button(document, '放弃并离开'));
    assert.equal(host.querySelector('article[aria-label="资料正文"]'), null);
    assert.ok(host.querySelector('h1').textContent.includes('任务清单'));
  },
);
