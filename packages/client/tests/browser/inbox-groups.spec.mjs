import { test, expect } from '@playwright/test';
const row = (page, name) => page.getByRole('article', { name, exact: true });
const group = (page, name) =>
  page
    .locator('.zm-inbox-group')
    .filter({ has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) });
async function open(page, preview = false) {
  await page.goto(`/?inbox-groups&strict${preview ? '&places-preview' : ''}`);
  await expect(page.getByText('已载入 6 个工作项', { exact: true })).toBeVisible();
}

test('inbox normal entry groups loaded work items, preserves unsupported obligations and never invents rows from waiting nodes', async ({
  page,
}) => {
  await open(page);
  for (const label of ['待我交付', '退回修改', '待我评审', '补充与确认', '处理中'])
    await expect(group(page, label)).toBeVisible();
  await expect(group(page, '补充与确认').getByRole('article')).toHaveCount(2);
  await expect(group(page, '补充与确认').getByRole('button')).toHaveCount(0);
  await expect(group(page, '处理中')).toContainText('正在生成帮助文案');
  await expect(
    group(page, '处理中').getByRole('button', { name: '打开 Agent 会话', exact: true }),
  ).toBeDisabled();
  await expect(group(page, '处理中')).toContainText('Agent 会话暂不可用');
  await expect(page.getByText('只有节点状态的等待事项', { exact: true })).toHaveCount(0);
  await expect(page.getByText('请核对发票范围后确认交付。', { exact: true })).toBeVisible();
  await expect(page.locator('.zm-inbox-path')).toHaveText(
    Array(6).fill('订单项目 / 结算能力升级 / 客户服务 / 交付说明'),
  );
  await expect(row(page, '编写订单状态帮助文案')).toContainText('任务负责人：林夏');
  const endpoints = await page.evaluate(() => window.inboxGroupsProbe.calls.map((c) => c.endpoint));
  expect(endpoints.every((endpoint) => endpoint.endsWith('/inbox'))).toBe(true);
  // A future reason stays in the readonly fallback instead of acquiring Agent actions.
  await page.evaluate(() => {
    window.inboxGroupsProbe.data.items.at(-1).reason = 'future-agent-handling';
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(group(page, '其他工作项')).toContainText('正在生成帮助文案');
  await expect(group(page, '其他工作项').getByRole('button')).toHaveCount(0);
  await expect(group(page, '处理中')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.inboxGroupsProbe.calls.every((c) => c.endpoint.endsWith('/inbox')),
    ),
  ).toBe(true);
});

for (const [title, action, detail] of [
  ['编写订单状态帮助文案', '提交产物', '产物正文'],
  ['补齐订单查询的接口约定', '提交新版本', '产物正文'],
  ['确认订单状态接口', '提交评审', '评审意见'],
])
  test(`inbox grouped item opens the existing precise ${action} workspace`, async ({ page }) => {
    await open(page);
    await row(page, title).getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByLabel(detail, { exact: true })).toBeVisible();
    if (detail === '产物正文')
      await expect(page.locator('.zm-draft-status')).toHaveText('尚未保存草稿');
    else
      await expect(
        page.getByText('订单状态支持待支付、已支付、已取消。\n取消原因单独返回。', { exact: true }),
      ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.inboxGroupsProbe.calls.some((c) => /submit|ballot|start-plan/.test(c.endpoint)),
      ),
    ).toBe(false);
  });

