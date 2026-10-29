import type { Context } from '@deepseek-ai/cordis';
import { readFile } from 'node:fs/promises';

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Zhuma 工作台</title></head>
<body><div id="zhuma-member-root"></div><script type="module" src="/workbench/app.js"></script></body></html>`;

/** Member presentation is independent of the SDK owner bootstrap/index injections. */
export function openMemberWebEntry(ctx: Context): void {
  ctx.inject(['webServer'], (web) => {
    for (const path of ['/workbench', '/workbench/', '/workbench/app.js']) {
      web.effect(() =>
        web.webServer.register({
          kind: 'exact',
          path,
          async handler(req, res) {
            if (ctx.connection.requestRejection({ headers: req.headers }) === 403) {
              res.writeHead(403);
              res.end();
              return;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD', connection: 'close' });
              res.end();
              return;
            }
            try {
              const script = path.endsWith('.js');
              const body = script
                ? await readFile(new URL('./member-web.js', import.meta.url))
                : html;
              res.writeHead(200, {
                'content-type': script
                  ? 'text/javascript; charset=utf-8'
                  : 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
                'referrer-policy': 'no-referrer',
                'content-security-policy':
                  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
              });
              res.end(req.method === 'HEAD' ? undefined : body);
            } catch {
              res.writeHead(503, { 'cache-control': 'no-store' });
              res.end('Member interface is unavailable.');
            }
          },
        }),
      );
    }
  });
}
