const form = document.querySelector('#import-form');
const fileInput = document.querySelector('#file');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const money = (cents) => `¥${(cents / 100).toFixed(2)}`;
let report;

fileInput.addEventListener('change', () => {
  report = undefined;
  result.hidden = true;
  status.textContent = fileInput.files[0]?.name ?? '尚未选择文件';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  report = undefined;
  result.hidden = true;
  const button = document.querySelector('#preview');
  button.disabled = true;
  fileInput.disabled = true;
  status.textContent = '正在预览…';
  try {
    const response = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: await file.arrayBuffer(),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? '请求失败');
    report = body;
    const { summary } = report;
    document.querySelector('#summary').textContent =
      `${summary.rows} 条记录 · 可导入 ${summary.accepted} · 需修正 ${summary.rejected} · 总金额 ${money(summary.totalCents)}`;
    const rows = report.orders.map((order) => {
      const row = document.createElement('tr');
      for (const value of [
        order.orderId,
        order.customer,
        order.quantity,
        money(order.unitPriceCents),
        money(order.totalCents),
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    });
    document.querySelector('#orders').replaceChildren(...rows);
    document.querySelector('#errors').replaceChildren(
      ...report.errors.map((error) => {
        const item = document.createElement('li');
        item.textContent = error.message;
        return item;
      }),
    );
    document.querySelector('#error-section').hidden = report.errors.length === 0;
    result.hidden = false;
    status.textContent = '预览完成';
  } catch (error) {
    status.textContent = `预览失败：${error.message}`;
  } finally {
    button.disabled = false;
    fileInput.disabled = false;
  }
});

document.querySelector('#download').addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'order-import-report.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
