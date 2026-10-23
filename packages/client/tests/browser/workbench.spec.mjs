import { emptyWorkbench } from '@zhuma/agent-core';
import { test, expect, deferred, failure, plannedWorkflows, proposal } from './replay.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const commands = (replay) => replay.requests.filter((r) => r.endpoint === 'command');
const plans = (replay) => replay.requests.filter((r) => r.endpoint === 'plan');
async function openTask(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
}
async function selectPeople(page, label, names) {
  await button(page, `选择${label}`).click();
  const dialog = page.getByRole('dialog', { name: `选择${label}`, exact: true });
  for (const name of names) {
    await dialog.getByLabel('搜索参与者', { exact: true }).fill(name);
    await dialog
      .locator('.zm-member')
      .filter({ has: page.getByText(name, { exact: true }) })
      .locator('input')
      .check();
  }
  await button(dialog, '确认选择').click();
}

test('创建任务、分工和多人评审配置可保存并在刷新后重开', async ({ page, replay }) => {
  await page.goto('/');
  await button(page, '＋ 创建任务').click();
  await page.getByLabel('任务名称', { exact: true }).fill('订单导出字段核对');
  await page.getByLabel('任务目标', { exact: true }).fill('明确字段和角色范围，再交付接口定义。');
  // Escape cancels the inner selection, without closing or changing the outer draft.
  await button(page, '选择任务负责人').click();
  await page.getByRole('dialog').last().getByLabel('搜索参与者').fill('陈宁');
  await page.getByRole('dialog').last().getByRole('radio').check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(button(page, '选择任务负责人')).not.toContainText('陈宁');
  await expect(page.getByLabel('任务名称', { exact: true })).toHaveValue('订单导出字段核对');
  await selectPeople(page, '任务负责人', ['陈宁']);
  await page.getByRole('radio', { name: '从空白开始' }).check();
  await button(page, '创建工作流').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('订单导出字段核对');
  await button(page, '＋ 节点').click();
  await page.getByLabel('节点名称', { exact: true }).fill('核对订单导出接口');
  await selectPeople(page, '执行者', ['陈宁']);
  await page.getByLabel('完成后需要评审', { exact: true }).check();
  await selectPeople(page, '评审人', ['质量专家', '林可']);
  await page.getByLabel('交付内容', { exact: true }).fill('字段清单与接口说明');
  await button(page, '保存草稿').click();
  await expect(button(page, '保存草稿')).toBeDisabled();
  expect(commands(replay)).toHaveLength(2);
  const task = replay.state.tasks.find((t) => t.title === '订单导出字段核对');
  expect(task.ownerId).toBe('chen');
  expect(task.workflows[0].nodes[0].reviewerIds).toEqual(['qa', 'lin']);
  await page.reload();
  await page.getByRole('button', { name: /^订单导出字段核对/ }).click();
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('核对订单导出接口');
  await expect(button(page, '选择执行者')).toContainText('陈宁');
  await expect(button(page, '选择评审人')).toContainText('质量专家、林可');
  await expect(page.getByLabel('交付内容', { exact: true })).toHaveValue('字段清单与接口说明');
});

test('主题切换保留节点草稿、选择和画布位置，不触发保存或规划', async ({ page, replay }) => {
  await openTask(page);
  await page.getByLabel('节点名称', { exact: true }).fill('尚未保存的节点修改');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  const transform = await page.locator('.react-flow__viewport').getAttribute('style');
  const before = replay.requests.length;
  for (const theme of ['dark', 'light', 'system']) {
    await page.getByLabel('外观', { exact: true }).click();
    const caption = { light: '浅色', dark: '深色', system: '跟随系统' }[theme];
    await page.getByRole('option', { name: caption, exact: true }).click();
    await expect(page.getByLabel('外观', { exact: true })).toHaveAttribute(
      'title',
      `外观：${caption}`,
    );
    await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('尚未保存的节点修改');
    await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', 'node-0');
    await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', transform);
    await expect(button(page, '保存草稿')).toBeEnabled();
  }
  expect(replay.requests).toHaveLength(before);
  expect(commands(replay)).toHaveLength(0);
  expect(plans(replay)).toHaveLength(0);
});

