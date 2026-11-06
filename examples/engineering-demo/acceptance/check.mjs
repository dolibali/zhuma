import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== '--project')
  throw new Error('Usage: node /frozen/acceptance/check.mjs --project /isolated/order-import');
const project = resolve(arguments_[1]);
const verifierRoot = new URL('../', import.meta.url);
const checks = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = (file) => readFile(new URL(`fixtures/${file}`, verifierRoot));
const { importOrders } = await import(pathToFileURL(resolve(project, 'src/import-orders.mjs')));
const { createApp } = await import(pathToFileURL(resolve(project, 'server.mjs')));
const header = 'order_id,customer,quantity,unit_price';
const basic = (await fixture('basic.csv')).toString('utf8');
const basicReport = {
  orders: [
    { orderId: 'ORD-1001', customer: '林可', quantity: 2, unitPriceCents: 1230, totalCents: 2460 },
    { orderId: 'ORD-1002', customer: '陈宁', quantity: 1, unitPriceCents: 10, totalCents: 10 },
  ],
  errors: [],
  summary: { rows: 2, accepted: 2, rejected: 0, totalCents: 2470 },
};
const check = async (id, action) => {
  try {
    await action();
    checks.push({ id, status: 'passed' });
  } catch (error) {
    checks.push({ id, status: 'failed', diagnostic: error.message });
  }
};

await check('KEEP-1: exact baseline report, cents and CRLF', () => {
  assert.deepEqual(importOrders(basic), basicReport);
  assert.deepEqual(importOrders(basic.replaceAll('\n', '\r\n')), basicReport);
});
await check('KEEP-2: row validation and partial success', () => {
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
await check('R-1/S-1: leading UTF-8 BOM is accepted', () => {
  assert.deepEqual(importOrders(`\uFEFF${basic}`), basicReport);
});
await check('R-2/S-2: blank records ignored, physical line numbers preserved', async () => {
  const report = importOrders((await fixture('blank-lines.csv')).toString('utf8'));
  assert.deepEqual(report.summary, { rows: 2, accepted: 1, rejected: 1, totalCents: 2460 });
  assert.deepEqual(
    report.errors.map(({ line, code }) => ({ line, code })),
    [{ line: 5, code: 'INVALID_QUANTITY' }],
  );
  assert.equal(importOrders(` \t\n${header}\n \t\nA,林可,1,1.00\n  \n`).summary.accepted, 1);
});
await check(
  'R-3/S-3: duplicate trimmed order ID rejected; invalid first does not reserve ID',
  async () => {
    const report = importOrders((await fixture('duplicates.csv')).toString('utf8'));
    assert.deepEqual(
      report.orders.map((order) => order.orderId),
      ['ORD-1001', 'ORD-1002'],
    );
    assert.deepEqual(
      report.errors.map(({ line, code }) => ({ line, code })),
      [
        { line: 3, code: 'DUPLICATE_ORDER' },
        { line: 4, code: 'INVALID_QUANTITY' },
      ],
    );
    assert.deepEqual(report.summary, { rows: 4, accepted: 2, rejected: 2, totalCents: 2760 });
    assert.equal(importOrders(`${header}\nCase,林可,1,1.00\ncase,陈宁,1,1.00`).summary.accepted, 2);
  },
);
await check(
  'R-5/S-5: CSV parsing and business validation are separate reusable modules',
  async () => {
    const { parseCsv } = await import(pathToFileURL(resolve(project, 'src/csv.mjs')));
    const { validateOrders } = await import(pathToFileURL(resolve(project, 'src/validation.mjs')));
    const records = parseCsv(`\uFEFF${header}\n \t\nA,林可,1,0.10\n`);
    assert.deepEqual(records, [
      { line: 1, values: ['order_id', 'customer', 'quantity', 'unit_price'] },
      { line: 3, values: ['A', '林可', '1', '0.10'] },
    ]);
    assert.deepEqual(validateOrders(parseCsv(basic)), basicReport);
    assert.deepEqual(validateOrders(parseCsv(basic)), importOrders(basic));
  },
);

const server = createApp();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const post = (type, body) =>
  fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body,
    signal: AbortSignal.timeout(5000),
  });
