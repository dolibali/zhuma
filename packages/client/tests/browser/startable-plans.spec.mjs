import { test, expect } from '@playwright/test';
const button = (page, name) =>
  page
    .locator('button')
    .filter({ has: page.locator('.zm-button-label').filter({ hasText: new RegExp(`^${name}$`) }) })
    .or(page.getByRole('button', { name, exact: true }));
const picker = (page) => page.getByLabel('已确认计划', { exact: true });
const base = '订单筛选方案 · 第 1 版';
const alternatives = {
  task: '支付状态方案 · 第 1 版',
  plan: '订单导出方案 · 第 1 版',
  revision: '订单筛选方案 · 第 2 版',
};
async function setup(page, formal = false) {
  await page.goto(`/?startable-plans&strict${formal ? '&formal' : ''}`);
  await expect(picker(page)).toBeEnabled();
}
async function choose(page, name) {
  await picker(page).click();
  await page.getByRole('option', { name, exact: true }).click();
}
const calls = (page, method) =>
  page.evaluate(
    (method) =>
      window.startableProbe.calls
        .filter((call) => call.endpoint.endsWith(`/${method}`))
        .map((call) => call.payload),
    method,
  );
async function finish(page, method, offset = -1, outcome = 'success', old = false) {
  await page.evaluate(
    ({ method, offset, outcome, old }) => {
      const control = old ? window.oldStartableProbe : window.startableProbe;
      const entries = control.calls.filter(
        (call) => call.endpoint.endsWith(`/${method}`) && !call.settled,
      );
      const call = entries.at(offset);
      control.complete(control.calls.indexOf(call), outcome);
    },
    { method, offset, outcome, old },
  );
}

test('normal member entry discovers and selects without executing; explicit start refreshes catalog and inbox', async ({
  page,
}) => {
  await setup(page, true);
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  await button(page, '提交产物').click();
  await page.getByLabel('补充说明（选填）', { exact: true }).fill('正在处理的交付草稿');
  await choose(page, base);
  await button(page, '刷新计划').click();
  await expect(picker(page)).toBeEnabled();
  expect(await calls(page, 'start-plan')).toHaveLength(0);
  const beforeInbox = (await calls(page, 'inbox')).length;
  await page.evaluate(() => {
    window.startableProbe.holdWrites = true;
  });
  await button(page, '开始执行').dblclick({ force: true });
  await expect(button(page, '开始执行')).toBeDisabled();
  await expect.poll(() => calls(page, 'start-plan')).toHaveLength(1);
  expect((await calls(page, 'start-plan'))[0]).toMatchObject({
    taskId: 'orders',
    planId: 'plan-main',
    revision: 1,
  });
  await finish(page, 'start-plan');
  await expect(button(page, '开始执行')).toHaveCount(0);
  await expect(page.getByText('执行 订单筛选方案', { exact: true })).toBeVisible();
  await expect(page.getByLabel('补充说明（选填）', { exact: true })).toHaveValue(
    '正在处理的交付草稿',
  );
  await expect.poll(async () => (await calls(page, 'inbox')).length).toBe(beforeInbox + 1);
  await picker(page).click();
  await expect(page.getByRole('option', { name: base, exact: true })).toHaveCount(0);
  expect(await calls(page, 'start-plan')).toHaveLength(1);
});

for (const [axis, name] of Object.entries(alternatives)) {
  for (const outcome of ['success', 'failure', 'reject']) {
    test(`${axis} selection ignores old start ${outcome} and finally while the current start remains pending`, async ({
      page,
    }) => {
      await setup(page);
      await page.evaluate(() => {
        window.startableProbe.holdWrites = true;
      });
      await choose(page, base);
      await button(page, '开始执行').click();
      await choose(page, name);
      await button(page, '开始执行').click();
      await finish(page, 'start-plan', 0, outcome);
      await expect(picker(page)).toContainText(name);
      await expect(button(page, '开始执行')).toBeDisabled();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await page.evaluate(() => window.startableProbe.events)).toBe(0);
      expect(
        await page.evaluate(
          () =>
            window.startableProbe.calls.find((call) => call.endpoint.endsWith('/start-plan')).signal
              .aborted,
        ),
      ).toBe(true);
      await finish(page, 'start-plan');
      await expect(button(page, '开始执行')).toHaveCount(0);
      expect(await page.evaluate(() => window.startableProbe.events)).toBe(1);
    });
  }
}

for (const outcome of ['success', 'failure', 'reject']) {
  test(`catalog ${outcome} from a superseded read cannot replace a pending refresh after start`, async ({
    page,
  }) => {
    await setup(page);
    await choose(page, base);
    await page.evaluate(() => {
      window.startableProbe.holdWrites = true;
    });
    await button(page, '开始执行').click();
    await page.evaluate(() => {
      window.startableProbe.holdReads = true;
    });
    await button(page, '刷新计划').click();
    await finish(page, 'start-plan');
    await finish(page, 'startable', 0, outcome);
    await expect(button(page, '刷新计划')).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => window.startableProbe.events)).toBe(1);
    await finish(page, 'startable');
    await expect(picker(page)).toBeEnabled();
    await picker(page).click();
    await expect(page.getByRole('option', { name: base, exact: true })).toHaveCount(0);
  });
  test(`old API catalog ${outcome} cannot alter a new session loading state`, async ({ page }) => {
    await page.addInitScript(() => {
      window.holdStartableOnMount = true;
    });
    await page.goto('/?startable-plans&strict');
    await page.waitForFunction(() => window.startableProbe.calls.length > 0);
    await page.evaluate(() => {
      window.oldStartableProbe = window.startableProbe;
    });
    await button(page, '更换计划API会话').click();
    await finish(page, 'startable', -1, outcome, true);
    await expect(button(page, '刷新计划')).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await finish(page, 'startable');
    await expect(picker(page)).toBeEnabled();
  });
}

