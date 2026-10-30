/** Staging gate contracts: disposable source/compiled fixtures, no SDK writes,
 * profiles, Electron launch or GUI acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { verifyDesktopMemberTransport } from '../../../scripts/lib/desktop-member-transport.mjs';

test('stage member transport rejects copied-old source and uncompiled routes, and accepts the exact compiled formal bridge', async (t) => {
  const stage = await mkdtemp(join(tmpdir(), 'zhuma-member-stage-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  await mkdir(join(stage, 'apps/desktop/src'), { recursive: true });
  await mkdir(join(stage, 'apps/desktop/lib'), { recursive: true });
  const expected = fileURLToPath(new URL('../src/desktop-member-cookie.ts', import.meta.url));
  const source = await readFile(expected, 'utf8');
  const copied = join(stage, 'apps/desktop/src/zhuma-member-cookie.ts'),
    main = join(stage, 'apps/desktop/lib/main.js');
  await writeFile(copied, source.replace('|asset-list', ''));
  await writeFile(main, '/* synthetic stale main */');
  await assert.rejects(verifyDesktopMemberTransport(stage, expected), /transport is stale/u);
  await writeFile(copied, source);
  await assert.rejects(
    verifyDesktopMemberTransport(stage, expected),
    /Compiled desktop member routes are stale/u,
  );
  const compiled = await build({
    entryPoints: [expected],
    bundle: true,
    platform: 'node',
    format: 'esm',
    minify: true,
    write: false,
  });
  await writeFile(main, compiled.outputFiles[0].contents);
  const result = await verifyDesktopMemberTransport(stage, expected);
  for (const value of Object.values(result)) assert.match(value, /^[a-f0-9]{64}$/u);
});
