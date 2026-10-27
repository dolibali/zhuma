/** Product composition assertion only; no provider request or upload is performed. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('product composition opts out of session-log contribution while keeping the official plugin available', async () => {
  const patch = parse(
    await readFile(
      new URL('../../../distribution/workbench/cordis.patch.yml', import.meta.url),
      'utf8',
    ),
  );
  const entries = patch.filter((entry) => entry.id === 'session-log-deepseek');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].config, { enabled: false });
  assert.notEqual(entries[0].disabled, true);
  assert.equal(entries[0].name, undefined); // Configure the official entry; do not replace its implementation.
});
