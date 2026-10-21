/** Decode our 8-bit non-interlaced RGBA PNGs for CI checks without native packages. */
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

export function decodeRgbaPng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0 && width <= 2048 && height <= 2048);
  assert.deepEqual(
    [...bytes.subarray(24, 29)],
    [8, 6, 0, 0, 0],
    'Expected RGBA8 non-interlaced PNG',
  );
  const chunks = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= bytes.length, 'Truncated PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === 'IEND') break;
  }
  const stride = width * 4;
  const expectedSize = height * (stride + 1);
  const encoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: expectedSize });
  assert.equal(encoded.length, expectedSize);
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = encoded[y * (stride + 1)];
    assert.ok(filter <= 4, 'Unknown PNG row filter');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= 4 ? pixels[at - 4] : 0;
      const up = y > 0 ? pixels[at - stride] : 0;
      const upperLeft = x >= 4 && y > 0 ? pixels[at - stride - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const dl = Math.abs(estimate - left);
        const du = Math.abs(estimate - up);
        const dul = Math.abs(estimate - upperLeft);
        predictor = dl <= du && dl <= dul ? left : du <= dul ? up : upperLeft;
      }
      pixels[at] = (encoded[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

export function assertTransparentExterior(image, label) {
  const { width, height, pixels } = image;
  const alpha = (x, y) => pixels[(y * width + x) * 4 + 3];
  for (let x = 0; x < width; x++) {
    assert.equal(alpha(x, 0), 0, `${label}: top edge is not transparent`);
    assert.equal(alpha(x, height - 1), 0, `${label}: bottom edge is not transparent`);
  }
  for (let y = 0; y < height; y++) {
    assert.equal(alpha(0, y), 0, `${label}: left edge is not transparent`);
    assert.equal(alpha(width - 1, y), 0, `${label}: right edge is not transparent`);
  }
  assert.equal(
    alpha(Math.floor(width / 2), Math.floor(height / 2)),
    255,
    `${label}: the original dark interior must remain opaque`,
  );
}
