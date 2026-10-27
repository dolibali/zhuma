import { test, expect } from './replay.mjs';
const trigger = (page, name) => page.getByLabel(name, { exact: true });
const popup = (page) => page.locator('.zm-select-popup');
async function withinViewport(page) {
  // Resize and floating-position updates settle separately. Sample both geometries
  // in the same renderer turn, retaining every edge check while waiting for layout.
  await expect
    .poll(
      () =>
        popup(page).evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            visible: box.width > 0 && box.height > 0,
            left: box.left >= 0,
            top: box.top >= 0,
            right: box.right <= innerWidth,
            bottom: box.bottom <= innerHeight,
          };
        }),
      { timeout: 2000, message: '菜单应在重新定位后完整保留在当前可视区内' },
    )
    .toEqual({ visible: true, left: true, top: true, right: true, bottom: true });
}
function manyProjects(replay) {
  replay.state.projects.push(
    ...Array.from({ length: 24 }, (_, i) => ({
      id: `project-${i}`,
      name: `跨区域企业采购与订单结算项目 ${i + 1} · 长中文目录`,
      description: '',
    })),
  );
}

test('项目菜单真实展开、搜索与选择；不同可视区不越界', async ({ page, replay }) => {
  manyProjects(replay);
  await page.goto('/');
  for (const zoom of [1, 1.25, 2]) {
    await page.setViewportSize({ width: Math.round(1440 / zoom), height: Math.round(900 / zoom) });
    const project = trigger(page, '筛选项目');
    await project.click();
    await expect(popup(page)).toBeVisible();
    await withinViewport(page);
    const a = await project.boundingBox(),
      b = await popup(page).boundingBox();
    // A wider menu at the right edge may shift inward to remain visible.
    expect(b.x).toBeLessThanOrEqual(a.x + 2);
    expect(b.x + b.width).toBeGreaterThanOrEqual(a.x + a.width - 2);
    // Floating UI may round the nominal 4px offset to a fractional CSS pixel.
    const nominalGap = 4,
      pixelTolerance = 0.5;
    const gap = b.y - a.y - a.height;
    expect(gap).toBeGreaterThanOrEqual(nominalGap - pixelTolerance);
    expect(gap).toBeLessThanOrEqual(nominalGap + pixelTolerance);
    expect(b.width).toBeGreaterThanOrEqual(a.width);
    expect(await popup(page).evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      await project.evaluate((el) => getComputedStyle(el).fontSize),
    );
    await trigger(page, '搜索筛选项目').fill('项目 24');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option').click();
    await expect(project).toContainText('项目 24');
    await expect(popup(page)).toBeHidden();
    await expect(project).toBeFocused();
    await project.click();
    await trigger(page, '搜索筛选项目').fill('没有这样的项目');
    await expect(page.getByText('没有匹配选项', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popup(page)).toBeHidden();
    await expect(project).toBeFocused();
  }
  expect(replay.requests.filter((r) => r.endpoint !== 'snapshot')).toHaveLength(0);
});

test('外观菜单键盘选择、取消和外部关闭不保存任务，菜单跟随主题与窗口', async ({ page, replay }) => {
  await page.goto('/');
  const appearance = trigger(page, '外观');
  await appearance.focus();
  await page.keyboard.press('ArrowDown');
  await expect(popup(page)).toBeVisible();
  await page.getByRole('option', { name: '深色', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-ds-dark-theme', '');
  await appearance.click();
  await expect(popup(page)).toHaveCSS('background-color', 'rgb(36, 39, 45)');
  await page.setViewportSize({ width: 720, height: 600 });
  await withinViewport(page);
  await page.keyboard.press('Escape');
  await expect(appearance).toBeFocused();
  await appearance.click();
  await page.getByRole('heading', { name: '任务清单', exact: true }).click();
  await expect(popup(page)).toBeHidden();
  expect(replay.requests.filter((r) => r.endpoint !== 'snapshot')).toHaveLength(0);
});

test('创建弹窗内项目菜单可操作，Esc只关闭菜单，选择不提交也不丢目标', async ({ page, replay }) => {
  manyProjects(replay);
  await page.setViewportSize({ width: 720, height: 600 });
  await page.goto('/');
  await page.getByRole('button', { name: '＋ 创建任务', exact: true }).click();
  await trigger(page, '任务目标').fill('保留中的目标');
  const project = trigger(page, '所属项目');
  await project.click();
  await expect(popup(page)).toBeVisible();
  await withinViewport(page);
  await expect(page.getByRole('dialog').locator('.zm-select-popup')).toHaveCount(1);
  await trigger(page, '搜索所属项目').fill('项目 24');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(project).toContainText('项目 24');
  await expect(popup(page)).toBeHidden();
  await project.click();
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup(page)).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(project).toBeFocused();
  await expect(trigger(page, '任务目标')).toHaveValue('保留中的目标');
  expect(replay.requests.filter((r) => r.endpoint !== 'snapshot')).toHaveLength(0);
});

test('靠窗底右侧自动向上避让；禁用项不可提交，Enter选择，Tab离开', async ({ page }) => {
  await page.goto('/?select-probe=1');
  const select = trigger(page, '边界选择');
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await expect(popup(page)).toBeVisible();
  await withinViewport(page);
  const a = await select.boundingBox(),
    b = await popup(page).boundingBox();
  expect(b.y + b.height).toBeLessThan(a.y);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(trigger(page, '当前值')).toHaveText('last');
  await expect(select).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(popup(page)).toBeVisible();
  await expect(page.getByRole('option', { name: /第三项/ })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('option', { name: '第一项', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: '暂不可用', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trigger(page, '当前值')).toHaveText('last');
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: /第三项/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trigger(page, '当前值')).toHaveText('last');
  await expect(popup(page)).toBeHidden();
  await select.click();
  await expect(popup(page)).toBeVisible();
  await expect(page.getByRole('option', { name: /第三项/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(popup(page)).toBeHidden();
  await expect(page.getByRole('button', { name: '后一项', exact: true })).toBeFocused();
});
