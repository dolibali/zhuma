import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyWorkbenchCommand,
  previewResourcePackage,
  parseWorkflowTemplate,
} from '@zhuma/agent-core';
import { expertStarterRoot } from '../../../../tests/fixtures/expert-starters.mjs';
import { test, expect, failure } from './replay.mjs';

const commands = (replay) => replay.requests.filter((request) => request.endpoint === 'command');
const expertFile = (name, filename = 'current.json') => ({
  name: filename,
  mimeType: 'application/json',
  buffer: Buffer.from(
    JSON.stringify({
      format: 'zhuma-expert',
      schemaVersion: 1,
      name,
      role: '文档核对',
      capabilities: ['文档'],
      instructions: '只处理当前选择的任务材料。',
    }),
  ),
});
async function open(page, expertLibrary) {
  await page.goto(expertLibrary ? '/?expert-library' : '/');
  if (!expertLibrary) await page.getByRole('button', { name: /^团队资产/ }).click();
  await page
    .getByRole('button', { name: expertLibrary ? '导入专家' : '导入定义', exact: true })
    .click();
  return page.getByRole('dialog', { name: expertLibrary ? '导入专家' : '导入资产', exact: true });
}
async function starter(page, modal) {
  await page
    .getByLabel('选择资产文件夹', { exact: true })
    .setInputFiles(fileURLToPath(expertStarterRoot));
  await expect(modal.getByRole('button', { name: '导入 8 项', exact: true })).toBeEnabled();
}
async function cannotSubmit(modal, replay, expectedCommands) {
  await expect(modal.getByLabel('识别的定义')).toHaveCount(0);
  await expect(modal.locator('button[type="submit"]')).toBeDisabled();
  await modal.locator('form').evaluate((form) => form.requestSubmit());
  expect(commands(replay)).toHaveLength(expectedCommands);
}
async function shot(page, info, name, enabled) {
  if (!enabled || !process.env.ZHUMA_EXPERT_EVIDENCE_DIR) return;
  const dir = resolve(process.env.ZHUMA_EXPERT_EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}-${info.project.name}.png`) });
}

for (const expertLibrary of [false, true]) {
  const label = expertLibrary ? '专家入口' : '团队资产入口';
  test(`${label}：新包超限、读取或文字格式失败立即作废旧预览/待提交内容，有效重选可恢复`, async ({
    page,
    replay,
  }, info) => {
    replay.handlers['preview-import'] = async (source) => ({
      ok: true,
      value: previewResourcePackage(source.files, parseWorkflowTemplate),
    });
    let attempts = 0;
    replay.handlers.command = async (payload) => {
      if (attempts++ === 0) return failure('storage', '保存暂不可用');
      replay.state = applyWorkbenchCommand(replay.state, payload.command);
      return { ok: true, value: replay.state };
    };
    await page.addInitScript(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        if (this.name === 'unreadable.json') return Promise.reject(Error('选中文件读取失败'));
        return original.call(this);
      };
    });
    const modal = await open(page, expertLibrary);
    await starter(page, modal);
    await modal.getByRole('button', { name: '导入 8 项', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('保存暂不可用');
    const firstRequest = commands(replay)[0].requestId;
    const rejected = [
      [
        {
          name: 'rejected.zip',
          mimeType: 'application/zip',
          buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
        },
        'ZIP 文件最多 2 MiB',
      ],
      [expertFile('不可读取的专家', 'unreadable.json'), '选中文件读取失败'],
      [{ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from([0xff, 0xfe]) }, 'UTF-8'],
    ];
    for (const [file, error] of rejected) {
      await page.getByLabel('选择资产文件', { exact: true }).setInputFiles(file);
      await expect(modal.getByRole('alert')).toContainText(error);
      await cannotSubmit(modal, replay, 1);
      await shot(
        page,
        info,
        'import-error-cleared',
        expertLibrary && error === 'ZIP 文件最多 2 MiB',
      );
      await starter(page, modal);
    }
    await page
      .getByLabel('选择资产文件', { exact: true })
      .setInputFiles(expertFile('当前重新选择的专家'));
    await modal.getByRole('button', { name: '导入 1 项', exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(commands(replay)).toHaveLength(2);
    expect(commands(replay)[1].requestId).not.toBe(firstRequest);
    expect(commands(replay)[1].command.input.choices.map((choice) => choice.name)).toEqual([
      '当前重新选择的专家',
    ]);
    expect(replay.state.participants.filter((p) => p.kind === 'expert')).toHaveLength(3);
    expect(replay.requests.filter((r) => r.endpoint === 'plan')).toHaveLength(0);
  });

  test(`${label}：Host预览失败不保留旧包，忽略取消后迟到的旧响应，后续有效包仍可保存`, async ({
    page,
    replay,
  }) => {
    replay.handlers['preview-import'] = async (source) =>
      source.files.some((f) => f.path === 'host-error.json')
        ? failure('asset-import', 'Host 预览失败，请重新选择')
        : { ok: true, value: previewResourcePackage(source.files, parseWorkflowTemplate) };
    const modal = await open(page, expertLibrary);
    await starter(page, modal);
    // Simulate a transport which completes a cancelled RPC; cancellation must still win in the view.
    await page.evaluate(() => {
      const original = window.fetch;
      window.__heldImport = { ready: false, delivered: false };
      window.fetch = async (input, options) => {
        const payload = options?.body && JSON.parse(options.body).payload;
        if (
          String(input).endsWith('/preview-import') &&
          payload?.files?.some((f) => f.path === 'old-late.json')
        ) {
          const held = { ready: false, delivered: false };
          window.__heldImport = held;
          const response = await original(input, { ...options, signal: undefined });
          const gate = new Promise((resolve) => {
            held.release = resolve;
          });
          held.ready = true;
          await gate;
          held.delivered = true;
          return response;
        }
        return original(input, options);
      };
    });
    await page
      .getByLabel('选择资产文件', { exact: true })
      .setInputFiles(expertFile('迟到的旧专家', 'old-late.json'));
    await expect.poll(() => page.evaluate(() => window.__heldImport.ready)).toBe(true);
    await expect(modal.getByLabel('识别的定义')).toHaveCount(0);
    await page
      .getByLabel('选择资产文件', { exact: true })
      .setInputFiles(expertFile('错误的新专家', 'host-error.json'));
    await expect(modal.getByRole('alert')).toContainText('Host 预览失败');
    await cannotSubmit(modal, replay, 0);
    await page.evaluate(() => window.__heldImport.release());
    await expect.poll(() => page.evaluate(() => window.__heldImport.delivered)).toBe(true);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(modal.getByRole('alert')).toContainText('Host 预览失败');
    await cannotSubmit(modal, replay, 0);
    await page
      .getByLabel('选择资产文件', { exact: true })
      .setInputFiles(expertFile('另一个迟到的旧专家', 'old-late.json'));
    await expect.poll(() => page.evaluate(() => window.__heldImport.ready)).toBe(true);
    await page
      .getByLabel('选择资产文件', { exact: true })
      .setInputFiles(expertFile('最终选择的专家'));
    await expect(modal.getByLabel('名称', { exact: true })).toHaveValue('最终选择的专家');
    await page.evaluate(() => window.__heldImport.release());
    await expect.poll(() => page.evaluate(() => window.__heldImport.delivered)).toBe(true);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(modal.getByLabel('名称', { exact: true })).toHaveValue('最终选择的专家');
    await modal.getByRole('button', { name: '导入 1 项', exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(commands(replay)).toHaveLength(1);
    expect(commands(replay)[0].command.input.choices.map((choice) => choice.name)).toEqual([
      '最终选择的专家',
    ]);
    expect(replay.state.participants.some((p) => p.name === '迟到的旧专家')).toBe(false);
    expect(replay.requests.filter((r) => r.endpoint === 'plan')).toHaveLength(0);
  });
}
