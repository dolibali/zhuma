/** Actual React DOM contracts with synthetic API, not browser/Host acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const module = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
if (module) {
  const { Window } = await import(pathToFileURL(resolve(module)).href),
    window = new Window({ url: 'http://localhost/' });
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
    'NodeFilter',
    'Event',
    'MouseEvent',
    'MutationObserver',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'ResizeObserver',
    'DOMRect',
    'CSS',
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? window : window[name],
    });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
}
const { createElement: h, act, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemberAssetFilesUploadDialog } =
  await import('../dist/assets/MemberAssetFilesUploadDialog.js');
const dom = { skip: !module, timeout: 15000 };
const tick = () => new Promise(setImmediate);
async function mount(t, api, extra = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let closed = 0,
    changed = 0,
    unmounted = false;
  await act(async () => {
    root.render(
      h(
        StrictMode,
        null,
        h(MemberAssetFilesUploadDialog, {
          api,
          spaceId: 'north',
          lifetime: { isCurrent: () => !unmounted, onUnauthenticated() {} },
          close() {
            closed++;
          },
          onChanged() {
            changed++;
          },
          ...extra,
        }),
      ),
    );
    await tick();
  });
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
    host.remove();
  };
  t.after(unmount);
  const click = async (text) => {
    const button = [...host.querySelectorAll('button')].find(
      (node) => node.querySelector('.zm-button-label')?.textContent.trim() === text,
    );
    assert(button, text);
    await act(async () => {
      button.click();
      await tick();
    });
  };
  const choose = async (files) => {
    const input = host.querySelector('input[aria-label="选择批量上传文件"]');
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
    });
  };
  return {
    host,
    click,
    choose,
    unmount,
    get closed() {
      return closed;
    },
    get changed() {
      return changed;
    },
  };
}
test(
  'batch upload UI: StrictMode ordinary multi-select/drop, remove, sequential real completed count and draft-only writes',
  dom,
  async (t) => {
    const held = Promise.withResolvers(),
      entered = Promise.withResolvers(),
      commands = [],
      uploads = [],
      records = new Map();
    const api = {
      async command(input) {
        commands.push(input);
        records.set(input.assetId, { version: 1 });
        return { resultVersion: 1 };
      },
      async upload(input, file) {
        uploads.push({ input, file });
        if (uploads.length === 1) {
          entered.resolve();
          await held.promise;
        }
        records.set(input.assetId, { version: 3, file: input.declare });
        return { assetVersion: 3, file: input.declare };
      },
      async read(input) {
        const row = records.get(input.assetId);
        return { asset: { version: row.version }, file: row.file };
      },
    };
    const f = await mount(t, api);
    const first = new File(['one'], 'first.txt'),
      removed = new File(['remove'], 'removed.txt'),
      second = new File(['two'], 'second.txt');
    await f.choose([first, removed]);
    await act(async () => {
      f.host.querySelector('button[aria-label="移除 removed.txt"]').click();
      await tick();
    });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { items: [], files: [second] } });
    await act(async () => {
      f.host.querySelector('.zm-member-asset-files-drop').dispatchEvent(drop);
      await tick();
    });
    assert.equal(f.host.querySelectorAll('li').length, 2);
    assert(!f.host.textContent.includes('removed.txt'));
    await f.click('开始上传');
    await entered.promise;
    assert.equal(commands.length, 1);
    assert.equal(uploads.length, 1);
    assert.equal(f.host.querySelector('progress').value, 0);
    assert(f.host.textContent.includes('已上传 0 / 2'));
    assert(!f.host.textContent.includes('%'));
    await act(async () => {
      held.resolve();
      await tick();
    });
    await act(tick);
    assert.equal(f.host.querySelector('progress').value, 2);
    assert(f.host.textContent.includes('已上传 2 / 2'));
    assert.deepEqual(
      commands.map((input) => input.operation),
      ['create-draft', 'create-draft'],
    );
    assert.equal(uploads[0].file, first);
    assert.equal(uploads[1].file, second);
  },
);
test(
  'batch upload UI: dirty close requires explicit choice and unmount aborts even an ignored-abort create without starting upload',
  dom,
  async (t) => {
    const held = Promise.withResolvers(),
      entered = Promise.withResolvers();
    let signal,
      uploads = 0;
    const f = await mount(t, {
      async command(_input, active) {
        signal = active;
        entered.resolve();
        await held.promise;
        return { resultVersion: 1 };
      },
      async upload() {
        uploads++;
      },
      async read() {
        throw Error('unexpected read');
      },
    });
    await f.choose([new File(['one'], 'first.txt'), new File(['two'], 'second.txt')]);
    await f.click('关闭');
    assert(f.host.textContent.includes('离开当前页面'));
    assert.equal(f.closed, 0);
    await f.click('继续编辑');
    assert.equal(f.host.querySelectorAll('li').length, 2);
    await f.click('开始上传');
    await entered.promise;
    await f.unmount();
    assert.equal(signal.aborted, true);
    await act(async () => {
      held.resolve();
      await tick();
    });
    assert.equal(uploads, 0);
    assert.equal(f.changed, 0);
  },
);
