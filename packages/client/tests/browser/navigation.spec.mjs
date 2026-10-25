import { test, expect, failure } from './replay.mjs';
import { treeFixture } from '../../../../tests/fixtures/workbench-tree.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const selected = (page, id) => page.locator(`.react-flow__node[data-id="${id}"].selected`);
async function openTree(page, replay) {
  replay.state = treeFixture();
  await page.goto('/');
  await page.getByRole('button', { name: /^订单与结算协同交付/ }).click();
  await button(page, '工作树定位').click();
}
async function findNode(page, title) {
  await page.getByLabel('搜索工作树', { exact: true }).fill(title);
  await button(page, `定位 ${title}`).click();
  await button(page, '清除搜索').click();
}

test('三层工作树保持全图选择；搜索、折叠、依赖和返回记住每层位置且不写入', async ({
  page,
  replay,
}) => {
  await openTree(page, replay);
  const requests = replay.requests.length;
  await expect(page.locator('.react-flow__node')).toHaveCount(14);
  const canvasNode = page.locator('.react-flow__node[data-id="reports"]');
  await canvasNode.focus();
  await page.keyboard.press('Enter');
  await expect(selected(page, 'reports')).toHaveCount(1);
  await canvasNode.click();
  await expect(button(page, '工作树定位')).toHaveAttribute('aria-pressed', 'true');
  await findNode(page, '异常数据处理');
  await expect(selected(page, 'exceptions')).toHaveCount(1);
  const path = page.getByRole('navigation', { name: '工作树路径', exact: true });
  await expect(path).toContainText('主工作流');
  await expect(path).toContainText('订单改造');
  await expect(path).toContainText('查询与导出');
  await expect(page.locator('.zm-tree-ancestor')).toHaveCount(2);
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.getByLabel('搜索工作树', { exact: true }).fill('不存在的节点');
  await expect(page.getByText('没有匹配的工作节点', { exact: true })).toBeVisible();
  await expect(selected(page, 'exceptions')).toHaveCount(1);
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', viewport);
  await button(page, '清除搜索').click();
  await button(page, '折叠 交付结算报表').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(11);
  await expect(selected(page, 'exceptions')).toHaveCount(1);
  await button(page.locator('.zm-tree-selection'), '字段映射').click();
  await expect(selected(page, 'mapping')).toHaveCount(1);
  await expect(page.locator('.zm-tree-selection')).toContainText('0 前置 · 2 后续');
  await findNode(page, '核对对账数据');
  await expect(page.locator('.react-flow__node')).toHaveCount(14);
  await expect(selected(page, 'reconcile')).toHaveCount(1);
  await button(path, '主工作流').click();
  await expect(selected(page, 'reports')).toHaveCount(1);
  await button(page, '进入本层工作流').click();
  await expect(button(page, '工作流')).toHaveAttribute('aria-pressed', 'true');
  await button(page, '打开子工作流').click();
  await expect(selected(page, 'reconcile')).toHaveCount(1);
  await button(page, '上一级').click();
  await expect(selected(page, 'reports')).toHaveCount(1);
  expect(replay.requests).toHaveLength(requests);
  // Save a real edit through the reducer and reopen the nested task from its normal list entry.
  await button(page, '打开子工作流').click();
  await page.getByLabel('节点名称', { exact: true }).fill('核对对账数据与差异');
  await button(page, '保存草稿').click();
  await expect(button(page, '保存草稿')).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: /^订单与结算协同交付/ }).click();
  await button(page, '工作树定位').click();
  await findNode(page, '核对对账数据与差异');
  await expect(selected(page, 'reconcile')).toHaveCount(1);
  expect(replay.requests.filter((r) => r.endpoint === 'command')).toHaveLength(1);
  expect(replay.requests.filter((r) => r.endpoint === 'plan')).toHaveLength(0);
});

test('新版本删除当前子树时回到可见上级，不保留已不可见内容', async ({ page, replay }) => {
  await openTree(page, replay);
  await findNode(page, '异常数据处理');
  await button(page, '进入本层工作流').click();
  await page.getByLabel('节点名称', { exact: true }).fill('本地修改');
  replay.handlers.command = () => failure('conflict', '有更新，请读取最新版本。');
  await button(page, '保存草稿').click();
  await expect(button(page, '读取最新版本')).toBeVisible();
  replay.state.tasks[0].workflows = replay.state.tasks[0].workflows.filter(
    (w) => w.id !== 'tree-export',
  );
  replay.state.revision++;
  page.once('dialog', (dialog) => dialog.accept());
  await button(page, '读取最新版本').click();
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('实现查询与导出');
  await expect(
    page.getByRole('status').filter({ hasText: '原定位在当前版本中不可用' }),
  ).toBeVisible();
  await button(page, '工作树定位').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(10);
  await page.getByLabel('搜索工作树', { exact: true }).fill('异常数据');
  await expect(page.getByText('没有匹配的工作节点', { exact: true })).toBeVisible();
  await expect(page.locator('.zm-tree-selection')).not.toContainText('异常数据');
  expect(replay.requests.filter((r) => r.endpoint === 'plan')).toHaveLength(0);
});

test('小屏工作树可以用键盘定位与进入，关闭侧栏恢复焦点', async ({ page, replay }) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await openTree(page, replay);
  await button(page, '层级导航').click();
  const panel = page.getByRole('dialog', { name: '工作树导航面板' });
  await expect(panel).toBeVisible();
  await expect(button(panel, '收起侧栏')).toBeFocused();
  await page.getByLabel('搜索工作树', { exact: true }).fill('异常数据处理');
  await button(panel, '定位 异常数据处理').focus();
  await page.keyboard.press('Enter');
  await expect(selected(page, 'exceptions')).toHaveCount(1);
  await expect(panel).toContainText('第 3 层');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(button(page, '层级导航')).toBeFocused();
  await page.keyboard.press('Enter');
  await button(panel, '进入本层工作流').focus();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(button(page, '配置')).toBeFocused();
  await expect(selected(page, 'exceptions')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(replay.requests.filter((r) => r.endpoint !== 'snapshot')).toHaveLength(0);
});
