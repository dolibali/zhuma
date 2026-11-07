import { test, expect } from '@playwright/test';
import { deliveryNode, inbox } from './execution-fixture.mjs';
const member = (accountId) => ({
  ok: true,
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: `fixture-${accountId}`,
  spaces: [{ id: `personal-${accountId}`, kind: 'personal', name: '我的空间' }],
});
const json = (route, status, body) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const draftQuery = {
  taskId: deliveryNode.taskId,
  planId: deliveryNode.planId,
  revision: deliveryNode.revision,
  nodeId: deliveryNode.nodeId,
};

async function routes(page, initialAccount) {
  const state = { account: initialAccount, expired: false, calls: [], legacy: [] };
  await page.route('**/api/zhuma/**', async (route) => {
    state.legacy.push(route.request().url());
    await json(route, 404, {});
  });
  await page.route('**/zhuma-id/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session'))
      return json(
        route,
        state.account ? 200 : 401,
        state.account ? member(state.account) : { ok: false },
      );
    if (path.endsWith('/login')) {
      state.account = route.request().postDataJSON().accountId;
      state.expired = false;
      return json(route, 200, { ok: true, accountId: state.account });
    }
    if (path.endsWith('/logout')) {
      const accountId = state.account;
      state.account = undefined;
      return json(route, 200, { ok: true, accountId });
    }
    throw Error('Unexpected identity request');
  });
  await page.route('**/api/zhuma-exec/**', async (route) => {
    const body = route.request().postDataJSON();
    state.calls.push(body);
    if (state.expired) {
      state.account = undefined;
      return json(route, 401, { ok: false, error: { code: 'unauthenticated' } });
    }
    if (body.method === 'zhuma-exec/draft') {
      expect(body.payload).toEqual(draftQuery);
      return json(route, 200, {
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { version: 0, text: '', links: [], files: [] } },
      });
    }
    if (body.method === 'zhuma-exec/startable')
      return json(route, 200, {
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: { actorId: state.account, spaceId: body.payload.spaceId, plans: [] },
        },
      });
    expect(body.method).toBe('zhuma-exec/inbox');
    const value =
      state.account === 'chen'
        ? inbox([deliveryNode])
        : { actorId: state.account, nodes: [], items: [] };
    return json(route, 200, {
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { ...value, spaceId: body.payload.spaceId } },
    });
  });
  return state;
}

test('formal member entry remains behind login and never falls back to owner routes', async ({
  page,
}) => {
  const state = await routes(page);
  await page.goto('/?member-execution&strict');
  await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toBeVisible();
  expect(state.calls).toHaveLength(0);
  expect(state.legacy).toHaveLength(0);
  await page.getByLabel('账号', { exact: true }).fill('chen');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '提交产物', exact: true })).toBeVisible();
  expect(
    state.calls.every((call) => ['zhuma-exec/inbox', 'zhuma-exec/startable'].includes(call.method)),
  ).toBe(true);
  expect(state.legacy).toHaveLength(0);
});

test('efficiency export sits at the bottom of my work and still downloads', async ({ page }) => {
  const seen = [];
  await routes(page, 'chen');
  await page.route('**/api/zhuma-efficiency/export', async (route) => {
    const body = route.request().postDataJSON();
    seen.push(body);
    const format = body.payload.format;
    return json(route, 200, {
      type: 'server-response',
      rpcId: body.rpcId,
      result: {
        ok: true,
        value: {
          format,
          filename: format === 'json' ? 'efficiency-metrics.json' : 'efficiency-metrics.csv',
          document: format === 'json' ? '{"metrics":[]}\n' : 'taskId\n',
          metricCount: 0,
        },
      },
    });
  });
  await page.goto('/?member-execution&strict');
  const heading = page.getByRole('heading', { name: '我的工作', exact: true });
  const workspace = page.locator('.zm-member-work > main.zm-page > .zm-execution-workspace');
  const jsonButton = page.getByRole('button', { name: '导出效率 JSON', exact: true });
  const csvButton = page.getByRole('button', { name: '导出效率 CSV', exact: true });
  await expect(heading).toBeVisible();
  await expect(jsonButton).toBeVisible();
  await expect(csvButton).toBeVisible();
  const headingBox = await heading.boundingBox();
  const workspaceBox = await workspace.boundingBox();
  const jsonBox = await jsonButton.boundingBox();
  const csvBox = await csvButton.boundingBox();
  expect(jsonBox.y).toBeGreaterThan(headingBox.y + headingBox.height);
  expect(jsonBox.y).toBeGreaterThanOrEqual(workspaceBox.y + workspaceBox.height - 1);
  expect(csvBox.y).toBeGreaterThanOrEqual(workspaceBox.y + workspaceBox.height - 1);
  const [download] = await Promise.all([page.waitForEvent('download'), jsonButton.click()]);
  expect(download.suggestedFilename()).toBe('efficiency-metrics.json');
  await expect(page.locator('.zm-efficiency-export').getByRole('status')).toHaveText(
    '已导出 JSON。',
  );
  const [csvDownload] = await Promise.all([page.waitForEvent('download'), csvButton.click()]);
  expect(csvDownload.suggestedFilename()).toBe('efficiency-metrics.csv');
  await expect(page.locator('.zm-efficiency-export').getByRole('status')).toHaveText(
    '已导出 CSV。',
  );
  expect(seen.map((body) => body.payload.format)).toEqual(['json', 'csv']);
});

test('execution HTTP401 unmounts old input; another member never sees the previous draft', async ({
  page,
}) => {
  const state = await routes(page, 'chen');
  await page.goto('/?member-execution&strict');
  await page.getByRole('button', { name: '提交产物', exact: true }).click();
  await expect(page.locator('.zm-draft-status')).toHaveText('尚未保存草稿');
  await page.getByLabel('补充说明（选填）', { exact: true }).fill('previous-member-private-draft');
  state.expired = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toBeVisible();
  await expect(page.getByLabel('补充说明（选填）', { exact: true })).toHaveCount(0);
  await page.getByLabel('账号', { exact: true }).fill('lin');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('现在没有需要你处理的工作。', { exact: true })).toBeVisible();
  await expect(page.getByText('previous-member-private-draft')).toHaveCount(0);
  expect(state.legacy).toHaveLength(0);
  expect(
    state.calls.every(
      (call) =>
        ['zhuma-exec/inbox', 'zhuma-exec/startable'].includes(call.method) ||
        (call.method === 'zhuma-exec/draft' &&
          Object.keys(call.payload).length === 4 &&
          Object.entries(draftQuery).every(([key, value]) => call.payload[key] === value)),
    ),
  ).toBe(true);
});
