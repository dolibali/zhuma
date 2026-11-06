/** A real overlapping Git patch stack; this proves index isolation, not a product build. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReversiblePatchSeries } from '../../../scripts/desktop/patch-series.mjs';

test('overlapping base/branding patches verify in reverse on a disposable index without changing the real index or files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'zhuma-patch-series-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  git('init', '--quiet');
  writeFileSync(join(directory, 'text'), 'original\n');
  git('add', 'text');
  git(
    '-c',
    'user.name=Patch fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  writeFileSync(join(directory, 'text'), 'base\n');
  const base = join(directory, 'base.patch');
  writeFileSync(base, git('diff', '--', 'text'));
  git('add', 'text');
  writeFileSync(join(directory, 'text'), 'branding\n');
  const branding = join(directory, 'branding.patch');
  writeFileSync(branding, git('diff', '--', 'text'));
  git('read-tree', 'HEAD');
  const before = readFileSync(join(directory, '.git/index'));
  assertReversiblePatchSeries(directory, [base, branding]);
  assert(readFileSync(join(directory, '.git/index')).equals(before));
  assert.equal(readFileSync(join(directory, 'text'), 'utf8'), 'branding\n');
  assert.throws(() => assertReversiblePatchSeries(directory, [branding, base]));
  writeFileSync(join(directory, 'text'), 'unrecognized change\n');
  assert.throws(() => assertReversiblePatchSeries(directory, [base, branding]));
  assert.equal(readFileSync(join(directory, 'text'), 'utf8'), 'unrecognized change\n');
});