test('连续规划引用当前草案；失败、取消和迟到响应不丢失已审阅草案', async ({ page, replay }) => {
  replay.state.tasks[0].workflows[0].nodes = [];
  const original = plannedWorkflows();
  const revised = structuredClone(original);
  revised[0].nodes[2].assigneeId = 'chen';
  const gate = deferred();
  let calls = 0;
  replay.handlers.plan = async (payload) => {
    calls++;
    if (calls === 1) return proposal(payload, original);
    if (calls === 2) return proposal(payload, revised, '第三步已交给陈宁，其余不变。');
    if (calls === 3) return failure('unavailable', '规划暂时不可用，请重试。');
    await gate.promise;
    return proposal(payload, original, '取消后到达的旧响应');
  };
  try {
    await openTask(page);
    await button(page, '✧ AI 规划').click();
    await button(page, '生成工作流草案').click();
    await expect(button(page, '应用草案')).toBeEnabled();
    await expect(page.locator('.react-flow__node')).toHaveCount(10);
    const ids = await page
      .locator('.react-flow__node')
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.id));
    const edges = await page
      .locator('.react-flow__edge')
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.id));
    await page.getByLabel('补充要求', { exact: true }).fill('第三步换陈宁，其余不变。');
    await button(page, '重新规划').click();
    await expect(
      page.getByText('第三步已交给陈宁，其余不变。', { exact: true }).first(),
    ).toBeVisible();
    expect(plans(replay)[1].baseProposalId).toBe(plans(replay)[0].requestId);
    expect(
      await page
        .locator('.react-flow__node')
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.id)),
    ).toEqual(ids);
    expect(
      await page
        .locator('.react-flow__edge')
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.id)),
    ).toEqual(edges);
    await expect(page.locator('.react-flow__node[data-id="node-2"]')).toContainText('陈宁');
    await button(page, '重新规划').click();
    await expect(page.getByRole('alert')).toContainText('规划暂时不可用');
    await expect(page.locator('.react-flow__node')).toHaveCount(10);
    await expect(button(page, '应用草案')).toBeEnabled();
    await button(page, '重新规划').click();
    await expect.poll(() => calls).toBe(4);
    await expect(button(page, '应用草案')).toBeDisabled();
    await button(page, '取消').click();
    gate.resolve();
    await expect.poll(() => replay.completed.includes(plans(replay)[3].requestId)).toBe(true);
    await expect(button(page, '重新规划')).toBeEnabled();
    await expect(
      page.getByText('第三步已交给陈宁，其余不变。', { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText('取消后到达的旧响应', { exact: true })).toHaveCount(0);
    expect(
      plans(replay)
        .slice(2)
        .map((p) => p.baseProposalId),
    ).toEqual([plans(replay)[1].requestId, plans(replay)[1].requestId]);
    expect(commands(replay)).toHaveLength(0);
    await button(page, '应用草案').click();
    await expect(button(page, '应用草案')).toHaveCount(0);
    expect(commands(replay)).toHaveLength(1);
    expect(replay.state.tasks[0].workflows).toEqual(revised);
  } finally {
    gate.resolve();
  }
});

test('冲突提示关闭后仍能恢复；取消读取保留预览，确认读取更新版本', async ({ page, replay }) => {
  replay.state.tasks[0].workflows[0].nodes = [];
  let calls = 0;
  replay.handlers.plan = async (payload) =>
    ++calls === 1 ? proposal(payload) : failure('conflict', '工作流已被更新，请读取最新版本。');
  await openTask(page);
  await button(page, '✧ AI 规划').click();
  await button(page, '生成工作流草案').click();
  await expect(button(page, '应用草案')).toBeEnabled();
  await button(page, '重新规划').click();
  await expect(page.getByRole('alert')).toContainText('工作流已被更新');
  await button(page, '关闭错误').click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(button(page, '读取最新版本')).toBeVisible();
  await expect(button(page, '重新规划')).toBeDisabled();
  await expect(button(page, '应用草案')).toBeDisabled();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('未应用草案');
    await dialog.dismiss();
  });
  await button(page, '读取最新版本').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(10);
  replay.state.tasks[0].title = '同事更新后的订单任务';
  replay.state.revision++;
  page.once('dialog', (dialog) => dialog.accept());
  await button(page, '读取最新版本').click();
  await expect(button(page, '读取最新版本')).toHaveCount(0);
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('同事更新后的订单任务');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await expect(button(page, '生成工作流草案')).toBeEnabled();
  expect(commands(replay)).toHaveLength(0);
  expect(replay.snapshots).toBe(2);
});

