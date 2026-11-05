import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { importOrders } from './src/import-orders.mjs';

const limit = 64 * 1024;
const files = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
]);

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export function createApp() {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && files.has(request.url)) {
        const [file, type] = files.get(request.url);
        response.writeHead(200, {
          'Content-Type': type,
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(await readFile(new URL(file, import.meta.url)));
        return;
      }
      if (request.url !== '/api/import' || request.method !== 'POST') {
        request.resume();
        json(response, 404, { error: 'NOT_FOUND' });
        return;
      }
      const type = request.headers['content-type']?.split(';')[0].trim();
      if (type !== 'application/json' && type !== 'text/csv') {
        request.resume();
        json(response, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > limit) {
          request.resume();
          json(response, 413, { error: 'BODY_TOO_LARGE' });
          return;
        }
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let csv = text;
      if (type === 'application/json') {
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          json(response, 400, { error: 'INVALID_JSON' });
          return;
        }
        if (typeof value?.csv !== 'string') {
          json(response, 400, { error: 'CSV_REQUIRED' });
          return;
        }
        csv = value.csv;
      }
      json(response, 200, importOrders(csv));
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'INTERNAL_ERROR' });
      else response.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length && (arguments_.length !== 2 || arguments_[0] !== '--port'))
    throw new Error('Usage: node server.mjs [--port 4179]');
  const port = arguments_.length ? Number(arguments_[1]) : 4179;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const server = createApp();
  server.listen(port, '127.0.0.1', () =>
    console.log(`Order import preview: http://127.0.0.1:${server.address().port}`),
  );
}
