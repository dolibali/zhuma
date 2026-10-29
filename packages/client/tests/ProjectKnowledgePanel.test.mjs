/** Actual React/optional installed DOM, controlled API contracts only.
 * No browser, real Host authorization, model, Node/Run or visual acceptance proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
if (modulePath) {
  const { Window } = await import(pathToFileURL(resolve(modulePath)).href);
  const window = new Window({ url: 'http://localhost/' });
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
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
const { createElement: el, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { canonicalPayload } = await import('@zhuma/agent-core');
const { ProjectKnowledgePanel } = await import('../dist/knowledge/ProjectKnowledgePanel.js');
const { KnowledgeClientError } = await import('../dist/knowledge/api.js');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const tick = () => new Promise(setImmediate);
const scope = { actorId: 'ann', spaceId: 'north', projectId: 'project' };
function fixture(patch = {}) {
  const who = { ...scope, ...patch.scope },
    hooks = {},
    calls = { project: 0, list: 0, reads: [], saves: [] };
  const texts = ['固定第一版正文。', '固定第二版正文。'];
  const reference = (version = 1) => ({
    spaceId: who.spaceId,
    libraryId: who.spaceId,
    pageId: 'guide',
    version,
    checksum: hash(texts[version - 1]),
  });
  let links = [{ reference: reference(), required: false }],
    version = 0;
  function metadata() {
    const snapshot = {
      sourceVersion: 'zhuma-project-knowledge@1',
      spaceId: who.spaceId,
      projectId: who.projectId,
      relationshipVersion: version,
      links: structuredClone(links),
    };
    return {
      ...who,
      relationshipVersion: version,
      links: links.map((link) => ({
        ...structuredClone(link),
        title: patch.title ?? '接口说明',
        format: 'markdown',
        bytes: Buffer.byteLength(texts[link.reference.version - 1]),
        hasUpdate: link.reference.version < 2,
      })),
      snapshot: { ...snapshot, checksum: hash(canonicalPayload(snapshot)) },
    };
  }
  const api = {
    async projectLinks(input, signal) {
      calls.project++;
      return hooks.project ? hooks.project(input, signal) : metadata();
    },
    async libraries() {
      return {
        actorId: who.actorId,
        spaceId: who.spaceId,
        libraries: [
          { id: who.spaceId, spaceId: who.spaceId, kind: 'team', name: '资料库', canCreate: true },
        ],
      };
    },
    async list(input) {
      calls.list++;
      return hooks.list
        ? hooks.list(input)
        : {
            actorId: who.actorId,
            spaceId: who.spaceId,
            libraryId: who.spaceId,
            pages: [
              {
                reference: reference(2),
                title: patch.title ?? '接口说明',
                format: 'markdown',
                ownerActorId: who.actorId,
                pageRevision: 3,
                bytes: Buffer.byteLength(texts[1]),
                publishedAt: '2026-10-29T12:00:00.000Z',
              },
            ],
            nextCursor: null,
          };
    },
    async read(input, signal) {
      calls.reads.push(structuredClone(input));
      if (hooks.read) return hooks.read(input, signal);
      const text = texts[input.version - 1];
      return {
        actorId: who.actorId,
        spaceId: who.spaceId,
        reference: reference(input.version),
        part: 'body',
        title: patch.title ?? '接口说明',
        format: 'markdown',
        text,
        offset: 0,
        length: Buffer.byteLength(text),
        nextOffset: Buffer.byteLength(text),
        totalBytes: Buffer.byteLength(text),
        partChecksum: reference(input.version).checksum,
        sources: [],
      };
    },
    async saveProjectLinks(input, signal) {
      calls.saves.push(structuredClone(input));
      if (hooks.save) await hooks.save(input, signal);
      links = structuredClone(input.links);
      version = input.expectedVersion + 1;
      return { ...who, relationshipVersion: version, disposition: 'saved' };
    },
  };
  return {
    api,
    who,
    calls,
    hooks,
    reference,
    metadata,
    setLinks(value, revision = 1) {
      links = value;
      version = revision;
    },
  };
}
async function mount(t, h) {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node),
    dirty = [];
  const props = (next) => ({
    scope: next.who,
    api: next.api,
    isCurrent: () => true,
    onDirtyChange: (value) => dirty.push(value),
  });
  await act(async () => {
    root.render(el(ProjectKnowledgePanel, props(h)));
    await tick();
  });
  t.after(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  const click = async (label) =>
    act(async () => {
      const button = [...node.querySelectorAll('button')].find(
        (b) => b.querySelector('.zm-button-label')?.textContent.trim() === label,
      );
      assert(button, label);
      button.click();
      await tick();
    });
  return {
    node,
    dirty,
    click,
    toggle: () =>
      act(async () => {
        node.querySelector('input[type=checkbox]').click();
        await tick();
      }),
    render: (next) =>
      act(async () => {
        root.render(el(ProjectKnowledgePanel, props(next)));
        await tick();
      }),
  };
}

test('project knowledge SSR: ordinary rendering has a named loading state and never calls a service', () => {
  const api = new Proxy({}, { get: () => () => assert.fail('SSR cannot call a service') });
  const html = renderToStaticMarkup(
    el(ProjectKnowledgePanel, { scope, api, isCurrent: () => true, onDirtyChange() {} }),
  );
  assert(html.includes('项目知识'));
  assert(html.includes('正在读取项目知识'));
  assert(!html.includes('关联已保存'));
});

test(
  'project knowledge DOM: exact old version stays selected until explicit update; required edits save and preview is demand-only',
  { skip: !modulePath },
  async (t) => {
    const h = fixture(),
      ui = await mount(t, h);
    assert.equal(h.calls.reads.length, 0);
    assert(ui.node.textContent.includes('v1 · 可选'));
    await ui.toggle();
    assert(ui.node.textContent.includes('v1 · 必读'));
    assert.equal(ui.dirty.at(-1), true);
    await ui.click('保存关联');
    assert.equal(h.calls.saves.length, 1);
    assert.equal(h.calls.saves[0].links[0].reference.version, 1);
    assert.equal(h.calls.saves[0].links[0].required, true);
    assert.equal('actorId' in h.calls.saves[0], false);
    assert.equal(ui.dirty.at(-1), false);
    await ui.click('预览');
    assert(ui.node.textContent.includes('固定第一版正文。'));
    assert.equal(h.calls.reads[0].checksum, h.reference().checksum);
    await ui.click('更新到 v2');
    assert(ui.node.textContent.includes('v2 · 必读'));
    await ui.click('保存关联');
    assert.equal(h.calls.saves[1].expectedVersion, 1);
    assert.equal(h.calls.saves[1].links[0].reference.version, 2);
    assert.notEqual(h.calls.saves[0].idempotencyKey, h.calls.saves[1].idempotencyKey);
  },
);

test(
  'project knowledge DOM: an unknown write locks editing and retries the identical key/version/content',
  { skip: !modulePath },
  async (t) => {
    const h = fixture(),
      ui = await mount(t, h);
    let lost = true;
    h.hooks.save = async () => {
      if (lost) {
        lost = false;
        throw new KnowledgeClientError('unavailable');
      }
    };
    await ui.toggle();
    await ui.click('保存关联');
    assert(ui.node.querySelector('input[type=checkbox]').disabled);
    assert.equal(ui.dirty.at(-1), true);
    await ui.click('重试保存');
    assert.equal(h.calls.saves.length, 2);
    assert.deepEqual(h.calls.saves[0], h.calls.saves[1]);
    assert.equal(ui.dirty.at(-1), false);
  },
);

test(
  'project knowledge DOM: a conflict preserves input and explicit reload can be cancelled before any replacement',
  { skip: !modulePath },
  async (t) => {
    const h = fixture(),
      ui = await mount(t, h);
    h.hooks.save = async () => {
      throw new KnowledgeClientError('conflict');
    };
    await ui.toggle();
    await ui.click('保存关联');
    assert.equal(ui.node.querySelector('input[type=checkbox]').checked, true);
    const count = h.calls.project;
    await ui.click('载入已保存关联');
    assert.equal(h.calls.project, count);
    await act(async () => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.querySelector('.zm-button-label')?.textContent.trim() === '保留选择',
      );
      assert(button);
      button.click();
      await tick();
    });
    assert.equal(ui.node.querySelector('input[type=checkbox]').checked, true);
    assert.equal(ui.dirty.at(-1), true);
    assert.equal(h.calls.project, count);
  },
);

test(
  'project knowledge DOM: a late saved receipt cannot clear new edits after API ownership changes in the same scope',
  { skip: !modulePath },
  async (t) => {
    const old = fixture({ title: '旧接口' }),
      ui = await mount(t, old),
      held = Promise.withResolvers();
    old.hooks.save = () => held.promise;
    await ui.toggle();
    await act(async () => {
      const button = [...ui.node.querySelectorAll('button')].find(
        (b) => b.querySelector('.zm-button-label')?.textContent.trim() === '保存关联',
      );
      button.click();
      await tick();
    });
    const next = fixture({ title: '新接口' });
    await ui.render(next);
    await ui.toggle();
    await act(async () => {
      held.resolve();
      await tick();
    });
    assert(ui.node.textContent.includes('新接口'));
    assert(!ui.node.textContent.includes('旧接口'));
    assert(!ui.node.textContent.includes('关联已保存'));
    assert.equal(ui.node.querySelector('input[type=checkbox]').checked, true);
    assert.equal(ui.dirty.at(-1), true);
    assert.equal(next.calls.saves.length, 0);
  },
);

test(
  'project knowledge DOM: late body data cannot appear after actor/project changes and no unavailable project falls back to a catalog',
  { skip: !modulePath },
  async (t) => {
    const old = fixture(),
      ui = await mount(t, old),
      held = Promise.withResolvers();
    old.hooks.read = () => held.promise;
    await ui.click('预览');
    const next = fixture({ scope: { actorId: 'bob', projectId: 'other' }, title: '新的项目资料' });
    await ui.render(next);
    await act(async () => {
      held.resolve({ text: 'OLD_PRIVATE_BODY' });
      await tick();
    });
    assert(ui.node.textContent.includes('新的项目资料'));
    assert(!ui.node.textContent.includes('OLD_PRIVATE_BODY'));
    const denied = fixture({ scope: { projectId: 'missing' } });
    denied.hooks.project = async () => {
      throw new KnowledgeClientError('forbidden');
    };
    await ui.render(denied);
    assert.equal(denied.calls.list, 0);
    assert(!ui.node.textContent.includes('新的项目资料'));
    assert(ui.node.textContent.includes('不可访问'));
  },
);

test(
  'project knowledge DOM: a known save ACK cannot keep a revoked project visible when its metadata refresh is refused',
  { skip: !modulePath },
  async (t) => {
    const h = fixture(),
      ui = await mount(t, h);
    h.hooks.save = async () => {
      h.hooks.project = async () => {
        throw new KnowledgeClientError('forbidden');
      };
    };
    await ui.toggle();
    await ui.click('保存关联');
    assert(ui.node.textContent.includes('不可访问'));
    assert(!ui.node.textContent.includes('接口说明'));
    assert.equal(ui.node.querySelector('input[type=checkbox]'), null);
    assert.equal(ui.dirty.at(-1), false);
  },
);
