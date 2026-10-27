import { test, expect } from '@playwright/test';
// Shared Button changes its accessible name while busy. Its original label stays
// in the label span, so locate that stable control rather than a loading caption.
const button = (page, name) =>
  page
    .locator('button')
    .filter({
      has: page.locator('.zm-button-label').filter({ hasText: new RegExp(`^${name}$`) }),
    })
    .or(page.getByRole('button', { name, exact: true }));
const probe = (page, callback) => page.evaluate(callback);
async function setup(page, mode) {
  await page.goto(`/?execution-client=1${mode ? `&execution-form=${mode}` : ''}&strict=1`);
  await page.waitForFunction(() => window.executionProbe);
  if (mode === 'delivery')
    await expect(page.locator('.zm-draft-status')).toHaveText('尚未保存草稿');
}
async function hold(page) {
  await probe(page, () => {
    window.executionProbe.hold = true;
  });
}
async function finish(page, outcome = 'success') {
  await page.evaluate((value) => window.executionProbe.complete(0, value), outcome);
}

test('only an explicit start dispatches; repeated clicks and retry reuse the same request', async ({
  page,
}) => {
  await setup(page);
  await expect(button(page, '提交评审')).toBeVisible();
  await button(page, '刷新').click();
  expect(
    await probe(
      page,
      () =>
        window.executionProbe.calls.filter((call) => call.endpoint.endsWith('/start-plan')).length,
    ),
  ).toBe(0);
  await hold(page);
  await button(page, '开始执行').dblclick({ force: true });
  await expect(button(page, '开始执行')).toBeDisabled();
  const startCount = () =>
    probe(
      page,
      () =>
        window.executionProbe.calls.filter((call) => call.endpoint.endsWith('/start-plan')).length,
    );
  expect(await startCount()).toBe(1);
  await probe(page, () => {
    const index = window.executionProbe.calls.findIndex((call) =>
      call.endpoint.endsWith('/start-plan'),
    );
    window.executionProbe.complete(index, 'reject');
  });
  await expect(page.getByRole('alert')).toHaveText('请求未完成，请重试。');
  await button(page, '开始执行').click();
  expect(await startCount()).toBe(2);
  const keys = await probe(page, () =>
    window.executionProbe.calls
      .filter((call) => call.endpoint.endsWith('/start-plan'))
      .map((call) => call.payload.idempotencyKey),
  );
  expect(keys[0]).toBe(keys[1]);
  await page.reload();
  expect(await startCount()).toBe(0);
});

for (const axis of ['task', 'plan', 'revision', 'node', 'round']) {
  for (const outcome of ['success', 'failure', 'reject']) {
    test(`review ${axis} switch ignores old ${outcome}, including finally`, async ({ page }) => {
      await setup(page, 'review');
      await hold(page);
      const input = page.getByLabel('评审意见', { exact: true });
      await input.fill('旧工作意见');
      await button(page, '退回修改').click();
      await button(page, `切换 ${axis}`).click();
      await expect(input).toHaveValue('');
      await input.fill('新工作意见');
      await button(page, '提交评论').click();
      await finish(page, outcome);
      await expect(input).toHaveValue('新工作意见');
      await expect(button(page, '通过')).toBeDisabled();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await probe(page, () => window.executionProbe.events.length)).toBe(0);
      expect(await probe(page, () => window.executionProbe.calls[0].signal.aborted)).toBe(true);
      await probe(page, () => window.executionProbe.complete(1));
      await expect(input).toHaveValue('');
      expect(await probe(page, () => window.executionProbe.events.length)).toBe(1);
    });
  }
}

test('review unmount and return to the same item cannot revive an old receipt', async ({
  page,
}) => {
  await setup(page, 'review');
  await hold(page);
  await page.getByLabel('评审意见').fill('旧意见');
  await button(page, '通过').click();
  await button(page, '卸载执行页').click();
  await button(page, '重新打开执行页').click();
  await page.getByLabel('评审意见').fill('重新打开后的意见');
  await finish(page);
  await expect(page.getByLabel('评审意见')).toHaveValue('重新打开后的意见');
  expect(await probe(page, () => window.executionProbe.events.length)).toBe(0);
});

