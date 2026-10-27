import { test, expect } from '@playwright/test';

const button = (page, label) =>
  page.locator('button').filter({
    has: page.locator('.zm-button-label').filter({ hasText: new RegExp(`^${label}$`) }),
  });
const panel = (page) => page.getByRole('region', { name: '上游输入', exact: true });
const input = (page) => page.getByLabel('产物正文', { exact: true });
const submitLabel = (mode) => (mode === 'revise' ? '重新提交' : '提交产物');
const submitButton = (page, mode = 'submit') =>
  button(page, submitLabel(mode)).and(page.locator('.zm-execution-detail button'));
async function open(page, mode) {
  await page.goto(`/?upstream-client&strict&upstream-mode=${mode}`);
  await button(page, mode === 'revise' ? '提交新版本' : '提交产物').click();
  await expect(panel(page)).toContainText('确认订单接口与错误码');
  await expect(page.locator('.zm-draft-status')).toHaveText('尚未保存草稿');
}
async function refresh(page, held = false) {
  await button(page, '刷新').click();
  if (held) await expect(button(page, '刷新')).toBeDisabled();
  else await expect(button(page, '刷新')).toBeEnabled();
}

for (const mode of ['submit', 'revise']) {
  test(`upstream ${mode}: normal entry shows fixed source metadata and pending hints; read and refresh never write`, async ({
    page,
  }) => {
    await open(page, mode);
    await expect(panel(page)).toContainText('api-contract');
    await expect(panel(page)).toContainText('第 2 版');
    await expect(panel(page)).toContainText('help-copy 尚无已接受版本');
    await expect(panel(page)).toContainText('引用的版本已被取代');
    await expect(submitButton(page, mode)).toBeEnabled();
    await expect(panel(page).locator('a, button, iframe')).toHaveCount(0);
    await input(page).fill('保留这段正在编辑的内容');
    await refresh(page);
    await expect(panel(page)).toContainText('确认订单接口与错误码');
    await expect(input(page)).toHaveValue('保留这段正在编辑的内容');
    expect(
      await page.evaluate(() =>
        window.upstreamProbe.calls.some((call) => /submit|ballot|start-plan/.test(call.endpoint)),
      ),
    ).toBe(false);
  });

  test(`upstream ${mode}: refreshed hidden projection stays anonymous, blocks submit and preserves the draft`, async ({
    page,
  }) => {
    await open(page, mode);
    await input(page).fill('已有交付草稿');
    await page.evaluate(() => {
      window.upstreamProbe.node.inputs = [
        {
          access: 'hidden',
          blocking: true,
          count: 2,
          message: '有 2 个上游来源你没有权限查看。',
          sourceNodeId: 'sealed-node',
          taskId: 'sealed-task',
          spaceId: 'sealed-space',
          sourceGoal: 'sealed-goal',
          name: 'sealed-artifact',
          version: 99,
          text: 'sealed-body',
        },
      ];
    });
    await refresh(page);
    await expect(panel(page)).toContainText('2 个受限来源');
    await expect(panel(page)).toContainText('有 2 个上游来源你没有权限查看。');
    await expect(panel(page)).not.toContainText('sealed-');
    expect(await panel(page).evaluate((element) => element.outerHTML.includes('sealed-'))).toBe(
      false,
    );
    await expect(submitButton(page, mode)).toBeDisabled();
    await expect(input(page)).toHaveValue('已有交付草稿');
    expect(
      await page.evaluate(
        () => window.upstreamProbe.calls.filter((call) => call.endpoint.endsWith('/submit')).length,
      ),
    ).toBe(0);
    await page.evaluate(() => {
      window.upstreamProbe.node.inputs = [];
    });
    await refresh(page);
    await expect(panel(page)).toContainText('没有上游输入。');
    await expect(submitButton(page, mode)).toBeEnabled();
    await expect(input(page)).toHaveValue('已有交付草稿');
  });
}

test('upstream missing projection differs from empty; malformed refresh is an error and preserves input', async ({
  page,
}) => {
  await open(page, 'submit');
  await input(page).fill('继续修改');
  await page.evaluate(() => {
    delete window.upstreamProbe.node.inputs;
  });
  await refresh(page);
  await expect(panel(page)).toContainText('上游输入尚未返回');
  await expect(panel(page)).not.toContainText('没有上游输入。');
  await page.evaluate(() => {
    window.upstreamProbe.node.inputs = [{ access: 'unknown', blocking: false }];
  });
  await refresh(page);
  await expect(page.getByRole('alert')).toContainText('上游可见状态不正确');
  await expect(input(page)).toHaveValue('继续修改');
  await expect(panel(page)).not.toContainText('没有上游输入。');
});

test('upstream only service blocking controls submission, and the write still accepts a fresh service denial', async ({
  page,
}) => {
  await open(page, 'submit');
  await page.evaluate(() => {
    window.upstreamProbe.node.inputs[0].blocking = true;
  });
  await refresh(page);
  await expect(submitButton(page)).toBeDisabled();
  await page.evaluate(() => {
    window.upstreamProbe.node.inputs[0].blocking = false;
    window.upstreamProbe.denySubmit = true;
  });
  await refresh(page);
  await expect(submitButton(page)).toBeEnabled();
  await input(page).fill('明确提交的正文');
  await submitButton(page).click();
  await expect(page.getByRole('alert')).toContainText('上游来源已不可用');
  await expect(input(page)).toHaveValue('明确提交的正文');
  const commands = await page.evaluate(() =>
    window.upstreamProbe.calls
      .filter((call) => call.endpoint.endsWith('/submit'))
      .map((call) => call.payload),
  );
  expect(commands).toHaveLength(1);
  expect(commands[0]).not.toHaveProperty('inputs');
  expect(commands[0]).not.toHaveProperty('actorId');
});

test('upstream a held refresh from an old API cannot leak source data into the replacement session', async ({
  page,
}) => {
  await open(page, 'submit');
  await input(page).fill('旧会话内容');
  await page.evaluate(() => {
    window.upstreamProbe.holdInbox = true;
    window.upstreamProbe.node.inputs[0].sourceGoal = '旧上下文来源';
  });
  await refresh(page, true);
  await page.evaluate(() => {
    const c = window.upstreamProbe;
    window.oldUpstream = c;
    c.oldIndex = c.calls.length - 1;
    c.replaceSession();
  });
  await expect(panel(page)).toHaveCount(0);
  await button(page, '提交产物').click();
  await expect(panel(page)).toContainText('确认订单接口与错误码');
  await expect(input(page)).toHaveValue('');
  await input(page).fill('新会话内容');
  await page.evaluate(() => window.oldUpstream.complete(window.oldUpstream.oldIndex));
  await expect(panel(page)).not.toContainText('旧上下文来源');
  await expect(input(page)).toHaveValue('新会话内容');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('upstream metadata wraps in a narrow viewport and keyboard editing stays available', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await open(page, 'submit');
  await page.evaluate(() => {
    window.upstreamProbe.node.inputs[0].sourceGoal = 'LongSource'.repeat(30);
  });
  await refresh(page);
  await expect(panel(page)).toContainText('LongSource');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await input(page).focus();
  await page.keyboard.type('仍可填写');
  await expect(input(page)).toHaveValue('仍可填写');
});
