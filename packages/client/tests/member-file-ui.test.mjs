/** Real React DOM interaction contracts; no Host authority or uploaded bytes are inferred. */
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
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
const { createElement: el, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DeliveryPanel } = await import('../dist/execution/DeliveryPanel.js');
const { ReviewWorkspace } = await import('../dist/execution/ReviewWorkspace.js');
const { RevisionPanel } = await import('../dist/execution/RevisionPanel.js');
const { UpstreamContentBody } = await import('../dist/execution/UpstreamContent.js');
const { deliveryNode, reviewNode } = await import('./browser/execution-fixture.mjs');
const tick = () => new Promise(setImmediate);
const ref = (id = 'upload', size = 3) => ({
  id,
  byteSize: size,
  mediaType: 'text/plain',
  checksum: 'a'.repeat(64),
  accessPolicyId: 'space:north',
  uploadComplete: true,
});
const empty = () => ({ version: 0, text: '', links: [], files: [] });
function api(extra = {}) {
  const calls = [],
    details = new Map();
  let draft = empty();
  const files = {
    async upload({ file, requestId }, signal) {
      calls.push(['upload', file, requestId, signal]);
      const reference = ref(requestId, file.size);
      details.set(requestId, { name: file.name, reference });
      return { uploadId: requestId, name: file.name, reference };
    },
    async metadata(query) {
      calls.push(['metadata', query]);
      const item = details.get(query.uploadId) ?? {
        name: '原始文件.txt',
        reference: ref(query.uploadId),
      };
      return {
        uploadId: query.uploadId,
        name: item.name,
        mediaType: item.reference.mediaType,
        bytes: item.reference.byteSize,
        sha256: item.reference.checksum,
        reference: item.reference,
      };
    },
    async read(query, mode) {
      calls.push(['read', query, mode]);
      return {
        info: await files.metadata(query),
        bytes: new TextEncoder().encode('正文'),
        inline: true,
      };
    },
  };
  const result = {
    files,
    async readDeliveryDraft() {
      return draft;
    },
    async saveDeliveryDraft(input) {
      calls.push(['save', input]);
      draft = {
        version: 1,
        text: input.text,
        links: input.links,
        files: input.files,
        fileDetails: input.files.map((file) => ({
          id: file.id,
          name: details.get(file.id)?.name ?? '原始文件.txt',
        })),
      };
      return draft;
    },
    async submit(input) {
      calls.push(['submit', input]);
      return { ...deliveryNode, status: 'in-review' };
    },
    ...extra,
  };
  return { api: result, calls, details };
}
async function mount(component, props) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el(component, props));
    await tick();
  });
  return {
    container,
    async update(next) {
      await act(async () => {
        root.render(el(component, next));
        await tick();
      });
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
function button(container, text) {
  const found = [...container.querySelectorAll('button')].find(
    (item) =>
      (item.querySelector('.zm-button-label')?.textContent ?? item.textContent).trim() === text,
  );
  assert.ok(found, `Missing button ${text}`);
  return found;
}
async function click(item) {
  await act(async () => {
    item.click();
    await tick();
  });
}
async function select(container, files) {
  await act(async () => {
    const input = container.querySelector('input[type="file"]');
    assert.ok(input);
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
  });
}

test(
  'file DOM contract: multiple uploads enable an empty-text file-only submission and retain names through draft save',
  { skip: !window },
  async () => {
    const h = api();
    const m = await mount(DeliveryPanel, { api: h.api, node: deliveryNode, onSubmitted() {} });
    try {
      await select(m.container, [
        new File(['one'], '一.txt', { type: 'text/plain' }),
        new File(['two'], '二.txt', { type: 'text/plain' }),
      ]);
      assert.equal(h.calls.filter((call) => call[0] === 'upload').length, 2);
      assert.match(m.container.textContent, /一.txt/);
      assert.match(m.container.textContent, /二.txt/);
      await click(button(m.container, '保存草稿'));
      assert.equal(h.calls.find((call) => call[0] === 'save')[1].files.length, 2);
      await click(button(m.container, '提交产物'));
      const submitted = h.calls.find((call) => call[0] === 'submit')[1];
      assert.equal(submitted.text, '');
      assert.equal(submitted.files.length, 2);
    } finally {
      await m.close();
    }
  },
);

test(
  'file DOM contract: failed upload retries the exact original File and idempotency key',
  { skip: !window },
  async () => {
    const h = api();
    const original = h.api.files.upload;
    let failed = false;
    h.api.files.upload = async (...args) => {
      if (!failed) {
        failed = true;
        h.calls.push(['failed', args[0].file, args[0].requestId]);
        throw Error('uncertain');
      }
      return original(...args);
    };
    const m = await mount(DeliveryPanel, { api: h.api, node: deliveryNode, onSubmitted() {} });
    try {
      const file = new File(['one'], '重试.txt', { type: 'text/plain' });
      await select(m.container, [file]);
      assert.equal(button(m.container, '提交产物').disabled, true);
      await click(button(m.container, '重试'));
      const failedCall = h.calls.find((call) => call[0] === 'failed'),
        success = h.calls.find((call) => call[0] === 'upload');
      assert.equal(success[1], file);
      assert.equal(success[1], failedCall[1]);
      assert.equal(success[2], failedCall[2]);
      assert.equal(button(m.container, '提交产物').disabled, false);
    } finally {
      await m.close();
    }
  },
);

test(
  'file DOM contract: node/round replacement cancels a paused upload and ignores its late receipt',
  { skip: !window },
  async () => {
    const gate = Promise.withResolvers(),
      h = api();
    let signal;
    h.api.files.upload = async (input, current) => {
      signal = current;
      await gate.promise;
      return { uploadId: 'late', name: '迟到.txt', reference: ref('late') };
    };
    const props = { api: h.api, node: deliveryNode, onSubmitted() {} },
      m = await mount(DeliveryPanel, props);
    try {
      await select(m.container, [new File(['one'], '迟到.txt')]);
      await m.update({
        ...props,
        node: {
          ...deliveryNode,
          version: deliveryNode.version + 1,
          currentRoundId: 'different-round',
        },
      });
      assert.equal(signal.aborted, true);
      await act(async () => {
        gate.resolve();
        await tick();
      });
      assert.equal(m.container.textContent.includes('迟到.txt'), false);
      await click(button(m.container, '提交产物'));
      assert.equal(
        h.calls.some((call) => call[0] === 'submit'),
        false,
      );
    } finally {
      gate.resolve();
      await m.close();
    }
  },
);

test(
  'file DOM contract: review, returned version and downstream previews bind their exact purposes and fixed versions',
  { skip: !window },
  async () => {
    const h = api();
    const file = ref('upload', 3),
      artifact = { ...reviewNode.artifacts[0], files: [file] };
    const node = { ...reviewNode, artifacts: [artifact] };
    const review = await mount(ReviewWorkspace, { api: h.api, node, onSubmitted() {} });
    try {
      await click(button(review.container, '预览'));
      const query = h.calls.find((call) => call[0] === 'read')[1];
      assert.equal(query.purpose, 'review');
      assert.equal(query.roundId, 'round-1');
      assert.equal(query.artifactVersionId, 'artifact-1');
      assert.equal(review.container.querySelector('pre').textContent, '正文');
    } finally {
      await review.close();
    }
    h.calls.length = 0;
    const locator = {
      taskId: node.taskId,
      planId: node.planId,
      revision: node.revision,
      nodeId: node.nodeId,
    };
    const revision = await mount(RevisionPanel, {
      api: h.api,
      target: locator,
      view: { reviewed: { id: 'old', version: 1, text: '', links: [], files: [file] }, notes: [] },
    });
    try {
      await click(button(revision.container, '预览'));
      assert.equal(h.calls.find((call) => call[0] === 'read')[1].artifactVersionId, 'old');
      assert.equal(h.calls.find((call) => call[0] === 'read')[1].purpose, 'artifact');
    } finally {
      await revision.close();
    }
    h.calls.length = 0;
    const upstream = await mount(UpstreamContentBody, {
      api: h.api,
      target: {
        ...locator,
        nodeId: 'downstream',
        purpose: 'upstream',
        sourceNodeId: 'design',
        artifactVersionId: 'accepted',
      },
      content: { text: '', links: [], files: [file] },
    });
    try {
      await click(button(upstream.container, '预览'));
      const query = h.calls.find((call) => call[0] === 'read')[1];
      assert.equal(query.nodeId, 'downstream');
      assert.equal(query.sourceNodeId, 'design');
      assert.equal(query.artifactVersionId, 'accepted');
    } finally {
      await upstream.close();
    }
  },
);