test('目录筛选、长表单错误与保存中关闭保护；多选搜索保持勾选', async ({ page, replay }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^成员与专家/ }).click();
  await page.getByLabel('搜索成员与专家', { exact: true }).fill('不存在的名字');
  await button(page, '清除筛选').click();
  await expect(page.getByRole('article')).toHaveCount(26);
  await page.getByLabel('成员类型', { exact: true }).click();
  await page.getByRole('option', { name: 'Agent 专家', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await page.getByRole('button', { name: /^团队资产/ }).click();
  await page.getByLabel('搜索资产', { exact: true }).fill('01 版');
  await button(page.getByRole('article'), '编辑').click();
  await expect(button(page.getByRole('dialog'), '关闭')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('名称', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('类型', { exact: true })).toBeFocused();
  await page.getByLabel('定义内容', { exact: true }).fill('取消的草稿');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await button(page.getByRole('article'), '编辑').click();
  await expect(page.getByLabel('定义内容', { exact: true })).toHaveValue(
    replay.state.assets[0].content,
  );
  replay.handlers.command = async () => failure('unavailable', '保存暂时不可用。');
  await page.getByLabel('定义内容', { exact: true }).fill('失败后保留的草稿');
  await button(page, '保存').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('保存暂时不可用');
  await expect(page.getByLabel('定义内容', { exact: true })).toHaveValue('失败后保留的草稿');
  const gate = deferred();
  replay.handlers.command = async () => {
    await gate.promise;
    return failure('unavailable', '保存暂时不可用。');
  };
  try {
    await button(page, '保存').click();
    await expect(page.getByLabel('定义内容', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeVisible();
    gate.resolve();
    await expect(button(page, '保存')).toBeEnabled();
    await page.setViewportSize({ width: 720, height: 450 });
    const before = await button(page, '保存').boundingBox();
    await page
      .getByRole('dialog')
      .locator('.zm-form-body')
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    const after = await button(page, '保存').boundingBox();
    expect(after.y).toBe(before.y);
    expect(after.y + after.height).toBeLessThanOrEqual(450);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    gate.resolve();
  }
  await button(page, '取消').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /^任务清单/ }).click();
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
  await page.getByText('能力与依赖', { exact: false }).first().click();
  const picker = page.locator('.zm-multiselect').filter({ hasText: 'Skills' });
  await picker.locator('summary').click();
  await page.getByLabel('搜索Skills', { exact: true }).fill('02 版');
  await expect(picker.getByRole('checkbox')).toHaveCount(1);
  await picker.getByRole('checkbox').check();
  await page.getByLabel('搜索Skills', { exact: true }).fill('没有这个技能');
  await button(picker, '清除搜索').click();
  await expect(picker.locator('input:checked')).toHaveCount(2);
});

test('连接等待、失败重试和空目录均有可操作的入口', async ({ page, replay }) => {
  const gate = deferred();
  let calls = 0;
  replay.handlers.snapshot = async () => {
    if (++calls === 1) {
      await gate.promise;
      return failure('unavailable', '工作台暂时不可用。');
    }
    return { ok: true, value: { state: emptyWorkbench(), model: 'response-replay / no-model' } };
  };
  try {
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('正在连接工作台…');
    gate.resolve();
    await expect(page.getByRole('alert')).toHaveText('工作台暂时不可用。');
    await button(page, '重新连接').click();
    await expect(page.getByRole('heading', { name: '开始下一项工作' })).toBeVisible();
    await page.getByRole('button', { name: /^项目/ }).first().click();
    await expect(page.getByRole('heading', { name: '暂无项目' })).toBeVisible();
    await button(page, '新建项目').click();
    await expect(page.getByRole('dialog', { name: '新建项目' })).toBeVisible();
    expect(commands(replay)).toHaveLength(0);
  } finally {
    gate.resolve();
  }
});

test('创建任务长表单支持滚轮和 Tab 到末项，操作区不随焦点漂移', async ({ page, replay }) => {
  await page.setViewportSize({ width: 720, height: 450 });
  await page.goto('/');
  await button(page, '＋ 创建任务').click();
  const dialog = page.getByRole('dialog');
  const body = dialog.locator('.zm-form-body');
  const footer = dialog.locator('footer');
  const initial = await footer.boundingBox();
  const bounds = await dialog.boundingBox();
  expect(Math.abs(initial.y + initial.height - (bounds.y + bounds.height - 1))).toBeLessThan(2);
  await body.hover({ position: { x: 4, y: 20 } });
  await page.mouse.wheel(0, 1200);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const owner = button(page, '选择任务负责人');
  const ownerBounds = await owner.boundingBox();
  const bodyBounds = await body.boundingBox();
  expect(ownerBounds.y).toBeGreaterThanOrEqual(bodyBounds.y);
  expect(ownerBounds.y + ownerBounds.height).toBeLessThanOrEqual(initial.y);
  await page.getByLabel('任务目标', { exact: true }).focus();
  let reached = false;
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab');
    const current = await footer.boundingBox();
    expect(Math.abs(current.y - initial.y), 'Footer must remain at the dialog bottom').toBeLessThan(
      1,
    );
    expect(await dialog.locator('form').evaluate((el) => el.scrollTop)).toBe(0);
    if (await owner.evaluate((el) => document.activeElement === el)) {
      reached = true;
      break;
    }
  }
  expect(reached, 'Tab must reach the final owner control').toBe(true);
  const final = await owner.boundingBox();
  expect(final.y).toBeGreaterThanOrEqual(bodyBounds.y);
  expect(final.y + final.height).toBeLessThanOrEqual(initial.y);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(commands(replay)).toHaveLength(0);
});
