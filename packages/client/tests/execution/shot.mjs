import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const out = fileURLToPath(new URL('../../../../docs/contracts/evidence/', import.meta.url));
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['packages/client/tests/execution/preview.tsx'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>执行待办样例</title>
<style>html,body,#root{margin:0}body{background:var(--zm-paper,#fff)}</style>
<div id="root"></div><script type="module" src="/preview.js"></script>`;
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/preview.js') {
    response
      .writeHead(200, { 'content-type': 'text/javascript' })
      .end(bundle.outputFiles[0].contents);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
await page.goto(`http://127.0.0.1:${port}/`);
await page.getByRole('heading', { name: '需要我处理' }).waitFor();
await page.getByText('登录接口接受邮箱和密码').waitFor();
await mkdir(out, { recursive: true });
await page.screenshot({ path: `${out}/b-m1-execution-light.png`, fullPage: true });
await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
await page.screenshot({ path: `${out}/b-m1-execution-dark.png`, fullPage: true });
await browser.close();
server.close();
console.log(out);
