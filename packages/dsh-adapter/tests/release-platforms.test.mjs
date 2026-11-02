/** Synthetic API/archive contracts. No real image, installer, model or publication. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assemblePlatformAssets,
  serverQualification,
  verifyPlatformAssets,
  verifyQualifiedServer,
} from '../../../scripts/lib/release-platforms.mjs';
import {
  platformNames,
  qualificationApi,
  rawPlatformFixture,
  serverReceipt,
} from './fixtures/release-platforms.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const context = {
  root,
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  repository: 'example/product',
  version: '1.4.0',
  sdkPin: 'c'.repeat(40),
  sdkVersion: '0.2.1-rc.4',
  rootLockSha256: 'd'.repeat(64),
};
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'zhuma-release-platform-contract-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('release platform contracts: only a successful exact-main dispatch with qualify and an immutable production artifact is admitted', async () => {
  assert.deepEqual(
    await serverQualification(context, 77, qualificationApi(context)),
    serverReceipt(context),
  );
  for (const options of [
    { run: { head_sha: 'f'.repeat(40) } },
    { run: { head_branch: 'develop' } },
    { run: { event: 'pull_request' } },
    { run: { path: '.github/workflows/ci.yml' } },
    { run: { conclusion: 'failure' } },
    { run: { status: 'in_progress' } },
    {
      jobs: [
        { name: 'qualify', conclusion: 'skipped' },
        { name: 'native-probe', conclusion: 'success' },
      ],
    },
    { artifact: { expired: true } },
    { artifact: { name: 'unqualified-native-diagnostics' } },
    { artifact: { digest: undefined } },
    { artifact: { workflow_run: { id: 77, head_sha: 'f'.repeat(40), head_branch: 'main' } } },
  ])
    await assert.rejects(serverQualification(context, 77, qualificationApi(context, options)));
  await assert.rejects(serverQualification(context, '77/foreign', qualificationApi(context)));
});

test('release archive contracts: original hashes, portable SOURCE and non-root Docker SAVE config are all required', async (t) => {
  const base = await directory(t);
  const valid = await rawPlatformFixture(context, base);
  assert.match(verifyQualifiedServer(context, valid.server).imageId, /^sha256:[a-f0-9]{64}$/u);
  await assert.rejects(async () =>
    verifyQualifiedServer({ ...context, version: '1.3.0' }, valid.server),
  );
  await writeFile(join(valid.server, 'IMAGE_ID'), `sha256:${'0'.repeat(64)}\n`);
  assert.throws(() => verifyQualifiedServer(context, valid.server), /hashes differ/);
  for (const options of [
    { config: { User: '0:0' } },
    { portableSource: { schemaVersion: 1, product: { commit: 'f'.repeat(40) } } },
  ]) {
    const next = await directory(t),
      fixture = await rawPlatformFixture(context, next, options);
    assert.throws(() => verifyQualifiedServer(context, fixture.server));
  }
});

test('release assembly contracts: retain original platform sources, qualify every extra byte, and never accept a foreign or missing platform', async (t) => {
  const base = await directory(t),
    fixture = await rawPlatformFixture(context, base),
    output = join(base, 'output');
  await mkdir(output);
  const platforms = await assemblePlatformAssets(
    context,
    fixture.windows,
    fixture.server,
    serverReceipt(context),
    output,
  );
  assert.deepEqual(
    (await verifyPlatformAssets(context, output, platforms)).map((item) => item.name),
    platformNames(context),
  );
  assert.equal(
    (await readFile(join(output, 'server-SOURCE.json'))).equals(
      await readFile(join(fixture.server, 'SOURCE.json')),
    ),
    true,
  );
  await assert.rejects(verifyPlatformAssets(context, output, undefined));
  await assert.rejects(
    verifyPlatformAssets({ ...context, source: 'f'.repeat(40) }, output, platforms),
  );
  await writeFile(join(output, platforms.windows.installer), 'CHANGED_SYNTHETIC_EXE');
  await assert.rejects(verifyPlatformAssets(context, output, platforms));
});
