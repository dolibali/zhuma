import { test, expect } from '@playwright/test';

// Identity HTTP replay, not real cookies, business filtering or authorization proof.
const personal = (id) => ({ id: `personal-${id}`, kind: 'personal', name: `${id} 的个人空间` });
const teamA = { id: 'team-a', kind: 'team', name: '产品研发' };
const teamB = { id: 'team-b', kind: 'team', name: '运营支持' };
async function fixture(page) {
  const state = {
    account: 'member-a',
    directory: {
      'member-a': [teamA, personal('a'), teamB],
      'member-b': [personal('b'), teamB],
      'member-c': [],
    },
    fail: false,
    requests: [],
    workRequests: [],
  };
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api')) state.workRequests.push(request.url());
  });
  await page.route('**/zhuma-id/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    state.requests.push(path);
    let body,
      status = 200;
    if (path.endsWith('/login')) {
      state.account = route.request().postDataJSON().accountId;
      body = { ok: true, accountId: state.account };
    } else if (path.endsWith('/logout')) {
      body = { ok: true, accountId: state.account };
      state.account = undefined;
    } else if (state.fail) {
      status = 503;
      body = { ok: false };
    } else if (!state.account) {
      status = 401;
      body = { ok: false };
    } else
      body = {
        ok: true,
        accountId: state.account,
        principal: { kind: 'zhuma-member', memberId: state.account },
        peerId: `request-peer-${state.requests.length}`,
        spaces: state.directory[state.account],
      };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/?member-spaces&strict');
  await expect(page.getByTestId('space-id')).toHaveText('personal-a');
  return state;
}
async function choose(page, label) {
  const picker = page.getByRole('combobox', { name: '当前空间' });
  await picker.click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test('space boundary: trusted personal/team selection, same-space refresh and zero work commands', async ({
  page,
}) => {
  const state = await fixture(page);
  await choose(page, '团队 · 产品研发');
  await expect(page.getByTestId('space-id')).toHaveText('team-a');
  await page.getByRole('textbox', { name: '交互夹具输入' }).fill('未提交正文');
  await page.getByRole('button', { name: '刷新空间', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新空间', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox')).toHaveValue('未提交正文');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.requests.every((path) => path === '/zhuma-id/session')).toBe(true);
  expect(state.workRequests).toEqual([]);
});

test('space boundary: unsaved change prompt can cancel, and confirmed switch clears it without migrating content', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('textbox').fill('留在个人空间的正文');
  await choose(page, '团队 · 产品研发');
  const dialog = page.getByRole('dialog', { name: '切换空间？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '留在当前空间' }).click();
  await expect(page.getByTestId('space-id')).toHaveText('personal-a');
  await expect(page.getByRole('textbox')).toHaveValue('留在个人空间的正文');
  await choose(page, '团队 · 产品研发');
  await dialog.getByRole('button', { name: '放弃修改并切换' }).click();
  await expect(page.getByTestId('space-id')).toHaveText('team-a');
  await expect(page.getByRole('textbox')).toHaveValue('');
  await choose(page, '个人 · a 的个人空间');
  await expect(page.getByTestId('space-id')).toHaveText('personal-a');
  await expect(page.getByRole('textbox')).toHaveValue('');
});

test('space boundary: permission loss bypasses discard prompt and cannot reopen a revoked space', async ({
  page,
}) => {
  const state = await fixture(page);
  await choose(page, '团队 · 产品研发');
  await page.getByRole('textbox').fill('必须关闭的输入');
  state.directory['member-a'] = [personal('a'), teamB];
  await page.getByRole('button', { name: '模拟当前空间权限失效' }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await expect(page.getByTestId('space-id')).toHaveCount(0);
  state.directory['member-a'] = [personal('a'), teamA, teamB];
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByTestId('space-id')).toHaveText('team-a');
  state.directory['member-a'] = [personal('a'), teamB];
  await page.getByRole('button', { name: '模拟当前空间权限失效' }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await choose(page, '团队 · 产品研发');
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await expect(page.getByTestId('space-id')).toHaveCount(0);
  await choose(page, '团队 · 运营支持');
  await expect(page.getByTestId('space-id')).toHaveText('team-b');
  await expect(page.getByRole('textbox')).toHaveValue('');
});

test('space boundary: revoked directory refresh retries the original space and reopens it only when restored', async ({
  page,
}) => {
  const state = await fixture(page);
  await choose(page, '团队 · 产品研发');
  await expect(page.getByTestId('space-id')).toHaveText('team-a');
  state.directory['member-a'] = [personal('a'), teamB];
  await page.getByRole('button', { name: '刷新空间', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByRole('alert')).toContainText('此空间已不可访问');
  await expect(page.getByTestId('space-id')).toHaveCount(0);
  state.directory['member-a'] = [personal('a'), teamA, teamB];
  await page.getByRole('button', { name: '刷新空间', exact: true }).click();
  await expect(page.getByTestId('space-id')).toHaveText('team-a');
});

test('space boundary: current failures close content, recover explicitly, and old invalidation cannot close a new space', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.evaluate(() => {
    window.oldSpaceFailure = window.memberSpacesProbe.invalidations.at(-1);
  });
  await choose(page, '团队 · 产品研发');
  await expect(page.getByTestId('space-id')).toHaveText('team-a');
  await page.evaluate(() => window.oldSpaceFailure());
  await expect(page.getByTestId('space-id')).toHaveText('team-a');
  state.fail = true;
  await choose(page, '团队 · 运营支持');
  await expect(page.getByRole('alert')).toContainText('暂时无法连接');
  await expect(page.getByTestId('space-id')).toHaveCount(0);
  state.fail = false;
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByTestId('space-id')).toHaveText('team-b');
});

test('space boundary: logout and three accounts keep personal/team lists separate, unassigned account is normal', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('textbox').fill('账号A输入');
  for (const [account, expected] of [
    ['member-b', 'personal-b'],
    ['member-c', undefined],
  ]) {
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(account);
    await page.getByLabel('密码', { exact: true }).fill('fixture-only');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    if (expected) {
      await expect(page.getByTestId('space-id')).toHaveText(expected);
      await expect(page.getByRole('textbox')).toHaveValue('');
      await page.getByRole('combobox', { name: '当前空间' }).click();
      await expect(page.getByRole('option', { name: '团队 · 产品研发', exact: true })).toHaveCount(
        0,
      );
      await page.keyboard.press('Escape');
    } else {
      await expect(page.getByRole('heading', { name: '尚未分配空间' })).toBeVisible();
      await expect(page.getByTestId('space-id')).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: '当前空间' })).toBeDisabled();
    }
  }
});

test('space boundary: keyboard switch returns focus and exposes only the explicitly selected space', async ({
  page,
}) => {
  await fixture(page);
  const picker = page.getByRole('combobox', { name: '当前空间' });
  await picker.focus();
  await picker.press('ArrowDown');
  await expect(
    page.getByRole('option', { name: '个人 · a 的个人空间', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: '团队 · 运营支持', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('space-id')).toHaveText('team-b');
  await expect(picker).toBeFocused();
});
