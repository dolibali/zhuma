/** Pure component/React DOM contracts with explicit parent fixtures. No member
 * API, saving, authorization, normal browser/Host or visual acceptance proof.
 * Existing optional DOM runtime is imported only; never installed by this test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { emptyWorkbench } from '@zhuma/agent-core';
const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
let window;
if (domModule) {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
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
const { createElement, act } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemberAssetDefinitionFields } =
  await import('../dist/workbench/MemberAssetDefinitionFields.js');
const reference = (patch = {}) => ({
  spaceId: 'north',
  assetId: 'method',
  kind: 'skill',
  versionId: randomUUID(),
  sha256: 'a'.repeat(64),
  ...patch,
});
const unknown = { slotId: 'unknown-slot', reference: reference({ assetId: 'prior-source' }) };
const expert = {
  kind: 'expert',
  name: 'Reviewer',
  description: 'Review a fixed version',
  role: 'Independent reviewer',
  capabilities: ['Review'],
  instructions: 'Keep complete instructions.\n  Preserve spacing.',
};
const props = (value) => ({
  value,
  dependencies: [structuredClone(unknown)],
  choices: [],
  onChange() {
    throw Error('Rendering never changes the parent');
  },
});

test('definition fields SSR: all types expose their real fields, file metadata has no false upload/save/publish controls', () => {
  for (const value of [
    expert,
    { kind: 'skill', name: 'Method', description: '', content: 'FULL\n' + 'x'.repeat(10000) },
    { kind: 'template', name: 'Flow', description: '', content: '{broken\n' + 'y'.repeat(12000) },
    { kind: 'file', name: 'Guide', description: 'Original bytes are separate' },
  ]) {
    const html = renderToStaticMarkup(createElement(MemberAssetDefinitionFields, props(value)));
    assert.ok(html.includes('名称'));
    assert.ok(html.includes('描述'));
    assert.ok(html.includes('unknown-slot'));
    assert.doesNotMatch(html, /type="file"|提交产物|保存草稿|发布资产/);
    if ('content' in value) assert.ok(html.includes(value.content));
    if (value.kind === 'expert') assert.ok(html.includes('专家指令'));
    if (value.kind === 'template') assert.ok(html.includes('原内容已完整保留'));
  }
});

test('definition fields SSR: read-only source definition and global disabled have separate semantics without changing dependencies', () => {
  const html = renderToStaticMarkup(
    createElement(MemberAssetDefinitionFields, { ...props(expert), readOnlyDefinition: true }),
  );
  assert.ok(html.includes('readonly=""'));
  assert.doesNotMatch(html, /disabled=""/);
  const all = renderToStaticMarkup(
    createElement(MemberAssetDefinitionFields, { ...props(expert), disabled: true }),
  );
  assert.ok(all.includes('disabled=""'));
});

async function mount(t, patch = {}) {
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    changes = [];
  let current = { ...props(structuredClone(expert)), ...patch };
  const onChange = (value, dependencies) => {
    changes.push(structuredClone({ value, dependencies }));
    current = { ...current, value, dependencies };
    root.render(createElement(MemberAssetDefinitionFields, { ...current, onChange }));
  };
  const render = async (next = {}) => {
    current = { ...current, ...next };
    await act(async () => {
      root.render(createElement(MemberAssetDefinitionFields, { ...current, onChange }));
      await new Promise(setImmediate);
    });
  };
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await render();
  const field = (label) => {
    const node = [...host.querySelectorAll('label')].find((item) => item.textContent === label);
    assert.ok(node, label);
    const input = document.getElementById(node.htmlFor);
    assert.ok(input, label);
    return input;
  };
  return {
    host,
    root,
    changes,
    field,
    render,
    current: () => current,
    async input(label, text) {
      const element = field(label),
        proto =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, text);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    async blur(label) {
      await act(async () => {
        field(label).dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
    },
    async click(element) {
      await act(async () => {
        element.click();
        await new Promise(setImmediate);
      });
    },
    async key(element, key) {
      await act(async () => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        await new Promise(setImmediate);
      });
    },
  };
}
const dom = { skip: !domModule, timeout: 15000 };

test(
  'DOM contract: expert fields retain full raw instructions, capability separators remain typeable and unrelated fixed dependencies survive',
  dom,
  async (t) => {
    const h = await mount(t),
      before = structuredClone(h.current().dependencies),
      raw = '  Full instructions\n<literal>\n' + 'z'.repeat(10000);
    await h.blur('能力关键词（逗号或换行分隔）');
    assert.equal(h.changes.length, 0, 'Merely leaving an unchanged field is not an edit');
    await h.input('专家指令', raw);
    assert.equal(h.current().value.instructions, raw);
    await h.input('角色定位', 'Review independently');
    assert.equal(h.current().value.role, 'Review independently');
    await h.input('能力关键词（逗号或换行分隔）', 'One\n');
    assert.equal(h.field('能力关键词（逗号或换行分隔）').value, 'One\n');
    await h.input('能力关键词（逗号或换行分隔）', 'One\nTwo, Three');
    await h.blur('能力关键词（逗号或换行分隔）');
    assert.deepEqual(h.current().value.capabilities, ['One', 'Two', 'Three']);
    assert.deepEqual(h.current().dependencies, before);
    assert.notEqual(h.current().dependencies[0].reference, before[0].reference);
  },
);

test(
  'DOM contract: switching definition types does not trim complete Skill/template content or infer file-byte success',
  dom,
  async (t) => {
    const skill = { kind: 'skill', name: 'Method', description: '', content: '' },
      h = await mount(t, { value: skill });
    const raw = '  Complete Skill\n' + 's'.repeat(20000);
    await h.input('Skill 内容', raw);
    assert.equal(h.current().value.content, raw);
    const count = h.changes.length,
      template = {
        kind: 'template',
        name: 'Flow',
        description: '',
        content: '{invalid\n' + 't'.repeat(15000),
      };
    await h.render({ value: template });
    assert.equal(h.changes.length, count);
    assert.equal(h.field('工作流完整内容').value, template.content);
    assert.equal(h.host.textContent.includes('原内容已完整保留'), true);
    assert.equal(
      [...h.host.querySelectorAll('button')].some((button) =>
        button.textContent.includes('编辑工作流结构'),
      ),
      false,
    );
    await h.render({ value: { kind: 'file', name: 'Guide', description: '' } });
    assert.equal(h.host.querySelector('input[type="file"]'), null);
    assert.equal(h.host.querySelectorAll('textarea').length, 1);
  },
);

test(
  'DOM contract: keyboard Skill selection keeps complete fixed ref and preserves unknown/MCP requirements without inventing satisfaction',
  dom,
  async (t) => {
    const first = reference(),
      second = reference({ assetId: 'another-method', sha256: 'b'.repeat(64) });
    const missing = { slotId: 'method-slot', reference: reference({ assetId: 'unavailable' }) };
    const connection = { slotId: 'mcp-slot', reference: reference({ assetId: 'old-connection' }) };
    const h = await mount(t, {
      dependencies: [missing, unknown, connection],
      choices: [
        { reference: first, name: 'Method', version: 1 },
        { reference: second, name: 'Method', version: 1 },
      ],
      requirements: [
        { slotId: 'method-slot', kind: 'skill' },
        { slotId: 'mcp-slot', kind: 'mcp' },
      ],
    });
    assert.equal(h.changes.length, 0);
    assert.ok(h.host.textContent.includes('MCP 尚未满足'));
    assert.ok(h.host.textContent.includes('unknown-slot'));
    const trigger = h.field('Skill 依赖 · method-slot');
    trigger.focus();
    await h.key(trigger, 'ArrowDown');
    assert.ok(document.querySelector('[role="listbox"]'));
    assert.ok(document.body.textContent.includes('north/method'));
    assert.ok(document.body.textContent.includes('north/another-method'));
    await h.key(document.activeElement, 'End');
    await h.key(document.activeElement, 'Enter');
    assert.deepEqual(
      h.current().dependencies.find((item) => item.slotId === 'method-slot').reference,
      second,
    );
    assert.deepEqual(
      h.current().dependencies.find((item) => item.slotId === 'unknown-slot'),
      unknown,
    );
    assert.deepEqual(
      h.current().dependencies.find((item) => item.slotId === 'mcp-slot'),
      connection,
    );
    assert.ok(h.host.textContent.includes('MCP 尚未满足'));
  },
);

test(
  'DOM contract: source text remains read-only while dependency mapping works; global disabled rejects all changes',
  dom,
  async (t) => {
    const fixed = reference(),
      h = await mount(t, {
        readOnlyDefinition: true,
        requirements: [{ slotId: 'method-slot', kind: 'skill' }],
        choices: [{ reference: fixed, name: 'Method', version: 1 }],
      });
    assert.equal(h.field('名称').readOnly, true);
    assert.equal(h.field('名称').disabled, false);
    await h.input('名称', 'Do not change source');
    assert.equal(h.changes.length, 0);
    const trigger = h.field('Skill 依赖 · method-slot');
    assert.equal(trigger.disabled, false);
    trigger.focus();
    await h.key(trigger, 'ArrowDown');
    await h.key(document.activeElement, 'End');
    await h.key(document.activeElement, 'Enter');
    assert.deepEqual(
      h.current().dependencies.find((item) => item.slotId === 'method-slot').reference,
      fixed,
    );
    const count = h.changes.length;
    await h.render({ disabled: true });
    assert.equal(h.field('名称').disabled, true);
    assert.equal(h.field('Skill 依赖 · method-slot').disabled, true);
    await h.input('专家指令', 'Ignored');
    await h.click(h.field('Skill 依赖 · method-slot'));
    assert.equal(h.changes.length, count);
    assert.equal(h.field('Skill 依赖 · method-slot').getAttribute('aria-expanded'), 'false');
  },
);

test(
  'DOM contract: template structure editor requires actual parent state and closes across disable without later reopening',
  dom,
  async (t) => {
    const h = await mount(t, {
      value: { kind: 'template', name: 'Flow', description: '', content: '' },
    });
    assert.equal(
      [...h.host.querySelectorAll('button')].some((button) =>
        button.textContent.includes('编辑工作流结构'),
      ),
      false,
    );
    await h.render({ authoringState: emptyWorkbench() }); // Explicit authoring fixture, never member authority.
    const edit = [...h.host.querySelectorAll('button')].find((button) =>
      button.textContent.includes('编辑工作流结构'),
    );
    assert.ok(edit);
    await h.click(edit);
    assert.ok(document.querySelector('dialog'));
    await h.render({ disabled: true });
    assert.equal(Boolean(document.querySelector('dialog')), false);
    await h.render({ disabled: false });
    assert.equal(Boolean(document.querySelector('dialog')), false);
    assert.equal(h.changes.length, 0);
    const bad = {
      kind: 'template',
      name: 'Broken',
      description: '',
      content: '{do not replace this original',
    };
    await h.render({ value: bad });
    assert.equal(
      [...h.host.querySelectorAll('button')].find((button) =>
        button.textContent.includes('编辑工作流结构'),
      ).disabled,
      true,
    );
    assert.equal(h.field('工作流完整内容').value, bad.content);
  },
);
