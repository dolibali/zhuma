/** Real React DOM with explicit service fixtures. These are UI contracts,
 * not browser painting, member authority, CLI or model acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
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
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { emptyWorkbench } = await import('@zhuma/agent-core');
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
  const calls = { command: [], read: [], upload: [], catalog: [] };
  const api = {
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
    await f.click(f.button('团队资产'));
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
