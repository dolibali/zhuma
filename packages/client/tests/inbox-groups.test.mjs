import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxPanel } from '../dist/execution/InboxPanel.js';
import { inboxItemGroup, INBOX_GROUPS } from '../dist/execution-view.js';
import { createExecutionApi, readInboxPlaces } from '../dist/execution/ExecutionApi.js';
import { groupedInbox } from './inbox-groups-fixture.mjs';

const render = (props = {}) =>
  renderToStaticMarkup(
    createElement(InboxPanel, {
      ...groupedInbox(),
      reload() {},
      open() {},
      ...props,
    }),
  );
for (const [index, group] of [
  'deliver',
  'revise',
  'review',
  'attention',
  'attention',
  'active',
].entries())
  test(`inbox groups: service item ${index} belongs to ${group} without deriving items from node status`, () => {
    assert.equal(inboxItemGroup(groupedInbox().items[index]), group);
  });

test('inbox groups: unknown kind/action/reason combinations stay visible without an actionable command', () => {
  const data = groupedInbox();
  const item = { ...data.items[0], reason: 'unknown-future-reason' };
  assert.equal(inboxItemGroup(item), 'other');
  const html = render({ items: [item] });
  assert.ok(html.includes('其他工作项'));
  assert.ok(html.includes('处理入口尚未接入'));
  assert.equal((html.match(/<button/g) ?? []).length, 1); // refresh only
});

test('inbox SSR: service work groups and work-item counts remain distinct from tasks', () => {
  const html = render();
  for (const group of INBOX_GROUPS.filter((group) => group.id !== 'other'))
    assert.ok(html.includes(group.label));
  assert.ok(html.includes('已载入 6 个工作项'));
  assert.ok(!html.includes('6 个任务'));
  assert.equal((html.match(/<article/g) ?? []).length, 6);
  assert.ok(!html.includes('只有节点状态的等待事项'));
  assert.equal((html.match(/<button/g) ?? []).length, 5); // refresh, three manual actions, unavailable Agent entry
  assert.ok(html.includes('请核对发票范围后确认交付。'));
});

test('inbox SSR: only the exact current service continuation item can render an Agent entry', () => {
  const data = groupedInbox(),
    item = data.items[5],
    node = data.nodes[5];
  let rendered = 0;
  const renderAgentAction = (current) => {
    rendered++;
    assert.equal(current, node);
    return createElement('button', {}, 'Open existing conversation');
  };
  assert.ok(
    render({ items: [item], nodes: [node], renderAgentAction }).includes(
      'Open existing conversation',
    ),
  );
  assert.equal(rendered, 1);
  for (const changed of [
    { items: [{ ...item, reason: 'unknown-future-reason' }], nodes: [node] },
    { items: [item], nodes: [{ ...node, status: 'completed' }] },
    { items: [item, item], nodes: [node] },
    { items: [item], nodes: [node, { ...node, revision: node.revision + 1 }] },
    { items: [], nodes: [node] },
  ])
    assert.ok(!render({ ...changed, renderAgentAction }).includes('Open existing conversation'));
  assert.equal(rendered, 1, 'status, duplicates and unknown reasons never invent an Agent action');
});

test('inbox SSR: only service-provided path and task owner names render, with no fabricated navigation', () => {
  const data = groupedInbox();
  const html = render({ places: readInboxPlaces(data.places) });
  assert.ok(html.includes('订单项目 / 结算能力升级 / 客户服务 / 交付说明'));
  assert.ok(html.includes('任务负责人：林夏'));
  assert.ok(!html.includes('href='));
  const missing = render({ places: undefined });
  assert.ok(missing.includes('来源路径未提供'));
  assert.ok(missing.includes('任务负责人：未提供'));
  assert.ok(!missing.includes('任务负责人：chen'));
  assert.ok(!missing.includes('任务负责人：mei'));
});

test('places projection: missing fields remain unknown, extra identities never become fallback locations', () => {
  const parsed = readInboxPlaces([
    {
      itemId: 'item-0',
      taskPath: '  服务给出的路径  ',
      ownerName: null,
      projectId: 'private-project',
      actorId: 'private-member',
      notes: 'private-path',
    },
    { itemId: 'item-1' },
  ]);
  assert.deepEqual(parsed, [
    { itemId: 'item-0', taskPath: '服务给出的路径', ownerName: '' },
    { itemId: 'item-1', taskPath: '', ownerName: '' },
  ]);
  const html = render({ places: parsed });
  assert.ok(html.includes('服务给出的路径'));
  assert.ok(!html.includes('private-'));
  assert.equal(readInboxPlaces(undefined), undefined);
});