try {
  await check('KEEP-3: legacy JSON and raw CSV remain equal on real HTTP', async () => {
    const legacy = await post('application/json', JSON.stringify({ csv: basic }));
    const raw = await post('text/csv; charset=utf-8', basic);
    assert.equal(legacy.status, 200);
    assert.equal(raw.status, 200);
    assert.deepEqual(await legacy.json(), basicReport);
    assert.deepEqual(await raw.json(), basicReport);
  });
  await check('R-1/S-1-HTTP: BOM bytes and JSON string both preview normally', async () => {
    const bytes = await fixture('bom.csv');
    for (const [type, body] of [
      ['text/csv', bytes],
      ['application/json', JSON.stringify({ csv: `\uFEFF${basic}` })],
    ]) {
      const response = await post(type, body);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), basicReport);
    }
  });
  await check(
    'R-4/S-4: malformed UTF-8 is HTTP 400, never replacement-character success',
    async () => {
      const bad = await fixture('invalid-utf8.csv');
      assert.deepEqual(
        bad,
        Buffer.from((await fixture('invalid-utf8.hex')).toString('utf8').trim(), 'hex'),
      );
      const response = await post('text/csv', bad);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'INVALID_UTF8' });
      const badJson = Buffer.concat([
        Buffer.from('{"csv":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}'),
      ]);
      const jsonResponse = await post('application/json', badJson);
      assert.equal(jsonResponse.status, 400);
      assert.deepEqual(await jsonResponse.json(), { error: 'INVALID_UTF8' });
    },
  );
  await check('KEEP-4: transport errors and public-file allowlist remain bounded', async () => {
    assert.equal((await post('application/json', '{')).status, 400);
    assert.deepEqual(await (await post('application/json', '{}')).json(), {
      error: 'CSV_REQUIRED',
    });
    assert.equal((await post('text/plain', basic)).status, 415);
    assert.equal((await post('text/csv', 'x'.repeat(65537))).status, 413);
    assert.equal((await fetch(`${base}/src/import-orders.mjs`)).status, 404);
  });
} finally {
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
}

const sourceDigests = {};
async function recordFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await recordFiles(path);
    else if (entry.isFile())
      sourceDigests[relative(project, path).replaceAll('\\', '/')] = hash(await readFile(path));
  }
}
for (const directory of ['src', 'public']) await recordFiles(resolve(project, directory));
for (const file of ['server.mjs', 'package.json'])
  sourceDigests[file] = hash(await readFile(resolve(project, file)));
const failed = checks.filter((entry) => entry.status === 'failed').length;
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      readiness: failed ? 'not-ready' : 'checks-passed-review-pending',
      generatedAt: new Date().toISOString(),
      node: process.version,
      cwd: process.cwd(),
      argv: process.argv,
      project,
      verifier: {
        path: fileURLToPath(import.meta.url),
        sha256: hash(await readFile(fileURLToPath(import.meta.url))),
        fixtureDigests: Object.fromEntries(
          await Promise.all(
            [
              'basic.csv',
              'bom.csv',
              'blank-lines.csv',
              'duplicates.csv',
              'invalid-utf8.hex',
              'invalid-utf8.csv',
            ].map(async (file) => [file, hash(await fixture(file))]),
          ),
        ),
      },
      sourceDigests,
      checks,
      passed: checks.length - failed,
      failed,
      boundary:
        'Real Node/loopback checks only. No model, GUI, formal review, deployment or efficiency claim. Frozen verifier is a review convention, not an OS sandbox.',
    },
    null,
    2,
  ),
);
process.exitCode = failed ? 1 : 0;
