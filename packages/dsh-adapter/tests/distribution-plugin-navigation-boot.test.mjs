/** Product composition: disabling plugin manager must also disable its navigation dependents. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('product composition disables entry-customization with ui-plugin-manager to avoid pluginNavigation boot stall', async () => {
  const patch = parse(
    await readFile(
      new URL('../../../distribution/workbench/cordis.patch.yml', import.meta.url),
      'utf8',
    ),
  );
  const byId = Object.fromEntries(
    patch.filter((entry) => typeof entry?.id === 'string').map((entry) => [entry.id, entry]),
  );
  assert.equal(byId['ui-plugin-manager']?.disabled, true);
  assert.equal(byId['entry-customization']?.disabled, true);
  // Official client inject list: entry-customization waits for pluginNavigation from ui-plugin-manager.
  const entryClient = await readFile(
    new URL(
      '../../../upstream/deepseek-harness/packages/client/ui-entry-customization/src/client/index.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(entryClient, /export const inject = \[[^\]]*['"]pluginNavigation['"]/);
  const pluginManagerClient = await readFile(
    new URL(
      '../../../upstream/deepseek-harness/packages/client/ui-plugin-manager/src/client/index.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(pluginManagerClient, /provide\(\s*['"]pluginNavigation['"]/);
});
