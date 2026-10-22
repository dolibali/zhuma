import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts =
  process.env.ZHUMA_BROWSER_ARTIFACTS ?? path.join(tmpdir(), 'zhuma-browser-artifacts');

test('浏览器：模拟执行器覆盖打开处理、两轮修改、刷新、补充排队、停止与迟到结果', async () => {
  mkdirSync(artifacts, { recursive: true });
  const sessionDir = mkdtempSync(path.join(tmpdir(), 'zhuma-browser-'));
  const child = spawn(process.execPath, ['examples/agent-workspace/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
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
  const url = await new Promise((resolve, reject) => {
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
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(url);
    await page.getByTestId('banner').filter({ hasText: '不会自动改用模拟' }).waitFor();
    await page.route('**/api/workspace', (route) => route.abort());
    await page.getByTestId('banner').filter({ hasText: '页面与服务断开' }).waitFor();
    await page.unroute('**/api/workspace');
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="banner"]')?.textContent?.includes('页面与服务断开'),
    );
    assert.match(
      await page.locator('[data-testid="expert"] option[value="api-impl"]').innerText(),
      /整理接口字段与校验/,
    );
    assert.equal(await page.getByTestId('primary').isDisabled(), true);
    assert.equal(await fitsViewport(page), true);
    await page.screenshot({ path: path.join(artifacts, 'wp03-config-1280.png') });

    await page.getByTestId('executor').selectOption('simulated');
    await page.getByTestId('banner').filter({ hasText: '当前是模拟执行器' }).waitFor();
    assert.equal(await page.getByTestId('primary').isDisabled(), false);
    await page.getByTestId('skill-search').fill('测试');
    await page.locator('[data-testid="skill"][value="test-design"]').check();
    await page.locator('[data-testid="skill-chip"][data-id="test-design"]').waitFor();
    await page.getByTestId('skill-search').fill('代码');
    await page.locator('[data-testid="skill"][value="review-code"]').check();
    await page.locator('[data-testid="skill-chip"][data-id="review-code"]').waitFor();
    await page.getByTestId('skill-search').fill('');
    assert.equal(await page.locator('[data-testid="skill"][value="legacy"]').isDisabled(), true);
    await page.getByTestId('mcp-search').fill('接口');
    await page.locator('[data-testid="mcp"][value="api-docs"]').check();
    await page.locator('[data-testid="mcp-chip"][data-id="api-docs"]').waitFor();
    await page.getByTestId('mcp-search').fill('工单');
    await page.locator('[data-testid="mcp"][value="issue-search"]').check();
    await page.locator('[data-testid="mcp-chip"][data-id="issue-search"]').waitFor();
    await page.getByTestId('mcp-search').fill('');
    assert.equal(await page.locator('[data-testid="mcp"][value="billing"]').isDisabled(), true);
    await page.route('**/api/messages', (route) => route.abort());
    await page.locator('#message').fill('这条发送到不了');
    await page.getByTestId('primary').click();
    await page.getByTestId('error').filter({ hasText: '页面与服务断开' }).waitFor();
    assert.equal((await page.locator('body').innerText()).includes('Failed to fetch'), false);
    await page.unroute('**/api/messages');
    assert.match(
      await page.locator('[data-testid="mcp"][value="billing"]').locator('..').innerText(),
      /没有工具授权/,
    );
    await page.locator('#file').setInputFiles({
      name: 'fields.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('字段,必填\n企业名称,是\n'),
    });
    const attachment = page.getByTestId('attachment').filter({ hasText: 'fields.csv' });
    await attachment.waitFor();
    assert.match(await attachment.innerText(), /企业名称/);

    await page.locator('[data-testid="context"][value="missing"]').check();
    await send(page, '带上不存在的映射表');
    await page.getByTestId('error').filter({ hasText: '外部映射表' }).waitFor();
    assert.equal((await workspace(page)).runs.length, 0);
    await page.locator('[data-testid="context"][value="missing"]').uncheck();

    await send(page, '第一轮：整理开户必填字段');
    await waitRunning(page);
    await page.screenshot({ path: path.join(artifacts, 'wp03-running-1280.png') });
    await page.route('**/api/workspace', (route) => route.abort());
    await page.getByTestId('banner').filter({ hasText: '页面与服务断开' }).waitFor();
    await page.unroute('**/api/workspace');
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="banner"]')?.textContent?.includes('页面与服务断开'),
    );
    await release(page);
    await waitStatus(page, '待处理');
    await page.getByTestId('activity').filter({ hasText: '没有调用真实模型' }).waitFor();
    const visible = await page.locator('body').innerText();
    assert.equal(visible.includes('node-fields'), false);
    assert.equal(visible.includes('attachment:'), false);
    assert.equal(visible.includes('goal:'), false);
    assert.equal(
      await page.getByTestId('activity').first().getAttribute('data-succeeded'),
      'false',
    );
    assert.equal((await workspace(page)).node.status, 'ready');
    assert.equal((await workspace(page)).runs.length, 1);

    await send(page, '第二轮：补充统一社会信用代码的校验');
    await waitRunning(page);
    await release(page);
    await waitStatus(page, '待处理');
    assert.equal((await workspace(page)).runs.length, 2);

    const beforeReload = (await workspace(page)).runs.length;
    await page.reload();
    await userTurn(page, '第一轮：整理开户必填字段').waitFor();
    await userTurn(page, '第二轮：补充统一社会信用代码的校验').waitFor();
    assert.equal((await workspace(page)).runs.length, beforeReload);

    await page.getByTestId('expert').selectOption('reviewer');
    await userTurn(page, '第一轮：整理开户必填字段').waitFor();
    await userTurn(page, '第二轮：补充统一社会信用代码的校验').waitFor();

    await page.setViewportSize({ width: 1920, height: 1080 });
    assert.equal(await fitsViewport(page), true);
    await page.getByTestId('edit-draft').click();
    await page.locator('#draft-text').fill('企业名称、统一社会信用代码。');
    await page.getByRole('button', { name: '保存草稿' }).click();
    const draft = page.getByTestId('draft').filter({ hasText: '尚未交付' });
    await draft.waitFor();
    await draft.scrollIntoViewIfNeeded();
    const drafted = await workspace(page);
    assert.equal(drafted.drafts.at(-1).autoDeliver, false);
    assert.equal(drafted.drafts.at(-1).skipReview, false);
    assert.equal(drafted.delivered, false);
    assert.equal(drafted.downstreamLaunches, 0);
    assert.equal(drafted.node.status, 'ready');
    await page.screenshot({ path: path.join(artifacts, 'wp03-draft-1920.png') });

    await page.setViewportSize({ width: 1280, height: 800 });
    await send(page, '第三轮：运行中再改一版');
    await waitRunning(page);
    const runningId = await page.getByTestId('active-run').getAttribute('data-run-id');
    await page.locator('#message').fill('补充：开户日期不必填');
    await page.getByTestId('intent').selectOption('supplement');
    await page.getByTestId('primary').click();
    const notice = page.getByTestId('intervention-notice').filter({ hasText: '实时注入' });
    await notice.waitFor();
    await notice.scrollIntoViewIfNeeded();
    assert.equal(
      await page.locator('[data-testid="phase"][data-phase="sent"]').getAttribute('data-reached'),
      'true',
    );
    assert.equal(
      await page
        .locator('[data-testid="phase"][data-phase="received"]')
        .getAttribute('data-reached'),
      'true',
    );
    assert.equal(
      await page
        .locator('[data-testid="phase"][data-phase="pending"]')
        .getAttribute('data-reached'),
      'true',
    );
    assert.equal(
      await page
        .locator('[data-testid="phase"][data-phase="applied"]')
        .getAttribute('data-reached'),
      'false',
    );
    await page.getByTestId('intervention').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'wp03-queue-1280.png') });

    await page.getByTestId('stop').click();
    await waitStatus(page, '已取消');
    const late = page.getByTestId('late-record').filter({ hasText: '未推进节点' });
    await late.waitFor();
    await late.scrollIntoViewIfNeeded();
    assert.match(await page.getByTestId('downstream').innerText(), /未触发下游/);
    const stopped = await workspace(page);
    assert.equal(stopped.node.status, 'cancelled');
    assert.equal(stopped.downstreamLaunches, 0);
    assert.equal(stopped.delivered, false);
    assert.equal(stopped.lateRecords.at(-1).mayChangeNodeStatus, false);
    assert.equal(stopped.lateRecords.at(-1).mayTriggerDownstream, false);
    await page.screenshot({ path: path.join(artifacts, 'wp03-stopped-1280.png') });

    await page.getByTestId('retry').click();
    await waitRunning(page);
    const retriedId = await page.getByTestId('active-run').getAttribute('data-run-id');
    assert.notEqual(retriedId, '');
    assert.notEqual(retriedId, runningId);
    await release(page);
    await waitStatus(page, '待处理');
    const retried = await workspace(page);
    assert.equal(retried.node.status, 'ready');
    assert.equal(retried.downstreamLaunches, 0);
    assert.equal(retried.delivered, false);

    const beforeTask = retried.runs.length;
    await page.getByRole('link', { name: '返回任务' }).click();
    await page.locator('#task-page').waitFor();
    assert.match(await page.locator('#task-page').innerText(), /不会启动运行/);
    assert.equal((await workspace(page)).runs.length, beforeTask);
    await page.getByRole('link', { name: '打开 Agent 处理' }).click();
    await page.locator('#message').waitFor();
    assert.equal((await workspace(page)).runs.length, beforeTask);

    await page.locator('#message').fill('键盘再发一轮');
    await page.locator('#message').press('Control+Enter');
    await waitRunning(page);
    await release(page);
    await waitStatus(page, '待处理');
    assert.equal((await workspace(page)).runs.length, beforeTask + 1);
    assert.equal(await fitsViewport(page), true);

    const zoomFits = await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
      return document.documentElement.scrollWidth <= window.innerWidth + 1;
    });
    assert.equal(zoomFits, true);
    await page.evaluate(() => {
      document.documentElement.style.zoom = '';
    });

    await send(page, '跑到一半丢掉入口');
    await waitRunning(page);
    const dropped = await page.request.post(api(page, '/api/test/drop-entry'));
    if (!dropped.ok()) throw new Error(await dropped.text());
    await release(page);
    await waitStatus(page, '节点记录异常，需要人工处理');
    const status = page.getByTestId('node-status');
    const statusText = await status.innerText();
    assert.equal(statusText.includes('执行中'), false);
    assert.match(statusText, /节点记录异常，需要人工处理/);
    assert.equal(await status.getAttribute('data-status'), 'record-broken');
    assert.match(await page.getByTestId('error').innerText(), /节点记录异常，需要人工处理/);
    const broken = await workspace(page);
    assert.equal(broken.node.status, 'running');
    assert.equal(broken.runs.at(-1).status, 'failed');
  } finally {
    await browser.close();
    child.kill();
  }
});

function userTurn(page, text) {
  return page.locator('[data-testid="turn"][data-role="user"]').filter({ hasText: text });
}

async function send(page, text) {
  await page.locator('#message').fill(text);
  await page.getByTestId('primary').click();
}

async function waitStatus(page, text) {
  await page.getByTestId('node-status').filter({ hasText: text }).waitFor({ timeout: 20000 });
}

async function waitRunning(page) {
  await waitStatus(page, '启动中');
  const starting = await page.getByTestId('node-status').innerText();
  assert.equal(starting.includes('执行中'), false);
  await release(page);
  await waitStatus(page, '执行中');
}

async function release(page) {
  const response = await page.request.post(api(page, '/api/release'));
  if (!response.ok()) throw new Error(await response.text());
}

async function workspace(page) {
  const response = await page.request.get(api(page, '/api/workspace'));
  return (await response.json()).snapshot;
}

function api(page, pathname) {
  return new URL(pathname, page.url()).toString();
}

async function fitsViewport(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
