import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

test('B-5: real loopback HTTP keeps legacy JSON, raw CSV and transport errors', async (context) => {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const csv = 'order_id,customer,quantity,unit_price\nA,林可,2,0.10';
  const post = (type, body) =>
    fetch(`${base}/api/import`, { method: 'POST', headers: { 'Content-Type': type }, body });
  const legacy = await post('application/json', JSON.stringify({ csv }));
  assert.equal(legacy.status, 200);
  const raw = await post('text/csv; charset=utf-8', csv);
  assert.equal(raw.status, 200);
  assert.deepEqual(await legacy.json(), await raw.json());
  assert.equal((await post('application/json', '{')).status, 400);
  assert.deepEqual(await (await post('application/json', '{}')).json(), { error: 'CSV_REQUIRED' });
  assert.equal((await post('text/plain', csv)).status, 415);
  assert.equal((await post('text/csv', 'x'.repeat(65537))).status, 413);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /订单导入预览/);
  assert.equal((await fetch(`${base}/src/import-orders.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/api/import`)).status, 404);
});
