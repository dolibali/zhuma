import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExecutionApi, readExecutionNode } from '../dist/execution/ExecutionApi.js';
import { DeliveryPanel } from '../dist/execution/DeliveryPanel.js';
import { UpstreamInputsPanel } from '../dist/execution/UpstreamInputsPanel.js';
import { deliveryNode } from './browser/execution-fixture.mjs';
import { upstreamInputs } from './upstream-input-fixture.mjs';

const render = (inputs, mode = 'submit') =>
  renderToStaticMarkup(
    createElement(DeliveryPanel, {
      api: {},
      node: readExecutionNode({
        ...deliveryNode,
        ...(mode === 'revise' ? { status: 'needs-revision' } : {}),
        inputs,
      }),
      mode,
      onSubmitted() {},
    }),
  );

test('upstream DTO: copy only the public projection; hidden source identifiers and all content are omitted', () => {
  const inputs = upstreamInputs();
  inputs[0].text = 'not-public-body';
  inputs[0].files = [{ id: 'not-public-file' }];
  // visible 行的 artifactVersionId 是公共投影（供内容读取），透传注入值
  inputs[0].artifactVersionId = 'artifact:injected-visible-pin';
  inputs[3].sourceNodeId = 'not-public-node';
  inputs[3].sourceGoal = 'not-public-goal';
  inputs[3].taskId = 'not-public-task';
  inputs[3].spaceId = 'not-public-space';
  inputs[3].version = 99;
  inputs[3].name = 'not-public-name';
  const parsed = readExecutionNode({ ...deliveryNode, inputs });
  const expected = upstreamInputs();
  expected[0].artifactVersionId = 'artifact:injected-visible-pin';
  assert.deepEqual(parsed.inputs, expected);
  assert.ok(!JSON.stringify(parsed).includes('not-public-'));
  assert.ok(
    !renderToStaticMarkup(createElement(UpstreamInputsPanel, { inputs: parsed.inputs })).includes(
      'not-public-',
    ),
  );
  inputs[0].sourceGoal = 'mutated';
  assert.equal(parsed.inputs[0].sourceGoal, '确认订单接口与错误码');
});

test('upstream DTO: preserve missing, explicitly empty and all supported service flags without deriving access rules', () => {
  assert.equal('inputs' in readExecutionNode(deliveryNode), false);
  assert.deepEqual(readExecutionNode({ ...deliveryNode, inputs: [] }).inputs, []);
  const inputs = upstreamInputs();
  inputs[0].blocking = true;
  inputs[1].blocking = true;
  inputs[3].blocking = false;
  assert.deepEqual(readExecutionNode({ ...deliveryNode, inputs }).inputs, inputs);
});

for (const [label, change] of [
  ['null collection', () => null],
  ['object collection', () => ({})],
  [
    'missing visible pin',
    (rows) => {
      delete rows[0].artifactVersionId;
      return rows;
    },
  ],
  [
    'empty visible pin',
    (rows) => {
      rows[0].artifactVersionId = ' ';
      return rows;
    },
  ],
  [
    'nonstring visible pin',
    (rows) => {
      rows[0].artifactVersionId = 2;
      return rows;
    },
  ],
  [
    'null row',
    (rows) => {
      rows[0] = null;
      return rows;
    },
  ],
  [
    'array row',
    (rows) => {
      rows[0] = [];
      return rows;
    },
  ],
  [
    'unknown access',
    (rows) => {
      rows[0].access = 'unknown';
      return rows;
    },
  ],
  [
    'missing blocking',
    (rows) => {
      delete rows[0].blocking;
      return rows;
    },
  ],
  [
    'nonboolean blocking',
    (rows) => {
      rows[1].blocking = 'false';
      return rows;
    },
  ],
  [
    'empty source',
    (rows) => {
      rows[0].sourceNodeId = '';
      return rows;
    },
  ],
  [
    'invalid goal',
    (rows) => {
      rows[0].sourceGoal = {};
      return rows;
    },
  ],
  [
    'zero version',
    (rows) => {
      rows[0].version = 0;
      return rows;
    },
  ],
  [
    'fractional version',
    (rows) => {
      rows[0].version = 1.5;
      return rows;
    },
  ],
  [
    'missing name',
    (rows) => {
      delete rows[0].name;
      return rows;
    },
  ],
  [
    'unknown pending',
    (rows) => {
      rows[1].pending = 'ready';
      return rows;
    },
  ],
  [
    'missing pending source',
    (rows) => {
      delete rows[1].sourceNodeId;
      return rows;
    },
  ],
  [
    'missing pending hint',
    (rows) => {
      delete rows[1].message;
      return rows;
    },
  ],
  [
    'zero hidden count',
    (rows) => {
      rows[3].count = 0;
      return rows;
    },
  ],
  [
    'fractional hidden count',
    (rows) => {
      rows[3].count = 1.5;
      return rows;
    },
  ],
  [
    'missing hidden hint',
    (rows) => {
      delete rows[3].message;
      return rows;
    },
  ],
]) {
  test(`upstream DTO: reject ${label} rather than return an empty or accessible projection`, () => {
    assert.throws(
      () => readExecutionNode({ ...deliveryNode, inputs: change(upstreamInputs()) }),
      (error) => error.code === 'validation',
    );
  });
}