test('unknown start result retries with the same key; an unavailable catalog disables starting', async ({
  page,
}) => {
  await setup(page);
  await choose(page, base);
  await page.evaluate(() => {
    window.startableProbe.holdWrites = true;
  });
  await button(page, '开始执行').click();
  await finish(page, 'start-plan', -1, 'reject');
  await expect(page.getByRole('alert')).toHaveText('请求未完成，请重试。');
  await button(page, '开始执行').click();
  const writes = await calls(page, 'start-plan');
  expect(writes[0].idempotencyKey).toBe(writes[1].idempotencyKey);
  await finish(page, 'start-plan', -1, 'failure');
  await expect(page.getByRole('alert')).toHaveText('当前账号已无权开始这项计划。');
  await page.evaluate(() => {
    window.startableProbe.holdReads = true;
  });
  await button(page, '刷新计划').click();
  await finish(page, 'startable', -1, 'reject');
  await expect(button(page, '开始执行')).toBeDisabled();
  expect(await page.evaluate(() => window.startableProbe.events)).toBe(0);
});

for (const outcome of ['success', 'failure', 'reject']) {
  test(`old session start ${outcome} cannot clear a new selection or release its pending command`, async ({
    page,
  }) => {
    await setup(page);
    await page.evaluate(() => {
      window.startableProbe.holdWrites = true;
    });
    await choose(page, base);
    await button(page, '开始执行').click();
    await page.evaluate(() => {
      window.oldStartableProbe = window.startableProbe;
    });
    await button(page, '更换计划API会话').click();
    await expect(picker(page)).toBeEnabled();
    await page.evaluate(() => {
      window.startableProbe.holdWrites = true;
    });
    await choose(page, alternatives.task);
    await button(page, '开始执行').click();
    await finish(page, 'start-plan', -1, outcome, true);
    await expect(picker(page)).toContainText(alternatives.task);
    await expect(button(page, '开始执行')).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => window.startableProbe.events)).toBe(0);
    await finish(page, 'start-plan');
    expect(await page.evaluate(() => window.startableProbe.events)).toBe(1);
  });
}

test('a catalog for a different cookie actor is never rendered beneath the previous account', async ({
  page,
}) => {
  await setup(page, true);
  await page.evaluate(() => {
    window.startableProbe.replyActor = 'lin';
    window.startableProbe.plans = [
      { taskId: 'lin-task', planId: 'lin-plan', revision: 1, title: '另一个账号的计划内容' },
    ];
  });
  await button(page, '刷新计划').click();
  await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toBeVisible();
  await expect(page.getByText('另一个账号的计划内容')).toHaveCount(0);
  await expect(picker(page)).toHaveCount(0);
});

test('keyboard plan selection stays read-only until the start button is explicitly activated', async ({
  page,
}) => {
  await setup(page);
  await picker(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: '选择一个计划', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(
    page.getByRole('option', { name: alternatives.revision, exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker(page)).toContainText(alternatives.revision);
  expect(await calls(page, 'start-plan')).toHaveLength(0);
  await expect(picker(page)).toBeFocused();
  await page.evaluate(() => {
    window.startableProbe.holdWrites = true;
  });
  await page.keyboard.press('Tab');
  await expect(button(page, '开始执行')).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await calls(page, 'start-plan'))[0]).toMatchObject({
    taskId: 'orders',
    planId: 'plan-main',
    revision: 2,
  });
});

test('a catalog revision replacement clears the old selection and never silently starts its successor', async ({
  page,
}) => {
  await setup(page);
  await choose(page, base);
  await page.evaluate(() => {
    window.startableProbe.holdWrites = true;
  });
  await button(page, '开始执行').click();
  await page.evaluate(() => {
    window.startableProbe.plans = window.startableProbe.plans.filter((plan) => plan.revision === 2);
  });
  await button(page, '刷新计划').click();
  await expect(picker(page)).toBeEnabled();
  await expect(picker(page)).toContainText('选择一个计划');
  await expect(button(page, '开始执行')).toHaveCount(0);
  await finish(page, 'start-plan');
  expect(await page.evaluate(() => window.startableProbe.events)).toBe(0);
  expect(await calls(page, 'start-plan')).toHaveLength(1);
  await choose(page, alternatives.revision);
  await button(page, '开始执行').click();
  await finish(page, 'start-plan');
  await expect(page.getByText('暂无待开始的计划', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.startableProbe.events)).toBe(1);
});
