import {
  applyWorkbenchCommand,
  captureWorkflowTemplate,
  instantiateWorkflowTemplate,
} from '@zhuma/agent-core';
import { test, expect, failure } from './replay.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const commands = (replay) => replay.requests.filter((r) => r.endpoint === 'command');
const plans = (replay) => replay.requests.filter((r) => r.endpoint === 'plan');
async function evidence(page, testInfo, name) {
  if (!process.env.ZHUMA_TEMPLATE_EVIDENCE_DIR) return;
  const dir = resolve(process.env.ZHUMA_TEMPLATE_EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}-${testInfo.project.name}.png`) });
}
async function select(page, label, name) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
function seed(replay) {
  const state = replay.state;
  state.participants = state.participants.slice(0, 4);
  state.tasks[0].participantIds = state.participants.map((p) => p.id);
  for (const p of state.participants)
    p.role = { chen: '业务负责人', lin: '接口开发', qa: '质量评审', frontend: '界面实现' }[p.id];
  const base = state.tasks[0].workflows[0].nodes[0];
  state.tasks[0].workflows = [
    {
      id: 'root',
      name: '订单工作流',
      parentNodeId: null,
      nodes: [
        {
          ...base,
          id: 'api',
          title: '实现订单接口',
          assigneeId: 'lin',
          reviewerIds: ['chen', 'qa'],
          dependsOn: [],
          position: { x: 40, y: 60 },
        },
        {
          ...base,
          id: 'ui',
          title: '实现筛选界面',
          assigneeId: 'frontend',
          reviewerIds: ['qa'],
          dependsOn: [],
          position: { x: 40, y: 240 },
        },
        {
          ...base,
          id: 'join',
          title: '联调并验证交付',
          assigneeId: 'chen',
          reviewerIds: ['qa'],
          dependsOn: ['api', 'ui'],
          position: { x: 400, y: 150 },
        },
      ],
    },
    {
      id: 'child',
      name: '接口字段映射',
      parentNodeId: 'api',
      nodes: [
        {
          ...base,
          id: 'field',
          title: '映射订单状态字段',
          assigneeId: 'lin',
          reviewerIds: ['qa'],
          dependsOn: [],
        },
      ],
    },
  ];
  const definition = captureWorkflowTemplate(state.tasks[0], state);
  const asset = {
    id: 'template',
    kind: 'template',
    name: '订单并行开发',
    description: '接口与界面并行，联调汇合，多人评审。',
    content: JSON.stringify(definition),
    available: true,
  };
  state.assets.push(asset);
  return { definition, asset };
}
test('预览真实并行与子工作流；完整映射后创建独立可编辑任务，不调用模型', async ({
  page,
  replay,
}, testInfo) => {
  const { definition, asset } = seed(replay);
  replay.state.assets.push({
    ...asset,
    id: 'legacy',
    name: '旧文字模板',
    content: '请先检查，再完成开发。',
  });
  await page.goto('/');
  await evidence(page, testInfo, 'task-entry');
  await button(page, '＋ 创建任务').click();
  await page.getByLabel('任务目标', { exact: true }).fill('为采购门户增加状态筛选');
  await page.getByRole('radio', { name: '使用工作流', exact: true }).check();
  const browser = page.getByRole('dialog', { name: '选择工作流', exact: true });
  await expect(browser.locator('.react-flow__node')).toHaveCount(3);
  await expect(browser.locator('.react-flow__edge')).toHaveCount(2);
  await expect
    .poll(() =>
      browser.locator('.react-flow').evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [...el.querySelectorAll('.react-flow__node')].every((node) => {
          const r = node.getBoundingClientRect();
          return (
            r.x >= box.x - 1 &&
            r.y >= box.y - 1 &&
            r.right <= box.right + 1 &&
            r.bottom <= box.bottom + 1
          );
        });
      }),
    )
    .toBe(true);
  await evidence(page, testInfo, 'template-browser');
  await button(browser, '清单').click();
  await expect(browser.locator('.zm-template-node-list > li')).toHaveCount(3);
  await expect(browser.locator('.zm-template-node-detail')).toContainText('业务负责人、质量评审');
  await select(page, '预览工作流层级', '接口字段映射');
  await expect(browser.locator('.zm-template-node-list')).toContainText('映射订单状态字段');
  await page.getByLabel('搜索工作流').fill('旧文字');
  await expect(button(browser, '使用此工作流')).toBeDisabled();
  await expect(browser).toContainText('尚未包含可复用的节点');
  await page.getByLabel('搜索工作流').fill('不存在');
  await expect(browser).toContainText('没有匹配的工作流');
  await page.getByLabel('搜索工作流').fill('订单并行');
  await button(browser, '使用此工作流').click();
  for (const [role, actual] of [
    ['接口开发', '林可 · 接口开发'],
    ['业务负责人', '陈宁 · 业务负责人'],
    ['质量评审', '质量专家 · 专家'],
    ['界面实现', '界面专家 · 专家'],
  ])
    await select(page, `绑定角色：${role}`, actual);
  await evidence(page, testInfo, 'template-mapping');
  await button(page, '创建工作流').click();
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('为采购门户增加状态筛选');
  const created = replay.state.tasks.at(-1);
  expect(created.workflows).toHaveLength(2);
  expect(created.workflows[0].nodes[2].dependsOn).toEqual(
    created.workflows[0].nodes.slice(0, 2).map((n) => n.id),
  );
  expect(created.workflows[1].parentNodeId).toBe(created.workflows[0].nodes[0].id);
  expect(created.workflows[0].nodes[0].reviewerIds).toEqual(['chen', 'qa']);
  expect(created.templateSource.definition).toEqual(definition);
  await page.getByLabel('节点名称', { exact: true }).fill('补充接口分页契约');
  await button(page, '保存草稿').click();
  await expect(button(page, '保存草稿')).toBeDisabled();
  expect(replay.state.assets.find((a) => a.id === asset.id)).toEqual(asset);
  expect(plans(replay)).toHaveLength(0);
  expect(commands(replay).map((r) => r.command.type)).toEqual([
    'instantiate-template',
    'save-task',
  ]);
});

test('缺项草稿可重开、增加参与者和补齐；保留人工修改与两个评审席位', async ({ page, replay }) => {
  const { asset } = seed(replay);
  const original = replay.state.tasks[0];
  const draft = instantiateWorkflowTemplate(replay.state, {
    templateId: asset.id,
    task: {
      ...original,
      id: '65fbe8a3-a90e-448e-9658-dd1c10c039ef',
      title: '待补齐的采购工作',
      participantIds: ['lin'],
      ownerId: 'lin',
      workflows: undefined,
      status: undefined,
    },
    roleBindings: {},
    resourceBindings: {},
  });
  replay.state.tasks.push(draft);
  await page.goto('/');
  await page.getByRole('button', { name: /^待补齐的采购工作/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '待绑定' })).toBeVisible();
  await page.getByLabel('节点名称', { exact: true }).fill('人工补充后的接口名称');
  await button(page, '确认工作流').click();
  await expect(page.getByRole('alert')).toContainText('请绑定角色');
  expect(commands(replay)).toHaveLength(0);
  await button(page, '补齐映射').click();
  const mapping = page.getByRole('dialog', { name: '补齐模板映射', exact: true });
  await button(mapping, '管理任务参与者').click();
  const members = page.getByRole('dialog', { name: '任务参与者', exact: true });
  for (const name of ['陈宁', '质量专家', '界面专家'])
    await members
      .locator('.zm-member')
      .filter({ has: page.getByText(name, { exact: true }) })
      .getByRole('checkbox')
      .check();
  await button(members, '更新参与者').click();
  for (const [role, actual] of [
    ['接口开发', '林可 · 接口开发'],
    ['业务负责人', '陈宁 · 业务负责人'],
    ['质量评审', '质量专家 · 专家'],
    ['界面实现', '界面专家 · 专家'],
  ])
    await select(page, `绑定角色：${role}`, actual);
  await select(page, `绑定资源：${replay.state.assets[0].name}`, replay.state.assets[0].name);
  await button(mapping, '应用映射').click();
  await expect(button(page, '补齐映射')).toHaveCount(0);
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('人工补充后的接口名称');
  await button(page, '保存草稿').click();
  await expect(button(page, '保存草稿')).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: /^待补齐的采购工作/ }).click();
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('人工补充后的接口名称');
  const saved = replay.state.tasks.at(-1);
  expect(saved.workflows[0].nodes[0].reviewerIds).toEqual(['chen', 'qa']);
  expect(saved.templateSource).toEqual(draft.templateSource);
  expect(plans(replay)).toHaveLength(0);
});

test('从未保存任务草稿保存模板：失败可重试同一请求，不写任务也不丢修改', async ({
  page,
  replay,
}) => {
  seed(replay);
  let attempt = 0;
  replay.handlers.command = async (payload) => {
    if (++attempt === 1) return failure('storage', '存储暂不可用');
    replay.state = applyWorkbenchCommand(replay.state, payload.command);
    return { ok: true, value: replay.state };
  };
  const taskBefore = structuredClone(replay.state.tasks[0]);
  await page.goto('/');
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
  await page.getByLabel('节点名称', { exact: true }).fill('尚未提交的模板节点');
  await button(page, '保存为工作流').click();
  const modal = page.getByRole('dialog', { name: '保存为工作流', exact: true });
  await modal.getByLabel('工作流名称', { exact: true }).fill('公共采购工作流');
  for (const name of ['缩小画布', '放大画布', '定位当前', '适应全图']) {
    await button(modal, name).click();
    await expect(modal).toBeVisible();
    await expect(modal.getByLabel('工作流名称', { exact: true })).toHaveValue('公共采购工作流');
    expect(commands(replay), `画布操作「${name}」不应提交模板表单`).toHaveLength(0);
  }
  await button(modal, '保存工作流').click();
  await expect(modal.getByRole('alert')).toContainText('存储暂不可用');
  await button(modal, '保存工作流').click();
  await expect(modal).toHaveCount(0);
  expect(commands(replay)).toHaveLength(2);
  expect(commands(replay)[0]).toEqual(commands(replay)[1]);
  expect(replay.state.tasks[0]).toEqual(taskBefore);
  expect(replay.state.assets.at(-1).content).toContain('尚未提交的模板节点');
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('尚未提交的模板节点');
  await expect(button(page, '保存草稿')).toBeEnabled();
  expect(plans(replay)).toHaveLength(0);
});

test('团队资产中显式转换文字模板，编排角色、节点和交付；取消不写入', async ({
  page,
  replay,
}, testInfo) => {
  const { asset } = seed(replay);
  replay.state.assets.push({
    ...asset,
    id: 'legacy',
    name: '采购核对参考',
    content: '原文字保留：核对采购字段，再交付。',
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^团队资产/ }).click();
  await button(page.getByRole('article', { name: '采购核对参考', exact: true }), '编辑').click();
  await button(page, '转换为工作流').click();
  const editor = page.getByRole('dialog', { name: '编辑工作流', exact: true });
  await expect(editor).toContainText('原文字参考');
  await editor.getByLabel('节点名称', { exact: true }).fill('核对采购字段');
  await editor.getByLabel('交付内容', { exact: true }).fill('字段核对报告');
  await button(editor, '取消').click();
  expect(commands(replay)).toHaveLength(0);
  await expect(page.getByRole('dialog', { name: '编辑资产', exact: true })).toContainText('原文字');
  await button(page, '转换为工作流').click();
  await editor.getByLabel('节点名称', { exact: true }).fill('核对采购字段');
  await editor.getByLabel('交付内容', { exact: true }).fill('字段核对报告');
  await button(editor, '管理角色 1').click();
  const roles = page.getByRole('dialog', { name: '管理模板角色', exact: true });
  await roles.getByLabel('角色名称 1', { exact: true }).fill('采购分析');
  await select(page, '角色偏好 1', 'Agent 专家');
  await button(roles, '确认角色').click();
  await evidence(page, testInfo, 'template-editor');
  await button(editor, '应用到模板').click();
  await expect(editor).toHaveCount(0);
  expect(commands(replay)).toHaveLength(0);
  await button(page.getByRole('dialog', { name: '编辑资产', exact: true }), '保存').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = JSON.parse(replay.state.assets.find((a) => a.id === 'legacy').content);
  expect(saved.roles[0]).toMatchObject({ name: '采购分析', preferredKind: 'expert' });
  expect(saved.workflows[0].nodes[0]).toMatchObject({
    title: '核对采购字段',
    output: '字段核对报告',
  });
  expect(replay.state.tasks).toHaveLength(1);
  expect(plans(replay)).toHaveLength(0);
});

test('长目录与小窗保持预览和操作可达，嵌套选择取消保留任务目标', async ({
  page,
  replay,
}, testInfo) => {
  const { asset } = seed(replay);
  replay.state.assets.push(
    ...Array.from({ length: 24 }, (_, i) => ({
      ...asset,
      id: `template-${i}`,
      name: `跨区域采购审批与供应链对账 · 第 ${i + 1} 版`,
    })),
  );
  await page.setViewportSize({ width: 720, height: 600 });
  await page.goto('/');
  await button(page, '＋ 创建任务').click();
  await page.getByLabel('任务目标', { exact: true }).fill('保持这份任务目标');
  await page.getByRole('radio', { name: '使用工作流', exact: true }).check();
  const browser = page.getByRole('dialog', { name: '选择工作流', exact: true });
  await page.getByLabel('搜索工作流').fill('第 24 版');
  await expect(browser.locator('.zm-template-library li')).toHaveCount(1);
  await select(page, '预览工作流层级', '接口字段映射');
  await button(browser, '清单').click();
  await expect(browser.locator('.zm-template-node-list')).toContainText('映射订单状态字段');
  await evidence(page, testInfo, 'template-small');
  const box = await browser.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(720);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  await button(browser, '使用此工作流').click();
  await page.getByLabel('绑定角色：接口开发', { exact: true }).click();
  await expect(page.locator('.zm-select-popup[data-open]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByLabel('任务目标', { exact: true })).toHaveValue('保持这份任务目标');
  await button(page.getByRole('dialog'), '取消').click();
  expect(commands(replay)).toHaveLength(0);
  expect(plans(replay)).toHaveLength(0);
});
