/** Build-only launcher bundling; the emitted runtime imports only Node and its two siblings. */
import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';

export async function bundleHeadlessLaunchers(root, stage) {
  // The producer rebuilds workspace exports first. Importing this helper must
  // also work immediately after a frozen install, before those exports exist.
  const { MEMBER_ROUTE_TUPLES } = await import('./member-routes.mjs');
  for (const [entry, file] of [
    ['headless.mjs', 'start.mjs'],
    ['member-gateway.mjs', 'member-gateway.mjs'],
    ['runtime-manifest.mjs', 'runtime-manifest.mjs'],
  ]) {
    const compiled = await build({
      absWorkingDir: root,
      entryPoints: [`scripts/server/${entry}`],
      outfile: join(stage, file),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: entry === 'headless.mjs' ? ['./member-gateway.mjs', './runtime-manifest.mjs'] : [],
      metafile: true,
      plugins: [
        {
          name: 'freeze-member-route-policy',
          setup(compiler) {
            compiler.onLoad({ filter: /[/\\]member-routes\.mjs$/ }, () => ({
              contents: `export const MEMBER_ROUTE_TUPLES = ${JSON.stringify(MEMBER_ROUTE_TUPLES)};`,
              loader: 'js',
            }));
          },
        },
      ],
    });
    assert(Object.keys(compiled.metafile.outputs).length > 0);
    for (const output of Object.values(compiled.metafile.outputs))
      for (const imported of output.imports)
        assert(
          !imported.external ||
            isBuiltin(imported.path) ||
            ['./member-gateway.mjs', './runtime-manifest.mjs'].includes(imported.path),
          'Launcher gained an external runtime dependency.',
        );
  }
}
