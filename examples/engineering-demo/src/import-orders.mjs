const header = ['order_id', 'customer', 'quantity', 'unit_price'];

/** Baseline dialect: comma-separated fields, no quoting or embedded newlines. */
export function importOrders(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (
    !header.every((value, index) => lines[0]?.split(',')[index] === value) ||
    lines[0]?.split(',').length !== 4
  ) {
    return {
      orders: [],
      errors: [
        {
          line: 1,
          code: 'INVALID_HEADER',
          message: '表头应为 order_id,customer,quantity,unit_price',
        },
      ],
      summary: { rows: 0, accepted: 0, rejected: 0, totalCents: 0 },
    };
  }
  const orders = [],
    errors = [];
  for (let index = 1; index < lines.length; index += 1) {
    const fields = lines[index].split(',').map((value) => value.trim());
    const [orderId, customer, quantityText, priceText] = fields;
    let code;
    if (fields.length !== 4) code = 'INVALID_COLUMNS';
    else if (!orderId || !customer) code = 'REQUIRED_FIELD';
    else if (!/^[1-9]\d*$/.test(quantityText) || !Number.isSafeInteger(Number(quantityText)))
      code = 'INVALID_QUANTITY';
    else if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(priceText)) code = 'INVALID_PRICE';
    const quantity = Number(quantityText);
    const [whole, fraction = ''] = (priceText ?? '').split('.');
    const unitPriceCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    const totalCents = unitPriceCents * quantity;
    if (
      !code &&
      (!Number.isSafeInteger(unitPriceCents) ||
        !Number.isSafeInteger(totalCents) ||
        !Number.isSafeInteger(
          orders.reduce((sum, order) => sum + order.totalCents, 0) + totalCents,
        ))
    )
      code = 'AMOUNT_OVERFLOW';
    if (code) {
      errors.push({ line: index + 1, code, message: `第 ${index + 1} 行：${code}` });
      continue;
    }
    orders.push({ orderId, customer, quantity, unitPriceCents, totalCents });
  }
  return {
    orders,
    errors,
    summary: {
      rows: lines.length - 1,
      accepted: orders.length,
      rejected: errors.length,
      totalCents: orders.reduce((sum, order) => sum + order.totalCents, 0),
    },
  };
}
