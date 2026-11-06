import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { importOrders } from '../src/import-orders.mjs';

const header = 'order_id,customer,quantity,unit_price';

test('B-1: baseline UTF-8 Chinese rows and integer cents stay exact', async () => {
  const text = await readFile(new URL('../fixtures/basic.csv', import.meta.url), 'utf8');
  const report = importOrders(text);
  assert.deepEqual(report, {
    orders: [
      {
        orderId: 'ORD-1001',
        customer: '林可',
        quantity: 2,
        unitPriceCents: 1230,
        totalCents: 2460,
      },
      { orderId: 'ORD-1002', customer: '陈宁', quantity: 1, unitPriceCents: 10, totalCents: 10 },
    ],
    errors: [],
    summary: { rows: 2, accepted: 2, rejected: 0, totalCents: 2470 },
  });
  assert.deepEqual(importOrders(text.replaceAll('\n', '\r\n')), report);
});

test('B-2: row errors keep physical lines and do not discard valid rows', () => {
  const report = importOrders(
    `${header}\nA,林可,1,0.10\nB,陈宁,0,1.00\nC,周禾,1,1.234\nD,林可,1,2.00`,
  );
  assert.deepEqual(
    report.errors.map(({ line, code }) => ({ line, code })),
    [
      { line: 3, code: 'INVALID_QUANTITY' },
      { line: 4, code: 'INVALID_PRICE' },
    ],
  );
  assert.deepEqual(report.summary, { rows: 4, accepted: 2, rejected: 2, totalCents: 210 });
});

test('B-3: missing fields, column count, unsafe quantity and amount remain invalid', () => {
  const rows = [
    'A,,1,1.00',
    'A,林可,1',
    'B,林可,9007199254740992,1.00',
    'C,林可,9007199254740991,2.00',
  ];
  assert.deepEqual(
    importOrders(`${header}\n${rows.join('\n')}`).errors.map((error) => error.code),
    ['REQUIRED_FIELD', 'INVALID_COLUMNS', 'INVALID_QUANTITY', 'AMOUNT_OVERFLOW'],
  );
});

test('B-4: empty/header-only input and exact header contract remain deterministic', () => {
  assert.equal(importOrders('').errors[0].code, 'INVALID_HEADER');
  assert.deepEqual(importOrders(header).summary, {
    rows: 0,
    accepted: 0,
    rejected: 0,
    totalCents: 0,
  });
  assert.equal(
    importOrders('customer,order_id,quantity,unit_price').errors[0].code,
    'INVALID_HEADER',
  );
});
