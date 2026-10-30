/** Pinned source/composition contract; normal desktop boot is qualified separately. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { parse } from 'yaml';

const root = new URL('../../../', import.meta.url);
test('desktop composition: active RC4 entry menus retain their real plugin-navigation provider', async () => {
  const upstream = parse(
    await readFile(
      new URL('upstream/deepseek-harness/packages/bundle/web-app/cordis.patch.yml', root),
      'utf8',
    ),
  );
  const overlay = parse(
    await readFile(new URL('distribution/workbench/cordis.patch.yml', root), 'utf8'),
  );
  const rows = new Map();
  for (const command of [...upstream, ...overlay]) {
    for (const row of command.insert ?? []) rows.set(row.id, row);
    if (command.id) rows.set(command.id, { ...rows.get(command.id), ...command });
  }
  const entry = rows.get('entry-customization'),
    manager = rows.get('ui-plugin-manager');
  assert.equal(entry?.name, '@deepseek-ai/dsh-client-ui-entry-customization');
  assert.equal(manager?.name, '@deepseek-ai/dsh-client-ui-plugin-manager');
  const source = ts.createSourceFile(
    'entry.ts',
    await readFile(
      new URL(
        'upstream/deepseek-harness/packages/client/ui-entry-customization/src/client/index.ts',
        root,
      ),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  let dependencies;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'inject') continue;
      assert.ok(declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer));
      dependencies = declaration.initializer.elements.map((value) => {
        assert.ok(ts.isStringLiteral(value));
        return value.text;
      });
    }
  }
  assert.ok(dependencies?.includes('pluginNavigation'), 'read the actual pinned Client dependency');
  assert.ok(
    entry.disabled === true || manager.disabled !== true,
    'an enabled entry cannot wait forever for a disabled plugin-navigation provider',
  );
});
