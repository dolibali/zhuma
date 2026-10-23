import { expect, test } from '@playwright/test';

// HTTP response replay only. These fixtures do not issue real member cookies or prove authorization.
function session(accountId) {
  return {
    ok: true,
    accountId,
    principal: { kind: 'zhuma-member', memberId: accountId },
    peerId: `fixture-peer-${accountId}`,
  };
}
async function reply(route, status, body) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('member login contract: keyboard login, rate limit, logout failure and account content reset', async ({
  page,
}) => {
  let accountId;
  let logins = 0;
  let logouts = 0;
  const unexpected = [];
  page.on('request', (request) => {
    if (/\/(api\/|zhuma-execution\/)/.test(new URL(request.url()).pathname))
      unexpected.push(request.url());
  });
  await page.route('**/zhuma-id/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session'))
      return reply(
        route,
        accountId ? 200 : 401,
        accountId ? session(accountId) : { ok: false, error: { code: 'unauthenticated' } },
      );
    if (path.endsWith('/login')) {
      const input = route.request().postDataJSON();
      expect(Object.keys(input).sort()).toEqual(['accountId', 'password']);
      if (++logins === 1)
        return reply(route, 429, { ok: false, error: { code: 'login-rate-limited' } });
      accountId = input.accountId;
      return reply(route, 200, { ok: true, accountId });
    }
    if (path.endsWith('/logout')) {
      if (++logouts === 1)
        return reply(route, 503, { ok: false, error: { code: 'service-unavailable' } });
      const previous = accountId;
      accountId = undefined;
      return reply(route, 200, { ok: true, accountId: previous });
    }
    throw Error('Unexpected identity route');
  });
  await page.goto('/?member-login&strict');
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  await page.getByLabel('账号', { exact: true }).fill('member-a');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByLabel('密码', { exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('尝试次数过多');
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByLabel('密码', { exact: true }).press('Enter');
  await expect(page.getByTestId('member-content')).toContainText('member-a');
  await page.getByLabel('临时工作内容').fill('old-account-draft');
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '尚未完成退出' })).toBeVisible();
  await expect(page.getByTestId('member-content')).toHaveCount(0);
  await page.getByRole('button', { name: '重试退出' }).click();
  await page.getByLabel('账号', { exact: true }).fill('member-b');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByTestId('member-content')).toContainText('member-b');
  await expect(page.getByLabel('临时工作内容')).toHaveValue('');
  expect(unexpected).toEqual([]);
});

test('member login contract: restore, protected 401, unmount and owner response stay isolated', async ({
  page,
}) => {
  let owner = false;
  await page.route('**/zhuma-id/session', (route) =>
    reply(
      route,
      200,
      owner ? { ...session('member-a'), principal: { kind: 'owner' } } : session('member-a'),
    ),
  );
  await page.goto('/?member-login&strict');
  await expect(page.getByTestId('member-content')).toContainText('member-a');
  await page.getByRole('button', { name: '报告会话失效' }).click();
  await expect(page.getByRole('alert')).toContainText('登录已失效');
  await expect(page.getByTestId('member-content')).toHaveCount(0);
  await page.getByRole('button', { name: '卸载登录入口' }).click();
  owner = true;
  await page.getByRole('button', { name: '重新打开登录入口' }).click();
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  await expect(page.getByTestId('member-content')).toHaveCount(0);
});
