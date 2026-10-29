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
const { KnowledgePanel } = await import('../dist/knowledge/KnowledgePanel.js');
const { createKnowledgeApi } = await import('../dist/knowledge/api.js');
const tick = () => new Promise(setImmediate);
async function flush() {
  await act(async () => {
    await tick();
    await tick();
  });
}
async function until(check, diagnostic = () => '') {
  for (let attempt = 0; attempt < 60 && !check(); attempt++) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(check(), `Expected asynchronous knowledge operation did not settle: ${diagnostic()}`);
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

test('knowledge real API classifies network failure as retryable but keeps malformed/scope/auth closed', async () => {
  const scope = { actorId: 'ann', spaceId: 'north', isCurrent: () => true, onUnauthenticated() {} };
  for (const fetcher of [
    () => {
      throw new TypeError('synthetic offline');
    },
    async () => {
      throw new TypeError('synthetic offline');
    },
  ])
    await assert.rejects(
      createKnowledgeApi(scope, fetcher).libraries(
        { spaceId: 'north' },
        new AbortController().signal,
      ),
      { code: 'unavailable' },
    );
  for (const fetcher of [
    async () => new Response('malformed JSON', { headers: { 'content-type': 'application/json' } }),
    async (_url, init) => {
      const request = JSON.parse(init.body);
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { actorId: 'other', spaceId: 'north', libraries: [] } },
      });
    },
  ])
    await assert.rejects(
      createKnowledgeApi(scope, fetcher).libraries(
        { spaceId: 'north' },
        new AbortController().signal,
      ),
      { code: 'invalid-response' },
    );
  let invalidations = 0;
  await assert.rejects(
    createKnowledgeApi(
      {
        ...scope,
        onUnauthenticated() {
          invalidations++;
        },
      },
      async () => new Response(null, { status: 401 }),
    ).libraries({ spaceId: 'north' }, new AbortController().signal),
    { code: 'unauthenticated' },
  );
  assert.equal(invalidations, 1);
});

test(
  'knowledge real API DOM keeps offline edits and retries the same payload idempotency key',
  { skip: !window },
  async (t) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    t.after(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const scope = {
      actorId: 'ann',
      spaceId: 'north',
      isCurrent: () => true,
      onUnauthenticated() {},
    };
    const writes = [];
    const api = createKnowledgeApi(scope, async (url, init) => {
      const request = JSON.parse(init.body);
      let value;
      if (url.endsWith('/libraries'))
        value = {
          actorId: 'ann',
          spaceId: 'north',
          libraries: [
            { id: 'north', spaceId: 'north', kind: 'team', name: '研发', canCreate: true },
          ],
        };
      else if (url.endsWith('/list') || url.endsWith('/drafts'))
        value = {
          actorId: 'ann',
          spaceId: 'north',
          libraryId: 'north',
          pages: [],
          nextCursor: null,
        };
      else {
        assert.ok(url.endsWith('/save-draft'));
        writes.push(request.payload);
        if (writes.length === 1) throw new TypeError('synthetic offline');
        value = {
          actorId: 'ann',
          spaceId: 'north',
          libraryId: 'north',
          pageId: request.payload.pageId,
          pageRevision: 1,
          operation: 'save-draft',
          disposition: 'saved',
        };
      }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value },
      });
    });
    await act(async () =>
      root.render(el(KnowledgePanel, { api, actorId: 'ann', spaceId: 'north', lifetime: scope })),
    );
    await flush();
    await click(button(host, '新建资料'));
    const title = host.querySelector('article input'),
      body = host.querySelector('article textarea');
    for (const [input, value] of [
      [title, '离线编辑标题'],
      [body, '尚未保存的正文'],
    ]) {
      assert.ok(input);
      const prototype =
        input.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        await tick();
      });
    }
    await click(button(host, '保存草稿'));
    await until(() => writes.length === 1 && host.textContent.includes('当前输入已保留'));
    assert.equal(host.querySelector('article input').value, '离线编辑标题');
    assert.equal(host.querySelector('article textarea').value, '尚未保存的正文');
    assert.ok(host.textContent.includes('当前输入已保留'));
    await click(button(host, '保存草稿'));
    await until(() => writes.length === 2 && host.textContent.includes('草稿已保存'));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], writes[1]);
    assert.ok(host.textContent.includes('草稿已保存'));
  },
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

test(
  'project knowledge mount shares the original leave confirmation across project, catalog and main tabs',
  { skip: !window },
  async () => {
    const reference = {
      spaceId: 'north',
      libraryId: 'north',
      pageId: 'guide',
      version: 1,
      checksum: 'a'.repeat(64),
    };
    const scope = { actorId: 'ann', spaceId: 'north' };
    const state = {
      ...emptyWorkbench(),
      projects: [{ id: 'project', name: '支付平台', description: '' }],
    };
    for (const destination of ['概览', '全部项目', '任务清单']) {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      let reads = 0;
      try {
        await act(async () =>
          root.render(
            el(WorkbenchPage, {
              api: { snapshot: async () => ({ state, model: '未配置' }) },
              initialSection: 'projects',
              appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
              knowledge: {
                ...scope,
                lifetime: { isCurrent: () => true, onUnauthenticated() {} },
                api: {},
                projectApi: {
                  async libraries() {
                    return { ...scope, libraries: [] };
                  },
                  async projectLinks(query) {
                    reads++;
                    assert.deepEqual(query, { spaceId: 'north', projectId: 'project' });
                    return {
                      ...scope,
                      projectId: 'project',
                      relationshipVersion: 1,
                      links: [
                        {
                          reference,
                          required: true,
                          title: '接口说明',
                          format: 'markdown',
                          bytes: 12,
                          hasUpdate: false,
                        },
                      ],
                      snapshot: {
                        sourceVersion: 'zhuma-project-knowledge@1',
                        ...query,
                        relationshipVersion: 1,
                        links: [{ reference, required: true }],
                        checksum: 'b'.repeat(64),
                      },
                    };
                  },
                },
              },
            }),
          ),
        );
        await flush();
        await click(button(host, '支付平台'));
        await click(button(host, '资料与成果'));
        await until(() => !!host.querySelector('.zm-project-knowledge input[type="checkbox"]'));
        assert.equal(reads, 1);
        const checkbox = host.querySelector('.zm-project-knowledge input[type="checkbox"]');
        await click(checkbox);
        assert.equal(checkbox.checked, false);
        const target = () =>
          destination === '任务清单'
            ? [...host.querySelectorAll('nav[aria-label="工作台导航"] button')].find((node) =>
                node.textContent.startsWith(destination),
              )
            : button(host, destination);
        await click(target());
        assert.ok(document.querySelector('dialog[open]'));
        await click(button(document, '继续编辑'));
        assert.equal(
          host.querySelector('.zm-project-knowledge input[type="checkbox"]').checked,
          false,
        );
        await click(target());
        await click(button(document, '放弃并离开'));
        assert.equal(host.querySelector('.zm-project-knowledge'), null);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    }
  },
);
