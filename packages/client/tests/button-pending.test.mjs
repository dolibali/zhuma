/** Button loading shape and first-paint shell. Not a desktop GUI proof. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(root, '../src/workbench/workbench.css'), 'utf8');
const { Button } = await import('../dist/workbench/Button.js');
const { WorkbenchPage } = await import('../dist/workbench/WorkbenchPage.js');

function block(selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, selector);
  return css.slice(start, css.indexOf('}', start));
}

test('button loading indicator is a square circular arc and keeps both labels', () => {
  const idle = renderToStaticMarkup(createElement(Button, { children: '登录' }));
  assert.equal(idle.includes('aria-busy'), false);
  assert.match(idle, /class="zm-button-label"/);
  assert.match(idle, /class="zm-button-busy"/);
  const busy = renderToStaticMarkup(
    createElement(Button, {
      busy: true,
      busyLabel: '正在登录…',
      className: 'zm-align-start',
      children: '登录',
    }),
  );
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /zm-align-start/);
  assert.match(busy, /viewBox="0 0 16 16"/);
  assert.match(busy, /width="14" height="14"/);
  assert.match(busy, /<circle[^>]*cx="8"[^>]*cy="8"/);
  assert.match(busy, /正在登录…/);
  assert.match(busy, /zm-button-label[^>]*>登录</);
  const spinner = block('.zm-spinner {');
  for (const rule of [
    'flex: 0 0 14px',
    'width: 14px',
    'height: 14px',
    'min-width: 14px',
    'min-height: 14px',
    'max-width: 14px',
    'max-height: 14px',
    'aspect-ratio: 1',
    'align-self: center',
  ])
    assert.ok(spinner.includes(rule), rule);
  assert.match(css, /\.zm-button \{\n  --zm-button-align: center;/);
  assert.match(css, /justify-content: var\(--zm-button-align, center\)/);
  assert.match(css, /\.zm-button-busy \{\n  flex-wrap: nowrap;/);
  assert.match(css, /\.zm-button\.zm-align-start,\n\.zm-import-items \.zm-button/);
});

test('workbench first paint shows the destination shell before the snapshot returns', () => {
  let reads = 0;
  const html = renderToStaticMarkup(
    createElement(WorkbenchPage, {
      initialSection: 'tasks',
      api: {
        snapshot() {
          reads += 1;
          return new Promise(() => {});
        },
      },
      appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
    }),
  );
  assert.equal(reads, 0);
  assert.match(html, /任务清单/);
  assert.match(html, /zm-boot-skeleton/);
  assert.match(html, /正在连接工作台/);
  assert.match(html, /viewBox="0 0 16 16"/);
  assert.equal(html.includes('aria-label="工作内容"'), false);
});
