import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeliveryPanel } from '../dist/execution/DeliveryPanel.js';
import { ExecutionWorkspace } from '../dist/execution/ExecutionWorkspace.js';
import { InboxPanel } from '../dist/execution/InboxPanel.js';
import { ReviewWorkspace } from '../dist/execution/ReviewWorkspace.js';

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

test('panels render delivery and review without an actor control', () => {
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
  const grouped = renderToStaticMarkup(
    createElement(InboxPanel, {
      items: [
        item,
        { ...item, id: 'review-1', kind: 'review', action: 'review', reason: 'review-assigned' },
        {
          ...item,
          id: 'owner-1',
          kind: 'deliver',
          action: 'provide-input',
          reason: 'owner-input-required',
          nodeId: 'expert-node',
        },
        {
          ...item,
          id: 'confirm-1',
          kind: 'confirm',
          action: 'confirm',
          reason: 'parent-confirmation',
        },
      ],
      nodes: [
        { ...node, status: 'ready' },
        { ...node, nodeId: 'expert-node', status: 'waiting-for-input', goal: '专家节点' },
      ],
      places: [
        { itemId: 'inbox-1', taskPath: '客户门户 / 账号登录', ownerName: '陈宁' },
        { itemId: 'owner-1', taskPath: '客户门户 / 账号登录 / 设计登录', ownerName: '陈宁' },
      ],
      reload() {},
      open() {},
    }),
  );
  const deliverAt = grouped.indexOf('data-inbox-group="deliver"');
  const reviewAt = grouped.indexOf('data-inbox-group="review"');
  const confirmAt = grouped.indexOf('data-inbox-group="confirm"');
  assert.deepEqual(
    [deliverAt >= 0, reviewAt > deliverAt, confirmAt > reviewAt],
    [true, true, true],
  );
  assert.match(grouped, /客户门户 \/ 账号登录/);
  assert.match(grouped, /负责人 陈宁/);
  assert.equal(grouped.slice(deliverAt, reviewAt).includes('专家节点'), true);
  assert.equal(grouped.slice(reviewAt, confirmAt).includes('专家节点'), false);

  const api = { async submit() {}, async ballot() {}, async inbox() {} };
  const delivery = renderToStaticMarkup(
    createElement(DeliveryPanel, { api, node, onSubmitted() {} }),
  );
  assert.match(delivery, /交付说明/);
  assert.match(delivery, /待解析/);
  assert.equal(delivery.includes('文件已经上传完成'), false);
  assert.equal(delivery.includes('reviewerId'), false);
  const review = renderToStaticMarkup(
    createElement(ReviewWorkspace, { api, node, onSubmitted() {} }),
  );
  assert.match(review, /第一版接口说明/);
  assert.match(review, /仅评论/);
  assert.match(review, /通过/);
  assert.match(review, /退回修改/);
  assert.equal(review.includes('type="hidden"'), false);

  const workspace = renderToStaticMarkup(
    createElement(ExecutionWorkspace, {
      api: { async submit() {}, async ballot() {}, async inbox() {} },
    }),
  );
  assert.equal(workspace.includes('<main'), false);
  assert.equal(workspace.includes('class="zhuma"'), false);
  assert.match(workspace, /需要我处理/);
});
