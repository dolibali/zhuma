import { test, expect } from '@playwright/test';

for (const width of [1320, 1024]) {
  test(`run fields and secondary CLI menu preserve geometry, dialog focus and model values at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 860 });
    await page.goto('/?run-config-probe&strict');
    await page.getByRole('button', { name: '使用 Agent', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '运行配置契约', exact: true });
    await expect(dialog.getByRole('combobox', { name: '选择模型', exact: true })).toBeEnabled();
    const fields = dialog.locator('.zm-native-run__choice');
    const boxes = await fields.evaluateAll((nodes) =>
      nodes.slice(0, 3).map((node) => {
        const label = node.querySelector(':scope > span').getBoundingClientRect();
        const control = node.querySelector('button').getBoundingClientRect();
        return { labelTop: label.top, controlTop: control.top, height: control.height };
      }),
    );
    expect(boxes).toHaveLength(3);
    for (const key of ['labelTop', 'controlTop', 'height'])
      expect(
        Math.max(...boxes.map((b) => b[key])) - Math.min(...boxes.map((b) => b[key])),
      ).toBeLessThan(1);
    await expect(fields.getByRole('button', { name: '配置码道', exact: true })).toHaveCount(0);
    await expect(fields.getByRole('button', { name: '更多', exact: true })).toHaveCount(0);
    const more = dialog.getByRole('button', { name: '更多', exact: true });
    await more.focus();
    await page.keyboard.press('Enter');
    const settings = dialog.getByRole('menuitem', { name: 'CLI 设置', exact: true });
    await expect(settings).toBeVisible();
    await expect(settings).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(dialog).toBeVisible();
    await more.click();
    await dialog.getByText('模型', { exact: true }).click();
    await expect(settings).toHaveCount(0);
    await more.click();
    await settings.click();
    const setup = page.getByRole('dialog', { name: '配置码道', exact: true });
    await expect(setup).toBeVisible();
    expect(await setup.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    const command = '/fixture/cli with spaces';
    await setup.getByLabel('码道命令', { exact: true }).fill(command);
    await setup.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(setup).toHaveCount(0);
    await expect(more).toBeFocused();
    expect(await page.evaluate(() => window.runConfigFixture.commands)).toEqual([command]);
    await dialog.getByRole('combobox', { name: '选择模型', exact: true }).click();
    await expect(dialog.getByRole('option', { name: '码道 CLI', exact: true })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /CodeArts|继承码道/ })).toHaveCount(0);
    await dialog.getByRole('option', { name: '码道 CLI', exact: true }).click();
    await expect(dialog.locator('.zm-native-run__config-values')).toContainText('码道 CLI');
    await dialog.getByRole('button', { name: '开始执行', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.runConfigFixture.starts.length)).toBe(1);
    expect(await page.evaluate(() => window.runConfigFixture.starts[0].model)).toEqual({
      provider: 'acp-zhuma-codearts',
      model: 'inherited',
      maxTokens: 4096,
    });
    await expect(dialog).toBeVisible();
  });
}

test('CLI settings remain reachable before any model selection or CLI registration', async ({
  page,
}) => {
  await page.goto('/?run-config-probe&strict&unconfigured');
  await page.getByRole('button', { name: '使用 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '运行配置契约', exact: true });
  await expect(dialog.getByRole('combobox', { name: '选择模型', exact: true })).toBeDisabled();
  const more = dialog.getByRole('button', { name: '更多', exact: true });
  await more.click();
  await dialog.getByRole('menuitem', { name: 'CLI 设置', exact: true }).click();
  const setup = page.getByRole('dialog', { name: '配置码道', exact: true });
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: '取消', exact: true }).click();
  await expect(setup).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(await page.evaluate(() => window.runConfigFixture.commands)).toEqual([]);
  expect(await page.evaluate(() => window.runConfigFixture.starts)).toEqual([]);
});