test('inbox refreshing a grouped list preserves a dirty delivery and a failed refresh never clears its obligations', async ({
  page,
}) => {
  await open(page);
  await row(page, '编写订单状态帮助文案').getByRole('button').click();
  await expect(page.locator('.zm-draft-status')).toHaveText('尚未保存草稿');
  const input = page.getByLabel('产物正文', { exact: true });
  await input.fill('刷新后也保留的内容');
  await page.evaluate(() => {
    const c = window.inboxGroupsProbe;
    c.data.places = c.data.places.map((p) => ({
      ...p,
      taskPath: '服务返回的新来源',
      ownerName: '当前任务负责人',
    }));
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(row(page, '编写订单状态帮助文案')).toContainText('服务返回的新来源');
  await expect(row(page, '编写订单状态帮助文案')).toContainText('任务负责人：当前任务负责人');
  await expect(input).toHaveValue('刷新后也保留的内容');
  await page.evaluate(() => {
    delete window.inboxGroupsProbe.data.places;
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('.zm-inbox-path')).toHaveText(Array(6).fill('来源路径未提供'));
  await expect(input).toHaveValue('刷新后也保留的内容');
  await page.evaluate(() => {
    window.inboxGroupsProbe.failInbox = true;
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('待办暂时无法读取。');
  await expect(page.getByText('已载入 6 个工作项', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('刷新后也保留的内容');
  await expect(page.getByText('现在没有需要你处理的工作。', { exact: true })).toHaveCount(0);
});

test('places independent preview displays only supplied task path/owner, without inferred links or alternate-owner lookup', async ({
  page,
}) => {
  await open(page, true);
  const work = row(page, '编写订单状态帮助文案');
  await expect(work).toContainText('订单项目 / 结算能力升级 / 客户服务 / 交付说明');
  await expect(work).toContainText('任务负责人：林夏');
  await expect(work.locator('a')).toHaveCount(0);
  await page.evaluate(() => {
    const c = window.inboxGroupsProbe;
    c.update({ ...c.data, places: [{ itemId: 'item-0', ownerName: '服务给定负责人' }] });
  });
  await expect(work).toContainText('来源路径未提供');
  await expect(work).toContainText('服务给定负责人');
  await expect(row(page, '确认订单状态接口')).toContainText('任务负责人：未提供');
});

test('places from a late inbox response cannot enter a replacement API generation', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const c = window.inboxGroupsProbe;
    c.holdInbox = true;
    c.data.places = c.data.places.map((p) => ({
      ...p,
      taskPath: '旧请求来源',
      ownerName: '旧请求负责人',
    }));
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(
    page
      .locator('button')
      .filter({ has: page.locator('.zm-button-label').filter({ hasText: /^刷新$/ }) }),
  ).toBeDisabled();
  await page.evaluate(() => {
    const c = window.inboxGroupsProbe;
    window.oldInboxGroups = c;
    c.heldIndex = c.calls.length - 1;
    c.replaceSession();
  });
  await expect(row(page, '新会话待交付工作')).toBeVisible();
  await page.evaluate(() => window.oldInboxGroups.complete(window.oldInboxGroups.heldIndex));
  await expect(page.locator('.zm-inbox-path')).toHaveText(
    Array(6).fill('订单项目 / 结算能力升级 / 客户服务 / 交付说明'),
  );
  await expect(page.getByText('旧请求来源', { exact: true })).toHaveCount(0);
  await expect(page.getByText('任务负责人：旧请求负责人', { exact: true })).toHaveCount(0);
});

test('places duplicate mappings or multiple node revisions keep source unknown and prevent ambiguous operations', async ({
  page,
}) => {
  await open(page, true);
  await page.evaluate(() => {
    const c = window.inboxGroupsProbe;
    c.update({
      ...c.data,
      places: [c.data.places[0], { ...c.data.places[0], taskPath: '冲突来源' }],
      nodes: [...c.data.nodes, { ...c.data.nodes[0], revision: c.data.nodes[0].revision + 1 }],
    });
  });
  await expect(page.getByText('冲突来源', { exact: true })).toHaveCount(0);
  const work = page.getByRole('article').first();
  await expect(work).toContainText('工作版本尚未确定');
  await expect(work).toContainText('来源路径未提供');
  await expect(work.getByRole('button', { name: '提交产物', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.inboxGroupsProbe.opened.length)).toBe(0);
});

test('places narrow layout wraps long source paths and the normal row action stays keyboard reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await open(page, true);
  await page.evaluate(() => {
    const c = window.inboxGroupsProbe;
    c.update({
      ...c.data,
      places: c.data.places.map((place) => ({ ...place, taskPath: 'LongParentPath'.repeat(30) })),
    });
  });
  await expect(page.locator('.zm-inbox-path').first()).toContainText('LongParentPath');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const action = row(page, '编写订单状态帮助文案').getByRole('button', {
    name: '提交产物',
    exact: true,
  });
  await action.focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.inboxGroupsProbe.opened.length)).toBe(1);
  await expect(page.getByText('已载入 6 个工作项', { exact: true })).toBeVisible();
});