test('delivery inputs and pending state are isolated across plan changes', async ({ page }) => {
  await setup(page, 'delivery');
  await hold(page);
  await page.getByLabel('产物正文', { exact: true }).fill('旧产物');
  await button(page, '提交产物').click();
  await button(page, '切换 plan').click();
  await page.getByLabel('产物正文', { exact: true }).fill('新产物');
  await finish(page, 'failure');
  await expect(page.getByLabel('产物正文', { exact: true })).toHaveValue('新产物');
  await expect(button(page, '提交产物')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('late inbox replies cannot replace a newer refresh or survive unmount', async ({ page }) => {
  await setup(page);
  await expect(button(page, '提交评审')).toBeVisible();
  await probe(page, () => {
    window.executionProbe.holdInbox = true;
  });
  await button(page, '刷新').click();
  // Start completion also requests inbox; it must supersede the still-pending read.
  await button(page, '开始执行').click();
  await page.waitForFunction(
    () =>
      window.executionProbe.calls.filter((call) => call.endpoint.endsWith('/inbox')).length >= 4,
  );
  await probe(page, () => {
    const reads = window.executionProbe.calls.filter(
      (call) => call.resolve && call.endpoint.endsWith('/inbox'),
    );
    reads.at(-1).response.value.nodes[0].goal = '最新工作';
    reads.at(-1).resolve(reads.at(-1).response);
    reads[0].resolve(reads[0].response);
  });
  await expect(page.getByText('最新工作', { exact: true })).toBeVisible();
  await button(page, '刷新').click();
  await button(page, '卸载执行页').click();
  await probe(page, () => {
    const call = window.executionProbe.calls.at(-1);
    call.reject(Error('late'));
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('switching selected work preserves the current delivery when an old review finishes', async ({
  page,
}) => {
  await setup(page);
  await hold(page);
  await button(page, '提交评审').click();
  await page.getByLabel('评审意见', { exact: true }).fill('旧评审');
  await button(page, '通过').click();
  await button(page, '提交产物').click();
  await page.getByLabel('产物正文', { exact: true }).fill('当前交付正文');
  await probe(page, () => {
    const index = window.executionProbe.calls.findIndex((call) =>
      call.endpoint.endsWith('/ballot'),
    );
    window.executionProbe.complete(index);
  });
  await expect(page.getByLabel('产物正文', { exact: true })).toHaveValue('当前交付正文');
  await expect(page.getByLabel('评审意见', { exact: true })).toHaveCount(0);
});

test('changing the API session resets input and fences the previous session receipt', async ({
  page,
}) => {
  await setup(page, 'review');
  await hold(page);
  await page.getByLabel('评审意见', { exact: true }).fill('上一会话意见');
  await button(page, '通过').click();
  await probe(page, () => {
    window.oldExecutionProbe = window.executionProbe;
  });
  await button(page, '更换 API 会话').click();
  await expect(page.getByLabel('评审意见', { exact: true })).toHaveValue('');
  await hold(page);
  await page.getByLabel('评审意见', { exact: true }).fill('当前会话意见');
  await button(page, '提交评论').click();
  await probe(page, () => window.oldExecutionProbe.complete(0));
  await expect(page.getByLabel('评审意见', { exact: true })).toHaveValue('当前会话意见');
  await expect(button(page, '通过')).toBeDisabled();
  expect(await probe(page, () => window.executionProbe.events.length)).toBe(0);
});

function contrastRatio(foreground, background) {
  function luminance(color) {
    const rgb = color.match(/^rgba?\(([^)]+)\)$/);
    expect(rgb, `Expected an opaque computed RGB color, got ${color}`).not.toBeNull();
    const channels = rgb[1]
      .split(',')
      .slice(0, 3)
      .map((value) => Number(value.trim()) / 255);
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('artifact links have readable theme colors, underlines and a keyboard focus ring', async ({
  page,
}) => {
  await setup(page, 'review');
  const link = page.getByRole('link', { name: 'https://example.com/design', exact: true });
  const styles = () =>
    link.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        background: getComputedStyle(element.closest('.zm-execution-artifact')).backgroundColor,
        decoration: style.textDecorationLine,
        thickness: style.textDecorationThickness,
        outline: style.outlineStyle,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
      };
    });
  for (const state of ['normal', 'hover', 'keyboard']) {
    if (state === 'hover') await link.hover();
    if (state === 'keyboard') {
      await page.mouse.move(0, 0);
      await link.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(link).toBeFocused();
    }
    const style = await styles();
    expect(
      contrastRatio(style.color, style.background),
      `${state} link text contrast`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(style.decoration).toContain('underline');
    if (state === 'keyboard') {
      expect(style.outline).not.toBe('none');
      expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
      expect(Number.parseFloat(style.outlineOffset)).toBeGreaterThanOrEqual(2);
      expect(contrastRatio(style.outlineColor, style.background)).toBeGreaterThanOrEqual(3);
    }
  }
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('href', 'https://example.com/design');
});

async function refreshedRound(page) {
  await probe(page, () => {
    const control = window.executionProbe;
    const node = control.nodes[0];
    control.nodes[0] = {
      ...node,
      version: 3,
      currentRoundId: 'round-2',
      artifacts: [...node.artifacts, { id: 'artifact-2', version: 2, text: '第二轮当前产物' }],
      rounds: [
        ...node.rounds,
        { ...node.rounds[0], id: 'round-2', artifactVersionId: 'artifact-2', ballots: [] },
      ],
    };
  });
  await button(page, '刷新').click();
  await expect(page.getByText('第二轮当前产物', { exact: true })).toBeVisible();
  await expect(page.getByLabel('评审意见', { exact: true })).toHaveValue('');
}
const readCount = (page) =>
  probe(
    page,
    () => window.executionProbe.calls.filter((call) => call.endpoint.endsWith('/inbox')).length,
  );
async function finishBallot(page, index, outcome = 'success') {
  await page.evaluate(
    ({ ballotIndex, result }) => {
      const control = window.executionProbe;
      const call = control.calls.filter((call) => call.endpoint.endsWith('/ballot'))[ballotIndex];
      control.complete(control.calls.indexOf(call), result);
    },
    { ballotIndex: index, result: outcome },
  );
}
async function expectClosedAndRefreshed(page, previousReads) {
  await expect(page.getByLabel('评审意见', { exact: true })).toHaveCount(0);
  await expect.poll(() => readCount(page)).toBe(previousReads + 1);
}

test('a newly presented review round can submit and refresh after inbox changes the original selection', async ({
  page,
}) => {
  await setup(page);
  await button(page, '提交评审').click();
  await refreshedRound(page);
  await hold(page);
  await page.getByLabel('评审意见', { exact: true }).fill('当前轮次意见');
  const previousReads = await readCount(page);
  await button(page, '提交评论').click();
  const payload = await probe(page, () => window.executionProbe.calls.at(-1).payload);
  expect(payload).toMatchObject({
    roundId: 'round-2',
    artifactVersionId: 'artifact-2',
    expectedVersion: 3,
    comment: '当前轮次意见',
  });
  await finishBallot(page, 0);
  await expectClosedAndRefreshed(page, previousReads);
});

for (const outcome of ['success', 'failure', 'reject']) {
  test(`a refreshed workspace ignores the previous round ${outcome} and accepts the current round receipt`, async ({
    page,
  }) => {
    await setup(page);
    await button(page, '提交评审').click();
    await hold(page);
    const input = page.getByLabel('评审意见', { exact: true });
    await input.fill('上一轮意见');
    await button(page, '提交评论').click();
    await refreshedRound(page);
    await input.fill('新轮次意见');
    await button(page, '提交评论').click();
    const previousReads = await readCount(page);
    await finishBallot(page, 0, outcome);
    await expect(input).toHaveValue('新轮次意见');
    await expect(button(page, '通过')).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await readCount(page)).toBe(previousReads);
    expect(
      await probe(
        page,
        () =>
          window.executionProbe.calls.filter((call) => call.endpoint.endsWith('/ballot'))[0].signal
            .aborted,
      ),
    ).toBe(true);
    await finishBallot(page, 1);
    await expectClosedAndRefreshed(page, previousReads);
  });
}
