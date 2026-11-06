/** Shared receipt/source contracts, no compiled desktop or GUI claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  SDK_SOURCE_RECIPE_FILES,
  productSourceRecipeDigest,
  assertProductSourceRecipe,
} from '../../../scripts/desktop/source-recipe.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
test('prepare and development consumer share one kind-aware recipe, and changed inputs stay rejected', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'zhuma-shared-recipe-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const name of SDK_SOURCE_RECIPE_FILES) {
    await mkdir(dirname(join(fixture, name)), { recursive: true });
    await copyFile(join(root, name), join(fixture, name));
  }
  const desktop = { kind: 'desktop', digest: productSourceRecipeDigest(fixture, 'desktop') };
  const server = { kind: 'server', digest: productSourceRecipeDigest(fixture, 'server') };
  assertProductSourceRecipe(fixture, desktop, 'desktop');
  assertProductSourceRecipe(fixture, server, 'server');
  assert.notEqual(desktop.digest, server.digest);
  assert.throws(() => assertProductSourceRecipe(fixture, desktop, 'server'), /kind differs/u);
  await writeFile(join(fixture, SDK_SOURCE_RECIPE_FILES[0]), 'different patch');
  assert.throws(() => assertProductSourceRecipe(fixture, desktop, 'desktop'), /recipe differs/u);
  assert.throws(() => assertProductSourceRecipe(fixture, server, 'server'), /recipe differs/u);
  // Check both real callers consume the shared implementation, avoiding another private file list.
  assert.match(
    await readFile(join(root, 'scripts/desktop/prepare.mjs'), 'utf8'),
    /productSourceRecipeDigest\(root, kind\)/u,
  );
  assert.match(
    await readFile(join(root, 'scripts/desktop/dev-host.mjs'), 'utf8'),
    /assertProductSourceRecipe\(root, stamp, 'desktop'\)/u,
  );
});
