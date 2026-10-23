import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyWorkbenchCommand,
  parseWorkflowTemplate,
  previewResourcePackage,
} from '@zhuma/agent-core';
import {
  expertStarterFiles,
  expertStarterRoot,
} from '../../../../tests/fixtures/expert-starters.mjs';
import { prepareExpertLibrary } from '../../../../tests/fixtures/expert-library.mjs';
import { test, expect, failure } from './replay.mjs';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const commands = (replay) => replay.requests.filter((request) => request.endpoint === 'command');
const plans = (replay) => replay.requests.filter((request) => request.endpoint === 'plan');
async function open(page, replay) {
  prepareExpertLibrary(replay.state);
  await page.goto('/?expert-library');
  await expect(page.getByRole('heading', { name: '专家', exact: true })).toBeVisible();
}
async function shot(page, testInfo, name) {
  if (!process.env.ZHUMA_EXPERT_EVIDENCE_DIR) return;
  const dir = resolve(process.env.ZHUMA_EXPERT_EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}-${testInfo.project.name}.png`) });
}

test('专家目录仅浏览同一专家定义，可搜索/按职责筛选/键盘查看完整方法和默认能力', async ({
  page,
  replay,
}, testInfo) => {
  await open(page, replay);
  await expect(page.getByRole('navigation', { name: '工作台导航' })).toHaveCount(0);
  const list = page.getByRole('list', { name: '选择专家' });
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('region', { name: '质量专家', exact: true })).toContainText(
    '尚未执行的检查保持待验证',
  );
  await expect(page.locator('.zm-expert-bindings')).toContainText('接口文档查询 · 已停用');
  await shot(page, testInfo, 'after-library');
  await page.getByLabel('搜索专家', { exact: true }).fill('组件实现');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '界面专家', exact: true })).toBeVisible();
  await page.getByLabel('筛选专家职责', { exact: true }).click();
  await page.getByRole('option', { name: '质量与验收', exact: true }).click();
  await expect(page.getByRole('heading', { name: '没有匹配的专家', exact: true })).toBeVisible();
  await button(page, '清除筛选').click();
  const next = list.getByRole('button').last();
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(next).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: '界面专家', exact: true })).toContainText(
    '可追溯的改动',
  );
  expect(commands(replay)).toHaveLength(0);
  expect(plans(replay)).toHaveLength(0);
});

test('编辑失败保留草稿和请求，保存后清筛选并定位同一个专家，成员入口仍是同一ID', async ({
  page,
  replay,
}) => {
  await open(page, replay);
  await page.getByLabel('搜索专家', { exact: true }).fill('质量');
  await button(page, '编辑定义').click();
  const modal = page.getByRole('dialog', { name: '编辑专家', exact: true });
  await expect(modal.getByLabel('类型', { exact: true })).toBeDisabled();
  await modal.getByLabel('名称', { exact: true }).fill('发布验证专家');
  await modal.getByLabel('职责', { exact: true }).fill('发布前验证');
  let attempts = 0;
  replay.handlers.command = async (payload) => {
    if (attempts++ === 0) return failure('storage', '保存暂不可用');
    replay.state = applyWorkbenchCommand(replay.state, payload.command);
    return { ok: true, value: replay.state };
  };
  await button(modal, '保存').click();
  await expect(modal.getByRole('alert')).toContainText('保存暂不可用');
  await expect(modal.getByLabel('名称', { exact: true })).toHaveValue('发布验证专家');
  await button(modal, '保存').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByLabel('搜索专家', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: '发布验证专家', exact: true })).toBeVisible();
  expect(commands(replay)[0]).toEqual(commands(replay)[1]);
  expect(replay.state.participants.find((p) => p.id === 'qa').name).toBe('发布验证专家');
  expect(replay.state.participants.filter((p) => p.kind === 'expert')).toHaveLength(2);
  await page.goto('/');
  await page.getByRole('button', { name: /^成员与专家/ }).click();
  await page.getByLabel('搜索成员与专家', { exact: true }).fill('发布验证专家');
  await expect(page.getByRole('article')).toHaveCount(1);
  expect(plans(replay)).toHaveLength(0);
});

test('无匹配时新建专家仍可直接维护定义，保存/刷新不产生任务，取消编辑不写入', async ({
  page,
  replay,
}) => {
  await open(page, replay);
  await page.getByLabel('搜索专家', { exact: true }).fill('尚不存在');
  await page.getByRole('button', { name: /新建专家/ }).click();
  const modal = page.getByRole('dialog', { name: '新建专家', exact: true });
  await modal.getByLabel('名称', { exact: true }).fill('用例审查专家');
  await modal
    .getByLabel('专家说明与工作方法', { exact: true })
    .fill('依据准确版本审查用例，记录未覆盖分支。');
  await button(modal, '保存').click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '用例审查专家', exact: true })).toBeVisible();
  await button(page, '编辑定义').click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('不保存的修改');
  await button(page.getByRole('dialog'), '取消').click();
  expect(commands(replay)).toHaveLength(1);
  expect(replay.state.tasks).toHaveLength(1);
  await page.reload();
  await page
    .getByRole('list', { name: '选择专家' })
    .getByRole('button', { name: /用例审查专家/ })
    .click();
  await expect(page.getByRole('region', { name: '用例审查专家', exact: true })).toContainText(
    '未覆盖分支',
  );
  expect(plans(replay)).toHaveLength(0);
});

test('专家导入须包含并勾选专家，导入后定位定义且可看来源/只读方法，配套能力仍在同一目录', async ({
  page,
  replay,
}, testInfo) => {
  const files = await expertStarterFiles();
  replay.handlers['preview-import'] = async (source) => ({
    ok: true,
    value: previewResourcePackage(source.files, parseWorkflowTemplate),
  });
  replay.handlers['resource-files'] = async (input) => {
    const expert = replay.state.participants.find((p) => p.id === input.id);
    // Directory transport preserves the selected root name; source responses are replayed.
    return {
      ok: true,
      value: {
        versionId: expert.origin.versionId,
        files: files
          .filter((f) => expert.origin.filePaths.includes(`starter-pack/${f.path}`))
          .map((f) => ({ ...f, path: `starter-pack/${f.path}` })),
      },
    };
  };
  await open(page, replay);
  await button(page, '导入专家').click();
  const modal = page.getByRole('dialog', { name: '导入专家', exact: true });
  await page
    .getByLabel('选择资产文件夹', { exact: true })
    .setInputFiles(fileURLToPath(expertStarterRoot));
  await expect(button(modal, '导入 8 项')).toBeEnabled();
  for (const name of ['交互体验专家', '工作规划专家', '工作流表达专家', '研发文档专家'])
    await modal.getByLabel(`导入 ${name}`, { exact: true }).uncheck();
  await expect(modal.locator('button[type="submit"]')).toBeDisabled();
  await page.getByLabel('选择资产文件', { exact: true }).setInputFiles({
    name: 'SKILL.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '---\nname: plain-skill\ndescription: Only a skill.\n---\nReview the supplied input.',
    ),
  });
  await expect(modal.getByRole('alert')).toContainText('所选包没有专家定义');
  await expect(modal.getByLabel('识别的定义')).toHaveCount(0);
  await expect(modal.locator('button[type="submit"]')).toBeDisabled();
  await page
    .getByLabel('选择资产文件夹', { exact: true })
    .setInputFiles(fileURLToPath(expertStarterRoot));
  await button(modal, '导入 8 项').click();
  await expect(modal).toHaveCount(0);
  const firstImported = replay.state.participants.find((p) =>
    p.origin?.sourceId?.startsWith('zhuma-'),
  );
  await expect(page.getByRole('heading', { name: firstImported.name, exact: true })).toBeVisible();
  await page
    .getByRole('list', { name: '选择专家' })
    .getByRole('button', { name: /^研发文档专家 / })
    .click();
  await expect(page.getByRole('heading', { name: '研发文档专家', exact: true })).toBeVisible();
  await shot(page, testInfo, 'imported-expert');
  await button(page, '查看来源').click();
  await expect(
    page.getByRole('dialog', { name: '来源文件 · 研发文档专家', exact: true }),
  ).toBeVisible();
  await button(page.getByRole('dialog').locator('footer'), '关闭').click();
  await button(page, '编辑定义').click();
  await expect(
    page.getByRole('dialog').getByLabel('专家说明与工作方法', { exact: true }),
  ).toHaveJSProperty('readOnly', true);
  await button(page.getByRole('dialog'), '取消').click();
  expect(replay.state.participants.filter((p) => p.kind === 'expert')).toHaveLength(6);
  expect(commands(replay)).toHaveLength(1);
  expect(plans(replay)).toHaveLength(0);
});

test('长专家目录与小窗均保留完整列表、可读详情和操作，不出现横向溢出', async ({
  page,
  replay,
}, testInfo) => {
  for (let i = 0; i < 25; i++)
    replay.state.participants.push({
      id: `long-expert-${i}`,
      name: `跨团队企业采购订单字段与研发交付核对专家 · ${i + 1}`,
      kind: 'expert',
      role: '研发交付核对',
      capabilities: ['采购', '研发交付'],
      instructions: '核对输入与来源，记录实际验证结果。\n'.repeat(40),
      available: true,
    });
  await page.setViewportSize({ width: 720, height: 600 });
  await open(page, replay);
  const list = page.getByRole('list', { name: '选择专家' });
  await expect(list.getByRole('button')).toHaveCount(27);
  await list.getByRole('button').last().click();
  const detail = page.getByRole('region', {
    name: '跨团队企业采购订单字段与研发交付核对专家 · 25',
    exact: true,
  });
  await detail.scrollIntoViewIfNeeded();
  await expect(button(detail, '编辑定义')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, testInfo, 'library-small');
  expect(commands(replay)).toHaveLength(0);
  expect(plans(replay)).toHaveLength(0);
});
