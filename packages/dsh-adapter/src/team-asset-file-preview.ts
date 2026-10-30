import { createHash } from 'node:crypto';
import { TeamAssetFileError, type TeamAssetFileDeclare } from './team-asset-file.js';

export const TEAM_ASSET_FILE_RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
});
export type TeamAssetFilePresentation = {
  readonly kind: 'text' | 'image' | 'pdf' | 'download';
  readonly contentType: string;
  readonly disposition: 'inline' | 'attachment';
};
const download = (): TeamAssetFilePresentation => ({
  kind: 'download',
  contentType: 'application/octet-stream',
  disposition: 'attachment',
});
const acceptableImage = (width: number, height: number) =>
  width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000;
function jpegDimensions(data: Buffer): [number, number] | undefined {
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset++] !== 0xff) return;
    while (offset < data.length && data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (length < 8) return;
      return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
}
function imageDimensions(type: string, data: Buffer): [number, number] | undefined {
  if (
    type === 'image/png' &&
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString('ascii', 12, 16) === 'IHDR'
  )
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (
    type === 'image/gif' &&
    data.length >= 10 &&
    ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
  )
    return [data.readUInt16LE(6), data.readUInt16LE(8)];
  if (
    type === 'image/jpeg' &&
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return jpegDimensions(data);
  if (
    type === 'image/webp' &&
    data.length >= 30 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
    if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a)
      return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L' && data[20] === 0x2f) {
      const size = data.readUInt32LE(21);
      return [1 + (size & 0x3fff), 1 + ((size >>> 14) & 0x3fff)];
    }
  }
}

/** Presentation hint after exact byte verification, not a parser, sanitizer or
 * authorization decision. A must retain these restrictive response headers and
 * a sandboxed PDF/document surface; no uploaded HTML/SVG/scripts run inline.
 * Office/archives and unknown or oversized image dimensions stay downloads. */
export function teamAssetFilePresentation(
  file: TeamAssetFileDeclare,
  bytes: Uint8Array,
): TeamAssetFilePresentation {
  if (
    bytes.byteLength !== file.byteSize ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new TeamAssetFileError('unavailable');
  const type = file.mediaType.split(';')[0]!.trim().toLowerCase(),
    data = Buffer.from(bytes);
  if (/\.(?:html?|svg|xml|m?js|cjs|wasm)$/iu.test(file.name)) return download();
  const dimensions = imageDimensions(type, data);
  if (dimensions && acceptableImage(...dimensions))
    return { kind: 'image', contentType: type, disposition: 'inline' };
  if (type === 'application/pdf' && data.length >= 8 && data.toString('ascii', 0, 5) === '%PDF-')
    return { kind: 'pdf', contentType: 'application/pdf', disposition: 'inline' };
  if (
    [
      'text/plain',
      'text/markdown',
      'text/csv',
      'text/yaml',
      'application/yaml',
      'application/json',
    ].includes(type) &&
    !data.includes(0) &&
    !data.includes(60)
  ) {
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
      return { kind: 'text', contentType: 'text/plain; charset=utf-8', disposition: 'inline' };
    } catch {
      /* Not text; the original is still available only as a download. */
    }
  }
  return download();
}
