import { test, expect } from '@playwright/test';

const sources = (page) => page.getByRole('region', { name: '上游输入', exact: true });
const disclosure = (page) => sources(page).locator('details').first();
const body = (page) => page.getByRole('region', { name: '上游正文', exact: true });
const draft = (page) => page.getByLabel('产物正文', { exact: true });
async function open(page, mode = 'submit', strict = false) {
  await page.goto(`/?upstream-client&${strict ? 'strict&' : ''}upstream-mode=${mode}`);
  await page
    .getByRole('button', { name: mode === 'revise' ? '提交新版本' : '提交产物', exact: true })
    .click();
  await expect(page.locator('.zm-draft-status')).toHaveText('尚未保存草稿');
}
const readCount = (page) =>
  page.evaluate(
    () =>
      window.upstreamProbe.calls.filter((call) => call.endpoint.endsWith('/upstream-content'))
        .length,
  );

async function heldContentRead(page) {
  const index = () =>
    page.evaluate(() =>
      window.upstreamProbe.calls.findLastIndex(
        (call) =>
          call.endpoint.endsWith('/upstream-content') &&
          typeof call.resolve === 'function' &&
          !call.signal.aborted,
      ),
    );
  // Loading can render before dispatch; StrictMode may already have aborted an earlier read.
  await expect.poll(index).toBeGreaterThanOrEqual(0);
  return index();
}

for (const mode of ['submit', 'revise']) {
  test(`upstream content ${mode}: read only on expand, preserve draft, close and reauthorize on reopen`, async ({
    page,
  }) => {
    await open(page, mode);
    await draft(page).fill('正在编辑的交付草稿');
    expect(await readCount(page)).toBe(0);
    await expect(sources(page).locator('details')).toHaveCount(1);
    await disclosure(page).locator('summary').click();
    await expect(body(page)).toContainText('缺少状态筛选时保持旧返回结构');
    await expect(sources(page).getByRole('link')).toHaveAttribute(
      'href',
      'https://example.com/contracts/orders',
    );
    expect(await readCount(page)).toBe(1);
    await expect(draft(page)).toHaveValue('正在编辑的交付草稿');
    await disclosure(page).locator('summary').click();
    await expect(body(page)).toHaveCount(0);
    await disclosure(page).locator('summary').click();
    await expect(body(page)).toBeVisible();
    expect(await readCount(page)).toBe(2);
    expect(
      await page.evaluate(() =>
        window.upstreamProbe.calls.some((call) => /submit|ballot|start-plan/.test(call.endpoint)),
      ),
    ).toBe(false);
    await expect(sources(page).locator('iframe, input[type=file], a[download]')).toHaveCount(0);
  });
}

test('upstream content: source denial stays local, retry preserves draft and uses the same pinned reference', async ({
  page,
}) => {
  await open(page);
  await draft(page).fill('错误时也保留');
  await page.evaluate(() => {
    window.upstreamProbe.denyContent = true;
  });
  await disclosure(page).locator('summary').click();
  await expect(sources(page).getByRole('alert')).toHaveText('来源版本已不可读取。');
  await expect(draft(page)).toHaveValue('错误时也保留');
  await page.evaluate(() => {
    window.upstreamProbe.denyContent = false;
  });
  await sources(page).getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(body(page)).toContainText('订单接口约定');
  const reads = await page.evaluate(() =>
    window.upstreamProbe.calls
      .filter((call) => call.endpoint.endsWith('/upstream-content'))
      .map((call) => call.payload),
  );
  expect(reads).toHaveLength(2);
  expect(reads[1]).toEqual(reads[0]);
  expect(reads[0].artifactVersionId).toBe('artifact:accept-api-contract-v2');
  expect(reads[0].spaceId).toBe('team-a');
  expect(reads[0]).not.toHaveProperty('expectedArtifactVersion');
});

