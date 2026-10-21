#!/usr/bin/env node
/** Read-only CDP smoke check of our packaged app's loaded branding, not a screenshot mockup. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyIconAssets } from './icon-assets.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = Number(process.argv[2] ?? 9333);
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
const manifest = verifyIconAssets(root);
const targets = await (
  await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
).json();
const target = targets.find(
  (entry) => entry.type === 'page' && entry.title === 'Zhuma' && entry.url === 'dsh-app://app/',
);
assert.ok(target, 'The Zhuma workspace page is not running');
assert.equal(
  targets.some((entry) => entry.type === 'page' && /welcome\.html/u.test(entry.url)),
  false,
  'Unexpected login welcome window',
);
const address = new URL(target.webSocketDebuggerUrl);
assert.ok(
  ['127.0.0.1', 'localhost'].includes(address.hostname),
  'Only connect to the local debugger',
);
const ws = new WebSocket(address);
await new Promise((resolveReady, reject) => {
  const timeout = setTimeout(() => reject(new Error('CDP handshake timeout')), 5000);
  ws.addEventListener(
    'open',
    () => {
      clearTimeout(timeout);
      resolveReady();
    },
    { once: true },
  );
  ws.addEventListener(
    'error',
    () => {
      clearTimeout(timeout);
      reject(new Error('CDP connection failed'));
    },
    { once: true },
  );
});
let nextId = 0;
async function call(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolveCall, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', listener);
      reject(new Error(`${method} timed out`));
    }, 12000);
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timeout);
      ws.removeEventListener('message', listener);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolveCall(message.result);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const evaluation = await call('Runtime.evaluate', {
    expression: `(async () => {
      const icons = [...document.images].filter((image) => image.alt === 'Zhuma');
      return { title: document.title, pixelRatio: devicePixelRatio, icons: await Promise.all(icons.map(async (image) => {
        await image.decode();
        const bytes = await (await fetch(image.currentSrc, { cache: 'reload' })).arrayBuffer();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
        const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        // Sample the actual displayed <img>, not only a fresh fetch that could hide stale pixels.
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const alphaAt = (x,y) => rgba[(y * canvas.width + x) * 4 + 3];
        const cornerAlpha = [[0,0], [canvas.width-1,0], [0,canvas.height-1], [canvas.width-1,canvas.height-1]].map(([x,y]) => alphaAt(x,y));
        const centerAlpha = alphaAt(Math.floor(canvas.width/2), Math.floor(canvas.height/2));
        bitmap.close();
        return { src: image.currentSrc, displayedWidth: image.width, naturalWidth: image.naturalWidth,
          sha256: hash, cornerAlpha, centerAlpha, background: getComputedStyle(image).backgroundColor,
          borderRadius: getComputedStyle(image).borderRadius, filter: getComputedStyle(image).filter, boxShadow: getComputedStyle(image).boxShadow };
      })) };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(evaluation.exceptionDetails, undefined, 'Renderer evaluation failed');
  const result = evaluation.result.value;
  assert.equal(result.title, 'Zhuma');
  assert.ok(result.icons.length >= 2, 'Sidebar and hero must both show Zhuma');
  for (const image of result.icons) {
    const path = new URL(image.src).pathname;
    const expected = manifest.outputs.find((entry) => path.endsWith(`/icon-${entry.width}.png`));
    assert.ok(expected, `Unknown icon: ${path}`);
    assert.equal(image.sha256, expected.sha256, 'Running UI is serving an old or modified image');
    assert.deepEqual(
      image.cornerAlpha,
      [0, 0, 0, 0],
      'Black matte: actual loaded UI image must have transparent corners',
    );
    assert.equal(image.centerAlpha, 255, 'The inner artwork must stay opaque');
    assert.equal(
      image.background,
      'rgba(0, 0, 0, 0)',
      'No CSS background may reintroduce a black tile',
    );
    assert.equal(image.boxShadow, 'none', 'No extra UI shadow around the mark');
    assert.equal(image.filter, 'none', 'Do not recolor the approved art with CSS');
    assert.equal(image.borderRadius, '0px', 'Do not apply an additional clipping mask');
  }
  const output = join(root, '.artifacts/icon-fix');
  mkdirSync(output, { recursive: true });
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(join(output, 'zhuma-fixed-window.png'), Buffer.from(screenshot.data, 'base64'));
  writeFileSync(
    join(output, 'runtime-icon-verification.json'),
    JSON.stringify(
      {
        originalSha256: manifest.source.sha256,
        transparentMasterSha256: manifest.master.sha256,
        ...result,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(
    'Actual sidebar and hero load verified transparent exports, with no CSS black background. Screenshot recorded.',
  );
} finally {
  ws.close();
}
