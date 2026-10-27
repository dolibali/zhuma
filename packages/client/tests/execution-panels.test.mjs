import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartablePlansPanel } from '../dist/execution/StartablePlansPanel.js';
import { StartPlanPanel } from '../dist/execution/StartPlanPanel.js';
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

  const api = { async submit() {}, async ballot() {}, async inbox() {} };
  const delivery = renderToStaticMarkup(
    createElement(DeliveryPanel, { api, node, onSubmitted() {} }),
  );
  assert.match(delivery, /产物正文/);
  assert.equal(delivery.includes('文件信息'), false);
  assert.match(delivery, /参考链接/);
  assert.equal(delivery.includes('reviewerId'), false);
  const review = renderToStaticMarkup(
    createElement(ReviewWorkspace, { api, node, onSubmitted() {} }),
  );
  assert.match(review, /第一版接口说明/);
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

for (const mode of ['submit', 'revise', 'review'])
  test(`execution goal headings: ${mode} keeps complete work outside the short heading`, () => {
    let writes = 0;
    const api = {
      async submit() {
        writes++;
      },
      async ballot() {
        writes++;
      },
    };
    for (const [goal, title] of [
      [
        '确认订单接口\n\n完整工作：' + '保留业务要求。'.repeat(100) + '<规则> & 末尾要求',
        '确认订单接口',
      ],
      ['确认订单接口\r\n\r\n保留 CRLF 和末尾空格  ', '确认订单接口'],
      ['长'.repeat(200) + '末尾要求', '长'.repeat(160)],
      ['\n\n没有首行标题的完整说明', '工作项'],
      ['', '工作项'],
      ['确认订单接口', '确认订单接口'],
    ]) {
      const current = Object.freeze({
        ...node,
        goal,
        status: mode === 'review' ? 'in-review' : mode === 'revise' ? 'needs-revision' : 'ready',
      });
      const markup = renderToStaticMarkup(
        mode === 'review'
          ? createElement(ReviewWorkspace, { api, node: current, onSubmitted() {} })
          : createElement(DeliveryPanel, { api, node: current, mode, onSubmitted() {} }),
      );
      assert.equal(markup.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)?.[1], title);
      const body = markup.match(/<p class="zm-execution-text">([\s\S]*?)<\/p>/)?.[1];
      if (goal !== title) {
        const escaped = renderToStaticMarkup(createElement('span', null, goal)).slice(6, -7);
        assert.equal(
          body,
          escaped,
          'The complete original goal stays in ordinary text, without truncation',
        );
      } else assert.equal(body, undefined, 'A one-line title is not repeated as a description');
      assert.equal(current.goal, goal);
      if (mode === 'review') {
        assert.match(markup, /第一版接口说明/);
        assert.match(markup, /第 1 版/);
        assert.match(markup, /通过/);
        assert.match(markup, /退回修改/);
      } else {
        assert.match(markup, /交付内容：接口说明/);
        assert.match(markup, /产物正文/);
        assert.match(markup, /保存草稿/);
        assert.match(markup, mode === 'revise' ? /重新提交/ : /提交产物/);
      }
    }
    assert.equal(writes, 0, 'Rendering instructions must not execute a delivery or review');
  });

test('read-only rendering never starts a plan and missing round artifact cannot be approved', () => {
  let writes = 0;
  const api = {
    async startPlan() {
      writes++;
    },
    async inbox() {},
    async submit() {
      writes++;
    },
    async ballot() {
      writes++;
    },
  };
  const plan = { taskId: 'task', planId: 'plan', revision: 1, title: '接口改造' };
  const markup = renderToStaticMarkup(createElement(StartPlanPanel, { api, plan, onStarted() {} }));
  assert.match(markup, /开始执行/);
  renderToStaticMarkup(createElement(ExecutionWorkspace, { api, plan }));
  assert.equal(writes, 0);
  const review = renderToStaticMarkup(
    createElement(ReviewWorkspace, {
      api,
      node: { ...node, rounds: [{ ...node.rounds[0], artifactVersionId: 'missing' }] },
      onSubmitted() {},
    }),
  );
  assert.match(review, /当前评审轮次或对应产物不可用/);
  assert.equal(review.includes('第一版接口说明'), false);
  assert.match(review, /disabled=""/);
});

test('catalog server rendering cannot read or execute before the member client mounts', () => {
  let calls = 0;
  const api = {
    startable: async () => {
      calls++;
    },
    startPlan: async () => {
      calls++;
    },
  };
  const markup = renderToStaticMarkup(createElement(StartablePlansPanel, { api, onStarted() {} }));
  assert.match(markup, /待开始/);
  assert.match(markup, /正在读取计划/);
  assert.equal(calls, 0);
  assert.equal(markup.includes('开始执行'), false);
});