test('upstream RPC: inbox consumes the real inputs field; write replies may omit it without inventing emptiness', async () => {
  const calls = [];
  const api = createExecutionApi({
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload });
      return {
        ok: true,
        value: endpoint.endsWith('/inbox')
          ? { actorId: 'chen', items: [], nodes: [{ ...deliveryNode, inputs: upstreamInputs() }] }
          : { node: deliveryNode },
      };
    },
  });
  assert.deepEqual((await api.inbox()).nodes[0].inputs, upstreamInputs());
  const result = await api.submit({
    taskId: deliveryNode.taskId,
    planId: deliveryNode.planId,
    revision: deliveryNode.revision,
    nodeId: deliveryNode.nodeId,
    expectedVersion: deliveryNode.version,
    idempotencyKey: 'upstream-submit',
    text: '产物',
  });
  assert.equal('inputs' in result, false);
  assert.deepEqual(calls[0].payload, {});
  assert.ok(!('inputs' in calls[1].payload));
});

test('upstream SSR: show accepted source and service hints without pretending to provide previews or navigation', () => {
  const html = render(upstreamInputs());
  for (const value of [
    '确认订单接口与错误码',
    'api-contract',
    '第 2 版',
    'help-copy 尚无已接受版本',
    '引用的版本已被取代',
    '2 个受限来源',
    '阻塞提交',
  ])
    assert.ok(html.includes(value), value);
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('download='));
  assert.ok(!html.includes('href='));
});

test('upstream SSR: missing and explicitly empty use distinct statements', () => {
  const unknown = render(undefined),
    empty = render([]);
  assert.ok(unknown.includes('上游输入尚未返回'));
  assert.ok(!unknown.includes('没有上游输入。'));
  assert.ok(empty.includes('没有上游输入。'));
  assert.ok(!empty.includes('上游输入尚未返回'));
});

test('upstream SSR: both delivery modes keep the initial unread draft closed regardless of source category', () => {
  for (const mode of ['submit', 'revise']) {
    for (const access of ['visible', 'pending', 'hidden']) {
      const input = upstreamInputs().find((row) => row.access === access);
      for (const blocking of [true, false]) {
        const html = render([{ ...input, blocking }], mode);
        assert.ok(html.includes('草稿尚未读取。'));
        assert.equal(/<button[^>]*disabled/.test(html), true, `${mode}/${access}/${blocking}`);
      }
    }
    assert.equal(/<button[^>]*disabled/.test(render(undefined, mode)), true);
  }
});

test('upstream SSR: parallel panels have unique IDs and escape server display text', () => {
  const rows = upstreamInputs();
  rows[0].sourceGoal = '<script>text</script>';
  const html = renderToStaticMarkup(
    createElement(
      'div',
      {},
      createElement(UpstreamInputsPanel, { inputs: rows }),
      createElement(UpstreamInputsPanel, { inputs: rows }),
    ),
  );
  assert.ok(html.includes('&lt;script&gt;text&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});
