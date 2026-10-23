/**
 * Real Chromium checks for member cookies. The workbench test:ui server does
 * not mount /zhuma-id; this spec starts that route itself.
 *
 * Re-run just this project:
 *   pnpm exec playwright test --config packages/client/tests/browser/playwright.config.mjs --project=identity
 * Playwright starts webServer before globalSetup. Since 4e6a055 that command
 * runs `pnpm exec tsc -b --pretty false` and then the server, so a tree
 * without dist still boots. globalSetup runs `tsc -b` again afterwards.
 * `pnpm test:ui` includes the same project.
 * The fixture listens on port 0.
 */
import { expect, test } from '@playwright/test';
import { startIdentitySite } from './server.mjs';

async function readJson(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json };
    },
    { method, path, body },
  );
}

test('two browser contexts are different members, and logout drops only the member cookie', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const site = await startIdentitySite();
  try {
    const openMember = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(site.authenticatedURL);
      return { context, page };
    };
    const memberName = (cookies) => cookies.some((cookie) => cookie.name === 'zhuma-member');
    const dshName = (cookies) => cookies.some((cookie) => cookie.name.startsWith('dsh-auth-'));

    const first = await openMember();
    const before = await first.context.cookies();
    expect(dshName(before)).toBe(true);
    expect((await readJson(first.page, 'GET', '/zhuma-id/session')).status).toBe(401);

    const loggedIn = await readJson(first.page, 'POST', '/zhuma-id/login', {
      accountId: 'chen',
      password: site.passwords.chen,
    });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.json.accountId).toBe('chen');
    const stored = await first.context.cookies();
    const member = stored.find((cookie) => cookie.name === 'zhuma-member');
    expect(member).toBeTruthy();
    expect(member.path).toBe('/');
    expect(member.httpOnly).toBe(true);
    expect(member.sameSite).toBe('Strict');
    expect(member.expires).toBeGreaterThan(Date.now() / 1000 + 43_000);
    expect(stored.filter((cookie) => cookie.name === 'zhuma-member')).toHaveLength(1);
    expect(dshName(stored)).toBe(true);
    expect(await first.page.evaluate(() => document.cookie)).toBe('');

    const session = await readJson(first.page, 'GET', '/zhuma-id/session');
    expect(session.status).toBe(200);
    expect(session.json.accountId).toBe('chen');
    expect(session.json.principal.kind).toBe('zhuma-member');
    expect((await readJson(first.page, 'GET', '/zhuma-id/notes/north-note')).status).toBe(404);
    expect((await readJson(first.page, 'GET', '/zhuma-id/notes/south-note')).status).toBe(200);

    const second = await openMember();
    const secondLogin = await readJson(second.page, 'POST', '/zhuma-id/login', {
      accountId: 'zhao',
      password: site.passwords.zhao,
    });
    expect(secondLogin.status).toBe(200);
    const [left, right] = await Promise.all([
      readJson(first.page, 'GET', '/zhuma-id/session'),
      readJson(second.page, 'GET', '/zhuma-id/session'),
    ]);
    expect(left.json.accountId).toBe('chen');
    expect(right.json.accountId).toBe('zhao');
    expect((await readJson(second.page, 'GET', '/zhuma-id/notes/north-note')).status).toBe(200);
    expect((await readJson(second.page, 'GET', '/zhuma-id/notes/south-note')).status).toBe(404);

    const other = await first.context.newPage();
    await other.goto(site.otherURL);
    await other.evaluate(async (base) => {
      await fetch(`${base}/zhuma-id/notes/south-note`, { credentials: 'include', mode: 'no-cors' });
      await fetch(`${base}/zhuma-id/logout`, {
        method: 'POST',
        credentials: 'include',
        mode: 'no-cors',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      });
    }, site.baseURL);
    expect((await readJson(first.page, 'GET', '/zhuma-id/session')).json.accountId).toBe('chen');

    const loggedOut = await readJson(first.page, 'POST', '/zhuma-id/logout', {});
    expect(loggedOut.status).toBe(200);
    const afterLogout = await first.context.cookies();
    expect(memberName(afterLogout)).toBe(false);
    expect(dshName(afterLogout)).toBe(true);
    expect((await readJson(first.page, 'GET', '/zhuma-id/session')).status).toBe(401);
    expect((await readJson(first.page, 'GET', '/zhuma-id/notes/north-note')).status).toBe(401);
    await first.page.reload();
    expect((await readJson(first.page, 'GET', '/zhuma-id/session')).status).toBe(401);
    expect((await readJson(second.page, 'GET', '/zhuma-id/session')).json.accountId).toBe('zhao');

    await second.context.clearCookies({ name: 'zhuma-member' });
    expect((await readJson(second.page, 'GET', '/zhuma-id/session')).status).toBe(401);
    expect(dshName(await second.context.cookies())).toBe(true);

    const again = await readJson(second.page, 'POST', '/zhuma-id/login', {
      accountId: 'zhao',
      password: site.passwords.zhao,
    });
    expect(again.status).toBe(200);
    const realNow = Date.now;
    Date.now = () => realNow() + 12 * 60 * 60 * 1000 + 1000;
    try {
      expect((await readJson(second.page, 'GET', '/zhuma-id/session')).status).toBe(401);
    } finally {
      Date.now = realNow;
    }

    const held = (await second.context.cookies()).find((cookie) => cookie.name === 'zhuma-member');
    expect(held).toBeTruthy();
    await second.context.addCookies([{ ...held, expires: Math.floor(Date.now() / 1000) + 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const lapsed = await second.context.cookies();
    expect(memberName(lapsed)).toBe(false);
    expect((await readJson(second.page, 'GET', '/zhuma-id/session')).status).toBe(401);
    expect(dshName(lapsed)).toBe(true);

    const third = await browser.newContext();
    const thirdPage = await third.newPage();
    await thirdPage.goto(`${site.baseURL}/zhuma-id/session`);
    const memberOnly = await readJson(thirdPage, 'POST', '/zhuma-id/login', {
      accountId: 'lin',
      password: site.passwords.lin,
    });
    expect(memberOnly.status).toBe(200);
    expect((await readJson(thirdPage, 'GET', '/zhuma-id/notes/north-note')).status).toBe(200);
    expect((await readJson(thirdPage, 'GET', '/zhuma-id/notes/south-note')).status).toBe(404);

    await third.close();
    await first.context.close();
    await second.context.close();
  } finally {
    await site.close();
  }
});
