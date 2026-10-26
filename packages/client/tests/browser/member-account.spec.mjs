import { test, expect } from '@playwright/test';

// Two real React roots, actual footer/main components and HTTP replay. Host geometry is NOT imitated.
const account = (page) => page.getByRole('button', { name: /^账号与空间：/ });
const dialog = (page) => page.getByRole('dialog', { name: '账号与空间', exact: true });
async function setup(page) {
  await page.goto('/?member-account&strict');
  await expect(account(page)).toHaveAttribute('data-account-id', 'chen');
  await expect(page.getByText('现在没有需要你处理的工作。', { exact: true })).toBeVisible();
}
async function choose(page, label) {
  await account(page).click();
  await dialog(page).getByRole('combobox', { name: '切换工作空间' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function delivery(page) {
  await page
    .getByRole('article', { name: '编写订单状态帮助文案', exact: true })
    .getByRole('button')
    .click();
  return page.getByLabel('补充说明（选填）', { exact: true });
}
const inspect = (page, fn, arg) => page.evaluate(fn, arg);

test('account component contract: shared roots show identity only in footer and return focus on Escape', async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator('#root .zm-current-account')).toHaveCount(0);
  await expect(
    page.locator('#root').getByRole('combobox', { name: '当前空间', exact: true }),
  ).toBeVisible();
  const before = await inspect(page, () => window.memberAccountProbe.replay.requests.length);
  await account(page).focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText('当前账号', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(account(page)).toBeFocused();
  expect(await inspect(page, () => window.memberAccountProbe.replay.requests.length)).toBe(before);
});

test('account component contract: selected space is shared with main and menu, without execution', async ({
  page,
}) => {
  await setup(page);
  await choose(page, '团队 · 产品研发');
  await expect(
    page.getByRole('article', { name: '编写订单状态帮助文案', exact: true }),
  ).toBeVisible();
  await expect(account(page)).toContainText('团队 · 产品研发');
  await expect(page.getByRole('combobox', { name: '当前空间', exact: true })).toContainText(
    '产品研发',
  );
  await account(page).click();
  await dialog(page).getByRole('combobox', { name: '切换工作空间' }).click();
  await expect(page.getByRole('option', { name: '团队 · 产品研发', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('account component contract: footer switching honors the active page discard guard and cancellation', async ({
  page,
}) => {
  await setup(page);
  await choose(page, '团队 · 产品研发');
  const input = await delivery(page);
  await input.fill('侧栏切换前的产物');
  await choose(page, '团队 · 运营支持');
  await expect(dialog(page)).toHaveCount(0);
  const confirm = page.getByRole('dialog', { name: '切换空间？', exact: true });
  await expect(confirm.getByRole('button', { name: '留在当前空间' })).toBeFocused();
  await confirm.getByRole('button', { name: '留在当前空间' }).click();
  await expect(account(page)).toBeFocused();
  await expect(input).toHaveValue('侧栏切换前的产物');
  await expect(account(page)).toContainText('团队 · 产品研发');
  await choose(page, '团队 · 运营支持');
  await confirm.getByRole('button', { name: '放弃修改并切换' }).click();
  await expect(
    page.getByRole('article', { name: '评审导出字段脱敏方案', exact: true }),
  ).toBeVisible();
  await expect(account(page)).toContainText('团队 · 运营支持');
  await expect(page.getByLabel('补充说明（选填）')).toHaveCount(0);
});

test('account component contract: an unmounted page does not destroy global login or current space', async ({
  page,
}) => {
  await setup(page);
  await choose(page, '团队 · 产品研发');
  await expect(
    page.getByRole('article', { name: '编写订单状态帮助文案', exact: true }),
  ).toBeVisible();
  const epoch = await inspect(
    page,
    () => window.memberAccountProbe.shell.getSnapshot().session.epoch,
  );
  await page.getByRole('button', { name: '卸载工作页', exact: true }).click();
  await expect(page.getByText('工作页未挂载', { exact: true })).toBeVisible();
  await expect(account(page)).toContainText('团队 · 产品研发');
  await choose(page, '团队 · 运营支持');
  await expect(
    page.getByRole('article', { name: '评审导出字段脱敏方案', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await inspect(page, () => window.memberAccountProbe.shell.getSnapshot().session.epoch),
  ).toBe(epoch);
  expect(await inspect(page, () => window.memberAccountProbe.replay.effects)).toEqual([]);
});

test('account component contract: narrow owner props retain an accessible trigger and close the old popup', async ({
  page,
}) => {
  await setup(page);
  await account(page).click();
  await expect(dialog(page)).toBeVisible();
  await inspect(page, () => window.memberAccountProbe.setWide(false));
  await expect(dialog(page)).toHaveCount(0);
  await expect(account(page)).toHaveAttribute('title', /chen/);
  const size = await account(page).boundingBox();
  expect(size.width).toBe(36);
  expect(size.height).toBe(36);
  await account(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(account(page)).toBeFocused();
});

test('account component contract: logout clears main and footer together; next account never inherits the draft', async ({
  page,
}) => {
  await setup(page);
  await choose(page, '团队 · 产品研发');
  await (await delivery(page)).fill('必须清理的旧账号产物');
  await account(page).click();
  await dialog(page).getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '登录账号', exact: true })).toBeVisible();
  await expect(page.getByLabel('账号', { exact: true })).toBeFocused();
  await expect(page.getByLabel('补充说明（选填）')).toHaveCount(0);
  await page.getByLabel('账号', { exact: true }).fill('lin');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(account(page)).toHaveAttribute('data-account-id', 'lin');
  await expect(page.getByText('现在没有需要你处理的工作。', { exact: true })).toBeVisible();
  await expect(page.getByText('必须清理的旧账号产物', { exact: true })).toHaveCount(0);
});

test('account component contract: revoked space is reflected in footer and retries keep the original target', async ({
  page,
}) => {
  await setup(page);
  await choose(page, '团队 · 产品研发');
  await (await delivery(page)).fill('权限失效前的产物');
  await inspect(page, () => {
    const data = window.memberAccountProbe.replay;
    data.directory.chen = data.directory.chen.filter((space) => space.id !== 'team-a');
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await expect(account(page)).toContainText('空间待重新确认');
  await account(page).click();
  await dialog(page).getByRole('button', { name: '重新连接空间', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await inspect(page, () => {
    window.memberAccountProbe.replay.directory.chen.push({
      id: 'team-a',
      kind: 'team',
      name: '产品研发',
    });
  });
  await account(page).click();
  await dialog(page).getByRole('button', { name: '重新连接空间', exact: true }).click();
  await expect(account(page)).toContainText('团队 · 产品研发');
  await expect(await delivery(page)).toHaveValue('');
});
