import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExecutionApi, readSavedDeliveryDraft } from '../dist/execution/ExecutionApi.js';
import { DeliveryPanel } from '../dist/execution/DeliveryPanel.js';

const node = {
  nodeId: 'publish',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  version: 1,
  status: 'ready',
  goal: '发布登录说明',
  expectedOutput: '说明',
  assigneeId: 'chen',
  reviewerIds: [],
  artifacts: [],
  rounds: [],
  comments: [],
};

test('delivery draft read keeps the text and drops echoed identifiers', () => {
  const read = readSavedDeliveryDraft({
    version: 2,
    text: '草稿正文-4e1',
    links: ['https://example.test/a'],
    files: [],
    idempotencyKey: 'secret-key-4e1',
    nodeId: 'node-sealed-4e1',
    taskId: 'task-sealed-4e1',
  });
  assert.deepEqual(read, {
    version: 2,
    text: '草稿正文-4e1',
    links: ['https://example.test/a'],
    files: [],
  });
  assert.equal(JSON.stringify(read).includes('secret-key-4e1'), false);
  assert.equal(JSON.stringify(read).includes('node-sealed-4e1'), false);
});

test('the delivery page offers to save a draft', () => {
  const api = {
    async readDeliveryDraft() {
      return { version: 0, text: '', links: [], files: [] };
    },
    async saveDeliveryDraft() {
      throw new Error('save was not clicked');
    },
    async submit() {
      throw new Error('submit was not clicked');
    },
    async inbox() {
      throw new Error('inbox was not clicked');
    },
    async ballot() {
      throw new Error('ballot was not clicked');
    },
    async revision() {
      throw new Error('revision was not clicked');
    },
  };
  const html = renderToStaticMarkup(createElement(DeliveryPanel, { api, node, onSubmitted() {} }));
  assert.match(html, /保存草稿/);
  assert.match(html, /提交产物/);
});

test('save and read both call the draft endpoint', async () => {
  const calls = [];
  const api = createExecutionApi({
    async call(_prefix, method, payload) {
      calls.push({ method, payload });
      return {
        ok: true,
        value: {
          version: 1,
          text: payload.text ?? '',
          links: payload.links ?? [],
          files: payload.files ?? [],
        },
      };
    },
  });
  const query = { taskId: 'task', planId: 'plan', revision: 1, nodeId: 'publish' };
  const read = await api.readDeliveryDraft(query);
  assert.equal(read.version, 1);
  const saved = await api.saveDeliveryDraft({
    ...query,
    expectedVersion: 0,
    idempotencyKey: 'draft-key-4e1',
    text: '草稿正文-4e1',
  });
  assert.equal(saved.text, '草稿正文-4e1');
  assert.deepEqual(
    calls.map((item) => item.method),
    ['zhuma-exec/draft', 'zhuma-exec/draft'],
  );
  assert.equal(calls[0].payload.idempotencyKey, undefined);
  assert.equal(calls[1].payload.text, '草稿正文-4e1');
  assert.equal(calls[1].payload.expectedVersion, 0);
  assert.equal(JSON.stringify(calls).includes('actorId'), false);
});
