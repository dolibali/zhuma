/** One source recipe shared by source preparation and every prepared-source consumer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SDK_SOURCE_RECIPE_FILES = Object.freeze([
  'patches/deepseek-harness/zhuma-desktop.patch',
  'patches/deepseek-harness/zhuma-ui-branding.patch',
  'packages/dsh-adapter/src/desktop-member-cookie.ts',
  'scripts/desktop/verify-build-source-paths.ts',
  'scripts/desktop/verify-runtime-privacy.ts',
  'branding/default/icon-manifest.json',
  'scripts/desktop/prepare.mjs',
  'scripts/desktop/icon-assets.mjs',
  'scripts/desktop/source-recipe.mjs',
  'scripts/desktop/patch-series.mjs',
]);
export function productSourceRecipeDigest(root, kind) {
  assert(['desktop', 'server'].includes(kind), 'Unsupported preparation kind.');
  return createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(kind),
        ...SDK_SOURCE_RECIPE_FILES.map((name) => readFileSync(join(root, name))),
      ]),
    )
    .digest('hex');
}
export function assertProductSourceRecipe(root, stamp, kind) {
  assert.equal(stamp.kind, kind, 'Prepared SDK kind differs.');
  assert.equal(
    stamp.digest,
    productSourceRecipeDigest(root, kind),
    'Prepared SDK recipe differs; prepare matching sources before refreshing.',
  );
}
