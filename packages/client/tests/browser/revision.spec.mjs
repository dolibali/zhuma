import { test, expect } from '@playwright/test';

const button = (page, label) =>
  page.locator('button').filter({
    has: page.locator('.zm-button-label').filter({ hasText: new RegExp(`^${label}$`) }),
  });
const source = (page) => page.locator('.zm-revision-source');
const revisionCalls = (page) =>
  page.evaluate(
    () => window.revisionProbe.calls.filter((c) => c.endpoint.endsWith('/revision')).length,
  );
async function open(page, direct = false) {
  await page.goto(`/?revision-client&strict${direct ? '&revision-direct' : ''}`);
  if (!direct) await button(page, '提交新版本').click();
  await expect(source(page)).toContainText('增加 status 筛选');
  await expect(page.locator('.zm-draft-status')).toHaveText('尚未保存草稿');
}
async function finishLast(page, kind, outcome = 'success') {
  await page.evaluate(
    ({ kind, outcome }) => {
      const calls = window.revisionProbe.calls;
      const index = calls.findLastIndex((c) => c.endpoint.endsWith(`/${kind}`));
      window.revisionProbe.complete(index, outcome);
    },
    { kind, outcome },
  );
}

test('revision normal inbox entry reads the fixed returned version, history, citations and honest file metadata', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByRole('heading', { name: '退回意见', exact: true })).toBeVisible();
  await expect(source(page)).not.toContainText('不属于被退回轮次');
  await expect(page.locator('.zm-revision-notes')).toContainText('林夏');
  await expect(page.locator('.zm-revision-notes')).toContainText('质量专家');
  await expect(page.locator('.zm-revision-notes')).toContainText('comment-auth');
  const files = source(page).getByRole('list', { name: '附件', exact: true });
  await expect(files.getByRole('listitem')).toHaveCount(1);
  await expect(files).toContainText('2.3 KiB · text/markdown');
  await expect(files).toContainText('文件读取尚未接入');
  await expect(files).not.toContainText('file-contract-v2');
  await expect(files.getByRole('button')).toHaveCount(0);
  expect(
    await page
      .locator('.zm-revision a[download], .zm-revision iframe, .zm-revision a[href^="#comment"]')
      .count(),
  ).toBe(0);
  const payloads = await page.evaluate(() =>
    window.revisionProbe.calls
      .filter((c) => c.endpoint.endsWith('/revision'))
      .map((c) => c.payload),
  );
  expect(payloads.length).toBeGreaterThan(0);
  for (const payload of payloads)
    expect(Object.keys(payload).sort()).toEqual(['nodeId', 'planId', 'revision', 'taskId']);
  expect(
    await page.evaluate(() =>
      window.revisionProbe.calls.some((c) => /submit|start-plan|ballot/.test(c.endpoint)),
    ),
  ).toBe(false);
});

test('revision version picker and named history button show the referenced version and focus its content', async ({
  page,
}) => {
  await open(page);
  const select = page.getByRole('combobox', { name: '对照版本', exact: true });
  await select.click();
  await page.getByRole('option', { name: '上一版 · 第 1 版', exact: true }).click();
  await expect(source(page)).toContainText('接口初稿：GET /orders。');
  await expect(source(page)).not.toContainText('增加 status 筛选');
  await expect(source(page).getByRole('list', { name: '附件', exact: true })).toHaveCount(0);
  const currentNote = page.locator('.zm-revision-note').filter({ hasText: '林夏' });
  await currentNote.getByRole('button', { name: '查看引用版本', exact: true }).click();
  await expect(source(page)).toContainText('增加 status 筛选');
  await expect(source(page).getByRole('list', { name: '附件', exact: true })).toContainText(
    '2.3 KiB · text/markdown',
  );
  await expect(source(page).locator('article')).toBeFocused();
});

