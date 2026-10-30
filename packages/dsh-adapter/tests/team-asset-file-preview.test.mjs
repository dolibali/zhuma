import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  teamAssetFilePresentation,
  TEAM_ASSET_FILE_RESPONSE_HEADERS,
} from '../dist/team-asset-file-preview.js';
const present = (bytes, name, mediaType) =>
  teamAssetFilePresentation(
    {
      name,
      mediaType,
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    bytes,
  );

test('team preview: text is escaped/plain only, never general text/* or active document content', () => {
  assert.equal(present(Buffer.from('资料 A汉😀BC'), 'guide.md', 'text/markdown').kind, 'text');
  for (const [name, type, body] of [
    ['index.html', 'text/plain', 'hello'],
    ['icon.svg', 'image/svg+xml', '<svg/>'],
    ['index.txt', 'text/plain', '<script>run()</script>'],
    ['code.js', 'text/plain', '1+1'],
    ['data.xml', 'text/xml', '<item/>'],
    ['data.txt', 'text/plain', '\u0000binary'],
  ])
    assert.equal(present(Buffer.from(body), name, type).kind, 'download');
});

test('team preview: image MIME needs real header and bounded dimensions; no full decoder or GUI proof', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9QAAAABJRU5ErkJggg==',
    'base64',
  );
  assert.equal(present(png, 'sample.png', 'image/png').kind, 'image');
  assert.equal(present(Buffer.from('<html>'), 'sample.png', 'image/png').kind, 'download');
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(32768, 16);
  assert.equal(present(oversized, 'sample.png', 'image/png').kind, 'download');
  assert.equal(present(png, 'sample.svg', 'image/png').kind, 'download');
});

test('team preview: PDF needs its header; Office/ZIP remain original downloads without claimed parsing', () => {
  assert.equal(present(Buffer.from('%PDF-1.7\n'), 'sample.pdf', 'application/pdf').kind, 'pdf');
  assert.equal(present(Buffer.from('<html>'), 'sample.pdf', 'application/pdf').kind, 'download');
  for (const [name, type] of [
    ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['archive.zip', 'application/zip'],
  ])
    assert.equal(present(Buffer.from('PK\u0003\u0004'), name, type).kind, 'download');
  assert.match(TEAM_ASSET_FILE_RESPONSE_HEADERS['content-security-policy'], /sandbox/u);
  assert.equal(TEAM_ASSET_FILE_RESPONSE_HEADERS['x-content-type-options'], 'nosniff');
});

test('team preview: presentation never labels changed bytes as a verified file', () => {
  assert.throws(
    () =>
      teamAssetFilePresentation(
        { name: 'x.txt', mediaType: 'text/plain', byteSize: 3, sha256: 'a'.repeat(64) },
        Buffer.from('abc'),
      ),
    { code: 'unavailable' },
  );
});
