/** Verify the prepared official forwarding module, without Electron, GUI or model execution. */
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const stage = join(root, '.build/desktop/deepseek-harness');
const patch = join(root, 'patches/deepseek-harness/zhuma-desktop.patch');
const source = join(root, 'packages/dsh-adapter/src/desktop-member-cookie.ts');
const copied = join(stage, 'apps/desktop/src/zhuma-member-cookie.ts');
const forwarding = join(stage, 'apps/desktop/src/web-document.ts');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const pin = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8')).upstreams
  .deepseekHarness.commit;
if (git('-C', stage, 'rev-parse', 'HEAD') !== pin)
  throw Error('Unexpected prepared desktop revision');
if (sha(await readFile(source)) !== sha(await readFile(copied)))
  throw Error('Prepared member transport is stale');
execFileSync('git', ['-C', stage, 'apply', '--reverse', '--check', patch], { stdio: 'pipe' });
const temporary = await mkdtemp(join(tmpdir(), 'zhuma-desktop-transport-'));
try {
  const artifact = join(temporary, 'forwarding.mjs');
  await build({
    entryPoints: [forwarding],
    outfile: artifact,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'error',
  });
  const env = { ...process.env, ZHUMA_DESKTOP_FORWARD_MODULE: artifact };
  delete env.ZHUMA_MODEL_API_KEY;
  delete env.ZHUMA_MODEL_BASE_URL;
  delete env.ZHUMA_MODEL_ID;
  const result = spawnSync(
    process.execPath,
    ['--test', 'packages/dsh-adapter/tests/desktop-member-cookie.test.mjs'],
    {
      cwd: root,
      stdio: 'inherit',
      env,
    },
  );
  if (result.error || result.status !== 0)
    throw Error('Prepared desktop forwarding contract failed');
  console.log(
    JSON.stringify({
      sourceHead: git('-C', root, 'rev-parse', 'HEAD'),
      sourceClean: git('-C', root, 'status', '--porcelain') === '',
      pin,
      patchSha256: sha(await readFile(patch)),
      transportSha256: sha(await readFile(source)),
      forwardingSha256: sha(await readFile(forwarding)),
      artifactSha256: sha(await readFile(artifact)),
      scope:
        'Prepared official forwarding module and real-service HTTP contract; memory service fixtures; no Electron GUI, install or disk-restart acceptance.',
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
