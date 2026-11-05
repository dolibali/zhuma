/** Release gating contracts with synthetic API responses; no tag, upload, model or cold builder. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { parse } from 'yaml';
import {
  platformNames,
  publishedPlatformFixture,
  qualificationApi,
} from './fixtures/release-platforms.mjs';
import {
  githubApi,
  preflight,
  publish,
  releaseContext,
} from '../../../scripts/desktop/release.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const context = {
  root,
  source: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  repository: 'example/product',
  version: '1.5.0',
  tag: 'v1.5.0',
  filename: 'zhuma-1.5.0-mac-arm64-unsigned.dmg',
  sdkPin: 'c'.repeat(40),
  sdkVersion: '0.2.1-rc.4',
  rootLockSha256: 'd'.repeat(64),
  runId: '123',
  runAttempt: '1',
};
function fakeApi(options = {}) {
  const calls = [],
    uploads = [];
  let created = false;
  const api = async (path, input = {}) => {
    const method = input.method ?? 'GET';
    calls.push({ path, method, ...input });
    if (/\/actions\/runs\/77(?:$|\/)/u.test(path))
      return qualificationApi(
        context,
        options.qualificationMovesAfterUpload && uploads.length >= 5
          ? { artifact: { digest: `sha256:${'8'.repeat(64)}` } }
          : {},
      )(path);
    if (path.endsWith('/git/ref/heads/main'))
      return {
        object: {
          sha:
            options.main ??
            (options.moveAfterUpload && uploads.length >= 5 ? 'f'.repeat(40) : context.source),
        },
      };
    if (path.includes('/actions/workflows/ci.yml/runs?'))
      return {
        workflow_runs: options.runs ?? [
          {
            id: 7,
            html_url: 'https://github.com/example/product/actions/runs/7',
            head_sha: context.source,
            head_branch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            ...options.ci,
          },
        ],
      };
    if (path.endsWith(`/git/ref/tags/${context.tag}`))
      return options.tag ?? (created ? { object: { sha: context.source } } : undefined);
    if (path.endsWith(`/releases/tags/${context.tag}`)) return options.release;
    if (path.endsWith('/git/refs') && method === 'POST') {
      assert.deepEqual(input.body, { ref: `refs/tags/${context.tag}`, sha: context.source });
      created = true;
      return { object: { sha: context.source } };
    }
    if (path.endsWith('/releases') && method === 'POST')
      return { id: 9, draft: true, tag_name: context.tag, target_commitish: context.source };
    if (path.includes('/releases/9/assets?name=')) {
      const name = decodeURIComponent(path.split('name=')[1]);
      assert.equal(input.upload, true);
      uploads.push(name);
      return {
        name,
        state: 'uploaded',
        size: input.bytes.length,
        digest: `sha256:${options.badDigest ? '0'.repeat(64) : sha(input.bytes)}`,
      };
    }
    if (path.endsWith('/releases/9') && method === 'PATCH') {
      assert.deepEqual(uploads, [
        context.filename,
        'SOURCE.json',
        'SHA256SUMS',
        'packaged-backend.sh',
        'packaged-backend.mjs',
        ...platformNames(context),
      ]);
      return {
        draft: false,
        tag_name: context.tag,
        html_url: `https://github.com/example/product/releases/tag/${context.tag}`,
      };
    }
    assert.fail('Unexpected synthetic API request');
  };
  return { api, calls, uploads };
}
async function artifacts(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-release-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dmg = Buffer.from('SYNTHETIC_DMG_CONTRACT_ONLY');
  const launchers = await Promise.all(
    ['packaged-backend.sh', 'packaged-backend.mjs'].map(async (name) => {
      const bytes = await readFile(join(root, 'scripts/server', name));
      await writeFile(join(directory, name), bytes);
      return { name, bytes: bytes.length, sha256: sha(bytes) };
    }),
  );
  const platforms = await publishedPlatformFixture(context, directory);
  const manifest = Buffer.from(
    JSON.stringify({
      platforms,
      sourceCommit: context.source,
      sourceTree: context.tree,
      repository: context.repository,
      version: context.version,
      tag: context.tag,
      sdkPin: context.sdkPin,
      locks: { workspace: context.rootLockSha256 },
      workflow: { runId: context.runId, runAttempt: context.runAttempt },
      target: { platform: 'darwin', arch: 'arm64', signature: 'ad-hoc', notarized: false },
      artifacts: {
        dmg: { name: context.filename, bytes: dmg.length, sha256: sha(dmg) },
        backendLaunchers: launchers,
      },
    }),
  );
  await writeFile(join(directory, context.filename), dmg);
  await writeFile(join(directory, 'SOURCE.json'), manifest);
  await writeFile(
    join(directory, 'SHA256SUMS'),
    `${sha(dmg)}  ${context.filename}\n${sha(manifest)}  SOURCE.json\n` +
      [...launchers, ...platforms.assets].map((item) => `${item.sha256}  ${item.name}\n`).join(''),
  );
  return directory;
}

test('release contracts: dispatch binds the full checked-out main SHA and product/build version', async () => {
  // The release gate checks committed provenance. Give it a committed fixture,
  // so checking an SDK-pin change before committing does not weaken that gate.
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-release-source-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    await mkdir(join(directory, 'branding/default'), { recursive: true });
    await mkdir(join(directory, 'upstream/deepseek-harness'), { recursive: true });
    for (const file of [
      'package.json',
      'runtime.lock.json',
      'pnpm-lock.yaml',
      'branding/default/brand.json',
    ])
      await writeFile(join(directory, file), await readFile(join(root, file)));
    const pin = JSON.parse(await readFile(join(directory, 'runtime.lock.json'), 'utf8')).upstreams
      .deepseekHarness.commit;
    git('init', '--quiet');
    git('add', '.');
    git('update-index', '--add', '--cacheinfo', `160000,${pin},upstream/deepseek-harness`);
    git(
      '-c',
      'user.name=Release fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Release fixture',
    );
    const source = git('rev-parse', 'HEAD');
    assert.equal(git('status', '--porcelain'), '');
    const env = {
      RELEASE_SOURCE_SHA: source,
      GITHUB_SHA: source,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'example/product',
    };
    assert.equal(releaseContext(directory, env).source, source);
    for (const patch of [
      { RELEASE_SOURCE_SHA: 'main' },
      { RELEASE_SOURCE_SHA: 'f'.repeat(40) },
      { GITHUB_REF: 'refs/heads/develop' },
      { GITHUB_REPOSITORY: 'example/product/extra' },
    ])
      assert.throws(() => releaseContext(directory, { ...env, ...patch }));
    const lock = JSON.parse(await readFile(join(directory, 'runtime.lock.json'), 'utf8'));
    lock.upstreams.deepseekHarness.commit = 'f'.repeat(40);
    await writeFile(join(directory, 'runtime.lock.json'), JSON.stringify(lock));
    assert.throws(() => releaseContext(directory, env));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('release contracts: preflight reuses exact-main CI and never writes or accepts existing tags/releases', async () => {
  const pass = fakeApi();
  assert.equal((await preflight(context, pass.api)).ciRunId, 7);
  assert(pass.calls.every((call) => call.method === 'GET'));
  for (const options of [
    { main: 'f'.repeat(40) },
    { ci: { head_sha: 'f'.repeat(40) } },
    { ci: { status: 'in_progress', conclusion: null } },
    { ci: { conclusion: 'failure' } },
    {
      runs: [
        {
          id: 6,
          head_sha: context.source,
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
        },
        {
          id: 7,
          head_sha: context.source,
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'failure',
        },
      ],
    },
    { tag: { object: { sha: context.source } } },
    { release: { draft: true } },
  ]) {
    const refused = fakeApi(options);
    await assert.rejects(preflight(context, refused.api));
    assert(refused.calls.every((call) => call.method === 'GET'));
  }
});
test('release contracts: only genuine 404 means absent; API errors never expose arbitrary bodies', async () => {
  const missing = githubApi('synthetic-token', async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 404 };
  });
  assert.equal(
    await missing('repos/example/product/releases/tags/v1', { allowMissing: true }),
    undefined,
  );
  for (const status of [401, 403, 500]) {
    const denied = githubApi('synthetic-token', async () => ({
      ok: false,
      status,
      json: () => assert.fail('PRIVATE_RESPONSE_BODY must not be read'),
    }));
    await assert.rejects(denied('repos/example/product/releases/tags/v1', { allowMissing: true }), {
      message: `GitHub GET request refused (${status}).`,
    });
  }
});
test('release contracts: publish verifies provenance/checksums and all remote asset digests before making a new release public', async (t) => {
  const directory = await artifacts(t),
    h = fakeApi();
  assert.equal(
    await publish(context, directory, h.api),
    `https://github.com/example/product/releases/tag/${context.tag}`,
  );
  const writes = h.calls.filter((call) => call.method !== 'GET');
  assert.equal(writes.length, 16);
  assert.equal(writes[0].path, 'repos/example/product/git/refs');
  assert.ok(
    writes[1].body.body.includes(`/blob/${context.source}/docs/release-v${context.version}.md`),
  );
  assert.equal(writes.at(-1).method, 'PATCH');
  assert.equal(
    h.calls.some((call) => call.method === 'DELETE'),
    false,
  );
});
test('release contracts: corrupt artifact/source identity refuses before writes; failed upload or moved main never publishes or rolls back existing objects', async (t) => {
  const corrupted = await artifacts(t),
    h = fakeApi();
  await writeFile(join(corrupted, context.filename), 'CHANGED_SYNTHETIC_BYTES');
  await assert.rejects(publish(context, corrupted, h.api));
  assert.equal(h.calls.length, 0);
  const other = await artifacts(t),
    foreign = fakeApi();
  await assert.rejects(publish({ ...context, source: 'f'.repeat(40) }, other, foreign.api));
  assert.equal(foreign.calls.length, 0);
  for (const options of [
    { badDigest: true },
    { moveAfterUpload: true },
    { qualificationMovesAfterUpload: true },
  ]) {
    const directory = await artifacts(t),
      refused = fakeApi(options);
    await assert.rejects(publish(context, directory, refused.api));
    assert.equal(
      refused.calls.some((call) => ['PATCH', 'DELETE'].includes(call.method)),
      false,
    );
  }
});
test('release workflow contract: manual default artifact build, fixed actions, arm64 guard and isolated write permission', async () => {
  const workflow = parse(await readFile(join(root, '.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'build-artifact');
  assert.equal(workflow.jobs.build['runs-on'], 'macos-15');
  assert.equal(workflow.jobs.build.permissions.contents, 'read');
  assert.equal(workflow.jobs.publish.permissions.contents, 'write');
  assert.equal(workflow.jobs.publish.if, "inputs.mode == 'publish'");
  assert.equal(workflow.on.workflow_dispatch.inputs.server_run_id.required, true);
  assert.equal(workflow.jobs.windows['runs-on'], 'windows-2025');
  assert.deepEqual(workflow.jobs.assemble.needs, ['build', 'windows']);
  assert.equal(workflow.jobs.assemble.permissions.contents, 'read');
  assert.equal(workflow.jobs.publish.needs, 'assemble');
  const ci = parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  for (const job of [workflow.jobs.windows, ci.jobs['windows-candidate']]) {
    const uploads = job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert(uploads.length > 0);
    for (const step of uploads)
      assert(step.with.path.split('\n').includes('dist/windows-x64/*-windows-x64-unsigned.exe'));
  }
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps) if (step.uses) assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/);
  const runs = workflow.jobs.build.steps.map((step) => step.run ?? '').join('\n');
  assert(runs.includes('test "$(uname -m)" = arm64'));
  assert(runs.includes('pnpm desktop:package:mac'));
  assert.equal(runs.includes('pnpm check'), false);
  const assemble = workflow.jobs.assemble.steps.map((step) => step.run ?? '').join('\n');
  assert(assemble.includes('server-preflight'));
  assert(assemble.includes('server-unpack'));
  assert.equal(assemble.includes('build:native-system'), false);
});

test('release contracts: self-consistent changed backend launcher bytes still refuse before any remote write', async (t) => {
  const directory = await artifacts(t),
    h = fakeApi();
  const file = join(directory, 'packaged-backend.mjs');
  const changed = Buffer.from('SYNTHETIC_CHANGED_LAUNCHER');
  await writeFile(file, changed);
  const manifest = JSON.parse(await readFile(join(directory, 'SOURCE.json'), 'utf8'));
  const item = manifest.artifacts.backendLaunchers.find(
    (item) => item.name === 'packaged-backend.mjs',
  );
  item.bytes = changed.length;
  item.sha256 = sha(changed);
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(directory, 'SOURCE.json'), bytes);
  const dmg = await readFile(join(directory, context.filename));
  await writeFile(
    join(directory, 'SHA256SUMS'),
    `${sha(dmg)}  ${context.filename}\n${sha(bytes)}  SOURCE.json\n` +
      [...manifest.artifacts.backendLaunchers, ...manifest.platforms.assets]
        .map((item) => `${item.sha256}  ${item.name}\n`)
        .join(''),
  );
  await assert.rejects(publish(context, directory, h.api), /exact checked-out release source/);
  assert.equal(h.calls.length, 0);
});

test('release contracts: recomputed outer hashes cannot replace the qualified Docker SAVE with invalid or different decompressed bytes', async (t) => {
  for (const [name, replacement, expected] of [
    [
      'not-gzip',
      () => Buffer.from('NOT_GZIP_AND_NOT_THE_QUALIFIED_DOCKER_SAVE'),
      { code: 'Z_DATA_ERROR' },
    ],
    [
      'same-length-different-bytes',
      (original) => gzipSync(Buffer.alloc(original.bytes)),
      /Decompressed image differs from the qualified Docker SAVE/,
    ],
    [
      'shorter-original',
      (original) => gzipSync(Buffer.alloc(original.bytes - 1)),
      /Decompressed image differs from the qualified Docker SAVE/,
    ],
    [
      'longer-original',
      (original) => gzipSync(Buffer.alloc(original.bytes + 1)),
      /Decompressed image exceeds the qualified byte length/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const directory = await artifacts(t),
        h = fakeApi();
      const manifest = JSON.parse(await readFile(join(directory, 'SOURCE.json'), 'utf8'));
      const original = structuredClone(manifest.platforms.server.records['backend-image.tar']);
      const bytes = replacement(original);
      await writeFile(join(directory, manifest.platforms.server.image), bytes);
      const asset = manifest.platforms.assets.find(
        (item) => item.name === manifest.platforms.server.image,
      );
      asset.bytes = bytes.length;
      asset.sha256 = sha(bytes);
      const source = Buffer.from(JSON.stringify(manifest));
      await writeFile(join(directory, 'SOURCE.json'), source);
      await writeFile(
        join(directory, 'SHA256SUMS'),
        `${sha(await readFile(join(directory, context.filename)))}  ${context.filename}\n${sha(source)}  SOURCE.json\n` +
          [...manifest.artifacts.backendLaunchers, ...manifest.platforms.assets]
            .map((item) => `${item.sha256}  ${item.name}\n`)
            .join(''),
      );
      assert.deepEqual(manifest.platforms.server.records['backend-image.tar'], original);
      await assert.rejects(publish(context, directory, h.api), expected);
      assert.equal(h.calls.length, 0, 'Reject before any release API call.');
    });
  }
});
