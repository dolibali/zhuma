import { mkdir } from 'node:fs/promises';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { test, expect, failure } from './replay.mjs';
import { prepareProjectHub } from '../../../../tests/fixtures/project-hub.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const commands = (replay) => replay.requests.filter((r) => r.endpoint === 'command');
const plans = (replay) => replay.requests.filter((r) => r.endpoint === 'plan');
const proofDir = 'docs/review/project-hub';
async function screenshot(page, name, info) {
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ path: `${proofDir}/${name}-${info.project.name}.png` });
}
async function openProject(page) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '工作台导航' })
    .getByRole('button', { name: /^项目/ })
    .click();
  await page
    .getByRole('article', { name: '订单门户', exact: true })
    .getByRole('button', { name: '订单门户', exact: true })
    .click();
}
async function togglePerson(page, label, name, checked) {
  await button(page, `选择${label}`).click();
  const picker = page.getByRole('dialog', { name: `选择${label}`, exact: true });
  await picker.getByLabel('搜索参与者').fill(name);
  await picker.getByRole('checkbox').setChecked(checked);
  await button(picker, '确认选择').click();
}

test.beforeEach(async ({ replay }) => {
  prepareProjectHub(replay.state);
});

test('项目四入口同源展示，任务返回原项目位置，成果状态未知；浏览和刷新不写入', async ({
  page,
  replay,
}, info) => {
  await openProject(page);
  await expect(page.getByRole('heading', { name: '订单门户', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '项目详情' })).not.toContainText('研究列表空状态');
  await screenshot(page, 'overview', info);
  const navigation = page.getByRole('navigation', { name: '项目导航' });
  await button(navigation, '工作').click();
  await page.getByLabel('搜索项目工作').fill('导出');
  await expect(page.locator('.zm-project-work-list > button')).toHaveCount(1);
  await page.getByRole('button', { name: /^订单导出字段核对/ }).click();
  await button(page, '项目').click();
  await expect(button(page.getByRole('navigation', { name: '项目导航' }), '工作')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await button(navigation, '资料与成果').click();
  await expect(page.getByRole('link', { name: 'HTTP 接口参考 ↗' })).toHaveAttribute(
    'href',
    'https://developer.mozilla.org/en-US/docs/Web/HTTP',
  );
  await expect(page.getByText('成果查询尚未接通。')).toBeVisible();
  await expect(page.getByText('旧版说明')).toBeVisible();
  await screenshot(page, 'materials', info);
  await button(navigation, '成员').click();
  await expect(
    page
      .locator('.zm-project-panel')
      .filter({ has: page.getByRole('heading', { name: /^默认参与者/ }) }),
  ).toContainText('质量专家');
  await expect(page.getByRole('heading', { name: '任务中的其他参与者 1' })).toBeVisible();
  await button(page, '刷新').click();
  await expect(page.getByRole('heading', { name: '订单门户', exact: true })).toBeVisible();
  expect(commands(replay)).toHaveLength(0);
  expect(plans(replay)).toHaveLength(0);
});

test('修改项目默认参与者和资料失败可同键重试；已有任务不变，刷新重开同定义', async ({
  page,
  replay,
}, info) => {
  const originalTasks = structuredClone(replay.state.tasks);
  let calls = 0;
  replay.handlers.command = async ({ command }) => {
    if (++calls === 1) return failure('unavailable', '项目保存暂时失败。');
    replay.state = applyWorkbenchCommand(replay.state, command);
    return { ok: true, value: replay.state };
  };
  await openProject(page);
  await button(page, '编辑项目').click();
  await button(page, '选择默认参与者').click();
  await screenshot(page, 'participants-open', info);
  await page.keyboard.press('Escape');
  await togglePerson(page, '默认参与者', '质量专家', false);
  await togglePerson(page, '默认参与者', '界面专家', true);
  const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await dialog.locator('summary').filter({ hasText: '关联资产' }).click();
  await dialog.getByLabel('交互检查清单 · Skill', { exact: true }).check();
  await button(dialog, '添加链接').click();
  await dialog.getByLabel('链接名称 2', { exact: true }).fill('设计参考');
  await dialog.getByLabel('链接地址 2', { exact: true }).fill('https://example.com/design');
  await button(dialog, '保存').click();
  await expect(dialog.getByRole('alert')).toContainText('项目保存暂时失败');
  await expect(dialog.getByLabel('链接名称 2', { exact: true })).toHaveValue('设计参考');
  await button(dialog, '保存').click();
  await expect(dialog).toHaveCount(0);
  expect(commands(replay)).toHaveLength(2);
  expect(commands(replay)[1]).toEqual(commands(replay)[0]);
  expect(replay.state.projects.find((p) => p.id === 'project')).toMatchObject({
    defaultParticipantIds: ['chen', 'frontend'],
    assetIds: ['skill-0', 'skill-2', 'skill-1'],
  });
  expect(replay.state.tasks).toEqual(originalTasks);
  await page.reload();
  await openProject(page);
  await button(page, '编辑项目').click();
  await expect(button(page, '选择默认参与者')).toContainText('陈宁、界面专家');
  await expect(page.getByLabel('链接名称 2', { exact: true })).toHaveValue('设计参考');
  expect(plans(replay)).toHaveLength(0);
});

test('项目内任务继承默认值，换项目保留人工选择，显式重置再创建并返回项目', async ({
  page,
  replay,
}) => {
  await openProject(page);
  await button(page, '＋ 创建任务').click();
  const dialog = page.getByRole('dialog', { name: '创建任务', exact: true });
  await expect(button(dialog, '选择参与者')).toContainText('陈宁、质量专家');
  await togglePerson(page, '参与者', '界面专家', true);
  await dialog.getByRole('combobox', { name: '所属项目', exact: true }).click();
  await page.getByRole('option', { name: '体验研究', exact: true }).click();
  await expect(button(dialog, '选择参与者')).toContainText('陈宁、质量专家、界面专家');
  await button(dialog, '使用项目默认参与者').click();
  await expect(button(dialog, '选择参与者')).toContainText('林可、界面专家');
  await page.getByLabel('任务目标', { exact: true }).fill('核对研究页面的空状态');
  await page.getByRole('radio', { name: '从空白开始', exact: true }).check();
  await button(dialog, '创建工作流').click();
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('核对研究页面的空状态');
  expect(replay.state.tasks.at(-1)).toMatchObject({
    projectId: 'research',
    participantIds: ['lin', 'frontend'],
    ownerId: null,
  });
  await button(page, '项目').click();
  await expect(page.getByRole('heading', { name: '体验研究', exact: true })).toBeVisible();
  expect(commands(replay)).toHaveLength(1);
  expect(plans(replay)).toHaveLength(0);
});

test('项目内 AI 创建只用默认参与者，规划失败仍返回同一项目；新建项目也可立即工作', async ({
  page,
  replay,
}) => {
  replay.handlers.plan = () => failure('unavailable', '规划服务暂不可用。');
  await openProject(page);
  await button(page, '＋ 创建任务').click();
  await page.getByLabel('任务目标', { exact: true }).fill('新增订单检索');
  await button(page, '生成计划').click();
  await expect(page.getByRole('alert')).toContainText('规划服务暂不可用');
  expect(replay.state.tasks.at(-1).participantIds).toEqual(['chen', 'qa']);
  await button(page, '项目').click();
  await button(page, '全部项目').click();
  await button(page, '＋ 新建项目').click();
  await page.getByLabel('项目名称', { exact: true }).fill('供应商门户');
  await button(page.getByRole('dialog', { name: '新建项目', exact: true }), '保存').click();
  await expect(page.getByRole('heading', { name: '供应商门户', exact: true })).toBeVisible();
  await button(page, '＋ 创建任务').click();
  await expect(button(page, '选择参与者')).toHaveText('选择参与者');
  await page.getByLabel('任务目标', { exact: true }).fill('确定门户入口');
  await button(page, '生成计划').click();
  await expect(
    page.getByRole('dialog', { name: '创建任务', exact: true }).getByRole('alert'),
  ).toContainText('至少选择一位');
  expect(plans(replay)).toHaveLength(1);
});

test('长项目、资料和小窗口不横溢；取消编辑不修改项目', async ({ page, replay }, info) => {
  const project = replay.state.projects[0];
  project.name = '跨团队订单协作与接口兼容检查'.repeat(4);
  project.references[0].name = '跨系统接口资料'.repeat(10);
  await page.setViewportSize({ width: 720, height: 600 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '工作台导航' })
    .getByRole('button', { name: /^项目/ })
    .click();
  await page
    .getByRole('article', { name: project.name, exact: true })
    .getByRole('button', { name: project.name, exact: true })
    .click();
  await screenshot(page, 'small', info);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await button(page, '编辑项目').click();
  await page.getByLabel('项目名称', { exact: true }).fill('不会保存');
  await button(page.getByRole('dialog', { name: '编辑项目', exact: true }), '取消').click();
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  expect(commands(replay)).toHaveLength(0);
});