for (const value of [null, {}, [null], [{ taskPath: 'no item identifier' }], [{ itemId: '' }]])
  test(`places projection rejects unattachable shape ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => readInboxPlaces(value),
      (error) => error.code === 'validation',
    );
  });

test('places projection: duplicate mappings or duplicate work-item IDs are unknown instead of selecting the first', () => {
  const data = groupedInbox();
  const places = [
    { itemId: 'item-0', taskPath: 'ambiguous-path', ownerName: 'ambiguous-owner' },
    { itemId: 'item-0', taskPath: 'other-path', ownerName: 'other-owner' },
  ];
  const html = render({ items: [data.items[0]], places });
  assert.ok(html.includes('来源路径未提供'));
  assert.ok(!html.includes('ambiguous-'));
  const duplicate = render({ items: [data.items[0], data.items[0]], places: [places[0]] });
  assert.ok(!duplicate.includes('ambiguous-'));
  assert.ok(duplicate.includes('工作版本尚未确定'));
  assert.equal((duplicate.match(/disabled/g) ?? []).length, 2);
});

test('inbox SSR: different tasks with the same node ID match by task, while multiple plans/revisions fail closed', () => {
  const data = groupedInbox(),
    item = data.items[0],
    node = data.nodes[0];
  const other = { ...node, taskId: 'other-task', goal: '其他任务同名节点' };
  const matched = render({ items: [item], nodes: [other, node] });
  assert.ok(matched.includes(node.goal));
  assert.ok(!matched.includes(other.goal));
  assert.ok(!matched.includes('disabled'));
  for (const changed of [{ revision: node.revision + 1 }, { planId: 'other-plan' }]) {
    const ambiguous = render({ items: [item], nodes: [node, { ...node, ...changed }] });
    assert.ok(ambiguous.includes('工作版本尚未确定'));
    assert.ok(ambiguous.includes('disabled'));
    assert.ok(ambiguous.includes('来源路径未提供'));
  }
});

test('inbox SSR: a changed status or a closed/missing current review round cannot open a fake handling flow', () => {
  const data = groupedInbox();
  const deliver = render({
    items: [data.items[0]],
    nodes: [{ ...data.nodes[0], status: 'running' }],
  });
  assert.ok(deliver.includes('disabled'));
  for (const change of [
    { currentRoundId: 'absent' },
    { rounds: data.nodes[2].rounds.map((r) => ({ ...r, status: 'approved' })) },
  ]) {
    const review = render({ items: [data.items[2]], nodes: [{ ...data.nodes[2], ...change }] });
    assert.ok(review.includes('disabled'));
    assert.ok(review.includes('当前轮次已变化'));
  }
});

test('inbox SSR: loading/failure never claims an empty inbox; a failed refresh preserves loaded obligations', () => {
  assert.ok(
    !render({ items: [], nodes: [], pending: true }).includes('现在没有需要你处理的工作。'),
  );
  assert.ok(
    !render({ items: [], nodes: [], error: '读取失败' }).includes('现在没有需要你处理的工作。'),
  );
  assert.ok(render({ error: '读取失败' }).includes('已载入 6 个工作项'));
  assert.ok(render({ items: [], nodes: [] }).includes('现在没有需要你处理的工作。'));
});

test('inbox SSR: parallel panels use unique semantic IDs and escape authoritative display text', () => {
  const data = groupedInbox();
  data.places[0].taskPath = '<script>text</script>';
  const props = { ...data, reload() {}, open() {} };
  const html = renderToStaticMarkup(
    createElement('div', {}, createElement(InboxPanel, props), createElement(InboxPanel, props)),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(html.includes('&lt;script&gt;text&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('places approved inbox projection is consumed without adding counts or event routes', async () => {
  const calls = [];
  const api = createExecutionApi({
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload });
      return { ok: true, value: groupedInbox() };
    },
  });
  const value = await api.inbox();
  assert.deepEqual(value.places, readInboxPlaces(groupedInbox().places));
  assert.deepEqual(calls, [{ channel: '/api', endpoint: 'zhuma-exec/inbox', payload: {} }]);
  assert.equal('inboxCounts' in api, false);
  assert.equal('events' in api, false);
});

test('places inbox accepts old responses, copies public fields and preserves unknown display values', async () => {
  const source = groupedInbox();
  source.places[0].actorId = 'not-a-display-field';
  delete source.places[1].ownerName;
  const api = createExecutionApi({
    async call() {
      return { ok: true, value: source };
    },
  });
  const value = await api.inbox();
  assert.equal('actorId' in value.places[0], false);
  assert.equal(value.places[1].ownerName, '');
  source.places[0].taskPath = 'changed-after-read';
  assert.notEqual(value.places[0].taskPath, source.places[0].taskPath);
  delete source.places;
  assert.equal('places' in (await api.inbox()), false);
});
