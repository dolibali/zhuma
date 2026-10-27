/** React/SSR and optional in-memory DOM contracts, not Host/GUI/authority proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
let window;
if (domModule) {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
  window = new Window({ url: 'http://localhost/' });
  for (const name of [
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'SVGElement',
    'Document',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'Node',
    'Event',
    'MouseEvent',
    'MutationObserver',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'ResizeObserver',
  ])
    Object.defineProperty(globalThis, name, { configurable: true, value: window[name] });
  globalThis.window = window;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
const { createElement: el, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { ProjectArtifactsPanel } = await import('../dist/workbench/ProjectArtifactsPanel.js');
const { ExecutionError } = await import('../dist/execution/ExecutionApi.js');
const tick = () => new Promise(setImmediate);
const latch = () => Promise.withResolvers();
const ref = (patch = {}) => ({
  spaceId: 'north',
  projectId: 'project',
  taskId: 'task',
  planId: 'task-v2',
  revision: 2,
  nodeId: 'deliver',
  artifactVersionId: 'fixed-v3',
  ...patch,
});
const row = (patch = {}) => ({
  ref: ref(),
  version: 3,
  taskTitle: '上线企业门户',
  nodeTitle: '交付登录接口',
  nodeStatus: 'completed',
  submittedBy: 'member',
  hasText: true,
  fileCount: 0,
  linkCount: 0,
  ...patch,
});
const page = (items = [row()], patch = {}) => ({
  view: 'list',
  spaceId: 'north',
  projectId: 'project',
  coverage: 'latest-confirmed-plans',
  items,
  ...patch,
});
const body = (patch = {}) => ({
  view: 'content',
  ref: ref(),
  version: 3,
  content: { text: '当前固定正文', links: [], files: [] },
  ...patch,
});
const cursor = (offset = 200) => ({
  selection: 'a'.repeat(64),
  taskId: 'task',
  planId: 'task-v2',
  revision: 2,
  offset,
});
function api(hooks = {}) {
  const calls = { list: [], content: [] };
  const value = {
    list(query, signal) {
      calls.list.push({ query, signal });
      return Promise.resolve().then(() => hooks.list?.(query, signal) ?? page());
    },
    content(query, signal) {
      calls.content.push({ query, signal });
      return Promise.resolve().then(() => hooks.content?.(query, signal) ?? body());
    },
  };
  return { value, calls };
}
const props = (source, patch = {}) => ({
  spaceId: 'north',
  projectId: 'project',
  api: source.value,
  openTask() {},
  ...patch,
});
async function mount(t, input) {
  const container = document.createElement('div');
  container.className = 'zhuma';
  document.body.append(container);
  const root = createRoot(container);
  const update = async (next) =>
    act(async () => {
      root.render(el(ProjectArtifactsPanel, next));
      await tick();
    });
  await update(input);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, update };
}
function button(mounted, name) {
  const found = [...mounted.container.querySelectorAll('button')].find((item) =>
    item.textContent.replace(/\s+/g, '').startsWith(name),
  );
  assert.ok(found, `missing action ${name}`);
  return found;
}
async function click(target) {
  await act(async () => {
    target.click();
    await tick();
  });
}
async function settle(fn) {
  await act(async () => {
    fn();
    await tick();
  });
}
const dom = {
  skip: !domModule && 'set ZHUMA_NATIVE_PANEL_DOM_MODULE for in-memory React DOM contracts',
};

test('project artifact panel SSR: initial rendering is passive, scoped, and announces loading rather than false emptiness', () => {
  const source = api();
  const markup = renderToStaticMarkup(el(ProjectArtifactsPanel, props(source)));
  assert.match(markup, /已接受成果/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /正在读取成果/);
  assert.doesNotMatch(markup, /暂无已接受成果|当前固定正文|aria-expanded="true"/);
  assert.equal(source.calls.list.length, 0);
  assert.equal(source.calls.content.length, 0);
});

test(
  'project artifact panel DOM: body and original accepted files are mounted only after explicit expansion; links and task action stay accurate',
  dom,
  async (t) => {
    const file = {
        id: 'upload-fixed',
        mediaType: 'text/plain',
        byteSize: 6,
        checksum: 'a'.repeat(64),
        accessPolicyId: 'space:north',
        uploadComplete: true,
      },
      fileCalls = [],
      opened = [];
    const info = (query) => ({
      request: { ...query, spaceId: 'north', mode: 'metadata' },
      uploadId: file.id,
      name: '接口说明.txt',
      mediaType: file.mediaType,
      bytes: file.byteSize,
      sha256: file.checksum,
      reference: file,
    });
    const filesApi = {
      files: {
        upload() {
          assert.fail('read-only panel cannot upload');
        },
        async metadata(query, signal) {
          fileCalls.push(['metadata', query, signal]);
          return info(query);
        },
        async read(query, mode, signal) {
          fileCalls.push(['read', query, mode, signal]);
          return { info: info(query), bytes: new TextEncoder().encode('原文'), inline: true };
        },
      },
    };
    const source = api({
      list: () => page([row({ fileCount: 1, linkCount: 3 })]),
      content: () =>
        body({
          content: {
            text: '<script>unsafe()</script>',
            links: [
              'https://example.com/spec',
              'javascript:alert(1)',
              'https://user:secret@example.com/',
            ],
            files: [file],
          },
        }),
    });
    const mounted = await mount(t, props(source, { filesApi, openTask: (id) => opened.push(id) }));
    assert.equal(source.calls.list.length, 1);
    assert.equal(source.calls.list[0].query.limit, 20);
    assert.equal(source.calls.content.length, 0);
    assert.equal(fileCalls.length, 0);
    assert.match(mounted.container.textContent, /计划 v2 · 已接受 v3/);
    assert.doesNotMatch(mounted.container.textContent, /已定位|acceptedAt/);
    await click(button(mounted, '查看任务'));
    assert.deepEqual(opened, ['task']);
    const trigger = button(mounted, '查看成果');
    assert.equal(trigger.type, 'button');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger);
    assert.deepEqual(source.calls.content[0].query, ref());
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(document.getElementById(trigger.getAttribute('aria-controls')));
    assert.equal(mounted.container.querySelector('script'), null);
    assert.match(mounted.container.textContent, /<script>unsafe\(\)<\/script>/);
    assert.deepEqual(
      [...mounted.container.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      ['https://example.com/spec'],
    );
    assert.equal(fileCalls.length, 1);
    assert.deepEqual(fileCalls[0][1], {
      purpose: 'accepted',
      projectId: 'project',
      taskId: 'task',
      planId: 'task-v2',
      revision: 2,
      nodeId: 'deliver',
      artifactVersionId: 'fixed-v3',
      uploadId: 'upload-fixed',
    });
    await click(button(mounted, '预览'));
    assert.equal(fileCalls.filter(([kind]) => kind === 'read').length, 1);
    assert.equal(fileCalls.find(([kind]) => kind === 'read')[2], 'preview');
  },
);

test(
  'project artifact panel DOM: an empty page with a cursor offers explicit continuation without declaring the project empty',
  dom,
  async (t) => {
    const next = cursor(),
      source = api({ list: (query) => (query.cursor ? page() : page([], { nextCursor: next })) });
    const mounted = await mount(t, props(source));
    assert.equal(source.calls.list.length, 1, 'no automatic whole-project scan');
    assert.match(mounted.container.textContent, /本页暂未找到/);
    assert.doesNotMatch(mounted.container.textContent, /当前最新确认计划暂无/);
    await click(button(mounted, '继续查找'));
    assert.equal(document.activeElement.getAttribute('aria-label'), '成果分页');
    assert.equal(source.calls.list.length, 2);
    assert.deepEqual(source.calls.list[1].query.cursor, next);
    assert.match(mounted.container.textContent, /交付登录接口/);
    assert.equal(source.calls.content.length, 0);
  },
);

test(
  'project artifact panel DOM: page failure retains only current metadata and explicit retry deduplicates overlapping pages',
  dom,
  async (t) => {
    const next = cursor();
    let failed = false;
    const second = row({
      ref: ref({ nodeId: 'other', artifactVersionId: 'other-v1' }),
      nodeTitle: '独立测试',
      version: 1,
    });
    const source = api({
      list: (query) => {
        if (!query.cursor) return page([row()], { nextCursor: next });
        if (!failed) {
          failed = true;
          throw new Error('PRIVATE_HOST_PATH');
        }
        return page([row(), second]);
      },
    });
    const mounted = await mount(t, props(source));
    await click(button(mounted, '加载更多'));
    assert.match(mounted.container.textContent, /交付登录接口/);
    assert.match(mounted.container.textContent, /请求未完成/);
    assert.doesNotMatch(mounted.container.textContent, /PRIVATE_HOST_PATH/);
    await click(button(mounted, '重试加载'));
    assert.equal(mounted.container.querySelectorAll('button[aria-expanded]').length, 2);
    assert.equal(source.calls.list.length, 3);
  },
);

test(
  'project artifact panel DOM: duplicate refs in one page and mismatched scope fail closed before any content',
  dom,
  async (t) => {
    for (const value of [
      page([row(), row()]),
      page([row({ ref: ref({ spaceId: 'private-space' }), nodeTitle: 'PRIVATE_NODE' })]),
    ]) {
      await t.test(value.items[0].nodeTitle, async (t) => {
        const source = api({ list: () => value }),
          mounted = await mount(t, props(source));
        assert.ok(mounted.container.querySelector('[role="alert"]'));
        assert.equal(mounted.container.querySelectorAll('button[aria-expanded]').length, 0);
        assert.doesNotMatch(mounted.container.textContent, /PRIVATE_NODE/);
        assert.equal(source.calls.content.length, 0);
      });
    }
  },
);

test(
  'project artifact panel DOM: actor API, project, space and file API generations synchronously drop old content and late replies',
  dom,
  async (t) => {
    for (const change of ['api', 'project', 'space', 'filesApi'])
      await t.test(change, async (t) => {
        const pending = latch(),
          source = api({
            list: (query) =>
              page([row({ ref: ref({ spaceId: query.spaceId, projectId: query.projectId }) })], {
                spaceId: query.spaceId,
                projectId: query.projectId,
              }),
            content: () => pending.promise,
          });
        const initial = props(source),
          mounted = await mount(t, initial);
        await click(button(mounted, '查看成果'));
        assert.equal(source.calls.content.length, 1);
        const next = { ...initial };
        if (change === 'api') next.api = api().value;
        if (change === 'project') next.projectId = 'other-project';
        if (change === 'space') next.spaceId = 'other-space';
        if (change === 'filesApi') next.filesApi = {};
        await mounted.update(next);
        assert.equal(source.calls.content[0].signal.aborted, true);
        await settle(() =>
          pending.resolve(body({ content: { text: 'PRIVATE_OLD_BODY', files: [], links: [] } })),
        );
        assert.doesNotMatch(mounted.container.textContent, /PRIVATE_OLD_BODY/);
        assert.equal(mounted.container.querySelector('button[aria-expanded="true"]'), null);
      });
  },
);

test(
  'project artifact panel DOM: closing aborts the old fixed read and reopening requests the same exact version anew',
  dom,
  async (t) => {
    const first = latch(),
      second = latch();
    let reads = 0;
    const source = api({ content: () => (++reads === 1 ? first.promise : second.promise) });
    const mounted = await mount(t, props(source));
    await click(button(mounted, '查看成果'));
    await click(button(mounted, '收起'));
    assert.equal(source.calls.content[0].signal.aborted, true);
    await click(button(mounted, '查看成果'));
    await settle(() =>
      first.resolve(body({ content: { text: 'LATE_CLOSED_BODY', links: [], files: [] } })),
    );
    assert.doesNotMatch(mounted.container.textContent, /LATE_CLOSED_BODY/);
    await settle(() => second.resolve(body()));
    assert.match(mounted.container.textContent, /当前固定正文/);
    assert.deepEqual(
      source.calls.content.map((call) => call.query),
      [ref(), ref()],
    );
  },
);

test(
  'project artifact panel DOM: mismatched fixed ref/version cannot render a body or become automatic latest',
  dom,
  async (t) => {
    for (const value of [
      body({ ref: ref({ artifactVersionId: 'other-version' }) }),
      body({ version: 99 }),
    ])
      await t.test(String(value.version), async (t) => {
        const source = api({
          content: () => ({
            ...value,
            content: { text: 'PRIVATE_WRONG_BODY', links: [], files: [] },
          }),
        });
        const mounted = await mount(t, props(source));
        await click(button(mounted, '查看成果'));
        assert.ok(mounted.container.querySelector('[role="alert"]'));
        assert.doesNotMatch(mounted.container.textContent, /PRIVATE_WRONG_BODY/);
        await click(button(mounted, '刷新成果'));
        assert.equal(source.calls.list.length, 2);
        assert.equal(source.calls.content.length, 1);
        assert.equal(mounted.container.querySelector('button[aria-expanded="true"]'), null);
        assert.equal(
          document.activeElement.id,
          mounted.container.querySelector('section').getAttribute('aria-labelledby'),
        );
      });
  },
);

test(
  'project artifact panel DOM: non-progressing pagination requires refresh and does not poll or preserve stale detail',
  dom,
  async (t) => {
    const next = cursor(),
      source = api({ list: () => page([row()], { nextCursor: next }) });
    const mounted = await mount(t, props(source));
    await click(button(mounted, '查看成果'));
    await click(button(mounted, '加载更多'));
    assert.equal(source.calls.list.length, 2);
    assert.ok(mounted.container.querySelector('[role="alert"]'));
    assert.doesNotMatch(mounted.container.textContent, /当前固定正文/);
    assert.equal(mounted.container.querySelector('button[aria-expanded="true"]'), null);
  },
);
