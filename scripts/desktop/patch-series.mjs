/** Verify an applied patch stack in reverse order without mutating its worktree or real index. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PRODUCT_SOURCE_PATCHES = Object.freeze([
  'patches/deepseek-harness/zhuma-desktop.patch',
  'patches/deepseek-harness/zhuma-ui-branding.patch',
]);
export function assertReversiblePatchSeries(stage, patches) {
  assert(patches.length > 0, 'Product patch series is empty.');
  const files = [
    ...new Set(
      patches.flatMap((patch) => {
        const paths = [
          ...readFileSync(patch, 'utf8').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu),
        ];
        assert(paths.length > 0, 'Product patch has no file headers.');
        return paths.map(([, from, to]) => {
          assert(
            from === to && !to.startsWith('/') && !to.split('/').includes('..'),
            'Unsupported product patch path.',
          );
          return to;
        });
      }),
    ),
  ];
  const scratch = mkdtempSync(join(tmpdir(), 'zhuma-patch-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    const git = (...args) => execFileSync('git', args, { cwd: stage, env, stdio: 'pipe' });
    git('read-tree', 'HEAD');
    git('add', '--all', '--', ...files);
    // --check alone cannot simulate overlapping patches; only this disposable
    // index is changed while the branding leaf and then its base are reversed.
    for (const patch of [...patches].reverse()) git('apply', '--cached', '--reverse', patch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
