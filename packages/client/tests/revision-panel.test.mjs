import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RevisionPanel } from '../dist/execution/RevisionPanel.js';
import { revisionView } from './revision-fixture.mjs';

const render = (props) => renderToStaticMarkup(createElement(RevisionPanel, props));
test('revision panel SSR: fixed reviewed version, named history and literal citation IDs; metadata never advertises a preview', () => {
  const html = render({ view: revisionView(), reload() {} });
  for (const text of [
    '增加 status 筛选',
    '林夏',
    '质量专家',
    '本次退回',
    '历史退回',
    'comment-auth',
    'file-contract-v2',
    'text/markdown',
    '本次查询未提供文件预览。',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('接口初稿：GET'));
  assert.ok(!html.includes('不属于被退回轮次'));
  assert.ok(!html.includes('download='));
  assert.ok(!html.includes('href="#comment'));
  assert.ok(!html.includes('<iframe'));
});

test('revision panel SSR: unsafe links stay text, safe links are isolated, contents are escaped', () => {
  const view = revisionView();
  view.reviewed.links.push('javascript:alert(1)', 'https://user:password@example.test/');
  view.reviewed.text = '<script>unsafe</script>';
  const html = render({ view });
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="https://user:'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
});

test('revision panel SSR: pending and failed reads do not expose a stale version', () => {
  for (const state of [{ pending: true }, { error: '读取失败，请重试。' }]) {
    const html = render({ view: revisionView(), reload() {}, ...state });
    assert.ok(!html.includes('增加 status 筛选'));
    assert.ok(!html.includes('comment-auth'));
  }
  assert.ok(render({ error: '读取失败，请重试。', reload() {} }).includes('重试读取'));
});

test('revision panel SSR: unavailable content and old references have no invented locator', () => {
  const view = revisionView();
  delete view.reviewed;
  delete view.previous;
  const html = render({ view });
  assert.ok(html.includes('被退回的版本暂不可用'));
  assert.ok(html.includes('未返回上一版'));
  assert.ok(html.includes('该版本正文未返回'));
  assert.ok(!html.includes('查看引用版本'));
});

test('revision panel SSR: parallel panels use unique semantic IDs', () => {
  const html = renderToStaticMarkup(
    createElement(
      'div',
      {},
      createElement(RevisionPanel, { view: revisionView() }),
      createElement(RevisionPanel, { view: revisionView() }),
    ),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length >= 6);
  assert.equal(new Set(ids).size, ids.length);
});