test('revision refresh and retry preserve editing input and never submit or clear the obligation', async ({
  page,
}) => {
  await open(page);
  const input = page.getByLabel('产物正文', { exact: true });
  await input.fill('正在修改权限错误码');
  await page.evaluate(() => {
    window.revisionProbe.holdReads = true;
  });
  await button(page, '刷新意见').click();
  await expect(page.getByText('正在读取被退回的版本和意见…', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('正在修改权限错误码');
  await finishLast(page, 'revision', 'failure');
  await expect(page.getByRole('alert')).toContainText('退回修改阶段');
  await expect(input).toHaveValue('正在修改权限错误码');
  await button(page, '重试读取').click();
  await finishLast(page, 'revision');
  await expect(source(page)).toContainText('增加 status 筛选');
  await expect(input).toHaveValue('正在修改权限错误码');
  expect(
    await page.evaluate(() =>
      window.revisionProbe.calls.some((c) => /submit|start-plan|ballot/.test(c.endpoint)),
    ),
  ).toBe(false);
  await expect(page.locator('.zm-directory-row')).toContainText('需修改');
});

for (const outcome of ['success', 'failure', 'reject']) {
  test(`revision replacement round discards old read ${outcome} while retaining same-node input`, async ({
    page,
  }) => {
    await open(page, true);
    const input = page.getByLabel('产物正文', { exact: true });
    await input.fill('保留我的修改');
    const before = await revisionCalls(page);
    await page.evaluate(() => {
      window.revisionProbe.holdReads = true;
    });
    await button(page, '刷新意见').click();
    await expect.poll(() => revisionCalls(page)).toBe(before + 1);
    const oldIndex = await page.evaluate(() => window.revisionProbe.calls.length - 1);
    await page.evaluate(() => {
      const c = window.revisionProbe;
      c.view.reviewed.text = '新轮次固定正文';
      c.update({
        ...c.node,
        version: c.node.version + 1,
        currentRoundId: 'new-return-round',
        rounds: [{ ...c.node.rounds[0], id: 'new-return-round' }],
      });
    });
    // StrictMode replays a newly mounted reader's effect; only its last read may apply.
    await expect.poll(() => revisionCalls(page)).toBeGreaterThan(before + 1);
    await finishLast(page, 'revision');
    await expect(source(page)).toContainText('新轮次固定正文');
    await page.evaluate(
      ({ oldIndex, outcome }) => window.revisionProbe.complete(oldIndex, outcome),
      { oldIndex, outcome },
    );
    await expect(source(page)).toContainText('新轮次固定正文');
    await expect(input).toHaveValue('保留我的修改');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('revision explicit resubmit sends one version-bound command and accepts its new round only on success', async ({
  page,
}) => {
  await open(page, true);
  await page.getByLabel('产物正文', { exact: true }).fill('补充401与403说明');
  await page.evaluate(() => {
    window.revisionProbe.holdSubmits = true;
  });
  await button(page, '重新提交').dblclick({ force: true });
  const submissions = await page.evaluate(() =>
    window.revisionProbe.calls.filter((c) => c.endpoint.endsWith('/submit')).map((c) => c.payload),
  );
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    taskId: 'task-orders',
    planId: 'plan-orders',
    revision: 1,
    nodeId: 'api-contract',
    expectedVersion: 5,
    text: '补充401与403说明',
    links: [],
  });
  expect(submissions[0].idempotencyKey).toBeTruthy();
  expect(await page.evaluate(() => window.revisionProbe.events.length)).toBe(0);
  await finishLast(page, 'submit');
  await expect(page.getByLabel('产物正文', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => window.revisionProbe.events[0].currentRoundId)).toBe(
    'resubmitted-round',
  );
});

for (const outcome of ['success', 'failure', 'reject']) {
  test(`revision late submit ${outcome} after same-node refresh preserves input and does not close the new context`, async ({
    page,
  }) => {
    await open(page, true);
    const input = page.getByLabel('产物正文', { exact: true });
    await input.fill('尚待核对的正文');
    await page.evaluate(() => {
      window.revisionProbe.holdSubmits = true;
    });
    await button(page, '重新提交').click();
    const before = await revisionCalls(page);
    await page.evaluate(() => {
      const c = window.revisionProbe;
      c.update({ ...c.node, version: c.node.version + 1 });
    });
    await expect.poll(() => revisionCalls(page)).toBeGreaterThan(before);
    await finishLast(page, 'submit', outcome);
    await expect(input).toHaveValue('尚待核对的正文');
    await expect(input).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => window.revisionProbe.events.length)).toBe(0);
  });
}

test('revision mismatch is retryable and does not substitute the latest inbox artifact', async ({
  page,
}) => {
  await open(page, true);
  await page.evaluate(() => {
    const c = window.revisionProbe;
    c.view.reviewed.id = 'different-returned-artifact';
  });
  await button(page, '刷新意见').click();
  await expect(page.getByRole('alert')).toContainText('退回版本已变化');
  await expect(page.locator('.zm-revision-source')).toHaveCount(0);
  await expect(button(page, '重新提交')).toBeEnabled();
});

for (const axis of ['taskId', 'planId', 'revision', 'nodeId', 'api']) {
  test(`revision ${axis} replacement clears old-context input and ignores an old read`, async ({
    page,
  }) => {
    await open(page, true);
    await page.getByLabel('产物正文', { exact: true }).fill('旧上下文输入');
    await page.evaluate(() => {
      window.revisionProbe.holdReads = true;
    });
    await button(page, '刷新意见').click();
    await page.evaluate((axis) => {
      const c = window.revisionProbe;
      window.oldRevisionProbe = c;
      c.oldIndex = c.calls.length - 1;
      if (axis === 'api') c.replaceSession();
      else {
        c.holdReads = false;
        c.update({
          ...c.node,
          [axis]: axis === 'revision' ? c.node.revision + 1 : `${c.node[axis]}-new`,
        });
      }
    }, axis);
    const input = page.getByLabel('产物正文', { exact: true });
    await expect(input).toHaveValue('');
    await input.fill('新上下文输入');
    await page.evaluate(() =>
      window.oldRevisionProbe.complete(window.oldRevisionProbe.oldIndex, 'failure'),
    );
    await expect(source(page)).toContainText('增加 status 筛选');
    await expect(input).toHaveValue('新上下文输入');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('revision responsive layout has no horizontal overflow and all controls remain keyboard reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await open(page, true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const select = page.getByRole('combobox', { name: '对照版本', exact: true });
  await select.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: '被退回 · 第 2 版', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: '上一版 · 第 1 版', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(source(page)).toContainText('接口初稿：GET /orders。');
  await page.getByLabel('产物正文', { exact: true }).focus();
  await page.keyboard.type('键盘修改');
  await expect(page.getByLabel('产物正文', { exact: true })).toHaveValue('键盘修改');
});
