/** React/SSR and in-memory DOM contracts; never real Host, browser or authority proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
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
const { renderToStaticMarkup } = await import('react-dom/server');
const { KnowledgePanel } = await import('../dist/knowledge/KnowledgePanel.js');
const { KnowledgeClientError } = await import('../dist/knowledge/api.js');
const tick = () => new Promise(setImmediate);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const content = (text = '已发布正文。') => ({
  title: '接口说明',
  format: 'markdown',
  text,
  sources: [],
});
function source({
  actorId = 'ann',
  spaceId = 'north',
  title = '接口说明',
  text = '已发布正文。',
  owner = 'bob',
  original,
} = {}) {
  const hooks = {},
    calls = {},
    pending = new Map(),
    published = new Map();
  const seed = {
    ...content(text),
    title,
    ownerActorId: owner,
    revision: 2,
    version: 1,
    ...(original === undefined ? {} : { originalText: original }),
  };
  published.set('guide', seed);
  const ref = (id, page) => ({
    spaceId,
    libraryId: spaceId,
    pageId: id,
    version: page.version,
    checksum: hash(page.text),
  });
  const summary = (id, page) => ({
    reference: ref(id, page),
    title: page.title,
    format: page.format,
    ownerActorId: page.ownerActorId,
    pageRevision: page.revision,
    bytes: Buffer.byteLength(page.text),
    publishedAt: '2026-10-28T10:00:00.000Z',
  });
  const defaults = {
    libraries: () => ({
      actorId,
      spaceId,
      libraries: [{ id: spaceId, spaceId, kind: 'team', name: '产品研发', canCreate: true }],
    }),
    list: () => ({
      actorId,
      spaceId,
      libraryId: spaceId,
      pages: [...published].map(([id, page]) => summary(id, page)),
      nextCursor: null,
    }),
    search: (query) => ({
      actorId,
      spaceId,
      libraryIds: [spaceId],
      query: query.query,
      complete: true,
      hits: [...published]
        .filter(([, page]) => page.text.includes(query.query) || page.title.includes(query.query))
        .map(([id, page]) => ({ ...summary(id, page), snippet: page.text.slice(0, 100) })),
    }),
    drafts: () => ({
      actorId,
      spaceId,
      libraryId: spaceId,
      nextCursor: null,
      pages: [...pending].map(([id, page]) => ({
        spaceId,
        libraryId: spaceId,
        pageId: id,
        ownerActorId: actorId,
        title: page.title,
        format: page.format,
        pageRevision: page.revision,
        bytes: Buffer.byteLength(page.text),
        authorship: page.authorship ?? 'member',
        savedAt: '2026-10-28T11:00:00.000Z',
        hasPublished: published.has(id),
      })),
    }),
    draft: (query) => {
      const draft = pending.get(query.pageId),
        accepted = published.get(query.pageId);
      return {
        actorId,
        spaceId,
        libraryId: spaceId,
        pageId: query.pageId,
        ownerActorId: actorId,
        pageRevision: draft?.revision ?? accepted?.revision ?? 0,
        draft: draft
          ? {
              title: draft.title,
              format: draft.format,
              text: draft.text,
              sources: draft.sources,
              ...(draft.originalText === undefined ? {} : { originalText: draft.originalText }),
              authorship: draft.authorship ?? 'member',
            }
          : null,
        published: accepted ? ref(query.pageId, accepted) : null,
        publishedHasOriginal: accepted?.originalText !== undefined,
      };
    },
    read: (query) => {
      const page = published.get(query.pageId);
      if (!page) throw new KnowledgeClientError('not-found');
      const text = query.part === 'original' ? page.originalText : page.text;
      if (text === undefined) throw new KnowledgeClientError('not-found');
      const bytes = Buffer.from(text),
        offset = query.offset ?? 0;
      let end = Math.min(bytes.length, offset + (query.length ?? 8192));
      while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      return {
        actorId,
        spaceId,
        reference: ref(query.pageId, page),
        part: query.part ?? 'body',
        title: page.title,
        format: page.format,
        text: bytes.subarray(offset, end).toString(),
        offset,
        length: end - offset,
        nextOffset: end,
        totalBytes: bytes.length,
        partChecksum: hash(text),
        sources: page.sources,
      };
    },
    saveDraft: (query) => {
      const revision = query.expectedVersion + 1;
      pending.set(query.pageId, { ...query.content, revision });
      return {
        actorId,
        spaceId,
        libraryId: spaceId,
        pageId: query.pageId,
        pageRevision: revision,
        operation: 'save-draft',
        disposition: 'saved',
      };
    },
    publish: (query) => {
      const draft = pending.get(query.pageId);
      if (!draft) throw new KnowledgeClientError('invalid');
      const accepted = {
        ...draft,
        ownerActorId: actorId,
        revision: query.expectedVersion + 1,
        version: (published.get(query.pageId)?.version ?? 0) + 1,
      };
      published.set(query.pageId, accepted);
      pending.delete(query.pageId);
      return {
        actorId,
        spaceId,
        libraryId: spaceId,
        pageId: query.pageId,
        pageRevision: accepted.revision,
        operation: 'publish',
        disposition: 'published',
        reference: ref(query.pageId, accepted),
      };
    },
  };
  const api = Object.fromEntries(
    Object.entries(defaults).map(([name, fallback]) => [
      name,
      (query, signal) => {
        (calls[name] ??= []).push({ query: structuredClone(query), signal });
        return Promise.resolve().then(() =>
          hooks[name] ? hooks[name](query, signal) : fallback(query),
        );
      },
    ]),
  );
  return { api, actorId, spaceId, hooks, calls, defaults, pending, published, ref };
}
function props(s, patch = {}) {
  return {
    api: s.api,
    actorId: s.actorId,
    spaceId: s.spaceId,
    lifetime: { isCurrent: () => true, onUnauthenticated() {} },
    ...patch,
  };
}
async function flush() {
  await act(async () => {
    await tick();
    await tick();
  });
}
async function until(check) {
  for (let i = 0; i < 60; i++) {
    if (check()) return;
    await flush();
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.ok(check(), 'expected React state did not settle');
}
const buttons = (container, text) =>
  [...container.querySelectorAll('button')].filter(
    (button) => button.querySelector('.zm-button-label')?.textContent.trim() === text,
  );
const button = (container, text) => {
  const found = buttons(container, text)[0];
  assert.ok(found, `missing ${text}`);
  return found;
};
async function click(target) {
  await act(async () => {
    target.click();
    await tick();
  });
}
async function input(target, text) {
  const prototype =
    target.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(target, text);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
  });
}
async function mount(t, value) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const update = async (next) => {
    await act(async () => {
      root.render(el(KnowledgePanel, next));
      await tick();
    });
    await flush();
  };
  await update(value);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, update };
}
function firstRow(container) {
  const found = container.querySelector('aside ul button');
  assert.ok(found);
  return found;
}
const domTest = (name, fn) => test(name, { skip: !domModule }, fn);

test('knowledge panel SSR: loading has no automatic read, write or model activity', () => {
  const s = source();
  const html = renderToStaticMarkup(el(KnowledgePanel, props(s)));
  assert.match(html, /知识资料/u);
  assert.match(html, /正在读取资料目录/u);
  assert.deepEqual(s.calls, {});
  assert.doesNotMatch(html, /已发布正文/u);
});

domTest(
  'knowledge panel: directory first, fixed body only after an explicit selection',
  async (t) => {
    const s = source({ text: '<script>PRIVATE_MARKUP</script>正文' });
    const { container } = await mount(t, props(s));
    await until(() => s.calls.list?.length);
    assert.equal(s.calls.read, undefined);
    await click(firstRow(container));
    await until(() => container.querySelector('article pre'));
    assert.equal(s.calls.read[0].query.checksum, hash('<script>PRIVATE_MARKUP</script>正文'));
    assert.equal(s.calls.read[0].query.version, 1);
    assert.equal(
      container.querySelector('article pre').textContent,
      '<script>PRIVATE_MARKUP</script>正文',
    );
    assert.equal(container.querySelector('script'), null);
    assert.equal(s.calls.saveDraft, undefined);
    assert.equal(s.calls.publish, undefined);
  },
);

domTest(
  'knowledge panel: byte pages remain on demand and malformed continuation closes old content',
  async (t) => {
    const s = source({ text: 'READ_PAGE_CANARY' + 'x'.repeat(10_000) });
    const { container } = await mount(t, props(s));
    await click(firstRow(container));
    await until(() => buttons(container, '继续读取').length);
    assert.equal(s.calls.read.length, 1);
    assert.equal(container.querySelector('article pre').textContent.length, 8192);
    s.hooks.read = (query) => ({
      ...s.defaults.read(query),
      offset: 0,
      text: 'WRONG_CONTINUATION',
    });
    await click(button(container, '继续读取'));
    await until(() => container.querySelector('[role="status"]')?.textContent.includes('不一致'));
    assert.equal(container.querySelector('article pre'), null);
    assert.doesNotMatch(container.textContent, /WRONG_CONTINUATION|READ_PAGE_CANARY/u);
  },
);

domTest(
  'knowledge panel: a new API/account/space aborts an old body and rejects a late reply',
  async (t) => {
    const s = source(),
      delayed = Promise.withResolvers();
    s.hooks.read = () => delayed.promise;
    const { container, update } = await mount(t, props(s));
    await click(firstRow(container));
    await until(() => s.calls.read?.length);
    const next = source({ actorId: 'cy', spaceId: 'south', title: '南区资料', text: 'NEW_SCOPE' });
    await update(props(next));
    assert.equal(s.calls.read[0].signal.aborted, true);
    await act(async () =>
      delayed.resolve({ ...s.defaults.read(s.calls.read[0].query), text: 'LATE_PRIVATE_CANARY' }),
    );
    await flush();
    assert.doesNotMatch(container.textContent, /LATE_PRIVATE_CANARY/u);
    assert.match(container.textContent, /南区资料/u);
  },
);

domTest(
  'knowledge panel: a replaced lifetime epoch fences old data even when API identity is retained',
  async (t) => {
    const s = source(),
      delayed = Promise.withResolvers();
    let valid = true;
    s.hooks.read = () => delayed.promise;
    const { container, update } = await mount(
      t,
      props(s, {
        lifetime: { isCurrent: () => valid, onUnauthenticated() {} },
      }),
    );
    await click(firstRow(container));
    await until(() => s.calls.read?.length);
    valid = false;
    await update(props(s));
    await act(async () => delayed.resolve(s.defaults.read(s.calls.read[0].query)));
    await flush();
    assert.equal(container.querySelector('article pre'), null);
  },
);

domTest(
  'knowledge panel: opening a published page for editing does not pretend its draft is saved',
  async (t) => {
    const s = source({ owner: 'ann', original: '原始输入😀' });
    const { container } = await mount(t, props(s));
    await click(firstRow(container));
    await until(() => buttons(container, '编辑我的草稿').length);
    await click(button(container, '编辑我的草稿'));
    await until(() => container.querySelector('textarea'));
    assert.equal(button(container, '保存草稿').disabled, false);
    assert.equal(button(container, '发布').disabled, true);
    assert.equal(s.calls.read.filter((call) => call.query.part === 'original').length, 1);
    await click(button(container, '保存草稿'));
    await until(() => button(container, '发布').disabled === false);
    assert.equal(s.calls.saveDraft[0].query.content.originalText, '原始输入😀');
    assert.equal(s.calls.saveDraft[0].query.expectedVersion, 2);
    await click(button(container, '发布'));
    await until(() => s.calls.publish?.length && container.querySelector('article pre'));
    assert.equal(s.calls.publish[0].query.expectedVersion, 3);
    assert.equal(s.published.get('guide').originalText, '原始输入😀');
  },
);

domTest(
  'knowledge panel: a stored Agent draft is discoverable but requires a separate explicit publish',
  async (t) => {
    const s = source();
    s.pending.set('suggestion', {
      ...content('Agent 建议正文'),
      title: '建议资料',
      revision: 1,
      authorship: 'agent',
    });
    const { container } = await mount(t, props(s));
    await click(button(container, '我的草稿'));
    await until(() => container.textContent.includes('建议资料'));
    await click(firstRow(container));
    await until(() => container.querySelector('textarea'));
    assert.match(container.textContent, /Agent 提议，待你确认/u);
    assert.equal(s.calls.publish, undefined);
    assert.equal(button(container, '保存草稿').disabled, true);
    assert.equal(button(container, '发布').disabled, false);
  },
);

domTest(
  'knowledge panel: unchanged retries preserve their key and revalidate a replay',
  async (t) => {
    const s = source();
    let attempts = 0;
    s.hooks.saveDraft = (query) => {
      if (attempts++ === 0) {
        s.defaults.saveDraft(query);
        throw new KnowledgeClientError('unavailable');
      }
      return { ...s.defaults.saveDraft(query), disposition: 'replayed' };
    };
    const { container } = await mount(t, props(s));
    await click(button(container, '新建资料'));
    await input(container.querySelector('article input'), '新资料');
    await input(container.querySelector('textarea'), '持久正文');
    await click(button(container, '保存草稿'));
    await until(() => container.querySelector('[role="alert"]'));
    assert.equal(container.querySelector('textarea').value, '持久正文');
    await click(button(container, '保存草稿'));
    await until(() => button(container, '发布').disabled === false);
    assert.equal(s.calls.saveDraft.length, 2);
    assert.equal(
      s.calls.saveDraft[0].query.idempotencyKey,
      s.calls.saveDraft[1].query.idempotencyKey,
    );
    assert.equal(s.calls.draft.length, 1);
  },
);

domTest(
  'knowledge panel: cancelling dirty navigation retains input and returns focus',
  async (t) => {
    const s = source(),
      dirty = [];
    const { container } = await mount(t, props(s, { onDirtyChange: (value) => dirty.push(value) }));
    await click(button(container, '新建资料'));
    await input(container.querySelector('article input'), '未保存标题');
    await input(container.querySelector('textarea'), '未保存正文');
    const target = firstRow(container);
    target.focus();
    await click(target);
    await until(() => container.querySelector('dialog[open]'));
    assert.equal(s.calls.read, undefined);
    await click(button(container, '继续编辑'));
    assert.equal(container.querySelector('textarea').value, '未保存正文');
    assert.equal(document.activeElement, target);
    assert.equal(dirty.at(-1), true);
    await click(target);
    await click(button(container, '放弃修改并继续'));
    await until(() => container.querySelector('article pre'));
    assert.equal(dirty.at(-1), false);
    assert.equal(s.calls.read.length, 1);
  },
);

domTest('knowledge panel: a late save cannot restore editor data in a new space', async (t) => {
  const s = source(),
    delayed = Promise.withResolvers();
  s.hooks.saveDraft = () => delayed.promise;
  const { container, update } = await mount(t, props(s));
  await click(button(container, '新建资料'));
  await input(container.querySelector('article input'), '旧空间标题');
  await input(container.querySelector('textarea'), 'OLD_DRAFT_CANARY');
  await click(button(container, '保存草稿'));
  await until(() => s.calls.saveDraft?.length);
  const next = source({ actorId: 'cy', spaceId: 'south', title: '南区资料' });
  await update(props(next));
  assert.equal(s.calls.saveDraft[0].signal.aborted, true);
  await act(async () => delayed.resolve(s.defaults.saveDraft(s.calls.saveDraft[0].query)));
  await flush();
  assert.equal(container.querySelector('textarea'), null);
  assert.doesNotMatch(container.textContent, /OLD_DRAFT_CANARY|旧空间标题|草稿已保存/u);
  assert.match(container.textContent, /南区资料/u);
  assert.equal(s.calls.drafts, undefined);
});

domTest('knowledge panel: another author in the draft directory closes the old view', async (t) => {
  const s = source();
  s.pending.set('wrong', { ...content('OTHER_PRIVATE_BODY'), revision: 1 });
  s.hooks.drafts = () => {
    const result = s.defaults.drafts();
    result.pages[0].ownerActorId = 'different-actor';
    result.pages[0].title = 'OTHER_PRIVATE_TITLE';
    return result;
  };
  const { container } = await mount(t, props(s));
  await click(firstRow(container));
  await until(() => container.querySelector('article pre'));
  await click(button(container, '我的草稿'));
  await until(() => container.querySelector('[role="alert"]'));
  assert.equal(container.querySelector('article pre'), null);
  assert.equal(container.querySelector('aside ul button'), null);
  assert.doesNotMatch(container.textContent, /OTHER_PRIVATE_BODY|OTHER_PRIVATE_TITLE/u);
  assert.equal(s.calls.draft, undefined);
});

domTest(
  'knowledge panel: importing UTF-8 retains original bytes without automatically saving',
  async (t) => {
    const s = source();
    const { container } = await mount(t, props(s));
    await click(button(container, '新建资料'));
    const text = '\uFEFF导入原文😀\n下一行';
    const file = new window.File([new TextEncoder().encode(text)], '使用说明.md', {
      type: 'text/markdown',
    });
    const transfer = new window.DataTransfer();
    transfer.items.add(file);
    const target = container.querySelector('input[type="file"]');
    await act(async () => {
      target.files = transfer.files;
      target.dispatchEvent(new window.Event('change', { bubbles: true }));
      await tick();
    });
    await until(() => container.querySelector('textarea').value === text);
    assert.equal(s.calls.saveDraft, undefined);
    await click(button(container, '保存草稿'));
    await until(() => s.calls.saveDraft?.length);
    assert.equal(s.calls.saveDraft[0].query.content.text, text);
    assert.equal(s.calls.saveDraft[0].query.content.originalText, text);
    assert.equal(s.calls.saveDraft[0].query.content.title, '使用说明');
    assert.equal(s.calls.publish, undefined);
  },
);

domTest(
  'knowledge panel: a conflicting replay preserves input and never enables publish',
  async (t) => {
    const s = source();
    s.hooks.saveDraft = (query) => {
      const value = s.defaults.saveDraft(query);
      s.pending.get(query.pageId).text = 'DIFFERENT_SAVED_BODY';
      return { ...value, disposition: 'replayed' };
    };
    const { container } = await mount(t, props(s));
    await click(button(container, '新建资料'));
    await input(container.querySelector('article input'), '本轮标题');
    await input(container.querySelector('textarea'), 'MY_UNSAVED_BODY');
    await click(button(container, '保存草稿'));
    await until(() => container.querySelector('[role="alert"]'));
    assert.equal(container.querySelector('textarea').value, 'MY_UNSAVED_BODY');
    assert.match(container.querySelector('[role="alert"]').textContent, /输入已保留/u);
    assert.equal(button(container, '发布').disabled, true);
    assert.equal(s.calls.publish, undefined);
  },
);

domTest('knowledge panel: a revoked space removes directory metadata and body', async (t) => {
  const s = source({ title: 'OLD_DIRECTORY_CANARY', text: 'OLD_BODY_CANARY' });
  const { container } = await mount(t, props(s));
  await click(firstRow(container));
  await until(() => container.querySelector('article pre'));
  s.hooks.search = () => {
    throw new KnowledgeClientError('forbidden');
  };
  const field = container.querySelector('input[type="search"]');
  await input(field, 'find');
  await act(async () => {
    field.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
  });
  await until(() => container.querySelector('[role="alert"]'));
  assert.doesNotMatch(container.textContent, /OLD_DIRECTORY_CANARY|OLD_BODY_CANARY/u);
  assert.equal(button(container, '已发布').disabled, true);
  assert.equal(s.calls.saveDraft, undefined);
});
