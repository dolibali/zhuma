/** Portable preparation contracts; no Linux binary or desktop installation claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installIconAssets } from '../../../scripts/desktop/icon-assets.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('headless and Windows source preparation keep approved PNG bytes without requiring iconutil', async (t) => {
  const stage = await mkdtemp(join(tmpdir(), 'zhuma-portable-brand-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  for (const path of ['apps/desktop/resources', 'apps/web/public'])
    await mkdir(join(stage, path), { recursive: true });
  installIconAssets(root, stage, { macOS: false });
  const master = await readFile(join(root, 'branding/default/icon.png'));
  assert((await readFile(join(stage, 'apps/desktop/resources/icon-windows.png'))).equals(master));
  assert((await readFile(join(stage, 'apps/web/public/zhuma-icon.png'))).equals(master));
  assert.equal(existsSync(join(stage, 'apps/desktop/resources/icon-macos.icns')), false);
  assert.equal(
    (await readdir(join(stage, 'apps/web/public/zhuma-icons'))).length,
    JSON.parse(await readFile(join(root, 'branding/default/icon-manifest.json'), 'utf8')).outputs
      .length,
  );
});
