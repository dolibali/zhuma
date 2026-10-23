import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeliveryPanel } from '../dist/execution/DeliveryPanel.js';
import { InboxPanel } from '../dist/execution/InboxPanel.js';

const node = {
  nodeId: 'design',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  version: 2,
  status: 'in-review',
  goal: '设计登录接口',
  expectedOutput: '接口说明',
  assigneeId: 'chen',
  reviewerIds: ['lin'],
  currentRoundId: 'round-1',
  artifacts: [{ id: 'artifact-1', version: 1, text: '第一版接口说明' }],
  rounds: [
    {
      id: 'round-1',
      status: 'open',
      artifactVersionId: 'artifact-1',
      reviewerIds: ['lin'],
      ballots: [],
    },
  ],
  comments: [],
};
const item = {
  id: 'inbox-1',
  kind: 'deliver',
  actorId: 'chen',
  nodeId: 'design',
  taskId: 'task',
  reason: 'assignee-delivery',
  action: 'submit',
};

test('inbox and delivery render without an actor control', () => {
  const inbox = renderToStaticMarkup(
    createElement(InboxPanel, {
      items: [item],
      nodes: [{ ...node, status: 'ready' }],
      reload() {},
      open() {},
    }),
  );
  assert.match(inbox, /需要我处理/);
  assert.match(inbox, /待我交付/);
  assert.match(inbox, /提交产物/);
  assert.equal(inbox.includes('actorId'), false);
  const empty = renderToStaticMarkup(
    createElement(InboxPanel, { items: [], nodes: [], reload() {}, open() {} }),
  );
  assert.match(empty, /现在没有需要你处理的工作/);

  const api = { async submit() {}, async ballot() {}, async inbox() {} };
  const delivery = renderToStaticMarkup(
    createElement(DeliveryPanel, { api, node, onSubmitted() {} }),
  );
  assert.match(delivery, /交付说明/);
  assert.match(delivery, /文件已经上传完成/);
  assert.equal(delivery.includes('reviewerId'), false);
});
