import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  applyWorkbenchCommand,
  previewResourcePackage,
  parseWorkflowTemplate,
} from '@zhuma/agent-core';
import { packageFixture, packageZip } from '../../../../tests/fixtures/asset-package.mjs';
import { test, expect, failure } from './replay.mjs';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const commands = (replay) => replay.requests.filter((r) => r.endpoint === 'command');
const plans = (replay) => replay.requests.filter((r) => r.endpoint === 'plan');
async function select(page, label, name) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function assets(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^团队资产/ }).click();
}
async function shot(page, testInfo, name) {
  if (!process.env.ZHUMA_ASSET_EVIDENCE_DIR) return;
  const dir = resolve(process.env.ZHUMA_ASSET_EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}-${testInfo.project.name}.png`) });
}
function imports(replay, files = packageFixture(), failFirst = false) {
  const versions = new Map();
  let attempts = 0;
  replay.handlers['preview-import'] = async (source) => {
    // Browser transport replay only; ZIP decoding is independently covered by Host tests.
    if (source.kind === 'zip') expect(source.data).toBe(packageZip(files));
    return {
      ok: true,
      value: previewResourcePackage(
        source.kind === 'files' ? source.files : files,
        parseWorkflowTemplate,
      ),
    };
  };
  replay.handlers.command = async (payload) => {
    if (payload.command.type === 'import-package' && failFirst && attempts++ === 0)
      return failure('storage', '保存暂不可用，请重试。');
    replay.state = applyWorkbenchCommand(replay.state, payload.command);
    if (payload.command.type === 'import-package')
      versions.set(payload.command.input.versionId, structuredClone(payload.command.input.files));
    return { ok: true, value: replay.state };
  };
  replay.handlers['resource-files'] = async (input) => {
    const resource =
      input.kind === 'asset'
        ? replay.state.assets.find((a) => a.id === input.id)
        : replay.state.participants.find((p) => p.id === input.id && p.kind === 'expert');
    if (!resource?.origin) return failure('not-found', '没有来源包');
    return {
      ok: true,
      value: {
        versionId: resource.origin.versionId,
        files: versions
          .get(resource.origin.versionId)
          .filter((f) => resource.origin.filePaths.includes(f.path)),
      },
    };
  };
  return versions;
}
async function zip(page, files = packageFixture()) {
  await button(page, '导入定义').click();
  await page.getByLabel('选择资产文件', { exact: true }).setInputFiles({
    name: 'order-analyst.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(packageZip(files), 'base64'),
  });
  await expect(page.getByRole('button', { name: /^Order analyst/ })).toBeVisible();
}

test('资产目录含专家但复用同一身份，分类计数与编辑互通', async ({ page, replay }, testInfo) => {
  await assets(page);
  await expect(page.getByRole('article')).toHaveCount(14);
  await shot(page, testInfo, 'after-catalog');
  await button(page.getByRole('navigation', { name: '资产分类' }), 'Agent 专家 2').click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await shot(page, testInfo, 'expert-catalog');
  await button(page.getByRole('article', { name: '质量专家', exact: true }), '编辑').click();
  await page.getByLabel('职责', { exact: true }).fill('发布回归评审');
  await button(page.getByRole('dialog'), '保存').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /^成员与专家/ }).click();
  await page.getByLabel('搜索成员与专家', { exact: true }).fill('质量专家');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article')).toContainText('发布回归评审');
  expect(replay.state.participants.filter((p) => p.id === 'qa')).toHaveLength(1);
  expect(replay.state.assets).toHaveLength(12);
  expect(commands(replay)[0].command.type).toBe('save-participant');
});

test('目录预览不读取私人文件；可切换定义/文件并取消，零写入与模型请求', async ({
  page,
  replay,
}, testInfo) => {
  imports(replay);
  const root = testInfo.outputPath('selected');
  for (const file of packageFixture().filter((f) => f.path.startsWith('analyst/'))) {
    const path = resolve(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(file.data, 'base64'));
  }
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (['USER.md', '.env'].includes(this.name)) throw Error('Private file must not be read');
      return original.call(this);
    };
  });
  await assets(page);
  await button(page, '导入定义').click();
  await page.getByLabel('选择资产文件夹', { exact: true }).setInputFiles(resolve(root, 'analyst'));
  const modal = page.getByRole('dialog', { name: '导入资产', exact: true });
  await expect(modal.getByRole('button', { name: /^Order analyst/ })).toBeVisible();
  await modal.getByRole('button', { name: /^Order analyst/ }).click();
  await expect(modal.getByLabel('名称', { exact: true })).toHaveValue('Order analyst');
  await shot(page, testInfo, 'import-preview');
  await button(modal, '文件 3').click();
  await select(page, '选择来源文件', 'analyst/AGENTS.md');
  await expect(modal.locator('pre')).toContainText('Explain conflicting fields');
  await modal.getByRole('button', { name: /^field-review/ }).click();
  await button(modal, '文件 3').click();
  await select(page, '选择来源文件', 'analyst/skills/field-review/scripts/check.py');
  await expect(modal.locator('pre')).toContainText('NEVER_EXECUTE_IMPORT');
  await button(modal, '取消').click();
  expect(commands(replay)).toHaveLength(0);
  expect(plans(replay)).toHaveLength(0);
  const source = replay.requests.find((r) => r.endpoint === 'preview-import');
  expect(source.files.find((f) => f.path.endsWith('USER.md')).data).toBe('');
  expect(source.files.find((f) => f.path.endsWith('.env')).data).toBe('');
  expect(replay.state.assets).toHaveLength(12);
});

test('ZIP 明确导入、失败同键重试、来源下载和更新已有定义保留 ID', async ({
  page,
  replay,
}, testInfo) => {
  const versions = imports(replay, packageFixture(), true);
  await assets(page);
  await zip(page);
  let modal = page.getByRole('dialog', { name: '导入资产', exact: true });
  await modal.getByLabel('名称', { exact: true }).fill('字段审查');
  await button(modal, '导入 2 项').click();
  await expect(modal.getByRole('alert')).toContainText('保存暂不可用');
  await expect(modal.getByLabel('名称', { exact: true })).toHaveValue('字段审查');
  await button(modal, '导入 2 项').click();
  await expect(modal).toHaveCount(0);
  expect(commands(replay)).toHaveLength(2);
  expect(commands(replay)[0]).toEqual(commands(replay)[1]);
  const skill = replay.state.assets.find((a) => a.name === '字段审查');
  const expert = replay.state.participants.find((p) => p.name === 'Order analyst');
  expect(expert.resourceBindings.skillIds).toEqual([skill.id]);
  expect(replay.state.assets).toHaveLength(13);
  expect(replay.state.participants).toHaveLength(27);
  await button(page.getByRole('article', { name: '字段审查', exact: true }), '来源').click();
  const source = page.getByRole('dialog', { name: '来源文件 · 字段审查', exact: true });
  await select(page, '选择来源文件', 'analyst/skills/field-review/scripts/check.py');
  await expect(source.locator('pre')).toContainText('NEVER_EXECUTE_IMPORT');
  await shot(page, testInfo, 'source-files');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button(source, '下载文件').click(),
  ]);
  expect(download.suggestedFilename()).toBe('check.py');
  expect((await readFile(await download.path())).toString()).toContain('NEVER_EXECUTE_IMPORT');
  await button(source.locator('footer'), '关闭').click();
  const old = structuredClone(versions.get(skill.origin.versionId));
  await zip(page);
  modal = page.getByRole('dialog', { name: '导入资产', exact: true });
  await modal.getByLabel('名称', { exact: true }).fill('字段审查');
  await select(page, '导入保存方式', '更新：字段审查');
  await modal.getByRole('button', { name: /^Order analyst/ }).click();
  await select(page, '导入保存方式', '更新：Order analyst');
  await button(modal, '导入 2 项').click();
  await expect(modal).toHaveCount(0);
  expect(replay.state.assets.find((a) => a.name === '字段审查').id).toBe(skill.id);
  expect(replay.state.participants.find((p) => p.name === 'Order analyst').id).toBe(expert.id);
  expect(replay.state.assets.find((a) => a.id === skill.id).origin.versionId).not.toBe(
    skill.origin.versionId,
  );
  expect(versions.get(skill.origin.versionId)).toEqual(old);
  expect(versions.size).toBe(2);
  expect(plans(replay)).toHaveLength(0);
});

test('小窗缺项保存停用；普通文字继续在原编辑器明确保存', async ({ page, replay }, testInfo) => {
  const files = packageFixture().filter((f) => !f.path.endsWith('guide.md'));
  imports(replay, files);
  await page.setViewportSize({ width: 720, height: 600 });
  await assets(page);
  await zip(page, files);
  let modal = page.getByRole('dialog', { name: '导入资产', exact: true });
  await expect(modal.getByLabel('导入后可选用', { exact: true })).toBeDisabled();
  await expect(modal).toContainText('将保存为停用');
  await shot(page, testInfo, 'import-small-missing');
  const box = await modal.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  await button(modal, '导入 2 项').click();
  await expect(modal).toHaveCount(0);
  expect(replay.state.assets.at(-1).available).toBe(false);
  expect(replay.state.participants.at(-1).available).toBe(false);
  await button(page.getByRole('navigation', { name: '资产分类' }), 'MCP 0').click();
  await button(page, '导入定义').click();
  await page.getByLabel('选择资产文件', { exact: true }).setInputFiles({
    name: 'api-docs.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('只读 API 文档接口说明。'),
  });
  modal = page.getByRole('dialog', { name: '新建资产', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel('定义内容', { exact: true })).toHaveValue(
    '只读 API 文档接口说明。',
  );
  expect(commands(replay)).toHaveLength(1);
  await button(modal, '保存').click();
  await expect(modal).toHaveCount(0);
  expect(replay.state.assets.at(-1)).toMatchObject({ kind: 'mcp', name: 'api-docs' });
  expect(replay.state.assets.at(-1).origin).toBeUndefined();
  expect(plans(replay)).toHaveLength(0);
});
