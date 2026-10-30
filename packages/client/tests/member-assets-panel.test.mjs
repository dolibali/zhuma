/** Real React DOM with explicit service fixtures. These are UI contracts,
 * not browser painting, member authority, CLI or model acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
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
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { emptyWorkbench } = await import('@zhuma/agent-core');
const { MemberAssetFilePicker } = await import('../dist/assets/MemberAssetFilePicker.js');
const { MemberAssetsPanel } = await import('../dist/assets/MemberAssetsPanel.js');
const { MemberAssetImportDialog } = await import('../dist/assets/MemberAssetImportDialog.js');
const { CodeArtsSetupDialog } = await import('../dist/run/CodeArtsSetupDialog.js');
const { MemberAssetClientError } = await import('../dist/assets/api.js');
const { WorkbenchPage } = await import('../dist/workbench/WorkbenchPage.js');
const { createMemberWorkbenchAdapter } = await import('../dist/workbench/member-adapter.js');
const spaceId = 'north';
const summary = (patch = {}) => ({
  spaceId,
  assetId: randomUUID(),
  kind: 'expert',
  name: '接口专家',
  description: '维护接口兼容',
  ownerId: 'ann',
  maintainerIds: ['ann'],
  version: 1,
  hasDraft: true,
  canMaintain: true,
  canPublish: true,
  versions: [],
  ...patch,
});
const definition = (asset) =>
  asset.kind === 'expert'
    ? {
        kind: 'expert',
        name: asset.name,
        description: asset.description,
        role: '接口设计',
        capabilities: ['兼容性'],
        instructions: '完整指令\n' + 'x'.repeat(10000),
      }
    : asset.kind === 'file'
      ? { kind: 'file', name: asset.name, description: '' }
      : { kind: asset.kind, name: asset.name, description: '', content: '完整方法\n' };
const valueOf = (asset, def = definition(asset), file) => ({
  actorId: 'ann',
  asset,
  selection: asset.hasDraft
    ? { kind: 'draft', expectedVersion: asset.version }
    : { kind: 'published', reference: asset.versions.at(-1).reference },
  definition: def,
  dependencies: [],
  ...(file ? { file } : {}),
});
function source(initial = [], hooks = {}) {
  let assets = initial.slice(),
    values = new Map(assets.map((asset) => [asset.assetId, valueOf(asset)]));
  const calls = { command: [], read: [], upload: [], catalog: [], folders: [] };
  const api = {
    async listFolder(query, signal) {
      calls.folders.push(query);
      if (hooks.listFolder) return hooks.listFolder(query, signal);
      return {
        actorId: 'ann',
        spaceId,
        folderId: query.folderId,
        path: [],
        folders: [],
        files: assets.filter((asset) => asset.kind === 'file'),
      };
    },
    async catalog(query) {
      calls.catalog.push(query);
      if (hooks.catalog) return hooks.catalog(query);
      const rows = assets.filter(
        (asset) =>
          (query.category === 'all' ||
            query.category === (asset.kind === 'file' ? 'material' : asset.kind)) &&
          asset.name.includes(query.search ?? ''),
      );
      const counts = { all: assets.length, material: 0, expert: 0, template: 0, skill: 0 };
      for (const asset of assets) counts[asset.kind === 'file' ? 'material' : asset.kind]++;
      return {
        sourceVersion: 'zhuma-team-asset-catalog@1',
        actorId: 'ann',
        spaceId,
        category: query.category,
        search: query.search,
        offset: query.offset,
        limit: query.limit,
        countUnit: 'items',
        counts,
        total: rows.length,
        items: rows.map((asset) => ({
          source: 'asset',
          category: asset.kind === 'file' ? 'material' : asset.kind,
          asset,
        })),
        nextOffset: null,
      };
    },
    async list() {
      return { actorId: 'ann', spaceId, items: assets.filter((asset) => asset.kind === 'skill') };
    },
    async read(query, signal) {
      calls.read.push(query);
      if (hooks.read) return hooks.read(query, signal);
      return structuredClone(values.get(query.assetId));
    },
    async command(input) {
      calls.command.push(structuredClone(input));
      if (hooks.command) await hooks.command(input, calls.command.length);
      let asset = assets.find((value) => value.assetId === input.assetId);
      if (!asset) {
        asset = summary({
          assetId: input.assetId,
          kind: input.definition.kind,
          name: input.definition.name,
          description: input.definition.description,
        });
        assets.push(asset);
      } else asset = { ...asset, version: asset.version + 1 };
      const old = values.get(asset.assetId);
      let file = old?.file;
      if (input.operation === 'publish') {
        const ref = {
          spaceId,
          assetId: asset.assetId,
          kind: asset.kind,
          versionId: randomUUID(),
          sha256: 'a'.repeat(64),
        };
        asset = {
          ...asset,
          hasDraft: false,
          versions: [
            ...asset.versions,
            {
              reference: ref,
              number: asset.versions.length + 1,
              publishedBy: 'ann',
              publishedAt: '2026-10-30T00:00:00.000Z',
            },
          ],
        };
      }
      assets = assets.map((value) => (value.assetId === asset.assetId ? asset : value));
      values.set(asset.assetId, valueOf(asset, input.definition ?? old.definition, file));
      return {
        actorId: 'ann',
        disposition: 'applied',
        asset,
        resultVersion: asset.version,
        ...(input.operation === 'publish' ? { reference: asset.versions.at(-1).reference } : {}),
      };
    },
    async upload(input, file) {
      calls.upload.push({ input, file });
      if (hooks.upload) await hooks.upload(input, file);
      const asset = {
        ...assets.find((value) => value.assetId === input.assetId),
        version: input.expectedVersion + 2,
      };
      assets = assets.map((value) => (value.assetId === asset.assetId ? asset : value));
      values.set(
        asset.assetId,
        valueOf(asset, values.get(asset.assetId).definition, input.declare),
      );
      return {
        spaceId,
        assetId: asset.assetId,
        idempotencyKey: input.idempotencyKey,
        assetVersion: asset.version,
        file: input.declare,
      };
    },
    async file() {
      throw Error('Unexpected file request');
    },
    async reference() {
      throw Error('Unexpected reference request');
    },
    async source() {
      throw Error('Unexpected source request');
    },
    async previewImport() {
      throw Error('Unexpected import');
    },
    async importDrafts() {
      throw Error('Unexpected import');
    },
  };
  return { api, calls, values };
}
async function mount(t, data, component = MemberAssetsPanel, extra = {}) {
  const host = document.createElement('div');
  host.className = 'zhuma';
  document.body.append(host);
  const root = createRoot(host);
  let alive = true;
  const props = {
    api: data.api,
    spaceId,
    lifetime: { isCurrent: () => alive, onUnauthenticated() {} },
    authoringState: emptyWorkbench(),
    ...extra,
  };
  await act(async () => {
    root.render(h(component, props));
    await new Promise(setImmediate);
  });
  t.after(async () => {
    alive = false;
    await act(async () => root.unmount());
    host.remove();
  });
  const settle = async () =>
    act(async () => {
      await new Promise(setImmediate);
    });
  const click = async (element) => {
    assert.ok(!!element, 'missing control');
    await act(async () => {
      element.click();
      await new Promise(setImmediate);
    });
  };
  const button = (text, scope = host) =>
    [...scope.querySelectorAll('button')].find((node) => node.textContent.includes(text));
  const field = (label) => {
    const node = [...host.querySelectorAll('label')].find((node) => node.textContent === label);
    return node ? document.getElementById(node.htmlFor) : null;
  };
  const input = async (label, text) => {
    const element = field(label);
    assert.ok(!!element, label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      ).set.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const choose = async (label, text) => {
    const trigger = host.querySelector(`button[aria-label="${label}"]`);
    await click(trigger);
    const menu = document.getElementById(trigger.getAttribute('aria-controls'));
    assert.ok(!!menu, 'select popup');
    await click(
      [...menu.querySelectorAll('[role="option"]')].find(
        (node) => node.textContent.trim() === text,
      ),
    );
  };
  return { host, click, button, field, input, choose, settle };
}
const dom = { skip: !module, timeout: 15000 };

test(
  'material category uses a full-width authoritative folder browser and opens bodies only on explicit preview',
  dom,
  async (t) => {
    const asset = summary({ kind: 'file', name: '接口规范.txt', hasDraft: false }),
      reference = {
        spaceId,
        assetId: asset.assetId,
        kind: 'file',
        versionId: randomUUID(),
        sha256: 'a'.repeat(64),
      },
      folder = {
        spaceId,
        folderId: randomUUID(),
        parentFolderId: null,
        name: '研发资料',
        createdBy: 'ann',
        version: 1,
      },
      file = {
        name: asset.name,
        mediaType: 'text/plain',
        byteSize: 3,
        sha256: createHash('sha256').update('abc').digest('hex'),
      };
    asset.versions = [
      { reference, number: 1, publishedBy: 'ann', publishedAt: '2026-10-30T00:00:00.000Z' },
    ];
    const data = source([asset], {
      listFolder: (query) => ({
        actorId: 'ann',
        spaceId,
        folderId: query.folderId,
        path: query.folderId ? [folder] : [],
        folders: query.folderId ? [] : [folder],
        files: query.folderId ? [] : [asset],
      }),
    });
    data.values.set(asset.assetId, valueOf(asset, definition(asset), file));
    let bodies = 0;
    data.api.file = async () => {
      bodies++;
      return {
        blob: new Blob(['abc'], { type: 'text/plain' }),
        contentType: 'text/plain',
        inline: true,
      };
    };
    const f = await mount(t, data);
    await f.click(f.button('资料', f.host.querySelector('.zm-asset-categories')));
    assert.equal(f.host.querySelector('.zm-member-assets-layout'), null);
    assert.equal(f.host.querySelector('.zm-member-asset-detail'), null);
    assert.deepEqual(
      [...f.host.querySelectorAll('thead th')].map((node) => node.textContent),
      ['名称', '大小', '状态 / 版本', '发布日期', '操作'],
    );
    assert.equal(data.calls.read.length, 0);
    assert.equal(bodies, 0);
    await f.click(f.button('研发资料'));
    assert.equal(data.calls.folders.at(-1).folderId, folder.folderId);
    assert.equal(data.calls.folders.at(-1).includeDrafts, true);
    assert.equal(
      f.host.querySelector('nav[aria-label="文件夹位置"]').textContent.includes('研发资料'),
      true,
    );
    await f.click(f.button('全部文件'));
    await f.click(f.host.querySelector(`button[aria-label="预览文件 ${asset.name}"]`));
    assert.equal(bodies, 1);
    assert.equal(document.querySelector('dialog[open] pre').textContent, 'abc');
    assert.equal(f.host.querySelector('tbody tr:last-child td:nth-child(2)').textContent, '3 B');
    await f.click(f.button('关闭', document.querySelector('dialog[open]')));
    await f.click(f.host.querySelector(`button[aria-label="文件信息 ${asset.name}"]`));
    assert.ok(document.querySelector('dialog[open] .zm-member-asset-detail'));
  },
);

test(
  'folder creation retries the same unknown intent and selected-folder batch upload uses its frozen folder',
  dom,
  async (t) => {
    const folder = {
        spaceId,
        folderId: randomUUID(),
        parentFolderId: null,
        name: '研发资料',
        createdBy: 'ann',
        version: 1,
      },
      data = source([], {
        listFolder: (query) => ({
          actorId: 'ann',
          spaceId,
          folderId: query.folderId,
          path: query.folderId ? [folder] : [],
          folders: query.folderId ? [] : [folder],
          files: [],
        }),
      }),
      calls = [];
    data.api.createFolder = async (input) => {
      calls.push(structuredClone(input));
      if (calls.length === 1) throw new MemberAssetClientError('asset-unavailable', 'unknown');
      return {
        actorId: 'ann',
        spaceId,
        disposition: 'replayed',
        resultVersion: 1,
        folder: { ...folder, folderId: input.folderId, name: input.name },
      };
    };
    const f = await mount(t, data);
    await f.click(f.button('资料', f.host.querySelector('.zm-asset-categories')));
    await f.click(f.button('新建文件夹'));
    await f.input('文件夹名称', '产品资料');
    await f.click(f.button('创建文件夹'));
    assert.equal(f.field('文件夹名称').disabled, true);
    await f.click(f.button('重试原请求'));
    assert.deepEqual(calls[1], calls[0]);
    await f.click(f.button('研发资料'));
    await f.click(f.button('上传文件'));
    const upload = document.querySelector('input[aria-label="选择批量上传文件"]');
    const file = new File(['真实字节'], 'spec.txt', { type: 'text/plain' });
    Object.defineProperty(upload, 'files', { configurable: true, value: [file] });
    await act(async () => {
      upload.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(setImmediate);
    });
    await f.click(f.button('开始上传', document.querySelector('dialog[open]')));
    await f.settle();
    await f.settle();
    assert.equal(data.calls.command[0].operation, 'create-draft');
    assert.equal(data.calls.command[0].folderId, folder.folderId);
    assert.equal(data.calls.upload[0].file, file);
  },
);

test(
  'moving a file keeps its original expected version and retries the same unknown move intent',
  dom,
  async (t) => {
    const asset = summary({ kind: 'file', name: '设计稿.pdf' }),
      folder = {
        spaceId,
        folderId: randomUUID(),
        parentFolderId: null,
        name: '设计资料',
        createdBy: 'ann',
        version: 1,
      },
      data = source([asset], {
        listFolder: (query) => ({
          actorId: 'ann',
          spaceId,
          folderId: query.folderId,
          path: query.folderId ? [folder] : [],
          folders: query.folderId ? [] : [folder],
          files: query.folderId ? [] : [asset],
        }),
        command: (_input, count) => {
          if (count === 1) throw new MemberAssetClientError('asset-unavailable', 'unknown');
        },
      }),
      f = await mount(t, data);
    await f.click(f.button('资料', f.host.querySelector('.zm-asset-categories')));
    await f.click(f.host.querySelector(`button[aria-label="移动文件 ${asset.name}"]`));
    await f.click(f.button('设计资料', document.querySelector('dialog[open]')));
    await f.click(f.button('移动到这里'));
    assert.equal(data.calls.command[0].operation, 'move-file');
    assert.equal(data.calls.command[0].expectedVersion, asset.version);
    assert.equal(data.calls.command[0].folderId, folder.folderId);
    await f.click(f.button('重试原请求'));
    assert.deepEqual(data.calls.command[1], data.calls.command[0]);
  },
);

test(
  'fixed file picker: metadata-only opening, explicit old-version choice, full fixed refs and cancel without a parent write',
  dom,
  async (t) => {
    const assetId = randomUUID();
    const ref = (sha) => ({
      spaceId,
      assetId,
      kind: 'file',
      versionId: randomUUID(),
      sha256: sha.repeat(64),
    });
    const old = ref('a'),
      latest = ref('b');
    const asset = summary({
      assetId,
      kind: 'file',
      name: '接口文档',
      hasDraft: false,
      versions: [
        { reference: old, number: 1, publishedBy: 'ann', publishedAt: '2026-10-30T00:00:00.000Z' },
        {
          reference: latest,
          number: 2,
          publishedBy: 'ann',
          publishedAt: '2026-10-30T01:00:00.000Z',
        },
      ],
    });
    const calls = [];
    const api = {
      async list() {
        return { items: [asset] };
      },
      async read() {
        throw Error('Opening must not read file metadata/body');
      },
    };
    const f = await mount(t, { api }, MemberAssetFilePicker, {
      value: undefined,
      change(value) {
        calls.push(value);
      },
    });
    await f.settle();
    assert.equal(calls.length, 0, 'missing property must not become [] on mount');
    await f.click(f.button('选择资料'));
    await f.click(f.host.querySelector('input[aria-label="选择资料 接口文档"]'));
    assert.equal(calls.length, 0);
    await f.choose('资料版本 接口文档', 'v1');
    await f.click(f.button('确认选择'));
    assert.deepEqual(calls, [[old]]);
    await f.click(f.button('选择资料'));
    await f.click(f.host.querySelector('input[aria-label="选择资料 接口文档"]'));
    await f.click(f.button('取消'));
    assert.equal(calls.length, 1);
  },
);

test(
  'fixed file picker: an unavailable pinned version is retained, never silently switched to latest, and a failed refresh is actionable',
  dom,
  async (t) => {
    const assetId = randomUUID(),
      pinned = { spaceId, assetId, kind: 'file', versionId: randomUUID(), sha256: 'a'.repeat(64) },
      latest = { ...pinned, versionId: randomUUID(), sha256: 'b'.repeat(64) };
    const asset = summary({
      assetId,
      kind: 'file',
      name: '旧版资料',
      hasDraft: false,
      versions: [
        {
          reference: latest,
          number: 2,
          publishedBy: 'ann',
          publishedAt: '2026-10-30T00:00:00.000Z',
        },
      ],
    });
    const calls = [];
    let fail = false;
    const api = {
      async list() {
        if (fail) throw new MemberAssetClientError('asset-unavailable');
        return { items: [asset] };
      },
    };
    const f = await mount(t, { api }, MemberAssetFilePicker, {
      value: [pinned],
      change(value) {
        calls.push(value);
      },
    });
    await f.settle();
    await f.click(f.button('选择资料'));
    const trigger = f.host.querySelector('button[aria-label="资料版本 旧版资料"]');
    assert.equal(trigger.textContent.includes('原版本不可用'), true);
    await f.click(f.button('确认选择'));
    assert.equal(calls.length, 0);
    assert.equal(f.host.textContent.includes('有资料版本当前不可用'), true);
    fail = true;
    await f.click(f.button('刷新'));
    await f.settle();
    assert.equal(f.host.textContent.includes('没有匹配的已发布资料'), false);
    assert.equal(f.button('确认选择').disabled, true);
    assert.equal(!!f.button('重试读取'), true);
  },
);

test(
  'asset category navigation confirms unsaved edits, clears unrelated detail and suppresses redundant type labels',
  dom,
  async (t) => {
    const expert = summary({ name: '企业级接口兼容性分析专家VeryLongUnbrokenName' }),
      skill = summary({ kind: 'skill', name: '接口校验' }),
      data = source([expert, skill]),
      f = await mount(t, data);
    const category = (label) => f.button(label, f.host.querySelector('.zm-asset-categories'));
    assert.equal(f.host.querySelectorAll('.zm-member-asset-kind').length, 2);
    await f.click(category('Agent 专家'));
    assert.equal(f.host.querySelectorAll('.zm-member-asset-kind').length, 0);
    await f.click(f.host.querySelector('.zm-member-asset-row'));
    await f.input('名称', '尚未保存的专家');
    await f.click(category('Skills'));
    const dialog = document.querySelector('dialog[open]');
    assert.ok(dialog?.textContent.includes('离开当前页面'));
    assert.equal(category('Agent 专家').getAttribute('aria-pressed'), 'true');
    await f.click(f.button('继续编辑', dialog));
    assert.equal(f.field('名称').value, '尚未保存的专家');
    await f.click(category('Skills'));
    await f.click(f.button('放弃并离开', document.querySelector('dialog[open]')));
    assert.equal(category('Skills').getAttribute('aria-pressed'), 'true');
    assert.equal(f.field('名称'), null);
    assert.equal(f.host.querySelector('.zm-member-asset-detail h3').textContent, '选择一项资产');
    assert.equal(f.host.querySelector('.zm-member-asset-row strong').textContent, '接口校验');
  },
);

test(
  'changing category aborts a pending detail and late completion cannot repopulate it',
  dom,
  async (t) => {
    const expert = summary(),
      held = Promise.withResolvers();
    let signal;
    const data = source([expert], {
        read: (_query, suppliedSignal) => {
          signal = suppliedSignal;
          return held.promise;
        },
      }),
      f = await mount(t, data);
    await f.click(f.host.querySelector('.zm-member-asset-row'));
    await f.click(f.button('Skills', f.host.querySelector('.zm-asset-categories')));
    assert.equal(signal.aborted, true);
    await act(async () => {
      held.resolve(valueOf(expert));
      await new Promise(setImmediate);
    });
    assert.equal(f.field('名称'), null);
    assert.equal(f.host.querySelector('.zm-member-asset-detail h3').textContent, '选择一项资产');
  },
);

test(
  'asset detail shows server provenance and maintainers without treating imported source declarations as editable instructions',
  dom,
  async (t) => {
    const asset = summary(),
      data = source([asset]);
    data.values.get(asset.assetId).source = {
      kind: 'import',
      versionId: randomUUID(),
      sha256: 'f'.repeat(64),
      entryPath: 'analyst/SOUL.md',
      sourceVersion: '1.2',
    };
    const f = await mount(t, data, MemberAssetsPanel, {
      authoringState: {
        ...emptyWorkbench(),
        participants: [
          {
            id: 'ann',
            name: '林可',
            kind: 'human',
            role: '开发',
            capabilities: [],
            instructions: '',
            available: true,
          },
        ],
      },
    });
    await f.click(f.button('接口专家'));
    const provenance = f.host.querySelector('.zm-asset-provenance');
    assert.equal(provenance.querySelector('summary').textContent, '来源与维护');
    for (const text of ['导入资源包', '创建者', '维护者', '林可', 'analyst/SOUL.md', '1.2'])
      assert.equal(provenance.textContent.includes(text), true);
  },
);

test(
  'member assets keep online documents reachable without a duplicate top-level knowledge tab',
  dom,
  async (t) => {
    const data = source(),
      state = emptyWorkbench(),
      snapshot = {
        actorId: 'ann',
        spaceId,
        space: { id: spaceId, kind: 'team', name: '团队' },
        state,
        model: null,
        capabilities: {
          createProject: true,
          createTask: true,
          planning: false,
          resources: 'authorized',
          tasks: [],
        },
      },
      adapter = createMemberWorkbenchAdapter({ snapshot: async () => snapshot }, 'ann');
    const f = await mount(t, data, WorkbenchPage, {
      api: adapter,
      initialSection: 'tasks',
      appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
      memberAssets: {
        api: data.api,
        spaceId,
        lifetime: { isCurrent: () => true, onUnauthenticated() {} },
      },
      knowledge: {
        actorId: 'ann',
        spaceId,
        lifetime: { isCurrent: () => true, onUnauthenticated() {} },
        api: {
          async libraries() {
            return { actorId: 'ann', spaceId, libraries: [] };
          },
        },
      },
    });
    const nav = f.host.querySelector('nav[aria-label="工作台导航"]');
    assert.deepEqual(
      [...nav.querySelectorAll('button')].map((button) =>
        button.textContent.replace(/\d+/gu, '').trim(),
      ),
      ['项目', '任务清单', '资产'],
    );
    const style = document.createElement('style');
    style.textContent = await readFile(
      new URL('../src/workbench/workbench.css', import.meta.url),
      'utf8',
    );
    document.head.append(style);
    t.after(() => style.remove());
    assert.equal(f.host.querySelector('.zm-page-heading'), null);
    assert.equal(f.host.querySelector('h1.zm-catalog-heading').textContent, '任务清单');
    assert.equal(
      getComputedStyle(f.host.querySelector('h1.zm-catalog-heading')).position,
      'absolute',
    );
    assert.ok(f.host.querySelector('.zm-page-bar .zm-catalog-actions'));
    await f.click(f.button('项目', nav));
    assert.equal(f.host.querySelector('h1.zm-catalog-heading').textContent, '项目');
    assert.equal(f.host.querySelector('.zm-page-heading'), null);
    await f.click(f.button('资产', nav));
    assert.equal(f.host.querySelector('h1.zm-catalog-heading').textContent, '资产');
    assert.equal(f.host.querySelector('.zm-page-heading'), null);
    assert.equal(!!f.button('在线文档'), true);
    await f.click(f.button('在线文档'));
    await f.settle();
    assert.equal(f.host.querySelector('h1').textContent, '知识资料');
    assert.equal(
      nav.querySelector('button[aria-current="page"]').textContent.includes('资产'),
      true,
    );
  },
);

test(
  'normal member upload keeps the same detail element while its parent snapshot is held and after the acknowledgement projection returns',
  dom,
  async (t) => {
    const data = source(),
      state = emptyWorkbench(),
      held = Promise.withResolvers();
    let reads = 0;
    const adapter = createMemberWorkbenchAdapter(
      {
        snapshot: async () => {
          if (++reads === 3) await held.promise;
          return {
            actorId: 'ann',
            spaceId,
            space: { id: spaceId, kind: 'team', name: '团队' },
            state,
            model: null,
            capabilities: {
              createProject: true,
              createTask: true,
              planning: false,
              resources: 'authorized',
              tasks: [],
            },
          };
        },
      },
      'ann',
    );
    const f = await mount(t, data, WorkbenchPage, {
      api: adapter,
      initialSection: 'tasks',
      appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
      memberAssets: {
        api: data.api,
        spaceId,
        lifetime: { isCurrent: () => true, onUnauthenticated() {} },
      },
    });
    await f.click(f.button('资产'));
    await f.settle();
    await f.choose('新建资产', '文件资料');
    await f.input('名称', '上传后保位');
    await f.click(f.button('保存草稿'));
    await f.settle();
    const savedField = f.field('名称'),
      input = f.host.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['actual synthetic file'], 'keep.txt', { type: 'text/plain' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(setImmediate);
    });
    await f.settle();
    await f.settle();
    assert.equal(data.calls.upload.length, 1);
    assert.equal(reads, 3);
    assert.equal(
      f.field('名称') === savedField,
      true,
      'held parent refresh retains the detail instance',
    );
    assert.equal(f.field('名称').value, '上传后保位');
    await act(async () => {
      held.resolve();
      await new Promise(setImmediate);
    });
    await f.settle();
    assert.equal(
      f.field('名称') === savedField,
      true,
      'completed parent refresh retains the detail instance',
    );
    assert.equal(!!f.button('发布'), true);
  },
);

test(
  'member import UI contract: full static preview, excluded private bytes, draft-only writes and exact retry after a lost reply',
  dom,
  async (t) => {
    const key = 'SKILL.md',
      preview = {
        actorId: 'ann',
        spaceId,
        packageChecksum: 'c'.repeat(64),
        ignored: [],
        items: [
          {
            key,
            kind: 'skill',
            name: '接口兼容',
            description: '检查字段',
            content: '<script>UNTRUSTED</script>\n' + 'x'.repeat(12000),
            role: '',
            capabilities: [],
            skillKeys: [],
            missing: [],
            requirements: [],
            filePaths: [key],
          },
        ],
      };
    const writes = [],
      uploads = [];
    let imported = 0,
      privateReads = 0;
    const api = {
      async previewImport(input) {
        uploads.push(input);
        return preview;
      },
      async importDrafts(input) {
        writes.push(structuredClone(input));
        if (writes.length === 1) throw new MemberAssetClientError('asset-unavailable', 'unknown');
        return { disposition: 'replayed', assets: [] };
      },
    };
    const f = await mount(t, { api }, MemberAssetImportDialog, {
      close() {},
      imported() {
        imported++;
      },
    });
    const files = [
      new File(['---\nname: api-check\n---\nFull content'], key),
      new File(['PRIVATE'], '.env'),
    ];
    files[1].arrayBuffer = async () => {
      privateReads++;
      throw Error('private file was read');
    };
    const input = f.host.querySelector('input[aria-label="导入资产文件"]');
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(setImmediate);
    });
    await f.settle();
    assert.equal(privateReads, 0);
    assert.equal(uploads[0].upload.files.find((item) => item.path === '.env').data, '');
    assert.equal(f.host.querySelectorAll('script').length, 0);
    assert.equal(f.host.querySelector('pre').textContent, preview.items[0].content);
    await f.click(f.button('导入为草稿'));
    assert.equal(f.field('导入名称').disabled, true);
    await f.click(f.button('重试原请求'));
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(writes[0].choices.length, 1);
    assert.equal(writes[0].choices[0].dependencies.length, 0);
    assert.equal(imported, 1);
  },
);

test(
  'CodeArts setup UI contract: mounting reads only status; explicit save preserves the command and refreshes normal Run options',
  dom,
  async (t) => {
    const calls = [];
    let changed = 0,
      closed = 0;
    const api = {
      async status() {
        calls.push('status');
        return { configured: false };
      },
      async configure(command) {
        calls.push(command);
        return { configured: true };
      },
    };
    const f = await mount(t, { api }, CodeArtsSetupDialog, {
      close() {
        closed++;
      },
      async changed() {
        changed++;
      },
    });
    await f.settle();
    assert.deepEqual(calls, ['status']);
    await f.input('码道命令', '/synthetic path/codearts');
    await f.click(f.button('保存配置'));
    assert.deepEqual(calls, ['status', '/synthetic path/codearts']);
    assert.equal(changed, 1);
    assert.equal(closed, 1);
  },
);

test(
  'asset panel contract: member navigation opens authoritative assets, without an owner save or duplicate creation toolbar',
  dom,
  async (t) => {
    const data = source(),
      state = emptyWorkbench();
    const adapter = createMemberWorkbenchAdapter(
      {
        snapshot: async () => ({
          actorId: 'ann',
          spaceId,
          space: { id: spaceId, kind: 'team', name: '团队' },
          state,
          model: null,
          capabilities: {
            createProject: true,
            createTask: true,
            planning: false,
            resources: 'authorized',
            tasks: [],
          },
        }),
      },
      'ann',
    );
    const f = await mount(t, data, WorkbenchPage, {
      api: adapter,
      initialSection: 'tasks',
      appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
      memberAssets: {
        api: data.api,
        spaceId,
        lifetime: { isCurrent: () => true, onUnauthenticated() {} },
      },
    });
    await f.click(f.button('资产'));
    await f.settle();
    assert.ok(!!f.host.querySelector('input[aria-label="搜索团队资产"]'));
    assert.equal(data.calls.catalog.length, 1);
    assert.equal(f.host.textContent.includes('暂未接入这项定义管理'), false);
    assert.equal(f.host.querySelectorAll('button[aria-label="新建资产"]').length, 1);
    await f.choose('新建资产', 'Skill');
    await f.input('名称', '原位置继续编辑');
    await f.input('Skill 内容', '完整定义');
    await f.click(f.button('保存草稿'));
    await f.settle();
    assert.equal(
      f.field('名称')?.value,
      '原位置继续编辑',
      'refreshing the parent catalog must not unmount the saved detail',
    );
  },
);

test(
  'asset panel contract: unknown save ACK locks editing and retries exactly the same draft intent',
  dom,
  async (t) => {
    const data = source([], {
        command(_input, attempt) {
          if (attempt === 1) throw new MemberAssetClientError('asset-unavailable', 'unknown');
        },
      }),
      f = await mount(t, data);
    await f.choose('新建资产', 'Skill');
    await f.input('名称', '接口规范');
    await f.input('Skill 内容', '完整内容\n' + 'y'.repeat(12000));
    await f.click(f.button('保存草稿'));
    assert.equal(f.field('名称').disabled, true);
    assert.ok(!!f.button('重试原请求'));
    await f.click(f.button('重试原请求'));
    await f.settle();
    assert.deepEqual(data.calls.command[0], data.calls.command[1]);
    assert.equal(data.calls.command[1].definition.content.length, 12005);
    assert.equal(f.field('名称').disabled, false);
    assert.ok(f.host.textContent.includes('草稿已保存'));
  },
);

test(
  'asset panel contract: text/file delivery uses real chosen bytes and declaration; publish becomes available only after acknowledged upload',
  dom,
  async (t) => {
    const held = Promise.withResolvers(),
      admitted = Promise.withResolvers();
    const data = source([], {
        upload() {
          admitted.resolve();
          return held.promise;
        },
      }),
      f = await mount(t, data);
    await f.choose('新建资产', '文件资料');
    await f.input('名称', '接口文档');
    assert.equal(f.host.querySelector('input[type="file"]').disabled, true);
    await f.click(f.button('保存草稿'));
    await f.settle();
    const control = f.host.querySelector('input[type="file"]');
    assert.equal(control.disabled, false);
    assert.equal(f.button('发布').disabled, true);
    const file = new File(['真实文件字节'], 'spec.txt', { type: 'text/plain' });
    Object.defineProperty(control, 'files', { configurable: true, value: [file] });
    await act(async () => {
      control.dispatchEvent(new Event('change', { bubbles: true }));
      await admitted.promise;
    });
    assert.ok(f.host.textContent.includes('正在上传文件'));
    assert.equal(f.host.textContent.includes('100%'), false);
    assert.equal(f.button('发布').disabled, true);
    await act(async () => {
      held.resolve();
      await new Promise(setImmediate);
    });
    await f.settle();
    const recorded = data.calls.upload[0];
    assert.equal(recorded.file, file);
    assert.equal(
      recorded.input.declare.sha256,
      createHash('sha256').update('真实文件字节').digest('hex'),
    );
    assert.equal('taskId' in recorded.input, false);
    assert.equal(f.button('发布').disabled, false);
    await f.click(f.button('发布'));
    await f.settle();
    assert.ok(!!f.button('预览'));
    assert.ok(!!f.button('下载'));
    assert.ok(f.host.textContent.includes('已发布'));
  },
);

test(
  'asset panel contract: late details cannot replace a newer selection, and failures never become empty catalog success',
  dom,
  async (t) => {
    const first = summary({ name: '第一位' }),
      second = summary({ name: '第二位' }),
      held = Promise.withResolvers();
    const data = source([first, second], {
        read: (query) =>
          query.assetId === first.assetId ? held.promise : Promise.resolve(valueOf(second)),
      }),
      f = await mount(t, data);
    await f.click(f.host.querySelectorAll('.zm-member-asset-row')[0]);
    await f.click(f.host.querySelectorAll('.zm-member-asset-row')[1]);
    await act(async () => {
      held.resolve(valueOf(first));
      await new Promise(setImmediate);
    });
    assert.equal(f.field('名称').value, '第二位');
    const failing = source([], {
        catalog() {
          throw new MemberAssetClientError('asset-unavailable');
        },
      }),
      g = await mount(t, failing);
    assert.ok(g.host.textContent.includes('资产服务暂不可用'));
    assert.equal(g.host.textContent.includes('还没有资产'), false);
  },
);
