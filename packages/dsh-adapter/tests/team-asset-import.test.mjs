import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { preflightTeamAssetImport } from '../dist/team-asset-import.js';
import { packageFixture, packageZip, sourceFile } from '../../../tests/fixtures/asset-package.mjs';

const grant = () => ({ signal: new AbortController().signal, assertCurrent() {} });
test('team import: original ZIP and file preflight agree; checksum binds sanitized files and source licenses', async () => {
  const files = [...packageFixture(), sourceFile('analyst/LICENSE', 'Public fixture license.')];
  const zipped = await preflightTeamAssetImport({ kind: 'zip', data: packageZip(files) }, grant());
  const folder = await preflightTeamAssetImport({ kind: 'files', files }, grant());
  assert.deepEqual(zipped, folder);
  assert.equal(
    folder.packageChecksum,
    createHash('sha256').update(canonicalPayload(folder.preview.files)).digest('hex'),
  );
  assert.ok(folder.preview.files.some((file) => /LICENSE/u.test(file.path)));
  assert.ok(folder.preview.items.length > 0);
});

test('team import: original privacy and inert-script rules stay in effect', async () => {
  const files = [
    ...packageFixture(),
    sourceFile('.env', 'PRIVATE_CREDENTIAL_CANARY'),
    sourceFile('sessions/history.json', 'PRIVATE_SESSION_CANARY'),
    sourceFile(
      'analyst/skills/field-review/scripts/run.js',
      'throw Error("THIS_FILE_IS_ONLY_DATA")',
    ),
  ];
  const result = await preflightTeamAssetImport({ kind: 'files', files }, grant());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(?:CREDENTIAL|SESSION)_CANARY/u);
  assert.ok(result.preview.files.some((file) => file.path.endsWith('scripts/run.js')));
  assert.equal(result.preview.ignored.length >= 2, true);
});

test('team import: denied authority precedes parsing and late revocation refuses the preview', async () => {
  await assert.rejects(
    preflightTeamAssetImport(undefined, {
      ...grant(),
      assertCurrent() {
        throw Error('denied');
      },
    }),
    { code: 'unavailable' },
  );
  let calls = 0;
  await assert.rejects(
    preflightTeamAssetImport(
      { kind: 'files', files: packageFixture() },
      {
        ...grant(),
        assertCurrent() {
          if (++calls === 2) throw Error('revoked');
        },
      },
    ),
    { code: 'unavailable' },
  );
  assert.equal(calls, 2);
});

test('team import: invalid traversal/archive budgets and pre-aborted input fail without a result', async () => {
  for (const files of [
    [{ path: '../SKILL.md', data: 'YQ==' }],
    [{ path: 'a.md', data: 'a'.repeat(349532) }],
  ])
    await assert.rejects(preflightTeamAssetImport({ kind: 'files', files }, grant()));
  await assert.rejects(preflightTeamAssetImport({ kind: 'zip', data: 'invalid' }, grant()));
  await assert.rejects(
    preflightTeamAssetImport(
      { kind: 'files', files: packageFixture() },
      {
        signal: AbortSignal.abort(),
        assertCurrent() {
          assert.fail('already aborted');
        },
      },
    ),
    { code: 'cancelled' },
  );
});
