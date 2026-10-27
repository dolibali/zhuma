import { test, expect } from '@playwright/test';

// Actual shared-shell components with HTTP replay; no Host, cookie or authorization proof.
const picker = (page) => page.getByLabel('当前空间', { exact: true });
const refresh = (page) => page.getByRole('button', { name: '刷新空间', exact: true });
const account = (page) => page.getByRole('button', { name: /^账号与空间：/ });
const inspect = (page, fn, arg) => page.evaluate(fn, arg);
async function setup(page) {
  await page.goto('/?member-account&strict');
  await expect(picker(page)).toContainText('我的空间');
  await expect(page.getByText('现在没有需要你处理的工作。', { exact: true })).toBeVisible();
}
async function choose(page, label) {
  await picker(page).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function delivery(page) {
  await page
    .getByRole('article', { name: '编写订单状态帮助文案', exact: true })
    .getByRole('button')
    .click();
  return page.getByLabel('补充说明（选填）', { exact: true });
}

test('space switcher: one-click menu exposes current space and keyboard switching shares footer state', async ({
  page,
}) => {
  await setup(page);
  const before = await inspect(page, () => window.memberAccountProbe.replay.requests.length);
  await picker(page).click();
  await expect(page.getByRole('option', { name: '个人 · 我的空间', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('option', { name: '团队 · 产品研发', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(picker(page)).toBeFocused();
  expect(await inspect(page, () => window.memberAccountProbe.replay.requests.length)).toBe(before);
  await page.keyboard.press('Tab');
  await expect(refresh(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(picker(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  // Opening schedules option focus separately. Observe both before sending navigation keys.
  await expect(picker(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('option', { name: '个人 · 我的空间', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: '团队 · 新建团队', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(picker(page)).toContainText('新建团队');
  await expect(account(page)).toContainText('团队 · 新建团队');
  await expect(picker(page)).toBeFocused();
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('space switcher: same-account reload restores the confirmed team after a fresh directory read', async ({
  page,
}) => {
  await setup(page);
  await choose(page, '团队 · 产品研发');
  await expect(picker(page)).toContainText('产品研发');
  await page.reload();
  await expect(picker(page)).toContainText('产品研发');
  await expect(account(page)).toContainText('团队 · 产品研发');
  await expect(
    page.getByRole('article', { name: '编写订单状态帮助文案', exact: true }),
  ).toBeVisible();
  expect(
    await inspect(
      page,
      () => window.memberAccountProbe.replay.requests.filter((r) => r.kind === 'session').length,
    ),
  ).toBeGreaterThanOrEqual(2);
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('space switcher: a saved ID absent from the trusted directory falls back to personal on reload', async ({
  page,
}) => {
  await setup(page);
  await inspect(page, () => localStorage.setItem('zhuma:member-space:v1:chen', 'removed-team'));
  await page.reload();
  await expect(picker(page)).toContainText('我的空间');
  await expect(account(page)).toContainText('个人 · 我的空间');
  expect(await inspect(page, () => localStorage.getItem('zhuma:member-space:v1:chen'))).toBeNull();
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('space switcher: top entry uses the same cancelable dirty guard as the account menu', async ({
  page,
}) => {
  await setup(page);
  await choose(page, '团队 · 产品研发');
  const input = await delivery(page);
  await input.fill('保留当前团队的产物草稿');
  await choose(page, '团队 · 运营支持');
  const confirm = page.getByRole('dialog', { name: '切换空间？', exact: true });
  await expect(confirm.getByRole('button', { name: '留在当前空间' })).toBeFocused();
  await expect(confirm).toContainText('已保存的内容不受影响');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(input).toHaveValue('保留当前团队的产物草稿');
  await expect(picker(page)).toBeFocused();
  await choose(page, '团队 · 运营支持');
  await confirm.getByRole('button', { name: '关闭' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(input).toHaveValue('保留当前团队的产物草稿');
  await expect(picker(page)).toBeFocused();
  await choose(page, '团队 · 运营支持');
  await confirm.getByRole('button', { name: '留在当前空间' }).click();
  await expect(input).toHaveValue('保留当前团队的产物草稿');
  await expect(picker(page)).toContainText('产品研发');
  await expect(account(page)).toContainText('团队 · 产品研发');
  await choose(page, '团队 · 运营支持');
  await confirm.getByRole('button', { name: '放弃修改并切换' }).click();
  await expect(picker(page)).toContainText('运营支持');
  await expect(account(page)).toContainText('团队 · 运营支持');
  await expect(page.getByLabel('补充说明（选填）', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: '评审导出字段脱敏方案', exact: true }),
  ).toBeVisible();
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('space switcher: more than eight spaces reuse search, retain long names and fit a narrow viewport', async ({
  page,
}) => {
  await setup(page);
  const longName = '跨区域产品研发与数据协作联合团队空间';
  await inspect(
    page,
    (name) => {
      const data = window.memberAccountProbe.replay;
      data.directory.chen.push(
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `team-extra-${i}`,
          kind: 'team',
          name: i === 9 ? name : `协作团队 ${i + 1}`,
        })),
      );
    },
    longName,
  );
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await page.setViewportSize({ width: 360, height: 640 });
  await picker(page).click();
  const search = page.getByLabel('搜索当前空间', { exact: true });
  await expect(search).toBeVisible();
  await search.fill('不存在的空间');
  await expect(page.getByText('没有匹配选项', { exact: true })).toBeVisible();
  await search.fill('跨区域');
  const option = page.getByRole('option', { name: `团队 · ${longName}`, exact: true });
  await expect(option).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.zm-select-popup').evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.left >= 0 &&
          box.top >= 0 &&
          box.right <= innerWidth &&
          box.bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
  await option.click();
  await expect(picker(page)).toContainText(longName);
  await expect(picker(page)).toHaveAttribute('title', `团队 · ${longName}`);
  await expect(account(page)).toContainText(longName);
  const trigger = await picker(page).boundingBox();
  const auxiliary = await refresh(page).boundingBox();
  expect(trigger.x + trigger.width).toBeLessThanOrEqual(auxiliary.x);
  expect(auxiliary.x + auxiliary.width).toBeLessThanOrEqual(360);
  await picker(page).click();
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(picker(page)).toBeFocused();
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('space switcher: one space still opens; revoking the last space disables choice and preserves refresh', async ({
  page,
}) => {
  await setup(page);
  await inspect(page, () => {
    const data = window.memberAccountProbe.replay;
    data.directory.chen = data.directory.chen.filter((space) => space.kind === 'personal');
  });
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await picker(page).click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await inspect(page, () => {
    window.memberAccountProbe.replay.directory.chen = [];
  });
  // The existing current-space refresh must report revocation, not silently switch.
  await refresh(page).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await expect(picker(page)).toBeDisabled();
  await expect(refresh(page)).toBeEnabled();
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('space switcher: pending selection hides old work and failed access retries the requested space', async ({
  page,
}) => {
  await setup(page);
  await inspect(page, () => {
    window.memberAccountProbe.replay.holdSessions = true;
  });
  await choose(page, '团队 · 产品研发');
  await expect(picker(page)).toContainText('正在确认空间');
  await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toHaveCount(0);
  await inspect(page, () => {
    const data = window.memberAccountProbe.replay;
    data.holdSessions = false;
    data.complete(
      data.requests.findLastIndex((entry) => entry.kind === 'session' && !entry.settled),
      'reject',
    );
  });
  await expect(page.getByRole('heading', { name: '暂时无法打开空间', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(picker(page)).toContainText('产品研发');
  await expect(account(page)).toContainText('团队 · 产品研发');
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('space switcher: refresh preserves input but confirmed revocation clears it without a discard prompt', async ({
  page,
}) => {
  await setup(page);
  await choose(page, '团队 · 产品研发');
  const input = await delivery(page);
  await input.fill('权限仍有效时保留的草稿');
  await refresh(page).click();
  await expect(refresh(page)).toBeEnabled();
  await expect(input).toHaveValue('权限仍有效时保留的草稿');
  await inspect(page, () => {
    const data = window.memberAccountProbe.replay;
    data.directory.chen = data.directory.chen.filter((space) => space.id !== 'team-a');
  });
  await refresh(page).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(account(page)).toContainText('空间待重新确认');
  await choose(page, '个人 · 我的空间');
  await expect(picker(page)).toContainText('我的空间');
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});
