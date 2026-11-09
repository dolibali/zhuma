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

test('my work exports through one heading menu, preserves downloads and keyboard dismissal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 860 });
  await routes(page, 'chen');
  const formats = [];
  await page.route('**/api/zhuma-efficiency/export', async (route) => {
    const body = route.request().postDataJSON();
    formats.push(body.payload);
    const { format } = body.payload;
    await json(route, 200, {
      type: 'server-response',
      rpcId: body.rpcId,
      result: {
        ok: true,
        value: {
          format,
          filename: `efficiency-metrics.${format}`,
          document: format === 'json' ? '{"recorded":true}' : 'metric,value\nrecorded,1\n',
        },
      },
    });
  });
  await page.goto('/?member-execution&strict');
  const heading = page.getByRole('heading', { name: '我的工作', exact: true });
  const trigger = page.getByRole('button', { name: '导出', exact: true });
  await expect(heading).toBeVisible();
  const [titleBox, buttonBox] = await Promise.all([heading.boundingBox(), trigger.boundingBox()]);
  expect(buttonBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
  expect(
    Math.abs(buttonBox.y + buttonBox.height / 2 - (titleBox.y + titleBox.height / 2)),
  ).toBeLessThan(2);
  expect(formats).toEqual([]);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: '导出 JSON', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '导出 CSV', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(formats).toEqual([]);
  await trigger.click();
  await heading.click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  for (const format of ['json', 'csv']) {
    await trigger.click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: `导出 ${format.toUpperCase()}`, exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`efficiency-metrics.${format}`);
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(
      format === 'json' ? '{"recorded":true}' : 'metric,value\nrecorded,1\n',
    );
    await expect(page.getByRole('status')).toContainText(`已导出 ${format.toUpperCase()}`);
  }
  expect(formats).toEqual([{ format: 'json' }, { format: 'csv' }]);
});

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
  await expect(page.getByRole('button', { name: '打开提交', exact: true })).toBeVisible();
  expect(
    state.calls.every((call) => ['zhuma-exec/inbox', 'zhuma-exec/startable'].includes(call.method)),
  ).toBe(true);
  expect(state.legacy).toHaveLength(0);
});

test('execution HTTP401 unmounts old input; another member never sees the previous draft', async ({
  page,
}) => {
  const state = await routes(page, 'chen');
  await page.goto('/?member-execution&strict');
  await page.getByRole('button', { name: '打开提交', exact: true }).click();
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
