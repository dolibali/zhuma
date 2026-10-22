import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// Static test harness only. RPC responses are intercepted per test; no Host or model is started.
const options = {
  entryPoints: [fileURLToPath(new URL('./harness.jsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
};
const bundle = await build({ ...options, define: { 'process.env.NODE_ENV': '"production"' } });
// Explicit development bundle exercises React StrictMode effect replay in creation tests.
const strictBundle = await build({
  ...options,
  define: { 'process.env.NODE_ENV': '"development"' },
});
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zhuma browser contract fixture</title>
<style>html,body,#root{margin:0;height:100%}body{background:var(--zm-paper)}</style>
<div id="root"></div><script type="module" src="/harness.js"></script></html>`;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && pathname === '/health') {
    response.writeHead(200).end('browser-contract-fixture');
  } else if (request.method === 'GET' && pathname === '/') {
    const strict = new URL(request.url, 'http://127.0.0.1').searchParams.has('strict');
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(strict ? html.replace('/harness.js', '/harness-dev.js') : html);
  } else if (request.method === 'GET' && pathname === '/harness.js') {
    response
      .writeHead(200, { 'content-type': 'text/javascript' })
      .end(bundle.outputFiles[0].contents);
  } else if (request.method === 'GET' && pathname === '/harness-dev.js') {
    response
      .writeHead(200, { 'content-type': 'text/javascript' })
      .end(strictBundle.outputFiles[0].contents);
  } else {
    response.writeHead(404).end('No real API is available in the browser contract harness.');
  }
});
server.listen(Number(process.env.ZHUMA_UI_TEST_PORT ?? 8796), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit()));
