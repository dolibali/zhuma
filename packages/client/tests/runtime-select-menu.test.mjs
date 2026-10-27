/** Real React click/keyboard contracts in an explicit in-memory DOM.
 * No native geometry, viewport, OS zoom, or screenshot proof is implied. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

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
    'HTMLTextAreaElement',
    'SVGElement',
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
const { createElement: el, useState, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SingleSelect } = await import('../dist/workbench/SingleSelect.js');
const { Modal } = await import('../dist/workbench/controls.js');
const { Appearance } = await import('../dist/workbench/Appearance.js');
const { WorkspaceApprovalDialog } = await import('../dist/run/WorkspaceApprovalDialog.js');
const { NativeRunPanel } = await import('../dist/run/NativeRunPanel.js');
const dom = { skip: !domModule };
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const caption = (button) =>
  (button.querySelector('.zm-button-label')?.textContent ?? button.textContent).trim();
const activePopup = () => document.querySelector('.zm-select-popup[data-open]');
async function mount(t, element) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await tick();
  });
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}
async function click(element) {
  assert.ok(element);
  await act(async () => {
    element.click();
    await tick();
  });
}
async function key(value) {
  await act(async () => {
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    );
    await tick();
  });
}
async function choose(trigger, label) {
  await click(trigger);
  const popup = activePopup();
  assert.ok(popup, 'the actual trigger must open its popup');
  const item = [...popup.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent.trim() === label,
  );
  assert.ok(item, `visible choice ${label}`);
  await click(item);
}

test(
  'shared menu click/keyboard: popup stays inside the modal, disabled choice cannot commit, Escape closes only the menu and returns focus',
  dom,
  async (t) => {
    const changes = [];
    let closed = 0;
    function Form() {
      const [value, setValue] = useState('read');
      return el(
        Modal,
        { title: '授权配置', close: () => closed++ },
        el(SingleSelect, {
          label: '权限',
          value,
          'aria-describedby': 'policy-description',
          'aria-invalid': true,
          options: [
            { value: 'read', label: '只读' },
            { value: 'disabled', label: '暂不可用', disabled: true },
            { value: 'write', label: '读写' },
          ],
          onValueChange: (next) => {
            changes.push(next);
            setValue(next);
          },
        }),
        el('p', { id: 'policy-description' }, '当前授权范围'),
        el(SingleSelect, {
          label: '停用菜单',
          value: 'read',
          disabled: true,
          options: [{ value: 'read', label: '只读' }],
          onValueChange: () => assert.fail('Disabled trigger cannot choose'),
        }),
        el('output', {}, value),
      );
    }
    const container = await mount(t, el(Form));
    const trigger = container.querySelector('[aria-label="权限"]');
    assert.equal(trigger.tagName, 'BUTTON');
    assert.equal(trigger.getAttribute('aria-invalid'), 'true');
    assert.equal(trigger.getAttribute('aria-describedby'), 'policy-description');
    const disabledTrigger = container.querySelector('[aria-label="停用菜单"]');
    assert.equal(disabledTrigger.disabled, true);
    await click(disabledTrigger);
    assert.equal(activePopup(), null);
    await click(trigger);
    assert.equal(activePopup().closest('dialog'), container.querySelector('dialog'));
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const disabled = [...activePopup().querySelectorAll('[role="option"]')].find(
      (item) => item.textContent === '暂不可用',
    );
    assert.equal(disabled.getAttribute('aria-disabled'), 'true');
    await click(disabled);
    assert.deepEqual(changes, []);
    await key('Escape');
    assert.equal(activePopup(), null);
    assert.equal(closed, 0);
    assert.equal(document.activeElement, trigger);
    await click(trigger);
    await key('End');
    await key('Enter');
    assert.deepEqual(changes, ['write']);
    assert.equal(container.querySelector('output').textContent, 'write');
    assert.equal(document.activeElement, trigger);
    assert.equal(container.querySelector('select'), null);
  },
);

test(
  'shared searchable menu and narrow theme trigger use the same popup while keeping readable icon-only choices',
  dom,
  async (t) => {
    const chosen = [];
    const options = Array.from({ length: 10 }, (_, index) => ({
      value: String(index),
      label: `模型 ${index + 1} · 中文配置名称`,
    }));
    const container = await mount(
      t,
      el(
        'div',
        {},
        el(SingleSelect, {
          label: '多模型',
          value: '0',
          options,
          onValueChange: (value) => chosen.push(value),
        }),
        el(Appearance, {
          store: {
            getSnapshot: () => 'light',
            subscribe: () => () => {},
            set: (value) => chosen.push(value),
          },
        }),
      ),
    );
    await choose(container.querySelector('[aria-label="多模型"]'), options[9].label);
    assert.deepEqual(chosen, ['9']);
    const appearance = container.querySelector('[aria-label="外观"]');
    await click(appearance);
    assert.equal(
      activePopup().parentElement.style.getPropertyValue('--zm-select-min-width'),
      '144px',
    );
    assert.equal(activePopup().querySelectorAll('[role="option"]').length, 3);
    assert.ok(activePopup().querySelector('.zm-select-check svg'));
    await key('Escape');
    assert.equal(document.activeElement, appearance);
  },
);

test(
  'workspace authorization menus: actual directory/permission/range clicks never elevate a read-only directory or auto-save',
  dom,
  async (t) => {
    const calls = [];
    const api = {
      context: async () => ({ accountName: '测试成员', projectName: '测试项目' }),
      options: async () => ({
        available: true,
        directories: [
          { id: 'directory', title: '接口工程', path: '/synthetic/project', access: 'read' },
        ],
        approvals: [],
      }),
      approve: (input) => {
        calls.push(input);
        assert.fail('Selecting a choice must not save');
      },
    };
    const container = await mount(
      t,
      el(WorkspaceApprovalDialog, {
        api,
        location: { spaceId: 'north', projectId: 'project' },
        close() {},
        changed() {},
      }),
    );
    await choose(container.querySelector('[aria-label="目录"]'), '接口工程');
    const permissions = container.querySelector('[aria-label="Agent 权限"]');
    await click(permissions);
    const write = [...activePopup().querySelectorAll('[role="option"]')].find(
      (item) => item.textContent === '读写',
    );
    assert.equal(write.getAttribute('aria-disabled'), 'true');
    await click(write);
    assert.match(permissions.textContent, /只读/);
    await key('Escape');
    assert.equal(document.activeElement, permissions);
    await click(
      [...container.querySelectorAll('button')].find((button) => caption(button) === '添加范围'),
    );
    await choose(container.querySelector('[aria-label="范围类型 1"]'), '文件');
    assert.match(container.querySelector('[aria-label="范围类型 1"]').textContent, /文件/);
    assert.equal(container.querySelector('select'), null);
    assert.deepEqual(calls, []);
  },
);

test(
  'NativeRun uses actual shared model menu clicks without starting or changing frozen scope',
  dom,
  async (t) => {
    const model = { provider: 'contract', model: 'first', maxTokens: 1000 };
    const changed = [];
    const unavailable = { kind: 'unavailable', message: 'not available' };
    const container = await mount(
      t,
      el(NativeRunPanel, {
        target: {
          spaceId: 'north',
          taskId: 'task',
          planId: 'plan',
          revision: 1,
          nodeId: 'node',
          title: '处理工作',
        },
        view: {
          kind: 'ready',
          run: null,
          messages: [],
          hasEarlier: false,
          selection: { model, executor: { kind: 'builtin' } },
          models: {
            kind: 'ready',
            items: [
              { id: 'first', label: '原模型', value: model },
              { id: 'second', label: '新模型', value: { ...model, model: 'second' } },
            ],
          },
          experts: {
            kind: 'ready',
            items: [
              { id: 'builtin', label: '内置 Agent', description: '', value: { kind: 'builtin' } },
            ],
          },
          resources: [],
          workspaces: [],
          actions: {
            start: { kind: 'available' },
            stop: unavailable,
            send: { followup: unavailable, steer: unavailable, queue: unavailable },
          },
        },
        onSelectionChange: (value) => changed.push(value),
        onStart: async () => assert.fail('No implicit start'),
        onSend: async () => assert.fail(),
        onStop: async () => assert.fail(),
        onRefresh: async () => {},
        onLoadEarlier: async () => {},
      }),
    );
    await choose(container.querySelector('[aria-label="选择模型"]'), '新模型');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].model.model, 'second');
    assert.deepEqual(changed[0].executor, { kind: 'builtin' });
    assert.equal(container.querySelector('select'), null);
  },
);
