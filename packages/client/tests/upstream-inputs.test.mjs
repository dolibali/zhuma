import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExecutionApi, readExecutionNode } from '../dist/execution/ExecutionApi.js';
import { DeliveryPanel } from '../dist/execution/DeliveryPanel.js';

const node = {
  nodeId: 'publish',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  version: 2,
  status: 'ready',
  goal: '发布登录说明',
  expectedOutput: '说明',
  assigneeId: 'chen',
  reviewerIds: [],
  artifacts: [],
  rounds: [],
  comments: [],
  inputs: [
    {
      access: 'visible',
      sourceNodeId: 'design',
      sourceGoal: '设计登录接口',
      version: 2,
      name: 'artifact-2',
      text: '错误码说明',
      files: [{ id: 'spec.pdf' }],
    },
    {
      access: 'redacted',
      sourceNodeId: 'hidden',
      sourceGoal: '机密目标',
      name: 'artifact-secret',
      version: 4,
      text: '机密正文',
      files: [{ id: 'secret.pdf' }],
    },
  ],
};

test('delivery read keeps the upstream reference and drops hidden file names', () => {
  const read = readExecutionNode(node);
  assert.deepEqual(read.inputs, [
    {
      access: 'visible',
      sourceNodeId: 'design',
      sourceGoal: '设计登录接口',
      version: 2,
      name: 'artifact-2',
    },
    { access: 'redacted', sourceNodeId: 'hidden' },
  ]);
  const encoded = JSON.stringify(read);
  for (const secret of [
    '错误码说明',
    'spec.pdf',
    '机密目标',
    '机密正文',
    'secret.pdf',
    'artifact-secret',
  ]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

test('the delivery page lists the goal and a placeholder for a hidden upstream', async () => {
  const api = createExecutionApi({
    async call() {
      return { ok: true, value: { node } };
    },
  });
  const html = renderToStaticMarkup(
    createElement(DeliveryPanel, { api, node: readExecutionNode(node), onSubmitted() {} }),
  );
  assert.match(html, /目标/);
  assert.match(html, /发布登录说明/);
  assert.match(html, /来源节点/);
  assert.match(html, /design/);
  assert.match(html, /设计登录接口/);
  assert.match(html, /版本<\/span> 2/);
  assert.match(html, /产物/);
  assert.match(html, /artifact-2/);
  assert.match(html, /没有权限查看来源节点 hidden 的产物/);
  for (const secret of ['spec.pdf', '机密', 'secret.pdf', 'artifact-secret', '错误码说明']) {
    assert.equal(html.includes(secret), false, secret);
  }
  const empty = renderToStaticMarkup(
    createElement(DeliveryPanel, {
      api,
      node: { ...node, inputs: [] },
      onSubmitted() {},
    }),
  );
  assert.match(empty, /没有已接受的上游产物/);
});