test('upstream content: close aborts a held read; its late reply cannot replace a new open', async ({
  page,
}) => {
  await open(page, 'submit', true);
  await page.evaluate(() => {
    window.upstreamProbe.holdContent = true;
    window.upstreamProbe.contentText = '不得显示的迟到正文';
  });
  await disclosure(page).locator('summary').click();
  await expect(sources(page).getByRole('status')).toHaveText('正在读取…');
  const old = await heldContentRead(page);
  await disclosure(page).locator('summary').click();
  // Native toggle is asynchronous. An absent body during loading does not prove cleanup.
  await expect(disclosure(page)).not.toHaveAttribute('open', '');
  await expect(disclosure(page).locator('summary')).toHaveText('查看内容');
  await expect(disclosure(page).locator('[role="status"]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((index) => window.upstreamProbe.calls[index].signal.aborted, old))
    .toBe(true);
  await expect(body(page)).toHaveCount(0);
  await page.evaluate(() => {
    window.upstreamProbe.holdContent = false;
    window.upstreamProbe.contentText = '本次授权读取的正文';
  });
  await disclosure(page).locator('summary').click();
  await expect(body(page)).toHaveText('本次授权读取的正文');
  await page.evaluate((index) => window.upstreamProbe.complete(index), old);
  await expect(body(page)).toHaveText('本次授权读取的正文');
});

test('upstream content: refreshed hidden source removes open content and late reads while preserving draft', async ({
  page,
}) => {
  await open(page, 'submit', true);
  await draft(page).fill('保留当前工作');
  await page.evaluate(() => {
    window.upstreamProbe.holdContent = true;
    window.upstreamProbe.contentText = '旧来源正文';
  });
  await disclosure(page).locator('summary').click();
  await expect(sources(page).getByRole('status')).toHaveText('正在读取…');
  const old = await heldContentRead(page);
  await page.evaluate(() => {
    window.upstreamProbe.node.inputs = [
      { access: 'hidden', blocking: true, count: 1, message: '来源已不可访问。' },
    ];
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(sources(page)).toContainText('来源已不可访问');
  await expect(sources(page).locator('details')).toHaveCount(0);
  await page.evaluate((index) => window.upstreamProbe.complete(index), old);
  await expect(sources(page)).not.toContainText('旧来源正文');
  await expect(draft(page)).toHaveValue('保留当前工作');
});

test('upstream content: an old API read cannot leak into a replacement session', async ({
  page,
}) => {
  await open(page, 'submit', true);
  await page.evaluate(() => {
    window.upstreamProbe.holdContent = true;
    window.upstreamProbe.contentText = '旧账号资料';
  });
  await disclosure(page).locator('summary').click();
  await expect(sources(page).getByRole('status')).toHaveText('正在读取…');
  const oldIndex = await heldContentRead(page);
  await page.evaluate((index) => {
    const old = window.upstreamProbe;
    window.oldUpstream = old;
    old.oldIndex = index;
    old.replaceSession();
  }, oldIndex);
  await expect(sources(page)).toHaveCount(0);
  await page.getByRole('button', { name: '提交产物', exact: true }).click();
  await draft(page).fill('新会话工作');
  await page.evaluate(() => window.oldUpstream.complete(window.oldUpstream.oldIndex));
  await expect(sources(page)).not.toContainText('旧账号资料');
  await expect(body(page)).toHaveCount(0);
  await expect(draft(page)).toHaveValue('新会话工作');
});

test('upstream content: refreshed node generation closes an old read without replacing the draft', async ({
  page,
}) => {
  await open(page, 'submit', true);
  await draft(page).fill('当前交付内容');
  await page.evaluate(() => {
    window.upstreamProbe.holdContent = true;
    window.upstreamProbe.contentText = '旧节点世代正文';
  });
  await disclosure(page).locator('summary').click();
  await expect(sources(page).getByRole('status')).toHaveText('正在读取…');
  const old = await heldContentRead(page);
  await page.evaluate(() => {
    window.upstreamProbe.node.version += 1;
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(disclosure(page)).not.toHaveAttribute('open', '');
  await page.evaluate((index) => window.upstreamProbe.complete(index), old);
  await expect(body(page)).toHaveCount(0);
  await expect(sources(page)).not.toContainText('旧节点世代正文');
  await expect(draft(page)).toHaveValue('当前交付内容');
});

test('upstream content: native disclosure and scrollable text remain keyboard accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await page.evaluate(() => {
    window.upstreamProbe.contentText = '很长的中文来源内容'.repeat(1000);
  });
  const icon = disclosure(page).locator('summary .zm-control-icon svg path');
  await expect(icon).toHaveCount(1);
  const closedDirection = await icon.getAttribute('transform');
  await disclosure(page).locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeVisible();
  await expect(icon).not.toHaveAttribute('transform', closedDirection);
  await body(page).focus();
  await expect(body(page)).toBeFocused();
  expect(await body(page).evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await draft(page).fill('仍可编辑');
  await expect(draft(page)).toHaveValue('仍可编辑');
});
