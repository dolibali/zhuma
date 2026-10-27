import { test, expect } from '@playwright/test';

// Actual MemberExecutionPage with deterministic HTTP replay; not real identity or business proof.
const control = (page, fn, arg) => page.evaluate(fn, arg);
const spacePicker = (page) => page.getByRole('combobox', { name: '当前空间', exact: true });
const planPicker = (page) => page.getByRole('combobox', { name: '已确认计划', exact: true });
async function setup(page) {
  await page.goto('/?member-execution-spaces&strict');
  await expect(spacePicker(page)).toContainText('我的空间');
  await expect(spacePicker(page)).toHaveAttribute('title', '个人 · 我的空间');
  await expect(page.getByText('现在没有需要你处理的工作。', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无待开始的计划', { exact: true })).toBeVisible();
}
async function chooseSpace(page, name) {
  await spacePicker(page).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function choosePlan(page, label) {
  await expect(planPicker(page)).toBeEnabled();
  await planPicker(page).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function delivery(page) {
  await page
    .getByRole('article', { name: '编写订单状态帮助文案', exact: true })
    .getByRole('button')
    .click();
  await expect(page.locator('.zm-draft-status')).toHaveText('尚未保存草稿');
  return page.getByLabel('补充说明（选填）', { exact: true });
}
async function review(page) {
  await page
    .getByRole('article', { name: '评审导出字段脱敏方案', exact: true })
    .getByRole('button')
    .click();
  return page.getByLabel('评审意见', { exact: true });
}
const calls = (page, method) =>
  control(
    page,
    (method) =>
      window.memberExecutionSpaces.requests
        .filter((entry) => entry.kind === 'service' && entry.request.method === method)
        .map((entry) => entry.request.payload),
    method,
  );
async function held(page, kind, method) {
  await page.waitForFunction(
    ({ kind, method }) =>
      window.memberExecutionSpaces.requests.some(
        (entry) =>
          entry.kind === kind && !entry.settled && (!method || entry.request.method === method),
      ),
    { kind, method },
  );
  return control(
    page,
    ({ kind, method }) =>
      window.memberExecutionSpaces.requests.findLastIndex(
        (entry) =>
          entry.kind === kind && !entry.settled && (!method || entry.request.method === method),
      ),
    { kind, method },
  );
}
const finish = (page, index, outcome = 'success') =>
  control(page, ({ index, outcome }) => window.memberExecutionSpaces.complete(index, outcome), {
    index,
    outcome,
  });

test('formal spaces: personal/team empty states and task data follow the explicit scope; reading and selecting execute nothing', async ({
  page,
}) => {
  await setup(page);
  await chooseSpace(page, '团队 · 产品研发');
  await expect(
    page.getByRole('article', { name: '编写订单状态帮助文案', exact: true }),
  ).toBeVisible();
  await chooseSpace(page, '团队 · 运营支持');
  await expect(
    page.getByRole('article', { name: '评审导出字段脱敏方案', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('编写订单状态帮助文案', { exact: true })).toHaveCount(0);
  await chooseSpace(page, '团队 · 新建团队');
  await expect(page.getByText('现在没有需要你处理的工作。', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无待开始的计划', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const queries = [...(await calls(page, 'inbox')), ...(await calls(page, 'startable'))];
  expect(
    queries.every((payload) =>
      ['personal-chen', 'team-a', 'team-b', 'team-empty'].includes(payload.spaceId),
    ),
  ).toBe(true);
  expect(await calls(page, 'start-plan')).toHaveLength(0);
  expect(await control(page, () => window.memberExecutionSpaces.effects)).toEqual([]);
});

test('formal spaces: same-space refresh and explicit start preserve delivery input; cross-space discard remains cancellable', async ({
  page,
}) => {
  await setup(page);
  await chooseSpace(page, '团队 · 产品研发');
  const input = await delivery(page);
  await input.fill('当前团队未提交产物');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('当前团队未提交产物');
  await choosePlan(page, '补充订单导出筛选 · 第 1 版');
  expect(await calls(page, 'start-plan')).toHaveLength(0);
  await page.getByRole('button', { name: '开始执行', exact: true }).click();
  await expect(
    page.getByText('「补充订单导出筛选」第 1 版已开始执行', { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue('当前团队未提交产物');
  expect((await calls(page, 'start-plan'))[0]).toMatchObject({
    spaceId: 'team-a',
    taskId: 'task-orders',
    planId: 'plan-export',
    revision: 1,
  });
  await chooseSpace(page, '团队 · 运营支持');
  const dialog = page.getByRole('dialog', { name: '切换空间？' });
  await dialog.getByRole('button', { name: '留在当前空间' }).click();
  await expect(input).toHaveValue('当前团队未提交产物');
  await chooseSpace(page, '团队 · 运营支持');
  await dialog.getByRole('button', { name: '放弃修改并切换' }).click();
  await expect(await review(page)).toHaveValue('');
  await chooseSpace(page, '团队 · 产品研发');
  await expect(await delivery(page)).toHaveValue('');
  expect(await calls(page, 'start-plan')).toHaveLength(1);
});

for (const method of ['inbox', 'startable'])
  for (const echo of ['missing', 'wrong']) {
    test(`formal spaces: ${method} ${echo} scope closes the view, then retry restores the same team`, async ({
      page,
    }) => {
      await setup(page);
      await control(
        page,
        ({ method, echo }) => {
          window.memberExecutionSpaces.badEcho[method] = echo;
        },
        { method, echo },
      );
      await chooseSpace(page, '团队 · 产品研发');
      await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
      await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toHaveCount(0);
      await control(page, () => {
        window.memberExecutionSpaces.badEcho = {};
      });
      await page.getByRole('button', { name: '重新连接' }).click();
      await expect(spacePicker(page)).toContainText('产品研发');
      await expect(spacePicker(page)).toHaveAttribute('title', '团队 · 产品研发');
      await expect(
        page.getByRole('article', { name: '编写订单状态帮助文案', exact: true }),
      ).toBeVisible();
      expect(await calls(page, 'start-plan')).toHaveLength(0);
    });
  }

test('formal spaces: revoked session membership closes dirty content before another execution request and retries the original team', async ({
  page,
}) => {
  await setup(page);
  await chooseSpace(page, '团队 · 产品研发');
  await (await delivery(page)).fill('权限失效时应清理');
  const before = (await calls(page, 'inbox')).length;
  await control(page, () => {
    const data = window.memberExecutionSpaces;
    data.directory.chen = data.directory.chen.filter((space) => space.id !== 'team-a');
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await expect(page.getByLabel('补充说明（选填）')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await calls(page, 'inbox')).toHaveLength(before);
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await control(page, () => {
    window.memberExecutionSpaces.directory.chen.push({
      id: 'team-a',
      kind: 'team',
      name: '产品研发',
    });
  });
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(spacePicker(page)).toContainText('产品研发');
  await expect(spacePicker(page)).toHaveAttribute('title', '团队 · 产品研发');
  await expect(await delivery(page)).toHaveValue('');
});

test('formal spaces: session prechecks held across switching and logout cannot change the new member or space', async ({
  page,
}) => {
  await setup(page);
  await chooseSpace(page, '团队 · 产品研发');
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await control(page, () => {
    window.memberExecutionSpaces.holdSessions = true;
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const old = await held(page, 'session');
  await chooseSpace(page, '团队 · 运营支持');
  await expect(page.getByRole('status')).toContainText('正在确认空间访问权限');
  const next = await held(page, 'session');
  expect(next).not.toBe(old);
  await control(page, () => {
    window.memberExecutionSpaces.holdSessions = false;
  });
  await finish(page, next);
  await expect(
    page.getByRole('article', { name: '评审导出字段脱敏方案', exact: true }),
  ).toBeVisible();
  await finish(page, old, '401');
  await expect(spacePicker(page)).toContainText('运营支持');
  await expect(spacePicker(page)).toHaveAttribute('title', '团队 · 运营支持');
  await control(page, () => {
    window.memberExecutionSpaces.holdSessions = true;
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const departing = await held(page, 'session');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toBeVisible();
  await control(page, () => {
    window.memberExecutionSpaces.holdSessions = false;
  });
  await page.getByLabel('账号', { exact: true }).fill('lin');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.zm-current-account strong')).toHaveText('lin');
  await expect(page.getByText('现在没有需要你处理的工作。', { exact: true })).toBeVisible();
  await finish(page, departing);
  await expect(page.locator('.zm-current-account strong')).toHaveText('lin');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('formal spaces: changed account during the current precheck returns to login with no command dispatch', async ({
  page,
}) => {
  await setup(page);
  await chooseSpace(page, '团队 · 产品研发');
  await expect(
    page.getByRole('article', { name: '编写订单状态帮助文案', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await control(page, () => {
    window.memberExecutionSpaces.holdSessions = true;
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const index = await held(page, 'session');
  await finish(page, index, 'wrong-member');
  await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  expect(await calls(page, 'start-plan')).toHaveLength(0);
});

for (const outcome of ['success', 'failure', 'reject']) {
  test(`formal spaces: old start ${outcome} cannot refresh, clear or disable another team's selected plan`, async ({
    page,
  }) => {
    await setup(page);
    await chooseSpace(page, '团队 · 产品研发');
    await choosePlan(page, '补充订单导出筛选 · 第 1 版');
    await control(page, () => {
      window.memberExecutionSpaces.holdMethods = ['start-plan'];
    });
    await page.getByRole('button', { name: '开始执行', exact: true }).click();
    const index = await held(page, 'service', 'start-plan');
    await chooseSpace(page, '团队 · 运营支持');
    await choosePlan(page, '敏感字段脱敏复核 · 第 2 版');
    await expect(
      page.getByRole('article', { name: '评审导出字段脱敏方案', exact: true }),
    ).toBeVisible();
    const before = (await calls(page, 'inbox')).length;
    await finish(page, index, outcome);
    await expect(planPicker(page)).toContainText('敏感字段脱敏复核');
    await expect(page.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(
      page.getByText('「补充订单导出筛选」第 1 版已开始执行', { exact: true }),
    ).toHaveCount(0);
    expect(await calls(page, 'inbox')).toHaveLength(before);
    expect(await calls(page, 'start-plan')).toHaveLength(1);
  });
  test(`formal spaces: old submission ${outcome} cannot clear another space's review input`, async ({
    page,
  }) => {
    await setup(page);
    await chooseSpace(page, '团队 · 产品研发');
    await (await delivery(page)).fill('旧空间已发送的产物');
    await control(page, () => {
      window.memberExecutionSpaces.holdMethods = ['submit'];
    });
    await page
      .locator('.zm-execution-detail')
      .getByRole('button', { name: '提交产物', exact: true })
      .click();
    const index = await held(page, 'service', 'submit');
    await chooseSpace(page, '团队 · 运营支持');
    await page.getByRole('dialog').getByRole('button', { name: '放弃修改并切换' }).click();
    const input = await review(page);
    await input.fill('新空间的评审意见');
    await finish(page, index, outcome);
    await expect(input).toHaveValue('新空间的评审意见');
    await expect(page.getByRole('button', { name: '通过', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await calls(page, 'submit')).toHaveLength(1);
  });
}
