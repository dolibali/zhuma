import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EfficiencyExportControls } from '../dist/execution/EfficiencyExport.js';
import { readEfficiencyExport } from '../dist/execution/efficiency-export.js';

test('requests the efficiency export and checks the document shape', async () => {
  let body;
  const fetcher = async (url, init) => {
    assert.equal(url, '/api/zhuma-efficiency/export');
    assert.equal(init.method, 'POST');
    body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            format: 'csv',
            filename: 'efficiency-metrics.csv',
            document: 'taskId,planId,revision,nodeId,metric,label,value,unit\n',
            metricCount: 0,
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const exported = await readEfficiencyExport(fetcher, 'csv', 'task');
  assert.equal(body.method, 'zhuma-efficiency/export');
  assert.equal(body.type, 'client-request');
  assert.deepEqual(body.payload, { format: 'csv', taskId: 'task' });
  assert.equal(exported.filename, 'efficiency-metrics.csv');
  assert.match(exported.document, /^taskId,/);
});

test('shows one closed export menu without requesting data or displaying a dashboard', () => {
  const html = renderToStaticMarkup(
    createElement(EfficiencyExportControls, {
      fetcher: async () => {
        throw new Error('unused');
      },
    }),
  );
  assert.match(html, /aria-label="导出"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(html, /导出效率 JSON|导出效率 CSV/);
  assert.equal(html.includes('看板'), false);
});
