/** Exact-source brand validation and lossless asset deployment. No drawing or image synthesis. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRgbaPng, assertTransparentExterior } from './png-alpha.mjs';
export const APPROVED_ICON_SHA256 =
  'e0fd8cc6d4706ad60af35d6ea12415f36582fdd8cae92e0a20d390538475bf00';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Expected PNG, not JPEG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
export function verifyIconAssets(root) {
  const brand = join(root, 'branding/default');
  const manifest = JSON.parse(readFileSync(join(brand, 'icon-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.source.sha256, APPROVED_ICON_SHA256);
  const source = readFileSync(join(brand, 'icon-source.png'));
  assert.equal(sha256(source), APPROVED_ICON_SHA256, 'Approved source image was replaced');
  assert.deepEqual(pngSize(source), [1254, 1254]);
  assert.equal(manifest.master.recipe, 'approved-perimeter-alpha-v1');
  assert.equal(manifest.master.path, 'icon-transparent.png');
  const masterBytes = readFileSync(join(brand, manifest.master.path));
  assert.equal(sha256(masterBytes), manifest.master.sha256, 'Transparent master checksum differs');
  const original = decodeRgbaPng(source);
  const master = decodeRgbaPng(masterBytes);
  assert.equal(original.width, master.width);
  assert.equal(original.height, master.height);
  for (let i = 0; i < original.pixels.length; i++) {
    if (i % 4 !== 3)
      assert.equal(
        master.pixels[i],
        original.pixels[i],
        'Only exterior alpha may change; RGB artwork must remain intact',
      );
  }
  assertTransparentExterior(master, 'Transparent master');

  assert.equal(existsSync(join(brand, 'render_icon.py')), false, 'Retire the old redrawing script');
  assert.equal(
    existsSync(join(brand, 'icon-source.jpg')),
    false,
    'Do not reintroduce lossy JPEG input',
  );
  for (const entry of manifest.outputs) {
    assert.match(entry.path, /^icons\/icon-\d+\.png$/u);
    const bytes = readFileSync(join(brand, entry.path));
    assert.equal(sha256(bytes), entry.sha256, `Export checksum mismatch: ${entry.path}`);
    assert.deepEqual(pngSize(bytes), [entry.width, entry.height]);
    assertTransparentExterior(decodeRgbaPng(bytes), entry.path);
  }
  assert.equal(
    sha256(readFileSync(join(brand, 'icon.png'))),
    manifest.outputs.find((entry) => entry.width === 1024).sha256,
  );
  return manifest;
}
export function installIconAssets(root, stage) {
  const manifest = verifyIconAssets(root);
  const brand = join(root, 'branding/default');
  for (const target of [
    'apps/desktop/resources/icon.png',
    'apps/desktop/resources/icon-macos.png',
    'apps/desktop/resources/icon-windows.png',
    'apps/web/public/zhuma-icon.png',
  ]) {
    copyFileSync(join(brand, 'icon.png'), join(stage, target));
  }
  const ui = join(stage, 'apps/web/public/zhuma-icons');
  mkdirSync(ui, { recursive: true });
  for (const entry of manifest.outputs)
    copyFileSync(join(brand, entry.path), join(ui, `icon-${entry.width}.png`));
  const iconset = join(root, '.build/desktop/Zhuma.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512])
    for (const density of [1, 2]) {
      copyFileSync(
        join(brand, `icons/icon-${size * density}.png`),
        join(iconset, `icon_${size}x${size}${density === 2 ? '@2x' : ''}.png`),
      );
    }
  const result = spawnSync(
    'iconutil',
    ['-c', 'icns', iconset, '-o', join(stage, 'apps/desktop/resources/icon-macos.icns')],
    { stdio: 'inherit' },
  );
  if (result.error || result.status !== 0)
    throw new Error('macOS icon container conversion failed');
  console.log(
    `Original PNG preserved; transparent native and UI sizes installed (${APPROVED_ICON_SHA256.slice(0, 12)}).`,
  );
}
