import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.dirname(fileURLToPath(import.meta.url));
const viewport = { width: 1440, height: 900 };

function shot(name) {
  return path.join(outDir, `${name}-light-1440x900.png`);
}

function startDemo(sessionDir) {
  const env = { ...process.env };
  delete env.ZHUMA_MODEL_API_KEY;
  delete env.ZHUMA_MODEL_BASE_URL;
  const child = spawn(process.execPath, ['examples/agent-workspace/server.mjs'], {
    cwd: root,
    env: {
      ...env,
      ZHUMA_HOLD_RUNS: '1',
      ZHUMA_TEST_HOOKS: '1',
      ZHUMA_SESSION_FILE: path.join(sessionDir, 'session.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务没有打印地址\n${stderr}`)), 15000);
    child.stdout.on('data', (chunk) => {
      const line = chunk
        .toString()
        .split('\n')
        .find((item) => item.includes('"url"'));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line).url);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务退出 ${code}\n${stderr}`));
    });
  });
  return { child, url };
}

const sessionDir = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-evidence-'));
const demo = startDemo(sessionDir);
const url = await demo.url;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport });
try {
  await page.goto(url);
  await page.getByTestId('banner').filter({ hasText: '不会自动改用模拟' }).waitFor();
  await page.getByTestId('executor').selectOption('simulated');
  await page.getByTestId('banner').filter({ hasText: '当前是模拟执行器' }).waitFor();
  await page.locator('[data-testid="skill"][value="test-design"]').check();
  await page.locator('[data-testid="skill-chip"][data-id="test-design"]').waitFor();
  await page.screenshot({ path: shot('configure') });

  await page.locator('#message').fill('整理企业开户必填字段');
  await page.getByTestId('primary').click();
  await page.getByTestId('node-status').filter({ hasText: '启动中' }).waitFor();
  const released = await page.request.post(`${url}/api/release`);
  if (!released.ok()) throw new Error(await released.text());
  await page.getByTestId('node-status').filter({ hasText: '执行中' }).waitFor();
  await page.screenshot({ path: shot('running') });

  const finished = await page.request.post(`${url}/api/release`);
  if (!finished.ok()) throw new Error(await finished.text());
  await page.getByTestId('node-status').filter({ hasText: '待处理' }).waitFor();
  await page.getByTestId('edit-draft').click();
  await page.locator('#draft-text').fill('企业名称、统一社会信用代码。');
  await page.locator('#draft-dialog').waitFor();
  await page.screenshot({ path: shot('draft') });
  await page.locator('#draft-save').click();
  await page.getByTestId('draft').filter({ hasText: '尚未交付' }).waitFor();

  await page.locator('#message').fill('跑到一半丢掉入口');
  await page.getByTestId('primary').click();
  await page.getByTestId('node-status').filter({ hasText: '启动中' }).waitFor();
  const again = await page.request.post(`${url}/api/release`);
  if (!again.ok()) throw new Error(await again.text());
  await page.getByTestId('node-status').filter({ hasText: '执行中' }).waitFor();
  const dropped = await page.request.post(`${url}/api/test/drop-entry`);
  if (!dropped.ok()) throw new Error(await dropped.text());
  await page.getByTestId('stop').click();
  await page.getByTestId('node-status').filter({ hasText: '节点记录异常' }).waitFor();
  await page.screenshot({ path: shot('record-abnormal') });

  const faultDir = mkdtempSync(path.join(tmpdir(), 'zhuma-wp03-fault-'));
  const faultDemo = startDemo(faultDir);
  let faultPage;
  try {
    const faultUrl = await faultDemo.url;
    faultPage = await browser.newPage({ viewport });
    await faultPage.goto(faultUrl);
    await faultPage.getByTestId('banner').filter({ hasText: '不会自动改用模拟' }).waitFor();
    await faultPage.getByTestId('executor').selectOption('simulated');
    await faultPage.getByTestId('banner').filter({ hasText: '当前是模拟执行器' }).waitFor();
    await faultPage.locator('[data-testid="skill"][value="test-design"]').check();
    await faultPage.locator('[data-testid="skill-chip"][data-id="test-design"]').waitFor();
    await faultPage.locator('#message').fill('写到一半日志不可写');
    await faultPage.getByTestId('primary').click();
    await faultPage.getByTestId('node-status').filter({ hasText: '启动中' }).waitFor();
    const accepted = await faultPage.request.post(`${faultUrl}/api/release`);
    if (!accepted.ok()) throw new Error(await accepted.text());
    await faultPage.getByTestId('node-status').filter({ hasText: '执行中' }).waitFor();
    chmodSync(faultDir, 0o555);
    const blocked = await faultPage.request.post(`${faultUrl}/api/release`);
    if (!blocked.ok()) throw new Error(await blocked.text());
    const fault = faultPage.getByTestId('persistence-fault');
    await fault.waitFor();
    const text = await fault.innerText();
    if (text.includes('/') || text.includes(faultDir)) {
      throw new Error(`故障文字含路径：${text}`);
    }
    if (!text.includes('EACCES')) throw new Error(`故障文字没有错误码：${text}`);
    if ((await faultPage.getByTestId('error').count()) !== 0) {
      throw new Error(
        `同一条故障出现了两次：${await faultPage.getByTestId('error').allInnerTexts()}`,
      );
    }
    await fault.scrollIntoViewIfNeeded();
    await faultPage.screenshot({ path: shot('persistence-fault') });
  } finally {
    chmodSync(faultDir, 0o755);
    rmSync(faultDir, { recursive: true, force: true });
    faultDemo.child.kill();
    if (faultPage) await faultPage.close();
  }
} finally {
  await browser.close();
  demo.child.kill();
  rmSync(sessionDir, { recursive: true, force: true });
}
