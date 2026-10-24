import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExecutionApi, readExecutionNode } from '../dist/execution/ExecutionApi.js';
import { DeliveryPanel } from '../dist/execution/DeliveryPanel.js';

const noneMessage = '上游节点 draft 尚无已接受版本。';
const replacedMessage = '上游节点 moved 已有新的已接受版本，当前引用的版本已被取代。';
const hiddenMessage = '有 2 个上游来源你没有权限查看。';

const node = {
  nodeId: 'publish',
  taskId: 'task-page-4e1',
  planId: 'plan-page-4e1',
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
      blocking: false,
      sourceNodeId: 'design',
      sourceGoal: '设计登录接口',
      version: 2,
      name: '第2版',
      text: '错误码说明',
      files: [{ id: 'spec.pdf' }],
      idempotencyKey: 'idem-key-4e1',
    },
    {
      access: 'hidden',
      count: 2,
      blocking: true,
      sourceNodeId: 'node-sealed-4e1',
      taskId: 'task-sealed-4e1',
      spaceId: 'space-sealed-4e1',
      message:
        '有 2 个上游来源你没有权限查看。泄露 node-sealed-4e1 task-sealed-4e1 space-sealed-4e1',
      name: 'artifact-sealed-4e1',
      text: 'sealed-body-4e1',
      files: [{ id: 'sealed.pdf' }],
    },
  ],
};

function page(inputs) {
  const api = createExecutionApi({
    async call() {
      return { ok: true, value: { node } };
    },
  });
  return renderToStaticMarkup(
    createElement(DeliveryPanel, {
      api,
      node: readExecutionNode({ ...node, inputs }),
      onSubmitted() {},
    }),
  );
}

test('delivery read keeps a visible ref and drops hidden identifiers', () => {
  const read = readExecutionNode(node);
  assert.deepEqual(read.inputs, [
    {
      access: 'visible',
      blocking: false,
      sourceNodeId: 'design',
      sourceGoal: '设计登录接口',
      version: 2,
      name: '第2版',
    },
    { access: 'hidden', blocking: true, count: 2, message: hiddenMessage },
  ]);
  const encoded = JSON.stringify(read);
  for (const secret of [
    '错误码说明',
    'spec.pdf',
    'idem-key-4e1',
    'node-sealed-4e1',
    'task-sealed-4e1',
    'space-sealed-4e1',
    'artifact-sealed-4e1',
    'sealed-body-4e1',
    'sealed.pdf',
    '泄露',
  ]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

test('the delivery page counts hidden sources and disables submit', () => {
  const html = page(node.inputs);
  assert.match(html, /目标/);
  assert.match(html, /发布登录说明/);
  assert.match(html, /来源节点/);
  assert.match(html, /design/);
  assert.match(html, /设计登录接口/);
  assert.match(html, /版本<\/span> 2/);
  assert.match(html, /产物/);
  assert.match(html, /第2版/);
  assert.equal(html.includes('artifact:idem-key-4e1'), false);
  assert.match(html, /有 2 个上游来源你没有权限查看/);
  assert.match(html, /<button[^>]*disabled/);
  for (const secret of [
    'spec.pdf',
    '错误码说明',
    'idem-key-4e1',
    'node-sealed-4e1',
    'task-sealed-4e1',
    'space-sealed-4e1',
    'task-page-4e1',
    'plan-page-4e1',
    'artifact-sealed-4e1',
    'sealed.pdf',
    '泄露',
  ]) {
    assert.equal(html.includes(secret), false, secret);
  }
  const empty = page([]);
  assert.match(empty, /没有已接受的上游产物/);
  assert.equal(empty.includes('disabled'), false);
});

test('a source with no accepted version is named and submit stays available', () => {
  const read = readExecutionNode({
    ...node,
    inputs: [
      {
        access: 'pending',
        pending: 'none',
        blocking: false,
        sourceNodeId: 'draft',
        taskId: 'task-sealed-4e1',
        spaceId: 'space-sealed-4e1',
        message: 'wrong',
      },
    ],
  });
  assert.equal(read.inputs[0].message, noneMessage);
  assert.equal(read.inputs[0].sourceNodeId, 'draft');
  const html = page(read.inputs);
  assert.match(html, /上游节点 draft 尚无已接受版本/);
  assert.match(html, /draft/);
  assert.equal(html.includes('disabled'), false);
  assert.equal(html.includes('task-sealed-4e1'), false);
  assert.equal(html.includes('space-sealed-4e1'), false);
});

test('a replaced accepted version is named and submit stays available', () => {
  const read = readExecutionNode({
    ...node,
    inputs: [
      {
        access: 'pending',
        pending: 'replaced',
        blocking: false,
        sourceNodeId: 'moved',
        message: 'wrong',
        name: 'artifact-new',
      },
    ],
  });
  assert.equal(read.inputs[0].message, replacedMessage);
  assert.equal(read.inputs[0].sourceNodeId, 'moved');
  const html = page(read.inputs);
  assert.match(html, /上游节点 moved 已有新的已接受版本，当前引用的版本已被取代/);
  assert.match(html, /moved/);
  assert.equal(html.includes('disabled'), false);
  assert.equal(html.includes('artifact-new'), false);
});
